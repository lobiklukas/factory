/**
 * A loopback GitHub for the rulesets (LOB-30): the REST routes `../rulesets/github.ts` calls, and
 * git's smart-HTTP push path with the rulesets enforced on it — so a test or a drive can apply the
 * policy, delete a ruleset, and push a force-push at `factory/x`, all without reaching github.com.
 *
 *   const forge = await startGitHubFake({ root, workerToken, adminToken });
 *   forge.createRepo("acme/app");          // a bare repo, `main` seeded, the pre-receive installed
 *   forge.url                              // GITHUB_API_URL
 *   forge.gitUrl("acme/app")               // what `git push` is pointed at
 *
 * - **REST.** `GET`/`POST /repos/:owner/:repo/rulesets` and `GET`/`PUT`/`DELETE …/:id`, answering
 *   GitHub's documented shapes: the list carries ids and names only, a full read carries the rules,
 *   and `bypass_actors` is answered to the admin token alone (the worker's token reads a ruleset
 *   without it, and may not write one: `403`). Names are unique per repo (`422`). No token is `401`.
 * - **git.** `git http-backend` behind Basic auth (`x-access-token:<workerToken>`, else `401`), as
 *   `packages/core/src/git.test.ts` serves it. Each bare repo carries a `pre-receive` hook that
 *   classifies every ref update (create, fast-forward, force, delete — `git merge-base
 *   --is-ancestor`) and asks this server, which evaluates it against the repo's stored rulesets with
 *   `evaluateRefUpdate` and answers GitHub's own `GH013` lines. The pusher is the factory's App
 *   (`pusher`), so a bypass entry naming it is what would let it through.
 *
 * Every REST request and every push decision is recorded in memory and, with `ledger`, on disk, so a
 * drive that outlives nothing can still count what happened. The tokens are throwaway test values.
 * What it cannot prove: that GitHub's enforcement matches `enforce.ts` — the live probe does that.
 */
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { join } from "node:path";
import {
  type EnforcedRuleset,
  evaluateRefUpdate,
  type Pusher,
  type RefUpdate,
  rejectionLines,
} from "../rulesets/enforce";

export type StoredRuleset = EnforcedRuleset & {
  readonly id: number;
  readonly target: string;
  readonly source_type: "Repository";
  readonly source: string;
  readonly bypass_actors: ReadonlyArray<{
    readonly actor_id?: number | null;
    readonly actor_type: string;
    readonly bypass_mode?: string;
  }>;
  readonly rules: ReadonlyArray<{
    readonly type: string;
    readonly parameters?: Record<string, unknown>;
  }>;
};

export type RecordedRequest = {
  readonly method: string;
  readonly path: string;
  /** `admin`, `worker`, or `none`/`other`: which token asked, never its value. */
  readonly as: "admin" | "worker" | "none" | "other";
  readonly status: number;
};

export type RecordedPush = {
  readonly repo: string;
  readonly updates: ReadonlyArray<RefUpdate>;
  readonly allowed: boolean;
  readonly lines: ReadonlyArray<string>;
};

export type GitHubFakeOptions = {
  /** Where the bare repositories live: `<root>/<owner>/<name>.git`. */
  readonly root: string;
  /** The push credential the git routes accept. */
  readonly workerToken: string;
  /** The operator's credential the ruleset writes accept. */
  readonly adminToken: string;
  readonly defaultBranch?: string;
  /** Who every push is from, for `bypass_actors`. Defaults to the factory's App, `Integration 4242`. */
  readonly pusher?: Pusher;
  /** `0` (the default) binds an ephemeral port. */
  readonly port?: number;
  /** A file the requests and pushes are rewritten to after each one. */
  readonly ledger?: string;
};

