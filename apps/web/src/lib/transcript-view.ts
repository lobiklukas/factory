import type { TranscriptEntry } from "@repo/domain/Session";

/**
 * Whether a log entry has a row in the transcript at all (LOB-273).
 *
 * The log holds entries that are bookkeeping rather than something anyone said, and rendering them
 * attributed them to the wrong author:
 *
 * - `title` is the session's name (`factory.title`), carrying the card title or the first prompt.
 *   It has no row of its own because the sidebar and the header already show it; with no branch
 *   for it the row fell through to assistant prose, so the prompt appeared once as if the agent had
 *   said it and once more as the user's own bubble.
 * - `system` carries no text in the projection (`messageText` flattens only user, assistant and
 *   tool results), so its row was always a bare `SYSTEM` divider between two hairlines saying
 *   nothing. A system entry that does carry text keeps its marker.
 *
 * Kept as a function of the entry so the pane (which has to skip the row, since the scroller's
 * `gap-5` would otherwise stack an empty gap) and the row (which returns nothing) cannot disagree.
 */
export const hasTranscriptRow = (entry: TranscriptEntry): boolean => {
  if (entry.kind === "title") return false;
  if (entry.kind === "system") return entry.text.length > 0;
  return true;
};

/** An entry that has a row, with its index in the full log (the compaction summary is found by that index). */
export type VisibleEntry = {
  readonly entry: TranscriptEntry;
  readonly index: number;
};

export const visibleEntries = (
  entries: readonly TranscriptEntry[],
): readonly VisibleEntry[] =>
  entries.flatMap((entry, index) =>
    hasTranscriptRow(entry) ? [{ entry, index }] : [],
  );
