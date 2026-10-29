/**
 * A worktree's declared setup (S-env-setup), through the real service: a session on a repo whose
 * `.factory/config` declares `install` and `build` gets them run in its fresh worktree before the
 * agent's first turn, so the run's own `verify` passes without the agent installing anything; a
 * failing install refuses the first message `setup_failed`, parks the card with that reason and the
 * output's last lines, keeps the whole tail in the log, and calls no model. And the registry answers
 * each checkout's agent-readiness score (LOB-29) on registration and on every read.
 *
 * The fixtures are local git repos with no remote; the install is `bun install` of a `file:`
 * dependency, which needs no network. The model is pi-ai's faux provider, whose call count is the
 * witness that no model was called.
 *
 * Postgres only, not mocked: `docker compose up -d --wait postgres`.
 */
import { BunServices } from "@effect/platform-bun";
import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  RepoSlug,
  type SessionError,
  type SessionId,
} from "@repo/domain/Session";
import { DefinitionId, DEFAULT_DEFINITION_ID } from "@repo/domain/Task";
import {
  createFauxModelAccess,
  readLoggedSetup,
  readVerifyRecords,
} from "@repo/harness";
import { DatabaseLive, PostgresStorage } from "@repo/storage-postgres";
import {
  Clock,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  ManagedRuntime,
} from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { afterAll, describe, expect, it } from "vitest";
import { SessionService, SessionServiceLive } from "./SessionService";
import { TaskService, TaskServiceLive } from "./TaskService";
import {
  TriggerSessions,
  TriggerSessionsFromSessionService,
} from "./TriggerService";

const PERSON = "person:lukas";

/** A run of this file's, so two runs on one database never share a slug or a fixture. */
const RUN = randomBytes(4).toString("hex");
const scratch = mkdtempSync(join(tmpdir(), "factory-core-setup-"));

/** The `bash` call the faux model makes on its first turn: did the run start with the deps? */
const PROBE =
  'if [ -d node_modules/local-dep ]; then echo "deps-present"; else echo "deps-missing"; fi; mkdir -p src && echo 1 > src/feature.txt';

const faux = createFauxModelAccess({ fauxVerify: true, fauxCommand: PROBE });

const runtime = ManagedRuntime.make(
  Layer.mergeAll(
    SessionServiceLive({
      model: faux.access,
      sessionRoot: join(scratch, "sessions"),
    }),
    TaskServiceLive,
  ).pipe(Layer.provideMerge(Layer.mergeAll(DatabaseLive, BunServices.layer))),
);

/** A second process on the same database whose sends wait for a setup only briefly. */
const impatient = ManagedRuntime.make(
  SessionServiceLive({
    model: faux.access,
    sessionRoot: join(scratch, "impatient-sessions"),
    setupWaitMs: 300,
  }).pipe(Layer.provideMerge(Layer.mergeAll(DatabaseLive, BunServices.layer))),
);

afterAll(async () => {
  await impatient.dispose();
  await runtime.dispose();
  rmSync(scratch, { recursive: true, force: true });
});

const waitUntil = <E, R>(
  check: Effect.Effect<boolean, E, R>,
  label: string,
): Effect.Effect<void, E, R> =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 600; attempt += 1) {
      if (yield* check) return;
      yield* Effect.sleep(50);
    }
    return yield* Effect.die(new Error(`timed out waiting for ${label}`));
  });

/** A checkout with `files` committed on `main`, and no remote: nothing here can leave the machine. */
const fixtureRepo = (name: string, files: Record<string, string>): string => {
  const root = join(scratch, "repos", name);
  mkdirSync(root, { recursive: true });
  const git = (command: string) =>
    execSync(command, { cwd: root, stdio: "ignore" });
  git("git init -q -b main");
  git("git config user.email setup@localhost");
  git("git config user.name setup");
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), content);
  }
  git("git add -A");
  git("git commit -q -m base");
  return root;
};

