// The loopback sinks the notifier is driven against (S-notifications): a Slack incoming webhook and
// an ntfy server, in one process, with one ledger on disk.
//
// Two routes, because the notifier makes exactly two calls: `POST /slack/<anything>` is the webhook
// (a Slack webhook URL is a path under hooks.slack.com, so the drive's URL carries a path too) and
// `POST /` is ntfy's JSON publish, the topic in the body. Any other path is a 404 on purpose: a fake
// that answered more than the client calls would hide a wrong URL instead of failing on it.
//
// The ledger is a file so "exactly one message, and none after a restart" is countable across the
// drive's phases and the API processes, and so the evidence outlives the drive: every message the
// API sent, which sink it reached, the body as sent, and the `Authorization` it carried.
//
//   NOTIFY_FAKE_PORT    port to listen on (default 9447)
//   NOTIFY_FAKE_LEDGER  ledger file path, required
import { readFileSync, writeFileSync } from "node:fs";

type Received = {
  readonly sink: "slack" | "ntfy";
  readonly path: string;
  readonly authorization: string | undefined;
  readonly body: unknown;
  readonly at: string;
};

type Ledger = {
  readonly messages: ReadonlyArray<Received>;
  readonly refused: ReadonlyArray<{
    readonly method: string;
    readonly path: string;
  }>;
};

const port = Number(process.env["NOTIFY_FAKE_PORT"] ?? "9447");
const ledgerPath = process.env["NOTIFY_FAKE_LEDGER"];

if (ledgerPath === undefined || ledgerPath === "") {
  console.error("NOTIFY_FAKE_LEDGER is required: the ledger is the evidence");
  process.exit(1);
}

const empty: Ledger = { messages: [], refused: [] };

const read = (): Ledger => {
  try {
    return JSON.parse(readFileSync(ledgerPath, "utf8")) as Ledger;
  } catch {
    return empty;
  }
};

/** Synchronous, so a message is on disk before its acknowledgement is. */
const write = (ledger: Ledger): void => {
  writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
};

write(empty);

const server = Bun.serve({
  port,
  hostname: "127.0.0.1",
  async fetch(request) {
    const url = new URL(request.url);
    const sink =
      request.method === "POST" && url.pathname.startsWith("/slack/")
        ? "slack"
        : request.method === "POST" && url.pathname === "/"
          ? "ntfy"
          : undefined;
    const before = read();
    if (sink === undefined) {
      write({
        ...before,
        refused: [
          ...before.refused,
          { method: request.method, path: url.pathname },
        ],
      });
      return new Response("not found", { status: 404 });
    }
    const body: unknown = await request.json().catch(() => null);
    write({
      ...before,
      messages: [
        ...before.messages,
        {
          sink,
          path: url.pathname,
          authorization: request.headers.get("authorization") ?? undefined,
          body,
          at: new Date().toISOString(),
        },
      ],
    });
    // Slack's webhook answers a bare `ok`; ntfy answers the message it published.
    return sink === "slack"
      ? new Response("ok", { status: 200 })
      : Response.json({ id: `m${before.messages.length}`, event: "message" });
  },
});

console.log(`notify-fake listening on http://127.0.0.1:${server.port}`);
