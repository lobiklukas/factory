/**
 * The PR step publishes the session's branch before it names it, and the session's worktree is cut
 * from the remote's base (C17).
 *
 * Driven through `SessionService` with the deployment's own remote (`gitRepoRemote`) against a forge
 * that is real git and nothing else: bare repositories served over smart HTTP by `git http-backend`
 * on a loopback port, refusing any request without the token (`git-remote.test-fake.ts`). The
 * credential provider counts what it is asked, so "the push used the provider's token" is a count
 * and a credential the remote saw, not an inference. GitHub's PR endpoint is an `HttpClient` fake
 * that reads the remote *at the moment it is called*, which is what proves the order: a step that
 * opened first and pushed after would show GitHub a head the remote did not have.
 *
 * Postgres only, not mocked: `docker compose up -d --wait postgres`.
 */
import { BunServices } from "@effect/platform-bun";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PullRequestStep } from "@repo/domain/PullRequest";
import { RepoSlug } from "@repo/domain/Session";
import { createFauxModelAccess } from "@repo/harness";
import { DatabaseLive } from "@repo/storage-postgres";
import { Effect, Layer, ManagedRuntime, Redacted, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CredentialProvider } from "./credentials";
import { startGitRemote } from "./git-remote.test-fake";
import { gitRepoRemote } from "./RepoRemote";
import { SessionService, SessionServiceLive } from "./SessionService";

const TOKEN = `ghs_${randomBytes(18).toString("hex")}`;

// Hermetic, as `git.test.ts` is: no developer's `url.insteadOf`, signing or credential helper.
// oxlint-disable-next-line effecttsgo/process-env -- a test harness sets up its own process.
process.env["GIT_CONFIG_NOSYSTEM"] = "1";
// oxlint-disable-next-line effecttsgo/process-env -- as above.
process.env["GIT_CONFIG_GLOBAL"] = "/dev/null";

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

/** The sha `ref` names in `repo`, or `undefined` when it names nothing. */
const shaOf = (repo: string, ref: string): string | undefined => {
  try {
    return git(repo, "rev-parse", "--verify", "--quiet", ref);
  } catch {
    return undefined;
  }
};

const commitFile = (cwd: string, file: string, text: string): string => {
  writeFileSync(join(cwd, file), text);
  git(cwd, "add", file);
  git(cwd, "commit", "-m", `write ${file}`);
  return git(cwd, "rev-parse", "HEAD");
};

const root = mkdtempSync(join(tmpdir(), "factory-pr-push-"));
let remote: Awaited<ReturnType<typeof startGitRemote>>;

/** Every repo slug the provider was asked a token for, in order: the push's and the PR's alike. */
const asked: Array<string> = [];
const countingProvider = CredentialProvider.of({
  source: "static-token",
  tokenFor: (repo) =>
    Effect.sync(() => {
      asked.push(repo);
      return Redacted.make(TOKEN);
    }),
});

/** What GitHub was asked, and what the forge held for the head at that moment. */
type Opened = {
  readonly head: string;
  readonly base: string;
  readonly body: string;
  readonly headOnRemote: string | undefined;
};
const opened: Array<Opened> = [];
/** Where the fake looks for the head a create names: the bare repository of the case's repo. */
const bareOf = (repo: string): string => join(root, "forge", `${repo}.git`);

const Json = Schema.fromJsonString(Schema.Unknown);
const GitHubFake = Layer.mergeAll(
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request, url) =>
      Effect.gen(function* () {
        const sent =
          request.body._tag === "Uint8Array"
            ? yield* Schema.decodeEffect(Json)(
                new TextDecoder().decode(request.body.body),
              )
            : undefined;
        const fields = (sent ?? {}) as Record<string, string>;
        const repo = url.pathname
          .replace(/^\/repos\//, "")
          .replace(/\/pulls$/, "");
        const number = opened.length + 1;
        opened.push({
          head: fields["head"] ?? "",
          base: fields["base"] ?? "",
          body: fields["body"] ?? "",
          headOnRemote: shaOf(bareOf(repo), `refs/heads/${fields["head"]}`),
        });
        const text = yield* Schema.encodeEffect(Json)({
          number,
          html_url: `https://github.com/${repo}/pull/${number}`,
        }).pipe(Effect.orDie);
        return HttpClientResponse.fromWeb(
          request,
          new Response(text, {
            status: 201,
            headers: { "content-type": "application/json" },
          }),
        );
      }).pipe(Effect.orDie),
    ),
  ),
  Layer.succeed(CredentialProvider, countingProvider),
);

