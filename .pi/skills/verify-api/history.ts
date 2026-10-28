// A long session's history over the wire (LOB-243): a historical read carries the newest entries
// and pages back through the rest on request.
//
//   bun history.ts      (via ./history.sh, which owns the API instance this drives)
//
// The API this talks to releases an idle owner after SESSION_IDLE_TIMEOUT_MS, so a session nobody
// is running is read through the fold. One session is grown past the historical window with faux
// turns, then read once released, through the same RPC client the CLI and the dashboard build:
//
//   window    getSession reads `historical`, carries HISTORY_WINDOW entries, and `earlier` names the
//             oldest of them; the stream's one snapshot says the same
//   history   readSessionHistory pages back from `earlier` to the first entry: every page within
//             its limit, ids strictly increasing across the joined pages, every turn's message
//             exactly once and in order, the first one first
//   refusals  a `before` that is not an entry id → `invalid_input`; an unknown session → `not_found`
//
// Env: API_URL, EVIDENCE_DIR, HISTORY_WINDOW (the server's window, 200).
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { SessionRpc } from "@repo/domain/Rpc";
import type {
  SessionHistoryPage,
  SessionSnapshot,
  TranscriptEntry,
} from "@repo/domain/Session";
import { SessionId } from "@repo/domain/Session";
import { Effect, Stream } from "effect";
import { RpcClient } from "effect/rpc";
import { makeChecker, protocolFor, waitUntil } from "./harness.ts";
import type { CheckRecord } from "./harness.ts";

const API_URL = process.env["API_URL"] ?? "http://localhost:9437";
const EVIDENCE_DIR =
  process.env["EVIDENCE_DIR"] ?? ".verify/evidence/latest/api";
const WINDOW = Number(process.env["HISTORY_WINDOW"] ?? "200");
/** How far past the window the session is grown, so the history is more than one page. */
const BEYOND = 60;
const PAGE = 50;
const MAX_TURNS = 150;

await mkdir(EVIDENCE_DIR, { recursive: true });

const observed: {
  apiUrl: string;
  window: number;
  sessionId: string;
  turns: number;
  liveEntries: number;
  historical: { entries: number; earlier: string | undefined };
  pages: ReadonlyArray<{ entries: number; first?: string; earlier?: string }>;
  checks: Record<string, CheckRecord>;
} = {
  apiUrl: API_URL,
  window: WINDOW,
  sessionId: "",
  turns: 0,
  liveEntries: 0,
  historical: { entries: 0, earlier: undefined },
  pages: [],
  checks: {},
};
const assert = makeChecker(observed);

const turnText = (turn: number) => `history turn ${turn}`;

