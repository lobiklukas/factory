/**
 * Moving a session's refs against a local bare repository, with the credential injected per call
 * (LOB-54, docs/design.md D10/D11/D14).
 *
 * Nothing here is mocked and nothing leaves the machine (docs/testing-third-parties.md, `git`): the
 * remote is a bare repository this file creates, served over git's smart-HTTP protocol by the real
 * `git http-backend` behind an in-process `node:http` listener on an ephemeral loopback port. The
 * listener answers `401` to any request without `x-access-token:<token>` Basic auth, which is what
 * makes the credential load-bearing: over a plain path remote git never asks for one, so a runner
 * that forgot to inject it would still pass. Every request's credential is recorded, so a case can
 * say which token git actually sent.
 *
 * The session's checkout is the one LOB-11 cuts: `resolveWorkspace` makes the linked worktree on
 * `factory/<session-id>` off a registered repo's `local_path`.
 */
import { BunServices } from "@effect/platform-bun";
import {
  Duration,
  Effect,
  Exit,
  FileSystem,
  Option,
  Path,
  Redacted,
  Schema,
} from "effect";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  RepoCloneFailed,
  RepoSlug,
  type SessionId,
} from "@repo/domain/Session";
import { CredentialProvider, staticTokenProvider } from "./credentials";
import {
  fetchBranch,
  GitError,
  isSafeBranchName,
  pushBranch,
  resolveForgeUrl,
} from "./git";
import { mintSessionId } from "./ids";
import { gitRepoMirror } from "./RepoMirror";
import { resolveWorkspace } from "./workspace";

const repo = RepoSlug.make("lobiklukas/factory");
const TOKEN = `ghs_${randomBytes(18).toString("hex")}`;

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

const commitFile = (cwd: string, file: string, text: string): string => {
  writeFileSync(join(cwd, file), text);
  git(cwd, "add", file);
  git(cwd, "commit", "-m", `write ${file}`);
  return git(cwd, "rev-parse", "HEAD");
};

/** Every file under a directory, `.git` included: what "on disk" means for the token check. */
const filesUnder = (root: string): ReadonlyArray<string> =>
  readdirSync(root).flatMap((name) => {
    const full = join(root, name);
    return statSync(full).isDirectory() ? filesUnder(full) : [full];
  });

type Seen = { readonly user: string; readonly password: string };

/**
 * The smart-HTTP remote: `git http-backend` as a CGI behind a Basic-auth gate. `seen` records the
 * credential of every request that carried one; `requests` counts every request at all, so a case
 * can prove a refused call never reached the remote.
 */
