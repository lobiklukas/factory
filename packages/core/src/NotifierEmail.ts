/**
 * The email sink (F21): a notification as one plain-text message over SMTP, to one person's address.
 *
 * The factory sends mail through an SMTP server the operator names (`NOTIFY_SMTP_URL`, with
 * `NOTIFY_SMTP_FROM` as the sender): `smtps://` is TLS from the first byte, `smtp://` upgrades with
 * STARTTLS whenever the server offers it. A password never crosses a connection that is not
 * encrypted — unless the server is on this machine — so a server that offers no TLS and is asked to
 * authenticate is a failed send, not a plaintext login. The client is the one command sequence the
 * notifier needs (`EHLO`, `STARTTLS`, `AUTH`, `MAIL`, `RCPT`, `DATA`, `QUIT`) written over `node:net`,
 * not a general mail library: there is one message, one recipient, and no attachment.
 *
 * Tests and drives point it at a loopback fake SMTP server (`docs/testing-third-parties.md`), never
 * at a real mail provider.
 *
 * **What a message carries.** The title is the subject, the body and the link the text, UTF-8 and
 * base64 so no line is ever long or starts with a dot. A header can never be injected from a
 * notification: control characters are stripped from the subject and an address with one, or with
 * anything an address is not made of, is refused before a connection opens. The `Message-ID` is a
 * digest of the event and the recipient, so a retry of one delivery is the same message to a mail
 * client.
 */
/* oxlint-disable effecttsgo/async-function effecttsgo/new-promise effecttsgo/extends-native-error -- the SMTP client is one callback-driven socket conversation (net/tls events into awaited replies); it runs inside `Effect.tryPromise` below, which owns its interruption and its error mapping. */
import { createHash } from "node:crypto";
import net from "node:net";
import tls from "node:tls";
import { DateTime, Effect, Redacted } from "effect";
import {
  type Notification,
  type NotificationSink,
  NotifyError,
} from "./Notifier";

/** An SMTP server and how to talk to it. */
export type SmtpConfig = {
  readonly host: string;
  readonly port: number;
  /** TLS from the first byte (`smtps://`, port 465); otherwise STARTTLS when the server offers it. */
  readonly secure: boolean;
  readonly user?: string;
  readonly password?: Redacted.Redacted<string>;
  /** The name `EHLO` gives. */
  readonly clientName: string;
  /** Extra TLS options (a private CA). Certificates are always verified; there is no way to turn that off. */
  readonly tls?: Pick<tls.ConnectionOptions, "ca">;
};

/** One message: a sender, one recipient, a subject and a plain-text body. */
export type Mail = {
  readonly from: string;
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  /** Stable per event and recipient: the `Message-ID`'s local part is derived from it. */
  readonly key: string;
};

export type MailTransport = (mail: Mail) => Effect.Effect<void, NotifyError>;

const DEFAULT_SMTP_PORT = 587;
const DEFAULT_SMTPS_PORT = 465;
/** How long one step of the conversation may wait for the server before the send fails. */
const STEP_TIMEOUT_MS = 15_000;

/**
 * An address a message may be sent to or from: one `local@domain`, with nothing in it a header or an
 * envelope could be broken with — no whitespace, control character, quote, bracket, comma or
 * semicolon — and a dot in the domain.
 */
