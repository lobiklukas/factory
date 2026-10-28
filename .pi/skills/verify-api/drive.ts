// Drive the session RPC surface with the real Effect RPC client.
//
//   bun drive.ts
//
// Env:
//   API_URL       default http://localhost:9200
//   EVIDENCE_DIR  default .verify/evidence/latest
//   DATABASE_URL  required: the database the API writes. The replay check reads the replay's log
//                 there, as a reader (no migrator, no owner), because no RPC answers the link it
//                 records. Never defaulted, so a drive cannot read the shared `factory` database.
//   REPLAY_MODEL  default faux/faux-2, the second model up.sh publishes for the replay check (up.sh
//                 reads the same variable, so set it for both)
//
// Why a client and not curl: curl proves a route is mounted. This uses the same
// `RpcClient` a CLI or the dashboard uses, over the same NDJSON protocol, so a broken
// schema, a mis-declared stream, or a lost typed error all fail here. See
// features/session-stream.md.
import { realpathSync } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { ApprovalsRpc, SessionRpc, TasksRpc } from "@repo/domain/Rpc";
import { DefinitionId } from "@repo/domain/Task";
import {
  RepoSlug,
  SessionId,
  type SessionEvent,
  type SessionSnapshot,
  type TranscriptEntry,
} from "@repo/domain/Session";
import { readSessionLog } from "@repo/harness";
import { PostgresLive, PostgresStorage } from "@repo/storage-postgres";
import { Effect, Exit, Fiber, Ref, Stream } from "effect";
import { RpcClient } from "effect/rpc";
import { SqlClient } from "effect/sql/SqlClient";
import {
  type CheckRecord,
  makeChecker,
  probeFor,
  protocolFor,
  waitUntil,
} from "./harness.ts";

const API_URL = process.env["API_URL"] ?? "http://localhost:9200";
const EVIDENCE_DIR = process.env["EVIDENCE_DIR"] ?? ".verify/evidence/latest";

/** Distinctive, so the answer can only have come from this prompt. */
const PROMPT = "verify-api probe";
const EXPECTED_ANSWER = `faux-ok (re: ${PROMPT})`;
/** The replay check's prompt: its own, so the replay's first entry can only be this source's. */
const REPLAY_PROMPT = `${PROMPT} replay`;
/** The model every session on the instance runs on (`FAUX_MODEL_ID`), and the one a replay picks. */
const DEPLOYMENT_MODEL = "faux/faux-1";
const REPLAY_MODEL = process.env["REPLAY_MODEL"] ?? "faux/faux-2";

if (!process.env["DATABASE_URL"]) {
  console.error(
    "drive.ts needs DATABASE_URL: the database the API from ./up.sh writes",
  );
  process.exit(2);
}

await mkdir(EVIDENCE_DIR, { recursive: true });

