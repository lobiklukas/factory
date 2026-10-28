// The loopback GitHub fake the PR step is driven against (LOB-179).
//
// The routes the factory's PR clients call: `POST /repos/:owner/:repo/pulls` creates a pull request,
// `GET /repos/:owner/:repo/pulls?head=&base=` answers the open one that already exists for a head and base,
// and `GET /repos/:owner/:repo/pulls/:number` answers one PR's state (C20: the PR-state read when a
// card is opened). Two more are GitHub's own merge and close (`PUT .../pulls/:number/merge`,
// `PATCH .../pulls/:number` with `{"state":"closed"}`), which nothing in the factory calls: a drive
// calls them, as a person's click in GitHub would, so the state read has something to find.
// Everything else is a 404 on purpose — a fake that answers more than the clients call would hide a
// wrong URL instead of failing on it.
//
// The ledger is a **file**, not memory, and that is the whole point: the process being proved is
// killed between its request and its acknowledgement, so the record of what the client asked for
// has to outlive that process. It holds every request the client made (so "no second call" is a
// countable fact) and the pull requests that exist (so "exactly one PR" is too). Since LOB-228 a
// request also keeps **the body it sent**, because "the PR body lists the three changed paths" is a
// claim about the request, and a ledger that only counted methods could not see it.
//
//   GITHUB_FAKE_PORT       port to listen on (default 9411)
//   GITHUB_FAKE_LEDGER     ledger file path, required
//   GITHUB_FAKE_HANG_FIRST "1" holds the first create request open, never answering it — the
//                          window a killed process leaves behind
//   GITHUB_FAKE_REFUSE     a JSON array of `{ "title": "<substring>", "status": 422, "body": {...} }`
//                          (C7b): a create whose PR title contains the substring is answered with
//                          that status and body, and records no PR. How a drive makes one forge
//                          refusal that repeats (a 422 naming an existing PR) and one that passes
//                          (a 502) from the same fake. The first matching rule answers
//   GITHUB_FAKE_GIT_ROOT   a directory of bare repositories (`<root>/<owner>/<repo>.git`), the
//                          git side of the same forge (C17). When set, a create whose head that
//                          repository does not hold is refused `422` as GitHub refuses it, and a PR
//                          records the head's sha at the moment it was opened (`headSha`)
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Ledger = {
  readonly requests: ReadonlyArray<{
    readonly method: string;
    readonly path: string;
    /** The JSON body the client sent, for a request that carried one. */
    readonly body?: unknown;
  }>;
  readonly pulls: ReadonlyArray<{
    readonly number: number;
    readonly url: string;
    readonly head: string;
    readonly base: string;
    /** The head's sha on the git side when the PR was opened, under `GITHUB_FAKE_GIT_ROOT`. */
    readonly headSha?: string;
    /** `closed` once a drive merged or closed it; absent is open. */
    readonly state?: "open" | "closed";
    /** When a drive merged it (`PUT .../merge`); absent while it is unmerged. */
    readonly mergedAt?: string;
  }>;
};

const port = Number(process.env["GITHUB_FAKE_PORT"] ?? "9411");
const ledgerPath = process.env["GITHUB_FAKE_LEDGER"];
const hangFirst = process.env["GITHUB_FAKE_HANG_FIRST"] === "1";
const gitRoot = process.env["GITHUB_FAKE_GIT_ROOT"];

/** The scripted refusals (`GITHUB_FAKE_REFUSE`): a create naming `title` is answered `status`/`body`. */
const refusals: ReadonlyArray<{
  readonly title: string;
  readonly status: number;
  readonly body: unknown;
}> = (() => {
  const raw = process.env["GITHUB_FAKE_REFUSE"];
  return raw === undefined || raw === "" ? [] : JSON.parse(raw);
})();

