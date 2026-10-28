// The loopback GitHub fake the PR step is driven against (LOB-179).
//
// Exactly two routes, because the PR client calls exactly two: `POST /repos/:owner/:repo/pulls`
// creates a pull request, and `GET /repos/:owner/:repo/pulls?head=&base=` answers the one that
// already exists for a head and base. Everything else is a 404 on purpose — a fake that answers
// more than the client calls would hide a wrong URL instead of failing on it.
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
  }>;
};

const port = Number(process.env["GITHUB_FAKE_PORT"] ?? "9411");
const ledgerPath = process.env["GITHUB_FAKE_LEDGER"];
const hangFirst = process.env["GITHUB_FAKE_HANG_FIRST"] === "1";
const gitRoot = process.env["GITHUB_FAKE_GIT_ROOT"];

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

const server = Bun.serve({
  port,
  hostname: "127.0.0.1",
  fetch: async (request) => {
    const url = new URL(request.url);
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
      const body = parsed as { head?: string; base?: string };
      const head = body.head ?? "";
      const base = body.base ?? "";
      const recorded = read().pulls.find(
        (pull) => pull.head === head && pull.base === base,
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
      return json(
        200,
        read()
          .pulls.filter((pull) => pull.head === branch && pull.base === base)
          .map((pull) => answer(owner, repo, pull)),
      );
    }

    return new Response("method not allowed", { status: 405 });
  },
});

console.log(
  `github-fake listening on ${server.url.href} ledger=${ledgerPath} hangFirst=${String(hangFirst)}`,
);