/** A package with one dependency on a directory of its own: `bun install` resolves it offline. */
const PACKAGE = {
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

/** Requires the installed dependency: fails in a worktree nobody installed. */
const VERIFY = `bun -e "console.log('verify:', require('local-dep'), require('fs').readFileSync('dist.txt', 'utf8'))"`;

const slug = (name: string) => RepoSlug.make(`setup-${RUN}/${name}`);

const registerFixture = (name: string, files: Record<string, string>) =>
  Effect.gen(function* () {
    const sessions = yield* SessionService;
    const repo = slug(name);
    const localPath = fixtureRepo(name, files);
    const registered = yield* sessions.registerRepo({
      repo,
      url: `https://example.invalid/${name}.git`,
      defaultBaseRef: "main",
      localPath,
    });
    return { repo, localPath, registered };
  });

const readSetup = (sessionId: SessionId) =>
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

const settled = (sessionId: SessionId) =>
  Effect.gen(function* () {
    const sessions = yield* SessionService;
    yield* waitUntil(
      Effect.map(
        sessions.get(sessionId),
        (snapshot) =>
          !snapshot.live.busy &&
          snapshot.entries.some(
            (entry) => entry.kind === "assistant" && entry.text !== "",
          ),
      ),
      "the run to answer",
    );
    return yield* sessions.get(sessionId);
  });

describe("a worktree's declared setup", () => {
  it("installs and builds before the first turn, so verify passes without the agent installing", async () => {
    const attempts = join(scratch, "installs-ok.txt");
    const outcome = await runtime.runPromise(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const { repo } = yield* registerFixture("ok", {
          ...PACKAGE,
          ".factory/config": JSON.stringify({
            install: `echo install >> ${attempts}; bun install`,
            build: `bun -e "require('fs').writeFileSync('dist.txt', require('local-dep'))"`,
            verify: VERIFY,
          }),
        });
        const calls = faux.faux.state.callCount;
        const created = yield* sessions.create({ repo, title: "set up" });
        yield* sessions.send({
          sessionId: created.id,
          content: "make the change and verify it",
        });
        const first = yield* settled(created.id);
        const logged = yield* readSetup(created.id);
        // A second message is not a first turn: the setup that succeeded is not run again.
        yield* sessions.send({ sessionId: created.id, content: "again" });
        yield* waitUntil(
          Effect.map(
            sessions.get(created.id),
            (snapshot) =>
              !snapshot.live.busy &&
              snapshot.entries.filter((entry) => entry.kind === "user")
                .length === 2,
          ),
          "the second message to settle",
        );
        return { first, logged, calls, after: yield* readSetup(created.id) };
      }),
    );

    const { setup, verify } = outcome.logged;
    expect(setup?.outcome).toBe("succeeded");
    expect(setup?.directory).toBe(realpathSync(outcome.first.workspace.path));
    expect(setup?.steps.map((step) => [step._tag, step.step])).toEqual([
      ["SetupStepRan", "install"],
      ["SetupStepRan", "build"],
    ]);
    expect(
      setup?.steps.every(
        (step) => step._tag === "SetupStepRan" && step.exitCode === 0,
      ),
    ).toBe(true);
    // The worktree had its dependencies when the agent's first command ran in it.
    const probe = outcome.first.entries.find(
      (entry) => entry.kind === "toolResult" && entry.toolName === "bash",
    );
    expect(probe?.text).toContain("deps-present");
    // And the run's declared verify, which requires them, passed.
    const report = verify[0];
    expect(report?._tag).toBe("VerifyReport");
    const result = report?._tag === "VerifyReport" ? report.results[0] : null;
    expect(result).toMatchObject({
      _tag: "VerifyRan",
      source: "workspace",
      exitCode: 0,
    });
    expect(result?._tag === "VerifyRan" ? result.output : "").toContain(
      "verify: from-local-dep from-local-dep",
    );
    // Installed once across both messages, and the record stands as it was.
    expect(readFileSync(attempts, "utf8")).toBe("install\n");
    expect(outcome.after.setup).toEqual(setup);
  }, 180_000);

  it("refuses the first message on a failed install, parks the card, keeps the tail, and calls no model", async () => {
    const attempts = join(scratch, "installs-failed.txt");
    const outcome = await runtime.runPromise(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const tasks = yield* TaskService;
        const sql = yield* SqlClient;
        const { repo } = yield* registerFixture("broken", {
          ...PACKAGE,
          ".factory/config": JSON.stringify({
            install: `echo attempt >> ${attempts}; echo "resolving local-dep"; echo "error: registry unreachable" >&2; exit 7`,
            build: "touch built-marker",
            verify: VERIFY,
          }),
        });
        const board = yield* tasks.createBoard({
          repo,
          definitionId: DefinitionId.make(DEFAULT_DEFINITION_ID),
        });
        const card = yield* tasks.create({
          boardId: board.id,
          title: "a card whose repo does not install",
          actor: PERSON,
        });
        const run = yield* sessions.create({
          taskId: card.id,
          taskColumn: card.column,
        });
        const calls = faux.faux.state.callCount;
        const refused = yield* Effect.exit(
          sessions.send({ sessionId: run.id, content: "build it" }),
        );
        const callsAfter = faux.faux.state.callCount;
        const parked = yield* tasks.get(card.id);
        const snapshot = yield* sessions.get(run.id);
        const logged = yield* readSetup(run.id);
        const runRows = yield* sql<{ finished: boolean }>`
          SELECT finished_at IS NOT NULL AS finished FROM task_runs
          WHERE session_id = ${run.id}
        `;
        // The run ended with its setup: a message to it is refused with that failure, runs nothing,
        // and leaves the card's block and the ended run as they are.
        const again = yield* Effect.exit(
          sessions.send({ sessionId: run.id, content: "try again" }),
        );
        const stillParked = yield* tasks.get(card.id);
        const runRowsAfter = yield* sql<{ finished: boolean }>`
          SELECT finished_at IS NOT NULL AS finished FROM task_runs
          WHERE session_id = ${run.id}
        `;
        return {
          refused,
          again,
          calls,
          callsAfter,
          parked,
          stillParked,
          snapshot,
          logged,
          runRows,
          runRowsAfter,
        };
      }),
    );

    const failure = (exit: Exit.Exit<unknown, SessionError>) =>
      Exit.isFailure(exit)
        ? exit.cause.reasons.find((reason) => reason._tag === "Fail")?.error
        : undefined;
    const error = failure(outcome.refused);
    expect(error?.code).toBe("setup_failed");
    expect(error?.message).toContain("setup failed: install");
    expect(error?.message).toContain("exited 7");
    expect(error?.message).toContain("error: registry unreachable");

    // No model was called and no message was submitted.
    expect(outcome.callsAfter).toBe(outcome.calls);
    // Nothing at all: not the message, and not a title taken from it.
    expect(outcome.snapshot.entries).toEqual([]);
    expect(outcome.snapshot.session.title).toBe("");

    // The card says why, in the same words, and its run is over rather than holding a cap slot.
    expect(outcome.parked.blocked?.reason).toBe("setup_failed");
    expect(outcome.parked.blocked?.note).toContain("exited 7");
    expect(outcome.parked.blocked?.note).toContain(
      "error: registry unreachable",
    );
    expect(outcome.runRows).toEqual([{ finished: true }]);

    // The log holds the step, its exit code and its whole tail; the build never ran.
    const setup = outcome.logged.setup;
    expect(setup?.outcome).toBe("failed");
    expect(setup?.steps).toHaveLength(1);
    expect(setup?.steps[0]).toMatchObject({
      _tag: "SetupStepRan",
      step: "install",
      exitCode: 7,
    });
    expect(setup?.steps[0]?.output).toContain("resolving local-dep");
    expect(setup?.steps[0]?.output).toContain("error: registry unreachable");
    expect(
      existsSync(join(outcome.snapshot.workspace.path, "built-marker")),
    ).toBe(false);

    // Sent to again: refused with the recorded failure and what to do, and the install did not rerun.
    const again = failure(outcome.again);
    expect(again?.code).toBe("setup_failed");
    expect(again?.message).toContain("exited 7");
    expect(again?.message).toContain("start a new run");
    expect(readFileSync(attempts, "utf8")).toBe("attempt\n");
    expect(outcome.stillParked.blocked).toEqual(outcome.parked.blocked);
    expect(outcome.runRowsAfter).toEqual([{ finished: true }]);
    expect(faux.faux.state.callCount).toBe(outcome.calls);
  }, 180_000);

  it("runs a failed setup again on the next message to a session that is no card's run, and works once it passes", async () => {
    const attempts = join(scratch, "installs-retried.txt");
    const fixed = join(scratch, "installs-retried.fixed");
    const outcome = await runtime.runPromise(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const { repo } = yield* registerFixture("flaky", {
          ...PACKAGE,
          ".factory/config": JSON.stringify({
            install: `echo attempt >> ${attempts}; if [ -f ${fixed} ]; then bun install; else touch ${fixed}; echo "network blip" >&2; exit 4; fi`,
            verify: "true",
          }),
        });
        const created = yield* sessions.create({ repo, title: "retried" });
        const first = yield* Effect.exit(
          sessions.send({ sessionId: created.id, content: "go" }),
        );
        const failed = yield* readSetup(created.id);
        yield* sessions.send({ sessionId: created.id, content: "go again" });
        const snapshot = yield* settled(created.id);
        return {
          first,
          failed,
          snapshot,
          logged: yield* readSetup(created.id),
        };
      }),
    );
    expect(Exit.isFailure(outcome.first)).toBe(true);
    expect(outcome.failed.setup?.outcome).toBe("failed");
    expect(readFileSync(attempts, "utf8")).toBe("attempt\nattempt\n");
    expect(outcome.logged.setup?.outcome).toBe("succeeded");
    // The message that ran is the second, the first was never submitted.
    expect(
      outcome.snapshot.entries
        .filter((entry) => entry.kind === "user")
        .map((entry) => entry.text),
    ).toEqual(["go again"]);
    const probe = outcome.snapshot.entries.find(
      (entry) => entry.kind === "toolResult" && entry.toolName === "bash",
    );
    expect(probe?.text).toContain("deps-present");
  }, 180_000);

  it("keeps a setup running when the send waiting on it goes away, and the next send waits for it instead of installing again", async () => {
    const attempts = join(scratch, "installs-abandoned.txt");
    const outcome = await runtime.runPromise(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const { repo } = yield* registerFixture("abandoned", {
          ...PACKAGE,
          ".factory/config": JSON.stringify({
            install: `echo start >> ${attempts}; sleep 2; bun install; echo done >> ${attempts}`,
            verify: "true",
          }),
        });
        const created = yield* sessions.create({ repo, title: "abandoned" });
        // A client that goes away mid-install: its request's fiber is interrupted.
        const abandoned = yield* Effect.forkChild(
          sessions.send({ sessionId: created.id, content: "first try" }),
        );
        yield* waitUntil(
          Effect.sync(() => existsSync(attempts)),
          "the install to start",
        );
        yield* Fiber.interrupt(abandoned);
        // The retry arrives while the first install still runs.
        yield* sessions.send({ sessionId: created.id, content: "retry" });
        const snapshot = yield* settled(created.id);
        return { snapshot, logged: yield* readSetup(created.id) };
      }),
    );
    expect(readFileSync(attempts, "utf8")).toBe("start\ndone\n");
    expect(outcome.logged.setup?.outcome).toBe("succeeded");
    expect(
      outcome.snapshot.entries
        .filter((entry) => entry.kind === "user")
        .map((entry) => entry.text),
    ).toEqual(["retry"]);
    const probe = outcome.snapshot.entries.find(
      (entry) => entry.kind === "toolResult" && entry.toolName === "bash",
    );
    expect(probe?.text).toContain("deps-present");
  }, 180_000);

  it("answers setup_running to a send that outwaits its bound, and the setup it left finishes once", async () => {
    const attempts = join(scratch, "installs-slow.txt");
    const outcome = await impatient.runPromise(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const { repo } = yield* registerFixture("slow", {
          ...PACKAGE,
          ".factory/config": JSON.stringify({
            install: `echo start >> ${attempts}; sleep 2; bun install; echo done >> ${attempts}`,
            verify: "true",
          }),
        });
        const created = yield* sessions.create({ repo, title: "slow" });
        const first = yield* Effect.exit(
          sessions.send({ sessionId: created.id, content: "go" }),
        );
        // Sent again until the setup the first send left has finished; each waits for that one.
        let retries = 0;
        for (;;) {
          const sent = yield* Effect.exit(
            sessions.send({ sessionId: created.id, content: "go" }),
          );
          if (Exit.isSuccess(sent)) break;
          retries += 1;
          if (retries > 100)
            return yield* Effect.die(new Error("never set up"));
        }
        yield* settled(created.id);
        return { first, retries };
      }),
    );
    const failure = Exit.isFailure(outcome.first)
      ? outcome.first.cause.reasons.find((reason) => reason._tag === "Fail")
          ?.error
      : undefined;
    expect(failure?.code).toBe("setup_running");
    expect(failure?.message).toContain("still running");
    expect(readFileSync(attempts, "utf8")).toBe("start\ndone\n");
  }, 180_000);

  it("answers a trigger's send before a slow setup finishes, and sends its prompt once the setup succeeds", async () => {
    const attempts = join(scratch, "installs-trigger.txt");
    const outcome = await runtime.runPromise(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const port = yield* TriggerSessions;
        const { repo } = yield* registerFixture("trigger", {
          ...PACKAGE,
          ".factory/config": JSON.stringify({
            install: `echo start >> ${attempts}; sleep 3; bun install; echo done >> ${attempts}`,
            verify: "true",
          }),
        });
        const created = yield* sessions.create({ repo, title: "triggered" });
        const requestId = `trigger:setup-${RUN}`;
        const startedAt = yield* Clock.currentTimeMillis;
        // The webhook's own request: answered while the install still sleeps.
        yield* port.send({
          sessionId: created.id,
          content: "from the webhook",
          requestId,
        });
        const answeredInMs = (yield* Clock.currentTimeMillis) - startedAt;
        const whileRunning = yield* readSetup(created.id);
        const entriesWhileRunning = (yield* sessions.get(created.id)).entries;
        // A redelivery of the same delivery while the setup runs waits beside nothing new.
        yield* port.send({
          sessionId: created.id,
          content: "from the webhook",
          requestId,
        });
        const snapshot = yield* settled(created.id);
        // And one after the setup is a duplicate of a message already submitted under that key.
        yield* port.send({
          sessionId: created.id,
          content: "from the webhook",
          requestId,
        });
        return {
          answeredInMs,
          whileRunning,
          entriesWhileRunning,
          snapshot,
          after: yield* sessions.get(created.id),
          logged: yield* readSetup(created.id),
        };
      }).pipe(Effect.provide(TriggerSessionsFromSessionService)),
    );
    expect(outcome.answeredInMs).toBeLessThan(2_500);
    expect(outcome.whileRunning.setup).toBeUndefined();
    expect(
      outcome.entriesWhileRunning.filter((entry) => entry.kind === "user"),
    ).toEqual([]);
    expect(outcome.logged.setup?.outcome).toBe("succeeded");
    expect(readFileSync(attempts, "utf8")).toBe("start\ndone\n");
    const users = (entries: typeof outcome.after.entries) =>
      entries.filter((entry) => entry.kind === "user").map((e) => e.text);
    expect(users(outcome.snapshot.entries)).toEqual(["from the webhook"]);
    expect(users(outcome.after.entries)).toEqual(["from the webhook"]);
    const probe = outcome.snapshot.entries.find(
      (entry) => entry.kind === "toolResult" && entry.toolName === "bash",
    );
    expect(probe?.text).toContain("deps-present");
  }, 180_000);

  it("sends a trigger's prompt nowhere when the setup it waited for fails, and calls no model", async () => {
    const outcome = await runtime.runPromise(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const port = yield* TriggerSessions;
        const { repo } = yield* registerFixture("trigger-broken", {
          ...PACKAGE,
          ".factory/config": JSON.stringify({
            install: 'sleep 1; echo "error: registry unreachable" >&2; exit 7',
            verify: "true",
          }),
        });
        const created = yield* sessions.create({ repo, title: "broken" });
        const calls = faux.faux.state.callCount;
        yield* port.send({
          sessionId: created.id,
          content: "from the webhook",
          requestId: `trigger:broken-${RUN}`,
        });
        yield* waitUntil(
          Effect.map(
            readSetup(created.id),
            (logged) => logged.setup !== undefined,
          ),
          "the setup to be recorded",
        );
        // Long enough for a message that was going to be sent after it to have been.
        yield* Effect.sleep(500);
        return {
          calls,
          snapshot: yield* sessions.get(created.id),
          logged: yield* readSetup(created.id),
        };
      }).pipe(Effect.provide(TriggerSessionsFromSessionService)),
    );
    expect(outcome.logged.setup?.outcome).toBe("failed");
    expect(
      outcome.snapshot.entries.filter((entry) => entry.kind === "user"),
    ).toEqual([]);
    expect(faux.faux.state.callCount).toBe(outcome.calls);
  }, 180_000);

  it("stops a setup still running when its workspace is released, and records nothing for it", async () => {
    const attempts = join(scratch, "installs-released.txt");
    const outcome = await runtime.runPromise(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const tasks = yield* TaskService;
        const { repo } = yield* registerFixture("released", {
          ...PACKAGE,
          ".factory/config": JSON.stringify({
            install: `echo start >> ${attempts}; sleep 3; echo done >> ${attempts}; exit 7`,
            verify: "true",
          }),
        });
        const board = yield* tasks.createBoard({
          repo,
          definitionId: DefinitionId.make(DEFAULT_DEFINITION_ID),
        });
        const card = yield* tasks.create({
          boardId: board.id,
          title: "a card released mid-install",
          actor: PERSON,
        });
        const run = yield* sessions.create({
          taskId: card.id,
          taskColumn: card.column,
        });
        const waiting = yield* Effect.forkChild(
          Effect.exit(sessions.send({ sessionId: run.id, content: "go" })),
        );
        yield* waitUntil(
          Effect.sync(() => existsSync(attempts)),
          "the install to start",
        );
        yield* sessions.releaseWorkspace({
          sessionId: run.id,
          reason: "discarded",
        });
        const sent = yield* Fiber.join(waiting);
        // Past the install's own end: a command left running would have written `done` and failed.
        yield* Effect.sleep(4_000);
        return {
          sent,
          card: yield* tasks.get(card.id),
          logged: yield* readSetup(run.id),
        };
      }),
    );
    const failure = Exit.isFailure(outcome.sent)
      ? outcome.sent.cause.reasons.find((reason) => reason._tag === "Fail")
          ?.error
      : undefined;
    expect(failure?.code).toBe("harness");
    expect(failure?.message).toContain("stopped before it finished");
    expect(readFileSync(attempts, "utf8")).toBe("start\n");
    expect(outcome.logged.setup).toBeUndefined();
    expect(outcome.card.blocked).toBeUndefined();
  }, 180_000);

  it("sets a replay's worktree up before its first model call, and compares it as the run it is", async () => {
    const attempts = join(scratch, "installs-replay.txt");
    const outcome = await runtime.runPromise(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const { repo } = yield* registerFixture("replayed", {
          ...PACKAGE,
          ".factory/config": JSON.stringify({
            install: `echo install >> ${attempts}; sleep 1; bun install`,
            verify: "true",
          }),
        });
        const source = yield* sessions.create({ repo, title: "to replay" });
        yield* sessions.send({ sessionId: source.id, content: "do it" });
        yield* settled(source.id);
        const calls = faux.faux.state.callCount;
        const replay = yield* sessions.replay({ sessionId: source.id });
        // The replay is answered while its install still runs: no model call has been made.
        const answered = {
          calls: faux.faux.state.callCount - calls,
          users: (yield* sessions.get(replay.id)).entries.filter(
            (entry) => entry.kind === "user",
          ).length,
        };
        const run = yield* settled(replay.id);
        yield* waitUntil(
          Effect.map(
            sessions.get(replay.id),
            (snapshot) => (snapshot.replayComparisons ?? []).length > 0,
          ),
          "the replay's comparison",
        );
        return {
          replay,
          answered,
          run,
          compared: yield* sessions.get(replay.id),
          logged: yield* readSetup(replay.id),
        };
      }),
    );
    expect(outcome.answered).toEqual({ calls: 0, users: 0 });
    // Its own worktree, which had its dependencies when the replay's first command ran in it.
    const probe = outcome.run.entries.find(
      (entry) => entry.kind === "toolResult" && entry.toolName === "bash",
    );
    expect(probe?.text).toContain("deps-present");
    expect(outcome.logged.setup?.outcome).toBe("succeeded");
    expect(outcome.logged.setup?.directory).toBe(
      realpathSync(outcome.run.workspace.path),
    );
    // The source's install and the replay's: one each, the replay's not skipped as the source's.
    expect(readFileSync(attempts, "utf8")).toBe("install\ninstall\n");
    // The comparison waited for the prompt the setup held, so it reads a run that answered.
    expect(outcome.compared.replayComparisons?.[0]?.self.outcome).toBe(
      "answered",
    );
  }, 180_000);

  /** Mutation: let a message sent to the replay wake beside the held prompt, in either order. */
  it("places the source's prompt before a message sent to a replay while its setup runs", async () => {
    const entries = await runtime.runPromise(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const { repo } = yield* registerFixture("replay-order", {
          ...PACKAGE,
          ".factory/config": JSON.stringify({
            install: "sleep 1; bun install",
            verify: "true",
          }),
        });
        const source = yield* sessions.create({ repo, title: "to replay" });
        yield* sessions.send({ sessionId: source.id, content: "the task" });
        yield* settled(source.id);
        const replay = yield* sessions.replay({ sessionId: source.id });
        // The web pane on the new session: a person types while the install still runs.
        yield* sessions.sendDeferringSetup({
          sessionId: replay.id,
          content: "and a person's note",
        });
        const users = (id: SessionId) =>
          Effect.map(sessions.get(id), (snapshot) =>
            snapshot.entries.flatMap((entry) =>
              entry.kind === "user" ? [entry.text] : [],
            ),
          );
        yield* waitUntil(
          Effect.map(users(replay.id), (texts) => texts.length >= 2),
          "both messages to be submitted",
        );
        return yield* users(replay.id);
      }),
    );
    expect(entries).toEqual(["the task", "and a person's note"]);
  }, 180_000);

  /** Mutation: `tapError` for the open's cleanup, which an interrupted request skips. */
  it("leaves no index row behind when a replay request is interrupted in its open", async () => {
    const counts = await runtime.runPromise(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const sql = yield* SqlClient;
        const { repo } = yield* registerFixture("replay-interrupted", {
          ...PACKAGE,
          ".factory/config": JSON.stringify({
            install: "bun install",
            verify: "true",
          }),
        });
        const source = yield* sessions.create({ repo, title: "to replay" });
        yield* sessions.send({ sessionId: source.id, content: "do it" });
        yield* settled(source.id);
        const rows = () =>
          Effect.map(
            sql<{
              n: number;
            }>`SELECT count(*)::int AS n FROM sessions WHERE repo = ${repo}`,
            (found) => found[0]?.n ?? 0,
          );
        const outcomes: Array<{ interrupted: boolean; rows: number }> = [];
        // The request stops at a different step of the open each time: the cut is slow enough that
        // some land after the index row is written.
        for (const ms of [2, 10, 25, 60]) {
          const before = yield* rows();
          const finished = yield* sessions
            .replay({ sessionId: source.id })
            .pipe(Effect.timeoutOption(Duration.millis(ms)));
          const after = yield* rows();
          outcomes.push(
            finished._tag === "Some"
              ? { interrupted: false, rows: after - before - 1 }
              : { interrupted: true, rows: after - before },
          );
        }
        return outcomes;
      }),
    );
    // An interrupted request left no row; a replay that did finish left exactly its own.
    expect(counts.every((outcome) => outcome.rows === 0)).toBe(true);
  }, 180_000);

  it("submits no prompt for a replay whose setup fails, and says it was unanswered", async () => {
    const outcome = await runtime.runPromise(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const { repo, localPath } = yield* registerFixture("replay-broken", {
          ...PACKAGE,
          ".factory/config": JSON.stringify({
            install: "bun install",
            verify: "true",
          }),
        });
        const source = yield* sessions.create({ repo, title: "to replay" });
        yield* sessions.send({ sessionId: source.id, content: "do it" });
        yield* settled(source.id);
        // The repo's install breaks after the source ran: the replay's worktree is cut from it.
        writeFileSync(
          join(localPath, ".factory", "config"),
          JSON.stringify({
            install: 'echo "error: registry unreachable" >&2; exit 7',
            verify: "true",
          }),
        );
        execSync("git commit -qam break", { cwd: localPath, stdio: "ignore" });
        const calls = faux.faux.state.callCount;
        const replay = yield* sessions.replay({ sessionId: source.id });
        yield* waitUntil(
          Effect.map(
            readSetup(replay.id),
            (logged) => logged.setup !== undefined,
          ),
          "the replay's setup to be recorded",
        );
        yield* waitUntil(
          Effect.map(
            sessions.get(replay.id),
            (snapshot) => (snapshot.replayComparisons ?? []).length > 0,
          ),
          "the replay's comparison",
        );
        return {
          calls,
          snapshot: yield* sessions.get(replay.id),
          logged: yield* readSetup(replay.id),
        };
      }),
    );
    expect(outcome.logged.setup?.outcome).toBe("failed");
    expect(
      outcome.snapshot.entries.filter((entry) => entry.kind === "user"),
    ).toEqual([]);
    expect(faux.faux.state.callCount).toBe(outcome.calls);
    expect(outcome.snapshot.replayComparisons?.[0]?.self.outcome).toBe(
      "unanswered",
    );
  }, 180_000);

  it("sets a worktree up again when it is cut again, and not when it is merely reopened", async () => {
    const attempts = join(scratch, "installs-recut.txt");
    const outcome = await runtime.runPromise(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const { repo } = yield* registerFixture("recut", {
          ...PACKAGE,
          ".factory/config": JSON.stringify({
            install: `echo install >> ${attempts}; bun install`,
            verify: "true",
          }),
        });
        const created = yield* sessions.create({ repo, title: "recut" });
        const turns = (n: number) =>
          waitUntil(
            Effect.map(
              sessions.get(created.id),
              (snapshot) =>
                !snapshot.live.busy &&
                snapshot.entries.filter((entry) => entry.kind === "user")
                  .length === n,
            ),
            `turn ${n} to settle`,
          );
        yield* sessions.send({ sessionId: created.id, content: "one" });
        yield* turns(1);
        const first = yield* readSetup(created.id);
        const path = (yield* sessions.get(created.id)).workspace.path;
        // Released and reopened on the same worktree: its dependencies are still there.
        yield* sessions.close;
        yield* sessions.send({ sessionId: created.id, content: "two" });
        yield* turns(2);
        const reopened = yield* readSetup(created.id);
        const installsAfterReopen = readFileSync(attempts, "utf8");
        // Released with its directory gone: the next send cuts a new worktree, with none.
        yield* sessions.close;
        rmSync(path, { recursive: true, force: true });
        yield* sessions.send({ sessionId: created.id, content: "three" });
        yield* turns(3);
        return {
          path,
          first,
          reopened,
          installsAfterReopen,
          recut: yield* readSetup(created.id),
          installed: existsSync(join(path, "node_modules", "local-dep")),
        };
      }),
    );
    expect(outcome.first.setup?.cut).toBeTruthy();
    expect(outcome.installsAfterReopen).toBe("install\n");
    expect(outcome.reopened.setup).toEqual(outcome.first.setup);
    expect(readFileSync(attempts, "utf8")).toBe("install\ninstall\n");
    expect(outcome.recut.setup?.outcome).toBe("succeeded");
    expect(outcome.recut.setup?.cut).toBeTruthy();
    expect(outcome.recut.setup?.cut).not.toBe(outcome.first.setup?.cut);
    expect(outcome.installed).toBe(true);
  }, 180_000);

  it("runs and records nothing for a repo that declares no install or build", async () => {
    const outcome = await runtime.runPromise(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const { repo } = yield* registerFixture("plain", {
          ...PACKAGE,
          ".factory/config": JSON.stringify({ verify: "true" }),
        });
        const created = yield* sessions.create({ repo, title: "no setup" });
        yield* sessions.send({ sessionId: created.id, content: "go" });
        const snapshot = yield* settled(created.id);
        return { snapshot, logged: yield* readSetup(created.id) };
      }),
    );
    expect(outcome.logged.setup).toBeUndefined();
    const probe = outcome.snapshot.entries.find(
      (entry) => entry.kind === "toolResult" && entry.toolName === "bash",
    );
    expect(probe?.text).toContain("deps-missing");
  }, 180_000);
});

