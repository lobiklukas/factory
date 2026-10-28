// The git side of a loopback forge (C17): bare repositories served over git's smart-HTTP protocol by
// the real `git http-backend`, behind a Basic-auth gate that answers `401` to any request without
// `x-access-token:<token>` — so a push or fetch that did not carry the control plane's token fails
// here exactly as it would on GitHub, and one over a plain path would prove nothing.
//
// Nothing is mocked but the host: the repositories are real, the protocol is git's own, and the
// ledger is a file so the drive can count what reached the forge after the API has exited. It holds
// one row per request — method, path, the `service` git asked for (`git-upload-pack` is a fetch or
// an `ls-remote`, `git-receive-pack` a push) and which credential it carried: `none` (git's first,
// unauthenticated request, which the `401` challenge answers), `token`, or `other`. The token itself
// is never written to the ledger.
//
//   GIT_FORGE_PORT    port to listen on, required
//   GIT_FORGE_ROOT    the directory of bare repositories (`<root>/<owner>/<repo>.git`), required
//   GIT_FORGE_TOKEN   the one token the gate accepts, required
//   GIT_FORGE_LEDGER  ledger file path, required
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";

const port = Number(process.env["GIT_FORGE_PORT"] ?? "");
const root = process.env["GIT_FORGE_ROOT"] ?? "";
const token = process.env["GIT_FORGE_TOKEN"] ?? "";
const ledgerPath = process.env["GIT_FORGE_LEDGER"] ?? "";
if (
  !Number.isInteger(port) ||
  root === "" ||
  token === "" ||
  ledgerPath === ""
) {
  console.error(
    "GIT_FORGE_PORT, GIT_FORGE_ROOT, GIT_FORGE_TOKEN and GIT_FORGE_LEDGER are required",
  );
  process.exit(1);
}

type Row = {
  readonly method: string;
  readonly path: string;
  readonly service: string;
  readonly credential: "none" | "token" | "other";
};

const read = (): { readonly requests: ReadonlyArray<Row> } => {
  try {
    return JSON.parse(readFileSync(ledgerPath, "utf8")) as {
      readonly requests: ReadonlyArray<Row>;
    };
  } catch {
    return { requests: [] };
  }
};
const record = (row: Row): void =>
  writeFileSync(
    ledgerPath,
    `${JSON.stringify({ requests: [...read().requests, row] }, null, 2)}\n`,
  );

writeFileSync(ledgerPath, `${JSON.stringify({ requests: [] }, null, 2)}\n`);

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const header = req.headers.authorization ?? "";
  const decoded = header.startsWith("Basic ")
    ? Buffer.from(header.slice(6), "base64").toString("utf8")
    : undefined;
  const authorized = decoded === `x-access-token:${token}`;
  // The service is in the query of the advertisement and the path of the RPC that follows it.
  const service =
    url.searchParams.get("service") ??
    (url.pathname.endsWith("/git-receive-pack")
      ? "git-receive-pack"
      : url.pathname.endsWith("/git-upload-pack")
        ? "git-upload-pack"
        : "");
  record({
    method: req.method ?? "GET",
    path: url.pathname,
    service,
    credential: authorized ? "token" : decoded === undefined ? "none" : "other",
  });
  if (!authorized) {
    req.resume();
    res.writeHead(401, { "WWW-Authenticate": 'Basic realm="git-forge-fake"' });
    res.end();
    return;
  }
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

server.listen(port, "127.0.0.1");
await once(server, "listening");
console.log(
  `git-forge-fake listening on http://127.0.0.1:${port} root=${root}`,
);
