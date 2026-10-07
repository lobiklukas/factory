// Drive the session RPC surface with the real Effect RPC client.
//
//   bun drive.ts
//
// Env:
//   API_URL       default http://localhost:9200
//   EVIDENCE_DIR  default .verify/evidence/latest
//
// Why a client and not curl: curl proves a route is mounted. This uses the same
// `RpcClient` a CLI or the dashboard uses, over the same NDJSON protocol, so a broken
// schema, a mis-declared stream, or a lost typed error all fail here. See
// features/session-stream.md.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { SessionRpc } from "@repo/domain/Rpc";
import { Effect, Exit, Fiber, Ref, Stream } from "effect";
import { RpcClient } from "effect/rpc";
import { makeChecker, protocolFor, waitUntil } from "./harness.ts";

const API_URL = process.env["API_URL"] ?? "http://localhost:9200";
const EVIDENCE_DIR = process.env["EVIDENCE_DIR"] ?? ".verify/evidence/latest";

/** Distinctive, so the answer can only have come from this prompt. */
const PROMPT = "verify-api probe";
const EXPECTED_ANSWER = `faux-ok (re: ${PROMPT})`;

await mkdir(EVIDENCE_DIR, { recursive: true });

const observed = {
  apiUrl: API_URL,
  probes: {},
  checks: {},
  events: [],
  transcript: [],
};
const assert = makeChecker(observed);

const ProtocolLive = protocolFor(API_URL);

/**
 * Feature: the probes (LOB-21). `/livez` must answer without touching the database, and `/readyz`
 * must answer from a live check of Postgres, the migration ledger, and the tables a session request
 * reads. Both are plain HTTP — the RPC client cannot reach them.
 */
const probe = async (route) => {
  const response = await fetch(`${API_URL}${route}`);
  return {
    status: response.status,
    body: await response.json().catch(() => null),
  };
};

const livez = await probe("/livez");
assert(
  "GET /livez answers 200",
  livez.status === 200 && livez.body?.status === "ok",
  `status=${livez.status} body=${JSON.stringify(livez.body)}`,
);

const readyz = await probe("/readyz");
const readyzChecks = readyz.body?.checks ?? [];
assert(
  "GET /readyz answers 200 with every check ok",
  readyz.status === 200 &&
    readyz.body?.status === "ok" &&
    readyzChecks.length > 0 &&
    readyzChecks.every((check) => check.ok),
  `status=${readyz.status} checks=${JSON.stringify(readyzChecks)}`,
);

/**
 * Feature: the transport request cap (LOB-21). `up.sh` runs the instance with
 * `MAX_REQUEST_BODY_BYTES=1 MiB`, so a 2 MiB body must be refused at the transport — before any RPC
 * parsing — and the process must still be serving afterwards. Bun's own default is 128 MiB, so this
 * check fails if the configured cap is lost.
 */
const oversizedBody = "x".repeat(2 * 1024 * 1024);
const capped = await fetch(`${API_URL}/rpc`, {
  method: "POST",
  headers: { "content-type": "application/x-ndjson" },
  body: oversizedBody,
})
  .then((response) => response.status)
  .catch(() => 0);
assert(
  "an oversized request body is refused",
  capped === 413,
  `status=${capped} (body=${oversizedBody.length} bytes)`,
);

const afterCap = await probe("/livez");
assert(
  "the server survives an oversized body",
  afterCap.status === 200,
  `livez=${afterCap.status}`,
);

observed.probes = {
  livez: livez.body,
  readyz: readyz.body,
  oversizedBodyStatus: capped,
};

const textOf = (entry) => entry.text;
const lastAssistant = (entries) =>
  entries.filter((entry) => entry.kind === "assistant").at(-1);

