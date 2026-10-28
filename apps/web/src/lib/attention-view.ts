import type { SessionId } from "@repo/domain/Session";
import type {
  AttentionItem,
  AttentionReason,
  BoardInstanceId,
  TaskId,
} from "@repo/domain/Task";
import { THREAD_ANCHOR } from "./thread-view";

/**
 * The attention view's arithmetic (LOB-77): what `/attention` renders from one `listAttention` read.
 *
 * The server decides what needs a person (`TaskService.attention`); this file only says it in words,
 * groups the rows by what the person has to do, and names the card each row opens. Pure, so the
 * wording a screenshot cannot pin — a question with no text, an approval with no detail — is a unit
 * case rather than a guess.
 */
export type AttentionKind = AttentionReason["_tag"];

export type AttentionGroup = {
  readonly kind: AttentionKind;
  /** What the person does for every row in the group, as the section heading says it. */
  readonly title: string;
  readonly items: ReadonlyArray<AttentionItem>;
};

/** The groups in the order the server answers them: a run waiting live, a parked run, a gate. */
const GROUPS: ReadonlyArray<{
  readonly kind: AttentionKind;
  readonly title: string;
}> = [
  { kind: "approval", title: "Approve or deny a request" },
  { kind: "question", title: "Answer a run's question" },
  { kind: "gate", title: "Make a person's move" },
];

/**
 * The rows grouped by reason, in the server's order within each group, and only the groups that have
 * a row: an empty heading would read as "something here", and the view's empty state is one message
 * for the whole page, not three.
 */
export const attentionGroups = (
  items: ReadonlyArray<AttentionItem>,
): ReadonlyArray<AttentionGroup> =>
  GROUPS.map((group) => ({
    ...group,
    items: items.filter((item) => item.reason._tag === group.kind),
  })).filter((group) => group.items.length > 0);

/**
 * Why the card is on the list, in one sentence a person can act on. The words come from the server's
 * record — the approval's action, the run's question, the gate's name — so the row says what the
 * card pane will show when it opens.
 */
export const attentionReasonText = (item: AttentionItem): string => {
  const { reason, task } = item;
  switch (reason._tag) {
    case "approval": {
      // A session no card owns is not a card's run (LOB-271): the row says "session".
      const asker = task === undefined ? "A session" : "A run";
      return reason.detail.trim() === ""
        ? `${asker} asks to ${reason.action}`
        : `${asker} asks to ${reason.action}: ${reason.detail}`;
    }
    case "question":
      return task === undefined
        ? `Asked: ${reason.question ?? "no question recorded"}`
        : reason.question === undefined
          ? `Blocked: needs input from ${task.blocked?.column ?? task.column}, with no question recorded`
          : `Asked: ${reason.question}`;
    case "gate":
      if (task === undefined)
        return `Idle at the ${reason.gate}, a person's move`;
      // The exit still misses a checked requirement (D10: no plan yet), so the gate's move would be
      // refused: say what must be met first, not invite the approval.
      return reason.unmet === undefined || reason.unmet.length === 0
        ? `The ${task.column} run is idle; ${task.column} → ${reason.to} is the ${reason.gate}, a person's move`
        : `The ${task.column} run is idle without ${reason.unmet.join(", ")}; ${task.column} → ${reason.to} needs it before the ${reason.gate}`;
  }
};

/**
 * What names the row: the card's title, or for a session no card owns (LOB-271) the session's title,
 * falling back to its id when the session was never titled.
 */
export const attentionTitle = (item: AttentionItem): string =>
  item.task?.title ??
  (item.sessionTitle === undefined || item.sessionTitle.trim() === ""
    ? item.reason._tag === "approval"
      ? item.reason.sessionId
      : "Untitled session"
    : item.sessionTitle);

/**
 * The rail's count (LOB-271): the number of rows the view lists, so the badge and the page cannot
 * disagree. Nothing for none, and capped, because a badge four characters wide does not fit a 32px
 * rail button.
 */
export const attentionBadge = (count: number): string | undefined =>
  count <= 0 ? undefined : count > 99 ? "99+" : String(count);

export type AttentionLink =
  | {
      readonly kind: "card";
      readonly boardId: BoardInstanceId;
      readonly search: { readonly card: TaskId; readonly run?: SessionId };
      readonly hash?: typeof THREAD_ANCHOR;
    }
  | { readonly kind: "session"; readonly sessionId: SessionId }
  | { readonly kind: "sessions" };

/**
 * Where a row's link goes: the card's own pane on its board; for an approval, the run that asked, so
 * the pane opens on the session whose Approvals tab holds the request; for a question, the card's
 * thread (`#thread`, LOB-239), where the question is read and answered; and for a row with no card
 * (LOB-271), the session itself, whose page holds the approval. The server lists only approvals
 * without a card, so a card-less question (which names no session) falls back to the sessions list
 * rather than to a link that goes nowhere.
 */
export const attentionLink = (item: AttentionItem): AttentionLink => {
  const { task } = item;
  if (task === undefined) {
    return item.reason._tag === "question"
      ? { kind: "sessions" }
      : { kind: "session", sessionId: item.reason.sessionId };
  }
  switch (item.reason._tag) {
    case "approval":
      return {
        kind: "card",
        boardId: task.boardId,
        search: { card: task.id, run: item.reason.sessionId },
      };
    case "question":
      return {
        kind: "card",
        boardId: task.boardId,
        search: { card: task.id },
        hash: THREAD_ANCHOR,
      };
    case "gate":
      return {
        kind: "card",
        boardId: task.boardId,
        search: { card: task.id },
      };
  }
};