const runtime = ManagedRuntime.make(
  Layer.unwrap(
    Effect.gen(function* () {
      const repoRemote = yield* gitRepoRemote.pipe(
        Effect.provideService(CredentialProvider, countingProvider),
      );
      return SessionServiceLive({
        model: createFauxModelAccess().access,
        sessionRoot: join(root, "sessions"),
        repoRemote,
      });
    }),
  ).pipe(Layer.provideMerge(Layer.mergeAll(DatabaseLive, BunServices.layer))),
);

const run = <A, E>(effect: Effect.Effect<A, E, SessionService>) =>
  runtime.runPromise(effect);

/**
 * A repo on the forge: its bare repository (pushable, `HEAD` on `defaultBranch`), an upstream clone
 * that moves it, and the operator's checkout the factory is registered over. The checkout's own
 * `origin` is a path, so nothing the checkout's config says can be what the factory reached.
 */
const makeRepo = (defaultBranch = "main") => {
  const repo = RepoSlug.make(`c17/push-${randomBytes(4).toString("hex")}`);
  const bare = bareOf(repo);
  mkdirSync(join(root, "forge", "c17"), { recursive: true });
  git(root, "init", "--bare", "-b", defaultBranch, bare);
  git(bare, "config", "http.receivepack", "true");
  const upstream = join(root, `${repo.replace("/", "-")}-upstream`);
  git(root, "clone", "-q", bare, upstream);
  git(upstream, "checkout", "-q", "-b", defaultBranch);
  commitFile(upstream, "README.md", "seed\n");
  git(upstream, "push", "-q", "origin", defaultBranch);
  const checkout = join(root, `${repo.replace("/", "-")}-checkout`);
  git(root, "clone", "-q", bare, checkout);
  return {
    repo,
    bare,
    upstream,
    checkout,
    url: `${remote.url}/${repo}.git`,
  };
};

/** The step's answer when it opened a PR; the case fails naming the answer otherwise. */
const link = (answer: PullRequestStep) => {
  if (answer.outcome === "opened" || answer.outcome === "already-open")
    return answer;
  throw new Error(`the step opened no PR: ${JSON.stringify(answer)}`);
};

beforeAll(async () => {
  remote = await startGitRemote(join(root, "forge"), TOKEN);
});

afterAll(async () => {
  await runtime.dispose();
  remote?.server.close();
  rmSync(root, { recursive: true, force: true });
});

const CASE = { timeout: 60_000 };

