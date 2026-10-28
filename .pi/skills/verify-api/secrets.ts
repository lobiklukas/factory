// A repo's scoped secrets, over the real API and the real CLI (S-agent-secrets).
//
//   bun secrets.ts      (via ./secrets.sh, which boots the API with a store key and the faux script)
//
// Two fixture repos, each a local git checkout with no remote, registered over RPC:
//
//   verify   `.factory/config` at the base declares `"secrets": {"verify": ["TEST_API_KEY"]}` and a
//            `verify` that passes only when TEST_API_KEY is the stored value (checked by digest, so
//            the config never spells it). The value is stored with `factory secret set` from stdin.
//            A session's run reports how many non-empty TEST_API_KEY its own shell holds (0), then
//            its `verify` passes; the value is in no row the session wrote, its transcript holds
//            `[secret:TEST_API_KEY]` where verify printed it, and no RPC answer holds it.
//   leaky    its base carries a `leak-source` file with the stored value; a card's building run
//            commits a copy of it. The run settles and the PR step refuses `secret-found` before any
//            push: the card's note names the refusal, the secret by name and where it is, and never
//            the value; `factory pr` meets the same refusal.
//
// Every value is obviously fake and minted per run. The card is put in `building` with one SQL
// update, as the core suite seeds it: the moves that get a card there are verify-board's to prove.
//
// Env: API_URL, DATABASE_URL (the run's database, to read the session's rows), SECRETS_REPOS,
// EVIDENCE_DIR.
import { execSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { RpcApi } from "@repo/domain/Rpc";
import { RepoSlug, type SessionId } from "@repo/domain/Session";
import { BoardInstanceId, DefinitionId, TaskId } from "@repo/domain/Task";
import { readVerifyRecords } from "@repo/harness";
import { DatabaseLive, PostgresStorage } from "@repo/storage-postgres";
import { Effect, Exit, Layer, Redacted } from "effect";
import { RpcClient } from "effect/rpc";
import { SqlClient } from "effect/sql/SqlClient";
import { makeChecker, protocolFor, waitUntil } from "./harness.ts";
import type { CheckRecord } from "./harness.ts";

const API_URL = process.env["API_URL"] ?? "http://localhost:9200";
const REPOS = path.resolve(
  process.env["SECRETS_REPOS"] ?? ".verify/run/secrets/repos",
);
const EVIDENCE_DIR = path.resolve(
  process.env["EVIDENCE_DIR"] ?? ".verify/evidence/latest/api",
);
const ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const RUN = Date.now().toString(36);
/** Obviously fake, minted for this run, so no other drive's rows can hold it. */
const FAKE = `verify-secrets-fake-value-${RUN}`;
const DIGEST = createHash("sha256").update(FAKE).digest("hex");

const observed: {
  apiUrl: string;
  run: string;
  cli?: unknown;
  verify?: unknown;
  leaky?: unknown;
  checks: Record<string, CheckRecord>;
} = { apiUrl: API_URL, run: RUN, checks: {} };
const assert = makeChecker(observed);

/** A checkout with `files` committed on `main`, no remote, and an identity the run can commit as. */
const fixtureRepo = (name: string, files: Record<string, string>): string => {
  const root = path.join(REPOS, name);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  const git = (command: string) =>
    execSync(command, { cwd: root, stdio: "ignore" });
  git("git init -q -b main");
  git("git config user.email verify-secrets@localhost");
  git("git config user.name verify-secrets");
  for (const [file, content] of Object.entries({
    "README.md": "# secrets fixture\n",
    ...files,
  })) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), content);
  }
  git("git add -A");
  git("git commit -q -m base");
  return root;
};

/** `factory …` as an operator types it, with `input` on stdin; its exit code and both streams. */
const factory = (args: readonly string[], input = "") => {
  const ran = spawnSync(
    "bun",
    [path.join(ROOT, "apps/cli/src/index.ts"), ...args, "--api", API_URL],
    { input, encoding: "utf8" },
  );
  return {
    code: ran.status,
    out: `${ran.stdout ?? ""}${ran.stderr ?? ""}`,
  };
};

/** How many rows the session wrote — its log and every index row keyed by it — and how many hold `text`. */
const rowsHolding = (sessionId: SessionId, text: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const tables = yield* sql<{
      readonly tableName: string;
      readonly columnName: string;
    }>`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name IN ('log_id', 'session_id')
    `;
    let holding = 0;
    let scanned = 0;
    for (const { tableName, columnName } of [
      ...tables,
      { tableName: "sessions", columnName: "id" },
    ]) {
      const rows = yield* sql<{ readonly total: number; readonly hits: number }>`
        SELECT count(*)::int AS total,
          count(*) FILTER (WHERE r::text LIKE ${`%${text}%`})::int AS hits
        FROM ${sql(tableName)} AS r WHERE ${sql(columnName)} = ${sessionId}
      `;
      scanned += rows[0]?.total ?? 0;
      holding += rows[0]?.hits ?? 0;
    }
    return { holding, scanned };
  });

