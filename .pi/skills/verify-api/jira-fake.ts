// The loopback Jira Cloud fake the Jira adapter is driven against (LOB-189).
//
// Exactly one path, because the adapter calls exactly one: `POST /rest/api/3/issue/:key/comment`
// creates a comment and `GET` on the same path answers the issue's comments — the read the
// write-back makes before it posts, so a retry whose comment already landed posts nothing. Any
// other path is a 404 on purpose: a fake that answers more than the client calls would hide a wrong
// URL instead of failing on it (the `github-fake.ts` rule).
//
// The ledger is a file rather than memory so "one comment, not two" survives across the driver's
// phases, and so the evidence is something a later reader can open: it holds every request the
// write-back made — method, path, `Authorization`, the ADF body — and the comments that now exist.
//
//   JIRA_FAKE_PORT              port to listen on (default 9412)
//   JIRA_FAKE_LEDGER            ledger file path, required
//   JIRA_FAKE_FAIL_AFTER_WRITE  an issue key: for that issue's FIRST comment, record it and then
//                               answer 500 instead of 201 — the window where Jira has the comment
//                               and the caller never learned it, which a retry must not turn into a
//                               second comment
import { readFileSync, writeFileSync } from "node:fs";

type Comment = {
  readonly id: string;
  readonly issue: string;
  readonly body: unknown;
};

type Ledger = {
  readonly requests: ReadonlyArray<{
    readonly method: string;
    readonly path: string;
    readonly authorization: string | undefined;
  }>;
  readonly comments: ReadonlyArray<Comment>;
};

const port = Number(process.env["JIRA_FAKE_PORT"] ?? "9412");
const failAfterWrite = process.env["JIRA_FAKE_FAIL_AFTER_WRITE"] ?? "";
const ledgerPath = process.env["JIRA_FAKE_LEDGER"];

if (ledgerPath === undefined || ledgerPath === "") {
  console.error("JIRA_FAKE_LEDGER is required: the ledger is the evidence");
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

const commentRoute = /^\/rest\/api\/3\/issue\/([^/]+)\/comment$/;

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
    });
    write(ledger);

    const match = commentRoute.exec(url.pathname);
    if (match === null) {
      return json(404, { errorMessages: ["not found"] });
    }
    const issue = match[1] ?? "";

    if (request.method === "GET") {
      return json(200, {
        comments: ledger.comments.filter((comment) => comment.issue === issue),
      });
    }
    if (request.method !== "POST") {
      return json(405, { errorMessages: ["method not allowed"] });
    }

    // The client posts `{ body: <ADF> }`; Jira's own comment resource is the ADF document, so the
    // ledger stores the inner body — otherwise a GET would answer a shape no client sends.
    const payload: unknown = await request.json().catch(() => null);
    const body =
      typeof payload === "object" && payload !== null && "body" in payload
        ? (payload as { body: unknown }).body
        : payload;
    const comment: Comment = {
      id: String(20_001 + ledger.comments.length),
      issue,
      body,
    };
    write({ ...ledger, comments: [...ledger.comments, comment] });
    if (
      failAfterWrite !== "" &&
      failAfterWrite === issue &&
      ledger.comments.filter((existing) => existing.issue === issue).length ===
        0
    ) {
      // The comment is on the issue; the caller sees a failure and will retry.
      return json(500, { errorMessages: ["internal server error"] });
    }
    return json(201, {
      id: comment.id,
      self: `http://127.0.0.1:${port}/rest/api/3/issue/${issue}/comment/${comment.id}`,
    });
  },
});

console.log(`jira-fake listening on http://127.0.0.1:${server.port}`);
