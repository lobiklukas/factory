/**
 * Scoped secrets through the session service (S-agent-secrets): a repo's declared `verify` gets its
 * stored secret and passes, the value is in no row the session wrote and the agent's own `env` does
 * not hold it; and a branch whose commits add a stored value is refused before the push, with a
 * named refusal on its card and nothing on the forge.
 *
 * Real Postgres, real git worktrees, a real forge for the push (`git http-backend` behind a token,
 * `git-remote.test-fake.ts`), and a fake GitHub `HttpClient` that records what it is asked. The model
 * is faux: its `bash` call reports how many non-empty `TEST_API_KEY` variables its shell holds,
 * commits a change — and, in a repo whose base carries a `leak-source`, a copy of it — and its next
 * turn calls `verify`. Every secret value here is obviously fake.
 *
 * Postgres only, not mocked: `docker compose up -d --wait postgres`.
 */
import { BunServices } from "@effect/platform-bun";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { RepoSlug, type SessionId } from "@repo/domain/Session";
import {
  BoardInstanceId,
  DEFAULT_DEFINITION_ID,
  DefinitionId,
} from "@repo/domain/Task";
import { createFauxModelAccess, readVerifyRecords } from "@repo/harness";
import { DatabaseLive, PostgresStorage } from "@repo/storage-postgres";
import {
  Context,
  Effect,
  Layer,
  ManagedRuntime,
  Redacted,
  Schema,
} from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { SqlClient } from "effect/sql/SqlClient";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CredentialProvider } from "./credentials";
import { startGitRemote, type GitRemoteRequest } from "./git-remote.test-fake";
import type { SettleDecision } from "./prOnSettle";
import { gitRepoRemote } from "./RepoRemote";
import { makeSecretService, SecretService } from "./SecretService";
import { SessionService, SessionServiceLive } from "./SessionService";
import { TaskService, TaskServiceLive } from "./TaskService";

// Hermetic, as `prStep.test.ts` is: no developer's `url.insteadOf`, signing or credential helper.
// oxlint-disable-next-line effecttsgo/process-env -- a test harness sets up its own process.
process.env["GIT_CONFIG_NOSYSTEM"] = "1";
// oxlint-disable-next-line effecttsgo/process-env -- as above.
process.env["GIT_CONFIG_GLOBAL"] = "/dev/null";

const runId = randomBytes(4).toString("hex");
/** Obviously fake, and unique to this run so no other suite's rows can hold it. */
const FAKE_KEY = `fake-secrets-test-key-${runId}`;
const DIGEST = createHash("sha256").update(FAKE_KEY).digest("hex");
const TOKEN = `fake-forge-token-${randomBytes(8).toString("hex")}`;
const STORE_KEY = randomBytes(32);

const root = mkdtempSync(join(tmpdir(), "factory-secrets-"));

const git = (cwd: string, ...args: ReadonlyArray<string>): string =>
  execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t.com",
    },
  }).trim();

const shaOf = (repo: string, ref: string): string | undefined => {
  try {
    return git(repo, "rev-parse", "--verify", "--quiet", ref);
  } catch {
    return undefined;
  }
};

let remote: Awaited<ReturnType<typeof startGitRemote>>;
const remoteRequests: Array<GitRemoteRequest> = [];
const bareOf = (repo: string): string => join(root, "forge", `${repo}.git`);

/**
 * A repo on the forge with `files` committed on `main`: its bare repository, and the operator's
 * checkout the factory is registered over.
 */
