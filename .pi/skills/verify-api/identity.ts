// Control-plane identity (LOB-20), driven with the real Effect RPC client, the real CLI, and a
// signed trigger delivery.
//
//   bun identity.ts      (via ./identity.sh, which boots the API this drives with a token table)
//
//   refusal   with no credential, and with a wrong one, `listSessions` (unary) and `watchSession`
//             (the stream) fail as the typed `Unauthenticated`, reason `missing` / `invalid`
//   actors    with amy's credential and a body actor naming `mallory`: `createSession`,
//             `decideApproval`, `createTask` and `moveTask` record `amy` in `sessions.actor`,
//             `session_approvals.actor` and `task_events.actor`; `factory board move --actor mallory`
//             through the CLI (FACTORY_API_TOKEN = amy's) records `amy` too; the shared token records
//             its own actor; `listSpend` groups by the authenticated actors and holds no `mallory`
//   author    `defineBoard` as amy with a body actor naming `mallory` records `amy` as the version's
//             author (`getDefinition`, `board_definitions.author`); an unchanged answer and a dry run write
//             no row; the shared token's version carries its own actor; a seeded version has none (F7)
//   webhook   a signed generic delivery sent with no credential still starts a session, attributed
//             `trigger:generic`; the same body unsigned is still `401`
//
// Env: API_URL, EVIDENCE_DIR, DATABASE_URL, CLI_ENTRY, IDENTITY_SHARED_TOKEN / _AMY_TOKEN /
// _SHARED_ACTOR, TRIGGER_SECRET, IDENTITY_REPO (all set by ./identity.sh).
import { SQL } from "bun";
import { spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { RpcApi } from "@repo/domain/Rpc";
import { DefinitionId } from "@repo/domain/Task";
import { RepoSlug, type SessionId } from "@repo/domain/Session";
import { Effect, Stream } from "effect";
import { RpcClient } from "effect/rpc";
import type { RpcClientError } from "effect/rpc/RpcClientError";
import { makeChecker, protocolFor, type CheckRecord } from "./harness.ts";

const need = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value === "") {
    console.error(`identity.ts needs ${name} (run it through ./identity.sh)`);
    process.exit(2);
  }
  return value;
};

const API_URL = process.env["API_URL"] ?? "http://localhost:9200";
const EVIDENCE_DIR =
  process.env["EVIDENCE_DIR"] ?? ".verify/evidence/latest/api";
const DATABASE_URL = need("DATABASE_URL");
const CLI_ENTRY = need("CLI_ENTRY");
const SHARED_TOKEN = need("IDENTITY_SHARED_TOKEN");
const AMY_TOKEN = need("IDENTITY_AMY_TOKEN");
const SHARED_ACTOR = need("IDENTITY_SHARED_ACTOR");
const TRIGGER_SECRET = need("TRIGGER_SECRET");
const REPO = RepoSlug.make(need("IDENTITY_REPO"));
const MALLORY = "mallory";
const WRONG_TOKEN = "identity-nobodys-token-0123456789";

await mkdir(EVIDENCE_DIR, { recursive: true });

const observed: {
  apiUrl: string;
  repo: string;
  refusals: Record<string, unknown>;
  recorded: Record<string, unknown>;
  checks: Record<string, CheckRecord>;
} = { apiUrl: API_URL, repo: REPO, refusals: {}, recorded: {}, checks: {} };
const assert = makeChecker(observed);

/** Run `body` with an RPC client that sends `token` (none when `null`). */
const as = <A, E>(
  token: string | null,
  body: (
    client: RpcClient.FromGroup<typeof RpcApi, RpcClientError>,
  ) => Effect.Effect<A, E>,
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* RpcClient.make(RpcApi);
        return yield* body(client);
      }),
    ).pipe(Effect.provide(protocolFor(API_URL, token))),
  );

/** The failure a call answered, as the client decoded it: tag and reason, nothing presented. */
const refusal = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.flip(effect).pipe(
    Effect.map((error) => {
      const tagged = error as { _tag?: unknown; reason?: unknown };
      return { tag: String(tagged._tag), reason: String(tagged.reason) };
    }),
  );

