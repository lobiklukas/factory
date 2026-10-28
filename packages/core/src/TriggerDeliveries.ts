/**
 * The deliveries the trigger seam recorded (T4): the read side of `webhook_deliveries`.
 *
 * The table was written from the first trigger (LOB-168) and its skip reasons were a recorded
 * decision (LOB-14), but nothing read them: an operator whose labelled issue started nothing had no
 * way to tell a delivery that never arrived from one the seam refused, or to find the session a
 * processed one opened. `list` is that read, newest first, with the reason exactly as the seam wrote
 * it.
 *
 * Only what reached the seam is here. A delivery refused before it (`401`, `413`, `429`, `503`) is
 * logged by the route and never stored, so an unauthenticated request cannot write a row; that is
 * documented on `DeliveryRecord`, and the route's tests assert it.
 */
import { Context, Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import {
  DeliveryRecord,
  TriggerDeliveryError,
  type ListTriggerDeliveriesInput,
  type ListTriggerDeliveriesOutput,
} from "@repo/domain/Trigger";

/** The page size when the caller names none, and the most the server returns in one page. */
export const DELIVERIES_DEFAULT_PAGE = 50;
export const DELIVERIES_MAX_PAGE = 200;

export type TriggerDeliveriesShape = {
  /** One page of recorded deliveries, newest first, filtered by source and status when asked. */
  readonly list: (
    input: ListTriggerDeliveriesInput,
  ) => Effect.Effect<ListTriggerDeliveriesOutput, TriggerDeliveryError>;
};

export class TriggerDeliveries extends Context.Service<
  TriggerDeliveries,
  TriggerDeliveriesShape
>()("@repo/core/TriggerDeliveries") {}

type DeliveryRow = {
  readonly requestId: string;
  readonly source: string | null;
  readonly status: string;
  readonly skipReason: string | null;
  readonly sessionId: string | null;
  readonly taskId: string | null;
  readonly receivedAt: string;
  /** `received_at` to the microsecond: what the keyset compares, which the display value rounds. */
  readonly receivedExact: string;
};

const EXACT_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

/** A cursor is `<received_at to the microsecond>|<delivery id>`: the only thing this module mints. */
const parseCursor = (
  raw: string,
): Effect.Effect<
  { readonly at: string; readonly id: string },
  TriggerDeliveryError
> => {
  const separator = raw.indexOf("|");
  const at = separator === -1 ? "" : raw.slice(0, separator);
  const id = separator === -1 ? "" : raw.slice(separator + 1);
  return EXACT_AT.test(at) && id !== ""
    ? Effect.succeed({ at, id })
    : Effect.fail(
        new TriggerDeliveryError({
          code: "invalid_input",
          message: `"${raw}" is not a delivery list cursor`,
        }),
      );
};

/** A stored row, checked: a status or id this build does not know is a broken row, not a delivery. */
const toRecord = (
  row: DeliveryRow,
): Effect.Effect<DeliveryRecord, Schema.SchemaError> =>
  Schema.decodeUnknownEffect(DeliveryRecord)({
    deliveryId: row.requestId,
    receivedAt: row.receivedAt,
    status: row.status,
    ...(row.source === null ? {} : { source: row.source }),
    ...(row.skipReason === null ? {} : { reason: row.skipReason }),
    ...(row.sessionId === null ? {} : { sessionId: row.sessionId }),
    ...(row.taskId === null ? {} : { taskId: row.taskId }),
  });

const storage =
  (what: string) =>
  (cause: { readonly message: string }): TriggerDeliveryError =>
    new TriggerDeliveryError({
      code: "storage",
      message: `${what}: ${cause.message}`,
    });

export const TriggerDeliveriesLive = Layer.effect(
  TriggerDeliveries,
  Effect.gen(function* () {
    const sql = yield* SqlClient;

    const list = Effect.fn("TriggerDeliveries.list")(function* (
      input: ListTriggerDeliveriesInput,
    ) {
      const limit = Math.min(
        Math.max(input.limit ?? DELIVERIES_DEFAULT_PAGE, 1),
        DELIVERIES_MAX_PAGE,
      );
      const cursor =
        input.cursor === undefined
          ? undefined
          : yield* parseCursor(input.cursor);
      // One statement: the keyset comparison is a parameter, and `limit + 1` rows say whether a page
      // follows, so a cursor is minted only when one does. The `ORDER BY` names the table's column:
      // a bare `received_at` would sort by the display alias above, the millisecond text.
      const rows = yield* sql<DeliveryRow>`
        SELECT request_id, source, status, skip_reason, session_id, task_id,
          to_char(received_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS received_at,
          to_char(received_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS received_exact
        FROM webhook_deliveries
        WHERE (${input.source ?? null}::text IS NULL OR source = ${input.source ?? null})
          AND (${input.status ?? null}::text IS NULL OR status = ${input.status ?? null})
          AND (
            ${cursor?.at ?? null}::timestamptz IS NULL
            OR (received_at, request_id) < (${cursor?.at ?? null}::timestamptz, ${cursor?.id ?? null}::text)
          )
        ORDER BY webhook_deliveries.received_at DESC, webhook_deliveries.request_id DESC
        LIMIT ${limit + 1}
      `.pipe(Effect.mapError(storage("list trigger deliveries")));
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      const deliveries = yield* Effect.forEach(page, toRecord).pipe(
        Effect.mapError(storage("read trigger deliveries")),
      );
      return {
        deliveries,
        ...(rows.length > limit && last !== undefined
          ? { nextCursor: `${last.receivedExact}|${last.requestId}` }
          : {}),
      };
    });

    return TriggerDeliveries.of({ list });
  }),
);
