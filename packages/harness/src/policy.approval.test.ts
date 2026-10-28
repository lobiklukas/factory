/**
 * A gated call asks once (docs/design.md D15, LOB-52).
 *
 * Three layers, each proving what the one below cannot:
 *
 * - The gate is a decision: which commands ask, which do not, that a refusal outranks a gate, and that
 *   the request id is a function of the call alone — the property every "do not ask twice" rests on.
 * - The ask is delivered through a real harness: the call is blocked with the asked sentence, the
 *   command does not run, the asker is called once, and the run settles rather than waiting — a run
 *   parked on a person is not busy. An answer that is already settled runs or refuses the call.
 * - The memo is what holds across a recovery. A real Pi Durable harness asks, is approved, memoizes,
 *   runs the call, and then loses the commit that would settle the tool call — the crash window
 *   `api.memo` exists for. A second harness over the same log reruns the tool task, and the hook
 *   reads the approval back instead of asking again. The asker spends an approval the way the
 *   control plane's does (one run per yes), so removing either the memo read or the memo write makes
 *   the rerun ask again, be told `pending`, and block a call a person approved — the assertion that
 *   fails. A pending answer is not memoized: the rerun asks again, and the recorder answers from the
 *   request it holds — still waiting, or approved while the process was down.
 *
 * No database and no model: the storage is Pi Durable's in-memory implementation (wrapped, for the
 * crash, so one commit can be lost) and the model is pi-ai's scripted faux provider.
 */
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context as ChordContext } from "@earendil-works/chord";
import type { ToolCall } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai/providers/faux";
import {
  MemoryStorage,
  type Storage,
  type StorageWrite,
} from "@earendil-works/pi-durable";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { TranscriptEntry } from "@repo/domain/Session";
import type { ModelAccess } from "./models";
import {
  approvalRequestId,
  autonomyPolicy,
  autonomyRules,
  decideToolCall,
  DEFAULT_AUTONOMY,
  docsPolicy,
  type ApprovalAnswer,
  type ApprovalAsk,
  type ApprovalAsker,
} from "./policy";
import { projectView } from "./projection";
import { closeHarness, isBusy, openSession, submitMessage } from "./session";

const GATES = ["npm publish", "sleep", "terraform apply"];
const config = { ...DEFAULT_AUTONOMY, approvalRequired: GATES };

const bash = (command: string): ToolCall => ({
  type: "toolCall",
  id: "call_1",
  name: "bash",
  arguments: { command },
});