const startRemote = async (
  projectRoot: string,
): Promise<{
  readonly server: Server;
  readonly url: string;
  readonly seen: Array<Seen>;
  readonly requests: { count: number };
}> => {
  const seen: Array<Seen> = [];
  const requests = { count: 0 };
  const server = createServer((req, res) => {
    requests.count += 1;
    const header = req.headers.authorization ?? "";
    const decoded = header.startsWith("Basic ")
      ? Buffer.from(header.slice(6), "base64").toString("utf8")
      : undefined;
    if (decoded !== undefined) {
      const at = decoded.indexOf(":");
      seen.push({
        user: decoded.slice(0, at),
        password: decoded.slice(at + 1),
      });
    }
    if (decoded !== `x-access-token:${TOKEN}`) {
      req.resume();
      res.writeHead(401, { "WWW-Authenticate": 'Basic realm="factory-test"' });
      res.end();
      return;
    }
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const cgi = spawn("git", ["http-backend"], {
      env: {
        ...process.env,
        GIT_PROJECT_ROOT: projectRoot,
        GIT_HTTP_EXPORT_ALL: "1",
        PATH_INFO: decodeURIComponent(url.pathname),
        QUERY_STRING: url.search.slice(1),
        REQUEST_METHOD: req.method ?? "GET",
        CONTENT_TYPE: req.headers["content-type"] ?? "",
        REMOTE_USER: "x-access-token",
        REMOTE_ADDR: "127.0.0.1",
        GIT_PROTOCOL: String(req.headers["git-protocol"] ?? ""),
        HTTP_CONTENT_ENCODING: String(req.headers["content-encoding"] ?? ""),
        ...(req.headers["content-length"] === undefined
          ? {}
          : { CONTENT_LENGTH: req.headers["content-length"] }),
      },
      stdio: ["pipe", "pipe", "ignore"],
    });
    req.pipe(cgi.stdin);
    const chunks: Array<Buffer> = [];
    cgi.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    cgi.on("close", () => {
      const out = Buffer.concat(chunks);
      const crlf = out.indexOf("\r\n\r\n");
      const lf = out.indexOf("\n\n");
      const split = crlf !== -1 && (lf === -1 || crlf < lf) ? crlf : lf;
      const sep = split === crlf ? 4 : 2;
      const head = out.subarray(0, split).toString("utf8");
      let status = 200;
      const headers: Record<string, string> = {};
      for (const line of head.split(/\r?\n/)) {
        const colon = line.indexOf(":");
        if (colon === -1) continue;
        const name = line.slice(0, colon).trim();
        const value = line.slice(colon + 1).trim();
        if (name.toLowerCase() === "status")
          status = Number(value.split(" ")[0]);
        else headers[name] = value;
      }
      res.writeHead(status, headers);
      res.end(out.subarray(split + sep));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("the test remote did not bind a TCP port");
  return { server, url: `http://127.0.0.1:${address.port}`, seen, requests };
};

/** A listener that records every request it gets and answers none of them usefully. */
const startDecoy = async (): Promise<{
  readonly server: Server;
  readonly url: string;
  readonly requests: Array<string>;
}> => {
  const requests: Array<string> = [];
  const server = createServer((req, res) => {
    requests.push(
      `${req.method} ${req.url} ${req.headers.authorization ?? ""}`,
    );
    req.resume();
    res.writeHead(401, { "WWW-Authenticate": 'Basic realm="decoy"' });
    res.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("the decoy did not bind a TCP port");
  return { server, url: `http://127.0.0.1:${address.port}`, requests };
};

// Hermetic: the system and global git configuration of whoever runs the suite are not read, by the
// setup commands or by the runner's children (it extends this environment). That keeps a
// developer's `url.insteadOf` or signing setup out of the cases, and it keeps a regression of the
// helper reset from `approve`-ing the test token into a real keychain (`osxkeychain` is Apple Git's
// system default); the repo-level storing helper below is what witnesses that regression instead.
// oxlint-disable-next-line effecttsgo/process-env -- a test harness sets up its own process.
process.env["GIT_CONFIG_NOSYSTEM"] = "1";
// oxlint-disable-next-line effecttsgo/process-env -- as above.
process.env["GIT_CONFIG_GLOBAL"] = "/dev/null";

/** Each case spawns a few dozen git processes; `bun run test` runs every package at once. */
const GIT_CASE = { timeout: 30_000 };

const root = mkdtempSync(join(tmpdir(), "factory-git-"));
// The bare repository sits at `/<repo>.git` under the served root, because the runner sends the
// token only to a URL whose path names the repo it was resolved for.
const bare = join(root, "lobiklukas", "factory.git");
const upstream = join(root, "upstream");
const local = join(root, "local");
const sessionRoot = join(root, "sessions");
const leakedStore = join(root, "leaked-credentials");
let remote: Awaited<ReturnType<typeof startRemote>>;
/** The repo's URL on the test forge: what every call is given as `url`. */
const forgeUrl = (): string => `${remote.url}/lobiklukas/factory.git`;

const withToken = (token: Option.Option<Redacted.Redacted<string>>) =>
  Effect.provideService(
    CredentialProvider,
    CredentialProvider.of(staticTokenProvider(token)),
  );

const runWith = <A, E>(
  effect: Effect.Effect<A, E, CredentialProvider | BunServices.BunServices>,
  token: Option.Option<Redacted.Redacted<string>> = Option.some(
    Redacted.make(TOKEN),
  ),
) =>
  Effect.runPromiseExit(
    effect.pipe(withToken(token), Effect.provide(BunServices.layer)),
  );

const isGitError = Schema.is(GitError);

const gitErrorOf = <A>(exit: Exit.Exit<A, unknown>): GitError | undefined =>
  Exit.isFailure(exit)
    ? exit.cause.reasons.flatMap((r) =>
        r._tag === "Fail" && isGitError(r.error) ? [r.error] : [],
      )[0]
    : undefined;

/** A session: its id and the worktree LOB-11 cut for it on `factory/<id>`. */
const openSession = async (): Promise<{
  readonly id: SessionId;
  readonly branch: string;
  readonly worktree: string;
}> => {
  const workspace = await Effect.runPromise(
    Effect.gen(function* () {
      const id = yield* mintSessionId;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const resolved = yield* resolveWorkspace(
        { sessionRoot, sessionId: id, repo, localPath: local, baseRef: "main" },
        { fs, path },
      );
      return { id, resolved };
    }).pipe(Effect.provide(BunServices.layer)),
  );
  const branch = workspace.resolved.branch ?? "";
  expect(branch).toBe(`factory/${workspace.id}`);
  return { id: workspace.id, branch, worktree: workspace.resolved.path };
};

beforeAll(async () => {
  git(root, "init", "--bare", "-b", "main", bare);
  git(bare, "config", "http.receivepack", "true");
  git(root, "clone", bare, upstream);
  commitFile(upstream, "README.md", "seed\n");
  git(upstream, "push", "origin", "main");
  remote = await startRemote(root);
  // The registered repo: a clone whose `origin` is the authenticated HTTP remote, credential-free.
  git(root, "clone", bare, local);
  git(local, "remote", "set-url", "origin", forgeUrl());
  // A helper that *stores*: if the runner let configured helpers see the token, git would
  // `approve` it into this file after the first successful call.
  git(local, "config", "credential.helper", `store --file=${leakedStore}`);
});

afterAll(() => {
  remote?.server.close();
  // One directory holds the remote, the registered repo and every worktree, so one removal is all.
  rmSync(root, { recursive: true, force: true });
});

describe(
  "fetch, commit, push against a local bare repository",
  GIT_CASE,
  () => {
    it("fetches the advanced base, commits on factory/<session-id>, and pushes it to the remote", async () => {
      const session = await openSession();
      const upstreamTip = commitFile(upstream, "UPSTREAM.md", "moved on\n");
      git(upstream, "push", "origin", "main");
      expect(
        git(session.worktree, "rev-parse", "refs/remotes/origin/main"),
      ).not.toBe(upstreamTip);

      const before = remote.seen.length;
      const fetched = await runWith(
        fetchBranch({
          worktree: session.worktree,
          repo,
          url: forgeUrl(),
          branch: "main",
        }),
      );
      expect(Exit.isSuccess(fetched)).toBe(true);
      if (Exit.isSuccess(fetched)) {
        expect(fetched.value).toEqual({
          ref: "refs/remotes/origin/main",
          sha: upstreamTip,
        });
      }
      expect(
        git(session.worktree, "rev-parse", "refs/remotes/origin/main"),
      ).toBe(upstreamTip);

      git(session.worktree, "merge", "--ff-only", "origin/main");
      const head = commitFile(
        session.worktree,
        "WORK.md",
        "the session's work\n",
      );
      expect(git(session.worktree, "rev-parse", "--abbrev-ref", "HEAD")).toBe(
        session.branch,
      );

      const pushed = await runWith(
        pushBranch({
          worktree: session.worktree,
          repo,
          url: forgeUrl(),
          branch: session.branch,
        }),
      );
      expect(Exit.isSuccess(pushed)).toBe(true);
      if (Exit.isSuccess(pushed)) {
        expect(pushed.value).toEqual({
          ref: `refs/heads/${session.branch}`,
          sha: head,
          outcome: "created",
        });
      }
      expect(git(bare, "rev-parse", `refs/heads/${session.branch}`)).toBe(head);

      // The remote saw the token, as the username GitHub expects: the credential was the one
      // resolved from the provider, not something git found on its own.
      const used = remote.seen.slice(before);
      expect(used.length).toBeGreaterThan(0);
      expect(used.every((s) => s.user === "x-access-token")).toBe(true);
      expect(used.some((s) => s.password === TOKEN)).toBe(true);

      // A second commit fast-forwards the branch.
      const next = commitFile(session.worktree, "WORK.md", "more work\n");
      const again = await runWith(
        pushBranch({
          worktree: session.worktree,
          repo,
          url: forgeUrl(),
          branch: session.branch,
        }),
      );
      expect(Exit.isSuccess(again) ? again.value.outcome : undefined).toBe(
        "updated",
      );
      expect(git(bare, "rev-parse", `refs/heads/${session.branch}`)).toBe(next);
    });

    it("leaves the token in neither .git/config, the stored remote URL, nor any file on disk", async () => {
      const session = await openSession();
      commitFile(session.worktree, "LEAK.md", "a push to inspect after\n");
      const pushed = await runWith(
        pushBranch({
          worktree: session.worktree,
          repo,
          url: forgeUrl(),
          branch: session.branch,
        }),
      );
      expect(Exit.isSuccess(pushed)).toBe(true);

      const commonDir = join(local, ".git");
      const config = readFileSync(join(commonDir, "config"), "utf8");
      expect(config).toContain(forgeUrl());
      expect(config).not.toContain(TOKEN);

      const storedUrl = git(session.worktree, "remote", "get-url", "origin");
      expect(storedUrl).toBe(forgeUrl());
      expect(storedUrl).not.toContain(TOKEN);
      expect(
        git(session.worktree, "config", "--get-all", "remote.origin.url"),
      ).toBe(storedUrl);

      // The configured storing helper was never handed the token.
      expect(existsSync(leakedStore)).toBe(false);

      // Every file of the registered repo (its `.git` included), every session's worktree, and the
      // remote itself: no byte sequence equal to the token anywhere.
      const files = [
        ...filesUnder(local),
        ...filesUnder(sessionRoot),
        ...filesUnder(bare),
      ];
      expect(files.length).toBeGreaterThan(10);
      const tokenBytes = Buffer.from(TOKEN);
      const holding = files.filter((file) =>
        readFileSync(file).includes(tokenBytes),
      );
      expect(holding).toEqual([]);
    });
  },
);

describe("a rejected push", GIT_CASE, () => {
  it("is a typed non-fast-forward error naming the operation and the ref, whether or not the remote's commit was fetched", async () => {
    const session = await openSession();
    const ref = `refs/heads/${session.branch}`;
    commitFile(session.worktree, "MINE.md", "first\n");
    expect(
      Exit.isSuccess(
        await runWith(
          pushBranch({
            worktree: session.worktree,
            repo,
            url: forgeUrl(),
            branch: session.branch,
          }),
        ),
      ),
    ).toBe(true);

    // Someone else moves the remote branch on.
    git(upstream, "fetch", "origin", `${ref}:${ref}`);
    git(upstream, "checkout", "-q", session.branch);
    const theirs = commitFile(upstream, "THEIRS.md", "theirs\n");
    git(upstream, "push", "origin", `${ref}:${ref}`);
    git(upstream, "checkout", "-q", "main");

    // The session diverges without knowing: git says "fetch first".
    commitFile(session.worktree, "MINE.md", "second\n");
    const blind = gitErrorOf(
      await runWith(
        pushBranch({
          worktree: session.worktree,
          repo,
          url: forgeUrl(),
          branch: session.branch,
        }),
      ),
    );
    expect(blind).toMatchObject({
      _tag: "GitError",
      operation: "push",
      repo,
      ref,
      reason: "non-fast-forward",
    });

    // After fetching the remote's branch, git says "non-fast-forward": the same typed answer.
    const fetched = await runWith(
      fetchBranch({
        worktree: session.worktree,
        repo,
        url: forgeUrl(),
        branch: session.branch,
      }),
    );
    expect(Exit.isSuccess(fetched) ? fetched.value.sha : undefined).toBe(
      theirs,
    );
    const informed = gitErrorOf(
      await runWith(
        pushBranch({
          worktree: session.worktree,
          repo,
          url: forgeUrl(),
          branch: session.branch,
        }),
      ),
    );
    expect(informed).toMatchObject({
      operation: "push",
      ref,
      reason: "non-fast-forward",
    });

    // The message names both, and is not git's stderr: no hints, no remote banner, no token.
    for (const error of [blind, informed]) {
      expect(error?.message).toContain("push");
      expect(error?.message).toContain(ref);
      expect(error?.message).not.toMatch(/hint:|To http|error: failed to push/);
      expect(error?.message).not.toContain(TOKEN);
      expect(error?.message.split("\n")).toHaveLength(1);
    }
    // And nothing was forced: the remote still holds their commit.
    expect(git(bare, "rev-parse", ref)).toBe(theirs);
  });

  it("is a typed auth error when the remote refuses the credential, without echoing it", async () => {
    const session = await openSession();
    commitFile(session.worktree, "AUTH.md", "x\n");
    const wrong = `ghs_${randomBytes(18).toString("hex")}`;
    const before = remote.seen.length;
    const error = gitErrorOf(
      await runWith(
        pushBranch({
          worktree: session.worktree,
          repo,
          url: forgeUrl(),
          branch: session.branch,
        }),
        Option.some(Redacted.make(wrong)),
      ),
    );
    expect(error).toMatchObject({
      operation: "push",
      ref: `refs/heads/${session.branch}`,
      reason: "auth",
    });
    expect(error?.message).not.toContain(wrong);
    expect(remote.seen.slice(before).some((s) => s.password === wrong)).toBe(
      true,
    );

    const fetchError = gitErrorOf(
      await runWith(
        fetchBranch({
          worktree: session.worktree,
          repo,
          url: forgeUrl(),
          branch: "main",
        }),
        Option.some(Redacted.make(wrong)),
      ),
    );
    expect(fetchError).toMatchObject({
      operation: "fetch",
      ref: "refs/heads/main",
      reason: "auth",
    });
  });

  it("is a typed missing-ref error for a branch the remote does not have", async () => {
    const session = await openSession();
    const error = gitErrorOf(
      await runWith(
        fetchBranch({
          worktree: session.worktree,
          repo,
          url: forgeUrl(),
          branch: "no-such-branch",
        }),
      ),
    );
    expect(error).toMatchObject({
      operation: "fetch",
      ref: "refs/heads/no-such-branch",
      reason: "missing-ref",
    });
  });
});

describe("what is refused before git runs", GIT_CASE, () => {
  it("fails with the provider's typed error when no token is configured, and reaches no remote", async () => {
    const session = await openSession();
    commitFile(session.worktree, "NOTOKEN.md", "x\n");
    const before = remote.requests.count;
    const exit = await runWith(
      pushBranch({
        worktree: session.worktree,
        repo,
        url: forgeUrl(),
        branch: session.branch,
      }),
      Option.none(),
    );
    const error = Exit.isFailure(exit)
      ? exit.cause.reasons.flatMap((r) =>
          r._tag === "Fail" ? [r.error] : [],
        )[0]
      : undefined;
    expect(error).toMatchObject({ _tag: "CredentialError", code: "missing" });
    expect(remote.requests.count).toBe(before);
  });

  it("refuses to push a branch outside factory/, or one that smuggles a second refspec", async () => {
    const session = await openSession();
    const before = remote.requests.count;
    for (const branch of [
      "main",
      `${session.branch}:refs/heads/main`,
      `+${session.branch}`,
      "factory/../main",
      "factory/-x",
    ]) {
      const error = gitErrorOf(
        await runWith(
          pushBranch({
            worktree: session.worktree,
            repo,
            url: forgeUrl(),
            branch,
          }),
        ),
      );
      expect(error, branch).toMatchObject({
        operation: "push",
        reason: "refused",
      });
    }
    expect(remote.requests.count).toBe(before);
    expect(git(bare, "rev-parse", "refs/heads/main")).toBe(
      git(upstream, "rev-parse", "main"),
    );
  });

  it("refuses a URL that is not the repo's, carries a credential, or is not https, and reaches no remote", async () => {
    const session = await openSession();
    commitFile(session.worktree, "URL.md", "x\n");
    const before = remote.requests.count;
    for (const url of [
      // Another repo on the same forge: the token is resolved for lobiklukas/factory only.
      `${remote.url}/someone/else.git`,
      // A stored password, and a token placed as the username (GitHub's `https://<pat>@` form).
      `${remote.url.replace("http://", "http://x-access-token:stored@")}/lobiklukas/factory.git`,
      `${remote.url.replace("http://", "http://ghp_stored@")}/lobiklukas/factory.git`,
      // Cleartext to a host that is not this machine.
      "http://example.com/lobiklukas/factory.git",
      // Transports that are not https at all.
      "git@github.com:lobiklukas/factory.git",
      "ssh://git@github.com/lobiklukas/factory.git",
      `file://${bare}`,
      "ext::sh -c touch% /tmp/pwned",
      `${forgeUrl()}?x=1`,
    ]) {
      for (const exit of [
        await runWith(
          fetchBranch({
            worktree: session.worktree,
            repo,
            url,
            branch: "main",
          }),
        ),
        await runWith(
          pushBranch({
            worktree: session.worktree,
            repo,
            url,
            branch: session.branch,
          }),
        ),
      ]) {
        const error = gitErrorOf(exit);
        expect(error, url).toMatchObject({ repo, reason: "refused" });
        expect(error?.message, url).not.toContain("stored");
      }
    }
    expect(remote.requests.count).toBe(before);
  });

  it("is a typed missing-ref error, before any credential, for a branch the checkout does not have", async () => {
    const session = await openSession();
    const before = remote.requests.count;
    const error = gitErrorOf(
      await runWith(
        pushBranch({
          worktree: session.worktree,
          repo,
          url: forgeUrl(),
          branch: "factory/never-committed",
        }),
        Option.none(),
      ),
    );
    expect(error).toMatchObject({
      operation: "push",
      ref: "refs/heads/factory/never-committed",
      reason: "missing-ref",
    });
    expect(remote.requests.count).toBe(before);
  });
});

describe("resolveForgeUrl", () => {
  it("defaults to the repo on GitHub and accepts the repo's own https URL in its usual spellings", () => {
    expect(resolveForgeUrl(repo)).toEqual({
      ok: true,
      forge: {
        url: "https://github.com/lobiklukas/factory.git",
        origin: "https://github.com",
        scheme: "https",
      },
    });
    for (const url of [
      "https://github.com/lobiklukas/factory",
      "https://github.com/lobiklukas/factory/",
      "https://GitHub.com/LobikLukas/Factory.git",
      "http://127.0.0.1:9510/lobiklukas/factory.git",
      "http://localhost/lobiklukas/factory.git",
    ])
      expect(resolveForgeUrl(repo, url).ok, url).toBe(true);
    for (const url of [
      "https://github.com/lobiklukas/factory-evil.git",
      "https://github.com/lobiklukas/factory/../other.git",
      "https://evil.example/lobiklukas/factory.git",
      "https://github.com/lobiklukas/factory.git?x",
      "http://github.com/lobiklukas/factory.git",
      "https://u:p@github.com/lobiklukas/factory.git",
      "not a url",
    ])
      expect(resolveForgeUrl(repo, url).ok, url).toBe(false);
  });
});

describe(
  "what the checkout cannot make the credentialed git do",
  GIT_CASE,
  () => {
    /** A script that records it ran, and with which environment, in `<root>/ran-<name>`. */
    const recorder = (dir: string, name: string): string => {
      const file = join(dir, name);
      writeFileSync(file, `#!/bin/sh\nenv > "${join(root, `ran-${name}`)}"\n`);
      chmodSync(file, 0o755);
      return file;
    };
    const ran = (): ReadonlyArray<string> =>
      readdirSync(root).filter((name) => name.startsWith("ran-"));

    it("runs no hook and no fsmonitor of the checkout, so none of them sees the token", async () => {
      const session = await openSession();
      commitFile(session.worktree, "HOOKS.md", "x\n");
      const hooks = join(local, ".git", "hooks");
      const elsewhere = join(root, "agent-hooks");
      mkdirSync(elsewhere, { recursive: true });
      const names = [
        "pre-push",
        "reference-transaction",
        "post-update",
        "pre-auto-gc",
        "post-checkout",
      ];
      for (const name of names) {
        recorder(hooks, name);
        recorder(elsewhere, `${name}`);
      }
      const fsmonitor = recorder(root, "fsmonitor");
      try {
        const pushed = await runWith(
          pushBranch({
            worktree: session.worktree,
            repo,
            url: forgeUrl(),
            branch: session.branch,
          }),
        );
        expect(Exit.isSuccess(pushed)).toBe(true);
        const fetched = await runWith(
          fetchBranch({
            worktree: session.worktree,
            repo,
            url: forgeUrl(),
            branch: "main",
          }),
        );
        expect(Exit.isSuccess(fetched)).toBe(true);
        // The same again with the hooks moved by config, the way an agent would redirect them.
        git(local, "config", "core.hooksPath", elsewhere);
        git(local, "config", "core.fsmonitor", fsmonitor);
        commitFile(session.worktree, "HOOKS.md", "y\n");
        for (const name of ran()) rmSync(join(root, name));
        const again = await runWith(
          pushBranch({
            worktree: session.worktree,
            repo,
            url: forgeUrl(),
            branch: session.branch,
          }),
        );
        expect(Exit.isSuccess(again)).toBe(true);
        const refetched = await runWith(
          fetchBranch({
            worktree: session.worktree,
            repo,
            url: forgeUrl(),
            branch: "main",
          }),
        );
        expect(Exit.isSuccess(refetched)).toBe(true);
        expect(ran()).toEqual([]);

        // The witness: the planted hooks are live, so their silence above is the runner's doing.
        git(session.worktree, "update-ref", "refs/heads/witness", "HEAD");
        expect(ran()).toContain("ran-reference-transaction");
      } finally {
        git(local, "config", "--unset", "core.hooksPath");
        git(local, "config", "--unset", "core.fsmonitor");
        for (const name of names) rmSync(join(hooks, name));
        for (const name of ran()) rmSync(join(root, name));
      }
    });

    it("sends the token to the given URL only, whatever the checkout's remotes, rewrites and proxy say", async () => {
      const session = await openSession();
      const head = commitFile(session.worktree, "DECOY.md", "x\n");
      const decoy = await startDecoy();
      const decoyUrl = `${decoy.url}/lobiklukas/factory.git`;
      git(local, "remote", "set-url", "origin", decoyUrl);
      git(local, "config", "remote.origin.pushurl", decoyUrl);
      git(local, "config", `url.${decoy.url}/.insteadOf`, `${remote.url}/`);
      git(local, "config", `url.${decoy.url}/.pushInsteadOf`, `${remote.url}/`);
      git(local, "config", "http.proxy", decoy.url);
      git(local, "config", "include.path", join(root, "no-such-include"));
      try {
        const pushed = await runWith(
          pushBranch({
            worktree: session.worktree,
            repo,
            url: forgeUrl(),
            branch: session.branch,
          }),
        );
        expect(Exit.isSuccess(pushed) ? pushed.value.sha : undefined).toBe(
          head,
        );
        expect(git(bare, "rev-parse", `refs/heads/${session.branch}`)).toBe(
          head,
        );
        const fetched = await runWith(
          fetchBranch({
            worktree: session.worktree,
            repo,
            url: forgeUrl(),
            branch: "main",
          }),
        );
        expect(Exit.isSuccess(fetched)).toBe(true);
        expect(decoy.requests).toEqual([]);
      } finally {
        git(local, "remote", "set-url", "origin", forgeUrl());
        git(local, "config", "--unset", "remote.origin.pushurl");
        git(local, "config", "--remove-section", `url.${decoy.url}/`);
        git(local, "config", "--unset", "http.proxy");
        git(local, "config", "--unset", "include.path");
        decoy.server.close();
      }
    });
  },
);

describe("a stalled remote", GIT_CASE, () => {
  it("is a typed timeout at the deadline, not a hang", async () => {
    const session = await openSession();
    // Accepts the connection, reads the request, and never answers.
    const stall = createServer(() => {});
    stall.listen(0, "127.0.0.1");
    await once(stall, "listening");
    const address = stall.address();
    if (address === null || typeof address === "string")
      throw new Error("the stall listener did not bind a TCP port");
    try {
      const error = gitErrorOf(
        await runWith(
          fetchBranch({
            worktree: session.worktree,
            repo,
            url: `http://127.0.0.1:${address.port}/lobiklukas/factory.git`,
            branch: "main",
            timeout: Duration.seconds(1),
          }),
        ),
      );
      expect(error).toMatchObject({
        operation: "fetch",
        reason: "timeout",
      });
      // No hang: the case's own 30 s limit is far under the 5-minute default deadline.
    } finally {
      stall.closeAllConnections();
      stall.close();
    }
  });
});

const mirrorRoot = join(root, "mirror-root");

const isCloneFailed = Schema.is(RepoCloneFailed);

const cloneErrorOf = <A>(
  exit: Exit.Exit<A, unknown>,
): RepoCloneFailed | undefined =>
  Exit.isFailure(exit)
    ? exit.cause.reasons.flatMap((r) =>
        r._tag === "Fail" && isCloneFailed(r.error) ? [r.error] : [],
      )[0]
    : undefined;

/** The deployment's mirror, built the way the API builds it: `<root>/.cache/<owner>/<name>.git`. */
const openMirror = (token?: Option.Option<Redacted.Redacted<string>>) =>
  runWith(gitRepoMirror({ root: mirrorRoot }), token);

describe(
  "the factory's clone of a repo registered with only a URL (LOB-265)",
  GIT_CASE,
  () => {
    const cloned = async () => {
      const made = await openMirror();
      if (!Exit.isSuccess(made)) throw new Error("the mirror did not build");
      const mirror = made.value;
      const synced = await runWith(
        mirror.sync({ repo, url: forgeUrl(), baseRef: "main" }),
      );
      return { mirror, synced };
    };

    it("clones a bare repository at the cache path with no credential in its config or on disk", async () => {
      const { mirror, synced } = await cloned();
      const mirrorPath = join(
        mirrorRoot,
        ".cache",
        "lobiklukas",
        "factory.git",
      );
      expect(mirror.directory(repo)).toBe(mirrorPath);
      expect(Exit.isSuccess(synced)).toBe(true);
      if (!Exit.isSuccess(synced)) return;
      expect(synced.value).toEqual({
        path: mirrorPath,
        ref: "refs/remotes/origin/main",
        sha: git(bare, "rev-parse", "main"),
      });
      expect(git(mirrorPath, "rev-parse", "--is-bare-repository")).toBe("true");
      expect(git(mirrorPath, "rev-parse", "refs/remotes/origin/main")).toBe(
        synced.value.sha,
      );

      // The remote did demand the token, and git did send it: the clone is not a path copy.
      expect(remote.seen.some((s) => s.password === TOKEN)).toBe(true);
      // And it is written nowhere: not the config, which names no remote and no URL, not a helper
      // store, not a byte of any file in the mirror.
      const config = readFileSync(join(mirrorPath, "config"), "utf8");
      expect(config).not.toContain(TOKEN);
      expect(config).not.toContain("[remote");
      expect(config).not.toContain(remote.url);
      expect(config).not.toContain("credential");
      expect(existsSync(leakedStore)).toBe(false);
      const files = filesUnder(mirrorPath);
      expect(files.length).toBeGreaterThan(5);
      const tokenBytes = Buffer.from(TOKEN);
      expect(
        files.filter((file) => readFileSync(file).includes(tokenBytes)),
      ).toEqual([]);
    });

    it("cuts a session's worktree from the mirror at the fetched base ref, and fetches again for the next session", async () => {
      const { mirror } = await cloned();
      const mirrorPath = mirror.directory(repo);
      const open = (id: SessionId) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          return yield* resolveWorkspace(
            {
              sessionRoot,
              sessionId: id,
              repo,
              baseRef: "main",
              mirror: {
                path: mirror.directory(repo),
                sync: mirror
                  .sync({ repo, url: forgeUrl(), baseRef: "main" })
                  .pipe(Effect.map((tip) => tip.ref)),
              },
            },
            { fs, path },
          );
        });

      const tip = commitFile(upstream, "MIRROR.md", "in the mirror\n");
      git(upstream, "push", "origin", "main");
      const firstId = await Effect.runPromise(mintSessionId);
      const first = await runWith(open(firstId));
      expect(Exit.isSuccess(first)).toBe(true);
      if (!Exit.isSuccess(first)) return;
      const worktree = first.value.path;

      // A linked worktree of the mirror, on the session's branch, at the base the remote just had.
      expect(first.value.warning).toBeUndefined();
      expect(first.value.branch).toBe(`factory/${firstId}`);
      expect(readFileSync(join(worktree, ".git"), "utf8")).toContain(
        join(mirrorPath, "worktrees"),
      );
      expect(realpathSync(git(worktree, "rev-parse", "--git-common-dir"))).toBe(
        realpathSync(mirrorPath),
      );
      expect(git(worktree, "rev-parse", "--abbrev-ref", "HEAD")).toBe(
        `factory/${firstId}`,
      );
      expect(git(worktree, "rev-parse", "HEAD")).toBe(tip);
      expect(readFileSync(join(worktree, "README.md"), "utf8")).toBe("seed\n");
      expect(readFileSync(join(worktree, "MIRROR.md"), "utf8")).toBe(
        "in the mirror\n",
      );
      expect(git(mirrorPath, "worktree", "list")).toContain(worktree);
      // The base is also the mirror's own branch, so the range the PR step measures, `main...HEAD`,
      // resolves in the session's worktree: its diff is what the session committed and nothing else.
      expect(git(mirrorPath, "rev-parse", "refs/heads/main")).toBe(tip);
      const committed = commitFile(
        worktree,
        "SESSION.md",
        "the session's change\n",
      );
      expect(git(worktree, "diff", "--name-only", "main...HEAD")).toBe(
        "SESSION.md",
      );
      // Cutting it wrote no upstream into the mirror's config.
      expect(readFileSync(join(mirrorPath, "config"), "utf8")).not.toContain(
        "[branch",
      );

      // Reopening the same session — the directory is a workspace — touches no network.
      const requests = remote.requests.count;
      const again = await runWith(open(firstId));
      expect(Exit.isSuccess(again)).toBe(true);
      expect(remote.requests.count).toBe(requests);

      // The next session fetches again, so it starts from where the remote has moved to.
      const moved = commitFile(upstream, "MOVED.md", "moved on\n");
      git(upstream, "push", "origin", "main");
      const secondId = await Effect.runPromise(mintSessionId);
      const second = await runWith(open(secondId));
      expect(Exit.isSuccess(second)).toBe(true);
      if (!Exit.isSuccess(second)) return;
      expect(git(second.value.path, "rev-parse", "HEAD")).toBe(moved);
      // The first session's worktree is its own: still at what it committed.
      expect(git(worktree, "rev-parse", "HEAD")).toBe(committed);
    });

    it("is a typed error naming the repo and the reason when the remote refuses the credential, and leaves no mirror behind", async () => {
      const ghost = RepoSlug.make("lobiklukas/refused-clone");
      const wrong = `ghs_${randomBytes(18).toString("hex")}`;
      const made = await openMirror(Option.some(Redacted.make(wrong)));
      if (!Exit.isSuccess(made)) throw new Error("the mirror did not build");
      const exit = await runWith(
        made.value.sync({
          repo: ghost,
          url: `${remote.url}/lobiklukas/refused-clone.git`,
          baseRef: "main",
        }),
      );
      const error = cloneErrorOf(exit);
      expect(error).toMatchObject({ repo: ghost, reason: "auth" });
      expect(error?.message).toContain("lobiklukas/refused-clone");
      expect(error?.message).not.toContain(wrong);
      expect(existsSync(made.value.directory(ghost))).toBe(false);
      expect(existsSync(`${made.value.directory(ghost)}.partial`)).toBe(false);
    });

    it("finishes a clone a killed process left half-made, and never reports the half as a mirror", async () => {
      const slug = repo;
      const made = await runWith(
        gitRepoMirror({ root: join(root, "mirror-killed") }),
      );
      if (!Exit.isSuccess(made)) throw new Error("the mirror did not build");
      const directory = made.value.directory(slug);
      // What a process killed after `git init` and before the first fetch landed leaves behind.
      mkdirSync(`${directory}.partial`, { recursive: true });
      writeFileSync(
        join(`${directory}.partial`, "HEAD"),
        "ref: refs/heads/main\n",
      );
      expect(existsSync(join(directory, "HEAD"))).toBe(false);
      const exit = await runWith(
        made.value.sync({ repo: slug, url: forgeUrl(), baseRef: "main" }),
      );
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(existsSync(`${directory}.partial`)).toBe(false);
      expect(git(directory, "rev-parse", "refs/remotes/origin/main")).toMatch(
        /^[0-9a-f]{40}$/,
      );
    });

    it("names the reason for a ref the remote lacks, a repo it does not serve and no token at all", async () => {
      const { mirror } = await cloned();
      const noRef = cloneErrorOf(
        await runWith(
          mirror.sync({ repo, url: forgeUrl(), baseRef: "no-such-branch" }),
        ),
      );
      expect(noRef).toMatchObject({ repo, reason: "missing-ref" });

      const ghost = RepoSlug.make("lobiklukas/not-served");
      const notServed = cloneErrorOf(
        await runWith(
          mirror.sync({
            repo: ghost,
            url: `${remote.url}/lobiklukas/not-served.git`,
            baseRef: "main",
          }),
        ),
      );
      expect(notServed).toMatchObject({ repo: ghost, reason: "failed" });
      expect(existsSync(mirror.directory(ghost))).toBe(false);

      // The credential is the one the mirror was built with, resolved at each call.
      const tokenless = await openMirror(Option.none());
      if (!Exit.isSuccess(tokenless))
        throw new Error("the mirror did not build");
      const noToken = cloneErrorOf(
        await runWith(
          tokenless.value.sync({ repo, url: forgeUrl(), baseRef: "main" }),
        ),
      );
      expect(noToken).toMatchObject({ repo, reason: "credential" });
    });

    it("refuses a URL a token may not go to, and a slug that would name a dotfile, before reaching any remote", async () => {
      const { mirror } = await cloned();
      const before = remote.requests.count;
      const elsewhere = cloneErrorOf(
        await runWith(
          mirror.sync({
            repo,
            url: "https://evil.example/lobiklukas/factory.git",
            baseRef: "main",
          }),
        ),
      );
      expect(elsewhere).toMatchObject({ repo, reason: "refused" });
      const dotted = RepoSlug.make(".cache/factory");
      const dotfile = cloneErrorOf(
        await runWith(
          mirror.sync({
            repo: dotted,
            url: `${remote.url}/.cache/factory.git`,
            baseRef: "main",
          }),
        ),
      );
      expect(dotfile).toMatchObject({ repo: dotted, reason: "refused" });
      expect(remote.requests.count).toBe(before);
    });
  },
);

describe("isSafeBranchName", () => {
  it("accepts the branches the control plane names and nothing that reads as a refspec or option", () => {
    for (const ok of [
      "main",
      "factory/ses_01abc",
      "factory/doc-x1",
      "release/1.2",
    ])
      expect(isSafeBranchName(ok), ok).toBe(true);
    for (const bad of [
      "",
      "a:b",
      "+main",
      "-main",
      "a..b",
      "factory//x",
      "/main",
      "main/",
      "x.lock",
      "x.",
      ".hidden",
      "has space",
      "a~1",
      "a^",
      "a@{1}",
    ])
      expect(isSafeBranchName(bad), bad).toBe(false);
  });
});
