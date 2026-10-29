/**
 * The environment relay (LOB-91) held to Pi Durable's own oracle: `registerEnvConformance` runs
 * against a `RemoteExecutionEnv` whose every call crosses a real relay process — the same
 * `main.ts` the sandbox image runs in a pod — over its stdin and stdout. Then what only a remote
 * environment can get wrong: a lost connection, a refusal, a reconnect, cancellation on the wire.
 *
 * Offline and cluster-free: the relay is a local `bun` child in a fresh temporary directory, so
 * this proves the wire and the server, not `kubectl exec` (the verify-sandbox drive does that).
 */
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BACKGROUND_CONTEXT,
  withAbortSignal,
} from "@earendil-works/chord/context";
import { registerEnvConformance } from "@earendil-works/pi-durable/testing";
import { afterAll, describe, expect, it } from "vitest";
import { RemoteExecutionEnv } from "./client";
import { type Connection, spawnConnection } from "./connection";
import { buildRelay } from "./build";

const context = BACKGROUND_CONTEXT;
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "factory-relay-")));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
// The relay as the image runs it: one bundled file, under Node.
const RELAY = buildRelay(join(scratch, "relay.mjs"));

/** A relay over a fresh directory, and every connection it opened, so a case can cut one. */
const relay = (refusal?: () => string | undefined) => {
  const cwd = mkdtempSync(join(scratch, "sandbox-"));
  const connections: Connection[] = [];
  const env = new RemoteExecutionEnv({
    id: `relay-test:${cwd}`,
    cwd,
    connect: () => {
      const connection = spawnConnection("node", [RELAY], { cwd });
      connections.push(connection);
      return connection;
    },
    ...(refusal === undefined ? {} : { refusal }),
  });
  return { cwd, env, connections };
};

// oxlint-disable-next-line effecttsgo/global-timers, effecttsgo/new-promise -- a Promise-world suite waits in real time.
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Whether process `pid` still exists on this host. */
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * Wait until the command that wrote its shell's pid to `path` is gone: killed, not finished, since
 * the commands here sleep far longer than any wait. Polled rather than slept, so a loaded machine
 * slows the case down instead of failing it.
 */
const killed = async (env: RemoteExecutionEnv, path: string) => {
  const read = await env.readTextFile(path, context);
  if (!read.ok) throw read.error;
  const pid = Number(read.value);
  for (let tries = 0; tries < 500 && alive(pid); tries++) await sleep(20);
  return !alive(pid);
};

/** Wait until `path` exists in the environment: the command that writes it has started. */
const until = async (env: RemoteExecutionEnv, path: string) => {
  for (let tries = 0; tries < 250; tries++) {
    const found = await env.exists(path, context);
    if (found.ok && found.value) return;
    await sleep(20);
  }
  throw new Error(`${path} never appeared`);
};

// The suite sizes its timeouts for a local environment; here each case also starts a relay process,
// and the gate runs every package at once.
const patient = (name: string, run: () => Promise<void>, timeoutMs?: number) =>
  it(name, run, Math.max(timeoutMs ?? 0, 30_000));

registerEnvConformance(
  { describe, expect, it: patient },
  "relay: ExecutionEnv",
  async (use) => {
    const { cwd, env } = relay();
    try {
      await use(env);
    } finally {
      env.disconnect();
      rmSync(cwd, { recursive: true, force: true });
    }
  },
);

