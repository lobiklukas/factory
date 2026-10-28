import {
  DeliverySource,
  DeliveryStatus,
  type DeliveryRecord,
  type ListTriggerDeliveriesInput,
} from "@repo/domain/Trigger";

/**
 * The Triggers page's wording and list rules (T4).
 *
 * The rows are `listTriggerDeliveries`, the server's answer, and the only facts here: the reason is
 * the seam's own sentence and is shown as it was recorded, never reworded. Pure on purpose, so the
 * cases a screenshot cannot settle (a page that overlaps the poll, a filter that empties the list)
 * are unit cases.
 */

/** A status filter chip: the server's words, plus `all`, which sends no filter. */
export type StatusFilter = DeliveryStatus | "all";
export type SourceFilter = DeliverySource | "all";

export const STATUS_FILTERS: ReadonlyArray<StatusFilter> = [
  "all",
  ...DeliveryStatus.literals,
];
export const SOURCE_FILTERS: ReadonlyArray<SourceFilter> = [
  "all",
  ...DeliverySource.literals,
];

/** What each status means to the person reading it, in the chip's title and the row's marker. */
export const STATUS_MEANING: Record<DeliveryStatus, string> = {
  processed: "Started work, or found the card it already filed",
  skipped: "Refused by the seam: the reason says why, and nothing was started",
  received:
    "Claimed, with no outcome yet: in flight, or left by a process that died",
};

export const statusLabel = (status: StatusFilter): string =>
  status === "all"
    ? "All"
    : status === "received"
      ? "In flight"
      : status === "processed"
        ? "Processed"
        : "Skipped";

/** The input a pair of filters means: `all` sends nothing, so the server reads every delivery. */
export const filterInput = (
  status: StatusFilter,
  source: SourceFilter,
): Pick<ListTriggerDeliveriesInput, "source" | "status"> => ({
  ...(status === "all" ? {} : { status }),
  ...(source === "all" ? {} : { source }),
});

/**
 * A filter pair as one string, for the atom family keyed by it (`processed/linear`, `all/all`), and
 * back. A key this build did not mint reads as no filter, so a stale one asks for everything.
 */
export const filterKey = (status: StatusFilter, source: SourceFilter): string =>
  `${status}/${source}`;

export const inputOfKey = (
  key: string,
): Pick<ListTriggerDeliveriesInput, "source" | "status"> => {
  const [status, source] = key.split("/");
  return filterInput(
    STATUS_FILTERS.find((candidate) => candidate === status) ?? "all",
    SOURCE_FILTERS.find((candidate) => candidate === source) ?? "all",
  );
};

/** The page size the dashboard asks for; the server's own cap is higher. */
export const PAGE_SIZE = 50;

/**
 * The list as the page shows it: the head the poll just read, then every other row the page holds
 * (the older pages the person asked for and the heads it read before). A row in both is shown once,
 * at the head's position and as the head read it.
 *
 * The page folds each poll's head into what it holds (`mergeDeliveries(head, held)`) once older pages
 * are loaded: a new arrival pushes the head's last row out of the head, and the older pages start
 * after the head as it was, so that row stays shown only because an earlier head was held.
 */
export const mergeDeliveries = (
  head: ReadonlyArray<DeliveryRecord>,
  older: ReadonlyArray<DeliveryRecord>,
): ReadonlyArray<DeliveryRecord> => {
  const seen = new Set(head.map((row) => row.deliveryId));
  return [...head, ...older.filter((row) => !seen.has(row.deliveryId))];
};

/** What a delivery produced, for the row's last line: the session, the card, or nothing. */
export type DeliveryTarget =
  | { readonly kind: "session"; readonly id: string }
  | { readonly kind: "card"; readonly id: string }
  | { readonly kind: "none" };

export const deliveryTarget = (delivery: DeliveryRecord): DeliveryTarget =>
  delivery.sessionId !== undefined
    ? { kind: "session", id: delivery.sessionId }
    : delivery.taskId !== undefined
      ? { kind: "card", id: delivery.taskId }
      : { kind: "none" };

/**
 * The instant as a person reads it, in UTC and to the second, so the same row reads the same in
 * every browser: `2026-10-28 10:00:00 UTC`. A value that is not a timestamp is shown as it came.
 */
export const receivedLabel = (iso: string): string =>
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(iso)
    ? `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`
    : iso;

/** The empty list's sentence, naming the filter that emptied it when there is one. */
export const emptyMessage = (
  status: StatusFilter,
  source: SourceFilter,
): string => {
  const narrowed = [
    ...(source === "all" ? [] : [`from ${source}`]),
    ...(status === "all" ? [] : [`that ended ${status}`]),
  ];
  return narrowed.length === 0
    ? "No delivery has reached the trigger seam yet. A webhook that was refused before it (a wrong signature, a body over the cap, a route with no secret) is logged by the API and never recorded here."
    : `No delivery ${narrowed.join(" ")} is recorded.`;
};