const db = new SQL(DATABASE_URL);
const sessionActor = async (id: string) =>
  (
    (await db`SELECT actor FROM sessions WHERE id = ${id}`) as Array<{
      actor: string | null;
    }>
  )[0]?.actor ?? null;

try {
  // ── refusal ────────────────────────────────────────────────────────────────────────────────
  const watched = await as(SHARED_TOKEN, (client) =>
    client.createSession({ title: "identity: watched" }),
  );
  const watch = (client: RpcClient.FromGroup<typeof RpcApi, RpcClientError>) =>
    client
      .watchSession({ sessionId: watched.id })
      .pipe(Stream.take(1), Stream.runCollect);
  const refusals = {
    unaryMissing: await as(null, (client) => refusal(client.listSessions({}))),
    unaryInvalid: await as(WRONG_TOKEN, (client) =>
      refusal(client.listSessions({})),
    ),
    streamMissing: await as(null, (client) => refusal(watch(client))),
    streamInvalid: await as(WRONG_TOKEN, (client) => refusal(watch(client))),
  };
  observed.refusals = refusals;
  for (const [name, answer] of Object.entries(refusals)) {
    const want = name.endsWith("Missing") ? "missing" : "invalid";
    assert(
      `refusal: ${name.startsWith("unary") ? "listSessions" : "watchSession"} with a ${want} credential is Unauthenticated`,
      answer.tag === "Unauthenticated" && answer.reason === want,
      JSON.stringify(answer),
    );
  }
  const streamed = await as(SHARED_TOKEN, watch);
  assert(
    "refusal: the same stream with a credential is served",
    streamed.length === 1,
    `${streamed.length} event(s)`,
  );

  // ── actors ─────────────────────────────────────────────────────────────────────────────────
  const amy = await as(AMY_TOKEN, (client) =>
    Effect.gen(function* () {
      const session = yield* client.createSession({
        title: "identity: amy's",
        repo: REPO,
        actor: MALLORY,
      });
      yield* client.requestApproval({
        sessionId: session.id,
        requestId: "identity-approval",
        action: "npm publish",
      });
      const decision = yield* client.decideApproval({
        sessionId: session.id,
        requestId: "identity-approval",
        decision: "approved",
        actor: MALLORY,
      });
      const board = yield* client.createBoard({
        repo: REPO,
        definitionId: DefinitionId.make("default"),
      });
      const card = yield* client.createTask({
        boardId: board.id,
        title: "identity: a card",
        actor: MALLORY,
      });
      const moved = yield* client.moveTask({
        taskId: card.id,
        expectedRevision: card.revision,
        to: "specifying",
        actor: MALLORY,
      });
      return { session, decision, card, moved };
    }),
  );
  // The CLI's own path: `--actor mallory` on the command line, amy's token in the environment.
  const cli = spawnSync(
    "bun",
    [
      "run",
      CLI_ENTRY,
      "board",
      "move",
      "--task",
      amy.card.id,
      "--to",
      // `canceled`, not `planning`: leaving specifying for planning needs the card's spec (D9), which
      // this drive is not about, and abandoning a card checks no requirement.
      "canceled",
      "--expect-revision",
      String(amy.moved.revision),
      "--actor",
      MALLORY,
      "--api",
      API_URL,
    ],
    {
      encoding: "utf8",
      env: { ...process.env, FACTORY_API_TOKEN: AMY_TOKEN },
    },
  );
  const cliWithout = spawnSync(
    "bun",
    ["run", CLI_ENTRY, "ls", "--api", API_URL],
    {
      encoding: "utf8",
      env: { ...process.env, FACTORY_API_TOKEN: "" },
    },
  );
  const operator = await as(SHARED_TOKEN, (client) =>
    client.createSession({ title: "identity: shared", repo: REPO }),
  );
  const spend = await as(AMY_TOKEN, (client) => client.listSpend({}));

  const approvalRows = (await db`
    SELECT actor FROM session_approvals WHERE session_id = ${amy.session.id}
  `) as Array<{ actor: string | null }>;
  const events = (await db`
    SELECT kind, actor, payload->>'to' AS "to" FROM task_events
    WHERE task_id = ${amy.card.id} ORDER BY id
  `) as Array<{ kind: string; actor: string; to: string | null }>;
  const repoSpend = spend.rows.filter((row) => row.repo === REPO);
  observed.recorded = {
    session: { id: amy.session.id, actor: await sessionActor(amy.session.id) },
    decision: { actor: amy.decision.actor, rows: approvalRows },
    taskEvents: events,
    cli: {
      exit: cli.status,
      stdout: cli.stdout.trim(),
      stderr: cli.stderr.trim(),
    },
    cliWithoutToken: {
      exit: cliWithout.status,
      stderr: cliWithout.stderr.trim(),
    },
    shared: { id: operator.id, actor: await sessionActor(operator.id) },
    spend: repoSpend,
  };

  assert(
    "actors: createSession records amy in sessions.actor, not the body's mallory",
    (await sessionActor(amy.session.id)) === "amy",
    `sessions.actor=${String(await sessionActor(amy.session.id))}`,
  );
  assert(
    "actors: decideApproval records amy in the decision and session_approvals",
    amy.decision.actor === "amy" &&
      approvalRows.length === 1 &&
      approvalRows[0]?.actor === "amy",
    `decision=${amy.decision.actor} rows=${JSON.stringify(approvalRows)}`,
  );
  assert(
    "actors: the CLI's board move sent amy's token and its --actor changed nothing",
    cli.status === 0 &&
      events.length === 3 &&
      events[2]?.kind === "moved" &&
      events[2]?.to === "canceled",
    `exit=${cli.status} events=${JSON.stringify(events)}`,
  );
  assert(
    "actors: every task event (create, move, the CLI's move) records amy",
    events.length === 3 && events.every((event) => event.actor === "amy"),
    JSON.stringify(events.map((event) => [event.kind, event.actor])),
  );
  assert(
    "actors: the CLI with no token is refused, naming the variable",
    cliWithout.status !== 0 &&
      cliWithout.stderr.includes("unauthenticated") &&
      cliWithout.stderr.includes("FACTORY_API_TOKEN"),
    cliWithout.stderr.trim(),
  );
  assert(
    "actors: the shared token records its own actor",
    (await sessionActor(operator.id)) === SHARED_ACTOR,
    `sessions.actor=${String(await sessionActor(operator.id))}`,
  );
  const pairs = repoSpend.map((row) => `${row.actor}:${row.sessions}`).sort();
  assert(
    "actors: listSpend groups the repo's sessions by the authenticated actors, never mallory",
    pairs.join(",") === [`amy:1`, `${SHARED_ACTOR}:1`].sort().join(","),
    pairs.join(","),
  );

  // ── author (F7) ────────────────────────────────────────────────────────────────────────────
  // A definition version records the credential's actor, as a skill version does: amy's `defineBoard`
  // with a body actor naming mallory is amy's, the shared token's is its own, a seeded version has
  // none, and an unchanged answer or a dry run writes no row (so no author).
  const defId = DefinitionId.make(`idnt${Date.now().toString(36)}`);
  const authored = {
    id: defId,
    name: "identity: authored",
    initialColumn: "todo",
    columns: [
      {
        name: "todo",
        kind: "resting" as const,
        skills: [],
        requires: [],
        transitions: [{ to: "done" }],
      },
      {
        name: "done",
        kind: "terminal" as const,
        skills: [],
        requires: [],
        transitions: [],
      },
    ],
  };
  const defined = await as(AMY_TOKEN, (client) =>
    Effect.gen(function* () {
      const created = yield* client.defineBoard({
        ...authored,
        actor: MALLORY,
      });
      const again = yield* client.defineBoard({ ...authored, actor: MALLORY });
      const dry = yield* client.defineBoard({
        ...authored,
        name: "identity: dry",
        actor: MALLORY,
        dryRun: true,
      });
      return { created, again, dry };
    }),
  );
  const byOperator = await as(SHARED_TOKEN, (client) =>
    client.defineBoard({ ...authored, name: "identity: by the operator" }),
  );
  const read = await as(AMY_TOKEN, (client) =>
    Effect.gen(function* () {
      return {
        v1: yield* client.getDefinition({ definitionId: defId, version: 1 }),
        v2: yield* client.getDefinition({ definitionId: defId, version: 2 }),
        seeded: yield* client.getDefinition({
          definitionId: DefinitionId.make("default"),
          version: 1,
        }),
        listed: yield* client.listDefinitions({}),
      };
    }),
  );
  const authorRows = (await db`
    SELECT version, author FROM board_definitions WHERE id = ${defId} ORDER BY version
  `) as Array<{ version: number; author: string | null }>;
  observed.recorded = {
    ...observed.recorded,
    definitionAuthors: authorRows,
    definitionOutcomes: [
      defined.created.outcome,
      defined.again.outcome,
      defined.dry.outcome,
      byOperator.outcome,
    ],
  };
  assert(
    "author: defineBoard records amy on the version, not the body's mallory (getDefinition and the row)",
    defined.created.outcome === "created" &&
      defined.created.definition.author === "amy" &&
      read.v1.author === "amy" &&
      authorRows[0]?.author === "amy",
    `answer=${String(defined.created.definition.author)} read=${String(read.v1.author)} row=${String(authorRows[0]?.author)}`,
  );
  assert(
    "author: an unchanged answer and a dry run write no row, so no author",
    defined.again.outcome === "unchanged" &&
      defined.dry.outcome === "validated" &&
      defined.dry.definition.author === undefined &&
      authorRows.length === 2,
    `rows=${JSON.stringify(authorRows)}`,
  );
  assert(
    "author: the shared token's version carries its own actor, and listDefinitions names both",
    byOperator.definition.version === 2 &&
      read.v2.author === SHARED_ACTOR &&
      JSON.stringify(
        read.listed
          .find((definition) => definition.id === defId)
          ?.versions.map((version) => version.author),
      ) === JSON.stringify(["amy", SHARED_ACTOR]),
    `v2=${String(read.v2.author)}`,
  );
  assert(
    "author: a seeded version has none (absent, not empty)",
    !("author" in read.seeded) &&
      read.listed
        .find((definition) => definition.id === "default")
        ?.versions.every((version) => version.author === undefined) === true,
    `seeded=${JSON.stringify(read.seeded.author)}`,
  );

  // ── webhook ────────────────────────────────────────────────────────────────────────────────
  const body = JSON.stringify({
    requestId: `identity-${Date.now()}`,
    key: "identity-delivery",
    action: "create",
    label: "factory",
    title: "identity: a signed delivery",
    body: "no control-plane credential",
  });
  const post = async (signature: string | undefined) => {
    const response = await fetch(`${API_URL}/webhooks/generic`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(signature === undefined
          ? {}
          : { "x-trigger-signature": signature }),
      },
      body,
    });
    return {
      status: response.status,
      answer: (await response.json().catch(() => null)) as {
        sessionId?: string;
      } | null,
    };
  };
  const unsigned = await post(undefined);
  const signed = await post(
    createHmac("sha256", TRIGGER_SECRET).update(body).digest("hex"),
  );
  const triggered = signed.answer?.sessionId;
  const triggerActor =
    triggered === undefined ? null : await sessionActor(triggered as SessionId);
  observed.recorded["webhook"] = {
    unsigned,
    signed,
    sessionActor: triggerActor,
  };
  assert(
    "webhook: a signed delivery with no control-plane credential starts a session",
    signed.status === 200 && triggered !== undefined,
    `status=${signed.status} answer=${JSON.stringify(signed.answer)}`,
  );
  assert(
    "webhook: the delivery's session is attributed trigger:generic",
    triggerActor === "trigger:generic",
    `sessions.actor=${String(triggerActor)}`,
  );
  assert(
    "webhook: the same body unsigned is still refused by the route's own check",
    unsigned.status === 401,
    `status=${unsigned.status}`,
  );
} finally {
  await db.close();
}

await writeFile(
  path.join(EVIDENCE_DIR, "identity.json"),
  `${JSON.stringify(observed, null, 2)}\n`,
);
const failed = Object.entries(observed.checks).filter(([, c]) => !c.passed);
console.log(
  `${Object.keys(observed.checks).length - failed.length}/${Object.keys(observed.checks).length} checks passed`,
);
process.exit(failed.length === 0 ? 0 : 1);
