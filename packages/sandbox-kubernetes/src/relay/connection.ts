/* oxlint-disable effecttsgo/node-builtin-import -- a connection is a long-lived child process whose stdin and stdout carry the relay's lines both ways, for the life of an `ExecutionEnv` that Pi Durable drives with promises. */
/**
 * How the relay's two halves are joined (LOB-91): a child process whose stdin takes the client's
 * lines and whose stdout carries the server's. For a pod the child is `kubectl exec -i … --
 * factory-env-relay`; for the tests it is the relay itself, run locally.
 *
 * Closing a connection ends the child's stdin, which ends the server, which kills every command it
 * still ran; a child that has not gone a moment later is killed. What the child wrote to stderr is
 * kept (its tail), because when a connection is lost that is usually the only account of why —
 * `kubectl` saying the pod is gone, or the relay failing to start.
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export type Connection = {
  /** Send one line, without its newline. Lines sent after the connection closed are dropped. */
  readonly send: (line: string) => void;
  /** Called for every line the other side sends. */
  readonly onLine: (listener: (line: string) => void) => void;
  /** Called once, when the connection is gone, with what it last said about why. */
  readonly onClose: (listener: (reason: string) => void) => void;
  /** End the connection; the other side's work ends with it. Idempotent. */
  readonly close: () => void;
};

/** The most stderr a connection keeps for its closing reason. */
const STDERR_TAIL = 2048;

/** A connection over a new child process running `command` with `args`. */
export const spawnConnection = (
  command: string,
  args: ReadonlyArray<string>,
  options: { readonly cwd?: string; readonly env?: NodeJS.ProcessEnv } = {},
): Connection => {
  const child = spawn(command, args, {
    stdio: ["pipe", "pipe", "pipe"],
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.env === undefined ? {} : { env: options.env }),
  });
  const lineListeners: Array<(line: string) => void> = [];
  const closeListeners: Array<(reason: string) => void> = [];
  let closed: string | undefined;
  let stderr = "";

  const finish = (reason: string) => {
    if (closed !== undefined) return;
    const said = stderr.trim();
    closed = said === "" ? reason : `${reason}: ${said}`;
    for (const listener of closeListeners.splice(0)) listener(closed);
  };

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-STDERR_TAIL);
  });
  createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => {
    for (const listener of lineListeners) listener(line);
  });
  child.on("error", (error) => finish(`${command} could not run (${error.message})`));
  child.on("close", (code, signal) =>
    finish(`${command} exited (${signal ?? `code ${code ?? "unknown"}`})`),
  );
  // A write after the child is gone fails here rather than throwing in the caller.
  child.stdin.on("error", () => undefined);

  return {
    send: (line) => {
      if (closed === undefined && child.stdin.writable) child.stdin.write(`${line}\n`);
    },
    onLine: (listener) => {
      lineListeners.push(listener);
    },
    onClose: (listener) => {
      if (closed !== undefined) listener(closed);
      else closeListeners.push(listener);
    },
    close: () => {
      if (closed !== undefined) return;
      child.stdin.end();
      // oxlint-disable-next-line effecttsgo/global-timers -- a grace period for a child process, outside any fiber.
      const kill = setTimeout(() => child.kill("SIGKILL"), 2000);
      kill.unref();
      child.once("close", () => clearTimeout(kill));
    },
  };
};
