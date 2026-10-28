// A worktree's declared setup, over the real API (S-env-setup).
//
//   bun setup.ts      (via ./setup.sh, which boots the API with the faux script this drives)
//
// Three fixture repos, each a local git checkout with no remote, registered over RPC:
//
//   ok        `.factory/config` declares `install: bun install` (one `file:` dependency, so no
//             network), a `build` that needs it, and a `verify` that needs both. A session's first
//             message runs them in its fresh worktree before the agent's first turn: the faux run's
//             `bash` probe finds `node_modules`, and its `verify` call exits 0 — the agent installed
//             nothing. The log's `factory.setup` record names both steps, exit 0.
//   broken    the install exits 7. A card's first message is refused `setup_failed` in the step's own
//             words; the card is blocked `setup_failed` with the same words as its note; the session
//             holds no message and no answer (no model was called); the log keeps the step's tail.
//   readiness the registry answers each checkout's agent-readiness score on registration, and
//             `listRepos` the same score.
//
// Env: API_URL, DATABASE_URL (to read the session logs), SETUP_REPOS, EVIDENCE_DIR.
import { execSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { RpcApi } from "@repo/domain/Rpc";
import { RepoSlug } from "@repo/domain/Session";
import { BoardInstanceId, DefinitionId, TaskId } from "@repo/domain/Task";
import { readLoggedSetup, readVerifyRecords } from "@repo/harness";
import { DatabaseLive, PostgresStorage } from "@repo/storage-postgres";
import { Effect, Exit, Layer } from "effect";
import { RpcClient } from "effect/rpc";
import { SqlClient } from "effect/sql/SqlClient";
import { makeChecker, protocolFor, waitUntil } from "./harness.ts";
import type { CheckRecord } from "./harness.ts";

const API_URL = process.env["API_URL"] ?? "http://localhost:9200";
const REPOS = path.resolve(
  process.env["SETUP_REPOS"] ?? ".verify/run/setup/repos",
);
const EVIDENCE_DIR = path.resolve(
  process.env["EVIDENCE_DIR"] ?? ".verify/evidence/latest/api",
);
const RUN = `${Date.now().toString(36)}`;

const observed: {
  apiUrl: string;
  run: string;
  ok?: unknown;
  broken?: unknown;
  readiness?: unknown;
  checks: Record<string, CheckRecord>;
} = { apiUrl: API_URL, run: RUN, checks: {} };
const assert = makeChecker(observed);

/** A checkout with `files` committed on `main`, and no remote. */
const fixtureRepo = (name: string, files: Record<string, string>): string => {
  const root = path.join(REPOS, name);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  const git = (command: string) =>
    execSync(command, { cwd: root, stdio: "ignore" });
  git("git init -q -b main");
  git("git config user.email verify-setup@localhost");
  git("git config user.name verify-setup");
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), content);
  }
  git("git add -A");
  git("git commit -q -m base");
  return root;
};

const PACKAGE = {
  "AGENTS.md": "# setup fixture\n",
  "package.json": JSON.stringify({
    name: "setup-fixture",
    private: true,
    dependencies: { "local-dep": "file:./vendor/local-dep" },
  }),
  "vendor/local-dep/package.json": JSON.stringify({
    name: "local-dep",
    version: "1.0.0",
    main: "index.js",
  }),
  "vendor/local-dep/index.js": 'module.exports = "from-local-dep";\n',
};
const BUILD = `bun -e "require('fs').writeFileSync('dist.txt', require('local-dep'))"`;
const VERIFY = `bun -e "console.log('verify:', require('local-dep'), require('fs').readFileSync('dist.txt', 'utf8'))"`;

/** The session's `factory.setup` and `verify` records, read from its log like any reader would. */
const logged = (sessionId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    return yield* Effect.acquireUseRelease(
      Effect.promise(() => PostgresStorage.reader(sql, sessionId)),
      (storage) =>
        Effect.all({
          setup: readLoggedSetup(storage),
          verify: readVerifyRecords(storage),
        }),
      (storage) => Effect.promise(() => storage.dispose()),
    );
  });