export type GitHubFake = {
  /** The API root (`GITHUB_API_URL`), which is also the git origin. */
  readonly url: string;
  readonly gitUrl: (repo: string) => string;
  readonly createRepo: (repo: string) => void;
  /**
   * An edit someone makes on the repo's settings page: a rulesets request as the admin, straight
   * to this fake (`path` is after `/rulesets`, e.g. `/1001`). Answers the status.
   */
  readonly editAsAdmin: (
    repo: string,
    method: string,
    path: string,
    body?: unknown,
  ) => Promise<number>;
  readonly rulesets: (repo: string) => ReadonlyArray<StoredRuleset>;
  readonly requests: ReadonlyArray<RecordedRequest>;
  readonly pushes: ReadonlyArray<RecordedPush>;
  readonly close: () => Promise<void>;
};

export const DEFAULT_PUSHER: Pusher = {
  actorType: "Integration",
  actorId: 4242,
};

/** The hook body: classify each update, ask the fake, print its lines, exit with its verdict. */
const HOOK_SCRIPT = `import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
const [url, repo] = process.argv.slice(2);
const zero = /^0+$/;
const isAncestor = (older, newer) => {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", older, newer], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};
const updates = readFileSync(0, "utf8")
  .split("\\n")
  .filter((line) => line.trim().length > 0)
  .map((line) => {
    const [older, newer, ref] = line.trim().split(" ");
    const kind = zero.test(older) ? "create" : zero.test(newer) ? "delete" : isAncestor(older, newer) ? "fast-forward" : "force";
    return { ref, kind };
  });
try {
  const response = await fetch(url + "/_fake/pre-receive", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ repo, updates }),
  });
  const verdict = await response.json();
  for (const line of verdict.lines) process.stderr.write(line + "\\n");
  process.exit(verdict.allowed ? 0 : 1);
} catch (error) {
  process.stderr.write("the fake forge did not answer: " + String(error) + "\\n");
  process.exit(1);
}
`;

const readBody = async (req: IncomingMessage): Promise<string> => {
  const chunks: Array<Buffer> = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
};

const json = (res: ServerResponse, status: number, body?: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body === undefined ? "" : JSON.stringify(body));
};

