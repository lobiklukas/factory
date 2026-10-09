/**
 * The hook is the seam, not decoration (docs/design.md D15).
 *
 * `policy.attack.test.ts` proves the decision; `policy.hook.test.ts` proves a refusal reaches the
 * transcript through a real harness. This file is about the *other* half of `hook(ToolTask, {
 * beforeTool, afterTool })`: that both handlers are registered on the tool task, that `afterTool`
 * returns every shape of result unchanged, and that it really runs — after execution, before the
 * result entry — when a harness installs this extension.
 *
 * What each check can and cannot see, stated plainly, because "registered and identity" is close to
 * unobservable:
 *
 * - Registration is read off the extension object the harness installs, and off the registry
 *   snapshot the harness itself resolved, so a hook that was dropped or renamed is caught.
 * - `afterTool`'s identity is asserted by reference (`toBe`): the handler returns the same object it
 *   was given, for an empty result, a text result, an error result, and one with details and
 *   diagnostics. A handler that rebuilt the result would fail every row.
 * - That it *runs* is proven through a real harness by installing a probe extension *before* the
 *   policy: the probe replaces the result, and the marker survives to the transcript, which a
 *   handler that returned a stashed pre-hook result would lose. The marker also proves the
 *   extension's hook is composed in install order with the others.
 * - Because an identity handler and an absent handler produce the same result value, no test can
 *   distinguish those two cases; the registration assertion above is what stands in for it.
 *
 * The harness here is built the way `openSession` builds one, because the point is to install an
 * extra extension and `openSession` takes none. `policy.hook.test.ts` covers the `openSession` path.
 *
 * Offline: the model is pi-ai's in-process faux provider and the storage is in memory.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JsonObject, ToolCall } from "@earendil-works/pi-ai";
import {
  createRegistry,
  defineExtension,
  Harness as HarnessRuntime,
  hook,
  MemoryStorage,
  ToolTask,
  type Extension,
  type Registry,
  type ToolExecutionResult,
} from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { TranscriptEntry } from "@repo/domain/Session";
import { createModelAccess } from "./models";
import {
  autonomyPolicy,
  DEFAULT_AUTONOMY,
  POLICY_EXTENSION,
  policyExtension,
} from "./policy";
import { projectView } from "./projection";
import {
  attempt,
  closeHarness,
  SESSION_PROGRESS,
  submitMessage,
} from "./session";

const worktree = mkdtempSync(join(tmpdir(), "factory-policy-seam-"));
const policy = autonomyPolicy(DEFAULT_AUTONOMY, worktree);

const extension = policyExtension(policy);
const registration = extension.hooks?.[0];

/** The two handlers as this module uses them: `beforeTool` reads the call, `afterTool` the result. */
type Seam = {
  readonly beforeTool?: (
    call: ToolCall,
  ) => Promise<{ readonly block?: string } | undefined> | undefined;
  readonly afterTool?: (
    call: ToolCall,
    result: ToolExecutionResult,
  ) => ToolExecutionResult | undefined;
};

const seam = (registration?.handlers ?? {}) as Seam;

const bash = (command: string): ToolCall => ({
  type: "toolCall",
  id: "call-1",
  name: "bash",
  arguments: { command } as JsonObject,
});

/** The text of the last tool result, which is what the model reads. */
const toolResults = (
  entries: readonly TranscriptEntry[],
): readonly TranscriptEntry[] =>
  entries.filter((entry) => entry.kind === "toolResult");

const MARKER = "[probe afterTool]";

/** A probe that records what it was given and replaces the result, installed before the policy. */
const probeAfterTool = (seen: ToolExecutionResult[]): Extension =>
  defineExtension({
    name: "probe-after-tool",
    hooks: [
      hook(ToolTask, {
        afterTool: (_call, result) => {
          seen.push(result);
          return {
            ...result,
            content: [
              ...(result.content ?? []),
              { type: "text" as const, text: MARKER },
            ],
          };
        },
      }),
    ],
  });

