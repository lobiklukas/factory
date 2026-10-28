/**
 * A repository's policy, through the real service (S-factory-config-as-code): a repo whose
 * `.factory/config` at the base gates `bun publish` gets an approval prompt for it, and a repo
 * without that config does not; an agent that rewrites `.factory/config` in its worktree, or a base
 * that moves under a session, does not change the policy of that session's run; and a config that
 * tries to allow something the deployment denies is refused at load with `policy_rejected`. What the
 * run met is the log's `factory.policy` record.
 *
 * The fixtures are local git repos with no remote, each holding `bin/bun`, a script that only echoes
 * a marker — so the faux run's `./bin/bun publish` reads as `bun publish` to the gate and, where it
 * is not gated, runs the fixture's script and nothing else. The model is pi-ai's faux provider,
 * calling that command on every turn.
 *
 * Postgres only, not mocked: `docker compose up -d --wait postgres`.
 */
import { BunServices } from "@effect/platform-bun";
import { execSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  RepoSlug,
  type SessionId,
  type SessionSnapshot,
} from "@repo/domain/Session";
import { createFauxModelAccess, readPolicyRecord } from "@repo/harness";
import { DatabaseLive, PostgresStorage } from "@repo/storage-postgres";
import { Effect, Layer, ManagedRuntime } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { afterAll, describe, expect, it } from "vitest";
import { SessionService, SessionServiceLive } from "./SessionService";

/** A run of this file's, so two runs on one database never share a slug. */
const RUN = randomBytes(4).toString("hex");
const scratch = mkdtempSync(join(tmpdir(), "factory-core-repo-policy-"));

const MARKER = `fake-bun-publish-ran-${RUN}`;
const COMMAND = "./bin/bun publish";
const BUN_SHIM = `#!/bin/sh\necho ${MARKER}\n`;

const faux = createFauxModelAccess({
  fauxCommand: COMMAND,
  fauxEveryTurn: true,
});

const runtime = ManagedRuntime.make(
  SessionServiceLive({
    model: faux.access,
    sessionRoot: join(scratch, "sessions"),
  }).pipe(Layer.provideMerge(Layer.mergeAll(DatabaseLive, BunServices.layer))),
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

const git = (root: string, command: string) =>
  execSync(command, { cwd: root, stdio: "ignore" });

const write = (root: string, files: Record<string, string>) => {
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), content);
  }
};

const GATED = JSON.stringify({ policy: { approvalRequired: ["bun publish"] } });

/** A checkout with `files` and the `bin/bun` shim committed on `main`, and no remote. */
const register = (name: string, files: Record<string, string>) =>
  Effect.gen(function* () {
    const sessions = yield* SessionService;
    const root = join(scratch, "repos", name);
    mkdirSync(root, { recursive: true });
    git(root, "git init -q -b main");
    git(root, "git config user.email policy@localhost");
    git(root, "git config user.name policy");
    write(root, { ...files, "bin/bun": BUN_SHIM });
    chmodSync(join(root, "bin/bun"), 0o755);
    git(root, "git add -A");
    git(root, "git commit -q -m base");
    const repo = RepoSlug.make(`repo-policy-${RUN}/${name}`);
    yield* sessions.registerRepo({
      repo,
      url: `https://example.invalid/${name}.git`,
      defaultBaseRef: "main",
      localPath: root,
    });
    return { repo, localPath: root };
  });

const bashResults = (snapshot: SessionSnapshot) =>
  snapshot.entries.filter(
    (entry) => entry.kind === "toolResult" && entry.toolName === "bash",
  );

/** Send, and wait for the turn to settle with one more `bash` result than before. */
const turn = (sessionId: SessionId) =>
  Effect.gen(function* () {
    const sessions = yield* SessionService;
    const before = bashResults(yield* sessions.get(sessionId)).length;
    yield* sessions.send({ sessionId, content: "publish" });
    yield* waitUntil(
      Effect.map(
        sessions.get(sessionId),
        (snapshot) =>
          !snapshot.live.busy && bashResults(snapshot).length > before,
      ),
      "the turn to settle",
    );
    return yield* sessions.get(sessionId);
  });