const makeRepo = (kind: string, files: Record<string, string>) => {
  const repo = RepoSlug.make(`secrets-${runId}/${kind}`);
  const bare = bareOf(repo);
  mkdirSync(dirname(bare), { recursive: true });
  git(root, "init", "-q", "--bare", "-b", "main", bare);
  git(bare, "config", "http.receivepack", "true");
  const upstream = join(root, `${kind}-upstream`);
  git(root, "clone", "-q", bare, upstream);
  git(upstream, "checkout", "-q", "-b", "main");
  for (const [file, text] of Object.entries({
    "README.md": "seed\n",
    ...files,
  })) {
    mkdirSync(dirname(join(upstream, file)), { recursive: true });
    writeFileSync(join(upstream, file), text);
  }
  git(upstream, "add", "-A");
  git(upstream, "commit", "-q", "-m", "base");
  git(upstream, "push", "-q", "origin", "main");
  const checkout = join(root, `${kind}-checkout`);
  git(root, "clone", "-q", bare, checkout);
  // The run commits in a worktree of this checkout, which shares its config.
  git(checkout, "config", "user.email", "secrets@localhost");
  git(checkout, "config", "user.name", "secrets");
  return { repo, bare, checkout, url: `${remote.url}/${repo}.git` };
};

/** What GitHub was asked to create. */
const created: Array<string> = [];
const Json = Schema.fromJsonString(Schema.Unknown);
const fakeGitHub = HttpClient.make((request, url) =>
  Effect.gen(function* () {
    created.push(url.pathname);
    const text = yield* Schema.encodeEffect(Json)({
      number: created.length,
      html_url: `https://github.com${url.pathname}/${created.length}`,
    }).pipe(Effect.orDie);
    return HttpClientResponse.fromWeb(
      request,
      new Response(text, {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
    );
  }),
);
const provider = CredentialProvider.of({
  source: "static-token",
  tokenFor: () => Effect.succeed(Redacted.make(TOKEN)),
});
const forge = Context.make(HttpClient.HttpClient, fakeGitHub).pipe(
  Context.add(CredentialProvider, provider),
);

const decisions: Array<{
  readonly sessionId: SessionId;
  readonly decision: SettleDecision;
}> = [];

/**
 * The run's one command: how many non-empty `TEST_API_KEY` its own shell holds, then a committed
 * change, with a copy of the base's `leak-source` when there is one.
 */
const COMMAND = [
  "echo \"agent-env-key-count:$(env | grep -c '^TEST_API_KEY=.')\"",
  "mkdir -p src && echo change > src/change.txt",
  "if [ -f leak-source ]; then cp leak-source leaked.txt; fi",
  "git add -A && git commit -qm change",
  "echo faux-ok",
].join("; ");

/** The repo's declared verify: passes only when the value it is given is the stored one. */
const VERIFY = `test "$(printf %s "$TEST_API_KEY" | shasum -a 256 | cut -c1-64)" = "${DIGEST}" && echo "verify got $TEST_API_KEY"`;

const SecretsLive = Layer.effect(
  SecretService,
  Effect.map(makeSecretService(STORE_KEY), SecretService.of),
);

let runtime: ManagedRuntime.ManagedRuntime<
  SessionService | TaskService | SecretService | SqlClient,
  unknown
>;

/** Every repo a case registered: its rows leave with the suite. */
const slugs: Array<RepoSlug> = [];

beforeAll(async () => {
  remote = await startGitRemote(join(root, "forge"), TOKEN, {
    onRequest: (request) => remoteRequests.push(request),
  });
  runtime = ManagedRuntime.make(
    Layer.mergeAll(
      Layer.unwrap(
        Effect.gen(function* () {
          const repoRemote = yield* gitRepoRemote.pipe(
            Effect.provideService(CredentialProvider, provider),
          );
          return SessionServiceLive({
            model: createFauxModelAccess({
              fauxCommand: COMMAND,
              fauxVerify: true,
            }).access,
            sessionRoot: join(root, "sessions"),
            repoRemote,
            pullRequestOnSettle: forge,
            onPullRequestSettled: (sessionId, decision) =>
              Effect.sync(() => {
                decisions.push({ sessionId, decision });
              }),
          });
        }),
      ),
      TaskServiceLive,
    ).pipe(
      Layer.provideMerge(SecretsLive),
      Layer.provideMerge(Layer.mergeAll(DatabaseLive, BunServices.layer)),
    ),
  );
});

afterAll(async () => {
  await runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      for (const repo of slugs) {
        yield* sql`DELETE FROM task_runs WHERE session_id IN (SELECT id FROM sessions WHERE repo = ${repo})`;
        yield* sql`DELETE FROM sessions WHERE repo = ${repo}`;
        yield* sql`DELETE FROM repos WHERE slug = ${repo}`;
      }
    }),
  );
  await runtime.dispose();
  remote?.server.close();
  rmSync(root, { recursive: true, force: true });
});

