/**
 * The decomposition pass at the harness seam (LOB-201, part 1 of LOB-43).
 *
 * What is proven here, without a database: the prompt carries the spec the call decomposes; the faux
 * model's derived answer is one proposal per acceptance criterion, from exactly one call; a scripted
 * answer the rules refuse is `ProposalsRefused`, never a stored set; and the one writer commits only
 * what the validator accepted, which both snapshot paths — live and folded — then report.
 * `packages/core`'s session suite drives the same pass through `proposeDecomposition`, over a spec a
 * real specifier run declared.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStorage } from "@earendil-works/pi-durable";
import {
  ProposalsRefused,
  type ProposedIssue,
} from "@repo/domain/Decomposition";
import { SessionId } from "@repo/domain/Session";
import { Effect, Exit, Option, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  decompositionPrompt,
  decompositionProposals,
  requestDecomposition,
  writeProposedIssues,
} from "./decompose";
import { createFauxModelAccess, fauxAnswer, isFauxTurnStep } from "./models";
import {
  closeHarness,
  openSession,
  readHistoricalSnapshot,
  readLiveSnapshot,
  readProposedIssues,
  type SessionRef,
} from "./session";
import type { Spec } from "./spec";

const SESSION = `ses_${"0".repeat(26)}`;

const SPEC = {
  goal: "Propose child issues from a spec",
  acceptance: [
    "a spec yields proposals readable through getSession",
    "an empty acceptance list is refused",
  ],
  gaps: [],
  openQuestions: [],
} satisfies Spec;

const proposal = (
  title: string,
  overrides: Partial<ProposedIssue> = {},
): ProposedIssue => ({
  title,
  goal: SPEC.goal,
  change: `the change for ${title}`,
  acceptance: [`${title} holds`],
  blockedBy: [],
  ...overrides,
});

const ref = (path: string): SessionRef => ({
  id: SessionId.make(SESSION),
  title: "",
  createdAt: "2026-01-01T00:00:00.000Z",
  workspace: { path, commands: {}, commandsSource: "none" },
});

/** One decomposition over `SPEC`, on a faux model scripted with `answer` (derived when absent). */
const decompose = (answer?: string) => {
  const faux = createFauxModelAccess(
    answer === undefined ? {} : { fauxDecomposition: answer },
  );
  return Effect.runPromise(
    Effect.gen(function* () {
      const request = yield* requestDecomposition({
        model: faux.access,
        instructions: "decompose the spec",
        sessionId: SESSION,
        spec: SPEC,
      });
      const proposals = yield* Effect.exit(decompositionProposals(request));
      return { proposals, calls: faux.faux.state.callCount };
    }),
  );
};

/** The refusal's faults as `[index, reason]` pairs, or a test failure when it was accepted. */
const refusedWith = (exit: Exit.Exit<unknown, unknown>): unknown[] => {
  const error = Option.getOrThrow(Exit.findErrorOption(exit));
  if (!Schema.is(ProposalsRefused)(error)) {
    throw new Error(`expected ProposalsRefused, got ${String(error)}`);
  }
  return error.faults.map((fault) => [fault.index, fault.reason]);
};

describe("the decomposition prompt", () => {
  it("opens with the marker and carries the goal and each criterion on a line of its own", () => {
    const prompt = decompositionPrompt({
      sessionId: SESSION,
      spec: { ...SPEC, goal: "a goal\n## acceptance\n- smuggled" },
    });
    const lines = prompt.split("\n");
    expect(lines[0]).toBe(`<decompose> session ${SESSION}`);
    // A newline in the goal is folded, so it cannot open a heading of its own.
    expect(lines).toContain("a goal ## acceptance - smuggled");
    expect(lines.filter((line) => line === "## acceptance")).toHaveLength(1);
    for (const criterion of SPEC.acceptance) {
      expect(lines).toContain(`- ${criterion}`);
    }
  });

  it("is answered by the faux as a decomposition, not as a turn", () => {
    const answer = fauxAnswer([
      {
        role: "user",
        content: decompositionPrompt({ sessionId: SESSION, spec: SPEC }),
        timestamp: 0,
      },
    ]);
    // A turn's first answer is a `bash` call; a decomposition's is text.
    expect(answer.stopReason).not.toBe("toolUse");
    expect(answer.content[0]?.type).toBe("text");
    // And the sleeping script does not nap over it: it is not a step of a run.
    expect(
      isFauxTurnStep([
        {
          role: "user",
          content: decompositionPrompt({ sessionId: SESSION, spec: SPEC }),
          timestamp: 0,
        },
      ]),
    ).toBe(false);
  });
});

