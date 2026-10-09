/**
 * Kubernetes-style probes (LOB-21).
 *
 * `/livez` answers "is this process alive" and must not depend on anything else: a liveness probe
 * that failed because the database was down would have Kubernetes restart a healthy pod and turn a
 * database outage into a crash loop. It is a constant 200.
 *
 * `/readyz` answers "can this process serve a session right now", and it is a *live* check: every
 * request queries Postgres, reads the migration ledger, and selects the exact columns the control
 * plane reads. It returns 503 with a body naming each check and what failed, so an operator can tell
 * a missing database from a missing migration from a missing table without reading the log.
 *
 * Both routes are reachable whether or not the database is up — `apps/api/src/index.ts` binds the
 * server without waiting for migrations, and requests that need the log fail with a typed
 * `SessionError` instead of killing the process at boot.
 */
import { Cause, Effect, Layer } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import { SqlClient } from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

/**
 * The migration ids the control plane's queries depend on — the files in
 * `packages/storage-postgres/src/migrations`. The `schema` check below is the enforcement (it
 * selects the real columns), so this list only has to be right enough to name the ledger state in
 * the probe's body.
 */
const REQUIRED_MIGRATIONS: ReadonlyArray<number> = [1, 2, 3, 4, 5, 6, 7, 8];

/** One named readiness check, as it appears in `/readyz`. */
type CheckResult =
  | { readonly name: string; readonly ok: true }
  | { readonly name: string; readonly ok: false; readonly error: string };

/**
 * A check that yields `undefined` when it passes, or the reason it failed. A reason rather than a
 * typed failure keeps every check in one error channel (`SqlError`) while still letting a check that
 * composes several statements say *which* invariant broke.
 */
type Check = Effect.Effect<string | undefined, SqlError, SqlClient>;

/** The first line of a cause, short enough to put in a JSON body. */
const reasonOf = (cause: Cause.Cause<SqlError>): string => {
  const line = Cause.pretty(cause).split("\n")[0]?.trim() ?? "";
  if (line.length === 0) return "failed with no message";
  return line.length > 300 ? `${line.slice(0, 297)}...` : line;
};

/**
 * Run one check and turn it into a `CheckResult`. Catches failures *and* defects: a probe that threw
 * would look like a 500 (a broken probe) rather than a truthful 503.
 */
const runCheck = (
  name: string,
  check: Check,
): Effect.Effect<CheckResult, never, SqlClient> =>
  check.pipe(
    Effect.map((failure) =>
      failure === undefined
        ? { name, ok: true as const }
        : { name, ok: false as const, error: failure },
    ),
    Effect.catchCause((cause) =>
      Effect.succeed({ name, ok: false as const, error: reasonOf(cause) }),
    ),
  );

/** Postgres is reachable and answers a trivial round-trip. */
const postgresCheck: Check = Effect.gen(function* () {
  const sql = yield* SqlClient;
  yield* sql`SELECT 1`;
  return undefined;
});

/** Every migration the control plane needs has been applied. */
const migrationsCheck: Check = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const rows = yield* sql<{
    migrationId: number;
  }>`SELECT migration_id FROM effect_sql_migrations`;
  const applied = rows.map((row) => row.migrationId);
  const missing = REQUIRED_MIGRATIONS.filter((id) => !applied.includes(id));
  return missing.length === 0
    ? undefined
    : `missing migrations: ${missing.join(", ")}`;
});

/**
 * The schema the control plane reads is usable. This selects the real columns of every table a
 * session request touches — the session index, the activity index the list reads, the repo registry,
 * and the commit log — so a half-applied migration fails here by name rather than as a confusing
 * error on the first `createSession`.
 */
const schemaCheck: Check = Effect.gen(function* () {
  const sql = yield* SqlClient;
  yield* sql`SELECT id, title, repo, base_ref, created_at FROM sessions LIMIT 1`;
  yield* sql`SELECT session_id, status, cost_total, last_activity_at FROM session_activity LIMIT 1`;
  yield* sql`SELECT session_id, request_id, action, detail, requested_at FROM session_approvals LIMIT 1`;
  yield* sql`SELECT slug, url, default_base_ref, local_path, registered_at FROM repos LIMIT 1`;
  yield* sql`SELECT log_id, seq, writes, committed_at FROM commits LIMIT 1`;
  return undefined;
});

const readiness: Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  never,
  SqlClient
> = Effect.gen(function* () {
  const checks: ReadonlyArray<CheckResult> = [
    yield* runCheck("postgres", postgresCheck),
    yield* runCheck("migrations", migrationsCheck),
    yield* runCheck("schema", schemaCheck),
  ];
  const ready = checks.every((check) => check.ok);
  return HttpServerResponse.setStatus(
    HttpServerResponse.jsonUnsafe({
      status: ready ? "ok" : "unavailable",
      checks,
    }),
    ready ? 200 : 503,
  );
});

const livez = HttpRouter.add(
  "GET",
  "/livez",
  HttpServerResponse.jsonUnsafe({ status: "ok" }),
);

const readyz = HttpRouter.add("GET", "/readyz", readiness);

export const ProbesLive = Layer.mergeAll(livez, readyz);
