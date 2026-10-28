import {
  MAX_TASK_TITLE_CHARS,
  type BlockReason,
  type Task,
  type TaskPriority,
} from "@repo/domain/Task";
import { refusalWith, type Refusal, type RefusedWith } from "./board-view";

/**
 * What the card pane's state controls say and send (C11): block and unblock a card, fix its title,
 * and flag it urgent. The server decides everything that matters — whether the revision is current,
 * whether the card is already blocked, whether a title is usable (`TaskService`, proven against
 * Postgres in `packages/core`); this file words the refusals, says which reasons a person offers,
 * and says whether a draft is worth sending. Pure, so the cases one browser drive cannot reach (a
 * blank or over-long title, an unchanged title, a refusal that is not a typed one) are unit cases.
 */

/**
 * The reasons a person parks a card for. `needs_input` is a run's question (the `ask` tool writes it
 * with the question in the thread, and a person's answer lifts it) and `setup_failed` is a run
 * parked by its worktree's failing install: neither is something a person declares by hand, so the
 * pane does not offer them. `factory board block` takes every reason.
 */
export const BLOCK_REASONS: ReadonlyArray<{
  readonly reason: BlockReason;
  readonly label: string;
}> = [
  { reason: "dependency", label: "Waiting on a dependency" },
  { reason: "capability", label: "Missing a capability" },
  { reason: "transient", label: "A transient failure" },
];

/** A block's note as sent: trimmed, and none when it says nothing. */
export const blockNote = (draft: string): string | undefined => {
  const note = draft.trim();
  return note === "" ? undefined : note;
};

/**
 * Whether a title draft can be saved, and as what. A title is a line: it is saved trimmed, a blank
 * one or one over `MAX_TASK_TITLE_CHARS` is refused here before a round trip, and the card's own
 * title is not a change — saving it would only spend a revision on nothing.
 */
export type TitleDraft =
  | { readonly ok: true; readonly title: string }
  | { readonly ok: false; readonly reason: string };

export const titleDraft = (
  draft: string,
  task: Pick<Task, "title">,
): TitleDraft => {
  const title = draft.trim();
  return title === ""
    ? { ok: false, reason: "A title has to say something" }
    : title.length > MAX_TASK_TITLE_CHARS
      ? {
          ok: false,
          reason: `A title is at most ${MAX_TASK_TITLE_CHARS} characters; this one is ${title.length}`,
        }
      : title === task.title
        ? { ok: false, reason: "That is the card's title already" }
        : { ok: true, title };
};

/** The priority a toggle press sets: urgent flips to normal, and anything else to urgent. */
export const otherPriority = (priority: TaskPriority): TaskPriority =>
  priority === "urgent" ? "normal" : "urgent";

/**
 * What the pane says when a state write — block, unblock, an edit — is refused. As with a move and a
 * comment, the body is the service's own message and only the heading is the pane's. A
 * `StaleRevision` is the case the revision exists for: the card changed while the person looked, and
 * the pane re-reads it so the next press expects the revision the server holds.
 */
export type CardEditRefusal = Refusal;

const REFUSAL_TITLES: Readonly<Record<string, string>> = {
  StaleRevision: "Someone changed this card first",
  AlreadyBlocked: "This card is already blocked",
  NotBlocked: "This card is not blocked",
  InvalidTaskInput: "The card cannot take that",
  TaskNotFound: "This card no longer exists",
  TaskStorageError: "The board could not record the change",
};

export const cardEditRefusal: (
  error: RefusedWith,
  fallback: string,
  sentRevision: number,
) => CardEditRefusal = refusalWith(
  REFUSAL_TITLES,
  "The change did not go through",
);