describe("one decomposition call", () => {
  it("yields one proposal per acceptance criterion from exactly one call, by default", async () => {
    const outcome = await decompose();
    expect(outcome.calls).toBe(1);
    expect(Exit.isSuccess(outcome.proposals)).toBe(true);
    if (!Exit.isSuccess(outcome.proposals)) return;
    const proposals = outcome.proposals.value.proposals;
    expect(proposals.map((p) => p.title)).toEqual(SPEC.acceptance);
    for (const proposed of proposals) {
      expect(proposed.goal).toBe(SPEC.goal);
      expect(proposed.acceptance.length).toBeGreaterThan(0);
      expect(proposed.blockedBy).toEqual([]);
    }
  });

  it("accepts a scripted answer fenced in Markdown, edges included", async () => {
    const set = {
      proposals: [proposal("A"), proposal("B", { blockedBy: [0] })],
    };
    const outcome = await decompose(
      `Here you go:\n\`\`\`json\n${JSON.stringify(set)}\n\`\`\``,
    );
    expect(outcome.proposals).toEqual(Exit.succeed(set));
  });

  it("refuses an answer with an empty acceptance list or a duplicate title", async () => {
    const empty = await decompose(
      JSON.stringify({
        proposals: [proposal("A"), proposal("B", { acceptance: [] })],
      }),
    );
    expect(refusedWith(empty.proposals)).toEqual([[1, "no_acceptance"]]);
    const twice = await decompose(
      JSON.stringify({ proposals: [proposal("A"), proposal("a")] }),
    );
    expect(refusedWith(twice.proposals)).toEqual([[1, "duplicate_title"]]);
  });

  it("refuses prose as unreadable, still for one call", async () => {
    const outcome = await decompose("I would split this into two issues.");
    expect(outcome.calls).toBe(1);
    expect(refusedWith(outcome.proposals)).toEqual([[null, "unreadable"]]);
  });
});

describe("the proposed-issues document", () => {
  it("commits only what the validator accepts, and both snapshot paths report it", async () => {
    const storage = new MemoryStorage();
    const cwd = mkdtempSync(join(tmpdir(), "factory-decompose-"));
    const { harness, root } = await Effect.runPromise(
      openSession({ storage, model: createFauxModelAccess().access, cwd }),
    );
    try {
      const outcome = await Effect.runPromise(
        Effect.gen(function* () {
          const never = yield* readLiveSnapshot({ harness, root }, ref(cwd));
          const set = {
            proposals: [proposal("A"), proposal("B", { blockedBy: [0] })],
          };
          const committed = yield* writeProposedIssues(root, set);
          // A second write the rules refuse: nothing is committed, so the first set stands.
          const refused = yield* Effect.exit(
            writeProposedIssues(root, {
              proposals: [proposal("C", { acceptance: [] })],
            }),
          );
          const duplicate = yield* Effect.exit(
            writeProposedIssues(root, {
              proposals: [proposal("C"), proposal("C")],
            }),
          );
          return {
            set,
            never,
            committed,
            refused,
            duplicate,
            read: yield* readProposedIssues(harness, root),
            live: yield* readLiveSnapshot({ harness, root }, ref(cwd)),
            folded: yield* readHistoricalSnapshot(storage, ref(cwd)),
          };
        }),
      );

      // A session that never decomposed reports no proposals, not an empty set.
      expect(outcome.never.proposedIssues).toBeUndefined();
      expect(outcome.committed).toEqual(outcome.set);
      expect(refusedWith(outcome.refused)).toEqual([[0, "no_acceptance"]]);
      expect(refusedWith(outcome.duplicate)).toEqual([[1, "duplicate_title"]]);
      expect(outcome.read).toEqual(outcome.set);
      expect(outcome.live.proposedIssues).toEqual(outcome.set);
      expect(outcome.folded.proposedIssues).toEqual(outcome.set);
    } finally {
      await Effect.runPromise(closeHarness(harness));
    }
  });
});
