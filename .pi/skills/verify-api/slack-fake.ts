// The loopback Slack the adapter is driven against (LOB-191).
//
// Two routes, because the write-back calls exactly two:
// `GET /api/conversations.replies?channel&ts` answers a thread's messages (the read the write-back
// makes before it replies, so a retry whose reply already landed posts nothing) and
// `POST /api/chat.postMessage` creates one. Any other path is a 404 on purpose: a fake that answers
// more than the client calls would hide a wrong URL instead of failing on it (the
// `github-issues-fake.ts` rule). Slack answers `200 {ok: false, error}` for a logical refusal, so
// the fake does too when it is told to — that shape is what the client has to look at.
//
// The ledger is a file rather than memory so "one reply, not two" survives across the driver's
// phases, and so the evidence is something a later reader can open: every request the write-back
// made — method, path, query, `Authorization` — and the replies that now exist.
//
//   SLACK_FAKE_PORT              port to listen on (default 9414)
//   SLACK_FAKE_LEDGER            ledger file path, required
//   SLACK_FAKE_FAIL_AFTER_WRITE  a thread root `ts`: for that thread's FIRST reply, record it and
//                                then answer 500 instead of 200 — the window where Slack has the
//                                reply and the caller never learned it, which a retry must not turn
//                                into a second reply
//   SLACK_FAKE_REFUSE_WRITE      `true`: answer `200 {ok: false, error: "not_in_channel"}`, which is
//                                how Slack refuses a reply, so the client's ok check is exercised
import { readFileSync, writeFileSync } from "node:fs";

type Reply = {
  readonly ts: string;
  readonly channel: string;
  readonly root: string;
  readonly text: string;
};

type Ledger = {
  readonly requests: ReadonlyArray<{
    readonly method: string;
    readonly path: string;
    readonly query: string;
    readonly authorization: string | undefined;
  }>;
  readonly replies: ReadonlyArray<Reply>;
};

const port = Number(process.env["SLACK_FAKE_PORT"] ?? "9414");
const failAfterWrite = process.env["SLACK_FAKE_FAIL_AFTER_WRITE"] ?? "";
const refuseWrite = process.env["SLACK_FAKE_REFUSE_WRITE"] === "true";
const ledgerPath = process.env["SLACK_FAKE_LEDGER"];

if (ledgerPath === undefined || ledgerPath === "") {
  console.error("SLACK_FAKE_LEDGER is required: the ledger is the evidence");
  process.exit(1);
}

const empty: Ledger = { requests: [], replies: [] };

const read = (): Ledger => {
  try {
    return JSON.parse(readFileSync(ledgerPath, "utf8")) as Ledger;
  } catch {
    return empty;
  }
};

/** Synchronous, so a reply is on disk before its response is. */
const write = (ledger: Ledger): void => {
  writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
};

write(empty);

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const server = Bun.serve({
  port,
  hostname: "127.0.0.1",
  async fetch(request) {
    const url = new URL(request.url);
    // Recorded before anything is answered, so the ledger holds every request that arrived.
    const before = read();
    const ledger: Ledger = {
      ...before,
      requests: [
        ...before.requests,
        {
          method: request.method,
          path: url.pathname,
          query: url.searchParams.toString(),
          authorization: request.headers.get("authorization") ?? undefined,
        },
      ],
    };
    write(ledger);

    if (url.pathname === "/api/conversations.replies") {
      if (request.method !== "GET") {
        return json(405, { ok: false, error: "method_not_allowed" });
      }
      const channel = url.searchParams.get("channel") ?? "";
      const root = url.searchParams.get("ts") ?? "";
      return json(200, {
        ok: true,
        messages: ledger.replies
          .filter((reply) => reply.channel === channel && reply.root === root)
          .map((reply) => ({ ts: reply.ts, text: reply.text })),
      });
    }

    if (url.pathname === "/api/chat.postMessage") {
      if (request.method !== "POST") {
        return json(405, { ok: false, error: "method_not_allowed" });
      }
      if (refuseWrite) {
        return json(200, { ok: false, error: "not_in_channel" });
      }
      const payload: unknown = await request.json().catch(() => null);
      const body =
        typeof payload === "object" && payload !== null
          ? (payload as Record<string, unknown>)
          : {};
      const reply: Reply = {
        ts: `1700000100.${String(100_000 + ledger.replies.length)}`,
        channel: typeof body["channel"] === "string" ? body["channel"] : "",
        root: typeof body["thread_ts"] === "string" ? body["thread_ts"] : "",
        text: typeof body["text"] === "string" ? body["text"] : "",
      };
      write({ ...ledger, replies: [...ledger.replies, reply] });
      const already = ledger.replies.filter(
        (existing) =>
          existing.channel === reply.channel && existing.root === reply.root,
      ).length;
      if (
        failAfterWrite !== "" &&
        reply.root === failAfterWrite &&
        already === 0
      ) {
        // The reply is in the thread; the caller sees a failure and will retry.
        return json(500, { ok: false, error: "internal_error" });
      }
      return json(200, { ok: true, ts: reply.ts });
    }

    return json(404, { ok: false, error: "unknown_method" });
  },
});

console.log(`slack-fake listening on http://127.0.0.1:${server.port}`);