describe("the PR step publishes the branch it names", CASE, () => {
  /**
   * Mutation: drop the push from the step (or run it after `createPullRequest`) — GitHub is asked
   * for a head the forge does not hold, and `headOnRemote` is `undefined`.
   * Mutation: push the branch name instead of the measured commit, or from another checkout — the
   * remote's sha is not the worktree's.
   * Mutation: resolve the push's token anywhere but the provider — the provider is asked once (the
   * PR's), and the remote refuses the push.
   */
  it("pushes factory/<id> with the provider's token, then opens the PR, and the remote holds the sha it names", async () => {
    const fixture = makeRepo();
    const result = await run(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        yield* sessions.registerRepo({
          repo: fixture.repo,
          url: fixture.url,
          localPath: fixture.checkout,
        });
        const created = yield* sessions.create({
          repo: fixture.repo,
          title: "publish the branch",
        });
        const worktree = (yield* sessions.get(created.id)).workspace.path;
        const tip = commitFile(worktree, "CHANGE.md", "the run's change\n");
        const before = asked.length;
        const seenBefore = remote.seen.length;
        const answer = yield* sessions
          .openPullRequest({
            sessionId: created.id,
            title: "factory: publish the branch",
          })
          .pipe(Effect.provide(GitHubFake));
        return {
          id: created.id,
          tip,
          answer,
          askedDuring: asked.slice(before),
          seenDuring: remote.seen.slice(seenBefore),
        };
      }),
    );
    const head = `factory/${result.id}`;
    expect(link(result.answer).outcome).toBe("opened");
    const call = opened.find((entry) => entry.head === head);
    expect(call).toMatchObject({
      head,
      base: "main",
      headOnRemote: result.tip,
    });
    expect(shaOf(fixture.bare, `refs/heads/${head}`)).toBe(result.tip);
    // One token for the push, one for the PR: both from the provider, both for this repo.
    expect(result.askedDuring).toEqual([fixture.repo, fixture.repo]);
    expect(result.seenDuring.length).toBeGreaterThan(0);
    expect(
      result.seenDuring.every(
        (seen) => seen.user === "x-access-token" && seen.password === TOKEN,
      ),
    ).toBe(true);
  });

  /**
   * Mutation: force the push, or ignore the porcelain `!` — the remote's commit is overwritten and a
   * PR opened over it.
   * Mutation: answer a rejected push as a `PrError` — the case fails on the error, not the value.
   */
  it("answers non-fast-forward, opening and recording nothing, when the remote branch moved past it", async () => {
    const fixture = makeRepo();
    const result = await run(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        yield* sessions.registerRepo({
          repo: fixture.repo,
          url: fixture.url,
          localPath: fixture.checkout,
        });
        const created = yield* sessions.create({
          repo: fixture.repo,
          title: "a branch someone else pushed to",
        });
        const worktree = (yield* sessions.get(created.id)).workspace.path;
        commitFile(worktree, "MINE.md", "the run's change\n");
        // Someone else's commit on the session's branch, on the forge only.
        git(fixture.upstream, "checkout", "-q", "-b", `factory/${created.id}`);
        const theirs = commitFile(fixture.upstream, "THEIRS.md", "not ours\n");
        git(fixture.upstream, "push", "-q", "origin", `factory/${created.id}`);
        const calls = opened.length;
        const answer = yield* sessions
          .openPullRequest({
            sessionId: created.id,
            title: "factory: rejected",
          })
          .pipe(Effect.provide(GitHubFake));
        const after = yield* sessions.get(created.id);
        return {
          id: created.id,
          theirs,
          answer,
          calls: opened.length - calls,
          prUrl: after.session.prUrl,
        };
      }),
    );
    expect(result.answer).toEqual({
      outcome: "non-fast-forward",
      head: `factory/${result.id}`,
    });
    expect(result.calls).toBe(0);
    expect(result.prUrl).toBeUndefined();
    expect(shaOf(fixture.bare, `refs/heads/factory/${result.id}`)).toBe(
      result.theirs,
    );
  });

  /**
   * Mutation: push for every registered repo whatever its URL — the URL-less repo's push is refused
   * or reaches the forge, and the step fails or the remote is asked.
   */
  it("pushes nothing for a repo registered with no forge URL, and opens the PR as before", async () => {
    const fixture = makeRepo();
    const requests = remote.requests.count;
    const result = await run(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        yield* sessions.registerRepo({
          repo: fixture.repo,
          localPath: fixture.checkout,
        });
        const created = yield* sessions.create({
          repo: fixture.repo,
          title: "no forge URL",
        });
        const worktree = (yield* sessions.get(created.id)).workspace.path;
        commitFile(worktree, "CHANGE.md", "x\n");
        const answer = yield* sessions
          .openPullRequest({ sessionId: created.id, title: "factory: no url" })
          .pipe(Effect.provide(GitHubFake));
        return { id: created.id, answer };
      }),
    );
    expect(link(result.answer).outcome).toBe("opened");
    expect(remote.requests.count).toBe(requests);
    expect(
      shaOf(fixture.bare, `refs/heads/factory/${result.id}`),
    ).toBeUndefined();
  });
});

describe("the worktree is cut from the remote's base", CASE, () => {
  /**
   * Mutation: drop the fetch before the cut — the worktree starts at the checkout's stale `main`.
   * Mutation: fetch into `refs/heads/main` of the operator's checkout — its local branch moves.
   * Mutation: measure the PR against the local `main` — the upstream file is counted as the run's.
   */
  it("fetches a base that moved on the remote before cutting, and measures the PR against it", async () => {
    const fixture = makeRepo();
    const stale = git(fixture.checkout, "rev-parse", "HEAD");
    const result = await run(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        yield* sessions.registerRepo({
          repo: fixture.repo,
          url: fixture.url,
          localPath: fixture.checkout,
        });
        // The remote's base moves on after the checkout was cloned.
        const moved = commitFile(fixture.upstream, "UPSTREAM.md", "moved\n");
        git(fixture.upstream, "push", "-q", "origin", "main");
        const created = yield* sessions.create({
          repo: fixture.repo,
          title: "cut from the remote's base",
        });
        const worktree = (yield* sessions.get(created.id)).workspace.path;
        const cutAt = git(worktree, "rev-parse", "HEAD");
        commitFile(worktree, "CHANGE.md", "the run's change\n");
        yield* sessions
          .openPullRequest({ sessionId: created.id, title: "factory: fresh" })
          .pipe(Effect.provide(GitHubFake));
        return { id: created.id, moved, cutAt };
      }),
    );
    expect(result.moved).not.toBe(stale);
    expect(result.cutAt).toBe(result.moved);
    expect(shaOf(fixture.checkout, "refs/remotes/factory/main")).toBe(
      result.moved,
    );
    // The operator's own branch is theirs: the fetch did not move it.
    expect(shaOf(fixture.checkout, "refs/heads/main")).toBe(stale);
    const body =
      opened.find((entry) => entry.head === `factory/${result.id}`)?.body ?? "";
    expect(body).toContain("CHANGE.md");
    expect(body).not.toContain("UPSTREAM.md");
  });

  /**
   * Mutation: fail the create on a fetch that failed — the session is refused for a forge that is
   * down. Mutation: cut at the tracking ref the failed fetch never wrote — the cut fails.
   */
  it("cuts from the checkout's local base when the fetch fails", async () => {
    const fixture = makeRepo();
    const local = git(fixture.checkout, "rev-parse", "HEAD");
    // The URL names the repo, but the forge holds no such repository.
    rmSync(fixture.bare, { recursive: true, force: true });
    const cutAt = await run(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        yield* sessions.registerRepo({
          repo: fixture.repo,
          url: fixture.url,
          localPath: fixture.checkout,
          defaultBaseRef: "main",
        });
        const created = yield* sessions.create({
          repo: fixture.repo,
          title: "a forge that cannot answer",
        });
        const worktree = (yield* sessions.get(created.id)).workspace.path;
        return git(worktree, "rev-parse", "HEAD");
      }),
    );
    expect(cutAt).toBe(local);
  });
});

