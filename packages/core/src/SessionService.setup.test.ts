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
import { Effect, Exit, Layer, ManagedRuntime } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { afterAll, describe, expect, it } from "vitest";
import { SessionService, SessionServiceLive } from "./SessionService";
import { TaskService, TaskServiceLive } from "./TaskService";

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

afterAll(async () => {
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
        // The next message is still the first: the setup runs again, and the card keeps its block.
        const again = yield* Effect.exit(
          sessions.send({ sessionId: run.id, content: "try again" }),
        );
        const stillParked = yield* tasks.get(card.id);
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

    // Retried: it ran again and failed again, and the block it first parked on is the one standing.
    expect(failure(outcome.again)?.code).toBe("setup_failed");
    expect(readFileSync(attempts, "utf8")).toBe("attempt\nattempt\n");
    expect(outcome.stillParked.blocked).toEqual(outcome.parked.blocked);
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