const program = Effect.gen(function* () {
  const client = yield* RpcClient.make(SessionRpc);
  const context = yield* Effect.context();

  // Feature: create. A retried create with the same request id must not make a second
  // session, or every client retry leaks a log.
  const requestId = `verify-api-${Date.now()}`;
  const created = yield* client.createSession({ requestId });
  const retried = yield* client.createSession({ requestId });
  assert(
    "createSession",
    /^ses_[0-9abcdefghjkmnpqrstvwxyz]{26}$/.test(created.id),
    `id=${created.id} mode=${created.mode} status=${created.status}`,
  );
  assert(
    "createSession is idempotent by requestId",
    retried.id === created.id,
    `retry id=${retried.id}`,
  );

  // Feature: repo binding (LOB-5). A session names a repo at a base ref, and its snapshot exposes
  // the workspace the server resolved — including the commands the repo declares about itself in
  // `.factory/config`. The registered local path is this skill's fixture.
  const repoSlug = "lobiklukas/verify-api-fixture";
  const repoUrl = "https://github.com/lobiklukas/factory.git";
  const fixture = path.resolve(
    new URL(".", import.meta.url).pathname,
    "fixtures",
    "repo",
  );
  const registered = yield* client.registerRepo({
    repo: repoSlug,
    url: repoUrl,
    defaultBaseRef: "main",
    localPath: fixture,
  });
  assert(
    "registerRepo",
    registered.repo === repoSlug &&
      registered.url === repoUrl &&
      registered.defaultBaseRef === "main",
    `repo=${registered.repo} url=${registered.url} base=${registered.defaultBaseRef}`,
  );

  const bound = yield* client.createSession({
    repo: repoSlug,
    baseRef: "main",
    title: "repo binding probe",
  });
  assert(
    "a session summary carries its repo and base ref",
    bound.repo === repoSlug && bound.baseRef === "main",
    `repo=${bound.repo} baseRef=${bound.baseRef}`,
  );

  const boundSnapshot = yield* client.getSession({ sessionId: bound.id });
  assert(
    "the snapshot exposes the resolved workspace",
    boundSnapshot.workspace.repo === repoSlug &&
      boundSnapshot.workspace.baseRef === "main" &&
      boundSnapshot.workspace.path.includes(
        path.join("lobiklukas", "verify-api-fixture"),
      ),
    `workspace=${JSON.stringify(boundSnapshot.workspace)}`,
  );
  assert(
    "the workspace carries the repo's own commands",
    boundSnapshot.workspace.commandsSource === "repo" &&
      boundSnapshot.workspace.commands.test === "bun run test" &&
      boundSnapshot.workspace.commands.verify ===
        "bun .pi/skills/verify-api/drive.ts",
    `source=${boundSnapshot.workspace.commandsSource} commands=${JSON.stringify(boundSnapshot.workspace.commands)}`,
  );

  // Feature: the session list (LOB-6). A session created a moment ago is in the list without any
  // read of its own, the list is ordered by newest activity, and it pages by cursor.
  const listed = yield* client.listSessions({ limit: 25 });
  assert(
    "listSessions shows a new session without a poll",
    listed.sessions.some((entry) => entry.id === bound.id) &&
      listed.sessions.some((entry) => entry.id === created.id),
    `${listed.sessions.length} entries, first=${listed.sessions[0]?.id}`,
  );
  const listedEntry = listed.sessions.find((entry) => entry.id === bound.id);
  assert(
    "a list entry carries status, repo, activity, and spend",
    listedEntry !== undefined &&
      listedEntry.repo === repoSlug &&
      listedEntry.status === "idle" &&
      listedEntry.lastActivityAt.length > 0 &&
      listedEntry.costTotal >= 0,
    JSON.stringify(listedEntry ?? null),
  );
  const listKeys = listed.sessions.map(
    (entry) => `${entry.lastActivityAt}|${entry.id}`,
  );
  assert(
    "the list is newest activity first",
    JSON.stringify(listKeys) === JSON.stringify([...listKeys].sort().reverse()),
    `${listKeys.length} keys, first=${listKeys[0]}`,
  );

  // One row per page, not two: the service mints a cursor only when a further row exists (it asks
  // Postgres for `limit + 1`), so a page whose size equals the table's row count *ends* the walk
  // instead of starting one. This driver creates exactly two sessions, so 1 is the largest limit
  // that is guaranteed to leave a row behind. At 2 the first page covered a clean database,
  // `nextCursor` was correctly absent, and the second call — made with an undefined cursor — was a
  // repeat of the first (LOB-140).
  const firstPage = yield* client.listSessions({ limit: 1 });
  const secondPage = yield* client.listSessions({
    limit: 1,
    cursor: firstPage.nextCursor,
  });
  assert(
    "listSessions pages by cursor without repeating a row",
    firstPage.sessions.length === 1 &&
      firstPage.nextCursor !== undefined &&
      secondPage.sessions.length === 1 &&
      secondPage.sessions.every(
        (entry) => !firstPage.sessions.some((first) => first.id === entry.id),
      ),
    `page1=${firstPage.sessions.map((entry) => entry.id).join(",")} page2=${secondPage.sessions.map((entry) => entry.id).join(",")}`,
  );

  // Feature: watch a live session. Attach *before* sending, so the first event is the
  // state before the message and everything after it is a real delta.
  const collected = yield* Ref.make([]);
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

  // Feature: send.
  const sent = yield* client.sendMessage({
    sessionId: created.id,
    content: PROMPT,
  });
  assert(
    "sendMessage",
    sent.placement === "run",
    `placement=${sent.placement} submission=${sent.submissionId} title=${JSON.stringify(sent.session.title)}`,
  );
  assert(
    "the first message names the session",
    sent.session.title === PROMPT,
    `title=${JSON.stringify(sent.session.title)}`,
  );

  yield* waitUntil(
    client
      .getSession({ sessionId: created.id })
      .pipe(Effect.map((snapshot) => !snapshot.live.busy)),
    "the turn to settle",
  );
  yield* Fiber.interrupt(watcher);

  const events = yield* Ref.get(collected);
  observed.events = events.map((event) =>
    event._tag === "snapshot"
      ? {
          _tag: event._tag,
          mode: event.session.mode,
          entries: event.entries.length,
        }
      : event._tag === "entry"
        ? { _tag: event._tag, kind: event.entry.kind, text: event.entry.text }
        : event._tag === "status"
          ? { _tag: event._tag, status: event.status }
          : { _tag: event._tag },
  );

  const snapshot = events[0];
  assert(
    "the stream opens with a live snapshot",
    snapshot?._tag === "snapshot" &&
      snapshot.session.mode === "live" &&
      snapshot.entries.length === 0,
    `first event=${snapshot?._tag} mode=${snapshot?.session?.mode}`,
  );
  assert(
    "the stream carries entries as they commit",
    events.some((event) => event._tag === "entry"),
    `${events.filter((event) => event._tag === "entry").length} entry event(s)`,
  );
  const statuses = events.flatMap((event) =>
    event._tag === "status" ? [event.status] : [],
  );
  assert(
    "the stream carries run state",
    statuses.includes("busy") && statuses.includes("idle"),
    `status events: ${statuses.join(" -> ")}`,
  );
  const streamedEntry = events.find(
    (event) => event._tag === "entry" && event.entry.text === EXPECTED_ANSWER,
  );
  assert(
    "the stream carries the answer",
    streamedEntry !== undefined,
    `looking for ${JSON.stringify(EXPECTED_ANSWER)}`,
  );

  // Feature: read. The transcript, with the tool call the answer depended on.
  const live = yield* client.getSession({ sessionId: created.id });
  observed.transcript = live.entries.map((entry) => ({
    kind: entry.kind,
    text: entry.text,
    toolName: entry.toolName ?? null,
  }));
  assert(
    "getSession returns the transcript",
    lastAssistant(live.entries)?.text === EXPECTED_ANSWER,
    `last assistant entry = ${JSON.stringify(lastAssistant(live.entries)?.text)}`,
  );
  assert(
    "the tool call is in the transcript",
    live.entries.some(
      (entry) => entry.kind === "toolResult" && entry.toolName === "bash",
    ),
    `entries: ${live.entries.map((entry) => entry.kind).join(", ")}`,
  );
  assert(
    "usage is attributed",
    (live.usage.models[0]?.usage.totalTokens ?? 0) > 0,
    JSON.stringify(live.usage.models[0] ?? null),
  );

  // Feature: the fold. Wait for the owner to be released (SESSION_IDLE_TIMEOUT_MS in
  // up.sh, 2s there so this is reachable), then read the same session again: D8 says
  // the control plane serves a paused session by folding its log, and it must not
  // disagree with the live read it replaced.
  //
  // The wait is deliberate and read-free: a read counts as use and keeps the owner
  // open, so idling *is* the thing under test here.
  yield* Effect.sleep(6_000);
  const folded = yield* waitUntil(
    client
      .getSession({ sessionId: created.id })
      .pipe(
        Effect.map((snapshot) =>
          snapshot.session.mode === "historical" ? snapshot : undefined,
        ),
      ),
    "the owner to be released",
  );
  assert(
    "a released session reads as historical",
    folded.session.mode === "historical" && folded.session.status === "idle",
    `mode=${folded.session.mode} status=${folded.session.status}`,
  );
  assert(
    "the fold agrees with the live read",
    JSON.stringify(folded.entries.map(textOf)) ===
      JSON.stringify(live.entries.map(textOf)),
    `${folded.entries.length} entries, live had ${live.entries.length}`,
  );

  // A historical session's stream is one snapshot and then it ends: a completed fold
  // must be distinguishable from a dropped connection.
  const historicalEvents = Array.from(
    yield* client
      .watchSession({ sessionId: created.id })
      .pipe(Stream.runCollect),
  );
  assert(
    "a historical stream ends after its snapshot",
    historicalEvents.length === 1 && historicalEvents[0]?._tag === "snapshot",
    `${historicalEvents.length} event(s): ${historicalEvents.map((event) => event._tag).join(", ")}`,
  );

  // Feature: request limits. An oversized message is refused with a typed error rather than
  // crashing the server or being silently truncated.
  const oversized = yield* Effect.exit(
    client.sendMessage({
      sessionId: bound.id,
      content: "x".repeat(100_001),
    }),
  );
  const oversizedFailure = Exit.findErrorOption(oversized);
  assert(
    "an oversized message is refused with a typed error",
    Exit.isFailure(oversized) &&
      oversizedFailure._tag === "Some" &&
      oversizedFailure.value._tag === "SessionError" &&
      oversizedFailure.value.code === "invalid_input",
    JSON.stringify(oversizedFailure),
  );

  // Feature: typed errors cross the wire.
  const missing = yield* Effect.exit(
    client.getSession({ sessionId: "ses_00000000000000000000000000" }),
  );
  const failure = Exit.findErrorOption(missing);
  assert(
    "an unknown session fails with a typed error",
    Exit.isFailure(missing) &&
      failure._tag === "Some" &&
      failure.value._tag === "SessionError" &&
      failure.value.code === "not_found",
    JSON.stringify(failure),
  );

  // Feature: interrupt wakes and stops. After the fold it is not owned, so this also
  // proves steering wakes a session before acting on it (D8).
  const interrupted = yield* client.interruptSession({ sessionId: created.id });
  assert(
    "interruptSession leaves the session idle",
    interrupted.status === "idle",
    `mode=${interrupted.mode} status=${interrupted.status}`,
  );

  return { id: created.id };
}).pipe(Effect.provide(ProtocolLive), Effect.scoped);

let sessionId = null;
try {
  const result = await Effect.runPromise(program);
  sessionId = result.id;
} catch (error) {
  assert("drive completed", false, `threw: ${String(error)}`);
}

observed.sessionId = sessionId;
observed.consoleErrors = [];
await writeFile(
  path.join(EVIDENCE_DIR, "observed.json"),
  `${JSON.stringify(observed, null, 2)}\n`,
);
await writeFile(
  path.join(EVIDENCE_DIR, "session.txt"),
  `${observed.transcript
    .map(
      (entry) =>
        `${entry.kind}: ${entry.text}${entry.toolName ? ` (${entry.toolName})` : ""}`,
    )
    .join("\n")}\n`,
);

console.log(`\nevidence: ${path.resolve(EVIDENCE_DIR)}`);
const failed = Object.entries(observed.checks).filter(
  ([, check]) => !check.passed,
);
if (failed.length > 0) {
  console.error(`\n${failed.length} required check(s) failed`);
  process.exitCode = 1;
}
