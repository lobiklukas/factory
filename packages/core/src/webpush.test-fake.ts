/**
 * A fake Web Push service on loopback, for the Web Push sink's tests (docs/testing-third-parties.md),
 * and the browser's half of the protocol: a subscription with keys the test holds, and the receiver's
 * decryption of RFC 8291, so a test reads the message a browser would. Never a browser vendor's
 * push service.
 */
import {
  createDecipheriv,
  createECDH,
  hkdfSync,
  randomBytes,
} from "node:crypto";
/* oxlint-disable effecttsgo/new-promise effecttsgo/node-builtin-import -- a node:http server's `listen` and `close` take callbacks, and a push service is a server this test stands up itself. */
import http from "node:http";

/** A browser's subscription: the keys it would keep, and the JSON it would hand the server. */
export const makeSubscription = (endpoint: string) => {
  const ua = createECDH("prime256v1");
  ua.generateKeys();
  const auth = randomBytes(16);
  return {
    endpoint,
    p256dh: ua.getPublicKey().toString("base64url"),
    auth: auth.toString("base64url"),
    private: ua,
    authSecret: auth,
  };
};
export type FakeSubscription = ReturnType<typeof makeSubscription>;

const hkdf = (salt: Buffer, ikm: Buffer, info: string, length: number) =>
  Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from(info, "utf8"), length));

/** What a browser does with a push body: RFC 8291 §4, one record. Throws on any tampering. */
export const decryptPayload = (
  subscription: FakeSubscription,
  body: Buffer,
): Buffer => {
  const salt = body.subarray(0, 16);
  const idLength = body.readUInt8(20);
  const asPublic = body.subarray(21, 21 + idLength);
  const record = body.subarray(21 + idLength);
  const uaPublic = subscription.private.getPublicKey();
  const shared = subscription.private.computeSecret(asPublic);
  const ikm = Buffer.from(
    hkdfSync(
      "sha256",
      shared,
      subscription.authSecret,
      Buffer.concat([
        Buffer.from("WebPush: info\0", "utf8"),
        uaPublic,
        asPublic,
      ]),
      32,
    ),
  );
  const cek = hkdf(salt, ikm, "Content-Encoding: aes128gcm\0", 16);
  const nonce = hkdf(salt, ikm, "Content-Encoding: nonce\0", 12);
  const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(record.subarray(record.length - 16));
  const padded = Buffer.concat([
    decipher.update(record.subarray(0, record.length - 16)),
    decipher.final(),
  ]);
  // The last byte of the single record is its delimiter.
  return padded.subarray(0, padded.lastIndexOf(2));
};

export type PushReceived = {
  readonly path: string;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: Buffer;
};

export type FakePush = {
  readonly origin: string;
  readonly received: PushReceived[];
  /** The status the next requests are answered with (default 201, a push service's accept). */
  status: number;
  /** When set, requests are answered `307` with this `Location` instead of `status`. */
  redirectTo: string | undefined;
  readonly close: () => Promise<void>;
};

export const startFakePush = (): Promise<FakePush> =>
  new Promise((resolve, reject) => {
    const received: PushReceived[] = [];
    const sockets = new Set<import("node:net").Socket>();
    const state: { status: number; redirectTo: string | undefined } = {
      status: 201,
      redirectTo: undefined,
    };
    const server = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        received.push({
          path: request.url ?? "",
          headers: request.headers,
          body: Buffer.concat(chunks),
        });
        if (state.redirectTo !== undefined) {
          response.writeHead(307, { location: state.redirectTo }).end();
          return;
        }
        response.writeHead(state.status).end();
      });
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("the fake push service has no port"));
        return;
      }
      resolve({
        origin: `http://127.0.0.1:${address.port}`,
        received,
        get status() {
          return state.status;
        },
        set status(value: number) {
          state.status = value;
        },
        get redirectTo() {
          return state.redirectTo;
        },
        set redirectTo(value: string | undefined) {
          state.redirectTo = value;
        },
        close: () =>
          new Promise<void>((done) => {
            for (const socket of sockets) socket.destroy();
            server.close(() => done());
          }),
      });
    });
  });
