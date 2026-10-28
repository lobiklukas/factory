import { Console, Effect, Option } from "effect";
import { Command, Flag } from "effect/cli";
import {
  DeliverySource,
  DeliveryStatus,
  type DeliveryRecord,
  type ListTriggerDeliveriesInput,
} from "@repo/domain/Trigger";
import { resolveApiUrl } from "../api";
import { reportFailure, reportFailures } from "../errors";
import { BoardClient } from "../rpc";

/**
 * `factory triggers` — what the trigger seam did with the deliveries it received (T4).
 *
 * `ls` (also spelled `deliveries`) reads `listTriggerDeliveries`: newest first, one row per delivery,
 * with how it ended and why. It answers "my labelled issue started nothing — did the delivery arrive,
 * was it refused, and what did it start": a skip's reason is printed exactly as the seam recorded it,
 * and a processed delivery names the session or the card it opened. A delivery refused before the
 * seam (a wrong signature, an oversized body, a route with no secret) is logged by the API and never
 * recorded, so it is not here by design.
 *
 * The lines are built by the pure functions below, so the layout is a table in a test and the command
 * only fetches and prints.
 */

/** What a cell with no value prints, as `factory repo ls` and `factory skill ls` do. */
export const NONE = "none";

/** What separates the columns: a tab, so a reason with spaces does not shift one. */
export const DELIVERY_SEPARATOR = "\t";

/** The header `factory triggers ls` prints: one name per column, in row order. */
export const DELIVERY_HEADER = [
  "received-at",
  "source",
  "status",
  "delivery",
  "session",
  "card",
  "reason",
].join(DELIVERY_SEPARATOR);

/**
 * A reason on one line. It is the seam's own sentence, unchanged; only a tab or newline in it (a
 * failed setup's first line is all the seam stores, but a reason is free text) becomes a space, so a
 * row stays a row and a script can still `cut -f` the columns.
 */
const oneLine = (text: string): string => text.replace(/[\t\r\n]+/g, " ");

/** One delivery as a row. `source` is `none` for a delivery recorded before the column existed. */
export const deliveryRow = (delivery: DeliveryRecord): string =>
  [
    delivery.receivedAt,
    delivery.source ?? NONE,
    delivery.status,
    oneLine(delivery.deliveryId),
    delivery.sessionId ?? NONE,
    delivery.taskId ?? NONE,
    delivery.reason === undefined ? NONE : oneLine(delivery.reason),
  ].join(DELIVERY_SEPARATOR);

/** `factory triggers ls`, whole: the header and a row per delivery, or a sentence naming the filter. */
export const deliveryLines = (
  deliveries: ReadonlyArray<DeliveryRecord>,
  filter: Pick<ListTriggerDeliveriesInput, "source" | "status"> = {},
): ReadonlyArray<string> => {
  if (deliveries.length > 0) {
    return [DELIVERY_HEADER, ...deliveries.map(deliveryRow)];
  }
  const narrowed = [
    ...(filter.source === undefined ? [] : [`source ${filter.source}`]),
    ...(filter.status === undefined ? [] : [`status ${filter.status}`]),
  ];
  return [
    narrowed.length === 0
      ? "no deliveries"
      : `no deliveries with ${narrowed.join(" and ")}`,
  ];
};

/**
 * A flag's value against the domain's own literals, so the words the server accepts are the CLI's: a
 * word outside them is `invalid_input` naming the ones inside, and no request is sent.
 */
const decodeChoice = <A extends string>(
  literals: ReadonlyArray<A>,
  flag: string,
  raw: string,
): Effect.Effect<A> => {
  const found = literals.find((literal) => literal === raw);
  return found !== undefined
    ? Effect.succeed(found)
    : Effect.andThen(
        reportFailure(
          "invalid_input",
          `--${flag} "${raw}" is not one of ${literals.join(", ")}`,
        ),
        Effect.never,
      );
};

const apiFlag = Flag.String("api").pipe(
  Flag.withDescription("Control plane base URL"),
  Flag.optional,
);

const deliveriesCommand = (name: "ls" | "deliveries") =>
  Command.make(
    name,
    {
      source: Flag.String("source").pipe(
        Flag.withDescription(
          `Only deliveries from this source (${DeliverySource.literals.join(", ")})`,
        ),
        Flag.optional,
      ),
      status: Flag.String("status").pipe(
        Flag.withDescription(
          `Only deliveries that ended this way (${DeliveryStatus.literals.join(", ")})`,
        ),
        Flag.optional,
      ),
      limit: Flag.Int("limit").pipe(
        Flag.withDescription("Page size (the server clamps it)"),
        Flag.optional,
      ),
      cursor: Flag.String("cursor").pipe(
        Flag.withDescription("Keyset cursor from a previous page"),
        Flag.optional,
      ),
      api: apiFlag,
    },
    Effect.fnUntraced(function* ({ source, status, limit, cursor, api }) {
      const filter: Pick<ListTriggerDeliveriesInput, "source" | "status"> = {
        ...(Option.isSome(source)
          ? {
              source: yield* decodeChoice(
                DeliverySource.literals,
                "source",
                source.value,
              ),
            }
          : {}),
        ...(Option.isSome(status)
          ? {
              status: yield* decodeChoice(
                DeliveryStatus.literals,
                "status",
                status.value,
              ),
            }
          : {}),
      };
      const apiUrl = yield* resolveApiUrl(api);

      const program = Effect.gen(function* () {
        const { client } = yield* BoardClient;
        const output = yield* client.listTriggerDeliveries({
          ...filter,
          ...(Option.isSome(limit) ? { limit: limit.value } : {}),
          ...(Option.isSome(cursor) ? { cursor: cursor.value } : {}),
        });
        for (const line of deliveryLines(output.deliveries, filter)) {
          yield* Console.log(line);
        }
        // On stderr, so a script that reads the rows with `cut` never takes the cursor for one.
        if (output.nextCursor !== undefined) {
          yield* Console.error(`cursor: ${output.nextCursor}`);
        }
      });

      // `TriggerDeliveryError` keeps its `code` (`invalid_input`: fix the cursor; `storage`: retry),
      // as `SessionError` does, rather than the tag's snake_case a script cannot branch on.
      yield* reportFailures(
        Effect.provide(program, BoardClient.layer(apiUrl)).pipe(
          Effect.catchTag("TriggerDeliveryError", (error) =>
            reportFailure(error.code, error.message),
          ),
        ),
      );
    }),
  ).pipe(
    Command.withDescription(
      "List the deliveries the trigger seam recorded, newest first, with how each ended and why",
    ),
    Command.withExamples([
      {
        command: "factory triggers ls --status skipped",
        description: "Why did my labelled issue start nothing?",
      },
      {
        command: "factory triggers ls --source linear --limit 10",
        description: "The newest Linear deliveries",
      },
    ]),
  );

export const triggersCommand = Command.make("triggers").pipe(
  Command.withDescription("Inspect what the trigger seam did with deliveries"),
  Command.withSubcommands([
    deliveriesCommand("ls"),
    deliveriesCommand("deliveries"),
  ]),
);
