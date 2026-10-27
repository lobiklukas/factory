/**
 * The specifying run's `spec` tool, at the harness seam (LOB-238).
 *
 * The card is the control plane's; what is proven here is what the harness does with the callback it
 * is handed: that a specifier run calls the tool and the spec is committed to its log and posted, that
 * a spec without `gaps` is refused with LOB-72's sentence naming the field — nothing committed,
 * nothing posted — and the run retries, that a spec with gaps still parks the run through the ask,
 * and that no other run is offered the tool. `packages/core`'s session suite drives the same path
 * through a real card, and `.pi/skills/verify-board/drive.sh` through `factory board`.
 *
 * No database: Pi Durable's in-memory storage and the faux provider, so this runs in the default gate.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolCall } from "@earendil-works/pi-ai";
import { MemoryStorage } from "@earendil-works/pi-durable";
import type { TranscriptEntry } from "@repo/domain/Session";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { ASK_TOOL, type AskOptions } from "./ask";
import type { RunProfile } from "./loader";
import { createFauxModelAccess, type FauxSpecAttempt } from "./models";
import { decideStageCall, readOnlyStageOf } from "./policy";
import {
  closeHarness,
  isBusy,
  openSession,
  readOfferedTools,
  readSessionLog,
  readSpec,
  submitMessage,
} from "./session";
import type { Spec } from "./spec";
import {
  describeSpec,
  SPEC_TOOL,
  type SpecOptions,
  type SpecReceipt,
} from "./specify";

const TASK = "tsk_00000000000000000000000000";
const QUESTION = "Which Postgres major does this card target?";

const SPEC = {
  goal: "Pin the card's Postgres major",
  acceptance: ["the compose file names one major"],
  gaps: ["which major the card targets"],
  openQuestions: [QUESTION],
} as const;

/** The spec a model that forgot the field sends: every field but `gaps`. */
const WITHOUT_GAPS: FauxSpecAttempt = {
  goal: SPEC.goal,
  acceptance: [...SPEC.acceptance],
  openQuestions: [...SPEC.openQuestions],
};

const COMPLETE: FauxSpecAttempt = {
  ...WITHOUT_GAPS,
  gaps: [...SPEC.gaps],
};

const call = (name: string, args: ToolCall["arguments"]): ToolCall => ({
  type: "toolCall",
  id: "call-1",
  name,
  arguments: args,
});

const specifier: RunProfile = {
  column: "specifying",
  role: "specifier",
  skills: [],
};

/** A poster that records what it was handed and answers the card at revision 3. */
const recorder = () => {
  const posts: { spec: Spec; callId: string }[] = [];
  const options: SpecOptions = {
    post: (request) => {
      posts.push(request);
      return Promise.resolve<SpecReceipt>({ taskId: TASK, revision: 3 });
    },
  };
  return { posts, options };
};

/** One run of a session, settled: its log, its spec, what it was offered, and whether it is busy. */
const runOnce = (options: {
  readonly run?: RunProfile;
  readonly spec?: SpecOptions;
  readonly ask?: AskOptions;
  readonly attempts: readonly FauxSpecAttempt[];
  readonly fauxAsk?: string;
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const faux = createFauxModelAccess({
        fauxSpec: options.attempts,
        ...(options.fauxAsk === undefined ? {} : { fauxAsk: options.fauxAsk }),
      });
      const storage = new MemoryStorage();
      const { harness, root } = yield* openSession({
        storage,
        model: faux.access,
        cwd: mkdtempSync(join(tmpdir(), "factory-specify-")),
        ...(options.run === undefined ? {} : { run: options.run }),
        ...(options.spec === undefined ? {} : { spec: options.spec }),
        ...(options.ask === undefined ? {} : { ask: options.ask }),
      });
      const submitted = yield* submitMessage(root, {
        content: "specify this card",
      });
      yield* Effect.promise(() =>
        submitted.submission.wait(BACKGROUND_CONTEXT),
      );
      const busy = yield* isBusy(harness, root);
      const spec = yield* readSpec(harness, root);
      // The read-only fold's spec: what a reader of the log finds, not a value the harness kept.
      const log = yield* readSessionLog(storage);
      const offered = yield* readOfferedTools(storage);
      yield* closeHarness(harness);
      return { busy, spec, stored: log.spec, offered, entries: log.entries };
    }),
  );

const specResults = (entries: ReadonlyArray<TranscriptEntry>) =>
  entries.filter(
    (entry) => entry.kind === "toolResult" && entry.toolName === SPEC_TOOL,
  );

