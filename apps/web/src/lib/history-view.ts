import type { SessionHistoryPage, TranscriptEntry } from "@repo/domain/Session";

/**
 * The earlier transcript a reader asked for (LOB-243), above the entries the pane's view carries.
 *
 * A historical snapshot carries the newest entries of a long session and says where they start
 * (`earlier`); each press of "Show earlier entries" reads the page before the oldest entry shown
 * and puts it on top. The pages belong to the snapshot they were read under — `sessionId` and that
 * snapshot's `earlier`, the `anchor` — so a re-attach that starts the transcript somewhere else, or
 * a route to another session, drops them instead of stitching two readings together.
 */
export type EarlierHistory = {
  readonly sessionId: string;
  readonly anchor: string;
  /** Every page read so far, oldest first. */
  readonly entries: readonly TranscriptEntry[];
  /** Where the page before `entries` starts; absent once `entries` reaches the first entry. */
  readonly earlier?: string;
};

/** The pages that still belong to what the pane shows, or `null` when none do. */
export const currentHistory = (
  history: EarlierHistory | null,
  sessionId: string,
  viewEarlier: string | undefined,
): EarlierHistory | null =>
  history !== null &&
  history.sessionId === sessionId &&
  history.anchor === viewEarlier
    ? history
    : null;

/**
 * What the next press reads before: the oldest loaded page's `earlier`, or the view's when nothing
 * is loaded. `undefined` means the transcript on screen already starts at the first entry.
 */
export const nextBefore = (
  history: EarlierHistory | null,
  viewEarlier: string | undefined,
): string | undefined => (history === null ? viewEarlier : history.earlier);

/** `history` with `page` — the page before its oldest entry — on top. */
export const withEarlierPage = (
  history: EarlierHistory | null,
  sessionId: string,
  anchor: string,
  page: SessionHistoryPage,
): EarlierHistory => ({
  sessionId,
  anchor,
  entries: [...page.entries, ...(history?.entries ?? [])],
  ...(page.earlier === undefined ? {} : { earlier: page.earlier }),
});
