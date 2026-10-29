/**
 * The email sink (F21): what a message looks like on the wire, and what the SMTP client does when a
 * server refuses it. Every case talks to a fake SMTP server on loopback (`./smtp.test-fake`) over the
 * real client — `node:net` and `node:tls` and nothing mocked — so the command sequence, the
 * encoding and the failure messages are the ones a real server would see. No real mail provider.
 */
import { execFileSync } from "node:child_process";
import net from "node:net";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DateTime, Effect, Exit, Redacted } from "effect";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  composeMail,
  emailSink,
  encodeSubject,
  isEmailAddress,
  type Mail,
  parseSmtpUrl,
  smtpTransport,
  type SmtpConfig,
} from "./NotifierEmail";
import type { Notification } from "./Notifier";
import { type FakeSmtp, startFakeSmtp } from "./smtp.test-fake";

const notification: Notification = {
  eventId: "approval:ses_abc:req-1",
  kind: "approval",
  title: 'Approval needed on "Fix the login page"',
  body: "bash: git push --force\nacme/widget",
  link: "http://dash.test/boards/brd_1?card=tsk_1",
};

const servers: FakeSmtp[] = [];
const start = async (options?: Parameters<typeof startFakeSmtp>[0]) => {
  const server = await startFakeSmtp(options);
  servers.push(server);
  return server;
};
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

const configFor = (
  server: FakeSmtp,
  more: Partial<SmtpConfig> = {},
): SmtpConfig => ({
  host: "127.0.0.1",
  port: server.port,
  secure: false,
  clientName: "factory.test",
  ...more,
});

const sinkOver = (config: SmtpConfig, to = "amy@example.test") =>
  emailSink({
    transport: smtpTransport(config),
    from: "factory@example.test",
    to,
  });

/** A header's value from a message, with folded lines joined. */
const header = (data: string, name: string): string | undefined => {
  const head = data.split("\r\n\r\n")[0] ?? "";
  const match = new RegExp(`^${name}: (.*(?:\\r\\n[ \\t].*)*)`, "im").exec(
    head,
  );
  return match?.[1]?.replace(/\r\n[ \t]/g, "");
};

const bodyOf = (data: string): string =>
  Buffer.from(
    (data.split("\r\n\r\n")[1] ?? "").replace(/\r\n/g, ""),
    "base64",
  ).toString("utf8");

const decodeWords = (value: string): string =>
  value.replace(/=\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=\s*/g, (_, b64: string) =>
    Buffer.from(b64, "base64").toString("utf8"),
  );