describe("the gate decides which calls ask", () => {
  const rules = autonomyRules(config, "/work/ses_1");
  const decision = (call: ToolCall) => decideToolCall(rules, call);

  it.each([
    ["npm publish", "npm publish"],
    ["npm publish --tag next", "npm publish"],
    ["cd pkg && npm publish", "npm publish"],
    ["sudo npm publish", "npm publish"],
    ["/usr/bin/npm   publish", "npm publish"],
    ["echo start; sleep 30 && echo done", "sleep"],
    // Flags between the command and its subcommand (LOB-52 review).
    ["npm --registry https://r.example publish", "npm publish"],
    ["npm --workspace=pkg publish", "npm publish"],
    ["terraform -chdir=infra apply", "terraform apply"],
    // Commands that run another command, and compound commands.
    ["timeout 60 npm publish", "npm publish"],
    ["timeout -s KILL 60 npm publish", "npm publish"],
    ["xargs npm publish", "npm publish"],
    ["ls | xargs -n 1 npm publish", "npm publish"],
    ["{ npm publish; }", "npm publish"],
    ["if true; then npm publish; fi", "npm publish"],
    ["bash -c 'npm publish'", "npm publish"],
    ['sh -lc "cd pkg && npm publish"', "npm publish"],
  ])("`%s` asks, naming the gate `%s`", (command, gate) => {
    const settled = decision(bash(command));
    expect(settled).toMatchObject({ _tag: "ask", action: gate });
  });

  it.each([
    "npm publishing",
    "npm install",
    "npm run publish",
    "echo npm publish",
    "echo 'bash -c npm publish'",
    "timeout 60 npm install",
    "sleepy",
    "ls -la",
  ])("`%s` runs unasked", (command) => {
    expect(decision(bash(command))._tag).toBe("allow");
  });

  it("reads a configured gate's command word as a command's: a path gates its basename", () => {
    const pathed = autonomyRules(
      { ...DEFAULT_AUTONOMY, approvalRequired: ["/usr/bin/npm  publish"] },
      "/work/ses_1",
    );
    expect(pathed.approvalRequired).toEqual(["npm publish"]);
    expect(decideToolCall(pathed, bash("npm publish"))).toMatchObject({
      _tag: "ask",
      action: "npm publish",
    });
  });

  it("asks about nothing when no gate is configured", () => {
    const ungated = autonomyRules(DEFAULT_AUTONOMY, "/work/ses_1");
    expect(decideToolCall(ungated, bash("npm publish"))._tag).toBe("allow");
  });

  it("ignores an empty gate rather than gating every command", () => {
    const blank = autonomyRules(
      { ...DEFAULT_AUTONOMY, approvalRequired: ["  ", ""] },
      "/work/ses_1",
    );
    expect(blank.approvalRequired).toEqual([]);
    expect(decideToolCall(blank, bash("ls"))._tag).toBe("allow");
  });

  it("gates only shell commands", () => {
    const write: ToolCall = {
      type: "toolCall",
      id: "call_1",
      name: "write",
      arguments: { path: "/work/ses_1/sleep", content: "npm publish" },
    };
    expect(decision(write)._tag).toBe("allow");
  });

  it("refuses rather than asks when D11 refuses the call", () => {
    // Asking a person about a refused call would let them widen D11 one call at a time.
    const settled = decision(bash("sleep 1 && git push origin main"));
    expect(settled._tag).toBe("block");
  });

  it("names the same request for the same call, however its arguments are ordered", () => {
    const one: ToolCall = {
      type: "toolCall",
      id: "call_1",
      name: "bash",
      arguments: { command: "npm publish", timeout: 30 },
    };
    const two: ToolCall = {
      type: "toolCall",
      id: "call_2",
      name: "bash",
      arguments: { timeout: 30, command: "npm publish" },
    };
    expect(approvalRequestId(one)).toBe(approvalRequestId(two));
    expect(approvalRequestId(one)).not.toBe(
      approvalRequestId(bash("npm publish --tag next")),
    );
    expect(approvalRequestId(one)).toMatch(/^ask-bash-[0-9a-f]{32}$/);
  });

  it("is carried through a docs run's narrower policy", () => {
    const docs = docsPolicy(autonomyPolicy(config, "/work/ses_1"));
    const settled = Effect.runSync(docs.decide(bash("npm publish")));
    expect(settled._tag).toBe("ask");
  });
});

// ---------------------------------------------------------------------------------------------
// Through a real harness
// ---------------------------------------------------------------------------------------------

/**
 * A model that calls `bash` with `command` once, then answers. `undefined` only answers: the model a
 * recovering process runs, whose call is already in the log.
 */
const scripted = (command: string | undefined): ModelAccess => {
  const models = createModels();
  const faux = fauxProvider();
  models.setProvider(faux.provider);
  let called = command === undefined;
  const step: FauxResponseFactory = () => {
    faux.appendResponses([step]);
    if (called) return fauxAssistantMessage("done");
    called = true;
    return fauxAssistantMessage(
      fauxToolCall("bash", { command: command ?? "" }),
      {
        stopReason: "toolUse",
      },
    );
  };
  faux.setResponses([step]);
  return {
    backend: "faux",
    models,
    provider: "faux",
    modelId: faux.models[0].id,
    contextWindow: faux.models[0].contextWindow,
  };
};

/**
 * An asker that records every ask it was given and answers the `n`-th with `answer(ask, n)`; by
 * default, a freshly recorded pending request under the call's own id.
 */
const recordingAsker = (
  answer: (ask: ApprovalAsk, n: number) => ApprovalAnswer = (ask) => ({
    _tag: "pending",
    requestId: ask.requestId,
    fresh: true,
  }),
): { readonly asks: ApprovalAsk[]; readonly ask: ApprovalAsker } => {
  const asks: ApprovalAsk[] = [];
  return {
    asks,
    ask: (ask) =>
      Effect.sync(() => {
        asks.push(ask);
        return answer(ask, asks.length);
      }),
  };
};

