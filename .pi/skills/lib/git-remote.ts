/**
 * A loopback git forge for the drives that clone a repository (LOB-265): `git http-backend` behind a
 * Basic-auth gate, serving the bare repositories under one directory over smart HTTP.
 *
 *   bun .pi/skills/lib/git-remote.ts <root> <port> <token>
 *
 * A bare repository at `<root>/<owner>/<name>.git` is `http://127.0.0.1:<port>/<owner>/<name>.git`. A
 * request without `x-access-token:<token>` is answered `401`, which is what makes the credential
 * load-bearing: over a path remote git never asks for one, so a clone that forgot to send it would
 * still pass. The one line it prints on stdout, once it listens, is the URL root.
 *
 * It is a drive's fake and nothing else: no real forge is reached, and the token is the drive's own
 * throwaway value. `packages/core/src/git.test.ts` serves the same shape for the unit cases.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";

const [root, port, token] = process.argv.slice(2);
if (root === undefined || port === undefined || token === undefined) {
  console.error("usage: git-remote.ts <root> <port> <token>");
  process.exit(2);
}

const server = createServer((req, res) => {
  const header = req.headers.authorization ?? "";
  const decoded = header.startsWith("Basic ")
    ? Buffer.from(header.slice(6), "base64").toString("utf8")
    : undefined;
  if (decoded !== `x-access-token:${token}`) {
    req.resume();
    res.writeHead(401, { "WWW-Authenticate": 'Basic realm="verify-git"' });
    res.end();
    return;
  }
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const cgi = spawn("git", ["http-backend"], {
    env: {
      ...process.env,
      GIT_PROJECT_ROOT: root,
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
    if (split === -1) {
      res.writeHead(502);
      res.end();
      return;
    }
    const sep = split === crlf ? 4 : 2;
    let status = 200;
    const headers: Record<string, string> = {};
    for (const line of out.subarray(0, split).toString("utf8").split(/\r?\n/)) {
      const colon = line.indexOf(":");
      if (colon === -1) continue;
      const name = line.slice(0, colon).trim();
      const value = line.slice(colon + 1).trim();
      if (name.toLowerCase() === "status") status = Number(value.split(" ")[0]);
      else headers[name] = value;
    }
    res.writeHead(status, headers);
    res.end(out.subarray(split + sep));
  });
});

server.listen(Number(port), "127.0.0.1", () => {
  console.log(`http://127.0.0.1:${port}`);
});
