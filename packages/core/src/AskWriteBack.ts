/**
 * Where a run's question is also asked, for a tracker to carry (T5).
 *
 * The `ask` tool parks the card on the question (B7) and that record is the product: the thread on
 * the card is where the question lives and where an answer unblocks it. A card that was filed from a
 * tracker issue has a person who is working in the tracker, not on the board, so the question is
 * carried to them there too — as Linear's own `elicitation` activity (`./LinearElicitation`) — and
 * their reply comes back as an event (`TriggerEvent.reply`), never as a comment the factory re-reads.
 *
 * **Optional, and a `Context.Reference` because of it**, as `SessionWriteBack` is: the default is a
 * no-op, so a session layer built without a tracker (every test, a deployment with no Linear key)
 * wires nothing and the `ask` tool is unchanged.
 *
 * **It cannot fail the ask.** The question is recorded on the card before this is called, and a run
 * that could not reach Linear still ended parked with a question a person can answer on the board.
 * The port answers `void` with no error — an implementation logs what it could not do — and the
 * session layer bounds it (`SESSION_WRITE_BACK_BUDGET`) and logs anything that escapes. The ask is
 * replayed by a crashed run, so an implementation is idempotent on `askId`.
 */
import { Context, Effect } from "effect";
import type { SessionId } from "@repo/domain/Session";

export type AskWriteBackShape = {
  /** A run's question was recorded on its card: carry it to the tracker its card came from. */
  readonly asked: (input: {
    readonly sessionId: SessionId;
    readonly taskId: string;
    /** The ask's own id (`<session>:<tool call>`): one question however often it is replayed. */
    readonly askId: string;
    readonly question: string;
  }) => Effect.Effect<void>;
};

export const AskWriteBack = Context.Reference<AskWriteBackShape>(
  "@repo/core/AskWriteBack",
  { defaultValue: () => ({ asked: () => Effect.void }) },
);