const observed: {
  apiUrl: string;
  probes: Record<string, unknown>;
  checks: Record<string, CheckRecord>;
  events: ReadonlyArray<unknown>;
  transcript: ReadonlyArray<{
    readonly kind: string;
    readonly text: string;
    readonly toolName: string | null;
  }>;
  fork?: Record<string, unknown>;
  replay?: Record<string, unknown>;
  sessionId?: SessionId | null;
  consoleErrors?: ReadonlyArray<string>;
} = {
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
const probe = probeFor(API_URL);

const livez = await probe("/livez");
assert(
  "GET /livez answers 200",
  livez.status === 200 && livez.answer?.status === "ok",
  `status=${livez.status} body=${JSON.stringify(livez.body)}`,
);

const readyz = await probe("/readyz");
const readyzChecks = readyz.answer?.checks ?? [];
assert(
  "GET /readyz answers 200 with every check ok",
  readyz.status === 200 &&
    readyz.answer?.status === "ok" &&
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

const textOf = (entry: TranscriptEntry) => entry.text;

/** Both `pi.usage` buckets, as one number: the total a session has spent on models and tools. */
const tokensOf = (snapshot: SessionSnapshot) =>
  [...snapshot.usage.models, ...snapshot.usage.tools].reduce(
    (total, bucket) => total + bucket.usage.totalTokens,
    0,
  );
const lastAssistant = (entries: ReadonlyArray<TranscriptEntry>) =>
  entries.filter((entry) => entry.kind === "assistant").at(-1);
const firstUser = (entries: ReadonlyArray<TranscriptEntry>) =>
  entries.find((entry) => entry.kind === "user")?.text;
/** The models a session's usage is keyed by: the ones it really sent requests to. */
const modelKeys = (snapshot: SessionSnapshot) =>
  snapshot.usage.models.map((model) => model.key);
/** A replay check's run has settled on the faux answer to its prompt, not merely gone idle. */
const answered = (snapshot: SessionSnapshot) =>
  !snapshot.live.busy &&
  lastAssistant(snapshot.entries)?.text === `faux-ok (re: ${REPLAY_PROMPT})`;
/** The `SessionError` code a refused call failed with, `"ok"` when it succeeded. */
const refusalCode = (exit: Exit.Exit<unknown, { readonly _tag: string }>) => {
  if (Exit.isSuccess(exit)) return "ok";
  const failure = Exit.findErrorOption(exit);
  if (failure._tag === "None") return "defect";
  return failure.value._tag === "SessionError" && "code" in failure.value
    ? String(failure.value.code)
    : failure.value._tag;
};

/**
 * A replay's own log as a rebuild folds it, read through a reader-mode storage: it never owns the
 * log, so it cannot collide with the API that does (two owners of one log poison each other). The
 * client is `PostgresLive`, provided here and nowhere else: no migrator runs against the API's
 * database, and no other check depends on reaching Postgres.
 */
const replayLink = (sessionId: SessionId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    return yield* Effect.acquireUseRelease(
      Effect.promise(() => PostgresStorage.reader(sql, sessionId)),
      readSessionLog,
      (storage) => Effect.promise(() => storage.dispose()),
    );
  }).pipe(Effect.provide(PostgresLive));

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
  const repoSlug = RepoSlug.make("lobiklukas/verify-api-fixture");
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

  // Feature: the registry read (LOB-253). `listRepos` holds the row `registerRepo` answered, each
  // with what its checkout says about itself; `getRepo` answers the same row; an unknown slug is
  // `RepoNotFound` with its own tag; and a checkout that is not a git work tree is refused
  // `invalid_input` naming the path, with nothing written.
  assert(
    "registerRepo reads the checkout it was given",
    registered.localPath === fixture &&
      registered.localPathIsGit &&
      registered.hasFactoryConfig &&
      // The fixture is a directory inside this checkout: the work tree named is the enclosing one.
      registered.workTree !== undefined &&
      realpathSync(fixture).startsWith(`${registered.workTree}/`),
    `localPath=${registered.localPath} git=${registered.localPathIsGit} config=${registered.hasFactoryConfig} workTree=${registered.workTree}`,
  );
  const repos = yield* client.listRepos({});
  const listedRepo = repos.repos.find((row) => row.repo === repoSlug);
  assert(
    "listRepos holds the registered row as registerRepo answered it",
    JSON.stringify(listedRepo) === JSON.stringify(registered),
    `${repos.repos.length} repos, row=${JSON.stringify(listedRepo ?? null)}`,
  );
  const gotRepo = yield* client.getRepo({ repo: repoSlug });
  assert(
    "getRepo answers the same row",
    JSON.stringify(gotRepo) === JSON.stringify(registered),
    JSON.stringify(gotRepo),
  );
  const unknownRepo = RepoSlug.make(
    `lobiklukas/verify-api-unknown-${Date.now()}`,
  );
  const missingRepo = yield* Effect.flip(client.getRepo({ repo: unknownRepo }));
  assert(
    "getRepo for an unknown slug is RepoNotFound",
    missingRepo._tag === "RepoNotFound",
    `${missingRepo._tag}: ${missingRepo.message}`,
  );
  const refusedCheckout = yield* Effect.flip(
    client.registerRepo({
      repo: unknownRepo,
      localPath: path.parse(fixture).root,
    }),
  );
  const stillMissing = yield* Effect.flip(
    client.getRepo({ repo: unknownRepo }),
  );
  assert(
    "registerRepo refuses a path that is not a git work tree, writing nothing",
    refusedCheckout._tag === "SessionError" &&
      refusedCheckout.code === "invalid_input" &&
      refusedCheckout.message.includes("not a git work tree") &&
      stillMissing._tag === "RepoNotFound",
    `${refusedCheckout._tag}: ${refusedCheckout.message}; then ${stillMissing._tag}`,
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

  // Feature: a repo with no local checkout says so when it is bound (LOB-263). Naming a repo is
  // enough to open a session, so the session opens — in an empty directory, with no worktree — and
  // its workspace carries the warning, with the command that fixes it. A repo with a checkout and a
  // scratch session carry none; a board over the repo carries the same warning on create and on read,
  // and registering a path clears the board's.
  const noCheckoutRepo = RepoSlug.make(
    `lobiklukas/verify-api-nocheckout-${Date.now()}`,
  );
  const noCheckoutFix = `factory repo add ${noCheckoutRepo} --path <dir>`;
  const unbound = yield* client.createSession({
    repo: noCheckoutRepo,
    title: "no checkout probe",
  });
  const unboundSnapshot = yield* client.getSession({ sessionId: unbound.id });
  assert(
    "a session bound to a repo with no local checkout opens and carries the warning",
    unbound.repo === noCheckoutRepo &&
      unboundSnapshot.workspace.warning?.includes(noCheckoutFix) === true,
    `warning=${unboundSnapshot.workspace.warning}`,
  );
  const scratchSnapshot = yield* client.getSession({ sessionId: created.id });
  assert(
    "a repo with a checkout and a scratch session carry no warning",
    boundSnapshot.workspace.warning === undefined &&
      scratchSnapshot.workspace.warning === undefined,
    `bound=${boundSnapshot.workspace.warning} scratch=${scratchSnapshot.workspace.warning}`,
  );
  const tasksClient = yield* RpcClient.make(TasksRpc);
  const warnedBoard = yield* tasksClient.createBoard({
    repo: noCheckoutRepo,
    definitionId: DefinitionId.make("default"),
  });
  const warnedRead = yield* tasksClient.getBoard({ boardId: warnedBoard.id });
  assert(
    "createBoard and getBoard over a repo with no local checkout carry the warning",
    warnedBoard.warning?.includes(noCheckoutFix) === true &&
      warnedRead.warning === warnedBoard.warning,
    `created=${warnedBoard.warning} read=${warnedRead.warning}`,
  );
  yield* client.registerRepo({ repo: noCheckoutRepo, localPath: fixture });
  const clearedRead = yield* tasksClient.getBoard({ boardId: warnedBoard.id });
  assert(
    "registering a checkout clears the board's warning",
    clearedRead.warning === undefined,
    `warning=${clearedRead.warning}`,
  );
  const cleanBoard = yield* tasksClient
    .createBoard({
      repo: repoSlug,
      definitionId: DefinitionId.make("default"),
    })
    .pipe(Effect.exit);
  assert(
    "a board over a repo with a checkout carries no warning",
    Exit.isSuccess(cleanBoard)
      ? cleanBoard.value.warning === undefined
      : // One board per repository: a rerun against this database finds the board it made.
        JSON.stringify(cleanBoard.cause).includes("BoardExists"),
    Exit.isSuccess(cleanBoard)
      ? `warning=${cleanBoard.value.warning}`
      : "the repo already had its board",
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
    `first event=${snapshot?._tag} mode=${snapshot?._tag === "snapshot" ? snapshot.session.mode : undefined}`,
  );
  // Feature: the live-task list (LOB-183). No durable task is started here — this driver has no
  // RPC that starts one — so the list is present and empty, which is what an idle session's panel
  // reads. The projection itself is proven in `packages/harness/src/tasks.test.ts`.
  assert(
    "the snapshot carries the live-task list",
    snapshot?._tag === "snapshot" &&
      Array.isArray(snapshot.tasks) &&
      snapshot.tasks.length === 0,
    `tasks=${JSON.stringify(snapshot?._tag === "snapshot" ? snapshot.tasks : null)}`,
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

  // Feature: fork (LOB-180). A session is one log (D7), so a fork is a second log holding the
  // parent's entries through the fork point. Its transcript must start as the parent's and then
  // diverge: a message admitted to the fork must not reach the parent, or the "try a different
  // approach" action would rewrite the history it was meant to leave alone.
  const forked = yield* client.forkSession({ sessionId: created.id });
  assert(
    "forkSession",
    /^ses_[0-9abcdefghjkmnpqrstvwxyz]{26}$/.test(forked.id) &&
      forked.id !== created.id &&
      forked.forkedFrom === created.id,
    `id=${forked.id} parent=${created.id} forkedFrom=${forked.forkedFrom}`,
  );
  const forkPrefix = yield* client.getSession({ sessionId: forked.id });
  assert(
    "the fork's transcript is the parent's prefix, text for text",
    JSON.stringify(forkPrefix.entries.map(textOf)) ===
      JSON.stringify(folded.entries.map(textOf)),
    `${forkPrefix.entries.length} fork entries, parent had ${folded.entries.length}`,
  );
  assert(
    "the fork's summary names the session it came from",
    forkPrefix.session.forkedFrom === created.id,
    `forkedFrom=${forkPrefix.session.forkedFrom}`,
  );

  const FORKED_PROMPT = `${PROMPT} fork`;
  yield* client.sendMessage({ sessionId: forked.id, content: FORKED_PROMPT });
  const forkSettled = yield* waitUntil(
    client
      .getSession({ sessionId: forked.id })
      .pipe(
        Effect.map((snapshot) => (snapshot.live.busy ? undefined : snapshot)),
      ),
    "the fork's run to settle",
  );
  const parentAfter = yield* client.getSession({ sessionId: created.id });
  assert(
    "a message sent to the fork does not appear in the parent",
    parentAfter.entries.every((entry) => !entry.text.includes(FORKED_PROMPT)) &&
      JSON.stringify(parentAfter.entries.map(textOf)) ===
        JSON.stringify(folded.entries.map(textOf)),
    `parent has ${parentAfter.entries.length} entries, folded read had ${folded.entries.length}`,
  );
  assert(
    "the fork keeps its prefix and answers on its own",
    forkSettled.entries.length > forkPrefix.entries.length &&
      forkSettled.entries
        .slice(0, forkPrefix.entries.length)
        .every(
          (entry, index) => entry.text === forkPrefix.entries[index]?.text,
        ) &&
      forkSettled.entries.some(
        (entry) => entry.text === `faux-ok (re: ${FORKED_PROMPT})`,
      ),
    `${forkSettled.entries.length} entries, last=${JSON.stringify(forkSettled.entries.at(-1)?.text)}`,
  );
  // Feature: the fork point is an entry of *this* session. The fork has grown past the parent's
  // last entry, so its newest entry id names no entry of the parent: asking the parent to fork there
  // must be a typed `invalid_input`, not a crash and not a fork of a history it never had. (Entry
  // ids are per-log numbers, so an id that exists in both logs *is* this session's entry; what a
  // foreign id can be is absent.)
  const foreignEntry = forkSettled.entries.at(-1)?.id ?? "0";
  const foreign = yield* Effect.exit(
    client.forkSession({ sessionId: created.id, at: foreignEntry }),
  );
  const foreignFailure = Exit.findErrorOption(foreign);
  assert(
    "forking at another session's entry is refused as invalid_input",
    Exit.isFailure(foreign) &&
      foreignFailure._tag === "Some" &&
      foreignFailure.value._tag === "SessionError" &&
      foreignFailure.value.code === "invalid_input",
    `at=${foreignEntry} ${JSON.stringify(foreignFailure)}`,
  );

  observed.fork = {
    id: forked.id,
    forkedFrom: forked.forkedFrom,
    prefixEntries: forkPrefix.entries.length,
    divergedEntries: forkSettled.entries.length,
    foreignRefusal: foreignEntry,
  };

  // Feature: replay (LOB-198, driven here by LOB-215). A replay is the same task in a new session on
  // another model: the source's first prompt is the replay's, its usage is keyed by the model it was
  // replayed onto, and the source's log is only read. `up.sh` publishes `REPLAY_MODEL` beside the
  // deployment's model, so the difference is one this drive can make with no key.
  //
  // The link between the two sessions is a `factory.replay` document in the replay's own log, and no
  // RPC answers it: it is read here the way a rebuild reads it, through a reader-mode storage over
  // the database the API writes. A replay that wrote everything else but not that document would
  // pass every wire check above it and fail this one.
  const replaySource = yield* client.createSession({
    repo: repoSlug,
    baseRef: "main",
    title: "replay probe",
  });
  yield* client.sendMessage({
    sessionId: replaySource.id,
    content: REPLAY_PROMPT,
  });
  const sourceRan = yield* waitUntil(
    client
      .getSession({ sessionId: replaySource.id })
      .pipe(Effect.map((state) => (answered(state) ? state : undefined))),
    "the replay source's answer",
  );
  const replay = yield* client.replaySession({
    sessionId: replaySource.id,
    model: REPLAY_MODEL,
  });
  assert(
    "replaySession answers a new session at the source's repo and base ref",
    /^ses_[0-9abcdefghjkmnpqrstvwxyz]{26}$/.test(replay.id) &&
      replay.id !== replaySource.id &&
      replay.repo === repoSlug &&
      replay.baseRef === "main" &&
      replay.title === replaySource.title &&
      // A replay is not a fork: nothing of the source's transcript is copied into it.
      replay.forkedFrom === undefined,
    `id=${replay.id} source=${replaySource.id} repo=${replay.repo} baseRef=${replay.baseRef} title=${JSON.stringify(replay.title)} forkedFrom=${replay.forkedFrom}`,
  );
  const replayRan = yield* waitUntil(
    client
      .getSession({ sessionId: replay.id })
      .pipe(Effect.map((state) => (answered(state) ? state : undefined))),
    "the replay's answer",
  );
  const sourcePrompt = firstUser(sourceRan.entries);
  const replayPrompt = firstUser(replayRan.entries);
  assert(
    "the replay's first user entry is the source's, text for text",
    sourcePrompt === REPLAY_PROMPT && replayPrompt === sourcePrompt,
    `source=${JSON.stringify(sourcePrompt ?? null)} replay=${JSON.stringify(replayPrompt ?? null)}`,
  );
  const sourceModels = modelKeys(sourceRan);
  const replayModels = modelKeys(replayRan);
  assert(
    "the replay ran on the model it was replayed onto, the source on its own",
    sourceModels.join(",") === DEPLOYMENT_MODEL &&
      replayModels.join(",") === REPLAY_MODEL,
    `source=${sourceModels.join(",") || "none"} replay=${replayModels.join(",") || "none"}`,
  );
  // The comparison (LOB-199) lands on both sessions once the replay's task settles, so the source
  // is read after its comparison does: what it gained is that document, and its transcript is not.
  const comparedSource = yield* waitUntil(
    client
      .getSession({ sessionId: replaySource.id })
      .pipe(
        Effect.map((snapshot) =>
          (snapshot.replayComparisons ?? []).length > 0 ? snapshot : false,
        ),
      ),
    "the source's replay comparison",
  );
  const comparedReplay = yield* waitUntil(
    client
      .getSession({ sessionId: replay.id })
      .pipe(
        Effect.map((snapshot) =>
          (snapshot.replayComparisons ?? []).length > 0 ? snapshot : false,
        ),
      ),
    "the replay's comparison",
  );
  const onSource = comparedSource.replayComparisons?.[0];
  const onReplay = comparedReplay.replayComparisons?.[0];
  assert(
    "getSession reports the comparison on both sides, each naming the other with opposite deltas",
    comparedSource.replayComparisons?.length === 1 &&
      comparedReplay.replayComparisons?.length === 1 &&
      onSource?.role === "source" &&
      onSource.counterpart.session === replay.id &&
      onSource.counterpart.model === REPLAY_MODEL &&
      onReplay?.role === "replay" &&
      onReplay.counterpart.session === replaySource.id &&
      onReplay.counterpart.model === DEPLOYMENT_MODEL &&
      onReplay.self.outcome === "answered" &&
      onReplay.counterpart.outcome === "answered" &&
      JSON.stringify(onSource.self) === JSON.stringify(onReplay.counterpart) &&
      onSource.delta.turns + onReplay.delta.turns === 0 &&
      onSource.delta.cost + onReplay.delta.cost === 0,
    `source=${JSON.stringify(onSource ?? null)} replay=${JSON.stringify(onReplay ?? null)}`,
  );
  const sourceAfter = comparedSource;
  assert(
    "the replayed session's transcript is unchanged",
    JSON.stringify(sourceAfter.entries) === JSON.stringify(sourceRan.entries),
    `${sourceRan.entries.length} entries before, ${sourceAfter.entries.length} after`,
  );
  const replayLog = yield* replayLink(replay.id);
  assert(
    "the replay's own log records the source and both models",
    replayLog.replay?.source === replaySource.id &&
      replayLog.replay.model === REPLAY_MODEL &&
      replayLog.replay.from === DEPLOYMENT_MODEL,
    `replay=${JSON.stringify(replayLog.replay ?? null)}`,
  );
  // Both comparisons are in the logs, not only in the API's answer: a fold of each reports the
  // same one, and the source's document names no source of its own, so it never reads as a replay.
  const sourceLog = yield* replayLink(replaySource.id);
  assert(
    "both logs carry the comparison, and the source is no replay",
    JSON.stringify(sourceLog.replayComparisons) ===
      JSON.stringify(comparedSource.replayComparisons) &&
      JSON.stringify(replayLog.replayComparisons) ===
        JSON.stringify(comparedReplay.replayComparisons) &&
      sourceLog.replay === undefined,
    `source=${sourceLog.replayComparisons.length} replay=${replayLog.replayComparisons.length} sourceLink=${JSON.stringify(sourceLog.replay ?? null)}`,
  );
  // A session nobody replayed reports no comparison: the drive's scratch session.
  const unreplayed = yield* client.getSession({ sessionId: created.id });
  assert(
    "a session that was never replayed reports no comparison",
    unreplayed.replayComparisons === undefined,
    `replayComparisons=${JSON.stringify(unreplayed.replayComparisons ?? null)}`,
  );

  // The refusals, typed over the wire: a model this process does not serve, and a session bound to
  // no repo (the scratch session this drive opened first). Neither may leave a session behind.
  const listedIds = client
    .listSessions({ limit: 250 })
    .pipe(
      Effect.map((listing) => listing.sessions.map((session) => session.id)),
    );
  const idsBefore = yield* listedIds;
  const unservedModel = yield* Effect.exit(
    client.replaySession({
      sessionId: replaySource.id,
      model: "faux/faux-unserved",
    }),
  );
  const noRepo = yield* Effect.exit(
    client.replaySession({ sessionId: created.id }),
  );
  const idsAfter = yield* listedIds;
  const refusals = {
    unservedModel: refusalCode(unservedModel),
    noRepo: refusalCode(noRepo),
  };
  assert(
    "a replay onto an unserved model, or of a session with no repo, is refused as invalid_input",
    refusals.unservedModel === "invalid_input" &&
      refusals.noRepo === "invalid_input" &&
      idsAfter.length === idsBefore.length &&
      idsAfter.every((id) => idsBefore.includes(id)),
    `${JSON.stringify(refusals)} sessions=${idsBefore.length}->${idsAfter.length}`,
  );
  observed.replay = {
    source: replaySource.id,
    replay: replay.id,
    prompts: { source: sourcePrompt ?? null, replay: replayPrompt ?? null },
    models: { source: sourceModels, replay: replayModels },
    log: replayLog.replay ?? null,
    comparisons: { source: onSource ?? null, replay: onReplay ?? null },
    refusals,
  };

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
    client.getSession({
      sessionId: SessionId.make("ses_00000000000000000000000000"),
    }),
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

  // Feature: reset (LOB-181). A reset starts a new model context whose first message is the handoff
  // note. The transcript keeps what came before it and marks the boundary with the `reset` entry,
  // so the old turns are still readable above the new context rather than truncated by it.
  const toReset = yield* client.createSession({
    requestId: `verify-api-reset-${Date.now()}`,
  });
  yield* client.sendMessage({
    sessionId: toReset.id,
    content: "reset probe: before",
  });
  // Wait for the answer itself, not for `busy` to be false: a read taken before the run starts would
  // see `idle`, the wait would pass at once, and the reset could land before the turn it is meant to
  // end — which would make the "one entry longer" assertion below meaningless.
  yield* waitUntil(
    client
      .getSession({ sessionId: toReset.id })
      .pipe(
        Effect.map((state) =>
          state.entries.some(
            (entry) => entry.kind === "assistant" && entry.text.length > 0,
          ),
        ),
      ),
    "the pre-reset turn to settle",
  );
  const beforeReset = yield* client.getSession({ sessionId: toReset.id });
  const handoff = "reset probe: carry on from here";
  const resetSummary = yield* client.resetSession({
    sessionId: toReset.id,
    handoff,
  });
  const afterReset = yield* client.getSession({ sessionId: toReset.id });
  const resetKinds = afterReset.entries.map((entry) => entry.kind);
  const resetEntry = afterReset.entries.find((entry) => entry.kind === "reset");
  assert(
    "resetSession answers with the session",
    resetSummary.id === toReset.id && resetSummary.status === "idle",
    `id=${resetSummary.id} mode=${resetSummary.mode} status=${resetSummary.status}`,
  );
  assert(
    "a reset keeps the transcript and marks where it happened",
    resetEntry?.text === handoff &&
      afterReset.entries.length === beforeReset.entries.length + 1 &&
      JSON.stringify(beforeReset.entries.map((entry) => entry.id)) ===
        JSON.stringify(
          afterReset.entries
            .slice(0, beforeReset.entries.length)
            .map((entry) => entry.id),
        ),
    `kinds=${resetKinds.join(", ")} reset=${JSON.stringify(resetEntry?.text ?? null)}`,
  );
  // A second reset with no handoff leaves an empty context and still marks the boundary, so
  // "reset" and "reset with notes" are one shape rather than two.
  yield* client.resetSession({ sessionId: toReset.id });
  const bareReset = yield* client.getSession({ sessionId: toReset.id });
  const bareEntries = bareReset.entries.filter(
    (entry) => entry.kind === "reset",
  );
  assert(
    "a reset with no handoff still marks the entry",
    bareEntries.length === 2 && bareEntries.at(-1)?.text === "",
    `reset entries=${bareEntries.length} last=${JSON.stringify(bareEntries.at(-1)?.text ?? null)}`,
  );

  // Feature: compaction (LOB-185). `compactSession` admits a compaction task in the log and
  // answers its id; the summary it writes is a `compaction` entry, and everything it stands in for
  // is still in the transcript. The message before it is long on purpose: Pi Durable summarizes an
  // old prefix and keeps the newest `keepRecentTokens` (20k on this window's policy) verbatim, so a
  // shorter transcript has nothing to compact and the task completes without a summary.
  const toCompact = yield* client.createSession({
    requestId: `verify-api-compact-${Date.now()}`,
  });
  yield* client.sendMessage({
    sessionId: toCompact.id,
    content: "y".repeat(90_000),
  });
  // Wait for the answer, not for `busy` to clear: a compaction admitted before the run has written
  // its entries would have nothing to summarize.
  yield* waitUntil(
    client
      .getSession({ sessionId: toCompact.id })
      .pipe(
        Effect.map(
          (state) =>
            !state.live.busy &&
            state.entries.some((entry) => entry.kind === "assistant"),
        ),
      ),
    "the turn before the compaction to settle",
  );
  const compactAdmitted = yield* client.compactSession({
    sessionId: toCompact.id,
    instructions: "the long probe message",
  });
  yield* waitUntil(
    client
      .getSession({ sessionId: toCompact.id })
      .pipe(
        Effect.map((state) =>
          state.entries.some((entry) => entry.kind === "compaction"),
        ),
      ),
    "the compaction's summary entry",
  );
  const afterCompact = yield* client.getSession({ sessionId: toCompact.id });
  const summary = afterCompact.entries.find(
    (entry) => entry.kind === "compaction",
  );
  assert(
    "compactSession answers a task id and its summary lands in the transcript",
    compactAdmitted.taskId.length > 0 &&
      compactAdmitted.session.id === toCompact.id &&
      compactAdmitted.session.status === "idle" &&
      summary !== undefined &&
      summary.text.length > 0 &&
      // Nothing is dropped: what the summary stands in for is still readable.
      afterCompact.entries.some(
        (entry) => entry.kind === "user" && entry.text.startsWith("y"),
      ),
    `taskId=${compactAdmitted.taskId} status=${compactAdmitted.session.status} kinds=${afterCompact.entries.map((entry) => entry.kind).join(", ")}`,
  );

  // Feature: approvals (LOB-50). A gated action asks a person first: the request is recorded in the
  // session's log and listed as pending until a decision settles it. The check runs over the same RPC
  // client, against a session of its own, and it survives the owner being released (the fold).
  const approvals = yield* RpcClient.make(ApprovalsRpc);
  const toApprove = yield* client.createSession({
    requestId: `verify-api-approval-${Date.now()}`,
  });
  const ask = {
    sessionId: toApprove.id,
    requestId: `approve-${Date.now()}`,
    action: "push refs/heads/main",
    detail: "verify-api probe",
  };
  const requested = yield* approvals.requestApproval(ask);
  const pendingBefore = yield* approvals.listApprovals({
    sessionId: toApprove.id,
  });
  assert(
    "requestApproval is listed as pending",
    requested.requestId === ask.requestId &&
      requested.action === ask.action &&
      pendingBefore.approvals.length === 1 &&
      pendingBefore.approvals[0]?.requestId === ask.requestId,
    `pending=${pendingBefore.approvals.map((approval) => approval.requestId).join(", ")}`,
  );

  // A second identical request is the same request: one pending row, not two.
  yield* approvals.requestApproval(ask);
  const pendingAfterRetry = yield* approvals.listApprovals({
    sessionId: toApprove.id,
  });
  assert(
    "a second identical request leaves one pending row",
    pendingAfterRetry.approvals.length === 1,
    `pending rows=${pendingAfterRetry.approvals.length}`,
  );

  // The fold: wait for the owner to be released, then the pending list still answers from the log.
  yield* Effect.sleep(6_000);
  const foldedApproval = yield* waitUntil(
    client
      .getSession({ sessionId: toApprove.id })
      .pipe(
        Effect.map((snapshot) =>
          snapshot.session.mode === "historical" ? snapshot : undefined,
        ),
      ),
    "the approval session's owner to be released",
  );
  const pendingFolded = yield* approvals.listApprovals({
    sessionId: toApprove.id,
  });
  assert(
    "the pending approval survives the owner being released",
    foldedApproval.session.mode === "historical" &&
      pendingFolded.approvals.length === 1,
    `mode=${foldedApproval.session.mode} pending=${pendingFolded.approvals.length}`,
  );

  // Decide it. The actor string is what the caller said it was, and it must come back in the
  // decision and survive in the evidence file.
  const actor = "verify-api operator";
  const decision = yield* approvals.decideApproval({
    sessionId: toApprove.id,
    requestId: ask.requestId,
    decision: "approved",
    actor,
  });
  const pendingAfterDecide = yield* approvals.listApprovals({
    sessionId: toApprove.id,
  });
  assert(
    "decideApproval settles the request and the pending list empties",
    decision.decision === "approved" &&
      decision.actor === actor &&
      pendingAfterDecide.approvals.length === 0,
    `decision=${decision.decision} actor=${decision.actor} pending=${pendingAfterDecide.approvals.length}`,
  );
  Object.assign(observed, {
    approvals: {
      sessionId: toApprove.id,
      requested,
      pendingAfterRetry: pendingAfterRetry.approvals,
      pendingFolded: pendingFolded.approvals,
      decision,
      pendingAfterDecide: pendingAfterDecide.approvals,
    },
  });

  // Feature: a mission (LOB-230). `startMission` admits one durable task and answers its id; the
  // phase it reaches is read off the session's snapshot, which is the surface the contract chose
  // over a `MissionRpc` of its own. Driven on a session of its own, so nothing here depends on the
  // transcript the rest of this driver sends.
  //
  // A scratch session declares no `.factory/config`, so the mission's verify phase reports that the
  // repo declares no verify command and the mission settles `failed` there. That is the honest end
  // for this run: what the wire is being asked to prove is the id and the phase, not that this
  // driver's directory can verify itself.
  const missionSession = yield* client.createSession({
    requestId: `verify-api-mission-${Date.now()}`,
  });
  const beforeMission = yield* client.getSession({
    sessionId: missionSession.id,
  });
  assert(
    "a session that never ran a mission reports none, not an empty phase",
    beforeMission.mission === undefined,
    `mission=${JSON.stringify(beforeMission.mission ?? null)}`,
  );
  const started = yield* client.startMission({
    sessionId: missionSession.id,
    feature: "verify-api mission probe",
  });
  assert(
    "startMission answers the mission's id",
    started.sessionId === missionSession.id &&
      typeof started.taskId === "string" &&
      started.taskId.length > 0,
    `sessionId=${started.sessionId} taskId=${started.taskId}`,
  );
  const atVerify = yield* waitUntil(
    client
      .getSession({ sessionId: missionSession.id })
      .pipe(
        Effect.map((snapshot) =>
          snapshot.mission?.phase === "verify" ? snapshot : undefined,
        ),
      ),
    "the mission to reach verify",
  );
  assert(
    "the phase the mission reached is readable through the snapshot",
    atVerify.mission?.taskId === started.taskId &&
      atVerify.mission.phase === "verify" &&
      atVerify.mission.entered.join(",") === "plan,implement,verify",
    `mission=${JSON.stringify(atVerify.mission ?? null)}`,
  );
  // The mission is a live task while it runs and gone from the list once it settles; either way the
  // record is the log's, which is what makes the phase readable afterwards.
  const settledMission = yield* waitUntil(
    client
      .getSession({ sessionId: missionSession.id })
      .pipe(
        Effect.map((snapshot) =>
          snapshot.tasks.some((task) => task.kind === "factory.mission")
            ? undefined
            : snapshot,
        ),
      ),
    "the mission to settle",
  );
  assert(
    "a settled mission still reports the phase it reached",
    settledMission.mission?.phase === "verify",
    `mission=${JSON.stringify(settledMission.mission ?? null)} tasks=${settledMission.tasks.map((task) => task.kind).join(", ") || "none"}`,
  );

  // The fold: the mission's record is a document, so a released owner still reports it.
  yield* Effect.sleep(6_000);
  const foldedMission = yield* waitUntil(
    client
      .getSession({ sessionId: missionSession.id })
      .pipe(
        Effect.map((snapshot) =>
          snapshot.session.mode === "historical" ? snapshot : undefined,
        ),
      ),
    "the mission session's owner to be released",
  );
  assert(
    "the fold reports the mission the live read reported",
    foldedMission.mission?.taskId === started.taskId &&
      foldedMission.mission.phase === settledMission.mission?.phase,
    `mode=${foldedMission.session.mode} mission=${JSON.stringify(foldedMission.mission ?? null)}`,
  );
  Object.assign(observed, {
    mission: {
      sessionId: missionSession.id,
      started,
      live: settledMission.mission ?? null,
      folded: foldedMission.mission ?? null,
      tasksAtVerify: atVerify.tasks.map((task) => task.kind),
    },
  });

  // Feature: a mission's fan-out (LOB-193). Two workers, each a task the mission owns with a
  // conversation of its own, and a join that either waits for both or — failFast — aborts the one
  // still running when the other fails. Each worker's check holds on a file this driver writes, so
  // the fan-out is read off the snapshot while both are live rather than raced; the API runs on this
  // machine, so an absolute path is a file both ends see.
  const holdDir = path.resolve(EVIDENCE_DIR, `mission-hold-${Date.now()}`);
  yield* Effect.promise(() => mkdir(holdDir, { recursive: true }));
  const holdUntil = (name: string) =>
    `while [ ! -f ${path.join(holdDir, name)} ]; do sleep 0.01; done`;
  const workersOf = <T extends { readonly kind: string }>(
    tasks: readonly T[],
  ): T[] => tasks.filter((task) => task.kind === "factory.mission.worker");
  const fanSession = yield* client.createSession({
    requestId: `verify-api-fanout-${Date.now()}`,
  });
  const fanned = yield* client.startMission({
    sessionId: fanSession.id,
    feature: "verify-api fan-out probe",
    workers: [
      { id: "a", prompt: "do part a", check: holdUntil("release") },
      { id: "b", prompt: "do part b", check: holdUntil("release") },
    ],
  });
  const bothLive = yield* waitUntil(
    client
      .getSession({ sessionId: fanSession.id })
      .pipe(
        Effect.map((snapshot) =>
          workersOf(snapshot.tasks).filter((task) => task.phase === "check")
            .length === 2
            ? snapshot
            : undefined,
        ),
      ),
    "both workers to reach their check",
  );
  const liveWorkers = workersOf(bothLive.tasks);
  const fanMission = bothLive.tasks.find((task) => task.id === fanned.taskId);
  assert(
    "a mission fans out to two workers it owns, each with a conversation of its own",
    liveWorkers.every(
      (task) => task.owner === fanned.taskId && task.conversations.length === 1,
    ) && new Set(liveWorkers.flatMap((task) => task.conversations)).size === 2,
    `workers=${JSON.stringify(liveWorkers)}`,
  );
  assert(
    "the mission waits on both workers, failFast by default",
    fanMission?.status === "waiting" &&
      fanMission.phase === "implement" &&
      fanMission.waitingOn.join(",") ===
        liveWorkers.map((task) => task.id).join(","),
    `mission=${JSON.stringify(fanMission ?? null)}`,
  );
  yield* Effect.promise(() => writeFile(path.join(holdDir, "release"), ""));
  const joined = yield* waitUntil(
    client
      .getSession({ sessionId: fanSession.id })
      .pipe(
        Effect.map((snapshot) =>
          snapshot.tasks.length === 0 ? snapshot : undefined,
        ),
      ),
    "the fanned-out mission to settle",
  );
  assert(
    "the join moves on to verify once both workers are done",
    joined.mission?.taskId === fanned.taskId &&
      joined.mission.entered.join(",") === "plan,implement,verify",
    `mission=${JSON.stringify(joined.mission ?? null)}`,
  );

  // failFast: `b` marks that its check started and then beats, in the session's worktree, while
  // holding on a file this driver never writes; `a` fails only once `b`'s mark exists. So `a`'s
  // failure finds `b`'s check running, nothing but a kill can end that check, and a beat that stops
  // is the abort reaching `b`'s process — which the snapshot alone (no outcomes on the wire) could
  // not tell apart from `b` failing on its own. The writes are inside the worktree because the
  // session's policy decides every check before the mission starts, as it would decide `bash`.
  const failSession = yield* client.createSession({
    requestId: `verify-api-failfast-${Date.now()}`,
  });
  const failWorktree = (yield* client.getSession({ sessionId: failSession.id }))
    .workspace.path;
  const failing = yield* client.startMission({
    sessionId: failSession.id,
    feature: "verify-api failFast probe",
    workers: [
      {
        id: "a",
        prompt: "do part a",
        check: "while [ ! -f .verify-b-checking ]; do sleep 0.01; done; exit 1",
      },
      {
        id: "b",
        prompt: "do part b",
        // The beat is written before the mark `a` waits on, so it exists by the time the abort can come.
        check: `touch .verify-b-alive; touch .verify-b-checking; ${holdUntil("never").replace("do sleep", "do touch .verify-b-alive; sleep")}`,
      },
    ],
  });
  const aborted = yield* waitUntil(
    client
      .getSession({ sessionId: failSession.id })
      .pipe(
        Effect.map((snapshot) =>
          snapshot.tasks.length === 0 && snapshot.mission !== undefined
            ? snapshot
            : undefined,
        ),
      ),
    "the failFast mission to settle",
  );
  const beatOf = () =>
    Effect.promise(() =>
      stat(path.join(failWorktree, ".verify-b-alive")).then(
        (info) => info.mtimeMs,
        () => undefined,
      ),
    );
  const beatAtSettle = yield* beatOf();
  yield* Effect.sleep("500 millis");
  const beatLater = yield* beatOf();
  const bChecked = yield* Effect.promise(() =>
    stat(path.join(failWorktree, ".verify-b-checking")).then(
      () => true,
      () => false,
    ),
  );
  assert(
    "a failing worker stops its sibling's running check under failFast",
    bChecked && beatAtSettle !== undefined && beatLater === beatAtSettle,
    `bChecked=${bChecked} beatAtSettle=${beatAtSettle} beatLater=${beatLater}`,
  );
  assert(
    "a mission whose worker failed stops in implement and never verifies",
    aborted.mission?.taskId === failing.taskId &&
      aborted.mission.phase === "implement" &&
      aborted.mission.entered.join(",") === "plan,implement",
    `mission=${JSON.stringify(aborted.mission ?? null)}`,
  );
  // A check the session's agent could not run as `bash` is refused before any task exists.
  const rogue = yield* client
    .startMission({
      sessionId: failSession.id,
      feature: "verify-api rogue check probe",
      workers: [
        {
          id: "rogue",
          prompt: "escape",
          check: `touch ${path.join(holdDir, "escaped")}`,
        },
      ],
    })
    .pipe(Effect.result);
  const escaped = yield* Effect.promise(() =>
    stat(path.join(holdDir, "escaped")).then(
      () => true,
      () => false,
    ),
  );
  assert(
    "a worker's check that writes outside the worktree is refused by the session's policy",
    rogue._tag === "Failure" &&
      rogue.failure._tag === "SessionError" &&
      rogue.failure.code === "invalid_input" &&
      rogue.failure.message.includes("only write inside its worktree") &&
      !escaped,
    `rogue=${JSON.stringify(rogue._tag === "Failure" ? rogue.failure : rogue.success)} escaped=${escaped}`,
  );
  Object.assign(observed, {
    missionFanOut: {
      joined: {
        sessionId: fanSession.id,
        started: fanned,
        whileWaiting: { mission: fanMission ?? null, workers: liveWorkers },
        settled: joined.mission ?? null,
      },
      failFast: {
        sessionId: failSession.id,
        started: failing,
        settled: aborted.mission ?? null,
        siblingCheck: { started: bChecked, beatAtSettle, beatLater },
        rogueCheck:
          rogue._tag === "Failure" ? rogue.failure : { started: rogue.success },
      },
    },
  });

  // Feature: curate a finished session's pages (LOB-206). One bounded model call over the transcript
  // and the pages the session already holds proposes page writes; the server commits at most
  // `maxPages` of them, cites the curated session, and commits nothing when it taught nothing new.
  // Driven over the RPC client, on a session of its own, so the contract is what is proven — and
  // with the faux model deriving its answer from the transcript, so a page can only exist if this
  // session really ran a tool.
  const toCurate = yield* client.createSession({
    requestId: `verify-api-curate-${Date.now()}`,
  });
  yield* client.sendMessage({ sessionId: toCurate.id, content: PROMPT });
  const curatedIdle = yield* waitUntil(
    client
      .getSession({ sessionId: toCurate.id })
      .pipe(
        Effect.map((state) =>
          !state.live.busy &&
          state.entries.some(
            (entry) => entry.kind === "toolResult" && entry.toolName === "bash",
          )
            ? state
            : undefined,
        ),
      ),
    "the curated session's bash result",
  );
  const spentBefore = tokensOf(curatedIdle);
  const knownIds = new Set(
    (yield* client.listSessions({ limit: 250 })).sessions.map(
      (session) => session.id,
    ),
  );
  const curated = yield* client.curateSession({
    sessionId: toCurate.id,
    maxPages: 1,
  });
  const heldPages = yield* client.listPages({ sessionId: toCurate.id });
  const afterCurate = yield* client.getSession({ sessionId: toCurate.id });
  const spentAfter = tokensOf(afterCurate);
  assert(
    "curateSession writes a page citing the session, and charges the call to it",
    curated.pages.length === 1 &&
      curated.proposed >= 1 &&
      curated.pages[0]?.sources.includes(toCurate.id) === true &&
      heldPages.pages.some((page) => page.name === curated.pages[0]?.name) &&
      // The call's spend lands in the curated session's own ledger, not a curator's.
      spentAfter > spentBefore,
    `pages=${curated.pages.map((page) => page.name).join(", ")} proposed=${curated.proposed} sources=${curated.pages[0]?.sources.join(", ")} tokens=${spentBefore}->${spentAfter}`,
  );

  // A curator is a call, not a run: no session of its own may appear on the list for having
  // curated. The curated session was already known before the call, so a new row is a curator's.
  const listedAfterCurate = yield* client.listSessions({ limit: 250 });
  const curatorSessions = listedAfterCurate.sessions.filter(
    (session) => !knownIds.has(session.id),
  );
  assert(
    "a curation opens no session of its own",
    curatorSessions.length === 0,
    `new sessions: ${curatorSessions.map((session) => session.id).join(", ") || "none"}`,
  );

  // The same pass again: the session already holds what the model proposes, so it commits nothing.
  // It still costs its one call, which is what makes "learned nothing new" cheap rather than free.
  const repeatCurated = yield* client.curateSession({
    sessionId: toCurate.id,
    maxPages: 1,
  });
  const heldAfterRepeat = yield* client.listPages({ sessionId: toCurate.id });
  assert(
    "a second curation commits nothing when the session already holds the proposal",
    repeatCurated.pages.length === 0 &&
      repeatCurated.proposed >= 1 &&
      heldAfterRepeat.pages.length === heldPages.pages.length,
    `pages=${repeatCurated.pages.length} proposed=${repeatCurated.proposed} held=${heldPages.pages.length}->${heldAfterRepeat.pages.length}`,
  );
  Object.assign(observed, {
    curation: {
      sessionId: toCurate.id,
      first: curated,
      pagesHeld: heldPages.pages,
      repeat: repeatCurated,
      tokens: { before: spentBefore, after: spentAfter },
    },
  });

  return { id: created.id };
}).pipe(Effect.provide(ProtocolLive), Effect.scoped);

let sessionId: SessionId | null = null;
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
const total = Object.keys(observed.checks).length;
console.log(`${total - failed.length}/${total} checks passed`);
if (failed.length > 0) {
  console.error(`\n${failed.length} required check(s) failed`);
  process.exitCode = 1;
}
