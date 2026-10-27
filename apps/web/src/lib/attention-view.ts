import type { SessionId } from "@repo/domain/Session";
import type {
  AttentionItem,
  AttentionReason,
  BoardInstanceId,
  TaskId,
} from "@repo/domain/Task";

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
  { kind: "approval", title: "Approve or deny a run's request" },
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
    case "approval":
      return reason.detail.trim() === ""
        ? `A run asks to ${reason.action}`
        : `A run asks to ${reason.action}: ${reason.detail}`;
    case "question":
      return reason.question === undefined
        ? `Blocked: needs input from ${task.blocked?.column ?? task.column}, with no question recorded`
        : `Asked: ${reason.question}`;
    case "gate":
      return `The ${task.column} run is idle; ${task.column} → ${reason.to} is the ${reason.gate}, a person's move`;
  }
};

/**
 * Where a row's link goes: the card's own pane on its board, and for an approval the run that asked,
 * so the pane opens on the session whose Approvals tab holds the request.
 */
export const attentionLink = (
  item: AttentionItem,
): {
  readonly boardId: BoardInstanceId;
  readonly search: { readonly card: TaskId; readonly run?: SessionId };
} =>
  item.reason._tag === "approval"
    ? {
        boardId: item.task.boardId,
        search: { card: item.task.id, run: item.reason.sessionId },
      }
    : { boardId: item.task.boardId, search: { card: item.task.id } };
