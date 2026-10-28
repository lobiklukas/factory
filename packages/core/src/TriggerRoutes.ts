/**
 * Stored trigger routes (LOB-266): the rows on the repo registry that say which label or team starts
 * work on which repo, and how a delivery's rule set is made of them.
 *
 * `TRIGGER_RULES` is read once per process, so changing where a label goes was an env edit and a
 * restart. A route is a row instead, and the trigger seam reads the table per delivery
 * (`readRoutedRules`): an operator who adds one over RPC has routed the next delivery. The env rules
 * stay as the fallback, after every stored route, so a deployment that has no rows behaves as it
 * always did.
 *
 * Which rule matched is a fact the delivery's recorded reason carries, so every rule here travels as a
 * `RoutedRule`: the rule and where it came from (`route <id>` for a row, `env:TRIGGER_RULES[i]` for
 * the fallback). Nothing in this file decides whether an event starts work; that is the seam's.
 */
import { Context, Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import {
  TriggerRouteError,
  TriggerRouteNotFound,
  type AddTriggerRouteInput,
  TriggerRoute,
  type TriggerRouteId,
  type TriggerRule,
} from "@repo/domain/Trigger";
import { mintTriggerRouteId } from "./ids";

/** A rule and the place it came from, which the recorded reason names. */
export type RoutedRule = {
  readonly rule: TriggerRule;
  /** `route <id>` for a stored route, `env:TRIGGER_RULES[i]` for the fallback. */
  readonly origin: string | undefined;
};

/** What `TRIGGER_RULES` is called in a reason, and in the boot log. */
export const ENV_RULES_ORIGIN = "env:TRIGGER_RULES";

/**
 * The rules the environment supplied, each named by its position in the variable. No `origin` means
 * the rules are not `TRIGGER_RULES` (the docs and review seams') and a reason names the rule only.
 */
export const envRoutedRules = (
  rules: ReadonlyArray<TriggerRule>,
  origin: string | undefined,
): ReadonlyArray<RoutedRule> =>
  rules.map((rule, index) => ({
    rule,
    origin: origin === undefined ? undefined : `${origin}[${index}]`,
  }));

type RouteRow = {
  readonly id: string;
  readonly label: string | null;
  readonly team: string | null;
  readonly repo: string;
  readonly baseRef: string | null;
  readonly prompt: string;
  readonly startsWorkFor: ReadonlyArray<string> | null;
  readonly createdAt: string;
};

/** A stored row, checked: a repo slug or id this build does not know is a broken row, not a route. */
const toRoute = (
  row: RouteRow,
): Effect.Effect<TriggerRoute, Schema.SchemaError> =>
  Schema.decodeEffect(TriggerRoute)({
    id: row.id,
    repo: row.repo,
    prompt: row.prompt,
    createdAt: row.createdAt,
    ...(row.label === null ? {} : { label: row.label }),
    ...(row.team === null ? {} : { team: row.team }),
    ...(row.baseRef === null ? {} : { baseRef: row.baseRef }),
    ...(row.startsWorkFor === null ? {} : { startsWorkFor: row.startsWorkFor }),
  });

/**
 * Every stored route in the order the seam consults them: a route naming a label and a team first
 * (the most specific), then a label alone, then a team alone, the older route first within each. The
 * order is a function of the rows alone, so two processes agree on it.
 */
export const readStoredRoutes = (
  sql: SqlClient,
): Effect.Effect<ReadonlyArray<TriggerRoute>, SqlError | Schema.SchemaError> =>
  Effect.gen(function* () {
    const rows = yield* sql<RouteRow>`
    SELECT id, label, team, repo, base_ref, prompt, starts_work_for,
      to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at
    FROM trigger_routes
    ORDER BY CASE WHEN label IS NOT NULL AND team IS NOT NULL THEN 0
                  WHEN label IS NOT NULL THEN 1
                  ELSE 2 END,
             created_at, id
  `;
    return yield* Effect.forEach(rows, toRoute);
  });

/**
 * The rule set one delivery is routed with: the stored routes, then the fallback. Read per call, so a
 * route added a moment ago is in it.
 */
export const readRoutedRules = (
  sql: SqlClient,
  fallback: ReadonlyArray<RoutedRule>,
): Effect.Effect<ReadonlyArray<RoutedRule>, SqlError | Schema.SchemaError> =>
  readStoredRoutes(sql).pipe(
    Effect.map((stored) => [
      ...stored.map((route) => ({
        rule: route satisfies TriggerRule,
        origin: `route ${route.id}`,
      })),
      ...fallback,
    ]),
  );

export type TriggerRoutesShape = {
  /**
   * Store a route. The repo must be registered (`invalid_input` naming it otherwise), so a route
   * never points at a repo the seam would only skip.
   */
  readonly add: (
    input: AddTriggerRouteInput,
  ) => Effect.Effect<TriggerRoute, TriggerRouteError>;
  /** Every stored route, in the order the seam consults them. */
  readonly list: Effect.Effect<ReadonlyArray<TriggerRoute>, TriggerRouteError>;
  /** Delete a route and answer the row it was; an unknown id is `TriggerRouteNotFound`. */
  readonly remove: (
    id: TriggerRouteId,
  ) => Effect.Effect<TriggerRoute, TriggerRouteError | TriggerRouteNotFound>;
};

export class TriggerRoutes extends Context.Service<
  TriggerRoutes,
  TriggerRoutesShape
>()("@repo/core/TriggerRoutes") {}

const storage =
  (what: string) =>
  (cause: { readonly message: string }): TriggerRouteError =>
    new TriggerRouteError({
      code: "storage",
      message: `${what}: ${cause.message}`,
    });

export const TriggerRoutesLive = Layer.effect(
  TriggerRoutes,
  Effect.gen(function* () {
    const sql = yield* SqlClient;

    const list = readStoredRoutes(sql).pipe(
      Effect.mapError(storage("read trigger routes")),
    );

    /** The one row a `RETURNING` answered, decoded. */
    const storedRow = (
      rows: ReadonlyArray<RouteRow>,
      id: TriggerRouteId,
      what: string,
    ) =>
      Effect.gen(function* () {
        const row = rows[0];
        if (row === undefined) {
          return yield* new TriggerRouteError({
            code: "storage",
            message: `${what}: trigger route ${id} returned no row`,
          });
        }
        return yield* toRoute(row).pipe(Effect.mapError(storage(what)));
      });

    const add = Effect.fn("TriggerRoutes.add")(function* (
      input: AddTriggerRouteInput,
    ) {
      const registered = yield* sql<{ slug: string }>`
        SELECT slug FROM repos WHERE slug = ${input.repo}
      `.pipe(Effect.mapError(storage("read repo registry")));
      if (registered.length === 0) {
        return yield* new TriggerRouteError({
          code: "invalid_input",
          message: `repo ${input.repo} is not registered; register it before routing to it`,
        });
      }
      const id = yield* mintTriggerRouteId;
      const rows = yield* sql<RouteRow>`
        INSERT INTO trigger_routes (id, label, team, repo, base_ref, prompt, starts_work_for)
        VALUES (
          ${id}, ${input.label ?? null}, ${input.team ?? null}, ${input.repo},
          ${input.baseRef ?? null}, ${input.prompt},
          ${input.startsWorkFor ?? null}::text[]
        )
        RETURNING id, label, team, repo, base_ref, prompt, starts_work_for,
          to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at
      `.pipe(Effect.mapError(storage("store trigger route")));
      return yield* storedRow(rows, id, "store trigger route");
    });

    const remove = Effect.fn("TriggerRoutes.remove")(function* (
      id: TriggerRouteId,
    ) {
      // One statement: of two concurrent removes only one gets the row back, so only one is told it
      // removed it and the other is told the route is gone.
      const rows = yield* sql<RouteRow>`
        DELETE FROM trigger_routes WHERE id = ${id}
        RETURNING id, label, team, repo, base_ref, prompt, starts_work_for,
          to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at
      `.pipe(Effect.mapError(storage("delete trigger route")));
      if (rows.length === 0) {
        return yield* new TriggerRouteNotFound({
          id,
          message: `trigger route ${id} does not exist`,
        });
      }
      return yield* storedRow(rows, id, "delete trigger route");
    });

    return TriggerRoutes.of({ add, list, remove });
  }),
);
