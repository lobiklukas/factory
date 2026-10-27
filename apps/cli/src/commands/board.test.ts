/**
 * `factory board show`'s thread lines (LOB-73): one header per comment, then its body exactly as it
 * was typed, one printed line per body line. And its spec lines (LOB-238): the run that declared the
 * card's spec, then each list, an empty one printed `none`.
 *
 * The command itself is proven by `.pi/skills/verify-board/ask.sh`, which reads the question and the
 * answer back from a real terminal run. This case is the one a pane capture would not localize: that
 * a multi-line answer keeps its own lines and inner whitespace rather than being joined or trimmed.
 */
import { Schema } from "effect";
import { TaskComment, TaskSpec } from "@repo/domain/Task";
import { describe, expect, it } from "vitest";
import { specLines, threadLines } from "./board";

const comment = (
  kind: TaskComment["kind"],
  actor: string,
  body: string,
): TaskComment =>
  Schema.decodeSync(TaskComment)({
    taskId: `tsk_${"0".repeat(26)}`,
    kind,
    actor,
    body,
    revision: 4,
    createdAt: "2026-10-27T00:00:00.000Z",
  });

describe("threadLines", () => {
  it("names the kind, the actor and the revision, then indents the body verbatim", () => {
    expect(
      threadLines(
        comment("answer", "person:lukas", "Postgres 16.\n  Keep 5442.  "),
      ),
    ).toEqual([
      "  [answer] person:lukas (revision 4)",
      "    Postgres 16.",
      "      Keep 5442.  ",
    ]);
  });

  it("prints a one-line question as one body line", () => {
    expect(threadLines(comment("question", "ses_run", "Which repo?"))).toEqual([
      "  [question] ses_run (revision 4)",
      "    Which repo?",
    ]);
  });
});

describe("specLines (LOB-238)", () => {
  const spec = (gaps: ReadonlyArray<string>): TaskSpec =>
    Schema.decodeSync(TaskSpec)({
      taskId: `tsk_${"0".repeat(26)}`,
      sessionId: `ses_${"1".repeat(26)}`,
      column: "specifying",
      goal: "Pin the Postgres major",
      acceptance: ["compose names one major", "the docs say which"],
      gaps,
      openQuestions: gaps.length === 0 ? [] : ["Which major?"],
      revision: 2,
      createdAt: "2026-10-27T00:00:00.000Z",
    });

  it("names the run and the revision, then the goal and each list item", () => {
    expect(specLines(spec(["which major"]))).toEqual([
      `spec      ses_${"1".repeat(26)} from specifying (revision 2)`,
      "  goal: Pin the Postgres major",
      "  acceptance: 2",
      "    - compose names one major",
      "    - the docs say which",
      "  gaps: 1",
      "    - which major",
      "  open questions: 1",
      "    - Which major?",
    ]);
  });

  it("prints an empty list as none, and a card with no spec as a dash", () => {
    const lines = specLines(spec([]));
    expect(lines).toContain("  gaps: none");
    expect(lines).toContain("  open questions: none");
    expect(specLines(null)).toEqual(["spec      -"]);
  });
});