/** Start the fake on loopback. */
export const startGitHubFake = async (
  options: GitHubFakeOptions,
): Promise<GitHubFake> => {
  const defaultBranch = options.defaultBranch ?? "main";
  const pusher = options.pusher ?? DEFAULT_PUSHER;
  const store = new Map<string, Array<StoredRuleset>>();
  const requests: Array<RecordedRequest> = [];
  const pushes: Array<RecordedPush> = [];
  let nextId = 1000;
  mkdirSync(options.root, { recursive: true });
  const hookScript = join(options.root, "pre-receive.mjs");
  writeFileSync(hookScript, HOOK_SCRIPT);

  const persist = () => {
    if (options.ledger !== undefined)
      writeFileSync(
        options.ledger,
        JSON.stringify(
          { requests, pushes, rulesets: Object.fromEntries(store) },
          null,
          2,
        ),
      );
  };

  const rulesetsOf = (repo: string) => {
    const found = store.get(repo);
    if (found !== undefined) return found;
    const created: Array<StoredRuleset> = [];
    store.set(repo, created);
    return created;
  };

  const bearer = (req: IncomingMessage): RecordedRequest["as"] => {
    const header = req.headers.authorization ?? "";
    if (!header.startsWith("Bearer ")) return "none";
    const token = header.slice("Bearer ".length);
    return token === options.adminToken
      ? "admin"
      : token === options.workerToken
        ? "worker"
        : "other";
  };

  /** A ruleset as a full read answers it: no `bypass_actors` to a caller who may not see them. */
  const present = (ruleset: StoredRuleset, as: RecordedRequest["as"]) => {
    if (as === "admin")
      return { ...ruleset, current_user_can_bypass: "never" as const };
    const { bypass_actors: _hidden, ...visible } = ruleset;
    return visible;
  };

  const writeRuleset = (
    repo: string,
    id: number,
    body: Record<string, unknown>,
    previous?: StoredRuleset,
  ): StoredRuleset | string => {
    const name = body["name"] ?? previous?.name;
    const enforcement = body["enforcement"] ?? previous?.enforcement;
    if (typeof name !== "string" || name.length === 0)
      return "name is required";
    if (
      enforcement !== "active" &&
      enforcement !== "evaluate" &&
      enforcement !== "disabled"
    )
      return "enforcement must be active, evaluate or disabled";
    if (
      rulesetsOf(repo).some(
        (other) => other.name === name && other.id !== previous?.id,
      )
    )
      return "Name must be unique";
    return {
      id,
      name,
      target:
        (body["target"] as string | undefined) ?? previous?.target ?? "branch",
      source_type: "Repository",
      source: repo,
      enforcement,
      conditions:
        (body["conditions"] as StoredRuleset["conditions"]) ??
        previous?.conditions,
      rules: (body["rules"] as StoredRuleset["rules"]) ?? previous?.rules ?? [],
      bypass_actors:
        (body["bypass_actors"] as StoredRuleset["bypass_actors"]) ??
        previous?.bypass_actors ??
        [],
    };
  };

  const handleRest = async (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<number> => {
    const match = /^\/repos\/([^/]+\/[^/]+)\/rulesets(?:\/(\d+))?$/.exec(
      url.pathname,
    );
    if (match === null) {
      json(res, 404, { message: "Not Found" });
      return 404;
    }
    const repo = match[1] ?? "";
    const id = match[2] === undefined ? undefined : Number(match[2]);
    const as = bearer(req);
    if (as === "none" || as === "other") {
      json(res, 401, { message: "Bad credentials" });
      return 401;
    }
    const method = req.method ?? "GET";
    const all = rulesetsOf(repo);
    if (method !== "GET" && as !== "admin") {
      json(res, 403, { message: "Resource not accessible by integration" });
      return 403;
    }
    if (id === undefined && method === "GET") {
      const perPage = Number(url.searchParams.get("per_page") ?? "30");
      const page = Number(url.searchParams.get("page") ?? "1");
      json(
        res,
        200,
        all
          .slice((page - 1) * perPage, page * perPage)
          .map(
            ({ id: rid, name, target, source_type, source, enforcement }) => ({
              id: rid,
              name,
              target,
              source_type,
              source,
              enforcement,
            }),
          ),
      );
      return 200;
    }
    if (id === undefined && method === "POST") {
      const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
      nextId += 1;
      const written = writeRuleset(repo, nextId, body);
      if (typeof written === "string") {
        json(res, 422, { message: written });
        return 422;
      }
      all.push(written);
      json(res, 201, present(written, as));
      return 201;
    }
    const index = all.findIndex((ruleset) => ruleset.id === id);
    const existing = all[index];
    if (id === undefined || existing === undefined) {
      req.resume();
      json(res, 404, { message: "Not Found" });
      return 404;
    }
    if (method === "GET") {
      json(res, 200, present(existing, as));
      return 200;
    }
    if (method === "PUT") {
      const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
      const written = writeRuleset(repo, existing.id, body, existing);
      if (typeof written === "string") {
        json(res, 422, { message: written });
        return 422;
      }
      all[index] = written;
      json(res, 200, present(written, as));
      return 200;
    }
    if (method === "DELETE") {
      all.splice(index, 1);
      res.writeHead(204);
      res.end();
      return 204;
    }
    json(res, 405, { message: "Method Not Allowed" });
    return 405;
  };

  const handlePreReceive = async (
    req: IncomingMessage,
    res: ServerResponse,
  ) => {
    const body = JSON.parse(await readBody(req)) as {
      repo: string;
      updates: ReadonlyArray<RefUpdate>;
    };
    const rulesets = rulesetsOf(body.repo);
    const lines: Array<string> = [];
    for (const update of body.updates) {
      const violations = evaluateRefUpdate(rulesets, update, {
        defaultBranch,
        pusher,
      });
      if (violations.length > 0)
        lines.push(...rejectionLines(body.repo, update.ref, violations));
    }
    const allowed = lines.length === 0;
    pushes.push({ repo: body.repo, updates: body.updates, allowed, lines });
    json(res, 200, { allowed, lines });
  };

  const handleGit = (req: IncomingMessage, res: ServerResponse, url: URL) => {
    const header = req.headers.authorization ?? "";
    const decoded = header.startsWith("Basic ")
      ? Buffer.from(header.slice(6), "base64").toString("utf8")
      : undefined;
    if (decoded !== `x-access-token:${options.workerToken}`) {
      req.resume();
      res.writeHead(401, { "WWW-Authenticate": 'Basic realm="github-fake"' });
      res.end();
      return;
    }
    const cgi = spawn("git", ["http-backend"], {
      env: {
        ...process.env,
        // The machine's own git config (a global `core.hooksPath`, say) must not decide whether
        // the repo's pre-receive runs.
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_PROJECT_ROOT: options.root,
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
      if (split === -1) {
        res.writeHead(502);
        res.end();
        return;
      }
      const sep = split === crlf ? 4 : 2;
      let status = 200;
      const headers: Record<string, string> = {};
      for (const line of out
        .subarray(0, split)
        .toString("utf8")
        .split(/\r?\n/)) {
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
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/_fake/pre-receive" && req.method === "POST") {
      void handlePreReceive(req, res).finally(persist);
      return;
    }
    if (/^\/[^/]+\/[^/]+\.git\//.test(url.pathname)) {
      handleGit(req, res, url);
      return;
    }
    void handleRest(req, res, url)
      .then((status) => {
        requests.push({
          method: req.method ?? "GET",
          path: `${url.pathname}${url.search}`,
          as: bearer(req),
          status,
        });
      })
      .catch(() => json(res, 500, { message: "fake error" }))
      .finally(persist);
  });
  await new Promise<void>((resolve) =>
    server.listen(options.port ?? 0, "127.0.0.1", resolve),
  );
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("the GitHub fake did not bind a TCP port");
  const url = `http://127.0.0.1:${address.port}`;

  const git = (cwd: string, args: ReadonlyArray<string>, input?: string) =>
    execFileSync("git", [...args], {
      cwd,
      input,
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_AUTHOR_NAME: "github fake",
        GIT_AUTHOR_EMAIL: "fake@factory.invalid",
        GIT_COMMITTER_NAME: "github fake",
        GIT_COMMITTER_EMAIL: "fake@factory.invalid",
      },
    })
      .toString("utf8")
      .trim();

  const createRepo = (repo: string) => {
    const dir = join(options.root, `${repo}.git`);
    mkdirSync(dir, { recursive: true });
    git(dir, ["init", "--bare", "--quiet", "--template=", dir]);
    git(dir, ["symbolic-ref", "HEAD", `refs/heads/${defaultBranch}`]);
    const tree = git(dir, ["mktree"], "");
    const commit = git(dir, ["commit-tree", tree, "-m", "initial"]);
    git(dir, ["update-ref", `refs/heads/${defaultBranch}`, commit]);
    mkdirSync(join(dir, "hooks"), { recursive: true });
    const hook = join(dir, "hooks", "pre-receive");
    writeFileSync(
      hook,
      `#!/bin/sh\nexec "${process.execPath}" "${hookScript}" "${url}" "${repo}"\n`,
    );
    chmodSync(hook, 0o755);
    rulesetsOf(repo);
  };

  return {
    url,
    gitUrl: (repo) => `${url}/${repo}.git`,
    createRepo,
    editAsAdmin: async (repo, method, path, body) => {
      const response = await fetch(`${url}/repos/${repo}/rulesets${path}`, {
        method,
        headers: {
          authorization: `Bearer ${options.adminToken}`,
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      await response.arrayBuffer();
      return response.status;
    },
    rulesets: (repo) => [...rulesetsOf(repo)],
    requests,
    pushes,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) =>
          error === undefined ? resolve() : reject(error),
        );
        server.closeAllConnections();
      }),
  };
};