/** The sha the forge's git side holds for `branch`, or `undefined` when it holds no such branch. */
const headOnForge = (
  owner: string,
  repo: string,
  branch: string,
): string | undefined => {
  if (gitRoot === undefined || gitRoot === "") return undefined;
  try {
    return execFileSync(
      "git",
      [
        "--git-dir",
        join(gitRoot, owner, `${repo}.git`),
        "rev-parse",
        "--verify",
        "--quiet",
        "--end-of-options",
        `refs/heads/${branch}^{commit}`,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
  } catch {
    return undefined;
  }
};

if (ledgerPath === undefined || ledgerPath === "") {
  console.error("GITHUB_FAKE_LEDGER is required: the ledger is the evidence");
  process.exit(1);
}

const empty: Ledger = { requests: [], pulls: [] };

/**
 * A PR as GitHub's REST API answers it: `url` is the API resource and `html_url` the page. The
 * ledger's `url` is the page — what the factory should record — and the answer carries both, so a
 * client that read the wrong field would record `api.github.com` and its drive would see it.
 */
const answer = (
  owner: string,
  repo: string,
  pull: { readonly number: number; readonly url: string },
) => ({
  number: pull.number,
  url: `https://api.github.com/repos/${owner}/${repo}/pulls/${pull.number}`,
  html_url: pull.url,
});

const read = (): Ledger => {
  try {
    return JSON.parse(readFileSync(ledgerPath, "utf8")) as Ledger;
  } catch {
    return empty;
  }
};

/** Synchronous, so a request is on disk before its response is — and before the kill lands. */
const write = (ledger: Ledger): void => {
  writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
};

let hung = false;

write(empty);

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const pullsRoute = /^\/repos\/([^/]+)\/([^/]+)\/pulls$/;
const pullRoute = /^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)(\/merge)?$/;

/** One PR's state as GitHub's REST API answers it: `state`, `merged`, `merged_at`, the merge commit. */
const stateOf = (
  owner: string,
  repo: string,
  pull: Ledger["pulls"][number],
) => ({
  ...answer(owner, repo, pull),
  state: pull.state ?? "open",
  merged: pull.mergedAt !== undefined,
  merged_at: pull.mergedAt ?? null,
  merge_commit_sha:
    pull.mergedAt === undefined
      ? null
      : `${"c0".repeat(19)}${pull.number.toString(16).padStart(2, "0")}`,
});

/**
 * `GET`, `PUT .../merge` and `PATCH` on one PR (module comment). A merge or a close is recorded in
 * the ledger, so a later state read — the factory's — answers it.
 */
const onePull = async (
  request: Request,
  owner: string,
  repo: string,
  number: number,
  merge: boolean,
): Promise<Response> => {
  const ledger = read();
  const body =
    request.method === "PATCH"
      ? ((await request.json().catch(() => undefined)) as
          | { state?: string }
          | undefined)
      : undefined;
  write({
    ...ledger,
    requests: [
      ...ledger.requests,
      {
        method: request.method,
        path: new URL(request.url).pathname,
        ...(body === undefined ? {} : { body }),
      },
    ],
  });
  // Looked up by the repository the URL names as well as the number: a PR opened under another
  // `owner/repo` is a 404, as GitHub answers it, so a read built with the wrong slug fails here.
  const page = `https://github.com/${owner}/${repo}/pull/${number}`;
  const pull = read().pulls.find((candidate) => candidate.url === page);
  if (pull === undefined) return json(404, { message: "Not Found" });
  const update = (next: Ledger["pulls"][number]) => {
    write({
      ...read(),
      pulls: read().pulls.map((candidate) =>
        candidate.url === page ? next : candidate,
      ),
    });
    return next;
  };
  if (merge && request.method === "PUT") {
    if (pull.state === "closed")
      return json(405, { message: "Pull Request is not mergeable" });
    const merged = update({
      ...pull,
      state: "closed",
      mergedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    });
    return json(200, {
      merged: true,
      sha: stateOf(owner, repo, merged).merge_commit_sha,
    });
  }
  if (!merge && request.method === "PATCH") {
    if (body?.state !== "closed")
      return json(422, { message: "only state: closed is faked" });
    return json(
      200,
      stateOf(owner, repo, update({ ...pull, state: "closed" })),
    );
  }
  if (!merge && request.method === "GET")
    return json(200, stateOf(owner, repo, pull));
  return new Response("method not allowed", { status: 405 });
};

const server = Bun.serve({
  port,
  hostname: "127.0.0.1",
  fetch: async (request) => {
    const url = new URL(request.url);
    const single = pullRoute.exec(url.pathname);
    if (single !== null) {
      const [, owner = "", repo = "", number = "0", merge] = single;
      return onePull(request, owner, repo, Number(number), merge !== undefined);
    }
    const route = pullsRoute.exec(url.pathname);
    if (route === null) {
      write({
        ...read(),
        requests: [
          ...read().requests,
          { method: request.method, path: url.pathname },
        ],
      });
      return new Response("no such route", { status: 404 });
    }
    const [, owner = "", repo = ""] = route;
    // Parsed before anything is written: the ledger records the request as it arrived, body and all.
    const parsed =
      request.method === "POST"
        ? await request.json().catch(() => undefined)
        : undefined;
    const ledger = read();
    write({
      ...ledger,
      requests: [
        ...ledger.requests,
        {
          method: request.method,
          path: url.pathname,
          ...(parsed === undefined ? {} : { body: parsed }),
        },
      ],
    });
    // A create whose body is not JSON is refused rather than answered with an empty head and base:
    // a fake that invented a PR for a request it could not read would hide a broken client.
    if (request.method === "POST" && parsed === undefined) {
      return json(400, { message: "the request body is not JSON" });
    }

    if (request.method === "POST") {
      const body = parsed as { head?: string; base?: string; title?: string };
      const scripted = refusals.find((rule) =>
        (body.title ?? "").includes(rule.title),
      );
      if (scripted !== undefined) return json(scripted.status, scripted.body);
      const head = body.head ?? "";
      const base = body.base ?? "";
      // Only an open PR stands in the way, as on GitHub: a head whose PR was closed may open another
      // (F12, `pr-closed.sh`).
      const recorded = read().pulls.find(
        (pull) =>
          pull.head === head && pull.base === base && pull.state !== "closed",
      );
      if (recorded !== undefined) {
        // What GitHub answers for a second PR on one head and base, which is the refusal the
        // client has to turn into the PR that already exists.
        return json(422, {
          message: "Validation Failed",
          errors: [
            { message: `A pull request already exists for ${owner}:${head}.` },
          ],
        });
      }
      const headSha = headOnForge(owner, repo, head);
      if (gitRoot !== undefined && gitRoot !== "" && headSha === undefined) {
        // GitHub's answer for a head the repository does not have: the bug C17 fixes is exactly a
        // create that reached this branch.
        return json(422, {
          message: "Validation Failed",
          errors: [{ resource: "PullRequest", field: "head", code: "invalid" }],
        });
      }
      const number = read().pulls.length + 1;
      const created = {
        number,
        url: `https://github.com/${owner}/${repo}/pull/${number}`,
        head,
        base,
        ...(headSha === undefined ? {} : { headSha }),
      };
      write({ ...read(), pulls: [...read().pulls, created] });
      if (hangFirst && !hung) {
        // Recorded, asked for, and never answered: the caller is inside the call, which is the
        // state the script kills it in.
        hung = true;
        await new Promise<never>(() => {});
      }
      return json(201, answer(owner, repo, created));
    }

    if (request.method === "GET") {
      const head = url.searchParams.get("head") ?? "";
      const base = url.searchParams.get("base") ?? "";
      // GitHub spells the head as the repo owner's branch (`owner:branch`); the fake matches on
      // the branch half, because that is what identifies the PR here.
      const branch = head.includes(":")
        ? head.slice(head.indexOf(":") + 1)
        : head;
      // `state=open` (what the client asks) leaves closed PRs out, as GitHub's list does.
      const openOnly = (url.searchParams.get("state") ?? "open") === "open";
      return json(
        200,
        read()
          .pulls.filter(
            (pull) =>
              pull.head === branch &&
              pull.base === base &&
              (!openOnly || pull.state !== "closed"),
          )
          .map((pull) => answer(owner, repo, pull)),
      );
    }

    return new Response("method not allowed", { status: 405 });
  },
});

console.log(
  `github-fake listening on ${server.url.href} ledger=${ledgerPath} hangFirst=${String(hangFirst)}`,
);
