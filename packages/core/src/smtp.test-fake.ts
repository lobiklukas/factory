/**
 * A fake SMTP server on loopback, for the email sink's tests (docs/testing-third-parties.md): it
 * speaks just enough ESMTP to take a message — `EHLO`, optionally `STARTTLS` and `AUTH PLAIN`,
 * `MAIL FROM`, `RCPT TO`, `DATA`, `QUIT` — records what arrived, and can refuse any one step.
 * Never a real mail provider.
 */
/* oxlint-disable effecttsgo/new-promise -- a node:net server's `listen` and `close` take callbacks. */
import net from "node:net";
import tls from "node:tls";

export type ReceivedMail = {
  readonly from: string;
  readonly to: string[];
  /** The message as the server saw it after `DATA`, dot-unstuffed, CRLF line ends kept. */
  readonly data: string;
  /** The credentials `AUTH PLAIN` carried, when it did. */
  readonly auth:
    | { readonly user: string; readonly password: string }
    | undefined;
  /** Whether the connection was TLS when the message arrived. */
  readonly encrypted: boolean;
};

export type FakeSmtpOptions = {
  /** Answer this to the connection instead of `220`: a server that is down for service. */
  readonly greeting?: string;
  /** Require `AUTH PLAIN` with exactly these, answering `535` to others. */
  readonly credentials?: { readonly user: string; readonly password: string };
  /** Reject `RCPT TO` for an address containing this text, with `550`. */
  readonly rejectRecipient?: string;
  /** Offer `STARTTLS`, upgrading with this key and certificate (PEM). */
  readonly starttls?: { readonly key: string; readonly cert: string };
  /** Be an implicit-TLS (`smtps`) server with this key and certificate. */
  readonly secure?: { readonly key: string; readonly cert: string };
};

export type FakeSmtp = {
  readonly port: number;
  readonly mail: ReceivedMail[];
  /** Every command line the server read, in order, passwords as sent. */
  readonly commands: string[];
  readonly close: () => Promise<void>;
};

const handle = (
  socket: net.Socket,
  options: FakeSmtpOptions,
  state: { readonly mail: ReceivedMail[]; readonly commands: string[] },
  encrypted: boolean,
  greet: boolean,
): void => {
  let buffer = "";
  let from = "";
  let to: string[] = [];
  let auth: ReceivedMail["auth"];
  let data: string | undefined;
  const reply = (line: string) => socket.write(`${line}\r\n`);
  socket.on("error", () => undefined);
  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    for (;;) {
      if (data !== undefined) {
        const end = buffer.indexOf("\r\n.\r\n");
        if (end < 0) return;
        const body = buffer.slice(0, end);
        buffer = buffer.slice(end + 5);
        state.mail.push({
          from,
          to,
          data: body.replace(/^\.\./gm, "."),
          auth,
          encrypted,
        });
        data = undefined;
        from = "";
        to = [];
        reply("250 queued");
        continue;
      }
      const end = buffer.indexOf("\r\n");
      if (end < 0) return;
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      state.commands.push(line);
      const verb = line.split(" ")[0]?.toUpperCase();
      if (verb === "EHLO") {
        const lines = ["250-fake.smtp"];
        if (options.starttls !== undefined && !encrypted)
          lines.push("250-STARTTLS");
        if (options.credentials !== undefined) lines.push("250-AUTH PLAIN");
        lines.push("250 8BITMIME");
        reply(lines.join("\r\n"));
      } else if (verb === "STARTTLS" && options.starttls !== undefined) {
        reply("220 ready to start TLS");
        socket.removeAllListeners("data");
        const secure = new tls.TLSSocket(socket, {
          isServer: true,
          key: options.starttls.key,
          cert: options.starttls.cert,
        });
        handle(secure, options, state, true, false);
      } else if (verb === "AUTH") {
        const [, , encoded = ""] = line.split(" ");
        const [, user = "", password = ""] = Buffer.from(encoded, "base64")
          .toString("utf8")
          .split("\0");
        if (
          options.credentials?.user === user &&
          options.credentials.password === password
        ) {
          auth = { user, password };
          reply("235 authenticated");
        } else {
          reply("535 bad credentials");
        }
      } else if (verb === "MAIL") {
        from = /<(.*)>/.exec(line)?.[1] ?? "";
        reply("250 ok");
      } else if (verb === "RCPT") {
        const address = /<(.*)>/.exec(line)?.[1] ?? "";
        if (
          options.rejectRecipient !== undefined &&
          address.includes(options.rejectRecipient)
        ) {
          reply("550 no such mailbox");
        } else {
          to.push(address);
          reply("250 ok");
        }
      } else if (verb === "DATA") {
        data = "";
        reply("354 end with <CRLF>.<CRLF>");
      } else if (verb === "QUIT") {
        reply("221 bye");
        socket.end();
        return;
      } else {
        reply("502 not implemented");
      }
    }
  });
  if (greet) reply(options.greeting ?? "220 fake.smtp ESMTP");
};

/** Start the fake on a free loopback port. */
export const startFakeSmtp = (
  options: FakeSmtpOptions = {},
): Promise<FakeSmtp> =>
  new Promise((resolve, reject) => {
    const state = { mail: [] as ReceivedMail[], commands: [] as string[] };
    const connections = new Set<net.Socket>();
    const onConnect = (socket: net.Socket) => {
      connections.add(socket);
      socket.on("close", () => connections.delete(socket));
      handle(socket, options, state, options.secure !== undefined, true);
    };
    const server =
      options.secure === undefined
        ? net.createServer(onConnect)
        : tls.createServer(options.secure, onConnect);
    server.on("error", reject);
    server.listen(0, "::", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("the fake SMTP server has no port"));
        return;
      }
      resolve({
        port: address.port,
        mail: state.mail,
        commands: state.commands,
        close: () =>
          new Promise<void>((done) => {
            for (const socket of connections) socket.destroy();
            server.close(() => done());
          }),
      });
    });
  });