const ADDRESS =
  /^[^\s\p{Cc}<>()[\]\\,;:"@]+@[^\s\p{Cc}<>()[\]\\,;:"@.]+(?:\.[^\s\p{Cc}<>()[\]\\,;:"@.]+)+$/u;

export const isEmailAddress = (text: string): boolean =>
  text.length <= 254 && ADDRESS.test(text);

const isLoopback = (host: string): boolean =>
  host === "localhost" || host === "::1" || host.startsWith("127.");

/**
 * Read `NOTIFY_SMTP_URL`: `smtp://[user:password@]host[:587]` or `smtps://…[:465]`. A URL that is
 * not one of those is refused with what is wrong and none of what it holds — the password is in it.
 */
export const parseSmtpUrl = (
  raw: Redacted.Redacted<string>,
  clientName: string,
): Effect.Effect<SmtpConfig, NotifyError> => {
  const refuse = (message: string) =>
    Effect.fail(
      new NotifyError({
        sink: "config",
        message: `NOTIFY_SMTP_URL ${message}`,
      }),
    );
  let url: URL;
  try {
    url = new URL(Redacted.value(raw));
  } catch {
    return refuse("is not a URL: expected smtp://[user:password@]host[:port]");
  }
  if (url.protocol !== "smtp:" && url.protocol !== "smtps:") {
    return refuse("must start with smtp:// or smtps://");
  }
  if (url.hostname === "") return refuse("names no host");
  const secure = url.protocol === "smtps:";
  const port =
    url.port === ""
      ? secure
        ? DEFAULT_SMTPS_PORT
        : DEFAULT_SMTP_PORT
      : Number(url.port);
  const user = decodeURIComponent(url.username);
  return Effect.succeed({
    host: url.hostname.replace(/^\[|\]$/g, ""),
    port,
    secure,
    clientName,
    ...(user === ""
      ? {}
      : {
          user,
          password: Redacted.make(decodeURIComponent(url.password)),
        }),
  });
};

/** A subject, as RFC 2047 encoded words when it is not plain printable ASCII. */
export const encodeSubject = (subject: string): string => {
  const flat = subject.replace(/[\p{Cc}\s]+/gu, " ").trim();
  if (/^[\x20-\x7e]*$/.test(flat)) return flat;
  const words: string[] = [];
  let chunk = "";
  for (const char of flat) {
    // 45 bytes of UTF-8 are 60 base64 characters, which keeps an encoded word under 75.
    if (Buffer.byteLength(chunk + char) > 45) {
      words.push(chunk);
      chunk = "";
    }
    chunk += char;
  }
  if (chunk !== "") words.push(chunk);
  return words
    .map(
      (word) => `=?UTF-8?B?${Buffer.from(word, "utf8").toString("base64")}?=`,
    )
    .join("\r\n ");
};

const domainOf = (address: string): string =>
  address.slice(address.lastIndexOf("@") + 1);

/** The message as it goes after `DATA`: CRLF lines, dot-stuffed, without the closing `.`. */
export const composeMail = (mail: Mail, now: Date): string => {
  const id = createHash("sha256").update(mail.key).digest("hex").slice(0, 32);
  const body = Buffer.from(
    mail.text.replace(/\r?\n/g, "\r\n"),
    "utf8",
  ).toString("base64");
  const lines = [
    `From: ${mail.from}`,
    `To: ${mail.to}`,
    `Subject: ${encodeSubject(mail.subject)}`,
    `Date: ${now.toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: <${id}@${domainOf(mail.from)}>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    ...(body.match(/.{1,76}/g) ?? []),
  ];
  return lines.map((line) => line.replace(/^\./, "..")).join("\r\n");
};

/** One reply: the code, and every line's text after it. */
type Reply = { readonly code: number; readonly text: string };

/** A conversation with a server that refused a step, said in the server's own words. */
class SmtpFailure extends Error {}

/** Lines from a socket, joined into whole replies (`250-…` continues, `250 …` ends one). */
const replyReader = (socket: net.Socket) => {
  let buffered = "";
  let current: string[] = [];
  const replies: Reply[] = [];
  const waiting: Array<(reply: Reply | Error) => void> = [];
  let broken: Error | undefined;
  const deliver = (reply: Reply) => {
    const next = waiting.shift();
    if (next === undefined) replies.push(reply);
    else next(reply);
  };
  socket.on("data", (data) => {
    buffered += data.toString("utf8");
    for (;;) {
      const end = buffered.indexOf("\r\n");
      if (end < 0) return;
      const line = buffered.slice(0, end);
      buffered = buffered.slice(end + 2);
      const match = /^(\d{3})([ -])(.*)$/.exec(line);
      if (match === null) continue;
      current.push(match[3] ?? "");
      if (match[2] === " ") {
        deliver({ code: Number(match[1]), text: current.join("\n") });
        current = [];
      }
    }
  });
  const fail = (cause: Error) => {
    broken ??= cause;
    for (const next of waiting.splice(0)) next(cause);
  };
  socket.on("error", fail);
  socket.on("close", () => fail(new SmtpFailure("the connection closed")));
  socket.on("timeout", () =>
    fail(new SmtpFailure("the server did not answer in time")),
  );
  return {
    next: (): Promise<Reply> =>
      new Promise((resolve, reject) => {
        const ready = replies.shift();
        if (ready !== undefined) return resolve(ready);
        if (broken !== undefined) return reject(broken);
        waiting.push((reply) =>
          reply instanceof Error ? reject(reply) : resolve(reply),
        );
      }),
  };
};

/**
 * Open the connection. The caller's `signal` and the step timeout both destroy the half-open socket,
 * so a host that drops packets holds neither a socket nor the notifier's claim past the send timeout.
 */
const connect = (
  config: SmtpConfig,
  signal: AbortSignal,
): Promise<net.Socket> =>
  new Promise((resolve, reject) => {
    if (signal.aborted)
      return reject(new SmtpFailure("the send was cancelled"));
    const socket = config.secure
      ? tls.connect({
          ...config.tls,
          host: config.host,
          port: config.port,
          servername: config.host,
        })
      : net.connect({ host: config.host, port: config.port });
    const readyEvent = config.secure ? "secureConnect" : "connect";
    const settle = () => {
      signal.removeEventListener("abort", onAbort);
      socket.removeListener("timeout", onTimeout);
      socket.removeListener("error", onError);
      socket.removeListener(readyEvent, onReady);
    };
    const giveUp = (cause: Error) => {
      settle();
      // Nothing listens for an error after this, and a destroyed socket may still raise one.
      socket.on("error", () => undefined);
      socket.destroy();
      reject(cause);
    };
    const onAbort = () => giveUp(new SmtpFailure("the send was cancelled"));
    const onTimeout = () =>
      giveUp(
        new SmtpFailure("the server did not accept the connection in time"),
      );
    const onError = (cause: Error) => giveUp(cause);
    const onReady = () => {
      settle();
      resolve(socket);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    socket.setTimeout(STEP_TIMEOUT_MS);
    socket.once("timeout", onTimeout);
    socket.once(readyEvent, onReady);
    socket.once("error", onError);
  });

/** One delivery over a fresh connection, closed when the conversation ends either way. */
const deliver = async (
  config: SmtpConfig,
  mail: Mail,
  now: Date,
  signal: AbortSignal,
): Promise<void> => {
  let socket = await connect(config, signal);
  const abort = () => socket.destroy();
  signal.addEventListener("abort", abort, { once: true });
  try {
    let reader = replyReader(socket);
    const accept = async (accepted: ReadonlyArray<number>, step: string) => {
      const reply = await reader.next();
      if (!accepted.includes(reply.code)) {
        throw new SmtpFailure(
          `${step}: the server answered ${reply.code} ${reply.text.slice(0, 200)}`,
        );
      }
      return reply;
    };
    const say = (line: string) => {
      socket.write(`${line}\r\n`);
    };

    await accept([220], "the greeting");
    say(`EHLO ${config.clientName}`);
    let hello = await accept([250], "EHLO");
    let encrypted = config.secure;
    if (!encrypted && /^STARTTLS$/im.test(hello.text)) {
      say("STARTTLS");
      await accept([220], "STARTTLS");
      socket.removeAllListeners("data");
      socket = tls.connect({
        ...config.tls,
        socket,
        servername: config.host,
      });
      await new Promise<void>((resolve, reject) => {
        socket.once("secureConnect", () => resolve());
        socket.once("error", reject);
      });
      socket.setTimeout(STEP_TIMEOUT_MS);
      reader = replyReader(socket);
      say(`EHLO ${config.clientName}`);
      hello = await accept([250], "EHLO after STARTTLS");
      encrypted = true;
    }
    if (config.user !== undefined && config.password !== undefined) {
      if (!encrypted && !isLoopback(config.host)) {
        throw new SmtpFailure(
          "the server offers no TLS, so the password was not sent",
        );
      }
      const password = Redacted.value(config.password);
      const plain = Buffer.from(
        `\0${config.user}\0${password}`,
        "utf8",
      ).toString("base64");
      say(`AUTH PLAIN ${plain}`);
      await accept([235], "AUTH");
    }
    say(`MAIL FROM:<${mail.from}>`);
    await accept([250], "MAIL FROM");
    say(`RCPT TO:<${mail.to}>`);
    await accept([250, 251], "RCPT TO");
    say("DATA");
    await accept([354], "DATA");
    socket.write(`${composeMail(mail, now)}\r\n.\r\n`);
    await accept([250], "the message");
    say("QUIT");
    // Best effort: the message is accepted, so a server that hangs up without answering is no failure.
    await reader.next().catch(() => undefined);
  } finally {
    signal.removeEventListener("abort", abort);
    socket.destroy();
  }
};

/** What went wrong in words that carry no password: the server's replies, or the socket's error. */
const describeFailure = (cause: unknown): string => {
  if (cause instanceof SmtpFailure) return cause.message;
  const code = (cause as { code?: unknown } | null)?.code;
  return typeof code === "string"
    ? `the SMTP server could not be reached (${code})`
    : "the SMTP server could not be reached";
};

/** Send mail through `config`. A failure is a `NotifyError` that names the step, never the login. */
export const smtpTransport =
  (config: SmtpConfig): MailTransport =>
  (mail) =>
    Effect.flatMap(DateTime.nowAsDate, (now) =>
      Effect.tryPromise({
        try: (signal) => deliver(config, mail, now, signal),
        catch: (cause) =>
          new NotifyError({
            sink: "email",
            message: `email to ${domainOf(mail.to)}: ${describeFailure(cause)}`,
          }),
      }),
    );

/** A short, stable, one-way name: the ledger key must not carry an address. */
const fingerprint = (value: string): string =>
  createHash("sha256").update(value).digest("hex").slice(0, 16);

/**
 * One person's address as a sink: its id is a digest of the address, so two people who share a
 * mailbox are one destination with one message per event, and removing an address and adding it
 * back is not a new destination. The label names the domain only, which is what a log line says.
 */
export const emailSink = (options: {
  readonly transport: MailTransport;
  readonly from: string;
  readonly to: string;
}): NotificationSink => ({
  id: `email:${fingerprint(options.to.toLowerCase())}`,
  label: `an email address at ${domainOf(options.to)}`,
  send: (notification: Notification) =>
    options.transport({
      from: options.from,
      to: options.to,
      subject: notification.title,
      text: `${notification.body}\n\nOpen in factory: ${notification.link}\n`,
      key: `${notification.eventId}\n${options.to.toLowerCase()}`,
    }),
});