describe("the message", () => {
  it("is the title as the subject and the body and link as the text", async () => {
    const server = await start();
    await Effect.runPromise(sinkOver(configFor(server)).send(notification));
    expect(server.mail).toHaveLength(1);
    const [mail] = server.mail;
    expect(mail?.from).toBe("factory@example.test");
    expect(mail?.to).toEqual(["amy@example.test"]);
    expect(header(mail?.data ?? "", "Subject")).toBe(notification.title);
    expect(header(mail?.data ?? "", "To")).toBe("amy@example.test");
    expect(header(mail?.data ?? "", "Content-Type")).toBe(
      "text/plain; charset=utf-8",
    );
    expect(bodyOf(mail?.data ?? "")).toBe(
      `${notification.body.replace(/\n/g, "\r\n")}\r\n\r\nOpen in factory: ${notification.link}\r\n`,
    );
    // The client said who it is and spoke the whole sequence, in order.
    expect(server.commands.map((line) => line.split(" ")[0])).toEqual([
      "EHLO",
      "MAIL",
      "RCPT",
      "DATA",
      "QUIT",
    ]);
    expect(server.commands[0]).toBe("EHLO factory.test");
  });

  it("encodes a subject that is not ASCII as RFC 2047 words that read back whole", async () => {
    const title = `Dotaz na kartě "Oprava přihlášení" ${"ž".repeat(60)}`;
    const server = await start();
    await Effect.runPromise(
      sinkOver(configFor(server)).send({ ...notification, title }),
    );
    const subject = header(server.mail[0]?.data ?? "", "Subject") ?? "";
    expect(subject).toContain("=?UTF-8?B?");
    expect(decodeWords(subject)).toBe(title);
    // Folded into encoded words, none past RFC 2047's 75 characters.
    for (const word of subject.match(/=\?UTF-8\?B\?[^?]+\?=/g) ?? []) {
      expect(word.length).toBeLessThanOrEqual(75);
    }
  });

  it("cannot be given a header: a title with a line break stays one subject line", async () => {
    const server = await start();
    await Effect.runPromise(
      sinkOver(configFor(server)).send({
        ...notification,
        title: "Run failed\r\nBcc: attacker@example.test",
      }),
    );
    const data = server.mail[0]?.data ?? "";
    expect(header(data, "Subject")).toBe(
      "Run failed Bcc: attacker@example.test",
    );
    expect(header(data, "Bcc")).toBeUndefined();
    expect(server.mail[0]?.to).toEqual(["amy@example.test"]);
  });

  it("is one message to a mail client however often it is retried", () => {
    const mail: Mail = {
      from: "factory@example.test",
      to: "amy@example.test",
      subject: "s",
      text: "t",
      key: "approval:x\namy@example.test",
    };
    const at = DateTime.toDateUtc(
      DateTime.makeUnsafe("2026-10-29T10:00:00.000Z"),
    );
    const id = (m: Mail) => /^Message-ID: (.*)$/m.exec(composeMail(m, at))?.[1];
    expect(id(mail)).toBe(id({ ...mail }));
    expect(id(mail)).not.toBe(
      id({ ...mail, key: "approval:y\namy@example.test" }),
    );
    expect(id(mail)).toMatch(/^<[0-9a-f]{32}@example\.test>$/);
  });

  it("dot-stuffs any line that starts with a dot, so the body cannot end the message", () => {
    const composed = composeMail(
      {
        from: "a@example.test",
        to: "b@example.test",
        subject: "s",
        text: "x",
        key: "k",
      },
      DateTime.toDateUtc(DateTime.makeUnsafe(0)),
    );
    expect(
      composed.split("\r\n").every((line) => !/^\.($|[^.])/.test(line)),
    ).toBe(true);
    expect(encodeSubject("plain subject")).toBe("plain subject");
  });
});

