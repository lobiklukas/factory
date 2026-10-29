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

  it("groups a review between the questions and the gates (C21)", () => {
    const groups = attentionGroups([
      item("gate", gate),
      item("reviewed", {
        _tag: "review",
        review: "@alice requested changes",
        since: AT,
      }),
      item("asked", { _tag: "question", question: "Which repo?", since: AT }),
    ]);
    expect(groups.map((group) => [group.kind, group.title])).toEqual([
      ["question", "Answer a run's question"],
      ["review", "Address a review"],
      ["gate", "Make a person's move"],
    ]);
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

  it("says who requested changes on the PR, and what to do when the note is gone (C21)", () => {
    expect(
      attentionReasonText(
        item("r", {
          _tag: "review",
          review: "@alice requested changes on pull request #7: split it",
          since: AT,
        }),
      ),
    ).toBe(
      "Changes requested: @alice requested changes on pull request #7: split it",
    );
    expect(attentionReasonText(item("r", { _tag: "review", since: AT }))).toBe(
      "Changes requested on the card's PR; start its building run to address them",
    );
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

  it("opens a review at the card's thread, where the review is (C21)", () => {
    const reviewed = item("r", { _tag: "review", since: AT });
    expect(attentionLink(reviewed)).toEqual({
      kind: "card",
      boardId: BOARD,
      search: { card: reviewed.task?.id },
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

describe("a spend cap row (S-aggregate-spend-caps)", () => {
  const spend = (threshold: number): AttentionItem => ({
    reason: {
      _tag: "spend",
      scope: "repo",
      subject: "acme/widgets",
      window: "month",
      threshold,
      limit: 300,
      spent: threshold === 100 ? 301.5 : 241,
      since: AT,
      resetsAt: "2026-11-01T00:00:00.000Z",
    },
  });

  it("is titled by what it counts, says how far the spend is and what happens next, and opens the spend page", () => {
    expect(attentionTitle(spend(80))).toBe("Repository acme/widgets");
    expect(attentionReasonText(spend(80))).toBe(
      "At 80% of its monthly cap ($241.00 of $300.00): new runs are refused once it is reached",
    );
    expect(attentionReasonText(spend(100))).toBe(
      "Reached its monthly cap ($301.50 of $300.00): new runs are refused until 2026-11-01T00:00:00.000Z",
    );
    expect(attentionLink(spend(100))).toEqual({ kind: "spend" });
  });

  it("is its own group, last, beside the card rows", () => {
    const groups = attentionGroups([
      spend(80),
      item("approve me", approval("")),
    ]);
    expect(groups.map((group) => group.kind)).toEqual(["approval", "spend"]);
    expect(groups[1]?.title).toBe("Spend cap reached or near");
  });
});
