// The per-session budget cap over the wire (LOB-163, part 3 of LOB-17).
//
//   bun budget.ts      (via ./budget.sh, which owns the API instance this drives)
//
// The API this talks to runs the faux model priced at FAUX_COST (a cent a request), with
// SESSION_BUDGET as the default cap. The faux script is two requests a run — a `bash` call, then a
// reply quoting its output — so a one-cent cap is reached by the first answer, and the run must stop
// before the reply's request. Every check reads through the same RPC client the CLI and the
// dashboard build:
//
//   capped    createSession({ budget }) reports the cap unspent; a watcher attached before the send
//             receives the `budget` entry as an event; the run settles idle with the tool's result
//             and the stop, and no reply; spend equals the cap; the snapshot's `budget.stopped` says so
//   again     a second message on the stopped session starts a run that stops before its first
//             request: a second stop, the spend unchanged
//   default   a session created without a cap gets SESSION_BUDGET, and a run under it answers
//
// Env: API_URL, EVIDENCE_DIR, FAUX_COST, SESSION_BUDGET.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { SessionRpc } from "@repo/domain/Rpc";
import type {
  SessionEvent,
  SessionId,
  SessionSnapshot,
} from "@repo/domain/Session";
import { Effect, Fiber, Ref, Stream } from "effect";
import { RpcClient } from "effect/rpc";
import { makeChecker, protocolFor, waitUntil } from "./harness.ts";
import type { CheckRecord } from "./harness.ts";

const API_URL = process.env["API_URL"] ?? "http://localhost:9419";
const EVIDENCE_DIR =
  process.env["EVIDENCE_DIR"] ?? ".verify/evidence/latest/api";
const COST = Number(process.env["FAUX_COST"] ?? "0.01");
const DEFAULT_BUDGET = Number(process.env["SESSION_BUDGET"] ?? "1");
/** The cap the capped session asks for: one request's worth. */
const CAP = COST;
const TASK = "spend at most a cent";

await mkdir(EVIDENCE_DIR, { recursive: true });

type TranscriptRow = { readonly kind: string; readonly text: string };

const observed: {
  apiUrl: string;
  fauxCost: number;
  defaultBudget: number;
  sessions: Record<string, SessionId>;
  budgets: Record<string, unknown>;
  events: ReadonlyArray<string>;
  transcripts: Record<string, ReadonlyArray<TranscriptRow>>;
  checks: Record<string, CheckRecord>;
} = {
  apiUrl: API_URL,
  fauxCost: COST,
  defaultBudget: DEFAULT_BUDGET,
  sessions: {},
  budgets: {},
  events: [],
  transcripts: {},
  checks: {},
};
const assert = makeChecker(observed);

const close = (left: number, right: number) => Math.abs(left - right) < 1e-9;

const spentOf = (snapshot: SessionSnapshot): number =>
  [...snapshot.usage.models, ...snapshot.usage.tools].reduce(
    (total, bucket) => total + bucket.usage.costTotal,
    0,
  );

/** The transcript without prompt sections and titles: what the run did, in order. */
const kinds = (snapshot: SessionSnapshot): readonly string[] =>
  snapshot.entries
    .map((entry) => entry.kind)
    .filter((kind) => kind !== "system" && kind !== "title");

const transcriptOf = (
  snapshot: SessionSnapshot,
): ReadonlyArray<TranscriptRow> =>
  snapshot.entries
    .filter((entry) => entry.kind !== "system")
    .map((entry) => ({ kind: entry.kind, text: entry.text }));

const stops = (snapshot: SessionSnapshot) =>
  snapshot.entries.filter((entry) => entry.kind === "budget");

