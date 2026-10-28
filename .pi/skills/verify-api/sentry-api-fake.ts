// The loopback Sentry REST API the link-back is driven against (LOB-83).
//
// Two routes, because the write-back uses two: `GET` and `POST /api/0/issues/{issue_id}/comments/`
// (an issue's notes: the read the write-back checks before it posts, and the create). Any other
// path is a 404, so a client that started calling another route would fail here instead of being
// answered by a fake that guessed. Issues exist on first sight, with no notes.
//
// Sentry's webhooks come *from* Sentry (LOB-81's drive is the sender); this is the other direction,
// the one place the factory calls Sentry. The ledger is a file rather than memory so "one note, not
// two" is a countable fact a later reader can open: every request (method, path, `Authorization`,
// body) and every issue's notes, in order.
//
//   SENTRY_FAKE_PORT       port to listen on (default 9417)
//   SENTRY_FAKE_LEDGER     ledger file path, required
//   SENTRY_FAKE_TOKEN      when set, a request without `Authorization: Bearer <token>` is a 401
//   SENTRY_FAKE_LOSE_ACK   an issue id: its FIRST note create is applied and the connection is then
//                          dropped — Sentry has the note, the caller never learned it, and a retry
//                          must not turn that into a second note
//   SENTRY_FAKE_FAIL       an issue id: every request for it is answered 503 and applies nothing
//   SENTRY_FAKE_HANG       an issue id: a request for it is never answered, so the caller's time
//                          budget is what ends it
import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";

type Ledger = {
  readonly requests: Array<{
    readonly method: string;
    readonly path: string;
    readonly authorization: string | null;
    readonly body: unknown;
  }>;
  /** Each issue's notes, oldest first. */
  readonly issues: Record<string, { readonly notes: string[] }>;
  /** The issues whose note landed and whose connection was then dropped: the window a retry closes. */
  readonly lostAcks: string[];
};

const port = Number(process.env["SENTRY_FAKE_PORT"] ?? "9417");
const ledgerPath = process.env["SENTRY_FAKE_LEDGER"];
const token = process.env["SENTRY_FAKE_TOKEN"] ?? "";
const loseAck = process.env["SENTRY_FAKE_LOSE_ACK"] ?? "";
const failIssue = process.env["SENTRY_FAKE_FAIL"] ?? "";
const hangIssue = process.env["SENTRY_FAKE_HANG"] ?? "";

if (ledgerPath === undefined || ledgerPath === "") {
  console.error("SENTRY_FAKE_LEDGER is required: the ledger is the evidence");
  process.exit(1);
}

const empty: Ledger = { requests: [], issues: {}, lostAcks: [] };

const read = (): Ledger => {
  try {
    return JSON.parse(readFileSync(ledgerPath, "utf8")) as Ledger;
  } catch {
    return empty;
  }
};

/** Synchronous, so a write is on disk before its response is. */
const write = (ledger: Ledger): void => {
  writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
};

write(empty);

const lost = new Set<string>();
const ROUTE = /^\/api\/0\/issues\/([^/]+)\/comments\/$/;

const server = createServer((request, response) => {
  const chunks: Buffer[] = [];
  request.on("data", (chunk: Buffer) => chunks.push(chunk));
  request.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf8");
    let body: unknown = undefined;
    try {
      body = raw === "" ? undefined : JSON.parse(raw);
    } catch {
      body = raw;
    }
    const path = new URL(request.url ?? "/", "http://fake").pathname;
    const method = request.method ?? "GET";
    const send = (status: number, payload: unknown): void => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(payload));
    };

    const ledger = read();
    ledger.requests.push({
      method,
      path,
      authorization: request.headers["authorization"] ?? null,
      body,
    });
    const route = ROUTE.exec(path);
    if (route === null) {
      write(ledger);
      return send(404, { detail: "not a Sentry API route this fake serves" });
    }
    const issueId = decodeURIComponent(route[1] ?? "");
    if (
      token !== "" &&
      request.headers["authorization"] !== `Bearer ${token}`
    ) {
      write(ledger);
      return send(401, { detail: "Invalid token" });
    }
    if (issueId === hangIssue) {
      // Recorded, never answered: the caller's budget is the only thing that ends this request.
      write(ledger);
      return;
    }
    if (issueId === failIssue) {
      write(ledger);
      return send(503, { detail: "upstream unavailable" });
    }
    const issue = (ledger.issues[issueId] ??= { notes: [] });

    if (method === "GET") {
      write(ledger);
      // Newest first, each as the activity Sentry serializes a note as.
      return send(
        200,
        [...issue.notes].reverse().map((text, index) => ({
          id: String(issue.notes.length - index),
          type: "note",
          data: { text },
          user: { name: "factory" },
        })),
      );
    }
    if (method !== "POST") {
      write(ledger);
      return send(405, { detail: "method not allowed" });
    }

    const text = (body as { readonly text?: unknown } | undefined)?.text;
    issue.notes.push(String(text));
    if (issueId === loseAck && !lost.has(issueId)) {
      lost.add(issueId);
      ledger.lostAcks.push(issueId);
      write(ledger);
      // The note is applied; the connection dies before the answer.
      request.socket.destroy();
      return;
    }
    write(ledger);
    return send(201, {
      id: String(issue.notes.length),
      type: "note",
      data: { text },
    });
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`sentry api fake listening on http://127.0.0.1:${port}`);
});