/** The policy record the log holds, read without owning it. */
const recorded = (sessionId: SessionId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    return yield* Effect.acquireUseRelease(
      Effect.promise(() => PostgresStorage.reader(sql, sessionId)),
      readPolicyRecord,
      (storage) => Effect.promise(() => storage.dispose()),
    );
  });

describe("a repository's policy from .factory/config at the base", () => {
  /** Mutation: drop `repoPolicy.repo` from `forWorktree` — the gated repo runs `bun publish`. */
  it("asks before `bun publish` in a repo whose config gates it, and not in one without it", async () => {
    const outcome = await runtime.runPromise(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const gated = yield* register("gated", { ".factory/config": GATED });
        const bare = yield* register("bare", { "README.md": "nothing\n" });
        const onGated = yield* sessions.create({ repo: gated.repo });
        const onBare = yield* sessions.create({ repo: bare.repo });
        const gatedTurn = yield* turn(onGated.id);
        const bareTurn = yield* turn(onBare.id);
        return {
          gatedTurn,
          bareTurn,
          gatedApprovals: yield* sessions.listApprovals(onGated.id),
          bareApprovals: yield* sessions.listApprovals(onBare.id),
          gatedRecord: yield* recorded(onGated.id),
          bareRecord: yield* recorded(onBare.id),
          head: execSync("git rev-parse main", {
            cwd: gated.localPath,
            encoding: "utf8",
          }).trim(),
        };
      }),
    );

    // The gated repo: a prompt for `bun publish`, and the shim did not run.
    expect(outcome.gatedApprovals.approvals).toHaveLength(1);
    expect(outcome.gatedApprovals.approvals[0]).toMatchObject({
      action: "bun publish",
      detail: COMMAND,
    });
    const asked = bashResults(outcome.gatedTurn)[0];
    expect(asked?.isError).toBe(true);
    expect(asked?.text).toContain("one has been asked for");
    expect(asked?.text).not.toContain(MARKER);
    // The repo without the config: no prompt, and the shim ran.
    expect(outcome.bareApprovals.approvals).toEqual([]);
    expect(bashResults(outcome.bareTurn)[0]?.text).toContain(MARKER);

    // The log records where the policy came from and what the run met.
    expect(outcome.gatedRecord).toEqual({
      source: {
        ref: "main",
        commit: outcome.head,
        path: ".factory/config",
        found: true,
      },
      repo: {
        approvalRequired: ["bun publish"],
        denied: [],
        allowedHosts: null,
      },
      effective: {
        approvalRequired: ["bun publish"],
        denied: [],
        allowedHosts: ["github.com", "api.github.com", "codeload.github.com"],
        pushRefPrefixes: ["refs/heads/factory/"],
      },
    });
    expect(outcome.bareRecord).toMatchObject({
      source: { found: false },
      repo: { approvalRequired: [], denied: [], allowedHosts: null },
      effective: { approvalRequired: [] },
    });
  }, 120_000);

  /**
   * Mutation: read the policy from the session's worktree (or re-read the base on every open
   * instead of keeping the pinned record) — the relaxed config is read and the shim runs.
   */
  it("keeps the run's policy when the agent rewrites .factory/config in its worktree, or the base moves", async () => {
    const outcome = await runtime.runPromise(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const { repo, localPath } = yield* register("edited", {
          ".factory/config": GATED,
        });
        const created = yield* sessions.create({ repo });
        const first = yield* turn(created.id);
        // What an agent could do with its own tools: rewrite the config in its worktree and commit
        // it on its branch.
        const worktree = (yield* sessions.get(created.id)).workspace.path;
        write(worktree, { ".factory/config": JSON.stringify({}) });
        git(worktree, "git commit -q -am relax");
        // A new owner opens over the same log: the run carries on under the policy it started with.
        yield* sessions.close;
        const second = yield* turn(created.id);
        // The base itself relaxes after the session opened: this session keeps its pinned policy,
        // and a new session on the repo reads the base as it is now.
        write(localPath, { ".factory/config": JSON.stringify({}) });
        git(localPath, "git commit -q -am relaxed-on-main");
        yield* sessions.close;
        const third = yield* turn(created.id);
        const fresh = yield* sessions.create({ repo });
        const freshTurn = yield* turn(fresh.id);
        return {
          first,
          second,
          third,
          freshTurn,
          approvals: yield* sessions.listApprovals(created.id),
          record: yield* recorded(created.id),
          freshApprovals: yield* sessions.listApprovals(fresh.id),
          freshRecord: yield* recorded(fresh.id),
        };
      }),
    );

    // Every turn of the session met the gate; the shim never ran in it.
    for (const snapshot of [outcome.first, outcome.second, outcome.third]) {
      const results = bashResults(snapshot);
      expect(results.at(-1)?.isError).toBe(true);
      expect(results.map((result) => result.text).join("\n")).not.toContain(
        MARKER,
      );
    }
    expect(outcome.approvals.approvals).toHaveLength(1);
    expect(outcome.approvals.approvals[0]?.action).toBe("bun publish");
    expect(outcome.record?.repo.approvalRequired).toEqual(["bun publish"]);
    expect(outcome.record?.effective.approvalRequired).toEqual(["bun publish"]);
    // The next session reads the base as it is now.
    expect(outcome.freshApprovals.approvals).toEqual([]);
    expect(bashResults(outcome.freshTurn)[0]?.text).toContain(MARKER);
    expect(outcome.freshRecord?.repo.approvalRequired).toEqual([]);
  }, 180_000);

  /** Mutation: skip `repoPolicyWidening` in `readRepoPolicy` — the session opens and reaches it. */
  it("refuses a session on a repo whose config allows a host the deployment denies", async () => {
    const outcome = await runtime.runPromise(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const sql = yield* SqlClient;
        const { repo } = yield* register("widening", {
          ".factory/config": JSON.stringify({
            policy: { allowedHosts: ["github.com", "evil.example"] },
          }),
        });
        const refused = yield* Effect.flip(sessions.create({ repo }));
        const rows = yield* sql<{ count: number }>`
          SELECT count(*)::int AS count FROM sessions WHERE repo = ${repo}
        `;
        return { refused, rows: rows[0]?.count };
      }),
    );

    expect(outcome.refused).toMatchObject({
      _tag: "SessionError",
      code: "policy_rejected",
    });
    expect(outcome.refused.message).toContain(
      "allowedHosts names evil.example, which this deployment does not allow",
    );
    expect(outcome.refused.message).toContain(".factory/config at main");
    // A refused create leaves no session behind.
    expect(outcome.rows).toBe(0);
  }, 120_000);

  /** Mutation: drop `decideDenied` — the denied command runs the shim. */
  it("refuses a command the repo's config denies, without asking", async () => {
    const outcome = await runtime.runPromise(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const { repo } = yield* register("denying", {
          ".factory/config": JSON.stringify({
            policy: { deny: ["bun publish"] },
          }),
        });
        const created = yield* sessions.create({ repo });
        const answered = yield* turn(created.id);
        return {
          answered,
          approvals: yield* sessions.listApprovals(created.id),
          record: yield* recorded(created.id),
        };
      }),
    );

    const refused = bashResults(outcome.answered)[0];
    expect(refused?.isError).toBe(true);
    expect(refused?.text).toContain("bun publish is refused");
    expect(refused?.text).not.toContain(MARKER);
    expect(outcome.approvals.approvals).toEqual([]);
    expect(outcome.record?.effective.denied).toEqual(["bun publish"]);
  }, 120_000);
});
