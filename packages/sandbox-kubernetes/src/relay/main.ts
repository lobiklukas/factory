/* oxlint-disable effecttsgo/node-builtin-import -- the relay is a stdio process: it reads its requests line by line from stdin and has no Effect runtime to read them through. */
/**
 * The relay's process (LOB-91): `bun main.ts`, run inside the sandbox by `kubectl exec -i`, or
 * as a local child process by the tests. It serves one client over its stdin and stdout and exits
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
  server.end().finally(() => process.exit(0));
});