describe("a registered repo's readiness score", () => {
  it("is answered on registration and on every read, from the checkout as it is now", async () => {
    const outcome = await runtime.runPromise(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const { repo, localPath, registered } = yield* registerFixture(
          "readiness",
          {
            "AGENTS.md": "# agents\n",
            "package.json": JSON.stringify({
              name: "r",
              scripts: { test: "true" },
            }),
          },
        );
        const listed = (yield* sessions.listRepos).repos.find(
          (row) => row.repo === repo,
        );
        // A verify skill added since registration counts on the next read.
        mkdirSync(join(localPath, ".pi", "skills", "verify-api"), {
          recursive: true,
        });
        writeFileSync(
          join(localPath, ".pi", "skills", "verify-api", "SKILL.md"),
          "# verify\n",
        );
        const rescored = yield* sessions.getRepo({ repo });
        // A checkout that is gone is no longer scored.
        rmSync(localPath, { recursive: true, force: true });
        const gone = yield* sessions.getRepo({ repo });
        // A repo with no checkout at all is not scored either.
        yield* sessions.create({ repo: slug("unregistered"), title: "auto" });
        const auto = yield* sessions.getRepo({ repo: slug("unregistered") });
        return { registered, listed, rescored, gone, auto };
      }),
    );

    expect(outcome.registered.readiness).toEqual({
      score: 1,
      max: 4,
      checks: [
        expect.objectContaining({ name: "agents-md", passed: true }),
        expect.objectContaining({
          name: "package-scripts",
          passed: false,
          reason: "package.json missing scripts: build",
        }),
        expect.objectContaining({ name: "verify-skills", passed: false }),
        expect.objectContaining({ name: "skill-dir", passed: false }),
      ],
    });
    expect(outcome.listed?.readiness).toEqual(outcome.registered.readiness);
    expect(outcome.rescored.readiness?.score).toBe(3);
    expect(outcome.gone.readiness).toBeUndefined();
    expect(outcome.auto.readiness).toBeUndefined();
  }, 120_000);
});