const waitUntil = <A, E, R>(
  read: Effect.Effect<A, E, R>,
  done: (value: A) => boolean,
  label: string,
): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 600; attempt += 1) {
      const value = yield* read;
      if (done(value)) return value;
      yield* Effect.sleep(50);
    }
    return yield* Effect.die(new Error(`timed out waiting for ${label}`));
  });

/** Register `fixture` with its stored `TEST_API_KEY`. */
const register = (fixture: ReturnType<typeof makeRepo>) =>
  Effect.gen(function* () {
    slugs.push(fixture.repo);
    const sessions = yield* SessionService;
    const secrets = yield* SecretService;
    yield* sessions.registerRepo({
      repo: fixture.repo,
      url: fixture.url,
      localPath: fixture.checkout,
    });
    const summary = yield* secrets.set({
      repo: fixture.repo,
      name: "TEST_API_KEY",
      value: Redacted.make(FAKE_KEY),
    });
    return summary;
  });

/**
 * How many rows the session wrote — its log's commits and checkpoints, and every index row keyed by
 * it — hold `text` anywhere in them.
 */
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
      const rows = yield* sql<{
        readonly total: number;
        readonly hits: number;
      }>`
        SELECT count(*)::int AS total,
          count(*) FILTER (WHERE r::text LIKE ${`%${text}%`})::int AS hits
        FROM ${sql(tableName)} AS r WHERE ${sql(columnName)} = ${sessionId}
      `;
      scanned += rows[0]?.total ?? 0;
      holding += rows[0]?.hits ?? 0;
    }
    return { holding, scanned };
  });

const settledRun = (sessionId: SessionId) =>
  Effect.gen(function* () {
    const sessions = yield* SessionService;
    return yield* waitUntil(
      sessions.get(sessionId),
      (snapshot) =>
        !snapshot.live.busy &&
        snapshot.entries.some((entry) => entry.kind === "assistant"),
      `session ${sessionId}'s run to settle`,
    );
  });

const CASE = { timeout: 120_000 };