describe("the address", () => {
  it("is one local@domain, and nothing a header or an envelope can be broken with", () => {
    for (const ok of ["amy@example.test", "amy.o+tag@mail.example.test"]) {
      expect(isEmailAddress(ok)).toBe(true);
    }
    for (const bad of [
      "",
      "amy",
      "amy@example",
      "amy@@example.test",
      "amy@example.test\r\nBcc: x@y.test",
      "amy@example.test, bob@example.test",
      "amy@example.test;bob@example.test",
      "<amy@example.test>",
      "amy @example.test",
      '"amy"@example.test',
      `${"a".repeat(250)}@example.test`,
    ]) {
      expect(isEmailAddress(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it("names the domain, never the address, in the sink's id and label", () => {
    const sink = sinkOver(
      { host: "127.0.0.1", port: 1, secure: false, clientName: "x" },
      "Amy@Example.test",
    );
    const same = sinkOver(
      { host: "127.0.0.1", port: 1, secure: false, clientName: "x" },
      "amy@example.test",
    );
    expect(sink.id).toBe(same.id);
    expect(sink.id).not.toContain("amy");
    expect(sink.label).toBe("an email address at Example.test");
    expect(sink.label).not.toContain("amy");
  });
});

describe("a server that refuses", () => {
  it("a recipient is a NotifyError naming the step and the server's words", async () => {
    const server = await start({ rejectRecipient: "nobody" });
    const exit = await Effect.runPromiseExit(
      sinkOver(configFor(server), "nobody@example.test").send(notification),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    const text = String(exit);
    expect(text).toContain("RCPT TO");
    expect(text).toContain("550 no such mailbox");
    expect(server.mail).toEqual([]);
  });

  it("the connection is a NotifyError, and a server that is down for service too", async () => {
    const server = await start();
    const down = configFor(server);
    await server.close();
    const refused = String(
      await Effect.runPromiseExit(sinkOver(down).send(notification)),
    );
    expect(refused).toContain("could not be reached");
    expect(refused).toContain("ECONNREFUSED");

    const busy = await start({ greeting: "554 no service" });
    const greeting = String(
      await Effect.runPromiseExit(sinkOver(configFor(busy)).send(notification)),
    );
    expect(greeting).toContain("the greeting");
    expect(greeting).toContain("554 no service");
  });
});

/* oxlint-disable effecttsgo/new-promise effecttsgo/global-timers -- a node:net server's `listen` and `close` take callbacks, and the case races a socket close against a deadline. */
describe("a server that never finishes connecting", () => {
  it("is cut off with the send: interrupting it closes the half-open socket instead of leaving it to the OS timeout", async () => {
    // A TLS handshake with a server that accepts the TCP connection and never answers is the
    // connect phase hanging, as a host that drops packets would be.
    const accepted: net.Socket[] = [];
    const closed: Promise<void>[] = [];
    const silent = net.createServer((socket) => {
      accepted.push(socket);
      closed.push(
        new Promise((resolve) => socket.once("close", () => resolve())),
      );
      socket.on("error", () => undefined);
      // Read, so the client's hang-up is seen as the end of the stream.
      socket.resume();
    });
    await new Promise<void>((resolve) =>
      silent.listen(0, "127.0.0.1", resolve),
    );
    try {
      const address = silent.address();
      const port =
        typeof address === "object" && address !== null ? address.port : 0;
      const transport = smtpTransport({
        host: "127.0.0.1",
        port,
        secure: true,
        clientName: "factory.test",
      });
      const exit = await Effect.runPromiseExit(
        transport({
          from: "factory@example.test",
          to: "amy@example.test",
          subject: "s",
          text: "t",
          key: "k",
        }).pipe(Effect.timeout(300)),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(accepted).toHaveLength(1);
      // The server sees the client hang up well inside the 15 s step timeout.
      await Promise.race([
        Promise.all(closed),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("the socket was left open")),
            3_000,
          ),
        ),
      ]);
    } finally {
      for (const socket of accepted) socket.destroy();
      await new Promise<void>((resolve) => silent.close(() => resolve()));
    }
  });
});

/* oxlint-enable effecttsgo/new-promise effecttsgo/global-timers */

describe("authentication", () => {
  const credentials = { user: "factory", password: "p@ss/w0rd secret" };

  it("sends AUTH PLAIN to a server on this machine and delivers", async () => {
    const server = await start({ credentials });
    await Effect.runPromise(
      sinkOver(
        configFor(server, {
          user: credentials.user,
          password: Redacted.make(credentials.password),
        }),
      ).send(notification),
    );
    expect(server.mail[0]?.auth).toEqual(credentials);
  });

  it("a wrong password is a failed send that does not repeat the password", async () => {
    const server = await start({ credentials });
    const exit = await Effect.runPromiseExit(
      sinkOver(
        configFor(server, {
          user: "factory",
          password: Redacted.make("not the password"),
        }),
      ).send(notification),
    );
    const text = String(exit);
    expect(text).toContain("535");
    expect(text).not.toContain("not the password");
    expect(text).not.toContain(credentials.password);
    expect(server.mail).toEqual([]);
  });

  it("never sends a password in the clear to a server that is not on this machine", async () => {
    const server = await start({ credentials });
    // The same listener by its IPv4-mapped name, which is not one the client treats as local.
    const exit = await Effect.runPromiseExit(
      sinkOver(
        configFor(server, {
          host: "::ffff:127.0.0.1",
          user: credentials.user,
          password: Redacted.make(credentials.password),
        }),
      ).send(notification),
    );
    expect(String(exit)).toContain("the password was not sent");
    expect(server.commands.some((line) => line.startsWith("AUTH"))).toBe(false);
    expect(server.mail).toEqual([]);
  });
});

describe("TLS", () => {
  const dir = mkdtempSync(join(tmpdir(), "factory-smtp-"));
  const pem = (() => {
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        join(dir, "key.pem"),
        "-out",
        join(dir, "cert.pem"),
        "-days",
        "1",
        "-subj",
        "/CN=localhost",
        "-addext",
        "subjectAltName=DNS:localhost,IP:127.0.0.1",
      ],
      { stdio: "ignore" },
    );
    return {
      key: readFileSync(join(dir, "key.pem"), "utf8"),
      cert: readFileSync(join(dir, "cert.pem"), "utf8"),
    };
  })();
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("upgrades with STARTTLS when the server offers it, before the password", async () => {
    const credentials = { user: "factory", password: "tls-only-secret" };
    const server = await start({ credentials, starttls: pem });
    await Effect.runPromise(
      sinkOver(
        configFor(server, {
          host: "localhost",
          tls: { ca: pem.cert },
          user: credentials.user,
          password: Redacted.make(credentials.password),
        }),
      ).send(notification),
    );
    expect(server.mail[0]?.encrypted).toBe(true);
    expect(server.mail[0]?.auth).toEqual(credentials);
    const verbs = server.commands.map((line) => line.split(" ")[0]);
    expect(verbs.slice(0, 3)).toEqual(["EHLO", "STARTTLS", "EHLO"]);
    expect(verbs.indexOf("AUTH")).toBeGreaterThan(verbs.indexOf("STARTTLS"));
  });

  it("is TLS from the first byte over smtps", async () => {
    const server = await start({ secure: pem });
    await Effect.runPromise(
      sinkOver(
        configFor(server, {
          host: "localhost",
          secure: true,
          tls: { ca: pem.cert },
        }),
      ).send(notification),
    );
    expect(server.mail[0]?.encrypted).toBe(true);
  });

  it("refuses a certificate it does not trust", async () => {
    const server = await start({ secure: pem });
    const exit = await Effect.runPromiseExit(
      sinkOver(configFor(server, { host: "localhost", secure: true })).send(
        notification,
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(server.mail).toEqual([]);
  });
});

describe("NOTIFY_SMTP_URL", () => {
  const parse = (url: string) =>
    Effect.runPromiseExit(parseSmtpUrl(Redacted.make(url), "factory.test"));

  it("reads the host, the port a scheme implies and a login with escapes", async () => {
    const ok = await Effect.runPromise(
      parseSmtpUrl(
        Redacted.make("smtp://am%40y:p%2Fw@mail.example.test"),
        "factory.test",
      ),
    );
    expect(ok.host).toBe("mail.example.test");
    expect(ok.port).toBe(587);
    expect(ok.secure).toBe(false);
    expect(ok.user).toBe("am@y");
    expect(Redacted.value(ok.password ?? Redacted.make(""))).toBe("p/w");
    const secure = await Effect.runPromise(
      parseSmtpUrl(Redacted.make("smtps://mail.example.test"), "factory.test"),
    );
    expect([secure.port, secure.secure, secure.user]).toEqual([
      465,
      true,
      undefined,
    ]);
  });

  it("refuses a URL that is not SMTP, without repeating what it holds", async () => {
    for (const bad of [
      "https://u:pw-secret@mail.example.test",
      "not a url pw-secret",
      "smtp://",
    ]) {
      const exit = await parse(bad);
      expect(Exit.isFailure(exit), bad).toBe(true);
      expect(String(exit)).not.toContain("pw-secret");
    }
  });
});
