// The loopback sinks the notifier is driven against (S-notifications, F21): a Slack incoming
// webhook, an ntfy server, a Web Push service and an SMTP server, in one process, with one ledger on
// disk.
//
// Three HTTP routes, because the notifier makes exactly three kinds of call: `POST /slack/<anything>`
// is the webhook (a Slack webhook URL is a path under hooks.slack.com, so the drive's URL carries a
// path too), `POST /` is ntfy's JSON publish, the topic in the body, and `POST /push/<anything>` is a
// push service's subscription endpoint (answered `201`, the body kept as it arrived: encrypted, for
// the drive — which holds the subscription's private key — to read). Any other path is a 404 on
// purpose: a fake that answered more than the client calls would hide a wrong URL instead of failing
// on it. With `NOTIFY_FAKE_SMTP_PORT` set it also listens for SMTP and records each message
// (envelope, headers, decoded text) as an `email` entry.
//
// The ledger is a file so "exactly one message, and none after a restart" is countable across the
// drive's phases and the API processes, and so the evidence outlives the drive: every message the
// API sent, which sink it reached, the body as sent, and the `Authorization` it carried.
//
//   NOTIFY_FAKE_PORT       port to listen on (default 9447)
//   NOTIFY_FAKE_SMTP_PORT  also listen for SMTP on this port (off when unset)
//   NOTIFY_FAKE_LEDGER     ledger file path, required
import { readFileSync, writeFileSync } from "node:fs";
import net from "node:net";

type Received = {
  readonly sink: "slack" | "ntfy" | "push" | "email";
  readonly path: string;
  readonly authorization: string | undefined;
  /** JSON for Slack and ntfy; for a push, `{encoding, base64}` of the encrypted body; for email, the message. */
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

/** Append one received message to the ledger. Synchronous, so it is on disk before it is acknowledged. */
const record = (message: Omit<Received, "at">): void => {
  const before = read();
  write({
    ...before,
    messages: [
      ...before.messages,
      { ...message, at: new Date().toISOString() },
    ],
  });
};

const smtpPort = process.env["NOTIFY_FAKE_SMTP_PORT"];
if (smtpPort !== undefined && smtpPort !== "") {
  // Just enough ESMTP to take a message: EHLO, MAIL, RCPT, DATA, QUIT.
  net
    .createServer((socket) => {
      let buffer = "";
      let from = "";
      const to: string[] = [];
      let inData = false;
      const reply = (line: string) => socket.write(`${line}\r\n`);
      socket.on("error", () => undefined);
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        for (;;) {
          if (inData) {
            const end = buffer.indexOf("\r\n.\r\n");
            if (end < 0) return;
            const data = buffer.slice(0, end).replace(/^\.\./gm, ".");
            buffer = buffer.slice(end + 5);
            const [head = "", encoded = ""] = data.split("\r\n\r\n");
            record({
              sink: "email",
              path: "smtp",
              authorization: undefined,
              body: {
                from,
                to: [...to],
                subject: /^Subject: (.*)$/m.exec(head)?.[1],
                text: Buffer.from(
                  encoded.replace(/\r\n/g, ""),
                  "base64",
                ).toString("utf8"),
              },
            });
            inData = false;
            to.length = 0;
            reply("250 queued");
            continue;
          }
          const end = buffer.indexOf("\r\n");
          if (end < 0) return;
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const verb = line.split(" ")[0]?.toUpperCase();
          if (verb === "EHLO") reply("250-notify-fake\r\n250 8BITMIME");
          else if (verb === "MAIL") {
            from = /<(.*)>/.exec(line)?.[1] ?? "";
            reply("250 ok");
          } else if (verb === "RCPT") {
            to.push(/<(.*)>/.exec(line)?.[1] ?? "");
            reply("250 ok");
          } else if (verb === "DATA") {
            inData = true;
            reply("354 end with <CRLF>.<CRLF>");
          } else if (verb === "QUIT") {
            reply("221 bye");
            socket.end();
            return;
          } else reply("502 not implemented");
        }
      });
      reply("220 notify-fake ESMTP");
    })
    .listen(Number(smtpPort), "127.0.0.1", () => {
      console.log(`notify-fake SMTP listening on 127.0.0.1:${smtpPort}`);
    });
}

const server = Bun.serve({
  port,
  hostname: "127.0.0.1",
  async fetch(request) {
    const url = new URL(request.url);
    const sink =
      request.method === "POST" && url.pathname.startsWith("/slack/")
        ? "slack"
        : request.method === "POST" && url.pathname.startsWith("/push/")
          ? "push"
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
    if (sink === "push") {
      // A push service's endpoint: the body is RFC 8291's encrypted record, which only the browser can read.
      record({
        sink,
        path: url.pathname,
        authorization: request.headers.get("authorization") ?? undefined,
        body: {
          encoding: request.headers.get("content-encoding"),
          base64: Buffer.from(await request.arrayBuffer()).toString("base64"),
        },
      });
      return new Response(null, { status: 201 });
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