describe("a repo's declared secrets in a session", CASE, () => {
  /**
   * Mutation: inject nothing into `verify` — the digest check fails, exit 1.
   * Mutation: inject the secret into the session's shell environment — the agent's count is 1.
   * Mutation: drop the masking — the value is in the commits and the verify record.
   */
  it("passes a verify that needs TEST_API_KEY, while no row holds the value and the agent's env lacks it", async () => {
    const fixture = makeRepo("verify", {
      ".factory/config": JSON.stringify({
        verify: VERIFY,
        secrets: { verify: ["TEST_API_KEY"] },
      }),
    });
    const outcome = await runtime.runPromise(
      Effect.gen(function* () {
        const summary = yield* register(fixture);
        const sessions = yield* SessionService;
        const session = yield* sessions.create({
          repo: fixture.repo,
          title: "verify with the key",
        });
        yield* sessions.send({ sessionId: session.id, content: "verify it" });
        const snapshot = yield* settledRun(session.id);
        const sql = yield* SqlClient;
        const storage = yield* Effect.promise(() =>
          PostgresStorage.reader(sql, session.id),
        );
        const records = yield* readVerifyRecords(storage).pipe(
          Effect.ensuring(Effect.promise(() => storage.dispose())),
        );
        return {
          summary,
          snapshot,
          records,
          rows: yield* rowsHolding(session.id, FAKE_KEY),
        };
      }),
    );
    expect(JSON.stringify(outcome.summary)).not.toContain(FAKE_KEY);
    const [record] = outcome.records;
    if (record?._tag !== "VerifyReport") throw new Error("no verify report");
    const [result] = record.results;
    if (result?._tag !== "VerifyRan") throw new Error("verify did not run");
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("== secrets: TEST_API_KEY");
    expect(result.output).toContain("verify got [secret:TEST_API_KEY]");
    const transcript = JSON.stringify(outcome.snapshot.entries);
    expect(transcript).toContain("agent-env-key-count:0");
    expect(transcript).not.toContain(FAKE_KEY);
    expect(outcome.rows.scanned).toBeGreaterThan(0);
    expect(outcome.rows.holding).toBe(0);
  });

  /**
   * Mutation: drop the scan, or run it after the push — the forge's `factory/<id>` holds the commit.
   * Mutation: scan only the patterns — a stored value with no well-known shape passes.
   * Mutation: name the value in the refusal — the card's note holds it.
   */
  it("refuses a card's branch that adds the stored value before the push, with a named refusal on the card", async () => {
    const fixture = makeRepo("leaky", { "leak-source": `${FAKE_KEY}\n` });
    const outcome = await runtime.runPromise(
      Effect.gen(function* () {
        yield* register(fixture);
        const sessions = yield* SessionService;
        const tasks = yield* TaskService;
        const sql = yield* SqlClient;
        const board = yield* tasks.createBoard({
          repo: fixture.repo,
          definitionId: DefinitionId.make(DEFAULT_DEFINITION_ID),
        });
        const card = yield* tasks.create({
          boardId: BoardInstanceId.make(board.id),
          title: "build on the leaky repo",
          actor: "person:secrets",
        });
        yield* sql`UPDATE tasks SET "column" = 'building' WHERE id = ${card.id}`;
        const session = yield* sessions.create({
          taskId: card.id,
          taskColumn: "building",
        });
        const pushesBefore = remoteRequests.filter(
          (request) => request.service === "git-receive-pack",
        ).length;
        const createdBefore = created.length;
        yield* sessions.send({ sessionId: session.id, content: "build it" });
        const decision = yield* waitUntil(
          Effect.sync(() =>
            decisions
              .filter((entry) => entry.sessionId === session.id)
              .map((entry) => entry.decision),
          ),
          (made) => made.length > 0,
          "the settle's decision",
        );
        const thread = yield* waitUntil(
          tasks.comments(card.id),
          (comments) => comments.length > 0,
          "the refusal on the card",
        );
        // The operator's call meets the same refusal, typed, and pushes nothing either.
        const answer = yield* sessions
          .openPullRequest({ sessionId: session.id, title: "leaky" })
          .pipe(Effect.provideContext(forge));
        return {
          sessionId: session.id,
          decision,
          thread,
          answer,
          pushes:
            remoteRequests.filter(
              (request) => request.service === "git-receive-pack",
            ).length - pushesBefore,
          created: created.length - createdBefore,
        };
      }),
    );
    expect(outcome.decision).toEqual(["secret-found"]);
    const note = outcome.thread.map((comment) => comment.body).join("\n");
    expect(note).toContain("secret_found");
    expect(note).toContain("the stored secret TEST_API_KEY at leaked.txt:1");
    expect(note).not.toContain(FAKE_KEY);
    expect(outcome.answer).toMatchObject({
      outcome: "secret-found",
      count: 1,
      findings: [
        { kind: "stored", name: "TEST_API_KEY", path: "leaked.txt", line: 1 },
      ],
    });
    expect(JSON.stringify(outcome.answer)).not.toContain(FAKE_KEY);
    expect(outcome.pushes).toBe(0);
    expect(outcome.created).toBe(0);
    expect(
      shaOf(fixture.bare, `refs/heads/factory/${outcome.sessionId}`),
    ).toBeUndefined();
  });
});
