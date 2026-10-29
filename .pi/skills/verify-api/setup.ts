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
//             A second message to that run is refused the same way and runs no install: it ended.
//   abandoned the install sleeps; the first send's client goes away mid-install and a second send
//             follows at once. The install runs once, is recorded, and the second send waits for it.
//   triggered a generic webhook delivery on a repo whose install sleeps: the route answers
//             `processed` while the install runs, and the server sends the prompt once it is done.
//   self      a clone of this checkout, whose own `.factory/config` declares `install: bun install`:
//             a session on the factory repo itself runs it in its fresh worktree (exit 0) before the
//             agent's first turn, which finds the monorepo's `node_modules` there.
//   readiness the registry answers each checkout's agent-readiness score on registration, and
//             `listRepos` the same score.
//
// A second phase, `PHASE=timeout`, runs against an API booted with `SETUP_TIMEOUT_SECONDS=1` (F24):
//
//   timeout   an install that sleeps 5 s is stopped at the deployment's bound. A card's first message
//             is refused `setup_failed` with the step's `could not run (timeout)`, the card is blocked
//             `setup_failed`, the install never reached its end, and `factory doctor`'s
//             `checkDeployment` reports the bound the process runs under.
//   recut     (main phase) a session whose worktree directory was deleted is cut again by its next
//             send and set up again (F23): the install ran twice, the record names a new cut.
//   replay    (main phase) a replay of a session on a repo with an install runs the install in its
//             own worktree before its first model call (F23).
//
// Env: API_URL, DATABASE_URL (to read the session logs), SETUP_REPOS, EVIDENCE_DIR, PHASE.
import { execSync } from "node:child_process";
import { createHmac } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { RpcApi } from "@repo/domain/Rpc";
import { RepoSlug, SessionId } from "@repo/domain/Session";
import { BoardInstanceId, DefinitionId, TaskId } from "@repo/domain/Task";
import { readLoggedSetup, readVerifyRecords } from "@repo/harness";
import { DatabaseLive, PostgresStorage } from "@repo/storage-postgres";
import { Clock, Effect, Exit, Fiber, Layer } from "effect";
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
/** The repo setup.sh's `TRIGGER_RULES` maps the `factory` label to, and the generic route's secret. */
const TRIGGER_REPO = RepoSlug.make(
  process.env["SETUP_TRIGGER_REPO"] ?? "verify-setup/triggered",
);
const TRIGGER_SECRET = process.env["TRIGGER_SECRET"] ?? "";
/** This checkout: the `self` scenario clones it, so a session runs on the factory repo itself. */
const SELF = path.resolve(import.meta.dirname, "..", "..", "..");

/**
 * `main` boots on the default bound; `restarted` runs against the same API home after a restart with
 * `SETUP_TIMEOUT_SECONDS=1` (setup.sh), which is what releases the owners the recut scenario needs.
 */
const PHASE = process.env["PHASE"] === "restarted" ? "restarted" : "main";
const STATE_FILE = path.join(REPOS, "recut-state.json");

const observed: {
  apiUrl: string;
  run: string;
  ok?: unknown;
  broken?: unknown;
  abandoned?: unknown;
  triggered?: unknown;
  self?: unknown;
  replay?: unknown;
  recut?: unknown;
  timeout?: unknown;
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

/** One delivery to the generic webhook route, signed as a sender signs it; its status and answer. */
const postSigned = async (delivery: string) => {
  const response = await fetch(`${API_URL}/webhooks/generic`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-trigger-signature": createHmac("sha256", TRIGGER_SECRET)
        .update(delivery)
        .digest("hex"),
    },
    body: delivery,
  });
  return {
    status: response.status,
    body: (await response.json().catch(() => null)) as {
      readonly status?: string;
      readonly sessionId?: string;
    } | null,
  };
};

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

