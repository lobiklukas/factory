/* oxlint-disable effecttsgo/node-builtin-import -- the relay is a stdio process: it reads its requests line by line from stdin and has no Effect runtime to read them through. */
/**
 * The relay's process (LOB-91): this file bundled by `buildRelay` (`./build`) into `relay.mjs` and
 * run under Node — `node relay.mjs`, not Bun, whose `fs.opendir` breaks a Pi Durable conformance
 * case — inside the sandbox by `kubectl exec -i`, or as a local child process by the tests. It serves one client over its stdin and stdout and exits
 * when stdin ends, killing every command it still runs on the way out — so closing the connection,
 * or losing it to a pause, leaves nothing of the client's running in the pod.
 *
 * The sandbox image puts it on PATH as `factory-env-relay` (infra/sandbox/Dockerfile).
 */
import { createInterface } from "node:readline";
import { serveExecutionEnv } from "./server";

const server = serveExecutionEnv({
  send: (line) => {
    process.stdout.write(`${line}\n`);
  },
});

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", server.receive);
lines.on("close", () => {
  void server.end().finally(() => process.exit(0));
});
