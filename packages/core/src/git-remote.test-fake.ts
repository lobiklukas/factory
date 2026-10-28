/**
 * A forge's git endpoint for tests (LOB-54, C17): the bare repositories under `projectRoot`, served
 * over git's smart-HTTP protocol by the real `git http-backend` behind an in-process `node:http`
 * listener on an ephemeral loopback port. Nothing is mocked and nothing leaves the machine
 * (docs/testing-third-parties.md, `git`).
 *
 * The listener answers `401` to any request without `x-access-token:<token>` Basic auth, which is
 * what makes the credential load-bearing: over a plain path remote git never asks for one, so code
 * that forgot to inject it would still pass. Every request's credential is recorded, so a case can
 * say which token git actually sent. A bare repository must set `http.receivepack` to take a push.
 *
 * The one copy of this bridge for core's suites and the verify drives: `@repo/core/testing` exports
 * it, and `.pi/skills/verify-api/git-forge-fake.ts` is a thin process around it with a ledger.
 */
// oxlint-disable-next-line effecttsgo/node-builtin-import -- the remote is the real `git http-backend` CGI, spawned per request.
import { spawn } from "node:child_process";
import { once } from "node:events";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- a listener git connects to, not a client: the forge's side of the wire.
import { createServer, type Server } from "node:http";

export type Seen = { readonly user: string; readonly password: string };

/** One request as the forge saw it: never the credential's value, only which one it was. */
export type GitRemoteRequest = {
  readonly method: string;
  readonly path: string;
  /** `git-upload-pack` (a fetch or an `ls-remote`) or `git-receive-pack` (a push); `""` otherwise. */
  readonly service: string;
  /** `none` (git's first, unauthenticated try), `token` (the one accepted), or `other`. */
  readonly credential: "none" | "token" | "other";
};

export type GitRemoteOptions = {
  /** The loopback port to bind. Absent: an ephemeral one. */
  readonly port?: number;
  /** Called once per request before it is answered — a drive's ledger (`verify-api/git-forge-fake.ts`). */
  readonly onRequest?: (request: GitRemoteRequest) => void;
};

/**
 * The smart-HTTP remote: `git http-backend` as a CGI behind a Basic-auth gate. `seen` records the
 * credential of every request that carried one; `requests` counts every request at all, so a case
 * can prove a refused call never reached the remote.
 */
// oxlint-disable-next-line effecttsgo/async-function -- a vitest `beforeAll` awaits it, as the suites that use it always have.
export const startGitRemote = async (
  projectRoot: string,
  token: string,
  options: GitRemoteOptions = {},
): Promise<{
  readonly server: Server;
  readonly url: string;
  readonly seen: Array<Seen>;
  readonly requests: { count: number };
}> => {
  const seen: Array<Seen> = [];
  const requests = { count: 0 };
  const server = createServer((req, res) => {
    requests.count += 1;
    const header = req.headers.authorization ?? "";
    const decoded = header.startsWith("Basic ")
      ? Buffer.from(header.slice(6), "base64").toString("utf8")
      : undefined;
    if (decoded !== undefined) {
      const at = decoded.indexOf(":");
      seen.push({
        user: decoded.slice(0, at),
        password: decoded.slice(at + 1),
      });
    }
    const authorized = decoded === `x-access-token:${token}`;
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    // The service is in the query of the advertisement and the path of the RPC that follows it.
    options.onRequest?.({
      method: req.method ?? "GET",
      path: url.pathname,
      service:
        url.searchParams.get("service") ??
        (url.pathname.endsWith("/git-receive-pack")
          ? "git-receive-pack"
          : url.pathname.endsWith("/git-upload-pack")
            ? "git-upload-pack"
            : ""),
      credential: authorized
        ? "token"
        : decoded === undefined
          ? "none"
          : "other",
    });
    if (!authorized) {
      req.resume();
      res.writeHead(401, { "WWW-Authenticate": 'Basic realm="factory-test"' });
      res.end();
      return;
    }
    const cgi = spawn("git", ["http-backend"], {
      env: {
        ...process.env,
        GIT_PROJECT_ROOT: projectRoot,
        GIT_HTTP_EXPORT_ALL: "1",
        PATH_INFO: decodeURIComponent(url.pathname),
        QUERY_STRING: url.search.slice(1),
        REQUEST_METHOD: req.method ?? "GET",
        CONTENT_TYPE: req.headers["content-type"] ?? "",
        REMOTE_USER: "x-access-token",
        REMOTE_ADDR: "127.0.0.1",
        GIT_PROTOCOL: String(req.headers["git-protocol"] ?? ""),
        HTTP_CONTENT_ENCODING: String(req.headers["content-encoding"] ?? ""),
        ...(req.headers["content-length"] === undefined
          ? {}
          : { CONTENT_LENGTH: req.headers["content-length"] }),
      },
      stdio: ["pipe", "pipe", "ignore"],
    });
    req.pipe(cgi.stdin);
    const chunks: Array<Buffer> = [];
    cgi.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    cgi.on("close", () => {
      const out = Buffer.concat(chunks);
      const crlf = out.indexOf("\r\n\r\n");
      const lf = out.indexOf("\n\n");
      const split = crlf !== -1 && (lf === -1 || crlf < lf) ? crlf : lf;
      const sep = split === crlf ? 4 : 2;
      const head = out.subarray(0, split).toString("utf8");
      let status = 200;
      const headers: Record<string, string> = {};
      for (const line of head.split(/\r?\n/)) {
        const colon = line.indexOf(":");
        if (colon === -1) continue;
        const name = line.slice(0, colon).trim();
        const value = line.slice(colon + 1).trim();
        if (name.toLowerCase() === "status")
          status = Number(value.split(" ")[0]);
        else headers[name] = value;
      }
      res.writeHead(status, headers);
      res.end(out.subarray(split + sep));
    });
  });
  server.listen(options.port ?? 0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("the test remote did not bind a TCP port");
  return { server, url: `http://127.0.0.1:${address.port}`, seen, requests };
};