describe("the spec tool", () => {
  it("commits a specifier's spec to its log and posts it on the card", async () => {
    const { posts, options } = recorder();
    const ran = await runOnce({
      run: specifier,
      spec: options,
      attempts: [COMPLETE],
    });

    expect(ran.offered).toContain(SPEC_TOOL);
    expect(ran.spec).toEqual(SPEC);
    expect(ran.stored).toEqual(SPEC);
    expect(posts).toHaveLength(1);
    expect(posts[0]?.spec).toEqual(SPEC);
    const results = specResults(ran.entries);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      isError: false,
      text: describeSpec(SPEC, { taskId: TASK, revision: 3 }),
    });
    // The call id the post was keyed by is the logged call's, so a replay finds its own post.
    const call = ran.entries
      .flatMap((entry) => entry.toolCalls)
      .find((ref) => ref.name === SPEC_TOOL);
    expect(call?.id).toBeDefined();
    expect(posts[0]?.callId).toBe(call?.id);
    // The run goes on after it specs: the spec does not end it.
    expect(ran.entries.at(-1)?.kind).toBe("assistant");
    expect(ran.busy).toBe(false);
  });

  it("refuses a spec missing `gaps`, naming the field, and the run retries with it", async () => {
    const { posts, options } = recorder();
    const ran = await runOnce({
      run: specifier,
      spec: options,
      attempts: [WITHOUT_GAPS, COMPLETE],
    });

    const results = specResults(ran.entries);
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ isError: true });
    expect(results[0]?.text).toContain(
      "spec refused: `gaps` is missing — declare the gaps, `[]` when there are none",
    );
    // The refusal posted nothing; the retry is the one post, and the log holds the retry's spec.
    expect(posts).toHaveLength(1);
    expect(results[1]).toMatchObject({ isError: false });
    expect(ran.spec).toEqual(SPEC);
  });

  it("commits and posts nothing when every attempt is refused", async () => {
    const { posts, options } = recorder();
    const ran = await runOnce({
      run: specifier,
      spec: options,
      attempts: [WITHOUT_GAPS, { ...COMPLETE, goal: "" }],
    });

    const results = specResults(ran.entries);
    expect(results.map((result) => result.isError)).toEqual([true, true]);
    expect(results[1]?.text).toContain("`goal` is invalid");
    expect(posts).toHaveLength(0);
    expect(ran.spec).toBeUndefined();
    expect(ran.stored).toBeUndefined();
  });

  it("accepts `gaps: []`, the explicit none", async () => {
    const { posts, options } = recorder();
    const ran = await runOnce({
      run: specifier,
      spec: options,
      attempts: [{ ...COMPLETE, gaps: [], openQuestions: [] }],
    });

    expect(ran.spec).toEqual({ ...SPEC, gaps: [], openQuestions: [] });
    expect(posts[0]?.spec.gaps).toEqual([]);
    expect(specResults(ran.entries)[0]?.text).toContain(
      "Gaps: none. Nothing is left to ask.",
    );
  });

  it("reports a post the card refused as the tool's error, with the spec in the log", async () => {
    const ran = await runOnce({
      run: specifier,
      spec: { post: () => Promise.reject(new Error("no task tsk_gone")) },
      attempts: [COMPLETE],
    });

    const results = specResults(ran.entries);
    expect(results[0]).toMatchObject({ isError: true });
    expect(results[0]?.text).toContain("no task tsk_gone");
    expect(ran.spec).toEqual(SPEC);
    expect(ran.entries.at(-1)?.kind).toBe("assistant");
  });

  it("still parks a spec with gaps through the ask", async () => {
    const { posts, options } = recorder();
    const asked: string[] = [];
    const ran = await runOnce({
      run: specifier,
      spec: options,
      ask: {
        ask: ({ question }) => {
          asked.push(question);
          return Promise.resolve({
            taskId: TASK,
            column: "specifying",
            revision: 5,
          });
        },
      },
      attempts: [COMPLETE],
      fauxAsk: QUESTION,
    });

    // The spec first, then the ask, which ends the run: declaring a gap is not asking anyone.
    expect(posts).toHaveLength(1);
    expect(asked).toEqual([QUESTION]);
    const tools = ran.entries
      .filter((entry) => entry.kind === "toolResult")
      .map((entry) => entry.toolName);
    expect(tools).toEqual(["bash", SPEC_TOOL, ASK_TOOL]);
    expect(ran.entries.at(-1)?.toolName).toBe(ASK_TOOL);
    expect(ran.busy).toBe(false);
  });
});

describe("who is offered the spec tool", () => {
  it("is not offered outside the specifying role, so no other run can spec", async () => {
    const { posts, options } = recorder();
    for (const run of [
      { column: "planning", role: "planner", skills: [] },
      { column: "building", role: "builder", skills: [] },
      { column: "intake", skills: [] },
      undefined,
    ] satisfies (RunProfile | undefined)[]) {
      const ran = await runOnce({
        ...(run === undefined ? {} : { run }),
        spec: options,
        attempts: [COMPLETE],
      });
      expect(ran.offered).not.toContain(SPEC_TOOL);
      expect(specResults(ran.entries)).toHaveLength(0);
      expect(ran.spec).toBeUndefined();
    }
    expect(posts).toHaveLength(0);
  });

  it("is not offered to a specifier with no card to post on", async () => {
    const ran = await runOnce({ run: specifier, attempts: [COMPLETE] });
    expect(ran.offered).not.toContain(SPEC_TOOL);
    expect(ran.spec).toBeUndefined();
  });

  it("is a call the read-only stage lets through, while its refusals stand", () => {
    const stage = readOnlyStageOf(specifier);
    expect(stage).toBeDefined();
    if (stage === undefined) return;
    expect(decideStageCall(stage, call(SPEC_TOOL, COMPLETE))).toEqual({
      _tag: "allow",
    });
    expect(
      decideStageCall(stage, call("write", { path: "spec.md", content: "x" }))
        ._tag,
    ).toBe("block");
  });
});