const program = Effect.gen(function* () {
  const client = yield* RpcClient.make(RpcApi);
  const settled = (sessionId: SessionId, label: string) =>
    waitUntil(
      Effect.map(client.getSession({ sessionId }), (snapshot) =>
        !snapshot.live.busy &&
        snapshot.entries.some(
          (entry) => entry.kind === "assistant" && entry.text !== "",
        )
          ? snapshot
          : undefined,
      ),
      label,
    );

  // --- verify: the declared verify gets its secret; nothing else holds it -------------------------
  const verifyRepo = RepoSlug.make(`verify-secrets-${RUN}/verify`);
  yield* client.registerRepo({
    repo: verifyRepo,
    defaultBaseRef: "main",
    localPath: fixtureRepo("verify", {
      ".factory/config": JSON.stringify({
        verify: `test "$(printf %s "$TEST_API_KEY" | shasum -a 256 | cut -c1-64)" = "${DIGEST}" && echo "verify got $TEST_API_KEY"`,
        secrets: { verify: ["TEST_API_KEY"] },
      }),
    }),
  });
  const set = factory(["secret", "set", verifyRepo, "TEST_API_KEY"], `${FAKE}\n`);
  const ls = factory(["secret", "ls", "--repo", verifyRepo]);
  const short = factory(["secret", "set", verifyRepo, "SHORT"], "short\n");
  observed.cli = { set, ls, short };
  assert(
    "cli: `factory secret set` stores the value from stdin and prints it nowhere",
    set.code === 0 &&
      set.out.includes(`set          ${verifyRepo} TEST_API_KEY`) &&
      set.out.includes("value        not shown") &&
      !set.out.includes(FAKE),
    set.out.split("\n")[0] ?? "",
  );
  assert(
    "cli: `factory secret ls` lists the name and who set it, never the value",
    ls.code === 0 &&
      ls.out.includes(`${verifyRepo}\tTEST_API_KEY\t`) &&
      !ls.out.includes(FAKE),
    ls.out.split("\n")[1] ?? "",
  );
  assert(
    "cli: a value under eight characters is refused invalid_secret, and nothing is stored",
    short.code !== 0 && short.out.includes("error: invalid_secret:"),
    short.out.trim().slice(0, 100),
  );
  const listed = yield* client.listSecrets({ repo: verifyRepo });
  assert(
    "rpc: listSecrets answers the summary and no value",
    listed.length === 1 &&
      listed[0]?.name === "TEST_API_KEY" &&
      !JSON.stringify(listed).includes(FAKE),
    JSON.stringify(listed.map((secret) => secret.name)),
  );

  const session = yield* client.createSession({
    repo: verifyRepo,
    title: "verify-secrets verify",
  });
  yield* client.sendMessage({
    sessionId: session.id,
    content: "make the change and verify it",
  });
  const snapshot = yield* settled(session.id, "the verify run to answer");
  const sql = yield* SqlClient;
  const records = yield* Effect.acquireUseRelease(
    Effect.promise(() => PostgresStorage.reader(sql, session.id)),
    readVerifyRecords,
    (storage) => Effect.promise(() => storage.dispose()),
  );
  const report = records[0];
  const ran = report?._tag === "VerifyReport" ? report.results[0] : undefined;
  const bash = snapshot.entries.find(
    (entry) => entry.kind === "toolResult" && entry.toolName === "bash",
  );
  const rows = yield* rowsHolding(session.id, FAKE);
  observed.verify = {
    sessionId: session.id,
    verify: records,
    bash: bash?.text,
    rows,
  };
  assert(
    "verify: the declared verify that needs TEST_API_KEY passes",
    ran?._tag === "VerifyRan" && ran.exitCode === 0,
    ran === undefined
      ? "no verify result"
      : `${ran._tag}${ran._tag === "VerifyRan" ? ` exit ${ran.exitCode}` : ""}`,
  );
  assert(
    "verify: what verify printed of the value is the placeholder",
    ran?._tag === "VerifyRan" &&
      ran.output.includes("verify got [secret:TEST_API_KEY]") &&
      !ran.output.includes(FAKE),
    ran?._tag === "VerifyRan"
      ? (ran.output.split("\n").find((line) => line.startsWith("verify got")) ?? "")
      : "",
  );
  assert(
    "verify: the agent's own env holds no TEST_API_KEY",
    bash?.text.includes("agent-env-key-count:0") === true,
    bash?.text.split("\n")[0] ?? "no bash result",
  );
  assert(
    "verify: the value is in no log entry or index row the session wrote",
    rows.scanned > 0 && rows.holding === 0,
    `${rows.holding} of ${rows.scanned} rows hold it`,
  );
  const fetched = yield* client.getSession({ sessionId: session.id });
  assert(
    "verify: the session's projection (getSession) holds no value",
    !JSON.stringify(fetched).includes(FAKE) &&
      JSON.stringify(fetched).includes("[secret:TEST_API_KEY]"),
    `${JSON.stringify(fetched).length} characters read`,
  );

  // --- leaky: a branch that adds the stored value is refused before the push ----------------------
  const leakyRepo = RepoSlug.make(`verify-secrets-${RUN}/leaky`);
  yield* client.registerRepo({
    repo: leakyRepo,
    defaultBaseRef: "main",
    localPath: fixtureRepo("leaky", { "leak-source": `${FAKE}\n` }),
  });
  yield* client.setSecret({
    repo: leakyRepo,
    name: "TEST_API_KEY",
    value: Redacted.make(FAKE),
  });
  const board = yield* client.createBoard({
    repo: leakyRepo,
    definitionId: DefinitionId.make("default"),
  });
  const card = yield* client.createTask({
    boardId: BoardInstanceId.make(board.id),
    title: "a card whose run commits a stored secret",
    actor: "person:verify-secrets",
  });
  yield* sql`UPDATE tasks SET "column" = 'building' WHERE id = ${card.id}`;
  const run = yield* client.createSession({
    taskId: card.id,
    taskColumn: "building",
  });
  yield* client.sendMessage({ sessionId: run.id, content: "build it" });
  yield* settled(run.id, "the leaky run to answer");
  const thread = yield* waitUntil(
    Effect.map(
      client.listTaskComments({ taskId: TaskId.make(card.id) }),
      (comments) =>
        comments.some((comment) => comment.body.includes("secret_found"))
          ? comments
          : undefined,
    ),
    "the refusal on the card",
  );
  const note = thread.map((comment) => comment.body).join("\n");
  const pr = factory(["pr", run.id]);
  const after = yield* client.getSession({ sessionId: run.id });
  observed.leaky = {
    sessionId: run.id,
    taskId: card.id,
    note,
    pr,
    prUrl: after.session.prUrl ?? null,
  };
  assert(
    "leaky: the card carries the named refusal, the secret by name and where it is",
    note.includes("secret_found") &&
      note.includes("the stored secret TEST_API_KEY at leaked.txt:1"),
    note.split("\n")[0]?.slice(0, 160) ?? "",
  );
  assert(
    "leaky: the refusal never quotes the value",
    !note.includes(FAKE) && !pr.out.includes(FAKE),
    "",
  );
  assert(
    "leaky: `factory pr` meets the same refusal, and no PR is recorded",
    pr.code !== 0 &&
      pr.out.includes("secret_found") &&
      after.session.prUrl === undefined,
    pr.out.trim().split("\n")[0]?.slice(0, 160) ?? "",
  );

  // --- delete: the secret is gone, and listed as such ---------------------------------------------
  const rm = factory(["secret", "rm", verifyRepo, "TEST_API_KEY"]);
  const gone = yield* client.listSecrets({ repo: verifyRepo });
  assert(
    "cli: `factory secret rm` deletes it; listSecrets answers none",
    rm.code === 0 && gone.length === 0,
    rm.out.trim(),
  );
  // The board show is the shell's (secrets.sh), which prints the card's note through the CLI.
  writeFileSync(path.join(REPOS, "leaky-task-id"), card.id);
});

mkdirSync(REPOS, { recursive: true });
const result = await Effect.runPromiseExit(
  Effect.scoped(program).pipe(
    Effect.provide(Layer.mergeAll(protocolFor(API_URL), DatabaseLive)),
  ),
);
if (Exit.isFailure(result)) {
  assert("the drive completed", false, String(result.cause));
}

await mkdir(EVIDENCE_DIR, { recursive: true });
await writeFile(
  path.join(EVIDENCE_DIR, "secrets.json"),
  `${JSON.stringify(observed, null, 2).split(FAKE).join("<the fake value>")}\n`,
);
const failed = Object.entries(observed.checks).filter(
  ([, check]) => !check.passed,
);
console.log(
  `\nsecrets: ${Object.keys(observed.checks).length - failed.length}/${Object.keys(observed.checks).length} checks passed — evidence in ${EVIDENCE_DIR}/secrets.json`,
);
if (failed.length > 0) process.exitCode = 1;
