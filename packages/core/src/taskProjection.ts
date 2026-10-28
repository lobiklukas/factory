/**
 * A card as its history says it is (LOB-260): `task_events` folded, oldest first, into the fields the
 * events carry.
 *
 * Cards are rows (B3): `tasks` is the card a reader gets, and nothing rebuilds it — a card is input,
 * and its row is written in the same transaction as the event that records the write. What this fold
 * proves is the other half of that rule: every write a card has had is in its history, so the row is
 * derivable from `task_events` alone. The `created` event carries what the create was given — the
 * title, and since LOB-260 the body, the base ref, the external ref and the priority (since LOB-254
 * the external ref's link too) — and every later event the one change it made.
 *
 * Revisions: `created` records revision 1, and every other event the revision its mutation expected,
 * so the card is at the event's revision plus one after it. An ask (a `commented` question and a
 * `blocked` in one transaction) is two events and two revisions, exactly as `TaskService` writes it. An update that changes both title and priority is the
 * opposite: two events (`retitled`, `priorityChanged`) at one revision, because the call is one write.
 *
 * What the fold cannot give is what the events never carried: the definition version and the repo
 * (both the board's when the card was made; a `repinned` event, D5, names the version it moved to,
 * but a card never repinned has none in its history), a block's note, and the row's timestamps.
 */
import type { BlockReason, TaskEvent, TaskPriority } from "@repo/domain/Task";

/** The card's fields its history carries, as `projectTask` folds them. */
export type TaskProjection = {
  readonly taskId: string;
  readonly boardId: string;
  readonly title: string;
  readonly column: string;
  readonly revision: number;
  readonly priority: TaskPriority;
  readonly body?: string;
  readonly baseRef?: string;
  readonly externalRef?: string;
  readonly externalUrl?: string;
  readonly blocked?: { readonly reason: BlockReason; readonly column: string };
};

/**
 * Fold a card's events, in write order, into what they say the card is. `undefined` when the history
 * does not start with `created`: no other event can stand for the card's input.
 */
export const projectTask = (
  events: ReadonlyArray<TaskEvent>,
): TaskProjection | undefined => {
  const [first, ...rest] = events;
  if (first === undefined || first._tag !== "created") return undefined;
  let card: TaskProjection = {
    taskId: first.taskId,
    boardId: first.boardId,
    title: first.title,
    column: first.column,
    revision: first.revision,
    priority: first.priority ?? "normal",
    ...(first.body === undefined ? {} : { body: first.body }),
    ...(first.baseRef === undefined ? {} : { baseRef: first.baseRef }),
    ...(first.externalRef === undefined
      ? {}
      : { externalRef: first.externalRef }),
    ...(first.externalUrl === undefined
      ? {}
      : { externalUrl: first.externalUrl }),
  };
  for (const event of rest) {
    const revision = event.revision + 1;
    switch (event._tag) {
      case "created":
        // A second `created` is not a card's history; the first one is the card.
        return undefined;
      case "moved":
        card = { ...card, column: event.to, revision };
        break;
      case "blocked":
        card = {
          ...card,
          blocked: { reason: event.reason, column: event.column },
          revision,
        };
        break;
      case "unblocked": {
        const { blocked: _lifted, ...unblocked } = card;
        card = { ...unblocked, revision };
        break;
      }
      case "priorityChanged":
        card = { ...card, priority: event.to, revision };
        break;
      case "retitled":
        card = { ...card, title: event.to, revision };
        break;
      case "repinned": {
        // A migration (D5) re-pins the card in the column its mapping names, and a block keeps its
        // place: the blocked column is mapped the same way.
        const blocked =
          card.blocked === undefined
            ? undefined
            : {
                ...card.blocked,
                column:
                  event.mapping[card.blocked.column] ?? card.blocked.column,
              };
        card = {
          ...card,
          column: event.to,
          revision,
          ...(blocked === undefined ? {} : { blocked }),
        };
        break;
      }
      case "commented":
      case "specified":
      case "planned":
        card = { ...card, revision };
        break;
    }
  }
  return card;
};