describe("relay connection", () => {
  it("runs in the server's directory, which the client names, not in its own", async () => {
    const { cwd, env } = relay();
    try {
      const result = await env.exec(
        "pwd -P; printf marker > marker.txt",
        undefined,
        context,
      );
      expect(result.ok).toBe(true);
      expect(existsSync(join(cwd, "marker.txt"))).toBe(true);
      expect(await env.readTextFile("marker.txt", context)).toEqual({
        ok: true,
        value: "marker",
      });
    } finally {
      env.disconnect();
    }
  });

  it("carries bytes unchanged both ways", async () => {
    const { env } = relay();
    try {
      const bytes = Uint8Array.from([0, 255, 10, 13, 0xc3, 0x28, 0x7b, 0x7d]);
      expect((await env.writeFile("data.bin", bytes, context)).ok).toBe(true);
      const read = await env.readBinaryFile("data.bin", context);
      expect(read.ok ? Array.from(read.value) : read.error.code).toEqual(
        Array.from(bytes),
      );
    } finally {
      env.disconnect();
    }
  });

  it("fails what is in flight when the connection is lost, kills the command, and reconnects on the next call", async () => {
    const { env, connections } = relay();
    try {
      const running = env.exec(
        "printf $$ > started; sleep 30; printf s > survived",
        undefined,
        context,
      );
      await until(env, "started");
      connections[0]?.close();
      const lost = await running;
      expect(lost.ok ? "ran" : lost.error.code).toBe("unknown");
      // The server ended with its stdin and took the command with it, long before it would end.
      expect(await killed(env, "started")).toBe(true);
      expect(connections).toHaveLength(2);
    } finally {
      env.disconnect();
    }
  }, 15_000);

  it("marks a handle dead once its connection is gone, even after a reconnect", async () => {
    const { env } = relay();
    try {
      expect((await env.writeFile("a.txt", "abc", context)).ok).toBe(true);
      const opened = await env.openBinaryReader("a.txt", undefined, context);
      if (!opened.ok) throw opened.error;
      env.disconnect();
      const read = await opened.value.read(0, 3, context);
      expect(read.ok ? "read" : read.error.code).toBe("invalid");
      await opened.value.close(context);
      expect(await env.readTextFile("a.txt", context)).toEqual({
        ok: true,
        value: "abc",
      });
    } finally {
      env.disconnect();
    }
  });

  it("refuses every call while the refusal holds, without opening a connection", async () => {
    let paused: string | undefined = "sandbox sbx-x is paused";
    const { env, connections } = relay(() => paused);
    try {
      const read = await env.readTextFile("x", context);
      expect(read.ok ? "read" : [read.error.code, read.error.message]).toEqual([
        "unknown",
        "sandbox sbx-x is paused",
      ]);
      const exec = await env.exec("true", undefined, context);
      expect(exec.ok ? "ran" : exec.error.code).toBe("unknown");
      await env.cleanup(context);
      expect(connections).toHaveLength(0);
      paused = undefined;
      expect((await env.exec("true", undefined, context)).ok).toBe(true);
      expect(connections).toHaveLength(1);
    } finally {
      env.disconnect();
    }
  });

  it("stops a command whose output callback throws, as callback_error", async () => {
    const { env } = relay();
    try {
      const result = await env.exec(
        "printf $$ > pid; printf one; sleep 30; printf two > survived",
        {
          onOutput: () => {
            throw new Error("the caller's callback failed");
          },
        },
        context,
      );
      expect(
        result.ok ? "ran" : [result.error.code, result.error.message],
      ).toEqual(["callback_error", "the caller's callback failed"]);
      // The shell is gone long before its thirty seconds were up. Whether every grandchild went with
      // it is Pi Durable's process-group kill, which this relay does not change.
      expect(await killed(env, "pid")).toBe(true);
    } finally {
      env.disconnect();
    }
  }, 15_000);

  it("refuses an aborted context before sending anything", async () => {
    const { env, connections } = relay();
    const controller = new AbortController();
    controller.abort();
    const read = await env.readTextFile(
      "x",
      withAbortSignal(controller.signal, context),
    );
    expect(read.ok ? "read" : read.error.code).toBe("aborted");
    expect(connections).toHaveLength(0);
  });

  it("names what the server said when it never started", async () => {
    const env = new RemoteExecutionEnv({
      id: "relay-test:broken",
      cwd: scratch,
      connect: () =>
        spawnConnection("sh", ["-c", "echo 'no such pod' >&2; exit 1"]),
    });
    const read = await env.readTextFile("x", context);
    expect(read.ok ? "read" : read.error.message).toMatch(
      /unreachable: sh exited \(code 1\): no such pod/,
    );
  });
});