const mainProgram = Effect.gen(function* () {
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
        install: `echo attempt >> ${path.join(REPOS, "broken-attempts.txt")}; echo "resolving local-dep"; echo "error: registry unreachable" >&2; exit 7`,
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
  // The run ended with its setup: a second message is refused with that failure and runs nothing.
  const again = yield* Effect.exit(
    client.sendMessage({ sessionId: run.id, content: "try again" }),
  );
  const againError = Exit.isFailure(again)
    ? again.cause.reasons.find((reason) => reason._tag === "Fail")?.error
    : undefined;
  const brokenAttempts = readFileSync(
    path.join(REPOS, "broken-attempts.txt"),
    "utf8",
  );
  const parkedAfter = yield* client.getTask({ taskId: TaskId.make(card.id) });
  observed.broken = {
    sessionId: run.id,
    taskId: card.id,
    error,
    blocked: parked.blocked,
    setup: brokenLog.setup,
    runs,
    entries: brokenSnapshot.entries.map((entry) => entry.kind),
    again: againError,
    attempts: brokenAttempts,
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

  const againCode =
    againError !== undefined && "code" in againError
      ? String(againError.code)
      : undefined;
  const againMessage =
    againError !== undefined && "message" in againError
      ? String(againError.message)
      : "";
  assert(
    "broken: a second message to the ended run is refused setup_failed and runs no install",
    againCode === "setup_failed" &&
      againMessage.includes("start a new run") &&
      brokenAttempts === "attempt\n" &&
      JSON.stringify(parkedAfter.blocked) === JSON.stringify(parked.blocked),
    `${againCode}; installs: ${brokenAttempts.split("\n").length - 1}`,
  );

  // --- abandoned: a client that goes away mid-install -------------------------------------------
  const abandonedLog = path.join(REPOS, "abandoned-attempts.txt");
  const abandonedRepo = RepoSlug.make(`verify-setup-${RUN}/abandoned`);
  yield* client.registerRepo({
    repo: abandonedRepo,
    defaultBaseRef: "main",
    localPath: fixtureRepo("abandoned", {
      ...PACKAGE,
      ".factory/config": JSON.stringify({
        install: `echo start >> ${abandonedLog}; sleep 3; bun install; echo done >> ${abandonedLog}`,
        verify: "true",
      }),
    }),
  });
  const abandonedSession = yield* client.createSession({
    repo: abandonedRepo,
    title: "verify-setup abandoned",
  });
  const gone = yield* Effect.forkChild(
    client.sendMessage({
      sessionId: abandonedSession.id,
      content: "first try",
    }),
  );
  yield* waitUntil(
    Effect.sync(() => existsSync(abandonedLog)),
    "the abandoned install to start",
  );
  // The request goes away (the server sees its client leave), then the retry arrives at once.
  yield* Fiber.interrupt(gone);
  yield* client.sendMessage({
    sessionId: abandonedSession.id,
    content: "retry",
  });
  const abandonedSnapshot = yield* waitUntil(
    Effect.map(
      client.getSession({ sessionId: abandonedSession.id }),
      (snapshot) =>
        !snapshot.live.busy &&
        snapshot.entries.some(
          (entry) => entry.kind === "assistant" && entry.text !== "",
        )
          ? snapshot
          : undefined,
    ),
    "the abandoned session's run to answer",
  );
  const abandonedAttempts = readFileSync(abandonedLog, "utf8");
  const abandonedSetup = (yield* logged(abandonedSession.id)).setup;
  const abandonedUsers = abandonedSnapshot.entries
    .filter((entry) => entry.kind === "user")
    .map((entry) => entry.text);
  observed.abandoned = {
    sessionId: abandonedSession.id,
    attempts: abandonedAttempts,
    setup: abandonedSetup,
    users: abandonedUsers,
  };
  assert(
    "abandoned: the install a gone client left ran once, was recorded, and the retry waited for it",
    abandonedAttempts === "start\ndone\n" &&
      abandonedSetup?.outcome === "succeeded" &&
      JSON.stringify(abandonedUsers) === JSON.stringify(["retry"]),
    `${JSON.stringify(abandonedAttempts)}; ${abandonedSetup?.outcome}; ${JSON.stringify(abandonedUsers)}`,
  );

  // --- triggered: a webhook delivery is answered before its session's setup finishes -----------
  // The sender (GitHub's timeout is 10 s) must not hold the request while an install runs: the
  // delivery is answered with the setup still running, and its prompt is sent once the setup is
  // done, by the server, with no request open.
  const triggeredLog = path.join(REPOS, "triggered-attempts.txt");
  yield* client.registerRepo({
    repo: TRIGGER_REPO,
    defaultBaseRef: "main",
    localPath: fixtureRepo("triggered", {
      ...PACKAGE,
      ".factory/config": JSON.stringify({
        install: `echo start >> ${triggeredLog}; sleep 4; bun install; echo done >> ${triggeredLog}`,
        verify: "true",
      }),
    }),
  });
  const deliveryId = `verify-setup-${RUN}`;
  const delivery = JSON.stringify({
    requestId: deliveryId,
    key: `verify-setup-${deliveryId}`,
    action: "create",
    label: "factory",
    title: `delivery ${deliveryId}`,
    body: "opened by verify-api setup",
  });
  const postedAt = yield* Clock.currentTimeMillis;
  const answered = yield* Effect.promise(() => postSigned(delivery));
  const answeredInMs = (yield* Clock.currentTimeMillis) - postedAt;
  const installWhenAnswered = existsSync(triggeredLog)
    ? readFileSync(triggeredLog, "utf8")
    : "";
  const triggeredId = answered.body?.sessionId;
  const triggeredSnapshot =
    triggeredId === undefined
      ? undefined
      : yield* waitUntil(
          Effect.map(
            client.getSession({ sessionId: SessionId.make(triggeredId) }),
            (snapshot) =>
              !snapshot.live.busy &&
              snapshot.entries.some(
                (entry) => entry.kind === "assistant" && entry.text !== "",
              )
                ? snapshot
                : undefined,
          ),
          "the triggered session's run to answer",
        );
  const triggeredUsers = (triggeredSnapshot?.entries ?? [])
    .filter((entry) => entry.kind === "user")
    .map((entry) => entry.text);
  const triggeredProbe = triggeredSnapshot?.entries.find(
    (entry) => entry.kind === "toolResult" && entry.toolName === "bash",
  );
  const triggeredSetup =
    triggeredId === undefined ? undefined : (yield* logged(triggeredId)).setup;
  observed.triggered = {
    status: answered.status,
    answer: answered.body,
    answeredInMs,
    installWhenAnswered,
    setup: triggeredSetup,
    users: triggeredUsers,
  };
  assert(
    "triggered: the webhook is answered processed while the session's install still runs",
    answered.status === 200 &&
      answered.body?.status === "processed" &&
      triggeredId !== undefined &&
      answeredInMs < 3_000 &&
      // Started, or about to: the setup is forked before the answer, and its shell may not have
      // written its first line yet. Never finished.
      !installWhenAnswered.includes("done"),
    `${answered.status} ${answered.body?.status} in ${answeredInMs}ms; install log ${JSON.stringify(installWhenAnswered)}`,
  );
  assert(
    "triggered: its prompt is sent once the setup succeeds, once, and the run starts with the deps",
    triggeredSetup?.outcome === "succeeded" &&
      readFileSync(triggeredLog, "utf8") === "start\ndone\n" &&
      triggeredUsers.length === 1 &&
      triggeredUsers[0]?.startsWith(`Work on delivery ${deliveryId}`) ===
        true &&
      triggeredProbe?.text.includes("deps-present") === true,
    `${triggeredSetup?.outcome}; ${JSON.stringify(triggeredUsers)}; ${triggeredProbe?.text.trim().slice(0, 40)}`,
  );

  // --- self: a session on this repo, whose own `.factory/config` declares `bun install` ----------
  // A clone of this checkout rather than the checkout itself: a session cuts its worktree and branch
  // in the repository it is registered at, and this one's `.git` is shared with every other checkout
  // of the factory on the machine. The clone has this checkout's HEAD and its `.factory/config`.
  const selfPath = path.join(REPOS, "self");
  rmSync(selfPath, { recursive: true, force: true });
  execSync(`git clone -q "${SELF}" "${selfPath}"`, { stdio: "ignore" });
  mkdirSync(path.join(selfPath, ".factory"), { recursive: true });
  writeFileSync(
    path.join(selfPath, ".factory", "config"),
    readFileSync(path.join(SELF, ".factory", "config"), "utf8"),
  );
  const selfBase = execSync("git rev-parse --abbrev-ref HEAD", {
    cwd: selfPath,
    encoding: "utf8",
  }).trim();
  const selfRepo = RepoSlug.make(`verify-setup-${RUN}/factory`);
  const selfRegistered = yield* client.registerRepo({
    repo: selfRepo,
    defaultBaseRef: selfBase,
    localPath: selfPath,
  });
  const selfSession = yield* client.createSession({
    repo: selfRepo,
    title: "verify-setup self",
  });
  // A cold install can outlast one send's wait (`setup_running`): sent again, each waits for it.
  const selfStarted = yield* Clock.currentTimeMillis;
  let selfRetries = 0;
  for (;;) {
    const sent = yield* Effect.exit(
      client.sendMessage({
        sessionId: selfSession.id,
        content: "look around the worktree",
      }),
    );
    if (Exit.isSuccess(sent)) break;
    const code = sent.cause.reasons.find(
      (reason) => reason._tag === "Fail",
    )?.error;
    if (
      code === undefined ||
      !("code" in code) ||
      code.code !== "setup_running" ||
      selfRetries >= 10
    ) {
      return yield* Effect.die(new Error(`self send: ${String(sent.cause)}`));
    }
    selfRetries += 1;
  }
  const selfSnapshot = yield* waitUntil(
    Effect.map(client.getSession({ sessionId: selfSession.id }), (snapshot) =>
      !snapshot.live.busy &&
      snapshot.entries.some(
        (entry) => entry.kind === "assistant" && entry.text !== "",
      )
        ? snapshot
        : undefined,
    ),
    "the self run to answer",
  );
  const selfLog = yield* logged(selfSession.id);
  const selfProbe = selfSnapshot.entries.find(
    (entry) => entry.kind === "toolResult" && entry.toolName === "bash",
  );
  observed.self = {
    sessionId: selfSession.id,
    checkout: selfPath,
    baseRef: selfBase,
    hasFactoryConfig: selfRegistered.hasFactoryConfig,
    worktree: selfSnapshot.workspace.path,
    sendRetries: selfRetries,
    firstAnswerMs: (yield* Clock.currentTimeMillis) - selfStarted,
    setup: selfLog.setup,
    probe: selfProbe?.text.slice(0, 200),
  };
  assert(
    "self: a session on this repo runs its declared `bun install` in its worktree, exit 0, before the first turn",
    selfRegistered.hasFactoryConfig &&
      selfLog.setup?.outcome === "succeeded" &&
      selfLog.setup.steps.length === 1 &&
      selfLog.setup.steps[0]?.step === "install" &&
      selfLog.setup.steps[0].command === "bun install" &&
      selfLog.setup.steps[0]._tag === "SetupStepRan" &&
      selfLog.setup.steps[0].exitCode === 0 &&
      selfLog.setup.directory.endsWith(selfSession.id),
    JSON.stringify(
      selfLog.setup?.steps.map((step) => [
        step.step,
        step.command,
        step._tag === "SetupStepRan" ? step.exitCode : step.code,
      ]),
    ),
  );
  assert(
    "self: the agent's first command found this repo's node_modules installed",
    selfProbe?.text.includes("deps-present") === true,
    selfProbe?.text.trim().slice(0, 80) ?? "no bash result",
  );

  // --- replay: a replay's worktree is set up before its first model call (F23) -------------------
  const replayLog = path.join(REPOS, "replay-attempts.txt");
  const replayRepo = RepoSlug.make(`verify-setup-${RUN}/replayed`);
  yield* client.registerRepo({
    repo: replayRepo,
    defaultBaseRef: "main",
    localPath: fixtureRepo("replayed", {
      ...PACKAGE,
      ".factory/config": JSON.stringify({
        install: `echo install >> ${replayLog}; sleep 3; bun install`,
        verify: "true",
      }),
    }),
  });
  const replaySource = yield* client.createSession({
    repo: replayRepo,
    title: "verify-setup replay source",
  });
  yield* client.sendMessage({
    sessionId: replaySource.id,
    content: "do the task",
  });
  yield* waitUntil(
    Effect.map(client.getSession({ sessionId: replaySource.id }), (snapshot) =>
      !snapshot.live.busy &&
      snapshot.entries.some(
        (entry) => entry.kind === "assistant" && entry.text !== "",
      )
        ? snapshot
        : undefined,
    ),
    "the replay source's run to answer",
  );
  const replayed = yield* client.replaySession({ sessionId: replaySource.id });
  // Answered while the replay's own install still sleeps: no prompt, so no model call, yet.
  const replayAtAnswer = yield* client.getSession({ sessionId: replayed.id });
  const replaySnapshot = yield* waitUntil(
    Effect.map(client.getSession({ sessionId: replayed.id }), (snapshot) =>
      !snapshot.live.busy &&
      snapshot.entries.some(
        (entry) => entry.kind === "assistant" && entry.text !== "",
      )
        ? snapshot
        : undefined,
    ),
    "the replay's run to answer",
  );
  const replayCompared = yield* waitUntil(
    Effect.map(client.getSession({ sessionId: replayed.id }), (snapshot) =>
      (snapshot.replayComparisons ?? []).length > 0 ? snapshot : undefined,
    ),
    "the replay's comparison",
  );
  const replayProbe = replaySnapshot.entries.find(
    (entry) => entry.kind === "toolResult" && entry.toolName === "bash",
  );
  const replayInstalls = readFileSync(replayLog, "utf8");
  const replaySetup = (yield* logged(replayed.id)).setup;
  observed.replay = {
    source: replaySource.id,
    replay: replayed.id,
    usersAtAnswer: replayAtAnswer.entries.filter(
      (entry) => entry.kind === "user",
    ).length,
    installs: replayInstalls,
    setup: replaySetup,
    probe: replayProbe?.text.slice(0, 120),
    comparison: replayCompared.replayComparisons?.[0]?.self.outcome,
  };
  assert(
    "replay: the replay is answered before its install ends, with no prompt submitted yet",
    replayAtAnswer.entries.filter((entry) => entry.kind === "user").length ===
      0,
    `${replayAtAnswer.entries.length} entries at the answer`,
  );
  assert(
    "replay: its own install ran in its own worktree before the agent's first command",
    replayInstalls === "install\ninstall\n" &&
      replaySetup?.outcome === "succeeded" &&
      replaySetup.directory.endsWith(replayed.id) &&
      replayProbe?.text.includes("deps-present") === true,
    `${JSON.stringify(replayInstalls)}; ${replaySetup?.outcome}; ${replayProbe?.text.trim().slice(0, 40)}`,
  );
  assert(
    "replay: the comparison waited for the held prompt and reads a run that answered",
    replayCompared.replayComparisons?.[0]?.self.outcome === "answered",
    String(replayCompared.replayComparisons?.[0]?.self.outcome),
  );

  // --- recut, seeded: the session the restarted phase deletes the worktree of (F23) -------------
  const recutLog = path.join(REPOS, "recut-attempts.txt");
  const recutRepo = RepoSlug.make(`verify-setup-${RUN}/recut`);
  yield* client.registerRepo({
    repo: recutRepo,
    defaultBaseRef: "main",
    localPath: fixtureRepo("recut", {
      ...PACKAGE,
      ".factory/config": JSON.stringify({
        install: `echo install >> ${recutLog}; touch installed.marker`,
        verify: "true",
      }),
    }),
  });
  const recutSession = yield* client.createSession({
    repo: recutRepo,
    title: "verify-setup recut",
  });
  yield* client.sendMessage({ sessionId: recutSession.id, content: "one" });
  const recutSeeded = yield* waitUntil(
    Effect.map(client.getSession({ sessionId: recutSession.id }), (snapshot) =>
      !snapshot.live.busy &&
      snapshot.entries.some(
        (entry) => entry.kind === "assistant" && entry.text !== "",
      )
        ? snapshot
        : undefined,
    ),
    "the recut session's first run to answer",
  );
  const recutFirst = (yield* logged(recutSession.id)).setup;
  writeFileSync(
    STATE_FILE,
    JSON.stringify({
      sessionId: recutSession.id,
      worktree: recutSeeded.workspace.path,
      attempts: recutLog,
      cut: recutFirst?.cut ?? null,
    }),
  );
  observed.recut = {
    seeded: {
      sessionId: recutSession.id,
      worktree: recutSeeded.workspace.path,
      cut: recutFirst?.cut,
    },
  };
  assert(
    "recut: the first send installed once and the record names the worktree's cut",
    recutFirst?.outcome === "succeeded" &&
      typeof recutFirst.cut === "string" &&
      readFileSync(recutLog, "utf8") === "install\n" &&
      existsSync(path.join(recutSeeded.workspace.path, "installed.marker")),
    `${recutFirst?.outcome}; cut ${recutFirst?.cut}`,
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

/** The scenarios that need the process restarted with `SETUP_TIMEOUT_SECONDS=1` (setup.sh). */
const restartedProgram = Effect.gen(function* () {
  const client = yield* RpcClient.make(RpcApi);

  // --- recut: the worktree's directory is gone, so the next send cuts it again (F23) -------------
  // The API was restarted, so no owner holds the session: deleting the directory is what a pruned
  // scratch disk does between two of a session's days.
  const state = JSON.parse(readFileSync(STATE_FILE, "utf8")) as {
    sessionId: string;
    worktree: string;
    attempts: string;
    cut: string | null;
  };
  const sessionId = SessionId.make(state.sessionId);
  const before = (yield* logged(sessionId)).setup;
  rmSync(state.worktree, { recursive: true, force: true });
  yield* client.sendMessage({ sessionId, content: "two" });
  const recutSnapshot = yield* waitUntil(
    Effect.map(client.getSession({ sessionId }), (snapshot) =>
      !snapshot.live.busy &&
      snapshot.entries.filter((entry) => entry.kind === "user").length === 2 &&
      snapshot.entries.some(
        (entry) => entry.kind === "assistant" && entry.text !== "",
      )
        ? snapshot
        : undefined,
    ),
    "the recut session's second run to answer",
  );
  const after = (yield* logged(sessionId)).setup;
  const installs = readFileSync(state.attempts, "utf8");
  observed.recut = {
    sessionId,
    cutBefore: before?.cut,
    cutAfter: after?.cut,
    installs,
    markerInNewWorktree: existsSync(
      path.join(recutSnapshot.workspace.path, "installed.marker"),
    ),
  };
  assert(
    "recut: the worktree cut again is set up again, and its record names the new cut",
    installs === "install\ninstall\n" &&
      existsSync(path.join(recutSnapshot.workspace.path, "installed.marker")) &&
      after?.outcome === "succeeded" &&
      typeof after.cut === "string" &&
      after.cut !== state.cut &&
      before?.cut === state.cut,
    `${JSON.stringify(installs)}; ${state.cut} -> ${after?.cut}`,
  );

  // --- timeout: an install that outlives SETUP_TIMEOUT_SECONDS=1 fails the setup (F24) ------------
  const sleepLog = path.join(REPOS, "timeout-attempts.txt");
  const sleepRepo = RepoSlug.make(`verify-setup-${RUN}/timeout`);
  yield* client.registerRepo({
    repo: sleepRepo,
    defaultBaseRef: "main",
    localPath: fixtureRepo("timeout", {
      ...PACKAGE,
      ".factory/config": JSON.stringify({
        install: `echo start >> ${sleepLog}; sleep 5; echo done >> ${sleepLog}`,
        verify: "true",
      }),
    }),
  });
  const board = yield* client.createBoard({
    repo: sleepRepo,
    definitionId: DefinitionId.make("default"),
  });
  const card = yield* client.createTask({
    boardId: BoardInstanceId.make(board.id),
    title: "a card whose install is slower than the bound",
    actor: "person:verify-setup",
  });
  const run = yield* client.createSession({
    taskId: card.id,
    taskColumn: card.column,
  });
  const startedAt = yield* Clock.currentTimeMillis;
  const refused = yield* Effect.exit(
    client.sendMessage({ sessionId: run.id, content: "build it" }),
  );
  const refusedInMs = (yield* Clock.currentTimeMillis) - startedAt;
  const error = Exit.isFailure(refused)
    ? refused.cause.reasons.find((reason) => reason._tag === "Fail")?.error
    : undefined;
  const parked = yield* client.getTask({ taskId: TaskId.make(card.id) });
  const snapshot = yield* client.getSession({ sessionId: run.id });
  const timeoutLog = yield* logged(run.id);
  // Past the install's own end: a step left running would have written `done`.
  yield* Effect.sleep(5_000);
  const attempts = readFileSync(sleepLog, "utf8");
  const deployment = yield* client.checkDeployment({});
  observed.timeout = {
    sessionId: run.id,
    taskId: card.id,
    refusedInMs,
    error,
    blocked: parked.blocked,
    setup: timeoutLog.setup,
    attempts,
    doctorSetupTimeoutSeconds: deployment.setupTimeoutSeconds,
  };
  const errorCode =
    error !== undefined && "code" in error ? String(error.code) : undefined;
  const errorMessage =
    error !== undefined && "message" in error ? String(error.message) : "";
  assert(
    "timeout: the first message is refused setup_failed with the step's timeout, after about one second",
    errorCode === "setup_failed" &&
      errorMessage.includes("setup failed: install") &&
      errorMessage.includes("could not run (timeout)") &&
      refusedInMs < 4_500,
    `${errorCode}: ${errorMessage.split("\n")[0]?.slice(0, 120)} in ${refusedInMs}ms`,
  );
  assert(
    "timeout: the card is parked setup_failed with the same words",
    parked.blocked?.reason === "setup_failed" &&
      parked.blocked.note?.includes("could not run (timeout)") === true,
    JSON.stringify(parked.blocked ?? null).slice(0, 160),
  );
  assert(
    "timeout: the log records the step unrunnable with code timeout, no model answered, and the install was stopped",
    timeoutLog.setup?.outcome === "failed" &&
      timeoutLog.setup.steps[0]?._tag === "SetupStepUnrunnable" &&
      timeoutLog.setup.steps[0].code === "timeout" &&
      snapshot.entries.length === 0 &&
      attempts === "start\n",
    `${timeoutLog.setup?.steps[0]?._tag}; ${JSON.stringify(attempts)}`,
  );
  assert(
    "timeout: checkDeployment (factory doctor) reports the bound the process runs under",
    deployment.setupTimeoutSeconds === 1,
    String(deployment.setupTimeoutSeconds),
  );
});

const result = await Effect.runPromiseExit(
  Effect.scoped(PHASE === "restarted" ? restartedProgram : mainProgram).pipe(
    Effect.provide(Layer.mergeAll(protocolFor(API_URL), DatabaseLive)),
  ),
);
if (Exit.isFailure(result)) {
  assert("the drive completed", false, String(result.cause));
}

await mkdir(EVIDENCE_DIR, { recursive: true });
await writeFile(
  path.join(
    EVIDENCE_DIR,
    PHASE === "restarted" ? "setup-restarted.json" : "setup.json",
  ),
  `${JSON.stringify(observed, null, 2)}\n`,
);
const failed = Object.entries(observed.checks).filter(
  ([, check]) => !check.passed,
);
console.log(
  `\nsetup (${PHASE}): ${Object.keys(observed.checks).length - failed.length}/${Object.keys(observed.checks).length} checks passed — evidence in ${EVIDENCE_DIR}/${PHASE === "restarted" ? "setup-restarted" : "setup"}.json`,
);
if (failed.length > 0) process.exitCode = 1;
