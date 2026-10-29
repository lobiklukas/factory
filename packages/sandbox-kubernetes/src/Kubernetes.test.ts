/**
 * The Kubernetes runtime (LOB-89, LOB-91) against the fake cluster (`./testing`): the shared
 * `SandboxRuntime` conformance suite and Pi Durable's `ExecutionEnv` suite over its relay, then the
 * lifecycle as the resource records it — what was asked of the cluster, the conditions read back,
 * the pod and the volume — and what a pause keeps and refuses.
 *
 * Cluster-free: the controller is modelled, the pod is a local relay process, the PVC a directory.
 * The same runtime against real kind is the verify-sandbox drive and `bun run test:kind`.
 */
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { SandboxCapabilities } from "@repo/sandbox";
import { registerSandboxRuntimeConformance } from "@repo/sandbox/testing";
import { Cause, Effect, Exit, Fiber, Layer, Schema, type Scope } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import { Kubernetes } from "./index";
import { buildRelay } from "./relay/build";
import { fakeCluster, type FakeCluster } from "./testing";

const scratch = realpathSync(
  mkdtempSync(join(tmpdir(), "factory-kubernetes-")),
);
// A minute: the gate runs every package at once, and a loaded machine removes a tree slowly.
afterAll(() => rmSync(scratch, { recursive: true, force: true }), 60_000);

/** Whether process `pid` still exists on this host. */
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// The relay as the image runs it, bundled once for every fake cluster here.
const RELAY = buildRelay(join(scratch, "relay.mjs"));

const freshCluster = (
  behaviour?: Parameters<typeof fakeCluster>[0]["behaviour"],
) =>
  fakeCluster({
    root: mkdtempSync(join(scratch, "cluster-")),
    relay: RELAY,
    ...(behaviour === undefined ? {} : { behaviour }),
  });

// One fake cluster per case, as one layer per case: the suite builds its layer afresh each time.
// The suite sizes its timeouts for a local process; every case here also spawns relay processes,
// and the gate runs every package at once.
const patient = (name: string, run: () => Promise<void>, timeoutMs?: number) =>
  it(name, run, Math.max(timeoutMs ?? 0, 30_000));

registerSandboxRuntimeConformance(
  { describe, expect, it: patient },
  "kubernetes runtime (fake cluster)",
  Layer.unwrap(
    Effect.sync(() =>
      Kubernetes.layer({ cluster: freshCluster(), pollInterval: "5 millis" }),
    ),
  ),
);

