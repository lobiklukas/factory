#!/usr/bin/env bun
// The probes `ask.sh` cannot make from a terminal (LOB-73): what the control plane says about a run
// and what the run's log says it was told. Everything a person reads — the block, the question, the
// answer — is read by `ask.sh` through `factory board`; this file reads the two facts no command
// prints: whether the session is busy, and the run's recorded prompt.
//
//   MODE=busy   SESSION_ID=…            the run is genuinely busy (the sleeping FAUX_COMMAND), which is
//                                       what makes "not busy after the ask" a check that can fail
//   MODE=parked SESSION_ID=… TASK_ID=…  once the card is blocked, the live owner is idle, the ask is
//                                       the last thing in the transcript, and nothing runs
//   MODE=told   SESSION_ID=… TASK_ID=…  the next run settled, its committed prompt quotes ANSWER
//                                       verbatim after QUESTION, and it did not ask again
//
// `drive.sh`'s specify phase (LOB-85) runs the same three probes on the drive's own card, with
// EVIDENCE_PREFIX=specify so its files sit beside `ask.sh`'s rather than over them.
//
// Env: API_URL, MODE, SESSION_ID, TASK_ID, QUESTION, ANSWER, DATABASE_URL (for `told`'s log read),
// EVIDENCE_DIR, EVIDENCE_PREFIX (default `ask`). Writes `<prefix>-<mode>.json` and exits non-zero
// when a check fails.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { RpcApi } from "@repo/domain/Rpc";
import type { SessionId } from "@repo/domain/Session";
import type { TaskId } from "@repo/domain/Task";
import { readPromptSections, THREAD_SECTION_KEY } from "@repo/harness";
import { DatabaseLive, PostgresStorage } from "@repo/storage-postgres";
import { Effect, Scope } from "effect";
import { RpcClient } from "effect/rpc";
import { SqlClient } from "effect/sql/SqlClient";
import { makeChecker, protocolFor } from "../verify-api/harness.ts";
import type { CheckRecord } from "../verify-api/harness.ts";

const API_URL = process.env["API_URL"] ?? "http://localhost:9400";
const MODE = process.env["MODE"] ?? "";
const SESSION = (process.env["SESSION_ID"] ?? "") as SessionId;
const TASK = (process.env["TASK_ID"] ?? "") as TaskId;
const QUESTION = process.env["QUESTION"] ?? "";
const ANSWER = process.env["ANSWER"] ?? "";
const EVIDENCE_DIR =
  process.env["EVIDENCE_DIR"] ?? ".verify/evidence/latest/board";
const EVIDENCE_PREFIX = process.env["EVIDENCE_PREFIX"] ?? "ask";

const observed: {
  mode: string;
  sessionId: string;
  taskId: string;
  facts: Record<string, unknown>;
  checks: Record<string, CheckRecord>;
} = { mode: MODE, sessionId: SESSION, taskId: TASK, facts: {}, checks: {} };
const check = makeChecker(observed);

/** Poll `probe` every 100 ms for up to `seconds`, returning the first value it accepts. */
const poll = <A, E>(
  probe: Effect.Effect<A, E>,
  accept: (value: A) => boolean,
  seconds: number,
): Effect.Effect<{ value: A; ms: number; met: boolean }, E> =>
  Effect.gen(function* () {
    const started = Date.now();
    let value = yield* probe;
    while (!accept(value) && Date.now() - started < seconds * 1000) {
      yield* Effect.sleep(100);
      value = yield* probe;
    }
    return { value, ms: Date.now() - started, met: accept(value) };
  });

const busy = Effect.gen(function* () {
  const client = yield* RpcClient.make(RpcApi);
  const seen = yield* poll(
    client.getSession({ sessionId: SESSION }),
    (snapshot) => snapshot.live.busy,
    15,
  );
  observed.facts["busyAfterMs"] = seen.ms;
  check(
    "the probe sees the run busy while its turn is held open",
    seen.met,
    `live.busy=${seen.value.live.busy} after ${seen.ms}ms`,
  );
});