const program = Effect.gen(function* () {
  const client = yield* RpcClient.make(RpcApi);

  // --- ok: installed and built before the first turn ---------------------------------------------
  const okRepo = RepoSlug.make(`verify-setup-${RUN}/ok`);
  const okRegistered = yield* client.registerRepo({
    repo: okRepo,
    defaultBaseRef: "main",
    localPath: fixtureRepo("ok", {
      ...PACKAGE,
      ".factory/config": JSON.stringify({
        install: "bun install",
        build: BUILD,
        verify: VERIFY,
      }),
    }),
  });
  const okSession = yield* client.createSession({
    repo: okRepo,
    title: "verify-setup ok",
  });
  yield* client.sendMessage({
    sessionId: okSession.id,
    content: "make the change and verify it",
  });
  const okSnapshot = yield* waitUntil(
    Effect.map(client.getSession({ sessionId: okSession.id }), (snapshot) =>
      !snapshot.live.busy &&
      snapshot.entries.some(
        (entry) => entry.kind === "assistant" && entry.text !== "",
      )
        ? snapshot
        : undefined,
    ),
    "the ok run to answer",
  );
  const okLog = yield* logged(okSession.id);
  const probe = okSnapshot.entries.find(
    (entry) => entry.kind === "toolResult" && entry.toolName === "bash",
  );
  const verifyText =
    okSnapshot.entries.find(
      (entry) => entry.kind === "toolResult" && entry.toolName === "verify",
    )?.text ?? "";
  const report = okLog.verify[0];
  const verified = report?._tag === "VerifyReport" ? report.results[0] : null;
  observed.ok = {
    sessionId: okSession.id,
    worktree: okSnapshot.workspace.path,
    setup: okLog.setup,
    verify: okLog.verify,
    transcript: okSnapshot.entries.map((entry) => ({
      kind: entry.kind,
      toolName: entry.toolName,
      text: entry.text.slice(0, 400),
    })),
  };
  assert(
    "ok: the log records install and build, each exit 0, in the session's worktree",
    okLog.setup?.outcome === "succeeded" &&
      okLog.setup.steps.length === 2 &&
      okLog.setup.steps.every(
        (step) => step._tag === "SetupStepRan" && step.exitCode === 0,
      ) &&
      okLog.setup.steps[0]?.command === "bun install" &&
      okLog.setup.directory.endsWith(okSession.id),
    JSON.stringify(
      okLog.setup?.steps.map((step) => [
        step.step,
        step._tag === "SetupStepRan" ? step.exitCode : step.code,
      ]),
    ),
  );
  assert(
    "ok: the agent's first command found node_modules already installed",
    probe?.text.includes("deps-present") === true,
    probe?.text.trim().slice(0, 80) ?? "no bash result",
  );
  assert(
    "ok: the run's verify passed without the agent installing anything",
    verified?._tag === "VerifyRan" &&
      verified.source === "workspace" &&
      verified.exitCode === 0 &&
      verified.output.includes("verify: from-local-dep from-local-dep") &&
      verifyText.includes("exit 0"),
    verified === null || verified === undefined
      ? "no verify result"
      : `${verified._tag} ${verified._tag === "VerifyRan" ? `exit ${verified.exitCode}` : ""}`,
  );

  // --- broken: a failing install parks the card ---------------------------------------------------
  const brokenRepo = RepoSlug.make(`verify-setup-${RUN}/broken`);
  yield* client.registerRepo({
    repo: brokenRepo,
    defaultBaseRef: "main",
    localPath: fixtureRepo("broken", {
      ...PACKAGE,
      ".factory/config": JSON.stringify({
        install:
          'echo "resolving local-dep"; echo "error: registry unreachable" >&2; exit 7',
        build: BUILD,
        verify: VERIFY,
      }),
    }),
  });
  const board = yield* client.createBoard({
    repo: brokenRepo,
    definitionId: DefinitionId.make("default"),
  });
  const card = yield* client.createTask({
    boardId: BoardInstanceId.make(board.id),
    title: "a card whose repo does not install",
    actor: "person:verify-setup",
  });
  const run = yield* client.createSession({
    taskId: card.id,
    taskColumn: card.column,
  });
  const refused = yield* Effect.exit(
    client.sendMessage({ sessionId: run.id, content: "build it" }),
  );
  const error = Exit.isFailure(refused)
    ? refused.cause.reasons.find((reason) => reason._tag === "Fail")?.error
    : undefined;
  const parked = yield* client.getTask({ taskId: TaskId.make(card.id) });
  const brokenSnapshot = yield* client.getSession({ sessionId: run.id });
  const brokenLog = yield* logged(run.id);
  const runs = yield* client.listTaskRuns({ taskId: TaskId.make(card.id) });
  observed.broken = {
    sessionId: run.id,
    taskId: card.id,
    error,
    blocked: parked.blocked,
    setup: brokenLog.setup,
    runs,
    entries: brokenSnapshot.entries.map((entry) => entry.kind),
  };
  const errorCode =
    error !== undefined && "code" in error ? String(error.code) : undefined;
  const errorMessage =
    error !== undefined && "message" in error ? String(error.message) : "";
  assert(
    "broken: the first message is refused setup_failed, naming the step, exit code and output",
    errorCode === "setup_failed" &&
      errorMessage.includes("setup failed: install") &&
      errorMessage.includes("exited 7") &&
      errorMessage.includes("error: registry unreachable"),
    `${errorCode}: ${errorMessage.split("\n")[0]?.slice(0, 100)}`,
  );
  assert(
    "broken: the card is blocked setup_failed, with the output tail as its note",
    parked.blocked?.reason === "setup_failed" &&
      parked.blocked.note?.includes("error: registry unreachable") === true,
    JSON.stringify(parked.blocked ?? null).slice(0, 160),
  );
  assert(
    "broken: no message was submitted, the session was not titled from it, and no model answered",
    brokenSnapshot.entries.length === 0 && brokenSnapshot.session.title === "",
    JSON.stringify(brokenSnapshot.entries.map((entry) => entry.kind)),
  );
  assert(
    "broken: the log keeps the failed step, its exit code and its output tail; build never ran",
    brokenLog.setup?.outcome === "failed" &&
      brokenLog.setup.steps.length === 1 &&
      brokenLog.setup.steps[0]?._tag === "SetupStepRan" &&
      brokenLog.setup.steps[0].exitCode === 7 &&
      brokenLog.setup.steps[0].output.includes("resolving local-dep") &&
      brokenLog.setup.steps[0].output.includes("error: registry unreachable"),
    JSON.stringify(brokenLog.setup?.steps[0] ?? null).slice(0, 160),
  );
  assert(
    "broken: the card's run is over, not holding a cap slot",
    runs.length === 1 && runs[0]?.finishedAt !== undefined,
    JSON.stringify(runs.map((row) => row.finishedAt ?? null)),
  );

  // --- readiness: scored at registration and on read ----------------------------------------------
  const listed = (yield* client.listRepos({})).repos.find(
    (row) => row.repo === okRepo,
  );
  observed.readiness = {
    registered: okRegistered.readiness,
    listed: listed?.readiness,
  };
  assert(
    "readiness: registration answers the checkout's score, and listRepos the same",
    okRegistered.readiness?.max === 4 &&
      // AGENTS.md passes; package.json has no build/test scripts, and there are no skills.
      okRegistered.readiness.score === 1 &&
      JSON.stringify(listed?.readiness) ===
        JSON.stringify(okRegistered.readiness),
    `${okRegistered.readiness?.score}/${okRegistered.readiness?.max}`,
  );
});

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
  path.join(EVIDENCE_DIR, "setup.json"),
  `${JSON.stringify(observed, null, 2)}\n`,
);
const failed = Object.entries(observed.checks).filter(
  ([, check]) => !check.passed,
);
console.log(
  `\nsetup: ${Object.keys(observed.checks).length - failed.length}/${Object.keys(observed.checks).length} checks passed — evidence in ${EVIDENCE_DIR}/setup.json`,
);
if (failed.length > 0) process.exitCode = 1;