/** Run `body` against a runtime over `cluster`, released when it ends. */
const withRuntime = <A, E>(
  cluster: FakeCluster,
  body: (
    runtime: Effect.Success<ReturnType<typeof Kubernetes.make>>,
  ) => Effect.Effect<A, E, Scope.Scope>,
  options: Partial<Kubernetes.KubernetesOptions> = {},
): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* body(
        yield* Kubernetes.make({
          cluster,
          pollInterval: "5 millis",
          ...options,
        }),
      );
    }).pipe(Effect.scoped),
  );

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe("kubernetes runtime lifecycle", () => {
  it("says what it provides: a volume that survives a pause, and no isolation", () => {
    expect(
      Schema.decodeSync(SandboxCapabilities)(Kubernetes.capabilities),
    ).toEqual({
      runtime: "kubernetes",
      isolation: "none",
      persistence: "volume",
      maxDiskGb: null,
      pauseResume: true,
      requiresKeepaliveForLongTasks: false,
    });
  });

  it("creates a resource, waits past a stale Ready for the current one, and runs commands in its pod's volume", async () => {
    const cluster = freshCluster();
    await withRuntime(cluster, (runtime) =>
      Effect.gen(function* () {
        const sandbox = yield* runtime.create;
        expect(cluster.resources()).toEqual([sandbox.id]);
        expect(sandbox.workdir).toBe(cluster.volume(sandbox.id));
        // Created, then read until the controller reported this generation ready — the first read
        // only carried the previous generation's `Ready`.
        expect(cluster.calls.slice(0, 3)).toEqual([
          `create ${sandbox.id}`,
          `read ${sandbox.id}`,
          `read ${sandbox.id}`,
        ]);
        const marked = yield* runtime.exec(
          sandbox,
          "printf in-the-pod > marker.txt; pwd -P",
        );
        expect(marked.stdout.trim()).toBe(sandbox.workdir);
        expect(
          readFileSync(join(cluster.volume(sandbox.id), "marker.txt"), "utf8"),
        ).toBe("in-the-pod");
      }),
    );
  });

  it("keeps a file written before a pause, refuses every operation while paused, and serves it after the resume", async () => {
    const cluster = freshCluster();
    await withRuntime(cluster, (runtime) =>
      Effect.gen(function* () {
        const sandbox = yield* runtime.create;
        const env = yield* runtime.executionEnv(sandbox);
        yield* runtime.writeFile(
          sandbox,
          "kept/before-pause.txt",
          "written before the pause",
        );
        yield* runtime.pause(sandbox);
        expect(cluster.calls).toContain(`setMode ${sandbox.id} Suspended`);
        expect(cluster.hasPod(sandbox.id)).toBe(false);
        expect(
          existsSync(join(cluster.volume(sandbox.id), "kept/before-pause.txt")),
        ).toBe(true);

        const refused = yield* Effect.all([
          Effect.flip(runtime.exec(sandbox, "true")),
          Effect.flip(runtime.readFile(sandbox, "kept/before-pause.txt")),
          Effect.flip(runtime.writeFile(sandbox, "x", "x")),
        ]);
        for (const error of refused) {
          expect(error).toMatchObject({
            code: "unknown",
            message: `sandbox ${sandbox.id} is paused: resume it first`,
          });
        }
        // The environment it handed out refuses too, without trying to reach a pod that is gone.
        const connects = cluster.calls.filter((call) =>
          call.startsWith("connect"),
        ).length;
        const viaEnv = yield* Effect.promise(() =>
          env.readTextFile("kept/before-pause.txt", BACKGROUND_CONTEXT),
        );
        expect(viaEnv.ok ? "read" : viaEnv.error.message).toBe(
          `sandbox ${sandbox.id} is paused: resume it first`,
        );
        expect(
          cluster.calls.filter((call) => call.startsWith("connect")).length,
        ).toBe(connects);
        // Pausing a paused sandbox is a no-op.
        yield* runtime.pause(sandbox);
        expect(
          cluster.calls.filter(
            (call) => call === `setMode ${sandbox.id} Suspended`,
          ),
        ).toHaveLength(1);

        yield* runtime.resume(sandbox);
        expect(cluster.hasPod(sandbox.id)).toBe(true);
        expect(
          text(yield* runtime.readFile(sandbox, "kept/before-pause.txt")),
        ).toBe("written before the pause");
        const again = yield* Effect.promise(() =>
          env.readTextFile("kept/before-pause.txt", BACKGROUND_CONTEXT),
        );
        expect(again).toEqual({ ok: true, value: "written before the pause" });
      }),
    );
  });

  it("kills what ran in the pod when it pauses", async () => {
    const cluster = freshCluster();
    await withRuntime(cluster, (runtime) =>
      Effect.gen(function* () {
        const sandbox = yield* runtime.create;
        const running = yield* Effect.forkChild(
          runtime.exec(
            sandbox,
            "printf $$ > started; sleep 30; printf s > survived",
          ),
        );
        while (!existsSync(join(sandbox.workdir, "started")))
          yield* Effect.sleep("20 millis");
        yield* runtime.pause(sandbox);
        const exit = yield* Fiber.await(running);
        expect(Exit.isFailure(exit)).toBe(true);
        expect(cluster.relays()).toBe(0);
        // The command's shell is gone well before its thirty seconds: killed with the pod.
        const pid = Number(
          readFileSync(join(sandbox.workdir, "started"), "utf8"),
        );
        for (let tries = 0; tries < 500 && alive(pid); tries++)
          yield* Effect.sleep("20 millis");
        expect(alive(pid)).toBe(false);
      }),
    );
  }, 15_000);

  it("destroys the resource, its pod and its volume; destroying twice is a no-op", async () => {
    const cluster = freshCluster();
    await withRuntime(cluster, (runtime) =>
      Effect.gen(function* () {
        const sandbox = yield* runtime.create;
        yield* runtime.exec(sandbox, "true");
        expect(cluster.relays()).toBe(1);
        yield* runtime.destroy(sandbox);
        expect(cluster.resources()).toEqual([]);
        expect(cluster.relays()).toBe(0);
        expect(existsSync(cluster.volume(sandbox.id))).toBe(false);
        const removes = cluster.calls.filter(
          (call) => call === `remove ${sandbox.id}`,
        ).length;
        yield* runtime.destroy(sandbox);
        expect(
          cluster.calls.filter((call) => call === `remove ${sandbox.id}`),
        ).toHaveLength(removes);
        expect((yield* Effect.flip(runtime.exec(sandbox, "true")))._tag).toBe(
          "SandboxNotFound",
        );
      }),
    );
  });

  it("destroys a paused sandbox without resuming it", async () => {
    const cluster = freshCluster();
    await withRuntime(cluster, (runtime) =>
      Effect.gen(function* () {
        const sandbox = yield* runtime.create;
        yield* runtime.pause(sandbox);
        yield* runtime.destroy(sandbox);
        expect(cluster.resources()).toEqual([]);
        expect(cluster.calls).not.toContain(`setMode ${sandbox.id} Running`);
      }),
    );
  });

  it("deletes every sandbox it still holds when it is released", async () => {
    const cluster = freshCluster();
    const ids = await withRuntime(cluster, (runtime) =>
      Effect.gen(function* () {
        const first = yield* runtime.create;
        const second = yield* runtime.create;
        yield* runtime.pause(second);
        return [first.id, second.id];
      }),
    );
    expect(ids).toHaveLength(2);
    expect(cluster.resources()).toEqual([]);
  });

  it("deletes a resource that never became ready, and says why it gave up", async () => {
    const cluster = freshCluster("stuck");
    const exit = await withRuntime(
      cluster,
      (runtime) => Effect.exit(runtime.create),
      {
        settleTimeout: "100 millis",
      },
    );
    expect(Exit.isFailure(exit)).toBe(true);
    const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;
    expect(error).toMatchObject({ _tag: "SandboxFileError", code: "unknown" });
    expect(String((error as { message?: string }).message)).toMatch(
      /was not running after .*: Pod is pending/,
    );
    expect(cluster.resources()).toEqual([]);
  });

  it("fails a create whose pod failed at once, and deletes it", async () => {
    const cluster = freshCluster("failing");
    const exit = await withRuntime(cluster, (runtime) =>
      Effect.exit(runtime.create),
    );
    const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;
    expect(String((error as { message?: string }).message)).toMatch(
      /Pod failed/,
    );
    expect(cluster.resources()).toEqual([]);
  });
});
