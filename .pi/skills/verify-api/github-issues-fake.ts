// The loopback GitHub fake the issues/labels adapter is driven against (LOB-190).
//
// Exactly one route, because the write-back calls exactly one:
// `GET|POST /repos/:owner/:repo/issues/:number/comments` — `GET` answers the issue's comments (the
// read the write-back makes before it posts, so a retry whose comment already landed posts nothing)
// and `POST` creates one. Any other path is a 404 on purpose: a fake that answers more than the
// client calls would hide a wrong URL instead of failing on it (the `github-fake.ts` rule).
//
// The ledger is a file rather than memory so "one comment, not two" survives across the driver's
// phases, and so the evidence is something a later reader can open: every request the write-back
// made — method, path, `Authorization`, `Accept`, `X-GitHub-Api-Version`, the body — and the
// comments that now exist.
//
//   GITHUB_ISSUES_FAKE_PORT              port to listen on (default 9413)
//   GITHUB_ISSUES_FAKE_LEDGER            ledger file path, required
//   GITHUB_ISSUES_FAKE_FAIL_AFTER_WRITE  `owner/repo#number`, or `#number` for any repo: for that
//                                        issue's FIRST comment, record it and then answer 500
//                                        instead of 201 — the window where GitHub has the comment
//                                        and the caller never learned it, which a retry must not
//                                        turn into a second comment
import { readFileSync, writeFileSync } from "node:fs";

type Comment = {
  readonly id: number;
  readonly issue: string;
  readonly body: unknown;
};

type Ledger = {
  readonly requests: ReadonlyArray<{
    readonly method: string;
    readonly path: string;
    readonly authorization: string | undefined;
    readonly accept: string | undefined;
    readonly apiVersion: string | undefined;
  }>;
  readonly comments: ReadonlyArray<Comment>;
};

const port = Number(process.env["GITHUB_ISSUES_FAKE_PORT"] ?? "9413");
const failAfterWrite = process.env["GITHUB_ISSUES_FAKE_FAIL_AFTER_WRITE"] ?? "";
const ledgerPath = process.env["GITHUB_ISSUES_FAKE_LEDGER"];

if (ledgerPath === undefined || ledgerPath === "") {
  console.error(
    "GITHUB_ISSUES_FAKE_LEDGER is required: the ledger is the evidence",
  );
  process.exit(1);
}

const empty: Ledger = { requests: [], comments: [] };

const read = (): Ledger => {
  try {
    return JSON.parse(readFileSync(ledgerPath, "utf8")) as Ledger;
  } catch {
    return empty;
  }
};

/** Synchronous, so a comment is on disk before its response is. */
const write = (ledger: Ledger): void => {
  writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
};

write(empty);

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const commentsRoute = /^\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)\/comments$/;

const server = Bun.serve({
  port,
  hostname: "127.0.0.1",
  async fetch(request) {
    const url = new URL(request.url);
    const ledger = read();
    ledger.requests.push({
      method: request.method,
      path: url.pathname,
      authorization: request.headers.get("authorization") ?? undefined,
      accept: request.headers.get("accept") ?? undefined,
      apiVersion: request.headers.get("x-github-api-version") ?? undefined,
    });
    write(ledger);

    const match = commentsRoute.exec(url.pathname);
    if (match === null) {
      return json(404, { message: "Not Found" });
    }
    const issue = `${match[1]}/${match[2]}#${match[3]}`;

    if (request.method === "GET") {
      return json(
        200,
        ledger.comments.filter((comment) => comment.issue === issue),
      );
    }
    if (request.method !== "POST") {
      return json(405, { message: "Method Not Allowed" });
    }

    const payload: unknown = await request.json().catch(() => null);
    const comment: Comment = {
      id: 30_001 + ledger.comments.length,
      issue,
      body:
        typeof payload === "object" && payload !== null && "body" in payload
          ? (payload as { body: unknown }).body
          : payload,
    };
    write({ ...ledger, comments: [...ledger.comments, comment] });
    if (
      failAfterWrite !== "" &&
      issue.endsWith(failAfterWrite) &&
      ledger.comments.filter((existing) => existing.issue === issue).length ===
        0
    ) {
      // The comment is on the issue; the caller sees a failure and will retry.
      return json(500, { message: "Internal Server Error" });
    }
    return json(201, {
      id: comment.id,
      body: comment.body,
    });
  },
});

console.log(`github-issues-fake listening on http://127.0.0.1:${server.port}`);
