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
 * - The memo is what holds across a recovery. A real Pi Durable harness asks, memoizes, and then
 *   loses the commit that would settle the tool call — the crash window `api.memo` exists for. A
 *   second harness over the same log reruns the tool task, and the hook reads the memo back instead
 *   of asking again. Removing either the memo read or the memo write makes the asker run twice, which
 *   is the assertion that fails.
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

const GATES = ["npm publish", "sleep"];
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
  ])("`%s` asks, naming the gate `%s`", (command, gate) => {
    const settled = decision(bash(command));
    expect(settled).toMatchObject({ _tag: "ask", action: gate });
  });

  it.each([
    "npm publishing",
    "npm install",
    "echo npm publish",
    "sleepy",
    "ls -la",
  ])("`%s` runs unasked", (command) => {
    expect(decision(bash(command))._tag).toBe("allow");
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

/** An asker that answers `answer` and records every ask it was given. */
const recordingAsker = (
  answer: ApprovalAnswer = { _tag: "pending" },
): { readonly asks: ApprovalAsk[]; readonly ask: ApprovalAsker } => {
  const asks: ApprovalAsk[] = [];
  return {
    asks,
    ask: (ask) =>
      Effect.sync(() => {
        asks.push(ask);
        return answer;
      }),
  };
};

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
      ...(options.ask === undefined ? {} : { ask: options.ask }),
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
    const asker = recordingAsker({ _tag: "approved", actor: "ops@example" });
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
    const asker = recordingAsker({ _tag: "denied", actor: "ops@example" });
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

  it("blocks the call when the ask could not be recorded", async () => {
    const worktree = mkdtempSync(join(tmpdir(), "factory-approval-"));
    const asker = recordingAsker({ _tag: "unrecorded", reason: "db down" });
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
 * A storage over `inner` that loses the first commit settling a tool call once `armed` says so — the
 * process dying after the hook asked and memoized, before the blocked result was written. Closing it
 * leaves `inner` open, so a second harness can recover from the same log.
 */
const crashingStorage = (
  inner: MemoryStorage,
  armed: () => boolean,
): { readonly storage: Storage; readonly lost: () => boolean } => {
  let lost = false;
  const storage = new Proxy(inner, {
    get(target, property, receiver) {
      if (property === "commit") {
        return (writes: readonly StorageWrite[], context: ChordContext) => {
          if (!lost && armed() && settlesToolCall(writes)) {
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

describe("the memo holds the ask across a recovery", () => {
  it("does not ask again when the tool task is rerun after a crash", async () => {
    const worktree = mkdtempSync(join(tmpdir(), "factory-approval-"));
    const command = "sleep 30";
    const asker = recordingAsker();
    const inner = new MemoryStorage();
    const crash = crashingStorage(inner, () => asker.asks.length > 0);
    const policy = autonomyPolicy(config, worktree);

    const first = await Effect.runPromise(
      openSession({
        storage: crash.storage,
        model: scripted(command),
        cwd: worktree,
        policy,
        ask: asker.ask,
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
        ask: asker.ask,
      }),
    );
    second.harness.resume();
    await second.harness.waitForIdle(BACKGROUND_CONTEXT);
    const view = await second.root.viewState(BACKGROUND_CONTEXT);
    const entries = projectView(view.value).entries;
    view.dispose();
    await Effect.runPromise(closeHarness(second.harness));

    // One ask across both processes: the rerun read the memo back.
    expect(asker.asks).toHaveLength(1);
    const results = toolResults(entries);
    expect(results).toHaveLength(1);
    expect(results[0]?.text).toContain("is not asked for again");
  });
});