describe("a repo whose default branch is not main", CASE, () => {
  /**
   * Mutation: default the registration to `main` — the create cuts at a branch the repo does not
   * have and fails, or the PR targets `main`.
   */
  it("starts its sessions from the forge's default without a base ref, and opens the PR onto it", async () => {
    const fixture = makeRepo("trunk");
    const result = await run(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const registered = yield* sessions.registerRepo({
          repo: fixture.repo,
          url: fixture.url,
          localPath: fixture.checkout,
        });
        const created = yield* sessions.create({
          repo: fixture.repo,
          title: "on trunk",
        });
        const snapshot = yield* sessions.get(created.id);
        const cutAt = git(snapshot.workspace.path, "rev-parse", "HEAD");
        commitFile(snapshot.workspace.path, "CHANGE.md", "x\n");
        const answer = yield* sessions
          .openPullRequest({ sessionId: created.id, title: "factory: trunk" })
          .pipe(Effect.provide(GitHubFake));
        return {
          id: created.id,
          registered: registered.defaultBaseRef,
          baseRef: snapshot.workspace.baseRef,
          cutAt,
          answer,
        };
      }),
    );
    expect(result.registered).toBe("trunk");
    expect(result.baseRef).toBe("trunk");
    expect(result.cutAt).toBe(git(fixture.bare, "rev-parse", "trunk"));
    expect(link(result.answer).outcome).toBe("opened");
    expect(
      opened.find((entry) => entry.head === `factory/${result.id}`)?.base,
    ).toBe("trunk");
  });

  /**
   * Mutation: read the default only from the forge — a checkout registered with no URL records
   * `main`, which it does not have.
   */
  it("reads the default from the checkout when there is no forge URL to ask", async () => {
    const checkout = join(root, `trunk-only-${randomBytes(4).toString("hex")}`);
    mkdirSync(checkout);
    git(checkout, "init", "-q", "-b", "trunk");
    commitFile(checkout, "README.md", "seed\n");
    const repo = RepoSlug.make(`c17/local-${randomBytes(4).toString("hex")}`);
    const result = await run(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const registered = yield* sessions.registerRepo({
          repo,
          localPath: checkout,
        });
        const created = yield* sessions.create({ repo, title: "local trunk" });
        const snapshot = yield* sessions.get(created.id);
        return {
          registered: registered.defaultBaseRef,
          baseRef: snapshot.workspace.baseRef,
          cutAt: git(snapshot.workspace.path, "rev-parse", "HEAD"),
        };
      }),
    );
    expect(result).toEqual({
      registered: "trunk",
      baseRef: "trunk",
      cutAt: git(checkout, "rev-parse", "trunk"),
    });
  });

  /** Mutation: let a later registration re-detect — an operator's explicit base ref is replaced. */
  it("keeps a base ref the operator chose over what the forge says", async () => {
    const fixture = makeRepo("trunk");
    git(fixture.upstream, "push", "-q", "origin", "trunk:release");
    const bases = await run(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const first = yield* sessions.registerRepo({
          repo: fixture.repo,
          url: fixture.url,
          localPath: fixture.checkout,
          defaultBaseRef: "release",
        });
        const again = yield* sessions.registerRepo({
          repo: fixture.repo,
          url: fixture.url,
        });
        return [first.defaultBaseRef, again.defaultBaseRef];
      }),
    );
    expect(bases).toEqual(["release", "release"]);
  });
});