const program = Effect.gen(function* () {
  const client = yield* RpcClient.make(SessionRpc);
  const settled = (
    sessionId: SessionId,
    done: (s: SessionSnapshot) => boolean,
  ) =>
    waitUntil(
      client
        .getSession({ sessionId })
        .pipe(
          Effect.map((snapshot) =>
            !snapshot.live.busy && done(snapshot) ? snapshot : undefined,
          ),
        ),
      "the run to settle",
    );

  // --- capped: the cap stops the run before its second request ---------------------------------
  const created = yield* client.createSession({
    title: "budget capped",
    budget: CAP,
  });
  observed.sessions["capped"] = created.id;
  const fresh = yield* client.getSession({ sessionId: created.id });
  assert(
    "a capped create reports its cap, unspent",
    fresh.budget?.cap === CAP &&
      fresh.budget.spent === 0 &&
      fresh.budget.stopped === undefined,
    `budget=${JSON.stringify(fresh.budget)}`,
  );

  // Attach before sending, so the stop arrives as an event rather than being read back afterwards.
  const collected = yield* Ref.make<ReadonlyArray<SessionEvent>>([]);
  const watcher = yield* client.watchSession({ sessionId: created.id }).pipe(
    Stream.tap((event) => Ref.update(collected, (all) => [...all, event])),
    Stream.runDrain,
    Effect.forkChild,
  );
  yield* waitUntil(
    Ref.get(collected).pipe(
      Effect.map((all) => all.some((event) => event._tag === "snapshot")),
    ),
    "the attached snapshot",
  );

  const sent = yield* client.sendMessage({
    sessionId: created.id,
    content: TASK,
  });
  assert(
    "the task starts a run",
    sent.placement === "run",
    `placement=${sent.placement}`,
  );
  const stopped = yield* settled(created.id, (s) => stops(s).length > 0);
  // The stop's entry, and the first idle status after it: the order a watcher sees the stop in.
  const stopIndex = (all: ReadonlyArray<SessionEvent>) =>
    all.findIndex(
      (event) => event._tag === "entry" && event.entry.kind === "budget",
    );
  const idleAfter = (all: ReadonlyArray<SessionEvent>, from: number) =>
    from < 0
      ? -1
      : all.findIndex(
          (event, index) =>
            index > from && event._tag === "status" && event.status === "idle",
        );
  yield* waitUntil(
    Ref.get(collected).pipe(
      Effect.map((all) => idleAfter(all, stopIndex(all)) !== -1),
    ),
    "the stop, then idle, as stream events",
  ).pipe(Effect.ignore);
  yield* Fiber.interrupt(watcher);
  const events = yield* Ref.get(collected);
  observed.events = events.map((event) =>
    event._tag === "entry"
      ? `entry:${event.entry.kind}`
      : event._tag === "status"
        ? `status:${event.status}`
        : event._tag,
  );
  observed.transcripts["capped"] = transcriptOf(stopped);
  observed.budgets["capped"] = stopped.budget;

  assert(
    "the run stopped after the tool, before the reply: user, call, result, stop",
    JSON.stringify(kinds(stopped)) ===
      JSON.stringify(["user", "assistant", "toolResult", "budget"]),
    `kinds=${kinds(stopped).join(",")}`,
  );
  assert(
    "no reply was produced: the reply's request was never sent",
    !stopped.entries.some(
      (entry) => entry.kind === "assistant" && entry.text.includes("(re:"),
    ),
    `assistant texts=${JSON.stringify(stopped.entries.filter((entry) => entry.kind === "assistant").map((entry) => entry.text))}`,
  );
  assert(
    "the session stopped at its limit: spend equals the cap",
    close(spentOf(stopped), CAP),
    `spent=${spentOf(stopped)} cap=${CAP}`,
  );
  assert(
    "the session is idle after the stop: nothing waits",
    stopped.session.status === "idle" && !stopped.live.busy,
    `status=${stopped.session.status} busy=${stopped.live.busy}`,
  );
  const line = stops(stopped)[0]?.text ?? "";
  assert(
    "the transcript says why: a budget entry naming the spend and the cap",
    line.startsWith("budget reached:") &&
      line.includes("$0.0100 of its $0.0100 cap"),
    `text=${JSON.stringify(line)}`,
  );
  assert(
    "the snapshot reports the stop: budget.stopped with its spend and cap",
    stopped.budget?.stopped !== undefined &&
      close(stopped.budget.stopped.spent, CAP) &&
      stopped.budget.stopped.cap === CAP,
    `budget=${JSON.stringify(stopped.budget)}`,
  );
  assert(
    "a watcher attached before the send received the stop, then status idle",
    idleAfter(events, stopIndex(events)) > stopIndex(events),
    `events=${observed.events.join(",")}`,
  );

  // --- again: a stopped session stays capped -----------------------------------------------------
  yield* client.sendMessage({ sessionId: created.id, content: "keep going" });
  const again = yield* settled(created.id, (s) => stops(s).length > 1);
  observed.transcripts["again"] = transcriptOf(again);
  assert(
    "a later run stops before its first request, spending nothing",
    JSON.stringify(kinds(again).slice(4)) ===
      JSON.stringify(["user", "budget"]) && close(spentOf(again), CAP),
    `kinds=${kinds(again).join(",")} spent=${spentOf(again)}`,
  );

  // --- default: the server's cap, not reached ------------------------------------------------------
  const defaulted = yield* client.createSession({ title: "budget default" });
  observed.sessions["default"] = defaulted.id;
  yield* client.sendMessage({ sessionId: defaulted.id, content: TASK });
  const answered = yield* settled(defaulted.id, (s) =>
    s.entries.some(
      (entry) => entry.kind === "assistant" && entry.text.includes("(re:"),
    ),
  );
  observed.transcripts["default"] = transcriptOf(answered);
  observed.budgets["default"] = answered.budget;
  assert(
    "a create that names no cap gets the server's default (SESSION_BUDGET)",
    answered.budget?.cap === DEFAULT_BUDGET,
    `budget=${JSON.stringify(answered.budget)}`,
  );
  assert(
    "a run under its cap answers as an uncapped one does",
    stops(answered).length === 0 &&
      answered.budget?.stopped === undefined &&
      close(spentOf(answered), 2 * COST),
    `kinds=${kinds(answered).join(",")} spent=${spentOf(answered)}`,
  );
});

try {
  await Effect.runPromise(
    program.pipe(Effect.provide(protocolFor(API_URL)), Effect.scoped),
  );
} catch (error) {
  assert("the drive completed", false, `threw: ${String(error)}`);
}

await writeFile(
  path.join(EVIDENCE_DIR, "budget.json"),
  `${JSON.stringify(observed, null, 2)}\n`,
);
await writeFile(
  path.join(EVIDENCE_DIR, "budget-transcript.txt"),
  `${Object.entries(observed.transcripts)
    .map(
      ([name, rows]) =>
        `## ${name}\n${rows.map((row) => `${row.kind}: ${row.text}`).join("\n")}`,
    )
    .join("\n\n")}\n`,
);
await writeFile(
  path.join(EVIDENCE_DIR, "budget-sessions.env"),
  `CAPPED=${observed.sessions["capped"] ?? ""}\nDEFAULTED=${observed.sessions["default"] ?? ""}\n`,
);

const failed = Object.entries(observed.checks).filter(
  ([, check]) => !check.passed,
);
if (failed.length > 0) {
  console.error(`\n${failed.length} required check(s) failed`);
  process.exitCode = 1;
}
