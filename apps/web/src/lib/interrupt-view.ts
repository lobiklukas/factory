import type { InterruptSessionResult } from "@repo/domain/Session";

/** A toast the pane raises for an interrupt's answer. */
export type InterruptNotice = {
  readonly title: string;
  readonly description: string;
};

/**
 * What the pane says about an interrupt's answer (C8), or `null` when the transcript says it.
 *
 * A run that was stopped ends its turn with an `interrupted` row and the header goes idle, so a
 * toast would only repeat it. `not_running` — the run finished between the render that showed the
 * button and the press — changes nothing on screen, so it is told, in the server's own sentence.
 */
export const interruptNotice = (
  result: InterruptSessionResult,
): InterruptNotice | null =>
  result.outcome === "interrupted"
    ? null
    : { title: "Nothing to interrupt", description: result.message };
