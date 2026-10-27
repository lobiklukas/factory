import type { CommentKind, Task, TaskBlocked } from "@repo/domain/Task";
import { MAX_COMMENT_CHARS } from "@repo/domain/Task";
import { refusalWith, type Refusal, type RefusedWith } from "./board-view";

/**
 * The card pane's thread arithmetic (LOB-239): what the Thread section says about `listTaskComments`
 * and what its composer sends with `commentTask`.
 *
 * The server decides what a comment *is* (B7: a person's comment on a card blocked `needs_input` is
 * the answer that lifts the block, anything else is a note) and records the kind when it writes it;
 * this file only words the kind, says which of the two a send will be, and says what a refusal
 * means. Pure, so the cases one drive cannot reach — an over-long draft, an answer someone else got
 * in first — are unit cases.
 */

/** The thread's id in the card pane: what the attention view's question rows link to (`#thread`). */
export const THREAD_ANCHOR = "thread";

const KIND_WORDS: Readonly<Record<CommentKind, string>> = {
  question: "Question",
  answer: "Answer",
  note: "Note",
};

/** A comment's kind as the thread heads it. */
export const commentKindLabel = (kind: CommentKind): string => KIND_WORDS[kind];

/**
 * When a comment was written, to the second, in the server's own clock (UTC) — the format the card
 * pane's run list uses, so two times on one pane read the same way.
 */
export const commentTime = (createdAt: string): string =>
  createdAt.slice(0, 19).replace("T", " ");

/**
 * What the composer's send will be (B7). The dashboard's actor is a person (`DASHBOARD_ACTOR`), so a
 * send on a card blocked `needs_input` is the answer and lifts the block; anywhere else it is a note
 * and the card's state is unchanged. The server is what decides — it classifies the comment under
 * the row lock — so this is the pane saying in advance what the server will do with the card it has
 * on screen, and a stale screen is refused rather than misclassified.
 */
export type ComposerIntent =
  | { readonly answers: true; readonly verb: "Answer"; readonly from: string }
  | { readonly answers: false; readonly verb: "Comment" };

export const composerIntent = (task: Pick<Task, "blocked">): ComposerIntent =>
  task.blocked?.reason === "needs_input"
    ? { answers: true, verb: "Answer", from: task.blocked.column }
    : { answers: false, verb: "Comment" };

/**
 * Whether a draft can be sent, and why not. The service refuses an empty or whitespace-only comment
 * (`EmptyComment`) and the schema one longer than `MAX_COMMENT_CHARS`, so the composer says so
 * before the round trip. The draft itself is never trimmed: a body is sent verbatim (B7).
 */
export type Sendable =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

export const sendable = (draft: string): Sendable =>
  draft.trim() === ""
    ? { ok: false, reason: "A comment has to say something" }
    : draft.length > MAX_COMMENT_CHARS
      ? {
          ok: false,
          reason: `A comment is at most ${MAX_COMMENT_CHARS.toLocaleString("en-US")} characters; this one is ${draft.length.toLocaleString("en-US")}`,
        }
      : { ok: true };

/**
 * What the pane says when `commentTask` is refused. As with a move (`moveRefusal`), the body is the
 * service's own message and only the heading is the pane's.
 *
 * `StaleRevision` is the case the composer exists to get right: the card changed while the person
 * typed (a run added a note, someone else answered), so the send is refused at the revision the pane
 * rendered. The draft stays in the composer whatever the refusal — the pane re-reads the card and
 * its thread, and the person sends again from what is now there. Nothing is resent on their behalf: if someone
 * else's answer already lifted the block, the same words would now be a note, and that is the
 * person's call to make, not the page's.
 */
export type CommentRefusal = Refusal;

const REFUSAL_TITLES: Readonly<Record<string, string>> = {
  StaleRevision: "The card changed while you wrote",
  EmptyComment: "A comment has to say something",
  TaskNotFound: "This card no longer exists",
  TaskStorageError: "The board could not record the comment",
};

export const commentRefusal: (
  error: RefusedWith,
  fallback: string,
  sentRevision: number,
) => CommentRefusal = refusalWith(
  REFUSAL_TITLES,
  "The comment did not go through",
);

/**
 * What stays in the composer once a send lands: only the part that was sent is cleared. The box is
 * editable while the send is in flight, so text typed after the send — appended to the sent body —
 * is kept; a draft edited anywhere else is kept whole, since the page cannot tell what of it was sent.
 */
export const draftAfterSend = (current: string, sent: string): string =>
  current.startsWith(sent) ? current.slice(sent.length) : current;

/**
 * The block a landed comment lifted, or `undefined` when it lifted none: the card the send was made
 * from was blocked and the server's answer is not. What the pane shows as "answered", the same thing
 * `factory board comment` prints.
 */
export const liftedBlock = (
  before: Pick<Task, "blocked">,
  after: Pick<Task, "blocked">,
): TaskBlocked | undefined =>
  before.blocked !== undefined && after.blocked === undefined
    ? before.blocked
    : undefined;