/**
 * An asker that spends an approval as the control plane's does: the first ask is answered
 * `approved`, and every ask after it finds that approval used and records a fresh request.
 */
const spendingAsker = () =>
  recordingAsker((ask, n) =>
    n === 1
      ? { _tag: "approved", requestId: ask.requestId, actor: "ops@example" }
      : { _tag: "pending", requestId: `${ask.requestId}-${n}`, fresh: true },
  );

const toolResults = (
  entries: readonly TranscriptEntry[],
): readonly TranscriptEntry[] =>
  entries.filter((entry) => entry.kind === "toolResult");

/** Run one turn to idle and return its transcript, and whether the run was still busy after it. */
const turn = async (options: {
  readonly command: string;
  readonly worktree: string;
  readonly ask?: ApprovalAsker;
}): Promise<{
  readonly entries: readonly TranscriptEntry[];
  readonly busy: boolean;
}> => {
  const { harness, root } = await Effect.runPromise(
    openSession({
      storage: new MemoryStorage(),
      model: scripted(options.command),
      cwd: options.worktree,
      policy: autonomyPolicy(config, options.worktree),
      ...(options.ask === undefined ? {} : { approvalAsker: options.ask }),
    }),
  );
  const submitted = await Effect.runPromise(
    submitMessage(root, { content: "go", requestId: "approval" }),
  );
  const settled = await submitted.submission.wait(BACKGROUND_CONTEXT);
  expect(settled.status).toBe("done");
  const busy = await Effect.runPromise(isBusy(harness, root));
  const view = await root.viewState(BACKGROUND_CONTEXT);
  const projection = projectView(view.value);
  view.dispose();
  await Effect.runPromise(closeHarness(harness));
  return { entries: projection.entries, busy };
};