const program = Effect.gen(function* () {
  const client = yield* RpcClient.make(SessionRpc);
  const created = yield* client.createSession({ title: "a long history" });
  observed.sessionId = created.id;

  // --- grow the session past the window: one faux turn at a time --------------------------------
  let live: SessionSnapshot | undefined;
  let turn = 0;
  while (turn < MAX_TURNS) {
    yield* client.sendMessage({
      sessionId: created.id,
      content: turnText(turn),
    });
    const expected = turnText(turn);
    live = yield* waitUntil(
      client
        .getSession({ sessionId: created.id })
        .pipe(
          Effect.map((snapshot) =>
            !snapshot.live.busy &&
            snapshot.entries.some(
              (entry) =>
                entry.kind === "assistant" &&
                entry.text.includes(`(re: ${expected})`),
            )
              ? snapshot
              : undefined,
          ),
        ),
      `turn ${turn} to settle`,
    );
    turn += 1;
    // A session read while owned is live and carries everything; once it is past the window by a
    // margin, its history is more than one page.
    if (live.session.mode === "live" && live.entries.length > WINDOW + BEYOND)
      break;
  }
  observed.turns = turn;
  observed.liveEntries = live?.entries.length ?? 0;
  assert(
    "the session grew past the historical window",
    live !== undefined && live.entries.length > WINDOW + BEYOND,
    `turns=${turn} entries=${live?.entries.length ?? 0} window=${WINDOW}`,
  );

  // --- window: released, the read is a fold that carries the newest entries only ---------------
  // The wait is read-free, as drive.ts's is: a read counts as use and keeps the owner open. Twice
  // history.sh's 4 s idle timeout covers the timeout and the sweep that acts on it.
  yield* Effect.sleep(8_000);
  const historical = yield* waitUntil(
    client
      .getSession({ sessionId: created.id })
      .pipe(
        Effect.map((snapshot) =>
          snapshot.session.mode === "historical" ? snapshot : undefined,
        ),
      ),
    "the idle owner to be released",
  );
  observed.historical = {
    entries: historical.entries.length,
    earlier: historical.earlier,
  };
  assert(
    "a historical read carries the newest HISTORY_WINDOW entries",
    historical.entries.length === WINDOW,
    `entries=${historical.entries.length}`,
  );
  assert(
    "`earlier` names the oldest entry carried",
    historical.earlier !== undefined &&
      historical.earlier === historical.entries[0]?.id,
    `earlier=${historical.earlier} first=${historical.entries[0]?.id}`,
  );
  assert(
    "the window is the tail of the transcript the live read carried",
    live !== undefined &&
      JSON.stringify(historical.entries.map((entry) => entry.id)) ===
        JSON.stringify(live.entries.slice(-WINDOW).map((entry) => entry.id)),
    `last=${historical.entries.at(-1)?.id} liveLast=${live?.entries.at(-1)?.id}`,
  );
  const streamed = yield* client
    .watchSession({ sessionId: created.id })
    .pipe(Stream.runCollect);
  const snapshotEvent = streamed[0];
  assert(
    "the stream's one snapshot carries the same window and `earlier`",
    streamed.length === 1 &&
      snapshotEvent?._tag === "snapshot" &&
      snapshotEvent.entries.length === WINDOW &&
      snapshotEvent.earlier === historical.earlier,
    `events=${streamed.length} earlier=${snapshotEvent?._tag === "snapshot" ? snapshotEvent.earlier : "-"}`,
  );

  // --- history: page back from `earlier` to the first entry -------------------------------------
  const pages: SessionHistoryPage[] = [];
  let before = historical.earlier;
  while (before !== undefined && pages.length < 100) {
    const page = yield* client.readSessionHistory({
      sessionId: created.id,
      before,
      limit: PAGE,
    });
    pages.push(page);
    before = page.earlier;
  }
  observed.pages = pages.map((page) => ({
    entries: page.entries.length,
    ...(page.entries[0] === undefined ? {} : { first: page.entries[0].id }),
    ...(page.earlier === undefined ? {} : { earlier: page.earlier }),
  }));
  const joined: TranscriptEntry[] = [
    ...pages.toReversed().flatMap((page) => page.entries),
    ...historical.entries,
  ];
  const ids = joined.map((entry) => Number(entry.id));
  assert(
    "every page is within its limit, and the last reaches the first entry",
    pages.length > 1 &&
      pages.every((page) => page.entries.length <= PAGE) &&
      pages.at(-1)?.earlier === undefined,
    `pages=${pages.map((page) => page.entries.length).join(",")}`,
  );
  assert(
    "the pages and the window join into one transcript, ids strictly increasing",
    ids.every((id, index) => index === 0 || id > (ids[index - 1] ?? 0)) &&
      joined.length === (live?.entries.length ?? -1),
    `joined=${joined.length} live=${live?.entries.length ?? 0}`,
  );
  const messages = joined
    .filter((entry) => entry.kind === "user")
    .map((entry) => entry.text);
  assert(
    "every turn's message is there exactly once, in order, the first one first",
    JSON.stringify(messages) ===
      JSON.stringify(Array.from({ length: turn }, (_, at) => turnText(at))),
    `messages=${messages.length} turns=${turn} first=${messages[0]}`,
  );

  // --- refusals ---------------------------------------------------------------------------------
  const refused = yield* client
    .readSessionHistory({ sessionId: created.id, before: "first" })
    .pipe(Effect.flip);
  assert(
    "a `before` that is not an entry id is refused as invalid_input",
    refused._tag === "SessionError" && refused.code === "invalid_input",
    `${refused._tag}:${"code" in refused ? refused.code : ""}`,
  );
  const missing = yield* client
    .readSessionHistory({
      sessionId: SessionId.make(`ses_${"0".repeat(26)}`),
      before: "1",
    })
    .pipe(Effect.flip);
  assert(
    "an unknown session is refused as not_found",
    missing._tag === "SessionError" && missing.code === "not_found",
    `${missing._tag}:${"code" in missing ? missing.code : ""}`,
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
  path.join(EVIDENCE_DIR, "history.json"),
  `${JSON.stringify(observed, null, 2)}\n`,
);
await writeFile(
  path.join(EVIDENCE_DIR, "history-session.env"),
  `SESSION=${observed.sessionId}\nEARLIER=${observed.historical.earlier ?? ""}\n`,
);

const failed = Object.entries(observed.checks).filter(
  ([, check]) => !check.passed,
);
if (failed.length > 0) {
  console.error(`\n${failed.length} required check(s) failed`);
  process.exitCode = 1;
}
