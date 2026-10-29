/**
 * The `kubectl` cluster seam (LOB-89) over a scripted spawner: no `kubectl` process runs, each
 * call is answered by the case, so what the seam does with an answer — and what it remembers of
 * one — is all that is under test. What `kubectl` itself does is the verify-sandbox drive's.
 */
import { Effect, Exit, Layer, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { describe, expect, it } from "vitest";
import { kubectlCluster } from "./Kubectl";
import { sandboxManifest } from "./manifest";

type Answer = { readonly exitCode: number; readonly stderr?: string };

/** A spawner that records every `kubectl` argument list and answers each with `answer`. */
const scripted = (answer: (args: ReadonlyArray<string>) => Answer) => {
  const calls: Array<ReadonlyArray<string>> = [];
  const encoder = new TextEncoder();
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.sync(() => {
      const args = command._tag === "StandardCommand" ? command.args : [];
      calls.push(args);
      const { exitCode, stderr = "" } = answer(args);
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: Sink.drain,
        stdout: Stream.empty,
        stderr: Stream.make(encoder.encode(stderr)),
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      });
    }),
  );
  return {
    calls,
    layer: Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
  };
};

const manifest = (name: string) =>
  sandboxManifest({
    name,
    namespace: "factory-test",
    workdir: `/workspace/${name}`,
  });

const isApply = (args: ReadonlyArray<string>) => args.includes("apply");

describe("kubectl cluster", () => {
  it("retries the namespace after a failed first apply, then applies it no more once it succeeded", async () => {
    let applies = 0;
    const { calls, layer } = scripted((args) => {
      if (!isApply(args)) return { exitCode: 0 };
      applies += 1;
      return applies === 1
        ? { exitCode: 1, stderr: "The connection to the server was refused" }
        : { exitCode: 0 };
    });
    const exits = await Effect.runPromise(
      Effect.gen(function* () {
        const cluster = yield* kubectlCluster({
          context: "kind-test",
          namespace: "factory-test",
        });
        const first = yield* Effect.exit(cluster.create(manifest("sbx-a")));
        const second = yield* Effect.exit(cluster.create(manifest("sbx-b")));
        const third = yield* Effect.exit(cluster.create(manifest("sbx-c")));
        return [first, second, third];
      }).pipe(Effect.provide(layer)),
    );
    expect(exits.map(Exit.isSuccess)).toEqual([false, true, true]);
    expect(String(exits[0])).toContain("connection to the server was refused");
    // Two applies (the failure, then the success), three creates — and no create after the failure
    // was refused by a remembered one.
    expect(calls.filter(isApply)).toHaveLength(2);
    expect(calls.filter((args) => args.includes("create"))).toHaveLength(2);
  });
});