describe("a gated call in a real harness", () => {
  it("asks once, does not run, and leaves the run idle rather than waiting", async () => {
    const worktree = mkdtempSync(join(tmpdir(), "factory-approval-"));
    const marker = join(worktree, "ran.txt");
    const asker = recordingAsker();
    const command = `sleep 30 && echo ran > ${marker}`;
    const { entries, busy } = await turn({ command, worktree, ask: asker.ask });

    expect(asker.asks).toEqual([
      {
        requestId: approvalRequestId(bash(command)),
        action: "sleep",
        detail: command,
      },
    ]);
    const result = toolResults(entries)[0];
    expect(result?.isError).toBe(true);
    expect(result?.text).toContain("Tool call blocked");
    expect(result?.text).toContain("one has been asked for");
    expect(result?.text).toContain(approvalRequestId(bash(command)));
    // The command never ran: a 30-second sleep that ran would have held the turn, and the marker
    // would exist.
    expect(existsSync(marker)).toBe(false);
    // Parked, not waiting: the turn ended with the ask outstanding.
    expect(busy).toBe(false);
    expect(entries.at(-1)?.text).toBe("done");
  });

  it("runs the call once the request was approved", async () => {
    const worktree = mkdtempSync(join(tmpdir(), "factory-approval-"));
    const marker = join(worktree, "ran.txt");
    const asker = recordingAsker((ask) => ({
      _tag: "approved",
      requestId: ask.requestId,
      actor: "ops@example",
    }));
    const { entries } = await turn({
      command: `sleep 0 && echo ran > ${marker}`,
      worktree,
      ask: asker.ask,
    });

    expect(asker.asks).toHaveLength(1);
    expect(toolResults(entries)[0]?.isError).toBe(false);
    expect(existsSync(marker)).toBe(true);
  });

  it("refuses the call once the request was denied, naming who denied it", async () => {
    const worktree = mkdtempSync(join(tmpdir(), "factory-approval-"));
    const marker = join(worktree, "ran.txt");
    const asker = recordingAsker((ask) => ({
      _tag: "denied",
      requestId: ask.requestId,
      actor: "ops@example",
    }));
    const { entries } = await turn({
      command: `sleep 0 && echo ran > ${marker}`,
      worktree,
      ask: asker.ask,
    });

    const result = toolResults(entries)[0];
    expect(result?.isError).toBe(true);
    expect(result?.text).toContain("was denied by ops@example");
    expect(existsSync(marker)).toBe(false);
  });

  it("tells a retry of a call still waiting that it was not asked for again", async () => {
    const worktree = mkdtempSync(join(tmpdir(), "factory-approval-"));
    const asker = recordingAsker((ask) => ({
      _tag: "pending",
      requestId: ask.requestId,
      fresh: false,
    }));
    const { entries } = await turn({
      command: "sleep 30",
      worktree,
      ask: asker.ask,
    });

    const result = toolResults(entries)[0];
    expect(result?.isError).toBe(true);
    expect(result?.text).toContain("is not asked for again");
    expect(result?.text).not.toContain("one has been asked for");
  });

  it("names the request the recorder recorded, not only the call's id", async () => {
    const worktree = mkdtempSync(join(tmpdir(), "factory-approval-"));
    const asker = recordingAsker((ask) => ({
      _tag: "pending",
      requestId: `${ask.requestId}-2`,
      fresh: true,
    }));
    const { entries } = await turn({
      command: "sleep 30",
      worktree,
      ask: asker.ask,
    });

    const result = toolResults(entries)[0];
    expect(result?.text).toContain(`${approvalRequestId(bash("sleep 30"))}-2`);
  });

  it("blocks the call when the ask could not be recorded", async () => {
    const worktree = mkdtempSync(join(tmpdir(), "factory-approval-"));
    const asker = recordingAsker(() => ({
      _tag: "unrecorded",
      reason: "db down",
    }));
    const { entries } = await turn({
      command: "sleep 30",
      worktree,
      ask: asker.ask,
    });

    const result = toolResults(entries)[0];
    expect(result?.isError).toBe(true);
    expect(result?.text).toContain("could not be recorded (db down)");
  });

  it("blocks the call when the session has no approval channel", async () => {
    const worktree = mkdtempSync(join(tmpdir(), "factory-approval-"));
    const { entries, busy } = await turn({ command: "sleep 30", worktree });

    const result = toolResults(entries)[0];
    expect(result?.isError).toBe(true);
    expect(result?.text).toContain("no approval channel");
    expect(busy).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// The memo across a recovery
// ---------------------------------------------------------------------------------------------

/** Whether a commit settles a tool call: it writes a `pi.tool` task that can no longer run. */
const settlesToolCall = (writes: readonly StorageWrite[]): boolean =>
  writes.some(
    (write) =>
      write.type === "task" &&
      write.value.kind === "pi.tool" &&
      (write.value.state.status === "terminal" ||
        write.value.state.status === "completing"),
  );

/**
 * Whether a commit records a tool call's intent to run: the `pi.tool` task moves to `running` with
 * its `execute` checkpoint, the step after `beforeTool` allowed it and before the tool starts. Lose
 * it, and recovery reruns the call phase — `beforeTool` included — rather than the tool.
 */
const recordsIntent = (writes: readonly StorageWrite[]): boolean =>
  writes.some(
    (write) =>
      write.type === "task" &&
      write.value.kind === "pi.tool" &&
      write.value.state.status === "running" &&
      JSON.stringify(write.value.state).includes('"phase":"execute"'),
  );

/**
 * A storage over `inner` that loses the first commit `loses` matches once `armed` says so — the
 * process dying after the hook asked and memoized, before the call's next step landed. Closing it
 * leaves `inner` open, so a second harness can recover from the same log.
 */
const crashingStorage = (
  inner: MemoryStorage,
  armed: () => boolean,
  loses: (writes: readonly StorageWrite[]) => boolean,
): { readonly storage: Storage; readonly lost: () => boolean } => {
  let lost = false;
  const storage = new Proxy(inner, {
    get(target, property, receiver) {
      if (property === "commit") {
        return (writes: readonly StorageWrite[], context: ChordContext) => {
          if (!lost && armed() && loses(writes)) {
            lost = true;
            return Promise.reject(new Error("crash: the settle never landed"));
          }
          return target.commit(writes, context);
        };
      }
      if (property === "close") return () => Promise.resolve();
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { storage, lost: () => lost };
};

/**
 * Ask in one harness until the settle of the tool call is lost, then recover in a second harness
 * over the same log, and return what the recovered run settled to.
 */
const crashAndRecover = async (options: {
  readonly command: string;
  readonly worktree: string;
  readonly asker: ReturnType<typeof recordingAsker>;
  /** Which commit the crash loses: by default the blocked result's settle. */
  readonly loses?: (writes: readonly StorageWrite[]) => boolean;
}): Promise<readonly TranscriptEntry[]> => {
  const { command, worktree, asker } = options;
  const inner = new MemoryStorage();
  const crash = crashingStorage(
    inner,
    () => asker.asks.length > 0,
    options.loses ?? settlesToolCall,
  );
  const policy = autonomyPolicy(config, worktree);

  const first = await Effect.runPromise(
    openSession({
      storage: crash.storage,
      model: scripted(command),
      cwd: worktree,
      policy,
      approvalAsker: asker.ask,
    }),
  );
  await Effect.runPromise(
    submitMessage(first.root, { content: "go", requestId: "approval" }),
  );
  await expect
    .poll(() => crash.lost(), { timeout: 10_000, interval: 20 })
    .toBe(true);
  expect(asker.asks).toHaveLength(1);
  await Effect.runPromise(closeHarness(first.harness));

  const second = await Effect.runPromise(
    openSession({
      storage: inner,
      model: scripted(undefined),
      cwd: worktree,
      policy,
      approvalAsker: asker.ask,
    }),
  );
  // The open is the recovery (LOB-25): it continues the run the crash left placed, before anything
  // here asks Pi Durable for progress — `waitForIdle` would enable the scheduler by itself.
  expect(second.resumed).toHaveLength(1);
  expect((await second.harness.inspect(BACKGROUND_CONTEXT)).scheduling).toBe(
    "running",
  );
  await second.harness.waitForIdle(BACKGROUND_CONTEXT);
  const view = await second.root.viewState(BACKGROUND_CONTEXT);
  const entries = projectView(view.value).entries;
  view.dispose();
  await Effect.runPromise(closeHarness(second.harness));
  return entries;
};

describe("the memo holds the answer across a recovery", () => {
  it("runs an approved call's rerun without asking again, so one yes is not spent twice", async () => {
    const worktree = mkdtempSync(join(tmpdir(), "factory-approval-"));
    const marker = join(worktree, "ran.txt");
    const asker = spendingAsker();
    const entries = await crashAndRecover({
      command: `sleep 0 && echo ran >> ${marker}`,
      worktree,
      asker,
      // The approval was answered and memoized; the crash takes the intent to run with it, so the
      // recovery reruns `beforeTool`.
      loses: recordsIntent,
    });

    // One ask across both processes: the rerun read the approval back. Asked again, the spending
    // asker would have answered a fresh `pending` and the rerun would be blocked.
    expect(asker.asks).toHaveLength(1);
    const results = toolResults(entries);
    expect(results).toHaveLength(1);
    expect(results[0]?.isError).toBe(false);
    expect(existsSync(marker)).toBe(true);
  });

  it("asks a pending call's rerun again, and the recorder answers from the request it holds", async () => {
    const worktree = mkdtempSync(join(tmpdir(), "factory-approval-"));
    const asker = recordingAsker((ask, n) => ({
      _tag: "pending",
      requestId: ask.requestId,
      fresh: n === 1,
    }));
    const entries = await crashAndRecover({
      command: "sleep 30",
      worktree,
      asker,
    });

    expect(asker.asks).toHaveLength(2);
    expect(asker.asks[1]).toEqual(asker.asks[0]);
    const results = toolResults(entries);
    expect(results).toHaveLength(1);
    expect(results[0]?.text).toContain("is not asked for again");
  });

  it("runs a pending call's rerun when it was approved while the process was down", async () => {
    const worktree = mkdtempSync(join(tmpdir(), "factory-approval-"));
    const marker = join(worktree, "ran.txt");
    const asker = recordingAsker((ask, n) =>
      n === 1
        ? { _tag: "pending", requestId: ask.requestId, fresh: true }
        : { _tag: "approved", requestId: ask.requestId, actor: "ops@example" },
    );
    const entries = await crashAndRecover({
      command: `sleep 0 && echo ran >> ${marker}`,
      worktree,
      asker,
    });

    expect(asker.asks).toHaveLength(2);
    expect(toolResults(entries)[0]?.isError).toBe(false);
    expect(existsSync(marker)).toBe(true);
  });
});