const parked = Effect.gen(function* () {
  const client = yield* RpcClient.make(RpcApi);
  const blocked = yield* poll(
    client.getTask({ taskId: TASK }),
    (task) => task.blocked !== undefined,
    30,
  );
  check(
    "the run asked: the card is blocked",
    blocked.met,
    `blocked=${blocked.value.blocked?.reason ?? "-"} after ${blocked.ms}ms`,
  );
  // "Not busy" is bounded, not eventual: a run that ended parked is idle at once, and one left
  // hanging in a turn would still be busy when the bound runs out.
  const idle = yield* poll(
    client.getSession({ sessionId: SESSION }),
    (snapshot) => !snapshot.live.busy,
    5,
  );
  const snapshot = idle.value;
  const last = snapshot.entries.at(-1);
  observed.facts["idleAfterBlockMs"] = idle.ms;
  observed.facts["lastEntry"] = last ?? null;
  check(
    "the run is not busy after the ask",
    snapshot.session.mode === "live" && !snapshot.live.busy,
    `mode=${snapshot.session.mode} busy=${snapshot.live.busy} status=${snapshot.session.status}`,
  );
  check(
    "no turn is left running and nothing is queued",
    snapshot.live.tools.length === 0 && snapshot.queued.length === 0,
    `live tools=${snapshot.live.tools.length} queued=${snapshot.queued.length}`,
  );
  // The card sits in `specifying`, whose role is the read-only stage (LOB-74): the run's `bash`
  // read — the sleep that made it busy — must have run, not been refused, or the stage would be
  // blocking the very reads a specifier asks from.
  const read = snapshot.entries.find(
    (entry) => entry.kind === "toolResult" && entry.toolName === "bash",
  );
  check(
    "the run's read ran in the specifying stage, not refused",
    read !== undefined &&
      read.isError !== true &&
      read.text.includes("faux-ok"),
    `bash ${read === undefined ? "absent" : read.isError === true ? "refused" : "ran"}: ${read?.text.trim().slice(0, 80) ?? "-"}`,
  );
  check(
    "the run ended on its ask, with no reply after it",
    last?.kind === "toolResult" && last.toolName === "ask" && !last.isError,
    `last=${last?.kind ?? "-"}/${last?.toolName ?? "-"}`,
  );
  const thread = yield* client.listTaskComments({ taskId: TASK });
  observed.facts["thread"] = thread;
  check(
    "the question is on the task, written by the run",
    thread.length === 1 &&
      thread[0]?.kind === "question" &&
      thread[0].actor === SESSION &&
      thread[0].body === QUESTION,
    `comments=${thread.length} kind=${thread[0]?.kind ?? "-"} actor=${thread[0]?.actor ?? "-"}`,
  );
});

/** The prompt sections the run's own log leaves in effect: what the model was sent. */
const promptOf = (sessionId: SessionId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    return yield* Effect.acquireUseRelease(
      Effect.promise(() => PostgresStorage.reader(sql, sessionId)),
      (storage) => readPromptSections(storage),
      (storage) => Effect.promise(() => storage.dispose()),
    );
  }).pipe(Effect.provide(DatabaseLive));

const told = Effect.gen(function* () {
  const client = yield* RpcClient.make(RpcApi);
  const settled = yield* poll(
    client.getSession({ sessionId: SESSION }),
    (snapshot) =>
      !snapshot.live.busy &&
      snapshot.entries.some(
        (entry) => entry.kind === "assistant" && entry.text !== "",
      ),
    30,
  );
  check(
    "the next run settled with a reply",
    settled.met,
    `busy=${settled.value.live.busy} after ${settled.ms}ms`,
  );
  const sections = yield* promptOf(SESSION);
  const thread = sections[THREAD_SECTION_KEY] ?? "";
  observed.facts["recordedThreadSection"] = thread;
  check(
    "the next run's recorded prompt quotes the answer verbatim",
    thread.includes(`\n${ANSWER}\n`),
    `task_thread section ${thread.length} chars`,
  );
  check(
    "and the question it answers, before it",
    thread.includes(QUESTION) &&
      thread.indexOf(QUESTION) < thread.indexOf(ANSWER),
    "question precedes answer",
  );
  const card = yield* client.getTask({ taskId: TASK });
  check(
    "holding the answer, the next run did not ask again",
    card.blocked === undefined &&
      !settled.value.entries.some((entry) => entry.toolName === "ask"),
    `blocked=${card.blocked?.reason ?? "-"}`,
  );
});

/** Run one phase; a phase that fails outright is a failed check, not a crash with no evidence. */
const run = <E>(
  phase: Effect.Effect<void, E, RpcClient.Protocol | Scope.Scope>,
): Promise<void> =>
  Effect.runPromise(
    Effect.scoped(phase).pipe(
      Effect.provide(protocolFor(API_URL)),
      Effect.catch((error) =>
        Effect.sync(() => {
          check(`the ${MODE} probe ran`, false, String(error));
        }),
      ),
    ),
  );

if (MODE === "busy") await run(busy);
else if (MODE === "parked") await run(parked);
else if (MODE === "told") await run(told);
else {
  console.error("ask.ts: MODE must be one of busy, parked, told");
  process.exit(2);
}

await mkdir(EVIDENCE_DIR, { recursive: true });
await writeFile(
  path.join(EVIDENCE_DIR, `${EVIDENCE_PREFIX}-${MODE}.json`),
  `${JSON.stringify(observed, null, 2)}\n`,
);
process.exit(Object.values(observed.checks).every((c) => c.passed) ? 0 : 1);