/** One turn through a harness built like `openSession`'s, with extra extensions installed first. */
const runTurn = async (
  command: string,
  extras: readonly Extension[] = [],
): Promise<{
  readonly entries: readonly TranscriptEntry[];
  readonly registry: Registry;
}> => {
  const model = createModelAccess("faux", { fauxCommand: command });
  const registry = createRegistry();
  registry.install(CodingTools);
  for (const extra of extras) registry.install(extra);
  registry.install(policyExtension(policy));

  const harness = await Effect.runPromise(
    attempt("open harness", () =>
      HarnessRuntime.open(
        new MemoryStorage(),
        {
          models: model.models,
          registry,
          env: (target) =>
            new NodeExecutionEnv({ cwd: target.cwd ?? worktree }),
          settings: { progress: SESSION_PROGRESS },
        },
        BACKGROUND_CONTEXT,
      ),
    ),
  );
  const root = await Effect.runPromise(
    attempt("open root conversation", () =>
      harness.root(BACKGROUND_CONTEXT, {
        agent: {
          model: { provider: model.provider, modelId: model.modelId },
          cwd: worktree,
        },
      }),
    ),
  );

  const submitted = await Effect.runPromise(
    submitMessage(root, { content: "seam", requestId: "seam" }),
  );
  const settled = await submitted.submission.wait(BACKGROUND_CONTEXT);
  expect(settled.status).toBe("done");

  const view = await root.viewState(BACKGROUND_CONTEXT);
  const projection = projectView(view.value);
  view.dispose();
  await Effect.runPromise(closeHarness(harness));
  return { entries: projection.entries, registry };
};

describe("policyExtension registers the hook D15 names", () => {
  it("is one extension, named, with one hook on the built-in tool task", () => {
    expect(extension.name).toBe(POLICY_EXTENSION);
    expect(POLICY_EXTENSION).toBe("policy");
    expect(extension.hooks?.length).toBe(1);
    // The task `name` is what the runtime looks hooks up by; a rename here would silently
    // uninstall the policy.
    expect(registration?.task).toBe(ToolTask.definition.name);
    expect(registration?.task).toBe("pi.tool");
  });

  it("registers both handlers", () => {
    expect(typeof seam.beforeTool).toBe("function");
    expect(typeof seam.afterTool).toBe("function");
  });
});

describe("the beforeTool handler is the decision", () => {
  it("returns no decision for a call the policy allows", async () => {
    expect(await seam.beforeTool?.(bash("echo faux-ok"))).toBeUndefined();
  });

  it("returns the refusal for a call the policy blocks", async () => {
    const decision = await seam.beforeTool?.(bash("git push origin main"));
    expect(decision?.block).toContain("pushing refs/heads/main is refused");
  });
});

describe("the afterTool handler leaves the result alone", () => {
  it.each([
    ["an empty result", {}],
    ["a text result", { content: [{ type: "text" as const, text: "hello" }] }],
    [
      "an error result",
      { isError: true, content: [{ type: "text" as const, text: "boom" }] },
    ],
    ["a result with details", { details: { lines: 3 } }],
    [
      "a result with diagnostics",
      { diagnostics: [{ severity: "info" as const, message: "note" }] },
    ],
    ["an empty content list", { content: [] }],
  ])("returns %s by reference", (_label, result) => {
    const shape = result as ToolExecutionResult;
    expect(seam.afterTool?.(bash("echo faux-ok"), shape)).toBe(shape);
  });
});

describe("the afterTool hook in a real harness", () => {
  it("runs after the tool executes and passes an earlier hook's result through", async () => {
    const seen: ToolExecutionResult[] = [];
    const { entries, registry } = await runTurn("echo faux-seam", [
      probeAfterTool(seen),
    ]);

    const result = toolResults(entries)[0];
    expect(result?.isError).toBe(false);
    // The tool really ran…
    expect(result?.text).toContain("faux-seam");
    // …a hook that replaced the result ran before the policy's…
    expect(seen.length).toBe(1);
    // …and the replacement reached the transcript, so the policy's handler returned what it was
    // given rather than anything stashed earlier.
    expect(result?.text).toContain(MARKER);
    // In the same registry the harness resolved, the policy registers for the tool task.
    expect(
      registry.snapshot().extension(POLICY_EXTENSION)?.hooks?.[0]?.task,
    ).toBe(ToolTask.definition.name);
  });

  it("does not run afterTool for a call the policy blocked", async () => {
    const seen: ToolExecutionResult[] = [];
    const { entries } = await runTurn("git push origin main", [
      probeAfterTool(seen),
    ]);

    const result = toolResults(entries)[0];
    expect(result?.isError).toBe(true);
    expect(result?.text).toContain("Tool call blocked");
    // pi-durable 1.0.3 settles a blocked call before executing it, so the after-the-execution hook
    // never runs. It matters for LOB-52: an audit written in `afterTool` does not see a refusal.
    expect(seen.length).toBe(0);
    expect(result?.text).not.toContain(MARKER);
  });
});
