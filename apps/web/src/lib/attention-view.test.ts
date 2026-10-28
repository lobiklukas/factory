/**
 * The attention view's wording and grouping (LOB-77). Which cards need a person is the server's
 * answer (`TaskService.attention`, proven against Postgres in `packages/core`); the browser drive
 * proves the rendered rows. These are the cases one drive cannot reach: a question with no text, an
 * approval with and without detail, a group with no rows.
 */
import type { AttentionItem, AttentionReason, Task } from "@repo/domain/Task";
import { BoardInstanceId, TaskId } from "@repo/domain/Task";
import { RepoSlug, SessionId } from "@repo/domain/Session";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  attentionBadge,
  attentionGroups,
  attentionLink,
  attentionReasonText,
  attentionTitle,
} from "./attention-view";

const AT = "2026-10-27T00:00:00.000Z";
const BOARD = Schema.decodeSync(BoardInstanceId)(
  "brd_0000000000000000000000000a",
);
const RUN = Schema.decodeSync(SessionId)("ses_0000000000000000000000000r");

let minted = 0;
const item = (
  title: string,
  reason: AttentionReason,
  extra: Partial<Task> = {},
): AttentionItem => ({
  task: {
    id: Schema.decodeSync(TaskId)(
      `tsk_${String((minted += 1)).padStart(26, "0")}`,
    ),
    boardId: BOARD,
    title,
    column: "planning",
    definitionVersion: 1,
    revision: 1,
    priority: "normal",
    createdAt: AT,
    updatedAt: AT,
    ...extra,
  },
  repo: Schema.decodeSync(RepoSlug)("acme/widgets"),
  reason,
});

const approval = (detail: string): AttentionReason => ({
  _tag: "approval",
  sessionId: RUN,
  requestId: "push",
  action: "push refs/heads/main",
  detail,
  requestedAt: AT,
});
const gate: AttentionReason = {
  _tag: "gate",
  gate: "plan approval",
  to: "building",
  sessionId: RUN,
};

/** An approval of a session no card owns (LOB-271): no task, the session's own title and repo. */
const sessionItem = (
  sessionTitle: string,
  reason: AttentionReason = approval(""),
): AttentionItem => ({
  sessionTitle,
  repo: Schema.decodeSync(RepoSlug)("acme/widgets"),
  reason,
});

describe("attentionGroups", () => {
  it("groups approvals, then questions, then gates, keeping the server's order and no empty group", () => {
    const groups = attentionGroups([
      item("gate one", gate),
      item("approve me", approval("")),
      item("gate two", gate),
    ]);
    expect(
      groups.map((group) => [group.kind, group.items.map(attentionTitle)]),
    ).toEqual([
      ["approval", ["approve me"]],
      ["gate", ["gate one", "gate two"]],
    ]);
    expect(groups.every((group) => group.title.length > 0)).toBe(true);
  });

  it("is empty for an empty answer, so the route can say so once", () => {
    expect(attentionGroups([])).toEqual([]);
  });
});

describe("attentionReasonText", () => {
  it("says what an approval asks, with its detail when there is one", () => {
    expect(attentionReasonText(item("a", approval("")))).toBe(
      "A run asks to push refs/heads/main",
    );
    expect(attentionReasonText(item("a", approval("3 commits")))).toBe(
      "A run asks to push refs/heads/main: 3 commits",
    );
  });

  it("quotes the question verbatim, and says so when none was recorded", () => {
    expect(
      attentionReasonText(
        item("q", { _tag: "question", question: "Which repo?", since: AT }),
      ),
    ).toBe("Asked: Which repo?");
    expect(
      attentionReasonText(
        item(
          "q",
          { _tag: "question", since: AT },
          {
            column: "specifying",
            blocked: {
              reason: "needs_input",
              column: "specifying",
              since: AT,
            },
          },
        ),
      ),
    ).toBe("Blocked: needs input from specifying, with no question recorded");
  });

  it("names the gate and the move only a person can make", () => {
    expect(attentionReasonText(item("g", gate))).toBe(
      "The planning run is idle; planning → building is the plan approval, a person's move",
    );
  });

  /** D10: the gate's move would be refused naming plan_doc, so the row says so instead. */
  it("says what the exit still needs before the gate, not the approval", () => {
    expect(
      attentionReasonText(item("g", { ...gate, unmet: ["plan_doc"] })),
    ).toBe(
      "The planning run is idle without plan_doc; planning → building needs it before the plan approval",
    );
  });
});

describe("attentionLink", () => {
  it("opens the card on its board, and an approval's run with it", () => {
    const gated = item("g", gate);
    expect(attentionLink(gated)).toEqual({
      kind: "card",
      boardId: BOARD,
      search: { card: gated.task?.id },
    });
    const asked = item("a", approval(""));
    expect(attentionLink(asked)).toEqual({
      kind: "card",
      boardId: BOARD,
      search: { card: asked.task?.id, run: RUN },
    });
  });

  it("opens a question straight at the card's thread, where it is answered (LOB-239)", () => {
    const question = item("q", {
      _tag: "question",
      question: "Which repo?",
      since: AT,
    });
    expect(attentionLink(question)).toEqual({
      kind: "card",
      boardId: BOARD,
      search: { card: question.task?.id },
      hash: "thread",
    });
  });

  it("opens a session no card owns on the session itself (LOB-271)", () => {
    expect(attentionLink(sessionItem("scratch"))).toEqual({
      kind: "session",
      sessionId: RUN,
    });
    expect(attentionLink(sessionItem("scratch", gate))).toEqual({
      kind: "session",
      sessionId: RUN,
    });
  });

  it("never links a card-less question to a card it does not have", () => {
    expect(
      attentionLink(sessionItem("odd", { _tag: "question", since: AT })),
    ).toEqual({ kind: "sessions" });
  });
});

describe("a row with no card (LOB-271)", () => {
  it("is titled by its session, or by the session id when it was never titled", () => {
    expect(attentionTitle(sessionItem("fix the flaky test"))).toBe(
      "fix the flaky test",
    );
    expect(attentionTitle(sessionItem(""))).toBe(RUN);
    expect(attentionTitle(sessionItem("   "))).toBe(RUN);
    expect(attentionTitle(item("a card", approval("")))).toBe("a card");
  });

  it("says a session, not a run, asks", () => {
    expect(attentionReasonText(sessionItem("s", approval("")))).toBe(
      "A session asks to push refs/heads/main",
    );
    expect(attentionReasonText(sessionItem("s", approval("3 commits")))).toBe(
      "A session asks to push refs/heads/main: 3 commits",
    );
  });

  it("groups with the card-bound approvals", () => {
    const groups = attentionGroups([
      item("a card", approval("")),
      sessionItem("scratch"),
    ]);
    expect(groups.map((group) => [group.kind, group.items.length])).toEqual([
      ["approval", 2],
    ]);
  });
});

describe("attentionBadge", () => {
  it("shows nothing for none, the count otherwise, and caps what a 32px button fits", () => {
    expect(attentionBadge(0)).toBeUndefined();
    expect(attentionBadge(1)).toBe("1");
    expect(attentionBadge(99)).toBe("99");
    expect(attentionBadge(100)).toBe("99+");
  });
});
