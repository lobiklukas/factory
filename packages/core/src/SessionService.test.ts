/**
 * The session service, driven through its own interface against a real Postgres log.
 *
 * What this proves that the harness test cannot: a session created and driven here is readable
 * *the same way* after its owner is released, which is D8's live/historical pair — the live view
 * and the fold have to agree, or the dashboard shows two different sessions depending on whether
 * a sandbox happens to be running.
 *
 * Deterministic and offline (faux model), but it needs Postgres: `docker compose up -d --wait
 * postgres`. It also needs the role to hold `CREATEDB`, because the block below creates the
 * database it runs against, and enough privilege over `pg_database` to drop one it does not own,
 * which the sweep does; `compose.yaml` satisfies both by making the bootstrap user the superuser,
 * and a role without them fails the whole file at import rather than one case.
 *
 * It creates a database of its own for the run and drops it at the end, so it never writes a row of
 * any table in whatever `DATABASE_URL` points at. It does write two kinds of thing there that are
 * not rows: it adds and removes databases in the shared `pg_database` catalogue, and it reads that
 * catalogue and `pg_stat_activity`. Every statement it issues against the configured database is
 * one of the shapes enumerated at `maintenance` below; the only ones that reach past a database
 * this file minted are the `pg_database`/`pg_stat_activity` reads and a `SELECT EXISTS` asking
 * whether a database it minted is still there.
 *
 * A run killed between `CREATE DATABASE` and `afterAll` — a signal, a crash, an OOM kill — never
 * reaches its own drop, so this file also sweeps what earlier runs abandoned before it creates its
 * own (LOB-134). That reduces the leak, it does not close it, and all three parts of the remainder
 * are worth stating rather than rounding off: the killed run's database stays until some *later* run
 * drops it, so a server nobody ever runs this file against keeps it forever; a database minted
 * before the start time was encoded into the name carries no age to read, so nothing will ever drop
 * it; and a run *older than the hour* that happens to be between connections at the instant the
 * sweep reads `pg_stat_activity` reads as an orphan and is collected, `WITH (FORCE)` taking its
 * backends with it. Best-effort collection, not a guarantee — do not read the sweep as one.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { BunServices } from "@effect/platform-bun";
import { PgClient } from "@effect/sql-pg";
import type { ApprovalRequest } from "@repo/domain/Approval";
import type {
  ListSessionsInput,
  ListSessionsOutput,
  RepoSlug,
  SessionError,
  SessionEvent,
  SessionId,
  SessionListEntry,
  SessionSnapshot,
  SessionSummary,
  SessionUsage,
  SpendReport,
} from "@repo/domain/Session";
import {
  RepoSlug as RepoSlugSchema,
  SessionId as SessionIdSchema,
} from "@repo/domain/Session";
import {
  DEFAULT_DEFINITION_ID,
  DefinitionId as DefinitionIdSchema,
} from "@repo/domain/Task";
import {
  DatabaseConfig,
  DatabaseLive,
  PostgresStorage,
} from "@repo/storage-postgres";
import {
  Clock,
  ConfigProvider,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  ManagedRuntime,
  Option,
  Random,
  Redacted,
  Ref,
  Schema,
  Stream,
} from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { SqlClient } from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createFauxModelAccess,
  createModelAccess,
  DEFAULT_AUTONOMY,
  PR_EVIDENCE_EXCERPT,
  readPromptSections,
  readSessionLog,
  readVerifyRecords,
  resolveRoleModels,
  tailOf,
  usageCostTotal,
  type VerifyRecord,
} from "@repo/harness";
import { rebuildIndexes } from "./rebuild";
import { CredentialProvider, staticTokenProvider } from "./credentials";
import { DEFAULT_DIFF_CAP, PullRequest } from "./pr";
import type { OpenedPullRequest, PullRequestStep } from "./pr";
import { SkillService, SkillServiceLive } from "./SkillService";
import { TaskService, TaskServiceLive } from "./TaskService";
import {
  sessionRequestIdOf,
  TriggerSessions,
  TriggerSessionsFromSessionService,
} from "./TriggerService";
import { DEFAULT_LINEAR_STATES, linearPullRequestComment } from "./LinearSync";
import {
  pullRequestReport,
  SessionWriteBack,
  type PullRequestReport,
  type SessionWriteBackShape,
} from "./SessionWriteBack";
import {
  approvalResumeMessage,
  MAX_MESSAGE_CHARS,
  MAX_PAGE_SIZE,
  SessionService,
  SessionServiceLive,
  type SessionServiceShape,
} from "./SessionService";

const sessionRoot = mkdtempSync(join(tmpdir(), "factory-core-"));

/** A checkout the registry can point at, so a repo's own config is readable. */
const repoRoot = mkdtempSync(join(tmpdir(), "factory-repo-"));
mkdirSync(join(repoRoot, ".factory"), { recursive: true });
execSync("git init -b main", { cwd: repoRoot, stdio: "ignore" });
execSync("git config user.email t@t.com", { cwd: repoRoot, stdio: "ignore" });
execSync("git config user.name t", { cwd: repoRoot, stdio: "ignore" });
execSync("git commit --allow-empty -m init", {
  cwd: repoRoot,
  stdio: "ignore",
});
writeFileSync(
  join(repoRoot, ".factory", "config"),
  JSON.stringify({
    install: "bun install",
    build: "bun run build",
    test: "bun run test",
    verify: "bun .pi/skills/verify-api/drive.ts",
  }),
);

const emptyRepoRoot = mkdtempSync(join(tmpdir(), "factory-repo-empty-"));
execSync("git init -b main", { cwd: emptyRepoRoot, stdio: "ignore" });
execSync("git config user.email t@t.com", {
  cwd: emptyRepoRoot,
  stdio: "ignore",
});
execSync("git config user.name t", { cwd: emptyRepoRoot, stdio: "ignore" });
execSync("git commit --allow-empty -m init", {
  cwd: emptyRepoRoot,
  stdio: "ignore",
});
execSync("git branch -m trunk", { cwd: emptyRepoRoot, stdio: "ignore" });

const DatabaseLayer = Layer.mergeAll(DatabaseLive, BunServices.layer);

/**
 * The URL `DATABASE_URL` resolves to, and the one the suite actually runs against (LOB-96).
 *
 * Every statement this file used to issue went through one pool, and one case of it emptied the
 * `sessions` index entirely, so the blast radius of a run was whatever database that pool opened.
 * Sharing one with everything else on the machine made that radius every session anyone else had,
 * and the fold that follows costs the whole shared log rather than the one session the case asserts
 * on — which is why that case carried a budget that expired as the shared database grew (LOB-113).
 *
 * So this file creates a database of its own for the run and drops it at the end, and points the
 * suite's `DATABASE_URL` at it before the runtime is built. Nothing else changes: the case still
 * drops the whole index and refolds it, which is the claim worth making, and it is now a claim
 * about this run's rows.
 *
 * The fallback below is `DatabaseConfig`'s own default, duplicated rather than imported because
 * reading the config is the thing being ordered around. `Database.ts` says so at the literal, and
 * `describe("this suite's database")` reads both back so the duplication cannot drift silently.
 *
 * Reading the environment directly is not a shortcut, it is the only order that works. In effect
 * 4.0.0 `ConfigProvider.fromEnv()` is a *copy* of `process.env`, not a per-read view, and
 * `ConfigProvider` is a `Context.Reference` whose default is memoised — so the snapshot is taken
 * when that reference's default is first materialised, which is the first config read anywhere in
 * the process, not when this line runs. `ManagedRuntime.make` is lazy, so the assignment below may
 * come after the runtime is constructed and still land first; what it may not do is come after
 * anything has *resolved* a config. That is why the maintenance client below is built from this
 * string rather than from `DatabaseLive` — a `DatabaseLive` here would resolve a config before the
 * assignment and freeze `DATABASE_URL` where it was.
 */
const configuredUrl =
  // oxlint-disable-next-line effecttsgo/process-env -- a test harness sets up its own process.
  process.env["DATABASE_URL"] ??
  "postgres://factory:factory@localhost:5442/factory";

/**
 * The database `DATABASE_URL` names, read from its URL path — or `""` when the URL names none.
 *
 * Empty is the honest answer and the code below is written to cope with it, because there is no
 * other one derivable here: a URL with an empty path resolves to the *role's* own database, and
 * which database that is belongs to the server, not to the string (measured: substituting a
 * plausible guess like `postgres` fails the witness below with
 * `expected 'factory' to be 'postgres'`). So the witness compares the configured database's own
 * name only when the URL gave one, and relies on the two pools disagreeing otherwise.
 */
const configuredDatabase = new URL(configuredUrl).pathname.replace(/^\//, "");

/**
 * How long a run's database has to sit unclaimed before the sweep will consider it abandoned.
 *
 * Generous on purpose, and the reason is structural rather than measured: the alternative liveness
 * signal — connections alone — is empty for a *starting* run for far longer than anyone would
 * guess. This file's own pool is a lazy `ManagedRuntime` built after its `CREATE DATABASE` and first
 * used inside the first case, so between those two points the database it is about to use has zero
 * backends for as long as module evaluation and test collection take. A sweep landing in that window
 * would drop a database a run is about to need, so the age has to be long compared with *that*, and
 * an hour is long compared with seconds.
 *
 * What the hour does not buy is certainty: a database under this prefix that is over an hour old and
 * reads zero connections at the instant of the query is a candidate whatever it really is. A run that
 * has outlived the hour and is between connections at that instant is the one case this sweep can
 * misjudge, and it is the case the residual-leak note in the file header is about.
 */
const STALE_RUN_AFTER_MS = 60 * 60 * 1000;

/** How many random characters disambiguate two runs that start in the same millisecond. */
const RUN_RANDOM_CHARS = 6;

/**
 * The widest a base-36 millisecond stamp gets before the year 2100, and the room every name this
 * file mints reserves for its tail.
 *
 * Named and module-level because two places need it and they must not disagree: the reservation
 * below cuts the base, and the case that checks every name fits inside 63 bytes measures the result.
 * That case used to re-derive the arithmetic locally, and narrowing the real reservation by one
 * character left it green while names overran the limit and Postgres truncated them silently.
 */
const MAX_STAMP_WIDTH = 9;
const RUN_NAME_RESERVED =
  `_core_`.length + RUN_RANDOM_CHARS + 1 + MAX_STAMP_WIDTH;

/**
 * The head every name for `database` gets, and therefore the prefix the sweep matches.
 *
 * A function of the database's name rather than a constant over the configured one, so the case
 * that checks the 63-byte limit can ask about a name long enough to hit the limit. It could not do
 * that by measuring this run's own prefix: `factory_ralph` is fourteen characters, so the limit is
 * nowhere near it and every reservation this file gets wrong still fits — the check was green on a
 * reservation narrowed by a whole character.
 *
 * The reservation is *fixed* rather than taken from the tail's measured length: the tail carries a
 * base-36 millisecond stamp whose width changes (8 characters today, 9 from 2059-05-25, which is
 * `36 ** 8` milliseconds after the epoch), and a prefix derived from a varying reservation would
 * change with it, so today's names would stop matching tomorrow's sweep.
 *
 * Every identifier this file issues is quoted — `sql(name)` escapes it — so Postgres does not fold
 * the name to lower case and does not need it folded. What *is* real is the 63-byte limit, which
 * applies to a quoted identifier too: it truncates silently, and a truncated tail would collide.
 * `RUN_NAME_RESERVED` keeps every name this file can mint inside it.
 */
const runDatabasePrefixFor = (database: string) => {
  // The name may be empty, which leaves a leading underscore — a legal identifier, and one this
  // file quotes anyway. There is nothing to pad it with.
  const base = database
    .replaceAll(/[^a-z0-9_]/g, "_")
    .slice(0, 63 - RUN_NAME_RESERVED);
  return `${base}_core_`;
};

/** This run's own prefix: the one over `configuredDatabase`. */
const runDatabasePrefix = runDatabasePrefixFor(configuredDatabase);

/** A tail for a run that started at `at`: random characters, then the stamp in base 36. */
const runDatabaseTail = (at: number) =>
  `${randomBytes(3).toString("hex")}_${Math.trunc(at).toString(36)}`;

/**
 * The start time encoded in a tail, or `undefined` when the tail does not carry one.
 *
 * `undefined` means *unproven*, not *fresh*: a database minted before this file encoded the stamp
 * has no age to read, so the sweep skips it. Dropping those would be the one thing the stamp exists
 * to prevent — deciding an unknown-age database is old — and the header states the leak they leave.
 *
 * A stamp is rejected by *length* as well as by character, and the length bound is the interesting
 * half. Base 36 is dense: `notbase36` is nine legal base-36 digits, so a character-set check alone
 * decodes it to a year-4085 timestamp. Nothing breaks today — such a value is far in the future, so
 * the sweep's cutoff skips it, which is the safe direction — but the safety would rest on an
 * accident of magnitude rather than on a rule. The bound is *`now`'s* own digit count: no stamp this
 * file mints is longer than the current one (base-36 width only grows, at 2059), so anything longer
 * was never minted here. That turns "happens to be safe" into "rejected by construction".
 *
 * `now` is a parameter rather than a `Date.now()` read so that one decision does not read two
 * clocks: the caller is inside an Effect and already has `Clock.currentTimeMillis` in hand, and
 * under a `TestClock` a bound taken from the wall clock would disagree with the cutoff it is
 * compared against.
 */
const runStartedAt = (tail: string, now: number): number | undefined => {
  const match = /^([0-9a-f]+)_([0-9a-z]+)$/.exec(tail);
  if (match === null) return undefined;
  const stamp = match[2] as string;
  if (stamp.length > now.toString(36).length) return undefined;
  const at = Number.parseInt(stamp, 36);
  return Number.isSafeInteger(at) && at > 0 ? at : undefined;
};

/**
 * A database name for this run: the shared prefix, then this run's own tail.
 *
 * The random characters are what keep two runs of this suite against one server from colliding
 * (measured: two concurrent runs of this file, and two concurrent gates, both clean); the stamp is
 * what lets a later run tell an abandoned database from a live one (LOB-134).
 */
// The run's name is minted at module scope, before the runtime that would let `Clock` answer —
// which is the same ordering constraint the `DATABASE_URL` assignment below is written around. The
// stamp is this run's real start time, so the real clock is what has to be read here.
// oxlint-disable-next-line effecttsgo/global-date -- a test harness mints its name before any runtime exists.
const runDatabaseName = `${runDatabasePrefix}${runDatabaseTail(Date.now())}`;

/** The same URL with a different database on it, and every other parameter left alone. */
const runDatabaseUrl = (() => {
  const url = new URL(configuredUrl);
  url.pathname = `/${runDatabaseName}`;
  return url.toString();
})();

/**
 * The only connection to the configured database this file ever opens.
 *
 * `PgClient.layer` with an explicit URL, never `DatabaseLive`: this client creates and drops
 * databases, and migrating somebody else's would be the very reach this change is about. It never
 * writes a `sessions` row either. The shapes of statement that reach the configured database are:
 * `CREATE DATABASE` for the run's own; `DROP DATABASE` for the run's own; `DROP DATABASE IF
 * EXISTS` for a decoy, and for an abandoned one (the sweep); the sweep's `pg_database` /
 * `pg_stat_activity` read; `current_database()`; a `to_regclass('public.sessions')` probe paired
 * with a `SELECT id FROM sessions`, both in one helper; and the sweep cases' `SELECT EXISTS …
 * FROM pg_database`. This list is the census — it is stated here rather than counted above because
 * a count is ambiguous (the `to_regclass` pair) and would drift the first time a shape is added.
 * Only the last two reach past a database this file minted, and neither writes.
 */
const maintenance = ManagedRuntime.make(
  PgClient.layer({
    url: Redacted.make(configuredUrl),
    maxConnections: 2,
  }).pipe(Layer.provide(BunServices.layer)),
);

/**
 * The databases under this file's prefix, with the two facts that decide whether each is an orphan.
 *
 * `connections` comes from `pg_stat_activity` rather than from the absence of rows, because a
 * connection that has not issued a query yet is exactly the state a *starting* run is in and a
 * *finishing* run is leaving. This client is connected to the configured database, never to one of
 * these, so its own backend is not in the count and no `pid` filter is needed.
 *
 * The age is deliberately *not* selected here: it is decoded in TypeScript by `runStartedAt`,
 * below. A name is not arithmetic — the stamp is a suffix whose width changes with the calendar,
 * so a cast in SQL would have to re-derive the encoding in a second language to read it back.
 *
 * `starts_with` rather than `LIKE`, for a reason that is easy to get wrong: the prefix is derived
 * from the configured database's name, which routinely contains `_`, and `_` is a LIKE wildcard
 * matching *any* one character. `LIKE 'factory_ralph_core_%'` therefore also matches a database
 * named `factoryXralph_core_…` — and dropping a database this file did not create is exactly the
 * reach it exists to prevent. `starts_with` (Postgres 11) has no wildcard to escape.
 */
const runDatabases = Effect.gen(function* () {
  const sql = yield* SqlClient;
  return yield* sql<{ datname: string; connections: number }>`
    SELECT d.datname, (
      SELECT count(*)::int FROM pg_stat_activity a WHERE a.datname = d.datname
    ) AS connections
    FROM pg_database d
    WHERE starts_with(d.datname, ${runDatabasePrefix})
    ORDER BY d.datname
  `;
});

/**
 * Drop every database under the prefix that is over an hour old and reads no connections.
 *
 * Best-effort, and the file header says so. Three conditions decide each candidate, and none is
 * sufficient alone:
 *
 * - `connections > 0` separates a live run from an orphan, and it is why the age check exists at all
 *   (see `STALE_RUN_AFTER_MS`): a starting run's database has no connections for as long as module
 *   evaluation takes, so without an hour of encoded age a sweep could drop one out from under it.
 * - an undecodable stamp is *skipped*, not guessed at. Dropping a database whose age is unknown is the
 *   one thing the stamp exists to prevent.
 * - `runDatabaseName` is skipped by name, and this one is deliberately redundant: the other two
 *   conditions already cover it, because this run's database is seconds old and — once a case calls
 *   this effect directly — connected. Deleting the line leaves the suite 32/32 green (measured), so no
 *   case here can redden it. It is kept because a reordering of this effect past the `CREATE` would
 *   leave the age clause as the only thing standing, and the ordering is asserted by the case
 *   "runs before this file creates its own database" rather than by this line.
 *
 * `WITH (FORCE)`, and it is the sibling of the `IF EXISTS` below. The connection count is read in
 * one statement and the drop issued in another, so nothing serialises them, and a run that
 * connects in that gap loses its database. `FORCE` makes that loss total — the drop takes the
 * run's backends with it — where without it the same race would answer `55006 object_in_use` and,
 * under this file's `orDie` at import, redden the *whole* file. Collecting a rare long run's
 * database is the lesser of the two failures, and it is the one the file header names. No case
 * here can witness it: every in-file drop target reads zero connections in the statement that
 * selected it.
 *
 * `IF EXISTS`, and not for tidiness. Two runs on one server each read the same list of orphans and
 * each drop them, so the loser of every such pair gets `3D000 database "…" does not exist` — and it
 * fails the *whole file* at import rather than one case, so it is a red gate rather than a red case.
 * The read and the drop cannot be made atomic without locking every candidate against every other
 * run, which is far more coordination than sweeping abandoned databases is worth; `IF EXISTS` turns
 * the loser's error into a NOTICE and a no-op, which is enough. No case here reddens its removal —
 * the two concurrent runs that produce the loser are the drive, not a single-file run — which is why
 * this comment names what is witnessed here and what is not.
 */
const sweepAbandonedRunDatabases = Effect.gen(function* () {
  const sql = yield* SqlClient;
  // `Clock`, not `Date.now()`: the file's own rule (`effecttsgo/global-date-in-effect`, and
  // `denyWarnings: true` in the lint config, so a warning fails the gate) says time inside an
  // Effect is reached through `Clock`. The same word the service writes `last_activity_at` with.
  const now = yield* Clock.currentTimeMillis;
  const cutoff = now - STALE_RUN_AFTER_MS;
  for (const database of yield* runDatabases) {
    if (database.datname === runDatabaseName) continue;
    if (database.connections > 0) continue;
    const startedAt = runStartedAt(
      database.datname.slice(runDatabasePrefix.length),
      now,
    );
    if (startedAt === undefined) continue;
    if (startedAt >= cutoff) continue;
    yield* sql`DROP DATABASE IF EXISTS ${sql(database.datname)} WITH (FORCE)`;
  }
});

/**
 * Create the run's database, loudly, after collecting what earlier runs abandoned (LOB-134).
 *
 * The sweep is its own statement rather than part of this effect, because it is a different job with
 * a different blast radius: it drops *other* runs' databases, so a failure inside it is worth being
 * able to read as a sweep failure rather than as a `CREATE` failure. It is not isolated from this
 * file's fate, though — it is a top-level `await … orDie`, so a sweep that cannot run at all fails
 * the whole file before this `CREATE` is reached. That is intended rather than tolerated: a role that
 * cannot sweep a database also cannot create one, so the sweep failing is the Postgres precondition
 * failing, and there is no fallback to the configured database because pointing at that is the defect.
 */
await maintenance.runPromise(sweepAbandonedRunDatabases.pipe(Effect.orDie));

await maintenance.runPromise(
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    // Not a parameter: Postgres has no placeholder for an identifier. `sql(name)` is the
    // compiler's escaped-identifier helper, so this cannot become an injection.
    yield* sql`CREATE DATABASE ${sql(runDatabaseName)}`;
  }).pipe(Effect.orDie),
);

// Before the runtime below and before any case can run it, and before this process has read any
// config at all — see the note on `configuredUrl`.
// oxlint-disable-next-line effecttsgo/process-env -- a test harness sets up its own process.
process.env["DATABASE_URL"] = runDatabaseUrl;

const runtime = ManagedRuntime.make(
  // `provideMerge` keeps the database in the runtime's context, so a test can run SQL and the
  // rebuild against the same pool the service uses.
  // Two faux models, so a replay onto a *different* model is a difference this suite can make: the
  // backend publishes one id unless told otherwise (LOB-198).
  SessionServiceLive({
    model: createModelAccess("faux", { fauxModels: ["faux-1", "faux-2"] }),
    sessionRoot,
  }).pipe(Layer.provideMerge(DatabaseLayer)),
);

const program = <A, E>(
  effect: Effect.Effect<A, E, SessionService | SqlClient>,
) => runtime.runPromise(effect);

/** The repo slug tests bind to. */
const factoryRepo = RepoSlugSchema.make("lobiklukas/factory");

/**
 * The `sessions` ids in whichever database this client is connected to.
 *
 * Empty for a database that has not been migrated: a fresh CI database has no such table, and a
 * database with no table has no rows. That is why the witness below is vacuous on a first CI run
 * and not vacuous anywhere a run-context database already holds sessions.
 */
const sessionIds = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const table = yield* sql<{ present: string | null }>`
    SELECT to_regclass('public.sessions')::text AS present
  `;
  if (table[0]?.present === null) return [];
  const rows = yield* sql<{ id: string }>`SELECT id FROM sessions ORDER BY id`;
  return rows.map((row) => row.id);
});

/** The name of the database a client is connected to: what the two pools below are compared on. */
const currentDatabase = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const rows = yield* sql<{ name: string }>`SELECT current_database() AS name`;
  const name = rows[0]?.name;
  if (name === undefined) throw new Error("unreachable");
  return name;
});

/**
 * The ids the *configured* database held before a single case ran, and had held for longer than a
 * run lasts.
 *
 * A witness for the isolation, not the isolation itself: the case below asks whether they are all
 * still there, and `sessions` is the table the rebuild case empties. Read before anything runs, so
 * another suite adding rows while this file runs is not this file's harm — only a *deletion* of one
 * of these ids is.
 *
 * Only the settled ones, because a fresh row may be another suite's, in flight, in the same gate:
 * `LinearSync.test.ts` seeds `ses_lws_*` rows into the configured database and deletes them in its
 * `afterAll`, so when this file started while they existed and that suite finished first, the case
 * below read them as this suite's deletions (LOB-237; red under the gate's parallel load, green on
 * the rerun). An hour is the same age the sweep above grants a run before it calls it abandoned,
 * and it is read on the database's own clock, which is the one that wrote `created_at`.
 */
const settledSessionIds = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const table = yield* sql<{ present: string | null }>`
    SELECT to_regclass('public.sessions')::text AS present
  `;
  if (table[0]?.present === null) return [];
  const rows = yield* sql<{ id: string }>`
    SELECT id FROM sessions
    WHERE created_at < now() - make_interval(secs => ${STALE_RUN_AFTER_MS / 1000})
    ORDER BY id
  `;
  return rows.map((row) => row.id);
});

const configuredSessionIdsAtStart = await maintenance.runPromise(
  settledSessionIds.pipe(Effect.orDie),
);

afterAll(async () => {
  // The run's own pool holds connections to the database being dropped, so it goes first.
  await runtime.dispose();
  // Undo the reassignment rather than leave it: harmless while this package holds one test file,
  // and a trap for the second one, which would inherit a `DATABASE_URL` naming a database that no
  // longer exists. The literal is `configuredUrl` again, not `undefined` — deleting the key would
  // make `DatabaseConfig` fall back to a *different* database than the one this file ran against.
  // oxlint-disable-next-line effecttsgo/process-env -- a test harness sets up its own process.
  process.env["DATABASE_URL"] = configuredUrl;
  await maintenance.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      yield* sql`DROP DATABASE ${sql(runDatabaseName)} WITH (FORCE)`;
    }).pipe(Effect.orDie),
  );
  await maintenance.dispose();
});

/** Count the SQL statements an effect issues, without changing what it does. */
const countStatements = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const count = yield* Ref.make(0);
    const value = yield* effect.pipe(
      Effect.provide(
        Layer.succeed(
          Statement.CurrentTransformer,
          (self: Statement.Statement<unknown>) =>
            Ref.update(count, (n) => n + 1).pipe(Effect.as(self)),
        ),
      ),
    );
    return { value, statements: yield* Ref.get(count) };
  });

/** Poll until `check`, so a test never depends on a fixed delay. */
const waitUntil = <E, R>(
  check: Effect.Effect<boolean, E, R>,
  label: string,
): Effect.Effect<void, E, R> =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (yield* check) return;
      yield* Effect.sleep(50);
    }
    return yield* Effect.die(new Error(`timed out waiting for ${label}`));
  });

describe("SessionService", () => {
  it("creates, drives, streams, and folds the same session", async () => {
    const session = await program(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const created = yield* sessions.create({ title: "probing" });
        expect(created.title).toBe("probing");
        expect(created.mode).toBe("live");
        expect(created.status).toBe("idle");
        expect(created.id).toMatch(/^ses_[0-9abcdefghjkmnpqrstvwxyz]{26}$/);

        // Send admits the message durably and returns; the answer arrives later, which is what
        // the stream is for. Wait for the run to settle before reading the transcript.
        const sent = yield* sessions.send({
          sessionId: created.id,
          content: "hello",
        });
        expect(sent.placement).toBe("run");
        expect(sent.submissionId).toEqual(expect.any(String));
        yield* waitUntil(
          sessions
            .get(created.id)
            .pipe(Effect.map((snapshot) => !snapshot.live.busy)),
          "the first turn to settle",
        );

        const live = yield* sessions.get(created.id);
        expect(live.session.mode).toBe("live");
        // A session that started no durable task reports an empty live-task list (LOB-183): the
        // field is present on every snapshot, so a client never has to tell "none" from "not sent".
        expect(live.tasks).toEqual([]);
        expect(live.entries.map((entry) => entry.kind)).toEqual([
          "title",
          "user",
          "system",
          "assistant",
          "toolResult",
          "assistant",
        ]);
        expect(
          live.entries.find((entry) => entry.kind === "toolResult")?.toolName,
        ).toBe("bash");
        // The title is in the log, not only in the index, so a rebuild can recover it.
        expect(live.entries[0]?.kind).toBe("title");
        expect(live.entries.at(-1)?.text).toBe("faux-ok (re: hello)");
        // The faux provider reports token usage, so spend survives the projection.
        expect(live.usage.models[0]?.usage.totalTokens).toBeGreaterThan(0);
        // The list shows cost per session, and the number it shows is the snapshot's ledger added
        // up (LOB-153): both buckets, through the one helper the rebuild fold also uses. It is 0
        // here — neither the faux model nor a built-in tool charges — so the arithmetic with a
        // non-zero tool bucket is pinned in the harness's `projection.test.ts`, and that a tool's
        // bucket reaches a real log is pinned in `session.test.ts`.
        const listed = (yield* sessions.list({ limit: 100 })).sessions.find(
          (entry) => entry.id === created.id,
        );
        expect(listed?.costTotal).toBe(usageCostTotal(live.usage));

        return { id: created.id, entries: live.entries };
      }),
    );

    // A client that attaches while the session is live: one snapshot, then the entries of the
    // next turn as they commit.
    const streamed = await program(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const collected = yield* Ref.make<readonly SessionEvent[]>([]);
        const fiber = yield* sessions.events(session.id).pipe(
          Stream.tap((event) =>
            Ref.update(collected, (all) => [...all, event]),
          ),
          Stream.runDrain,
          Effect.forkChild,
        );

        yield* waitUntil(
          Ref.get(collected).pipe(
            Effect.map((all) => all.some((e) => e._tag === "snapshot")),
          ),
          "the attached snapshot",
        );
        const second = yield* sessions.send({
          sessionId: session.id,
          content: "again",
        });
        expect(second.placement).toBe("run");
        yield* waitUntil(
          sessions
            .get(session.id)
            .pipe(Effect.map((snapshot) => !snapshot.live.busy)),
          "the second turn to settle",
        );
        yield* waitUntil(
          Ref.get(collected).pipe(
            Effect.map(
              (all) =>
                all.some((event) => event._tag === "entry") &&
                all.some((event) => event._tag === "status"),
            ),
          ),
          "entries and status from the second turn",
        );
        yield* Fiber.interrupt(fiber);

        const all = yield* Ref.get(collected);
        const snapshot = all[0];
        expect(snapshot?._tag).toBe("snapshot");
        if (snapshot?._tag !== "snapshot") throw new Error("unreachable");
        expect(snapshot.session.mode).toBe("live");
        expect(snapshot.entries).toEqual(session.entries);
        // A run goes busy and comes back to idle within one turn.
        expect(
          all.flatMap((event) =>
            event._tag === "status" ? [event.status] : [],
          ),
        ).toContain("busy");
        return all;
      }),
    );
    expect(streamed.length).toBeGreaterThan(2);

    // Release the owner. The session is now what D8 calls historical: nobody in this process
    // holds it, so the same read is served by folding the log.
    await program(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        yield* sessions.close;
      }),
    );

    const folded = await program(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const snapshot = yield* sessions.get(session.id);
        expect(snapshot.session.mode).toBe("historical");
        expect(snapshot.session.status).toBe("idle");
        expect(snapshot.live).toEqual({ busy: false, tools: [] });

        // The fold agrees with the live read it replaced, entry for entry.
        const liveEntries = session.entries;
        expect(snapshot.entries.slice(0, liveEntries.length)).toEqual(
          liveEntries,
        );

        // A historical session's stream is one snapshot and then it ends: complete, not dropped.
        const events = Array.from(
          yield* sessions.events(session.id).pipe(Stream.runCollect),
        );
        expect(events.map((event) => event._tag)).toEqual(["snapshot"]);
        const only = events[0];
        if (only?._tag !== "snapshot") throw new Error("unreachable");
        expect(only.session.mode).toBe("historical");

        // Steering wakes it: sending again reopens the owner and continues the same conversation.
        const resumed = yield* sessions.send({
          sessionId: session.id,
          content: "third",
        });
        expect(resumed.placement).toBe("run");
        yield* waitUntil(
          sessions
            .get(session.id)
            .pipe(Effect.map((snapshot) => !snapshot.live.busy)),
          "the third turn to settle",
        );
        const after = yield* sessions.get(session.id);
        expect(after.session.mode).toBe("live");
        expect(after.entries.length).toBeGreaterThan(snapshot.entries.length);
        return after;
      }),
    );

    expect(folded.entries.at(-1)?.text).toBe("faux-ok (re: third)");

    // This case ends with the session owned again — the third turn reopened it — and an owned
    // session keeps a projector running that rewrites its own `session_activity.last_activity_at`
    // to "now" on every live event (`recordActivity` → `touch` / `setActivityStatus`). Left open,
    // that projector writes to `session_activity` while every case below pages over the whole
    // table, and a row whose key moves mid-walk is one no walk can return: it has left the range
    // below the cursor. The list cases account for that skip, so it would not turn the gate red —
    // but the write is this case's, and the file has no business leaving a background writer
    // running for the twenty cases after it. Closing releases the owner and ends the fiber too.
    //
    // Mutation checked: deleting this `sessions.close`, which leaves the projector running. The
    // assertion below goes red on `expect(released.session.mode).toBe("historical")` — and nothing
    // else in the file notices, because a skip the helper can explain is silent by design.
    await program(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        yield* sessions.close;
      }),
    );
    const released = await program(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        return yield* sessions.get(session.id);
      }),
    );
    expect(released.session.mode).toBe("historical");
  }, 120_000);

  it("reports an unknown session as not_found", async () => {
    const outcome = await program(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        return yield* Effect.exit(
          sessions.get("ses_00000000000000000000000000" as SessionId),
        );
      }),
    );
    expect(Exit.isFailure(outcome)).toBe(true);
    if (Exit.isSuccess(outcome)) throw new Error("unreachable");
    const failure = Exit.findErrorOption(outcome);
    expect(failure._tag).toBe("Some");
    if (failure._tag !== "Some") throw new Error("unreachable");
    expect(failure.value.code).toBe("not_found");
  });

  it("defaults the title from the first message", async () => {
    const titled = await program(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const created = yield* sessions.create();
        expect(created.title).toBe("");
        const sent = yield* sessions.send({
          sessionId: created.id,
          content: "fix the flaky login test\nand then run the suite",
        });
        return sent.session.title;
      }),
    );
    expect(titled).toBe("fix the flaky login test");
  });
});

/**
 * Forking a session at one of its entries (LOB-180).
 *
 * A session is a log (D7), so every claim here is about two logs: the fork keeps the parent's
 * entries through the fork point and nothing after it, and a message admitted to either one lands
 * in that one only. The parent is deliberately left owned while the fork is taken — that is the
 * interesting case, because the fork reads a log another owner is writing.
 */
describe("fork", () => {
  it("forks at the last entry and the two transcripts diverge", async () => {
    const result = await program(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const parent = yield* sessions.create({ title: "forking" });
        yield* sessions.send({ sessionId: parent.id, content: "hello" });
        yield* waitUntil(
          sessions.get(parent.id).pipe(Effect.map((s) => !s.live.busy)),
          "the parent's first turn to settle",
        );
        const before = yield* sessions.get(parent.id);

        const fork = yield* sessions.fork({ sessionId: parent.id });
        const forked = yield* sessions.get(fork.id);

        // The fork's own turn: it must not reach the parent's transcript.
        yield* sessions.send({ sessionId: fork.id, content: "fork only" });
        yield* waitUntil(
          sessions.get(fork.id).pipe(Effect.map((s) => !s.live.busy)),
          "the fork's turn to settle",
        );
        const diverged = yield* sessions.get(fork.id);
        const parentAfter = yield* sessions.get(parent.id);

        return {
          parent: parent.id,
          before,
          fork,
          forked,
          diverged,
          parentAfter,
        };
      }),
    );

    expect(result.fork.id).not.toBe(result.parent);
    expect(result.fork.forkedFrom).toBe(result.parent);
    expect(result.fork.mode).toBe("live");
    expect(result.fork.title).toBe("forking");

    // The fork's transcript starts as the parent's, text for text and kind for kind.
    expect(
      result.forked.entries.map((entry) => [entry.kind, entry.text]),
    ).toEqual(result.before.entries.map((entry) => [entry.kind, entry.text]));
    expect(result.forked.session.forkedFrom).toBe(result.parent);

    // Both transcripts grow, and neither carries the other's message.
    expect(result.diverged.entries.length).toBeGreaterThan(
      result.forked.entries.length,
    );
    expect(
      result.diverged.entries.some((entry) => entry.text.includes("fork only")),
    ).toBe(true);
    expect(
      result.parentAfter.entries.map((entry) => [entry.kind, entry.text]),
    ).toEqual(result.before.entries.map((entry) => [entry.kind, entry.text]));

    await program(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        yield* sessions.close;
      }),
    );
  }, 120_000);

  it("forks at a named entry, so the fork ends where the parent had not", async () => {
    const result = await program(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const parent = yield* sessions.create({ title: "at an entry" });
        yield* sessions.send({ sessionId: parent.id, content: "first" });
        yield* waitUntil(
          sessions.get(parent.id).pipe(Effect.map((s) => !s.live.busy)),
          "the first turn to settle",
        );
        const before = yield* sessions.get(parent.id);
        // An entry in the middle of the transcript, not its last one.
        const at = before.entries[1];
        if (at === undefined) throw new Error("unreachable");
        const fork = yield* sessions.fork({ sessionId: parent.id, at: at.id });
        const forked = yield* sessions.get(fork.id);
        return { before, forked };
      }),
    );

    expect(
      result.forked.entries.map((entry) => [entry.kind, entry.text]),
    ).toEqual(
      result.before.entries
        .slice(0, 2)
        .map((entry) => [entry.kind, entry.text]),
    );

    await program(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        yield* sessions.close;
      }),
    );
  }, 120_000);

  it("refuses an entry id that belongs to another session", async () => {
    const result = await program(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const sql = yield* SqlClient;
        const parent = yield* sessions.create({ title: "forking" });
        yield* sessions.send({ sessionId: parent.id, content: "hello" });
        yield* waitUntil(
          sessions.get(parent.id).pipe(Effect.map((s) => !s.live.busy)),
          "the turn to settle",
        );
        // Deliberately longer than the parent: entry ids are per-log numbers, so an id from another
        // session that happened to name an entry here would *be* this session's entry, and there is
        // nothing else it could mean (the case below pins that). What a foreign id can be is
        // absent, and that is what this case drives.
        const elsewhere = yield* sessions.create({ title: "elsewhere" });
        for (const content of ["other", "and another"]) {
          yield* sessions.send({ sessionId: elsewhere.id, content });
          yield* waitUntil(
            sessions.get(elsewhere.id).pipe(Effect.map((s) => !s.live.busy)),
            "the other turn to settle",
          );
        }
        const other = yield* sessions.get(elsewhere.id);
        const own = yield* sessions.get(parent.id);
        const foreign = other.entries.at(-1);
        if (foreign === undefined) throw new Error("unreachable");
        // The premise, checked rather than assumed: this id names no entry of the parent.
        expect(own.entries.map((entry) => entry.id)).not.toContain(foreign.id);
        const outcome = yield* Effect.exit(
          sessions.fork({ sessionId: parent.id, at: foreign.id }),
        );
        // A refused fork leaves no index row behind: the row is written before the log, so the
        // failure path has to take it back (an orphan row is invisible to the list and would wait
        // for a rebuild).
        const strays = yield* sql<{ id: string }>`
          SELECT id FROM sessions WHERE forked_from = ${parent.id}
        `;
        return { outcome, strays };
      }),
    );

    expect(result.strays).toEqual([]);
    const { outcome } = result;
    expect(Exit.isFailure(outcome)).toBe(true);
    if (Exit.isSuccess(outcome)) throw new Error("unreachable");
    const failure = Exit.findErrorOption(outcome);
    expect(failure._tag).toBe("Some");
    if (failure._tag !== "Some") throw new Error("unreachable");
    expect(failure.value._tag).toBe("SessionError");
    expect(failure.value.code).toBe("invalid_input");

    await program(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        yield* sessions.close;
      }),
    );
  }, 120_000);

  it("takes this session's entry when a foreign session used the same number", async () => {
    const result = await program(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const parent = yield* sessions.create({ title: "numbers" });
        yield* sessions.send({ sessionId: parent.id, content: "hello" });
        yield* waitUntil(
          sessions.get(parent.id).pipe(Effect.map((s) => !s.live.busy)),
          "the turn to settle",
        );
        const elsewhere = yield* sessions.create({ title: "elsewhere" });
        yield* sessions.send({ sessionId: elsewhere.id, content: "other" });
        yield* waitUntil(
          sessions.get(elsewhere.id).pipe(Effect.map((s) => !s.live.busy)),
          "the other turn to settle",
        );
        const own = yield* sessions.get(parent.id);
        const other = yield* sessions.get(elsewhere.id);
        // Ids are minted per log, so `1` is an entry of both sessions. Forking this one at that
        // number means this one's entry: there is no other thing it could name.
        const shared = other.entries[1];
        if (shared === undefined) throw new Error("unreachable");
        expect(own.entries.map((entry) => entry.id)).toContain(shared.id);
        const fork = yield* sessions.fork({
          sessionId: parent.id,
          at: shared.id,
        });
        const forked = yield* sessions.get(fork.id);
        return { own, forked };
      }),
    );

    expect(
      result.forked.entries.map((entry) => [entry.kind, entry.text]),
    ).toEqual(
      result.own.entries.slice(0, 2).map((entry) => [entry.kind, entry.text]),
    );

    await program(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        yield* sessions.close;
      }),
    );
  }, 120_000);

  it("keeps the lineage in the fork's log, so a rebuild recovers it", async () => {
    const result = await program(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const sql = yield* SqlClient;
        const parent = yield* sessions.create({ title: "lineage" });
        const fork = yield* sessions.fork({ sessionId: parent.id });
        yield* sessions.close;
        // The index is a cache: wiping the column must not lose who the fork came from, because
        // the fork's log carries its own `factory.fork` document (D7).
        yield* sql`UPDATE sessions SET forked_from = NULL WHERE id = ${fork.id}`;
        const blanked = yield* sessions.get(fork.id);
        const report = yield* rebuildIndexes;
        const refolded = yield* sessions.get(fork.id);
        return { parent: parent.id, fork: fork.id, blanked, report, refolded };
      }),
    );

    expect(result.blanked.session.forkedFrom).toBeUndefined();
    expect(result.report.sessions).toBeGreaterThan(0);
    expect(result.refolded.session.forkedFrom).toBe(result.parent);
  }, 120_000);

  /**
   * The list is where the operator sees lineage (LOB-182): one page names the fork's parent and
   * leaves the parent's own row alone. The field comes from the index row, not from the session's
   * log, so the same case checks both halves of that claim — a blanked row loses the lineage and a
   * rebuild puts it back, which is what makes the list's cost one query rather than a fold (R6).
   */
  it("shows the lineage on the fork's list row and only there", async () => {
    const result = await program(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const sql = yield* SqlClient;
        const parent = yield* sessions.create({ title: "lineage list" });
        const fork = yield* sessions.fork({ sessionId: parent.id });
        const find = (entries: readonly SessionListEntry[], id: string) =>
          entries.find((entry) => entry.id === id);
        const listed = (yield* sessions.list({ limit: 100 })).sessions;
        // The index is a cache: blanking the column must remove the lineage from the list, or the
        // field is being served from somewhere a rebuild would disagree with.
        yield* sql`UPDATE sessions SET forked_from = NULL WHERE id = ${fork.id}`;
        const blanked = (yield* sessions.list({ limit: 100 })).sessions;
        yield* rebuildIndexes;
        const refolded = (yield* sessions.list({ limit: 100 })).sessions;
        return {
          parent: parent.id,
          fork: fork.id,
          parentRow: find(listed, parent.id),
          forkRow: find(listed, fork.id),
          blankedRow: find(blanked, fork.id),
          refoldedRow: find(refolded, fork.id),
        };
      }),
    );

    expect(result.parentRow?.forkedFrom).toBeUndefined();
    expect(result.forkRow?.forkedFrom).toBe(result.parent);
    expect(result.blankedRow?.forkedFrom).toBeUndefined();
    expect(result.refoldedRow?.forkedFrom).toBe(result.parent);
  }, 120_000);

  /**
   * Lineage is a display field, so a broken index value must not fail the page (LOB-182). A row
   * whose `forked_from` is not a session id is a corrupted index, not a session the list cannot
   * name: the row still renders, without lineage, and `rebuildIndexes` is what repairs the column.
   */
  it("drops a malformed lineage instead of failing the list", async () => {
    const result = await program(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const sql = yield* SqlClient;
        const parent = yield* sessions.create({ title: "malformed lineage" });
        const fork = yield* sessions.fork({ sessionId: parent.id });
        yield* sql`UPDATE sessions SET forked_from = ${"not a session id"} WHERE id = ${fork.id}`;
        const listed = (yield* sessions.list({ limit: 100 })).sessions;
        const row = listed.find((entry) => entry.id === fork.id);
        const report = yield* rebuildIndexes;
        const refolded = (yield* sessions.list({ limit: 100 })).sessions.find(
          (entry) => entry.id === fork.id,
        );
        return { parent: parent.id, row, report, refolded };
      }),
    );

    expect(result.row).toBeDefined();
    expect(result.row?.forkedFrom).toBeUndefined();
    expect(result.report.sessions).toBeGreaterThan(0);
    expect(result.refolded?.forkedFrom).toBe(result.parent);
  }, 120_000);
});

/**
 * Replaying a recorded session on another model (LOB-198).
 *
 * A replay is the same task in a new session, so these claims are one-directional: exactly one new
 * session exists afterwards, its first user entry is the source's, its model is not — and the source
 * is the log it was, down to its commit count and head. That last part is what makes "replay a
 * recorded run" not a rewrite of it, so it is asserted against `commits` rather than against a
 * projection that could agree with itself.
 */
describe("replay", () => {
  /** One log as the database holds it: how many commits, and the newest sequence number. */
  const logState = (logId: string) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const rows = yield* sql<{ commits: number; head: string | null }>`
        SELECT count(*)::int AS commits, max(seq)::text AS head
        FROM commits WHERE log_id = ${logId}
      `;
      return rows[0] ?? { commits: 0, head: null };
    });

  /** How many sessions the index holds, which is what a refusal must not add to. */
  const sessionCount = Effect.gen(function* () {
    const sql = yield* SqlClient;
    const rows = yield* sql<{ rows: number }>`
      SELECT count(*)::int AS rows FROM sessions
    `;
    return rows[0]?.rows ?? 0;
  });

  /** The `SessionError` code a refused call failed with, or `"ok"` when it succeeded. */
  const refusalCode = (exit: Exit.Exit<unknown, SessionError>): string => {
    if (exit._tag !== "Failure") return "ok";
    const failure = Exit.findErrorOption(exit);
    return failure._tag === "Some" ? failure.value.code : "defect";
  };

  it("replays the prompt on another model and leaves the source log untouched", async () => {
    const result = await program(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const sql = yield* SqlClient;
        const source = yield* sessions.create({
          title: "replaying",
          repo: factoryRepo,
        });
        yield* sessions.send({
          sessionId: source.id,
          content: "fix the flaky login test",
        });
        yield* waitUntil(
          sessions.get(source.id).pipe(Effect.map((s) => !s.live.busy)),
          "the source's turn to settle",
        );
        const before = yield* sessions.get(source.id);
        const sourceLog = yield* logState(source.id);
        const countBefore = yield* sessionCount;

        const replay = yield* sessions.replay({
          sessionId: source.id,
          model: "faux/faux-2",
        });
        yield* waitUntil(
          sessions.get(replay.id).pipe(Effect.map((s) => !s.live.busy)),
          "the replay's turn to settle",
        );
        const replayed = yield* sessions.get(replay.id);
        const sourceAfter = yield* sessions.get(source.id);
        const sourceLogAfter = yield* logState(source.id);
        const countAfter = yield* sessionCount;

        // Release the owners, then read the replay's log the way a rebuild does: the link has to
        // be in the log, not only in this call's answer (D7).
        yield* sessions.close;
        const storage = yield* Effect.promise(() =>
          PostgresStorage.reader(sql, replay.id),
        );
        const log = yield* readSessionLog(storage).pipe(
          Effect.ensuring(Effect.promise(() => storage.dispose())),
        );
        const folded = yield* sessions.get(replay.id);

        return {
          source: source.id,
          replay,
          before,
          replayed,
          sourceAfter,
          sourceLog,
          sourceLogAfter,
          countBefore,
          countAfter,
          log,
          folded,
        };
      }),
    );

    // One new session, and it is the replay.
    expect(result.replay.id).not.toBe(result.source);
    expect(result.countAfter).toBe(result.countBefore + 1);
    expect(result.replay.mode).toBe("live");
    // The source's task, run again: its first user entry is the replay's, text for text.
    const firstUser = (snapshot: {
      entries: readonly { kind: string; text: string }[];
    }) => snapshot.entries.find((entry) => entry.kind === "user")?.text;
    expect(firstUser(result.before)).toBe("fix the flaky login test");
    expect(firstUser(result.replayed)).toBe(firstUser(result.before));
    // ... on a different model, which the spend the log records is keyed by.
    expect(result.before.usage.models.map((model) => model.key)).toEqual([
      "faux/faux-1",
    ]);
    expect(result.replayed.usage.models.map((model) => model.key)).toEqual([
      "faux/faux-2",
    ]);

    // The source is unchanged: same entries after as before, same commit count, same head.
    expect(result.sourceAfter.entries).toEqual(result.before.entries);
    expect(result.sourceLog.commits).toBeGreaterThan(0);
    expect(result.sourceLogAfter).toEqual(result.sourceLog);

    // The replay's own log carries the link between both sessions and both models.
    expect(result.log.replay).toEqual({
      source: result.source,
      model: "faux/faux-2",
      from: "faux/faux-1",
    });
    // The repo binding and the title are the replay's own committed facts, so a fold has them.
    expect(result.log.binding).toEqual({ repo: factoryRepo, baseRef: "main" });
    expect(
      result.log.entries.some(
        (entry) => entry.kind === "title" && entry.text === "replaying",
      ),
    ).toBe(true);
    // And a session nobody owns reads the same transcript.
    expect(result.folded.session.mode).toBe("historical");
    expect(result.folded.entries).toEqual(result.replayed.entries);
  }, 120_000);

  it("refuses an unknown session, a session with no repo, and a model it does not serve", async () => {
    const result = await program(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const scratch = yield* sessions.create({
          title: "no repo to replay into",
        });
        yield* sessions.send({ sessionId: scratch.id, content: "hello" });
        yield* waitUntil(
          sessions.get(scratch.id).pipe(Effect.map((s) => !s.live.busy)),
          "the scratch turn to settle",
        );
        const countBefore = yield* sessionCount;
        const noRepo = yield* Effect.exit(
          sessions.replay({ sessionId: scratch.id }),
        );
        const unknown = yield* Effect.exit(
          sessions.replay({
            sessionId: SessionIdSchema.make(`ses_${"0".repeat(26)}`),
          }),
        );
        const noModel = yield* Effect.exit(
          sessions.replay({ sessionId: scratch.id, model: "faux/faux-9" }),
        );
        const countAfter = yield* sessionCount;
        return { noRepo, unknown, noModel, countBefore, countAfter };
      }),
    );

    // A refusal is typed, and a refused replay leaves no session behind.
    expect(refusalCode(result.noRepo)).toBe("invalid_input");
    expect(refusalCode(result.unknown)).toBe("not_found");
    expect(refusalCode(result.noModel)).toBe("invalid_input");
    expect(result.countAfter).toBe(result.countBefore);
  }, 120_000);
});

/**
 * Reset (LOB-181): a new model context, opened with the handoff note, over the same transcript.
 *
 * What the service owes: the entry is in the log (not in this process), the transcript keeps the
 * turns before it, and a released session folds to the same thing the live read showed. The model
 * context itself is read at the harness boundary, where a `ContextView` is available
 * (`packages/harness/src/session.test.ts`); this is the contract the RPC surface serves.
 */
describe("reset", () => {
  it("keeps the transcript, marks the boundary, and folds to the same entries", async () => {
    const { resetSummary, before, live, folded } = await program(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const created = yield* sessions.create({ title: "resetting" });
        yield* sessions.send({
          sessionId: created.id,
          content: "the turn the reset ends",
        });
        yield* waitUntil(
          sessions
            .get(created.id)
            .pipe(Effect.map((snapshot) => !snapshot.live.busy)),
          "the turn before the reset to settle",
        );
        const before = yield* sessions.get(created.id);

        const resetSummary = yield* sessions.reset({
          sessionId: created.id,
          handoff: "we were fixing the flaky login test",
        });
        const live = yield* sessions.get(created.id);

        // Release the owner, so the second read is D8's historical path — the fold.
        yield* sessions.close;
        const folded = yield* sessions.get(created.id);
        return { resetSummary, before, live, folded };
      }),
    );

    expect(resetSummary.id).toBe(live.session.id);
    expect(resetSummary.status).toBe("idle");
    // The title is untouched: a reset clears the context, not the session.
    expect(live.session.title).toBe("resetting");

    const resetEntry = live.entries.find((entry) => entry.kind === "reset");
    expect(resetEntry?.text).toBe("we were fixing the flaky login test");
    expect(live.entries.length).toBe(before.entries.length + 1);
    expect(live.entries.slice(0, before.entries.length)).toEqual(
      before.entries,
    );

    // D8: the fold is a different read path and must not disagree, history included.
    expect(folded.session.mode).toBe("historical");
    expect(folded.entries).toEqual(live.entries);
  });

  it("resets to an entry with no text for a missing or blank handoff", async () => {
    const entries = await program(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const created = yield* sessions.create({ title: "bare reset" });
        yield* sessions.reset({ sessionId: created.id });
        // A whitespace-only note is no note: a context that opens with a blank message is worse
        // than one that opens with nothing, and the service is where that is decided.
        yield* sessions.reset({ sessionId: created.id, handoff: "   \n " });
        const snapshot = yield* sessions.get(created.id);
        yield* sessions.close;
        return snapshot.entries;
      }),
    );

    const resets = entries.filter((entry) => entry.kind === "reset");
    expect(resets).toHaveLength(2);
    expect(resets.map((entry) => entry.text)).toEqual(["", ""]);
  });
});

/**
 * B4's manual half (LOB-185): `compact` admits a compaction task, answers its id, and the summary
 * the task writes is a transcript entry — one the fold agrees with, so a released session shows it
 * too. The model context itself (that the next request starts at the summary) is the harness's
 * contract and is read there (`packages/harness/src/session.test.ts`).
 *
 * The message is long on purpose: Pi Durable summarizes an *old prefix* and keeps the newest
 * `keepRecentTokens` verbatim, so a transcript shorter than that tail has nothing to compact and
 * the task completes without a summary. 90k characters is ~22.5k tokens, past the 20k tail this
 * window's policy keeps.
 */
describe("compact", () => {
  it("admits a compaction task and lands its summary in the transcript", async () => {
    const { result, before, live, folded } = await program(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const created = yield* sessions.create({ title: "compacting" });
        yield* sessions.send({
          sessionId: created.id,
          content: "z".repeat(90_000),
        });
        yield* waitUntil(
          sessions
            .get(created.id)
            .pipe(Effect.map((snapshot) => !snapshot.live.busy)),
          "the turn before the compaction to settle",
        );
        const before = yield* sessions.get(created.id);

        const result = yield* sessions.compact({
          sessionId: created.id,
          instructions: "  focus on the long message  ",
        });
        // The task settles in the background, so the entry is what to wait for — not `busy`,
        // which a compaction never sets (it is not a run).
        yield* waitUntil(
          sessions
            .get(created.id)
            .pipe(
              Effect.map((snapshot) =>
                snapshot.entries.some((entry) => entry.kind === "compaction"),
              ),
            ),
          "the compaction's summary entry",
        );
        const live = yield* sessions.get(created.id);

        // Release the owner, so the second read is D8's historical path — the fold.
        yield* sessions.close;
        const folded = yield* sessions.get(created.id);
        return { result, before, live, folded };
      }),
    );

    // The call answers the task's id and the session it belongs to; the work is the task's.
    expect(result.taskId.length).toBeGreaterThan(0);
    expect(result.session.id).toBe(live.session.id);
    // A compaction is not a run: the session is idle before it, while it works, and after it.
    expect(result.session.status).toBe("idle");

    const summaries = live.entries.filter(
      (entry) => entry.kind === "compaction",
    );
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.text.length).toBeGreaterThan(0);
    // Nothing is dropped: the turns the summary stands in for are still readable above it.
    expect(live.entries.slice(0, before.entries.length)).toEqual(
      before.entries,
    );

    // D8: the fold is a different read path and must not disagree, summary included.
    expect(folded.session.mode).toBe("historical");
    expect(folded.entries).toEqual(live.entries);
  }, 120_000);
});

describe("repo binding", () => {
  it("binds a session to a repo and resolves its workspace from the repo's config", async () => {
    const result = await program(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const registered = yield* sessions.registerRepo({
          repo: factoryRepo,
          url: "https://github.com/lobiklukas/factory.git",
          localPath: repoRoot,
        });
        const created = yield* sessions.create({
          repo: factoryRepo,
          baseRef: "main",
        });
        const snapshot = yield* sessions.get(created.id);
        return { registered, created, snapshot };
      }),
    );

    expect(result.registered.url).toBe(
      "https://github.com/lobiklukas/factory.git",
    );
    // A summary carries the binding, without a fold: that is what every client reads.
    expect(result.created.repo).toBe("lobiklukas/factory");
    expect(result.created.baseRef).toBe("main");
    // The workspace is the session's own directory, scoped by the repo, with the repo's commands.
    expect(result.snapshot.session.repo).toBe("lobiklukas/factory");
    expect(result.snapshot.workspace.path).toContain(
      join("lobiklukas", "factory"),
    );
    expect(result.snapshot.workspace.commandsSource).toBe("repo");
    expect(result.snapshot.workspace.commands.test).toBe("bun run test");
    expect(result.snapshot.workspace.commands.verify).toBe(
      "bun .pi/skills/verify-api/drive.ts",
    );
  });

  it("opens a repo whose default base ref it registers on first use", async () => {
    const result = await program(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        // No registerRepo: naming a repo is enough to create a session against it.
        const created = yield* sessions.create({ repo: factoryRepo });
        return created;
      }),
    );
    expect(result.repo).toBe("lobiklukas/factory");
    expect(result.baseRef).toBe("main");
  });

  it("opens a repo that declares no config", async () => {
    const result = await program(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        yield* sessions.registerRepo({
          repo: RepoSlugSchema.make("lobiklukas/configless"),
          defaultBaseRef: "trunk",
          localPath: emptyRepoRoot,
        });
        const created = yield* sessions.create({
          repo: RepoSlugSchema.make("lobiklukas/configless"),
        });
        return yield* sessions.get(created.id);
      }),
    );
    // The default ref comes from the registry; the absent config is a fact, not an error.
    expect(result.workspace.baseRef).toBe("trunk");
    expect(result.workspace.commandsSource).toBe("none");
    expect(result.workspace.commands).toEqual({});
  });
});

/**
 * The GitHub PR endpoint behind an `HttpClient.make` fake: the same shape `pr.test.ts` uses, so the
 * whole step is driven with no network and no credential, per the GitHub row in
 * `docs/testing-third-parties.md`. Every request is recorded, which is how "exactly one POST" is
 * asserted rather than inferred.
 */
/**
 * A case's PR, `{number, url}` with `url` the page, as GitHub's REST API answers it: `url` is the
 * API resource and `html_url` the page (LOB-15). The client must read `html_url`, so a fake that
 * answered the page as `url` would hide a client that recorded the API resource.
 */
const asGitHubAnswer = (body: unknown): unknown => {
  if (Array.isArray(body)) return body.map(asGitHubAnswer);
  if (typeof body !== "object" || body === null) return body;
  const pr = body as Record<string, unknown>;
  if (typeof pr["number"] !== "number" || typeof pr["url"] !== "string") {
    return body;
  }
  const page = new URL(pr["url"]);
  return {
    ...pr,
    url: `https://api.github.com/repos${page.pathname.replace("/pull/", "/pulls/")}`,
    html_url: pr["url"],
  };
};

const makeGithubFake = (status: number, body: unknown, delayMs = 0) => {
  /**
   * What GitHub was asked. The request body is kept because the PR body is one of the things a case
   * asserts (LOB-228 lists the branch's changed paths); a client that sent the right count and the
   * wrong body would pass a case that only counted.
   */
  const requests: Array<{
    readonly method: string;
    readonly url: string;
    readonly body: unknown;
  }> = [];
  const Json = Schema.fromJsonString(Schema.Unknown);
  const layer = Layer.merge(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request, url) =>
        Effect.gen(function* () {
          const sent =
            request.body._tag === "Uint8Array"
              ? yield* Schema.decodeEffect(Json)(
                  new TextDecoder().decode(request.body.body),
                )
              : undefined;
          requests.push({
            method: request.method,
            url: url.pathname,
            body: sent,
          });
          // A slow answer is how a case can hold a step inside GitHub's call, which is the window a
          // second caller would otherwise slip through.
          if (delayMs > 0) yield* Effect.sleep(delayMs);
          const text = yield* Schema.encodeEffect(Json)(
            asGitHubAnswer(body),
          ).pipe(Effect.orDie);
          const response = new Response(text, {
            status,
            headers: { "content-type": "application/json" },
          });
          return HttpClientResponse.fromWeb(request, response);
        }).pipe(Effect.orDie),
      ),
    ),
    Layer.succeed(
      CredentialProvider,
      staticTokenProvider(Option.some(Redacted.make("tok"))),
    ),
  );
  return { requests, layer };
};

/**
 * An answer that opened or replayed a PR, or a failure naming the answer that opened none.
 *
 * The step's answer is a union since LOB-227 (and gained its third member in LOB-196), so a case that
 * expects a link has to say what it expects when there is none: narrowing on the two outcomes that
 * carry one is what makes a refusal in an ordinary PR case read as the refusal it is rather than as a
 * missing field, and a fourth outcome would fail to compile here instead of passing silently.
 */
const opened = (answer: PullRequestStep): OpenedPullRequest => {
  if (answer.outcome === "opened" || answer.outcome === "already-open") {
    return answer;
  }
  throw new Error(`the step opened no PR: ${JSON.stringify(answer)}`);
};

/**
 * A session bound to `repoRoot` with one file committed on its own branch.
 *
 * Since LOB-196 a PR needs a diff: a branch even with its base answers `no-change` and never reaches
 * GitHub, so a case about the *call* has to start from work a PR could carry. Registration is
 * explicit here rather than inherited from whichever case ran first, so these cases do not depend on
 * their order in the file.
 */
const sessionWithDiff = (title: string) =>
  Effect.gen(function* () {
    const sessions = yield* SessionService;
    yield* sessions.registerRepo({
      repo: factoryRepo,
      url: "https://github.com/lobiklukas/factory.git",
      localPath: repoRoot,
    });
    const created = yield* sessions.create({
      repo: factoryRepo,
      baseRef: "main",
      title,
    });
    const snapshot = yield* sessions.get(created.id);
    commitDiff({ worktree: snapshot.workspace.path, files: 1, lines: 1 });
    return { created, worktree: snapshot.workspace.path };
  });

describe("the PR step", () => {
  it("opens exactly one PR, records it in the log and the index, and reports it from both reads", async () => {
    const url = "https://github.com/lobiklukas/factory/pull/7";
    const github = makeGithubFake(201, { number: 7, url });

    const result = await program(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const { created } = yield* sessionWithDiff("open a PR");
        const asked = {
          sessionId: created.id,
          title: "factory: open a PR",
          // The session's own branch, because the cap measures the branch the PR names (LOB-227).
          head: `factory/${created.id}`,
          base: "main",
        };
        const opened = yield* sessions
          .openPullRequest(asked)
          .pipe(Effect.provide(github.layer));
        // Reading the session back must not reach GitHub: the link is the log's and the index's.
        const snapshot = yield* sessions.get(created.id);
        const list = yield* sessions.list({});
        // A step that runs twice is the same PR, and there is no second call to make it so.
        const repeated = yield* sessions
          .openPullRequest(asked)
          .pipe(Effect.provide(github.layer));

        // The window a retry has to close: the document committed, the index row lost. A second
        // call reads the log and writes the row again, without a second GitHub call.
        const sql = yield* SqlClient;
        yield* sql`UPDATE sessions SET pr_url = NULL WHERE id = ${created.id}`;
        const lost = yield* sql<{ prUrl: string | null }>`
          SELECT pr_url FROM sessions WHERE id = ${created.id}
        `;
        yield* sessions
          .openPullRequest(asked)
          .pipe(Effect.provide(github.layer));
        const recovered = yield* sessions.get(created.id);

        return {
          opened,
          repeated,
          lost: lost[0]?.prUrl,
          recovered: recovered.session.prUrl,
          summary: snapshot.session,
          listed: list.sessions.find((row) => row.id === created.id),
        };
      }),
    );

    expect(github.requests).toEqual([
      {
        method: "POST",
        url: "/repos/lobiklukas/factory/pulls",
        body: expect.anything(),
      },
    ]);
    // The first call made the request, so it says so; the retry read the log, so it says that.
    expect(result.opened).toEqual({ number: 7, url, outcome: "opened" });
    expect(result.repeated).toEqual({
      number: 7,
      url,
      outcome: "already-open",
    });
    expect(result.summary.prUrl).toBe(url);
    expect(result.listed?.prUrl).toBe(url);
    // The lost row is restored from the log by a retry, and there is no second PR to show for it.
    expect(result.lost).toBeNull();
    expect(result.recovered).toBe(url);
    // Still one, after three step calls and four reads.
    expect(github.requests).toHaveLength(1);
  }, 120_000);

  it("opens one PR for two overlapping calls, because the step is serialized", async () => {
    const url = "https://github.com/lobiklukas/factory/pull/9";
    // Slow enough that the second caller is inside the first one's window: without the gate both
    // read an empty document and both would post.
    const github = makeGithubFake(201, { number: 9, url }, 100);

    const pair = await program(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const { created } = yield* sessionWithDiff("open a PR twice at once");
        const asked = {
          sessionId: created.id,
          title: "factory: open a PR twice at once",
          head: `factory/${created.id}`,
          base: "main",
        };
        const opened = yield* Effect.all(
          [asked, asked].map((input) =>
            sessions.openPullRequest(input).pipe(Effect.provide(github.layer)),
          ),
          { concurrency: "unbounded" },
        );
        const snapshot = yield* sessions.get(created.id);
        return { opened, prUrl: snapshot.session.prUrl };
      }),
    );

    expect(github.requests).toHaveLength(1);
    // Serialized, so exactly one of the two overlapped calls is the one that opened it.
    expect(pair.opened.map((answer) => answer.outcome).sort()).toEqual([
      "already-open",
      "opened",
    ]);
    expect(
      pair.opened.map((answer) => {
        const { number, url: link } = opened(answer);
        return { number, url: link };
      }),
    ).toEqual([
      { number: 9, url },
      { number: 9, url },
    ]);
    expect(pair.prUrl).toBe(url);
  }, 120_000);

  it("answers a client that reads only {number, url} exactly as it did before the tag", async () => {
    const url = "https://github.com/lobiklukas/factory/pull/13";
    const github = makeGithubFake(201, { number: 13, url });

    const answer = await program(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const { created } = yield* sessionWithDiff(
          "open a PR for a narrow client",
        );
        const asked = {
          sessionId: created.id,
          title: "factory: open a PR for a narrow client",
          head: `factory/${created.id}`,
          base: "main",
        };
        return yield* sessions
          .openPullRequest(asked)
          .pipe(Effect.provide(github.layer));
      }),
    );

    // The tag is additive: a client holding only `PullRequest` still decodes the answer, and it
    // holds only the two fields it knows.
    const narrow = Schema.decodeSync(PullRequest)(opened(answer));
    expect(narrow).toEqual({ number: 13, url });
    expect(github.requests).toHaveLength(1);
  }, 120_000);

  it("opens one PR per session, not one per branch: the guard is the session's own log", async () => {
    const firstUrl = "https://github.com/lobiklukas/factory/pull/11";
    const secondUrl = "https://github.com/lobiklukas/factory/pull/12";
    const onFirst = makeGithubFake(201, { number: 11, url: firstUrl });
    const onSecond = makeGithubFake(201, { number: 12, url: secondUrl });

    const result = await program(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const one = (yield* sessionWithDiff("one session on the branch"))
          .created;
        const two = (yield* sessionWithDiff(
          "a second session on the same branch",
        )).created;
        // The same head and base for both. A guard keyed by the branch would answer the second
        // session with the first one's PR and leave it with no link of its own; the guard is the
        // session's `factory.pr`, so each session opens its PR. The shared head has to be a real
        // ref since LOB-227 — the cap measures `main...head` in the session's worktree, and a
        // branch that is not there is a measurement failure rather than an empty diff — and it has
        // to carry a diff since LOB-196, so it is the first session's own branch: a ref belongs to
        // the repository, so the second session's worktree measures the same committed file.
        const asked = {
          title: "factory: one branch, two sessions",
          head: `factory/${one.id}`,
          base: "main",
        };
        const openedOne = yield* sessions
          .openPullRequest({ ...asked, sessionId: one.id })
          .pipe(Effect.provide(onFirst.layer));
        const openedTwo = yield* sessions
          .openPullRequest({ ...asked, sessionId: two.id })
          .pipe(Effect.provide(onSecond.layer));
        // The retry of the first session is still answered by its log: one session, one call.
        const repeatedOne = yield* sessions
          .openPullRequest({ ...asked, sessionId: one.id })
          .pipe(Effect.provide(onFirst.layer));
        const readOne = yield* sessions.get(one.id);
        const readTwo = yield* sessions.get(two.id);
        return {
          openedOne,
          openedTwo,
          repeatedOne,
          oneUrl: readOne.session.prUrl,
          twoUrl: readTwo.session.prUrl,
        };
      }),
    );

    // The ledger, not the answer: a step that reads the log makes no request to make its answer.
    expect(onFirst.requests).toHaveLength(1);
    expect(onSecond.requests).toHaveLength(1);
    expect(result.openedOne).toEqual({
      number: 11,
      url: firstUrl,
      outcome: "opened",
    });
    expect(result.openedTwo).toEqual({
      number: 12,
      url: secondUrl,
      outcome: "opened",
    });
    expect(result.repeatedOne).toEqual({
      number: 11,
      url: firstUrl,
      outcome: "already-open",
    });
    // Each session reports the PR it opened, so neither link was borrowed from the other.
    expect(result.oneUrl).toBe(firstUrl);
    expect(result.twoUrl).toBe(secondUrl);
  }, 120_000);

  it("restores the link from the log after the index rows are deleted", async () => {
    const url = "https://github.com/lobiklukas/factory/pull/8";
    const github = makeGithubFake(201, { number: 8, url });

    const rebuilt = await program(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        const sessions = yield* SessionService;
        const { created } = yield* sessionWithDiff(
          "open a PR and lose the index",
        );
        yield* sessions
          .openPullRequest({
            sessionId: created.id,
            title: "factory: open a PR and lose the index",
            head: `factory/${created.id}`,
            base: "main",
          })
          .pipe(Effect.provide(github.layer));

        // Only this session's index rows: the log is what a rebuild must answer from.
        yield* sql`DELETE FROM sessions WHERE id = ${created.id}`;
        yield* sql`DELETE FROM session_activity WHERE session_id = ${created.id}`;
        const gone = yield* sql<{ id: string }>`
          SELECT id FROM sessions WHERE id = ${created.id}
        `;
        const report = yield* rebuildIndexes;
        // A fresh service reads the refolded index, never the owner's memory: this instance is the
        // same process, so what is proved here is the row, not the fold.
        const restored = yield* sessions.get(created.id);
        const list = yield* sessions.list({});
        return {
          gone,
          report,
          prUrl: restored.session.prUrl,
          listed: list.sessions.find((row) => row.id === created.id)?.prUrl,
        };
      }),
    );

    expect(rebuilt.gone).toEqual([]);
    expect(rebuilt.report.sessions).toBeGreaterThan(0);
    expect(rebuilt.prUrl).toBe(url);
    expect(rebuilt.listed).toBe(url);
    expect(github.requests).toHaveLength(1);
  }, 120_000);
});

/*
 * The fixtures the diff cases share: what the branch carries, and the session that carries it.
 * They live here rather than inside one `describe` because "the diff cap" and "an empty diff" are
 * two questions about the same measurement.
 */

/** The `prOpened` entries a folded transcript holds: the PR entry carries no model content. */
const prEntries = (
  entries: ReadonlyArray<{
    readonly kind: string;
    readonly text: string;
  }>,
): number =>
  entries.filter((entry) => entry.kind === "other" && entry.text === "").length;

/**
 * Commit `files` files of `lines` lines each on the session's branch, in its own worktree.
 *
 * The commit is what the step measures: it reads the *branch's* diff, so a change left uncommitted
 * in the worktree is not part of what a PR would carry and is not counted here either. `git add -A`
 * inside the worktree only ever stages what this case just wrote — the worktree is a fresh checkout
 * of `main`. Zero files commits nothing at all, which is how the empty-diff cases below start a run
 * from an unchanged checkout.
 */
const commitDiff = (input: {
  readonly worktree: string;
  readonly files: number;
  readonly lines: number;
}): void => {
  if (input.files === 0) return;
  for (let file = 0; file < input.files; file += 1) {
    writeFileSync(
      join(input.worktree, `change-${file}.txt`),
      "x\n".repeat(input.lines),
    );
  }
  execSync("git add -A", { cwd: input.worktree, stdio: "ignore" });
  execSync(
    `git commit -m ${JSON.stringify(`change ${input.files}x${input.lines}`)}`,
    { cwd: input.worktree, stdio: "ignore" },
  );
};

/**
 * A session bound to `repoRoot` with a committed diff, and the answer the step gave for it.
 *
 * The session's own worktree is what the diff is committed into, read from the snapshot as a
 * client would read it, and the same snapshot is read back afterwards for what the step left
 * behind.
 */
const drive = (input: {
  readonly title: string;
  readonly files: number;
  readonly lines: number;
}) =>
  Effect.gen(function* () {
    const sessions = yield* SessionService;
    yield* sessions.registerRepo({
      repo: factoryRepo,
      url: "https://github.com/lobiklukas/factory.git",
      localPath: repoRoot,
    });
    const created = yield* sessions.create({
      repo: factoryRepo,
      baseRef: "main",
      title: input.title,
    });
    const before = yield* sessions.get(created.id);
    commitDiff({
      worktree: before.workspace.path,
      files: input.files,
      lines: input.lines,
    });
    const answer = yield* sessions.openPullRequest({
      sessionId: created.id,
      title: `factory: ${input.title}`,
      head: `factory/${created.id}`,
      base: "main",
    });
    const after = yield* sessions.get(created.id);
    return {
      sessionId: created.id,
      worktree: before.workspace.path,
      answer,
      prUrl: after.session.prUrl,
      prEntries: prEntries(after.entries),
      entries: after.entries,
    };
  });

/**
 * The cap on a session's diff (LOB-227), driven through the step that would open the PR.
 *
 * Every case here goes through a real worktree and a real branch: the session is bound to
 * `repoRoot`, so opening it cuts `factory/<id>` off `main`, this file commits a change on that
 * branch, and the step measures it with `git diff --numstat` exactly as it would in a deployment.
 * A fake git would prove the arithmetic and nothing else — that the diff the step reads is the
 * branch's, that the base is the one the PR names, and that an uncommitted change is not counted
 * are all facts of the real command.
 *
 * "Records no document" is asserted twice per refusal, because either half alone is weak: the
 * transcript holds no `prOpened`, and the widened-cap case opens the same session afterwards and is
 * answered `opened` rather than `already-open` — which it could not be if a `factory.pr` document
 * had been committed by the refusal.
 */

describe("the diff cap", () => {
  it("opens the one PR when the branch's diff is inside the cap", async () => {
    const url = "https://github.com/lobiklukas/factory/pull/31";
    const github = makeGithubFake(201, { number: 31, url });
    const result = await program(
      drive({ title: "a small diff", files: 2, lines: 10 }).pipe(
        Effect.provide(github.layer),
      ),
    );

    // A diff that is really there, and really measured: two files, twenty lines.
    expect(
      execSync("git diff --numstat main...HEAD", {
        cwd: result.worktree,
        encoding: "utf8",
      })
        .trim()
        .split("\n"),
    ).toEqual(["10\t0\tchange-0.txt", "10\t0\tchange-1.txt"]);
    expect(result.answer).toEqual({ number: 31, url, outcome: "opened" });
    expect(github.requests).toHaveLength(1);
    expect(result.prUrl).toBe(url);
    expect(result.prEntries).toBe(1);
    // The body lists the paths the same measurement counted (LOB-228): the reviewer reads what the
    // cap refused on, rather than opening the diff to find out.
    const sent = github.requests[0]?.body as { readonly body: string };
    expect(sent.body).toContain("## Changed files");
    expect(sent.body).toContain("- change-0.txt");
    expect(sent.body).toContain("- change-1.txt");
  }, 120_000);

  it("refuses a diff with too many files, under the line cap", async () => {
    const github = makeGithubFake(201, {
      number: 32,
      url: "https://github.com/lobiklukas/factory/pull/32",
    });
    // 51 files of one line each: over `maxFiles`, far under `maxLines`. The dimensions are
    // enforced separately, so this must refuse on the file count and say so.
    const result = await program(
      drive({ title: "a wide diff", files: 51, lines: 1 }).pipe(
        Effect.provide(github.layer),
      ),
    );

    expect(result.answer).toEqual({
      outcome: "over-cap",
      limit: "files",
      cap: DEFAULT_DIFF_CAP.maxFiles,
      measured: 51,
    });
    // Nothing was asked of GitHub, nothing was committed, and the index still says no PR.
    expect(github.requests).toEqual([]);
    expect(result.prUrl).toBeUndefined();
    expect(result.prEntries).toBe(0);
  }, 120_000);

  it("refuses a diff with too many lines, under the file cap", async () => {
    const github = makeGithubFake(201, {
      number: 33,
      url: "https://github.com/lobiklukas/factory/pull/33",
    });
    // One file, 2001 lines: over `maxLines`, far under `maxFiles`.
    const result = await program(
      drive({ title: "a deep diff", files: 1, lines: 2_001 }).pipe(
        Effect.provide(github.layer),
      ),
    );

    expect(result.answer).toEqual({
      outcome: "over-cap",
      limit: "lines",
      cap: DEFAULT_DIFF_CAP.maxLines,
      measured: 2_001,
    });
    expect(github.requests).toEqual([]);
    expect(result.prUrl).toBeUndefined();
    expect(result.prEntries).toBe(0);
  }, 120_000);

  it("accepts the same diff when the configured cap is widened", async () => {
    const url = "https://github.com/lobiklukas/factory/pull/34";
    const github = makeGithubFake(201, { number: 34, url });
    // The limits are configuration, not constants in the check: this diff is the one the case above
    // refuses, and a deployment that allows more files opens it.
    const wide = ManagedRuntime.make(
      SessionServiceLive({
        model: createModelAccess("faux"),
        sessionRoot,
        prCap: { maxFiles: 60, maxLines: DEFAULT_DIFF_CAP.maxLines },
      }).pipe(Layer.provideMerge(DatabaseLayer)),
    );
    try {
      const result = await wide.runPromise(
        drive({ title: "a wide diff, allowed", files: 51, lines: 1 }).pipe(
          Effect.provide(github.layer),
        ),
      );
      expect(result.answer).toEqual({ number: 34, url, outcome: "opened" });
      expect(github.requests).toHaveLength(1);
      expect(result.prUrl).toBe(url);
    } finally {
      await wide.dispose();
    }
  }, 120_000);

  it("does not re-measure a branch whose PR the log already records", async () => {
    const url = "https://github.com/lobiklukas/factory/pull/35";
    const github = makeGithubFake(201, { number: 35, url });
    const result = await program(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        yield* sessions.registerRepo({
          repo: factoryRepo,
          url: "https://github.com/lobiklukas/factory.git",
          localPath: repoRoot,
        });
        const created = yield* sessions.create({
          repo: factoryRepo,
          baseRef: "main",
          title: "a small diff, then a large one",
        });
        const openedOnce = yield* sessions.get(created.id);
        commitDiff({
          worktree: openedOnce.workspace.path,
          files: 1,
          lines: 1,
        });
        const asked = {
          sessionId: created.id,
          title: "factory: a small diff, then a large one",
          head: `factory/${created.id}`,
          base: "main",
        };
        const first = yield* sessions.openPullRequest(asked);
        // The branch then grows past the cap. The PR exists, so the step's answer is the one its
        // log records — the cap bounds what the step would open, not what it already opened.
        commitDiff({
          worktree: openedOnce.workspace.path,
          files: 1,
          lines: DEFAULT_DIFF_CAP.maxLines + 1,
        });
        const repeated = yield* sessions.openPullRequest(asked);
        return { first, repeated };
      }).pipe(Effect.provide(github.layer)),
    );

    expect(opened(result.first)).toEqual({
      number: 35,
      url,
      outcome: "opened",
    });
    expect(opened(result.repeated)).toEqual({
      number: 35,
      url,
      outcome: "already-open",
    });
    // One POST for both: the retry was answered by the log, whatever the branch has become.
    expect(github.requests).toHaveLength(1);
  }, 120_000);

  it("fails, naming the range, rather than opening a PR it could not measure", async () => {
    const github = makeGithubFake(201, {
      number: 36,
      url: "https://github.com/lobiklukas/factory/pull/36",
    });
    const result = await program(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        yield* sessions.registerRepo({
          repo: factoryRepo,
          url: "https://github.com/lobiklukas/factory.git",
          localPath: repoRoot,
        });
        const created = yield* sessions.create({
          repo: factoryRepo,
          baseRef: "main",
          title: "a branch whose base does not exist",
        });
        const snapshot = yield* sessions.get(created.id);
        commitDiff({
          worktree: snapshot.workspace.path,
          files: 1,
          lines: 1,
        });
        const exit = yield* Effect.exit(
          sessions.openPullRequest({
            sessionId: created.id,
            title: "factory: a branch whose base does not exist",
            head: `factory/${created.id}`,
            base: "no-such-base",
          }),
        );
        return { exit, head: `factory/${created.id}` };
      }).pipe(Effect.provide(github.layer)),
    );

    // A checkout whose base cannot be read is not a diff that fits: the cap does not disappear
    // because the measurement broke, and no PR is opened on an unmeasured branch.
    expect(result.exit._tag).toBe("Failure");
    if (result.exit._tag !== "Failure") throw new Error("unreachable");
    const error = result.exit.cause.reasons.flatMap((reason) =>
      reason._tag === "Fail"
        ? [reason.error as { operation: string; ref: string }]
        : [],
    )[0];
    expect(error?.operation).toBe("diffSize");
    expect(error?.ref).toBe(`no-such-base...${result.head}`);
    expect(github.requests).toEqual([]);
  }, 120_000);

  it("defaults to the session's own branch and base, and refuses a ref that reads as an option (LOB-213)", async () => {
    const github = makeGithubFake(201, {
      number: 37,
      url: "https://github.com/lobiklukas/factory/pull/37",
    });
    const result = await program(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        yield* sessions.registerRepo({
          repo: factoryRepo,
          url: "https://github.com/lobiklukas/factory.git",
          localPath: repoRoot,
        });
        const created = yield* sessions.create({
          repo: factoryRepo,
          baseRef: "main",
          title: "the branches are the session's",
        });
        const snapshot = yield* sessions.get(created.id);
        commitDiff({
          worktree: snapshot.workspace.path,
          files: 1,
          lines: 1,
        });
        // A name git would read as `--output=<file>`: before the check, `git diff --numstat` in the
        // session's checkout created that file and measured nothing.
        const planted = join(snapshot.workspace.path, "planted");
        const refused = yield* Effect.flip(
          sessions.openPullRequest({
            sessionId: created.id,
            title: "factory: an option for a base",
            base: `--output=${planted}`,
          }),
        );
        const refusedHead = yield* Effect.flip(
          sessions.openPullRequest({
            sessionId: created.id,
            title: "factory: an option for a head",
            head: "-p",
          }),
        );
        const opened = yield* sessions.openPullRequest({
          sessionId: created.id,
          title: "factory: the session's own branches",
        });
        return {
          refused,
          refusedHead,
          opened,
          planted: existsSync(`${planted}...factory/${created.id}`),
          head: `factory/${created.id}`,
        };
      }).pipe(Effect.provide(github.layer)),
    );

    expect(result.refused).toMatchObject({
      _tag: "SessionError",
      code: "invalid_input",
    });
    expect(result.refusedHead).toMatchObject({
      _tag: "SessionError",
      code: "invalid_input",
    });
    expect(result.planted).toBe(false);
    expect(result.opened).toMatchObject({ number: 37, outcome: "opened" });
    // One request, and it published the session's own branch onto the base it was cut from.
    expect(github.requests).toHaveLength(1);
    expect(github.requests[0]?.body).toMatchObject({
      head: result.head,
      base: "main",
    });
  }, 120_000);
});

/**
 * A branch with nothing to publish (LOB-196): the ordinary result of a docs run over docs that need
 * no edit, and the run that used to reach GitHub with an empty branch and fail on its 422.
 *
 * Both cases drive a real worktree and a real `git diff --numstat`, because "nothing changed" is a
 * fact about a branch: a fake that answered zero would prove only that the step can read a number it
 * was handed.
 */
/**
 * The PR step reports its exit to the session layer's write-back (LOB-15), whatever the exit was,
 * and the report cannot change the step's answer. The tracker is a recording fake: what it does
 * with a report is `LinearSync.test.ts`'s, and this is only that every exit reaches it.
 */
describe("the PR step's write-back", () => {
  it("reports the PR, the refusal, and the error — and the step answers as it would without it", async () => {
    const url = "https://github.com/lobiklukas/factory/pull/36";
    const github = makeGithubFake(201, { number: 36, url });
    const reports: Array<{
      readonly sessionId: SessionId;
      readonly report: PullRequestReport;
      readonly evidence: number;
    }> = [];
    const reported = ManagedRuntime.make(
      SessionServiceLive({
        model: createModelAccess("faux"),
        sessionRoot,
      }).pipe(
        Layer.provide(
          Layer.succeed(SessionWriteBack, {
            pullRequest: (input) =>
              Effect.map(input.evidence, (records) => {
                reports.push({
                  sessionId: input.sessionId,
                  report: pullRequestReport(input.result),
                  evidence: records.length,
                });
              }),
          }),
        ),
        Layer.provideMerge(DatabaseLayer),
      ),
    );
    try {
      const opened = await reported.runPromise(
        drive({ title: "a reported PR", files: 1, lines: 2 }).pipe(
          Effect.provide(github.layer),
        ),
      );
      const refused = await reported.runPromise(
        drive({ title: "a reported refusal", files: 51, lines: 1 }).pipe(
          Effect.provide(github.layer),
        ),
      );
      // GitHub refuses the token: the step's own typed error, reported and then raised as before.
      const forbidden = makeGithubFake(403, {
        message: "Resource not accessible",
      });
      const failed = await reported.runPromiseExit(
        drive({ title: "a reported error", files: 1, lines: 2 }).pipe(
          Effect.provide(forbidden.layer),
        ),
      );

      expect(opened.answer).toEqual({ number: 36, url, outcome: "opened" });
      expect(refused.answer).toMatchObject({ outcome: "over-cap" });
      expect(Exit.isFailure(failed)).toBe(true);
      expect(reports).toEqual([
        {
          sessionId: opened.sessionId,
          report: { _tag: "opened", pr: { number: 36, url } },
          evidence: 0,
        },
        {
          sessionId: refused.sessionId,
          report: expect.objectContaining({ _tag: "failed", step: "over-cap" }),
          evidence: 0,
        },
        {
          sessionId: expect.any(String),
          report: expect.objectContaining({
            _tag: "failed",
            step: "pr-error",
            reason: expect.stringContaining("PrError"),
          }),
          evidence: 0,
        },
      ]);
    } finally {
      await reported.dispose();
    }
  }, 120_000);
});

describe("a slow tracker", () => {
  it("does not hold up another session's PR step: the report runs outside the PR gate", async () => {
    const github = makeGithubFake(201, {
      number: 37,
      url: "https://github.com/lobiklukas/factory/pull/37",
    });
    const arrived = Deferred.makeUnsafe<void>();
    const release = Deferred.makeUnsafe<void>();
    let calls = 0;
    const runtime = ManagedRuntime.make(
      SessionServiceLive({
        model: createModelAccess("faux"),
        sessionRoot,
      }).pipe(
        Layer.provide(
          Layer.succeed(SessionWriteBack, {
            // The first report stalls until released — a tracker that accepted the connection and
            // has not answered — and every later one returns at once.
            pullRequest: () =>
              Effect.suspend(() => {
                calls += 1;
                return calls > 1
                  ? Effect.void
                  : Deferred.succeed(arrived, undefined).pipe(
                      Effect.andThen(Deferred.await(release)),
                    );
              }),
          }),
        ),
        Layer.provideMerge(DatabaseLayer),
      ),
    );
    try {
      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const stalled = yield* Effect.forkChild(
            drive({ title: "a stalled report", files: 1, lines: 1 }).pipe(
              Effect.provide(github.layer),
            ),
          );
          yield* Deferred.await(arrived);
          // Session A's report is in flight. Session B's whole PR step completes regardless.
          const other = yield* drive({
            title: "a PR behind a stalled report",
            files: 1,
            lines: 1,
          }).pipe(Effect.provide(github.layer), Effect.timeout("60 seconds"));
          yield* Deferred.succeed(release, undefined);
          const first = yield* Fiber.join(stalled);
          return { other, first };
        }),
      );
      expect(result.other.answer).toMatchObject({ outcome: "opened" });
      expect(result.first.answer).toMatchObject({ outcome: "opened" });
    } finally {
      await runtime.dispose();
    }
  }, 120_000);
});

describe("a write-back that breaks its contract", () => {
  /** A session layer whose tracker reports with `pullRequest`, and a short report budget. */
  const withTracker = (pullRequest: SessionWriteBackShape["pullRequest"]) =>
    ManagedRuntime.make(
      SessionServiceLive({
        model: createModelAccess("faux"),
        sessionRoot,
        writeBackBudget: "200 millis",
      }).pipe(
        Layer.provide(Layer.succeed(SessionWriteBack, { pullRequest })),
        Layer.provideMerge(DatabaseLayer),
      ),
    );

  it("never answering: the PR step answers once the report's budget is spent", async () => {
    const github = makeGithubFake(201, {
      number: 38,
      url: "https://github.com/lobiklukas/factory/pull/38",
    });
    const runtime = withTracker(() => Effect.never);
    try {
      const result = await runtime.runPromise(
        drive({
          title: "a report that never answers",
          files: 1,
          lines: 1,
        }).pipe(
          Effect.provide(github.layer),
          // Far longer than the budget, far shorter than "never": a stall fails the case here.
          Effect.timeout("30 seconds"),
        ),
      );
      expect(result.answer).toMatchObject({ number: 38, outcome: "opened" });
    } finally {
      await runtime.dispose();
    }
  }, 120_000);

  it("dying: the defect is logged, and the PR step's answer stands", async () => {
    const github = makeGithubFake(201, {
      number: 39,
      url: "https://github.com/lobiklukas/factory/pull/39",
    });
    const runtime = withTracker(() => Effect.die(new Error("tracker bug")));
    try {
      const result = await runtime.runPromise(
        drive({ title: "a report that dies", files: 1, lines: 1 }).pipe(
          Effect.provide(github.layer),
        ),
      );
      expect(result.answer).toMatchObject({ number: 39, outcome: "opened" });
    } finally {
      await runtime.dispose();
    }
  }, 120_000);
});

describe("an empty diff", () => {
  it("answers no-change for two runs on an unchanged checkout, announcing each in the transcript", async () => {
    const github = makeGithubFake(201, {
      number: 40,
      url: "https://github.com/lobiklukas/factory/pull/40",
    });
    const result = await program(
      Effect.gen(function* () {
        // Two runs over one unchanged checkout, each its own session — which is what a docs run is.
        const first = yield* drive({
          title: "docs that need no edit",
          files: 0,
          lines: 0,
        });
        const second = yield* drive({
          title: "docs that still need no edit",
          files: 0,
          lines: 0,
        });
        return { first, second };
      }).pipe(Effect.provide(github.layer)),
    );

    // The ledger, not an inferred count: a no-op run is not an empty-diff *attempt*, it is no
    // request at all, twice over.
    expect(github.requests).toEqual([]);
    // A value rather than a failure — the run settles — and the state it settles in names no PR.
    expect(result.first.answer).toEqual({ outcome: "no-change" });
    expect(result.second.answer).toEqual({ outcome: "no-change" });
    expect(result.first.prUrl).toBeUndefined();
    expect(result.first.prEntries).toBe(0);
    // What a person watching the run reads: one line saying nothing needed documenting, and the base
    // it was measured against. Without it a no-op run is silence.
    const said = result.second.entries.filter((entry) =>
      entry.text.includes("no documentation change"),
    );
    expect(said).toHaveLength(1);
    expect(said[0]?.text).toContain("main");
  }, 120_000);

  it("opens the PR when a run does change a file, because the guard records nothing", async () => {
    const url = "https://github.com/lobiklukas/factory/pull/41";
    const github = makeGithubFake(201, { number: 41, url });
    const result = await program(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        yield* sessions.registerRepo({
          repo: factoryRepo,
          url: "https://github.com/lobiklukas/factory.git",
          localPath: repoRoot,
        });
        const created = yield* sessions.create({
          repo: factoryRepo,
          baseRef: "main",
          title: "docs, then an edit",
        });
        const before = yield* sessions.get(created.id);
        const asked = {
          sessionId: created.id,
          title: "factory: docs, then an edit",
          head: `factory/${created.id}`,
          base: "main",
        };
        const empty = yield* sessions.openPullRequest(asked);
        // The next run edits a page on the same branch: a recorded "nothing to do" would answer
        // this one too, so what makes the guard safe is that it left nothing behind to read.
        commitDiff({ worktree: before.workspace.path, files: 1, lines: 3 });
        const changed = yield* sessions.openPullRequest(asked);
        const after = yield* sessions.get(created.id);
        return {
          empty,
          changed,
          prUrl: after.session.prUrl,
          prEntries: prEntries(after.entries),
        };
      }).pipe(Effect.provide(github.layer)),
    );

    expect(result.empty).toEqual({ outcome: "no-change" });
    expect(result.changed).toEqual({ number: 41, url, outcome: "opened" });
    expect(github.requests).toHaveLength(1);
    expect(result.prUrl).toBe(url);
    expect(result.prEntries).toBe(1);
  }, 120_000);

  it("still opens the PR for a directory that is not its own checkout, where nothing was measured", async () => {
    const url = "https://github.com/lobiklukas/factory/pull/42";
    const github = makeGithubFake(201, { number: 42, url });
    // A slug no case registered: the session's working directory is a plain directory, so the step
    // has no branch to read. "Nothing to publish" is a measurement, and a step that could not
    // measure must not read the absence as an empty diff — that is `diffCapRefusal`'s rule too.
    const unmeasured = RepoSlugSchema.make("lobiklukas/unregistered");

    const answer = await program(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const created = yield* sessions.create({
          repo: unmeasured,
          baseRef: "main",
          title: "a session with no worktree",
        });
        const snapshot = yield* sessions.get(created.id);
        const step = yield* sessions
          .openPullRequest({
            sessionId: created.id,
            title: "factory: a session with no worktree",
            head: `factory/${created.id}`,
            base: "main",
          })
          .pipe(Effect.provide(github.layer));
        return { step, worktree: snapshot.workspace.path };
      }),
    );

    expect(answer.step).toEqual({ number: 42, url, outcome: "opened" });
    expect(github.requests).toHaveLength(1);
  }, 120_000);
});

/** The page size this loop drives the list with, and the page size the old bound assumed. */
const PAGE_SIZE = 25;

/**
 * Filler rows this test writes itself. More than the old fixed budget of ten pages (`10 × 25`),
 * so the test fails on a database of *any* size unless the loop is bounded by the data it reads
 * rather than by a constant. The table may hold anything on top of these.
 */
const FILLERS = 280;

describe("session list", () => {
  // The page loop reads `SELECT count(*) FROM session_activity` and issues one list
  // statement per page, so its cost scales with the *shared* table, not the 280 fillers
  // this case writes. Measured 2026-10-07 at ~2 883 rows: ~360 ms, i.e. ~0.125 ms per
  // row — the 5 s default is reached at ~40 000 rows. 30 000 is ~8x today's cost and
  // gives the same headroom the rebuild guard uses; a database of its own per run
  // (LOB-96) would also resolve it.
  it("shows a new session without a poll, pages by cursor, one statement per page", async () => {
    // Run-private identity for this test's filler rows and its three sessions, so two
    // runs against one database cannot collide on primary keys (LOB-98).
    const alphabet = "0123456789abcdefghjkmnpqrstvwxyz";
    const token = Array.from(
      { length: 5 },
      () =>
        alphabet[Effect.runSync(Random.nextIntBetween(0, alphabet.length - 1))],
    ).join("");
    const runPrefix = `ses_f${token}`;
    const mineIds: string[] = [];
    const result = await program(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const sql = yield* SqlClient;
        // The filler rows are this test's, so its own leftovers are the only ones to clear here.
        yield* sql`DELETE FROM sessions WHERE starts_with(id, ${runPrefix})`;

        const first = yield* sessions.create({ title: "older" });
        const second = yield* sessions.create({ title: "newer" });
        const third = yield* sessions.create({ title: "newest" });
        mineIds.push(first.id, second.id, third.id);
        // A session created a moment ago is in the list already: no read, no fold, no poll.
        const immediately = (yield* sessions.list({
          limit: PAGE_SIZE,
        })).sessions.map((entry) => entry.id);

        // Deterministic activity order: the index is what the list reads, so set it directly.
        const at = (id: SessionId, secondsAgo: number) =>
          sql`UPDATE session_activity SET last_activity_at = now() - ${`${secondsAgo} seconds`}::interval WHERE session_id = ${id}`;
        yield* at(first.id, 30);
        yield* at(second.id, 20);
        yield* at(third.id, 10);

        // Older than the three above, and more of them than the old page budget could see on
        // their own, whatever the table already holds.
        yield* sql`
          INSERT INTO sessions (id, title)
          SELECT ${runPrefix} || lpad(n::text, 20, '0'), 'filler ' || n
          FROM generate_series(0, ${FILLERS - 1}) AS g(n)
        `;
        yield* sql`
          INSERT INTO session_activity (session_id, last_activity_at)
          SELECT ${runPrefix} || lpad(n::text, 20, '0'), now() - make_interval(secs => 300 + n)
          FROM generate_series(0, ${FILLERS - 1}) AS g(n)
        `;

        // The page budget is a function of the rows, not a constant: every page the data can
        // need, plus slack for a session a concurrent suite commits while we page. A budget that
        // is too small shows up as `exhausted: false` below rather than as a wrong page count.
        const [rowCount] = yield* sql<{ rows: number }>`
          SELECT count(*)::int AS rows FROM session_activity
        `;
        if (rowCount === undefined) throw new Error("unreachable");
        const visible = rowCount.rows;
        const budget = Math.ceil(visible / PAGE_SIZE) + 2;

        // Page through everything, one statement per page, until the cursor runs out.
        const pages = [];
        let cursor: string | undefined = undefined;
        let exhausted = false;
        for (let page = 0; page < budget; page += 1) {
          const payload: ListSessionsInput =
            cursor === undefined
              ? { limit: PAGE_SIZE }
              : { limit: PAGE_SIZE, cursor };
          const counted = yield* countStatements(sessions.list(payload));
          pages.push(counted);
          cursor = counted.value.nextCursor;
          if (cursor === undefined) {
            exhausted = true;
            break;
          }
        }
        // Its own page loop keeps `counted` whole (the statement count travels with it), so the
        // accounting reads the output out of it rather than this case reshaping the array.
        const leftOver = yield* unaccounted(
          pages.map((page) => ({ output: page.value })),
        );
        return {
          first,
          second,
          third,
          immediately,
          pages,
          exhausted,
          visible,
          leftOver,
        };
      }).pipe(
        // The fillers go whether this test passes, fails or dies: the cases below page over the
        // whole table, so 280 rows left behind are rows they read and this case does not own.
        Effect.ensuring(
          Effect.gen(function* () {
            const sql = yield* SqlClient;
            yield* sql`DELETE FROM sessions WHERE starts_with(id, ${runPrefix})`;
            for (const id of mineIds) {
              yield* sql`DELETE FROM sessions WHERE id = ${id}`;
            }
          }).pipe(
            // A cleanup that cannot run is a defect, not a silent 280-row leak.
            Effect.orDie,
          ),
        ),
      ),
    );

    expect(result.immediately).toContain(result.third.id);

    const entries = result.pages.flatMap((page) => page.value.sessions);
    const keys = entries.map((entry) => `${entry.lastActivityAt}|${entry.id}`);
    // Ordering contract, page after page: newest activity first. The wire renders
    // `lastActivityAt` at millisecond precision, so rows sharing a millisecond
    // are not totally ordered by the rendered key — only the timestamp itself
    // must be non-increasing; the id tie-break lives in the cursor, not here.
    // (See LOB-100.) The rendered timestamp must never rise as we page.
    for (let i = 1; i < entries.length; i++) {
      expect(entries[i]!.lastActivityAt <= entries[i - 1]!.lastActivityAt).toBe(
        true,
      );
    }
    expect(new Set(keys).size).toBe(keys.length);
    // The loop ended because the cursor ran out, not because it hit its budget: the list pages to
    // the end of a database of any size. This is the assertion the old constant bound broke.
    expect(result.exhausted).toBe(true);
    expect(result.pages.at(-1)?.value.nextCursor).toBeUndefined();
    expect(result.pages.length).toBeGreaterThan(1);
    // Every row the list should have had comes back, and comes back once. Not
    // `entries.length >= visible`: `visible` was counted before the walk, and `last_activity_at`
    // — the ordering key — is rewritten to "now" by every live event, so a row can leave the range
    // the walk is traversing mid-walk (LOB-135). That is one legitimate reason for a shortfall and
    // `unaccounted` accounts for it; a row dropped behind the fillers for any other reason still
    // reds here.
    expect(result.leftOver).toEqual([]);
    // Every filler row this test wrote comes back exactly once, so a list that stops early inside
    // them cannot pass by landing on the three sessions below.
    expect(
      entries.filter((entry) => entry.id.startsWith(runPrefix)).length,
    ).toBe(FILLERS);
    // Cost is one statement per page whatever the row count: never a fold per session (R6).
    for (const page of result.pages) expect(page.statements).toBe(1);

    // The wire shape of `lastActivityAt` is the one thing this issue promised not to change, and
    // nothing else here would notice if it did: the ordering key above and the cursor the
    // same-millisecond cases compare are both derived from it, so a switch to `US` precision would
    // leave every assertion in this file green while the dashboard's timestamps grew six digits.
    // `packages/domain/src/Session.ts` types it as a general `Timestamp`, so the millisecond
    // rendering is this file's contract to hold.
    for (const entry of entries) {
      expect(
        entry.lastActivityAt,
        `rendered as ${entry.lastActivityAt}: the wire shape is millisecond-precise and the cursor carries the exact instant separately`,
      ).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    }

    // The three sessions this test made are all there, in activity order.
    const mine = entries
      .map((entry) => entry.id)
      .filter((id) =>
        [result.first.id, result.second.id, result.third.id].includes(id),
      );
    expect(mine).toEqual([result.third.id, result.second.id, result.first.id]);
  }, 30_000);

  /**
   * A page boundary inside a group of rows that share a millisecond must not drop the rest of the
   * group. The cursor used to be built from `lastActivityAt`, which the list renders at millisecond
   * precision while `session_activity.last_activity_at` is a `TIMESTAMPTZ`: casting the truncated
   * cursor back gave a value strictly *less* than the stored one, so every remaining row in the
   * group failed `(last_activity_at, id) < (cursor.at, cursor.id)` and the page ended early.
   */
  // Every case below pages over the *whole* table to prove the group is not dropped in passing, so
  // each one's cost is the table's rather than the group's. That is why each one carried a 60 s
  // budget while the table was the shared one every run widened (LOB-95). The database of its own
  // that the block at the top of this file creates is the durable fix (LOB-96): against a table
  // this run alone fills, the nine cases below cost 11-30 ms each (measured), so they take
  // vitest's 5 s default again.
  // `describe("this suite's database")` further down this file is what notices if that stops being
  // the database they run against, since a shared one would make the cost a table's again.
  it("returns every row of a same-millisecond group exactly once", async () => {
    const GROUP = 12;
    const LIMIT = 4;
    // The seeding and paging helpers are declared *after* this case. They are `const`s in the same
    // `describe` callback, which vitest runs to completion before any case body, so by the time
    // this body reads them they are initialised — no hoisting is involved, only ordering.
    const result = await program(
      withGroup(
        Effect.gen(function* () {
          // One instant for the whole group, newer than anything the table holds and
          // with non-zero microseconds — `newestInstant` says why both halves are load-bearing.
          yield* seedGroup(GROUP, yield* newestInstant);
          const visible = yield* listableRows;
          // A four-row page against a twelve-row group: the page boundaries fall after the
          // group's 4th, 8th and 12th row, and the first two are inside it. A millisecond-
          // truncated cursor loses the rest of the group at each of those two boundaries.
          const { pages, exhausted } = yield* pageAll(
            LIMIT,
            Math.ceil(visible / LIMIT) + 2,
          );
          const leftOver = yield* unaccounted(pages);
          return { GROUP, pages, exhausted, leftOver };
        }),
      ),
    );

    const entries = result.pages.flatMap((page) => page.output.sessions);
    const group = entries.filter((entry) => entry.id.startsWith(GROUP_PREFIX));
    // Every row of the group came back, exactly once, in the keyset's own order (id descending
    // inside the tie). A cursor truncated to the millisecond stopped the page at the boundary
    // and dropped the rest of the group.
    expect(group.map((entry) => entry.id)).toEqual(
      groupIdsDescending(result.GROUP),
    );
    expect(new Set(group).size).toBe(group.length);
    // The walk ended because the cursor ran out, not because it hit its budget.
    expect(result.exhausted).toBe(true);
    // Cost is one statement per page whatever the row count: never a fold per session (R6).
    for (const page of result.pages) expect(page.statements).toBe(1);
  });

  /**
   * The prefix every case below seeds with, and the ids it seeds.
   *
   * Zero-padded to the full id length, so the ids sort contiguously and a page boundary falls
   * inside the group wherever the limit puts it. `ses_mv` is in the id alphabet (which excludes
   * `i`, `l`, `o` and `u`).
   */
  const GROUP_PREFIX = "ses_mv";
  const groupId = (n: number) =>
    `${GROUP_PREFIX}${String(n).padStart(24, "0")}`;
  const groupIds = (n: number) =>
    Array.from({ length: n }, (_, k) => groupId(k));
  /** A group's ids in the order the list returns them: id descending inside the tie. */
  const groupIdsDescending = (n: number) => [...groupIds(n)].sort().reverse();
  /**
   * The rows these cases seed *below* the group, so the group is not the head of the table and a
   * page boundary can fall inside it from either side.
   */
  // `ses_mn`, not `ses_mo`: the id alphabet excludes `i`, `l`, `o` and `u`, and the service
  // refuses a row it cannot parse.
  const OLDER_PREFIX = "ses_mn";
  /** A prefix as a `LIKE` pattern — `_` is a wildcard in `LIKE`, so it is escaped. */
  const asPattern = (prefix: string) => `${prefix.replace(/_/g, "\\_")}%`;
  const GROUP_PATTERN = asPattern(GROUP_PREFIX);
  const OLDER_PATTERN = asPattern(OLDER_PREFIX);
  /** The rows one case seeds *above* its group, so the group is the tail of the ordering. */
  const NEWER_PREFIX = "ses_my";
  const NEWER_PATTERN = asPattern(NEWER_PREFIX);

  /**
   * Delete every row these cases mint, in one statement.
   *
   * The database is the run's own (LOB-96), so a run can no longer collide with the next one's
   * `sessions_pkey`. What it can still do is leave rows behind for the cases that follow in this
   * file, which page over the whole table and would silently read a different count.
   */
  const deleteSeeded = Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql`DELETE FROM sessions WHERE id LIKE ${GROUP_PATTERN} OR id LIKE ${OLDER_PATTERN} OR id LIKE ${NEWER_PATTERN}`;
  });

  /**
   * Seed `n` sessions whose `last_activity_at` is one literal instant.
   *
   * The instant is a parameter because one case needs a group at the *end* of the ordering, which
   * only the database can place: `min(last_activity_at) - 1 hour` is however old the table already
   * is, and a fixed year would stop being the end the day something older is written.
   */
  /**
   * An instant newer than anything the table holds, with a non-zero sub-millisecond part.
   *
   * Derived from `max(last_activity_at)` rather than fixed, for two reasons that are both
   * load-bearing. A group has to be at the *head* of the ordering for the cases that assert it is,
   * and a hard-coded year stops being newer on the first day it passes — a red the fix did not
   * cause and cannot explain. And the sub-millisecond part must not be inherited from `max`, which
   * in a table this old is usually millisecond-aligned: an aligned instant renders losslessly
   * at `MS`, so the truncated cursor would drop nothing and the case would pass against the code it
   * exists to catch. Truncating to the second and adding a fixed `.123456` makes the loss
   * deterministic whatever the table holds — and it is load-bearing for more than one case:
   * zeroing the pinned part instead (`+ interval '1 hour 0.000000 seconds'`, a *valid* mutation,
   * unlike dropping the part and getting a SQL parse error) reddens the truncated-cursor case and
   * the end-of-ordering case. The cases whose group sits inside a single page cannot notice either
   * way, which is the control discussed at `alignedInstant`.
   */
  const newestInstant = Effect.gen(function* () {
    const sql = yield* SqlClient;
    const [row] = yield* sql<{ at: string }>`
      SELECT to_char(
        (
          date_trunc(
            'seconds',
            COALESCE(max(last_activity_at), now())
          ) + interval '1 hour 0.123456 seconds'
        ) AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      ) AS at
      FROM session_activity
    `;
    if (row === undefined) throw new Error("unreachable");
    return row.at;
  });

  /**
   * The same instant with its sub-millisecond part zeroed: newer than the table, and
   * rendered losslessly at `MS`. The one case that needs this is the control for the other eight —
   * see its doc comment.
   */
  const alignedInstant = Effect.gen(function* () {
    const at = yield* newestInstant;
    // Sliced, not `replace`d: a regex that quietly stopped matching would leave this a ninth copy
    // of the lossless case — green, and testing nothing. Asserting the six-digit shape first makes
    // a change to `newestInstant`'s format string die here instead.
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(at)) {
      throw new Error(
        `alignedInstant expected newestInstant's six-digit rendering, got ${at}`,
      );
    }
    // `2027-01-01T00:00:00.123456Z` → `2027-01-01T00:00:00.123Z`, the same instant at `MS`.
    return at.slice(0, -4) + "Z";
  });

  const seedGroup = (n: number, at: string) =>
    Effect.gen(function* () {
      yield* deleteSeeded;
      const sql = yield* SqlClient;
      // The prefix is cast because a bare parameter makes the concatenation's type come from the
      // parameter rather than from `lpad`, and the driver sends an untyped one. The cast states it
      // instead of leaving it to inference; nothing here depends on inference failing.
      yield* sql`
        INSERT INTO sessions (id, title)
        SELECT ${GROUP_PREFIX}::text || lpad(n::text, 24, '0'), 'same millisecond ' || n
        FROM generate_series(0, ${n - 1}) AS g(n)
      `;
      yield* sql`
        INSERT INTO session_activity (session_id, last_activity_at)
        SELECT ${GROUP_PREFIX}::text || lpad(n::text, 24, '0'), ${at}::timestamptz
        FROM generate_series(0, ${n - 1}) AS g(n)
      `;
    });

  /** Run `body` with these cases' rows gone afterwards, whether it passes, fails or dies. */
  const withGroup = <A, E, R>(body: Effect.Effect<A, E, R>) =>
    body.pipe(
      Effect.ensuring(
        deleteSeeded.pipe(
          // A cleanup that cannot run is a defect, not a silent row leak.
          Effect.orDie,
        ),
      ),
    );

  /**
   * The rows the three cases that move the table under the walk seed (LOB-135).
   *
   * A plain ladder of distinct instants, ten seconds apart, so the walk's order is the insertion
   * order reversed and every position is unambiguous. Nothing here is tied: those cases are about a
   * key *moving*, and a tie would make them pass or fail for two reasons at once.
   *
   * Seeded *above* everything else, into the near future, and that is load-bearing rather than
   * decorative. Two of the cases write to one row between two pages, and which row that write can
   * reach depends on where the walk is: the rewind case needs the row it moves to have been returned
   * already, so it must be the head of page 1, and the skip case needs the row it moves to be one
   * the walk has *not* reached. Seeding the ladder above the rest of the table — which holds rows
   * every earlier case created at `to_timestamp(Clock.currentTimeMillis / 1000)`, i.e. about now —
   * makes page 1 a probe row whichever way the write goes. Measured: seeded at `now() - 10n` the
   * rewind case passed in isolation and returned nothing extra in a full-file run, because the
   * walk had not reached the row it rewound. The cases must not depend on what else the table
   * holds.
   */
  const PROBE_PREFIX = "ses_pr";
  const probeId = (n: number) =>
    `${PROBE_PREFIX}${String(n).padStart(24, "0")}`;
  const seedProbe = (n: number) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      yield* sql`DELETE FROM sessions WHERE id LIKE ${asPattern(PROBE_PREFIX)}`;
      yield* sql`
        INSERT INTO sessions (id, title)
        SELECT ${PROBE_PREFIX}::text || lpad(n::text, 24, '0'), 'probe ' || n
        FROM generate_series(1, ${n}) AS g(n)
      `;
      // `1` is the newest row, so the walk reaches it first and `n` is the last one it reaches.
      // Into the future on purpose — see the doc comment above.
      yield* sql`
        INSERT INTO session_activity (session_id, last_activity_at)
        SELECT ${PROBE_PREFIX}::text || lpad(n::text, 24, '0'),
               now() + make_interval(secs => 10 * (${n} - n))
        FROM generate_series(1, ${n}) AS g(n)
      `;
    });
  const deleteProbe = Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql`DELETE FROM sessions WHERE id LIKE ${asPattern(PROBE_PREFIX)}`;
  });
  /** As `withGroup`, for the probe rows: they page over the whole table too. */
  const withProbe = <A, E, R>(body: Effect.Effect<A, E, R>) =>
    body.pipe(Effect.ensuring(deleteProbe.pipe(Effect.orDie)));

  /**
   * Page the list by hand, running `afterPage` once the given page is in.
   *
   * `pageAll` has no seam between pages, and the whole point of these two cases is to write to the
   * table in that gap — so the loop is spelled out here rather than bent into `pageAll`. What it
   * returns is exactly what `pageAll` returns, so the two are interchangeable everywhere else.
   */
  const walkBetween = (
    limit: number,
    afterPage: number,
    between: () => Effect.Effect<void, never, SqlClient>,
  ): Effect.Effect<
    {
      readonly pages: readonly {
        readonly output: ListSessionsOutput;
        readonly statements: number;
      }[];
      readonly exhausted: boolean;
    },
    SessionError,
    SessionService | SqlClient
  > =>
    Effect.gen(function* () {
      const sessions = yield* SessionService;
      const pages: {
        readonly output: ListSessionsOutput;
        readonly statements: number;
      }[] = [];
      let cursor: string | undefined = undefined;
      let exhausted = false;
      for (let page = 0; ; page += 1) {
        const input: ListSessionsInput =
          cursor === undefined ? { limit } : { limit, cursor };
        const counted = yield* countStatements(sessions.list(input));
        pages.push({ output: counted.value, statements: counted.statements });
        cursor = counted.value.nextCursor;
        if (cursor === undefined) {
          exhausted = true;
          break;
        }
        if (page === afterPage - 1) yield* between();
      }
      return { pages, exhausted };
    });

  /**
   * Page the list until the cursor runs out, returning every page with the number of statements
   * it cost.
   *
   * The budget is the caller's, and is a function of the rows the list can see rather than a
   * constant: a budget that is too small shows up as `exhausted: false` rather than as a wrong
   * page count. `start` is the cursor to page on from, for a walk that begins mid-table.
   */
  const pageAll = (
    limit: number,
    budget: number,
    start?: string,
  ): Effect.Effect<
    {
      readonly pages: readonly {
        readonly output: ListSessionsOutput;
        readonly statements: number;
      }[];
      readonly exhausted: boolean;
    },
    SessionError,
    SessionService
  > =>
    Effect.gen(function* () {
      const sessions = yield* SessionService;
      const pages: {
        readonly output: ListSessionsOutput;
        readonly statements: number;
      }[] = [];
      let cursor: string | undefined = start;
      let exhausted = false;
      for (let page = 0; page < budget; page += 1) {
        const input: ListSessionsInput =
          cursor === undefined ? { limit } : { limit, cursor };
        const counted = yield* countStatements(sessions.list(input));
        pages.push({ output: counted.value, statements: counted.statements });
        cursor = counted.value.nextCursor;
        if (cursor === undefined) {
          exhausted = true;
          break;
        }
      }
      return { pages, exhausted };
    });

  /** The rows the list can see, which is the set it has to page over exactly once. */
  const listableRows = Effect.gen(function* () {
    const sql = yield* SqlClient;
    const [rowCount] = yield* sql<{ rows: number }>`
      SELECT count(*)::int AS rows FROM session_activity
    `;
    if (rowCount === undefined) throw new Error("unreachable");
    return rowCount.rows;
  });

  /**
   * What a walk did to the table, minus the one thing it is allowed to do to it (LOB-135).
   *
   * A walk reads a table nothing holds still: `last_activity_at` is the ordering key *and* a
   * column every live event rewrites to "now" (`recordActivity` reaches it through `touch`,
   * `setActivityStatus` and `setActivityCost`), so a row can move while the walk is in flight.
   * Two things follow, and both are real:
   *
   * - **Skip.** A row below the cursor whose key moves *above* it has left the range the walk is
   *   traversing. It is never returned, and `nextCursor` still says the walk is finished, so the
   *   walk reads as complete while being short. The row is not lost: its activity advanced, so it
   *   now belongs at the head and the next walk finds it there.
   * - **Duplicate.** A row already returned whose key moves *back below* the cursor comes back
   *   around. Only `rebuildIndexes` moves a key backwards — every incremental writer sets it to
   *   "now" — so this one needs a whole-table rewrite to reach, and it is still a wrong answer.
   *
   * So the count the cases used to compare against is the wrong instrument twice over: it is read
   * *before* the walk, and rows the walk legitimately never returns were counted in it. This asks
   * the question that has a determinate answer instead — *is every row the walk should have had,
   * did it have, and did it have each one once?* — and reports what is left over.
   *
   * The boundary is the first page's own cursor: the walk traversed everything strictly below it,
   * so a row that is still below it and was not returned is unaccounted for, while a row at or
   * above it left the range legitimately. A one-page walk minted no cursor, traversed everything,
   * and can be short only by a duplicate — which is the other half of this list.
   *
   * Empty is the answer a correct walk gives, whatever else moved: the point is that it is
   * *always* empty when nothing rewrites the table, and the cases below that rewrite it
   * deliberately are the only ones that can ever see a skip.
   */
  const unaccounted = (
    pages: readonly { readonly output: ListSessionsOutput }[],
  ): Effect.Effect<readonly string[], never, SqlClient> =>
    Effect.gen(function* () {
      const returned = pages.flatMap((page) =>
        page.output.sessions.map((entry) => entry.id),
      );
      const seen = new Set<string>();
      const duplicated: string[] = [];
      for (const id of returned) {
        if (seen.has(id)) duplicated.push(id);
        seen.add(id);
      }
      const firstCursor = pages[0]?.output.nextCursor;
      if (firstCursor === undefined) return [...duplicated].sort();
      // The instant half of `at|id`, which is the exact `timestamptz` page 1 ordered by.
      const at = firstCursor.slice(0, firstCursor.indexOf("|"));
      const sql = yield* SqlClient;
      const rows = yield* sql<{ sessionId: string }>`
        SELECT session_id AS "sessionId" FROM session_activity
        WHERE last_activity_at < ${at}::timestamptz
      `.pipe(Effect.orDie);
      const belowCursor = rows
        .map((row) => row.sessionId)
        .filter((id) => !seen.has(id))
        .sort();
      return [
        ...duplicated.map((id) => `returned more than once: ${id}`),
        ...belowCursor.map(
          (id) => `below the first cursor, never returned: ${id}`,
        ),
      ];
    });

  /**
   * A group that is exactly one page big, so the cursor is minted only because the query fetches
   * `limit + 1` rows.
   *
   * `rows.length > limit` is the whole decision about whether another page exists. With the group
   * the newest thing in the table and the same size as the page, the page is full of group rows and
   * the one extra row the query fetched is what says there is more.
   *
   * This is a control, not a boundary case, and it passes against the unfixed code: the whole
   * group fits in the first page, so a millisecond-truncated cursor skips *past* the group instead
   * of splitting it. What it pins is the ordinary path and the last page — the group is the head of
   * page 1, every row below it still comes back, and the walk ends because the cursor ran out
   * rather than because a boundary truncated it. A fix that special-cased same-millisecond groups
   * and broke the walk, or that minted a cursor past the end of the table, fails here rather than
   * in the two cases below.
   *
   * The name says what it pins rather than what the fix does: it deliberately does *not* pin cursor
   * precision, because a group inside one page cannot expose it. The cases that do are the ones
   * that page a group in two.
   */
  it("returns a same-millisecond group that is exactly one page, and mints no cursor past the end", async () => {
    const result = await program(
      withGroup(
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          const GROUP = 4;
          const LIMIT = 4;
          // Newer than anything the table holds, with non-zero microseconds: a timestamp
          // whose millisecond rendering is already lossless would not trigger the bug.
          yield* seedGroup(GROUP, yield* newestInstant);
          // Older than the group, and enough of them that the table does not end with the group —
          // otherwise `rows.length > limit` is false and there is no cursor to mint at all.
          yield* sql`
            INSERT INTO sessions (id, title)
            SELECT 'ses_mn' || lpad(n::text, 24, '0'), 'older ' || n
            FROM generate_series(0, 6) AS g(n)
          `;
          yield* sql`
            INSERT INTO session_activity (session_id, last_activity_at)
            SELECT 'ses_mn' || lpad(n::text, 24, '0'),
                   now() - make_interval(secs => 60 + n)
            FROM generate_series(0, 6) AS g(n)
          `;

          const visible = yield* listableRows;
          const { pages, exhausted } = yield* pageAll(
            LIMIT,
            Math.ceil(visible / LIMIT) + 2,
          );
          const leftOver = yield* unaccounted(pages);
          return { GROUP, LIMIT, pages, exhausted, visible, leftOver };
        }),
      ),
    );

    const entries = result.pages.flatMap((page) => page.output.sessions);
    const group = entries.filter((entry) => entry.id.startsWith(GROUP_PREFIX));
    // The whole group, exactly once, in the keyset's own order.
    expect(group.map((entry) => entry.id)).toEqual(
      groupIdsDescending(result.GROUP),
    );
    // Exactly once across the whole walk, not only for the group: `toBeGreaterThanOrEqual` below
    // tolerates a duplicate, so a keyset that re-served a row on a boundary could pass every
    // other assertion here while the list handed the dashboard the same session twice.
    expect(new Set(entries.map((entry) => entry.id)).size).toBe(entries.length);
    // The group is the newest thing in the table, so it is the head of the first page: it cannot
    // be dropped by a boundary below it.
    expect(entries.slice(0, result.GROUP).map((entry) => entry.id)).toEqual(
      groupIdsDescending(result.GROUP),
    );
    // The loop ended because the cursor ran out, not because it hit its budget.
    expect(result.exhausted).toBe(true);
    expect(result.pages.at(-1)?.output.nextCursor).toBeUndefined();
    // Every row the list can see came back, so the group's exactness is not being paid for with
    // the older rows behind it.
    // Every row the walk should have had came back, once. Not `entries.length >= visible`:
    // `visible` was counted before the walk, and the ordering key is rewritten to "now" by every
    // live event, so a row can legitimately leave the range mid-walk (LOB-135). `leftOver` is empty
    // for that and names anything else.
    expect(result.leftOver).toEqual([]);
    // Cost is one statement per page whatever the row count: never a fold per session (R6).
    for (const page of result.pages) expect(page.statements).toBe(1);
  });

  /**
   * A group paged one row at a time, so every single page boundary falls inside the group.
   *
   * This is the sharpest form of the defect: the cursor is minted from a group row on every page,
   * and a millisecond-truncated one drops the rest of the group every time, not once.
   */
  it("returns a same-millisecond group one row at a time", async () => {
    const result = await program(
      withGroup(
        Effect.gen(function* () {
          const sessions = yield* SessionService;
          const sql = yield* SqlClient;
          const GROUP = 5;
          yield* seedGroup(GROUP, yield* newestInstant);
          yield* sql`
            INSERT INTO sessions (id, title)
            SELECT 'ses_mn' || lpad(n::text, 24, '0'), 'older ' || n
            FROM generate_series(0, 4) AS g(n)
          `;
          yield* sql`
            INSERT INTO session_activity (session_id, last_activity_at)
            SELECT 'ses_mn' || lpad(n::text, 24, '0'),
                   now() - make_interval(secs => 60 + n)
            FROM generate_series(0, 4) AS g(n)
          `;

          const visible = yield* listableRows;
          const { pages, exhausted } = yield* pageAll(
            1,
            Math.ceil(visible / 1) + 2,
          );
          // `limit: 0` is clamped to 1 by the service rather than refused: one row, and a cursor,
          // so the clamp does not silently mean "no pages".
          const clamped = yield* sessions.list({ limit: 0 });
          const leftOver = yield* unaccounted(pages);
          return { GROUP, pages, exhausted, clamped, leftOver };
        }),
      ),
    );

    const entries = result.pages.flatMap((page) => page.output.sessions);
    const group = entries.filter((entry) => entry.id.startsWith(GROUP_PREFIX));
    expect(group.map((entry) => entry.id)).toEqual(
      groupIdsDescending(result.GROUP),
    );
    expect(new Set(group).size).toBe(group.length);
    // Every page the group spans mints a cursor from a group row, so the group spans exactly one
    // page per row — a cursor that dropped the rest of the millisecond would show up here as a
    // short count, not as a wrong order.
    const groupPages = result.pages.filter((page) =>
      page.output.sessions.some((entry) => entry.id.startsWith(GROUP_PREFIX)),
    );
    expect(groupPages.length).toBe(result.GROUP);
    expect(result.exhausted).toBe(true);
    for (const page of result.pages) expect(page.statements).toBe(1);

    expect(result.clamped.sessions.length).toBe(1);
    expect(result.clamped.nextCursor).toBeDefined();
  });

  /**
   * A group that sits whole inside a page larger than it, so the cursor that carries the paging
   * past the group comes from a row *after* it.
   *
   * The second control, and it also passes against the unfixed code: the group is wholly inside
   * the first page, so no cursor is ever minted from a group row and no cursor can split it. What
   * it pins is the walk itself — the rows *below* the group have to keep coming back, exactly once,
   * on the pages after it (`entries.length >= visible`). A fix that special-cased same-millisecond
   * groups and broke the ordinary path fails here.
   */
  it("returns a same-millisecond group that sits inside a larger page", async () => {
    const result = await program(
      withGroup(
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          const GROUP = 3;
          yield* seedGroup(GROUP, yield* newestInstant);
          yield* sql`
            INSERT INTO sessions (id, title)
            SELECT 'ses_mn' || lpad(n::text, 24, '0'), 'older ' || n
            FROM generate_series(0, 11) AS g(n)
          `;
          yield* sql`
            INSERT INTO session_activity (session_id, last_activity_at)
            SELECT 'ses_mn' || lpad(n::text, 24, '0'),
                   now() - make_interval(secs => 60 + n)
            FROM generate_series(0, 11) AS g(n)
          `;

          const visible = yield* listableRows;
          const { pages, exhausted } = yield* pageAll(
            10,
            Math.ceil(visible / 10) + 2,
          );
          const leftOver = yield* unaccounted(pages);
          return { GROUP, pages, exhausted, visible, leftOver };
        }),
      ),
    );

    const entries = result.pages.flatMap((page) => page.output.sessions);
    const group = entries.filter((entry) => entry.id.startsWith(GROUP_PREFIX));
    expect(group.map((entry) => entry.id)).toEqual(
      groupIdsDescending(result.GROUP),
    );
    expect(new Set(group).size).toBe(group.length);
    expect(result.exhausted).toBe(true);
    // Every row the walk should have had came back, once. Not `entries.length >= visible`:
    // `visible` was counted before the walk, and the ordering key is rewritten to "now" by every
    // live event, so a row can legitimately leave the range mid-walk (LOB-135). `leftOver` is empty
    // for that and names anything else.
    expect(result.leftOver).toEqual([]);
    for (const page of result.pages) expect(page.statements).toBe(1);
  });

  /**
   * A group at the very end of the ordering — the oldest rows, not the newest.
   *
   * The cursor that reaches this group is minted from a row *above* it, so a different instant,
   * and the group is found by comparison rather than by being the head of the first page. The
   * page that starts inside the group then mints a cursor from a group row, and the next page has
   * to come back for the rest of the group instead of skipping past it.
   */
  it("returns a same-millisecond group at the end of the ordering", async () => {
    const result = await program(
      withGroup(
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          const GROUP = 5;
          // However old the table already is: the group has to be the end of the ordering,
          // whatever else is in it.
          // The subtraction is parenthesised: `AT TIME ZONE` binds to the interval on its left,
          // so without them Postgres reads `interval '1 hour' AT TIME ZONE 'UTC'` and rejects the
          // statement (42883) rather than shifting the instant.
          //
          // The sub-millisecond part is pinned rather than inherited. `min(last_activity_at)` in
          // a table this old tends to be millisecond-aligned, so a group placed at
          // `min - 1 hour` inherits an alignment that renders losslessly at millisecond precision
          // — the truncated cursor would drop nothing and the case would pass against the
          // unfixed code. Truncating to the second and adding a fixed `.123456` makes the loss
          // deterministic whatever the table holds.
          const [oldest] = yield* sql<{ at: string }>`
            SELECT to_char(
              (
                date_trunc(
                  'seconds',
                  COALESCE(min(last_activity_at), now()) - interval '1 hour'
                ) + interval '0.123456 seconds'
              ) AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
            ) AS at
            FROM session_activity
          `;
          if (oldest === undefined) throw new Error("unreachable");
          yield* seedGroup(GROUP, oldest.at);
          // Newer than the group, at second spacing so none of them ties with it.
          yield* sql`
            INSERT INTO sessions (id, title)
            SELECT 'ses_my' || lpad(n::text, 24, '0'), 'newer ' || n
            FROM generate_series(0, 6) AS g(n)
          `;
          yield* sql`
            INSERT INTO session_activity (session_id, last_activity_at)
            SELECT 'ses_my' || lpad(n::text, 24, '0'),
                   now() - make_interval(secs => n)
            FROM generate_series(0, 6) AS g(n)
          `;

          const visible = yield* listableRows;
          const { pages, exhausted } = yield* pageAll(
            2,
            Math.ceil(visible / 2) + 2,
          );
          const leftOver = yield* unaccounted(pages);
          return { GROUP, pages, exhausted, visible, leftOver };
        }),
      ),
    );

    const entries = result.pages.flatMap((page) => page.output.sessions);
    const group = entries.filter((entry) => entry.id.startsWith(GROUP_PREFIX));

    expect(group.map((entry) => entry.id)).toEqual(
      groupIdsDescending(result.GROUP),
    );
    expect(new Set(group).size).toBe(group.length);
    // The group is the tail of the ordering, so it is the tail of the whole walk: nothing after it.
    expect(
      entries.slice(entries.length - result.GROUP).map((entry) => entry.id),
    ).toEqual(groupIdsDescending(result.GROUP));
    expect(result.exhausted).toBe(true);
    // Every row the walk should have had came back, once. Not `entries.length >= visible`:
    // `visible` was counted before the walk, and the ordering key is rewritten to "now" by every
    // live event, so a row can legitimately leave the range mid-walk (LOB-135). `leftOver` is empty
    // for that and names anything else.
    expect(result.leftOver).toEqual([]);
    for (const page of result.pages) expect(page.statements).toBe(1);
  });

  /**
   * A cursor in the old millisecond-only format, fed back in.
   *
   * This pins the boundary of the fix rather than a behaviour anyone wanted. `parseCursor` checks
   * only that the cursor has a `|` and a well-formed id, so a truncated `at` is *accepted* — and
   * then loses every remaining row of that millisecond, because the stored `timestamptz` is
   * strictly greater than the truncated cursor. The code says so itself: nothing can repair a value
   * that has already been rounded. The contrast with the exact cursor on the same page is what
   * makes that visible in one test.
   *
   * A maintainer who hardens `parseCursor` — refusing a cursor it did not mint, as the case after
   * this one does for a malformed one — should expect this case to go red and delete it: refusing is
   * the better answer than answering lossily, and this case exists to show what the choice costs.
   */
  it("accepts a millisecond-truncated cursor and loses the rest of that millisecond", async () => {
    const result = await program(
      withGroup(
        Effect.gen(function* () {
          const sessions = yield* SessionService;
          const GROUP = 6;
          const LIMIT = 4;
          yield* seedGroup(GROUP, yield* newestInstant);

          const first = yield* sessions.list({ limit: LIMIT });
          const boundary = first.sessions.at(-1);
          if (boundary === undefined) throw new Error("unreachable");
          // Exactly what an older build minted from this same page: the rendered millisecond.
          const truncated = `${boundary.lastActivityAt}|${boundary.id}`;
          const exact = first.nextCursor;
          if (exact === undefined) throw new Error("unreachable");

          // The truncated cursor is well-formed, so it is not refused — it is answered, and the
          // answer skips the rest of the group.
          const oldFormat = yield* sessions.list({
            limit: LIMIT,
            cursor: truncated,
          });
          const exactNext = yield* sessions.list({
            limit: LIMIT,
            cursor: exact,
          });

          // Paging on *from the truncated cursor*, the group never comes back.
          const visible = yield* listableRows;
          const { pages } = yield* pageAll(
            LIMIT,
            Math.ceil(visible / LIMIT) + 2,
            truncated,
          );
          return { GROUP, first, truncated, oldFormat, exactNext, pages };
        }),
      ),
    );

    const groupOf = (
      entries: readonly SessionListEntry[],
    ): readonly SessionListEntry[] =>
      entries.filter((entry) => entry.id.startsWith(GROUP_PREFIX));
    // The first page is four of the six, and the cursor an older build would have minted is the
    // rendered millisecond of the row it ended on.
    expect(groupOf(result.first.sessions)).toHaveLength(4);
    expect(result.truncated).toBe(
      `${result.first.sessions.at(-1)?.lastActivityAt}|${result.first.sessions.at(-1)?.id}`,
    );
    expect(result.truncated).not.toBe(result.first.nextCursor);
    // The exact cursor comes back for the remaining two rows of the group.
    expect(groupOf(result.exactNext.sessions).map((entry) => entry.id)).toEqual(
      groupIdsDescending(result.GROUP).slice(4),
    );
    // The truncated cursor is accepted, and its page holds no row of the group at all: the two rows
    // above are skipped by the keyset comparison.
    expect(groupOf(result.oldFormat.sessions)).toEqual([]);
    // Paging on from it, the group is still absent — the loss is permanent for that cursor, not
    // deferred to the next page.
    expect(
      groupOf(result.pages.flatMap((page) => page.output.sessions)),
    ).toEqual([]);
  });

  /**
   * The smallest group the defect needs: two rows sharing a millisecond, with the page boundary
   * between them.
   *
   * Every other case here seeds at least three rows, so a boundary that splits a *pair* — one row
   * on each side of it — is the sharpest form of the repro, and the one the issue measured. A fix
   * that only held for a group larger than the page would pass all of them and still drop the
   * second row here.
   */
  it("returns a two-row same-millisecond group split by the page boundary", async () => {
    const result = await program(
      withGroup(
        Effect.gen(function* () {
          const GROUP = 2;
          const LIMIT = 1;
          yield* seedGroup(GROUP, yield* newestInstant);
          const visible = yield* listableRows;
          const { pages, exhausted } = yield* pageAll(
            LIMIT,
            Math.ceil(visible / LIMIT) + 2,
          );
          const leftOver = yield* unaccounted(pages);
          return { GROUP, pages, exhausted, visible, leftOver };
        }),
      ),
    );

    const entries = result.pages.flatMap((page) => page.output.sessions);
    const group = entries.filter((entry) => entry.id.startsWith(GROUP_PREFIX));
    expect(group.map((entry) => entry.id)).toEqual(
      groupIdsDescending(result.GROUP),
    );
    expect(new Set(group).size).toBe(group.length);
    expect(result.exhausted).toBe(true);
    // Every row the walk should have had came back, once. Not `entries.length >= visible`:
    // `visible` was counted before the walk, and the ordering key is rewritten to "now" by every
    // live event, so a row can legitimately leave the range mid-walk (LOB-135). `leftOver` is empty
    // for that and names anything else.
    expect(result.leftOver).toEqual([]);
    for (const page of result.pages) expect(page.statements).toBe(1);
  });

  /**
   * A group whose millisecond rendering is already lossless — the shape every live writer
   * actually produces.
   *
   * `touchActivity`, `setActivityStatus` and `setActivityCost` all write
   * `to_timestamp(Clock.currentTimeMillis / 1000)`, which is millisecond-aligned by construction,
   * and `rebuildIndexes` renders the column through `to_char(… 'MS')` before storing it. So a
   * real same-millisecond group is lossy in its microseconds only when something else wrote it.
   *
   * This pins the fix's other direction: an exact cursor must not *gain* rows a millisecond
   * cursor would have dropped, nor *lose* rows a millisecond cursor would have kept. The cursor
   * minted here has to denote the very instant the millisecond rendering shows, and the walk
   * still has to return the whole group exactly once.
   */
  it("returns a group whose millisecond rendering is already lossless", async () => {
    const result = await program(
      withGroup(
        Effect.gen(function* () {
          const GROUP = 6;
          const LIMIT = 4;
          // The one case that needs an aligned instant, so it cannot use `newestInstant`: the
          // millisecond rendering is *the* value, the truncated cursor an older build minted was
          // already exact, and the bug had nothing to bite on. `newestInstant` pins `.123456`
          // precisely so the other eight cases cannot inherit that alignment.
          yield* seedGroup(GROUP, yield* alignedInstant);
          const visible = yield* listableRows;
          const { pages, exhausted } = yield* pageAll(
            LIMIT,
            Math.ceil(visible / LIMIT) + 2,
          );
          const leftOver = yield* unaccounted(pages);
          return { GROUP, pages, exhausted, visible, leftOver };
        }),
      ),
    );

    const entries = result.pages.flatMap((page) => page.output.sessions);
    const group = entries.filter((entry) => entry.id.startsWith(GROUP_PREFIX));
    expect(group.map((entry) => entry.id)).toEqual(
      groupIdsDescending(result.GROUP),
    );
    expect(new Set(group).size).toBe(group.length);
    expect(result.exhausted).toBe(true);
    // Every row the walk should have had came back, once. Not `entries.length >= visible`:
    // `visible` was counted before the walk, and the ordering key is rewritten to "now" by every
    // live event, so a row can legitimately leave the range mid-walk (LOB-135). `leftOver` is empty
    // for that and names anything else.
    expect(result.leftOver).toEqual([]);
    for (const page of result.pages) expect(page.statements).toBe(1);

    // The cursor minted from a lossless row has to denote the same instant the millisecond
    // rendering shows — the extra digits are trailing zeros, not extra reach.
    const first = result.pages[0];
    if (first === undefined) throw new Error("unreachable");
    const boundary = first.output.sessions.at(-1);
    if (boundary === undefined) throw new Error("unreachable");
    const firstCursor: string | undefined = first.output.nextCursor;
    if (firstCursor === undefined) throw new Error("unreachable");
    const [firstAt, firstId] = firstCursor.split("|");
    if (firstAt === undefined || firstId === undefined)
      throw new Error("unreachable");
    expect(firstId).toBe(boundary.id);
    expect(Date.parse(firstAt)).toBe(Date.parse(boundary.lastActivityAt));
  });

  /**
   * A group straddling the page-size cap, and a limit larger than the table.
   *
   * `MAX_PAGE_SIZE` is where `Math.min` stops, so the query fetches `MAX_PAGE_SIZE + 1` rows and
   * `rows.length > limit` is decided a hundred rows into the group rather than four. The group
   * is deliberately bigger than the cap, so the boundary falls inside it at the largest limit the
   * service will honour. The second half pins the clamp itself: a limit above the cap is answered
   * with a capped page, not with the whole table.
   */
  it("returns a same-millisecond group straddling the page-size cap", async () => {
    const result = await program(
      withGroup(
        Effect.gen(function* () {
          const sessions = yield* SessionService;
          // Read off the cap rather than written as a literal, so the group stays larger than it
          // when the cap moves: a group that fit inside `MAX_PAGE_SIZE` would make the boundary
          // fall after the group and stop straddling it.
          const GROUP = MAX_PAGE_SIZE + 3;
          yield* seedGroup(GROUP, yield* newestInstant);
          const visible = yield* listableRows;
          const { pages, exhausted } = yield* pageAll(
            MAX_PAGE_SIZE,
            Math.ceil(visible / MAX_PAGE_SIZE) + 2,
          );
          // A limit above the cap is clamped to the cap: the page is capped, and a cursor is
          // still minted because the table is bigger than one capped page. A literal, for the
          // same reason `GROUP` is: `LIMIT ${limit + 1}` needs a type the driver can infer.
          const clamped = yield* sessions.list({ limit: 1100 });
          const leftOver = yield* unaccounted(pages);
          return { GROUP, pages, exhausted, visible, clamped, leftOver };
        }),
      ),
    );

    const entries = result.pages.flatMap((page) => page.output.sessions);
    const group = entries.filter((entry) => entry.id.startsWith(GROUP_PREFIX));
    expect(group.map((entry) => entry.id)).toEqual(
      groupIdsDescending(result.GROUP),
    );
    expect(new Set(group).size).toBe(group.length);
    expect(result.exhausted).toBe(true);
    // Every row the walk should have had came back, once. Not `entries.length >= visible`:
    // `visible` was counted before the walk, and the ordering key is rewritten to "now" by every
    // live event, so a row can legitimately leave the range mid-walk (LOB-135). `leftOver` is empty
    // for that and names anything else.
    expect(result.leftOver).toEqual([]);
    for (const page of result.pages) expect(page.statements).toBe(1);

    expect(result.clamped.sessions.length).toBe(MAX_PAGE_SIZE);
    expect(result.clamped.nextCursor).toBeDefined();
  });

  /**
   * A row whose activity advances above the cursor is skipped, and `unaccounted` accounts for it
   * (LOB-135).
   *
   * This is the shape that turned a green gate red about once in thirty-five runs and was never
   * reproduced by a rerun: `expected 9 to be greater than or equal to 10`, on a case whose cursor
   * arithmetic is exact. It is not a race to reproduce — it is a race to *notice*, because it
   * needs a row to move at the right instant. Here it moves at an instant this case chooses.
   *
   * `recordActivity` is what moves it in production: every live event for an owned session writes
   * `last_activity_at = to_timestamp(Clock.currentTimeMillis / 1000)` through `touch`,
   * `setActivityStatus` or `setActivityCost`, from the per-session projector. A walk that pages
   * slowly enough overlaps one, and the row it moved is one the walk had not reached.
   *
   * The skip is not a defect in the keyset — `lastActivityExact` carries microseconds, so the
   * comparison is exact and the row is skipped for being *newer*, not for being truncated. It is
   * the walk's contract: it traverses what was below its first cursor, and this row is no longer
   * below it. The next walk finds it at the head, which is where a session that just became active
   * belongs. So the assertions are about the *accounting*, not about the count:
   *
   * - the walk finished (`exhausted`), because a cursor running out is not how the row went;
   * - the row was not returned, and is now the newest thing in the table;
   * - a fresh walk returns it, so it was skipped rather than lost;
   * - `unaccounted` is empty — the skip has the reason the helper looks for, and nothing else is
   *   missing.
   *
   * This case pins the *behaviour*, and it is the only one that can: it stages the state, so it is
   * green or red on every run instead of once in thirty-five. It does not pin `unaccounted` — a
   * helper that returned an empty list always would pass it, which is what the two cases below it
   * are for.
   *
   * Mutation checked: `unaccounted`'s `belowCursor` filter to `filter(() => false)`, which hides
   * every unexplained shortfall. This case stays green — its only skip is the one it stages, and
   * that is the skip the helper exists to explain — and so does every other case in this file.
   * That mutation was measured green, which is the reason the case after this one exists.
   */
  it("skips a row whose activity advances above the cursor, and accounts for it", async () => {
    const result = await program(
      withProbe(
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          const sessions = yield* SessionService;
          const PROBE = 5;
          const LIMIT = 1;
          yield* seedProbe(PROBE);
          // Walk by hand rather than through `pageAll`, because the point is to write to the table
          // *between* two pages, and `pageAll` has no seam for that.
          const { pages, exhausted } = yield* walkBetween(LIMIT, 1, () =>
            Effect.orDie(sql`
                UPDATE session_activity
                SET last_activity_at = now() + interval '1 hour'
                WHERE session_id = ${probeId(PROBE)}
              `),
          );
          // The row did not vanish: it is the newest thing in the table, and a walk that starts
          // now returns it first.
          const head = yield* sessions.list({ limit: 1 });
          const leftOver = yield* unaccounted(pages);
          return { PROBE, LIMIT, pages, exhausted, head, leftOver };
        }),
      ),
    );

    expect(result.exhausted).toBe(true);
    const returned = result.pages.flatMap((page) =>
      page.output.sessions.map((entry) => entry.id),
    );
    // Every probe row but the moved one came back, in order, once each. The table holds more than
    // the probe, so the walk is over the whole thing and only the probe ids are claimed here.
    expect(returned.filter((id) => id.startsWith(PROBE_PREFIX))).toEqual(
      [1, 2, 3, 4].map((n) => probeId(n)),
    );
    // A fresh walk finds it at the head, so it was skipped and not lost.
    expect(result.head.sessions.map((entry) => entry.id)).toEqual([
      probeId(result.PROBE),
    ]);
    // Explained, and nothing else is missing.
    expect(result.leftOver).toEqual([]);
  });

  /**
   * A row whose activity is rewound below the cursor comes back around, and `unaccounted` names it
   * (LOB-135).
   *
   * The mirror image of the case above, and the one that keeps the helper honest. A walk that only
   * ever skipped rows could still be reporting the wrong thing, and a helper that returned an empty
   * list always would pass every other case in this file. So this case stages the direction that is
   * *not* legitimate — no incremental writer moves a key backwards, so the only thing that can is
   * `rebuildIndexes` rewriting the whole table — and asserts the helper says so by name.
   *
   * Mutation checked: `unaccounted`'s `duplicated` accumulator to never push, which is what a
   * helper that only looked for missing rows would look like. This case goes red on
   * `expect(result.leftOver).toEqual([...])`, naming the row.
   */
  it("names a row the walk returns twice after its activity is rewound", async () => {
    const result = await program(
      withProbe(
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          const PROBE = 5;
          const LIMIT = 1;
          yield* seedProbe(PROBE);
          const { pages, exhausted } = yield* walkBetween(LIMIT, 1, () =>
            Effect.orDie(sql`
                UPDATE session_activity
                SET last_activity_at = now() - interval '1 hour'
                WHERE session_id = ${probeId(1)}
              `),
          );
          const leftOver = yield* unaccounted(pages);
          return { PROBE, LIMIT, pages, exhausted, leftOver };
        }),
      ),
    );

    expect(result.exhausted).toBe(true);
    expect(result.leftOver).toEqual([`returned more than once: ${probeId(1)}`]);
  });

  /**
   * A row the walk left below its first cursor is named, not counted (LOB-135).
   *
   * The half of `unaccounted` that names *missing* rows has no walk to catch it, because on
   * unmutated code a row below the first cursor always comes back — that is the whole of what the
   * exact cursor buys (LOB-95) — and reverting it reddens six cases in this file on their group
   * assertions, not on this helper. So this case does not stage a walk. It stages the **output** of
   * a broken one.
   *
   * One real page against the seeded ladder, taken from the real list and carrying the real
   * cursor, and then the walk stops. Rows 2 to 5 are below that cursor and were never returned —
   * which is what LOB-135 saw, except there the walk also claimed to be finished. So the rule is
   * pinned against a helper that quietly stopped looking: mutating `belowCursor`'s filter to
   * `filter(() => false)` — a helper that finds missing rows by not looking for them — leaves
   * every other case in this file green and this one red. Measured: that mutation was green
   * before this case existed, which is why it is here.
   *
   * Mutation checked: `.filter((id) => !seen.has(id))` → `.filter(() => false)`. This case goes red
   * on the assertion below, which names all four probe rows.
   */
  it("names a row the walk left below its first cursor", async () => {
    const result = await program(
      withProbe(
        Effect.gen(function* () {
          const sessions = yield* SessionService;
          const PROBE = 5;
          yield* seedProbe(PROBE);
          const counted = yield* countStatements(sessions.list({ limit: 1 }));
          // A one-page walk that stops with a cursor still in hand: the shape of a list that
          // drops the rest of the table, and of a caller that pages once and gives up.
          const firstCursor = counted.value.nextCursor;
          if (firstCursor === undefined) throw new Error("unreachable");
          const leftOver = yield* unaccounted([{ output: counted.value }]);
          return { PROBE, firstCursor, leftOver };
        }),
      ),
    );

    // Only the probe rows are claimed: the table also holds every row the cases before this one
    // created, and those are below the cursor too, so the helper names them as well — which is
    // the helper working, not noise. Row 1 is absent from the list because the page returned it.
    expect(
      result.leftOver.filter((entry) => entry.includes(PROBE_PREFIX)),
    ).toEqual(
      [2, 3, 4, 5].map(
        (n) => `below the first cursor, never returned: ${probeId(n)}`,
      ),
    );
  });

  it("refuses a cursor it did not mint", async () => {
    const outcome = await program(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        return yield* Effect.exit(sessions.list({ cursor: "not-a-cursor" }));
      }),
    );
    expect(Exit.isFailure(outcome)).toBe(true);
    if (Exit.isSuccess(outcome)) throw new Error("unreachable");
    const failure = Exit.findErrorOption(outcome);
    if (failure._tag !== "Some") throw new Error("unreachable");
    expect(failure.value.code).toBe("invalid_input");
  });

  // The fold is global by design (D7): `rebuildIndexes` replays every commit the database holds,
  // log by log, so this case's cost is the whole database's, not the one session it asserts on.
  // That was the whole shared database when this case ran against whatever `DATABASE_URL` named:
  // ~670 session logs / 11 754 commits measured 5.8-6.0 s on 2026-10-06, so the case needed a
  // 30 000 budget that expired at ~4 050 logs (LOB-113), and its `DELETE FROM sessions` reached
  // every session on the machine (LOB-96). Both costs go with two fixes: this file runs against a
  // database of its own (the block above), so the delete below and the fold that follows are about
  // this run's rows; and the fold itself is batched (LOB-115), so it no longer costs round trips
  // per log or per index row. Measured against the run-context database's 2 883 session logs, the
  // fold went 23 050 ms -> 818 ms and writes byte-identical rows; here it is a handful of rows.
  //
  // Mutation checked: `rebuild.ts`'s `logs.filter((log) => Schema.is(SessionId)(log.logId))` to
  // `logs.filter(() => false)`, which makes the fold restore nothing — this case goes red 1 of 22
  // on `expect(result.report.sessions).toBeGreaterThan(0)`, which is the first assertion the
  // emptied index reaches, and `describe("this suite's database")` stays green because the fold's
  // job and the isolation's are separate claims and each is worth its own case.
  it("rebuilds the index from the log after the index tables are emptied", async () => {
    const result = await program(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const sql = yield* SqlClient;
        yield* sessions.registerRepo({
          repo: factoryRepo,
          url: "https://github.com/lobiklukas/factory.git",
          localPath: repoRoot,
        });
        // The database's own clock, read outside any transaction: `created_at` and `committed_at`
        // are both its `now()`, so the window they must fall in is measured on that same clock.
        const databaseNow = sql<{ readonly now: string }>`
          SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now
        `.pipe(Effect.map((rows) => rows[0]?.now ?? ""));
        const createStarted = yield* databaseNow;
        const created = yield* sessions.create({
          repo: factoryRepo,
          baseRef: "main",
          title: "rebuild me",
        });
        const createReturned = yield* databaseNow;
        yield* sessions.send({ sessionId: created.id, content: "say hello" });
        yield* waitUntil(
          sessions
            .get(created.id)
            .pipe(Effect.map((snapshot) => !snapshot.live.busy)),
          "the turn to settle",
        );

        const find = (entries: readonly SessionListEntry[]) =>
          entries.find((entry) => entry.id === created.id);
        const before = find((yield* sessions.list({ limit: 100 })).sessions);
        // The list's cost is the index column, not a fold per read (R6): a corrupted column is
        // what the list shows, and the rebuild below is what puts the log's number back. Both
        // halves matter for LOB-153 — the fold has to write `cost_total` from `pi.usage`, or a
        // stale number would outlive the repair.
        //
        // Corrupted until the list reads it back, not once: the index is written by the activity
        // stream, which can still be applying the turn's `usage` event after `busy` reads false,
        // and that late write put the log's 0 back over a single 9.99 (LOB-237; seen once in a
        // dozen runs under load). A list that folded the log per read would never show 9.99, so
        // the wait times out on exactly the regression the corruption exists to catch.
        let corrupted: SessionListEntry | undefined;
        yield* waitUntil(
          Effect.gen(function* () {
            yield* sql`UPDATE session_activity SET cost_total = 9.99 WHERE session_id = ${created.id}`;
            corrupted = find((yield* sessions.list({ limit: 100 })).sessions);
            return corrupted?.costTotal === 9.99;
          }),
          "the list to show the corrupted cost column",
        );

        // Drop the derived rows, as losing an index table would. Every row, not just this case's:
        // the claim under test is that the whole index comes back from the log, and the database
        // this runs against is the run's own (LOB-96), so the whole means whole.
        yield* sql`DELETE FROM sessions`;
        const empty = (yield* sessions.list({ limit: 100 })).sessions.length;

        const report = yield* rebuildIndexes;
        const after = find((yield* sessions.list({ limit: 100 })).sessions);
        const repos = yield* sql<{
          slug: string;
          url: string;
          defaultBaseRef: string;
        }>`
          SELECT slug, url, default_base_ref FROM repos WHERE slug = ${factoryRepo}
        `;
        return {
          before,
          corrupted,
          empty,
          report,
          after,
          repos,
          createStarted,
          createReturned,
        };
      }),
    );

    expect(result.corrupted?.costTotal).toBe(9.99);
    expect(result.empty).toBe(0);
    expect(result.report.sessions).toBeGreaterThan(0);
    expect(result.after).toBeDefined();
    if (result.before === undefined || result.after === undefined)
      throw new Error("unreachable");
    // Everything the list shows is recovered from the log alone.
    expect(result.after.id).toBe(result.before.id);
    expect(result.after.title).toBe("rebuild me");
    expect(result.after.repo).toBe("lobiklukas/factory");
    expect(result.after.baseRef).toBe("main");
    expect(result.after.costTotal).toEqual(result.before.costTotal);
    // Two clocks describe the same moment: the index row is written when the session is created,
    // the rebuilt one when its first commit landed: both inside the one `create` call, not a
    // different session. The bound is that call's own window on the database's clock, not a fixed
    // gap: during a gate run beside other worktrees' gates the two were 1 449 ms apart and a
    // `< 1000` ms bound went red (LOB-237). Mutation: have the fold take `max(committed_at)`
    // instead of `min` — the turn's commits land after `create` returned, and the rebuilt moment
    // leaves the window.
    for (const createdAt of [result.before.createdAt, result.after.createdAt]) {
      expect(Date.parse(createdAt)).toBeGreaterThanOrEqual(
        Date.parse(result.createStarted),
      );
      expect(Date.parse(createdAt)).toBeLessThanOrEqual(
        Date.parse(result.createReturned),
      );
    }
    // A slug the log names is back with no URL; an operator's URL survives.
    expect(result.repos[0]?.slug).toBe("lobiklukas/factory");
    expect(result.repos[0]?.url).toBe(
      "https://github.com/lobiklukas/factory.git",
    );
    expect(result.repos[0]?.defaultBaseRef).toBe("main");
  });

  // The fold writes its index rows as one `INSERT … SELECT FROM unnest(…)` per batch rather than
  // one statement per row (LOB-115). That is a change of SQL shape with no change of meaning, and
  // the shape has one thing the per-row statements did not have to get right: a column's NULLs
  // arrive inside an array. A scratch session is the row that has them — `repo` and `base_ref` are
  // both NULL, and `session_activity.status` is 'idle' for every row in a batch, so a status array
  // that were one element long would pad the rest with NULL and fail the NOT NULL. So this case is
  // about columns that are NULL, columns that are constant, and two slugs in one batch.
  it("folds a batch of logs into index rows, including a scratch session's NULL repo", async () => {
    const otherRepo = RepoSlugSchema.make("lobiklukas/other");
    const result = await program(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const sql = yield* SqlClient;
        yield* sessions.registerRepo({
          repo: factoryRepo,
          url: "https://github.com/lobiklukas/factory.git",
          localPath: repoRoot,
        });
        const onMain = yield* sessions.create({
          repo: factoryRepo,
          baseRef: "main",
          title: "batch main",
        });
        const onFeature = yield* sessions.create({
          repo: otherRepo,
          baseRef: "feature/board",
          title: "batch feature",
        });
        const scratch = yield* sessions.create({ title: "batch scratch" });
        yield* sessions.send({ sessionId: onMain.id, content: "hello" });
        yield* sessions.send({ sessionId: onFeature.id, content: "hello" });
        yield* sessions.send({ sessionId: scratch.id, content: "hello" });
        for (const id of [onMain.id, onFeature.id, scratch.id]) {
          yield* waitUntil(
            sessions
              .get(id)
              .pipe(Effect.map((snapshot) => !snapshot.live.busy)),
            "the turn to settle",
          );
        }

        yield* sql`DELETE FROM sessions`;
        const report = yield* rebuildIndexes;

        const rows = yield* sql<{
          id: string;
          title: string;
          repo: string | null;
          baseRef: string | null;
          requestId: string | null;
        }>`
          SELECT id, title, repo, base_ref AS "baseRef", request_id AS "requestId"
          FROM sessions
          WHERE id = ANY(${[onMain.id, onFeature.id, scratch.id]})
          ORDER BY title
        `;
        const activity = yield* sql<{
          sessionId: string;
          status: string;
          lastActivityAt: string;
        }>`
          SELECT session_id AS "sessionId", status, last_activity_at AS "lastActivityAt"
          FROM session_activity
          WHERE session_id = ANY(${[onMain.id, onFeature.id, scratch.id]})
          ORDER BY session_id
        `;
        const repos = yield* sql<{ slug: string; defaultBaseRef: string }>`
          SELECT slug, default_base_ref AS "defaultBaseRef"
          FROM repos
          WHERE slug = ANY(${[factoryRepo, otherRepo]})
          ORDER BY slug
        `;
        return { report, rows, activity, repos };
      }),
    );

    expect(result.report.sessions).toBeGreaterThanOrEqual(3);
    expect(result.rows).toEqual([
      {
        id: expect.any(String),
        title: "batch feature",
        repo: "lobiklukas/other",
        baseRef: "feature/board",
        requestId: null,
      },
      {
        id: expect.any(String),
        title: "batch main",
        repo: "lobiklukas/factory",
        baseRef: "main",
        requestId: null,
      },
      {
        id: expect.any(String),
        title: "batch scratch",
        repo: null,
        baseRef: null,
        requestId: null,
      },
    ]);
    // 'idle' for every row of the batch, not the first: a rebuild owns nothing (D8).
    expect(result.activity.map((row) => row.status)).toEqual([
      "idle",
      "idle",
      "idle",
    ]);
    expect(
      result.activity.every((row) => Date.parse(row.lastActivityAt) > 0),
    ).toBe(true);
    // A slug a log names arrives with no URL; the one registered keeps its default base ref.
    expect(result.repos).toEqual([
      { slug: "lobiklukas/factory", defaultBaseRef: "main" },
      { slug: "lobiklukas/other", defaultBaseRef: "feature/board" },
    ]);
  });
});

describe("approvals", () => {
  it("records a request, settles it with the caller's actor, and drops it from the pending list", async () => {
    const outcome = await program(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const created = yield* sessions.create({ title: "approvals" });
        const before = (yield* sessions.get(created.id)).entries.length;
        const request = yield* sessions.requestApproval({
          sessionId: created.id,
          requestId: "apr-1",
          action: "push refs/heads/main",
          detail: "from the agent",
        });
        const afterRequest = yield* sessions.get(created.id);
        const pending = yield* sessions.listApprovals(created.id);
        const decision = yield* sessions.decideApproval({
          sessionId: created.id,
          requestId: "apr-1",
          decision: "denied",
          actor: "lukas@laptop",
        });
        const afterDecision = yield* sessions.get(created.id);
        const remaining = yield* sessions.listApprovals(created.id);
        return {
          request,
          pending,
          decision,
          remaining,
          appended: [
            afterRequest.entries.length - before,
            afterDecision.entries.length - afterRequest.entries.length,
          ],
          sessionId: created.id,
        };
      }),
    );
    expect(outcome.request.action).toBe("push refs/heads/main");
    expect(outcome.request.requestId).toBe("apr-1");
    expect(outcome.pending.approvals).toEqual([outcome.request]);
    expect(outcome.decision.decision).toBe("denied");
    expect(outcome.decision.actor).toBe("lukas@laptop");
    expect(outcome.decision.sessionId).toBe(outcome.sessionId);
    expect(outcome.remaining.approvals).toEqual([]);
    // One log entry for the request and one for the decision: the record is in the log, not only here.
    expect(outcome.appended).toEqual([1, 1]);
  });

  it("does not create a second pending row for a repeated request id", async () => {
    const outcome = await program(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const created = yield* sessions.create({ title: "repeat" });
        const first = yield* sessions.requestApproval({
          sessionId: created.id,
          requestId: "apr-dup",
          action: "push",
        });
        const again = yield* sessions.requestApproval({
          sessionId: created.id,
          requestId: "apr-dup",
          action: "push",
        });
        const pending = yield* sessions.listApprovals(created.id);
        const entries = (yield* sessions.get(created.id)).entries.filter(
          (entry) => entry.kind === "other",
        );
        return { first, again, pending, entries: entries.length };
      }),
    );
    expect(outcome.again).toEqual(outcome.first);
    expect(outcome.pending.approvals).toHaveLength(1);
    expect(outcome.entries).toBe(1);
  });

  it("refuses a decision on a request that was never made", async () => {
    const outcome = await program(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const created = yield* sessions.create({ title: "unknown" });
        return yield* Effect.exit(
          sessions.decideApproval({
            sessionId: created.id,
            requestId: "apr-missing",
            decision: "approved",
            actor: "lukas",
          }),
        );
      }),
    );
    const failure = Exit.findErrorOption(outcome);
    expect(failure._tag).toBe("Some");
    if (failure._tag !== "Some") throw new Error("unreachable");
    expect(failure.value.code).toBe("not_found");
  });

  it("refuses a second, different decision on a settled request", async () => {
    const outcome = await program(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const created = yield* sessions.create({ title: "settled" });
        yield* sessions.requestApproval({
          sessionId: created.id,
          requestId: "apr-settled",
          action: "push",
        });
        yield* sessions.decideApproval({
          sessionId: created.id,
          requestId: "apr-settled",
          decision: "approved",
          actor: "lukas",
        });
        return yield* Effect.exit(
          sessions.decideApproval({
            sessionId: created.id,
            requestId: "apr-settled",
            decision: "denied",
            actor: "lukas",
          }),
        );
      }),
    );
    const failure = Exit.findErrorOption(outcome);
    expect(failure._tag).toBe("Some");
    if (failure._tag !== "Some") throw new Error("unreachable");
    expect(failure.value.code).toBe("invalid_input");
  });
});

/**
 * The operator's inbox (LOB-53): every session's pending requests from one read, which is what the
 * dashboard's `/approvals` pane and `factory approvals` list. Other cases in this file leave requests
 * pending in the same database, so each assertion is about this case's sessions.
 */
describe("every session's pending approvals", () => {
  it("lists the pending requests of every session, newest first, and drops a decided one", async () => {
    const outcome = await program(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const first = yield* sessions.create({ title: "inbox one" });
        const second = yield* sessions.create({ title: "inbox two" });
        const a = yield* sessions.requestApproval({
          sessionId: first.id,
          requestId: "inbox-a",
          action: "push",
        });
        const b = yield* sessions.requestApproval({
          sessionId: second.id,
          requestId: "inbox-b",
          action: "publish",
          detail: "npm publish",
        });
        const c = yield* sessions.requestApproval({
          sessionId: first.id,
          requestId: "inbox-c",
          action: "deploy",
        });
        const mine = new Set<string>([first.id, second.id]);
        const ours = (output: { approvals: readonly ApprovalRequest[] }) =>
          output.approvals.filter((request) => mine.has(request.sessionId));
        const before = ours(yield* sessions.listPendingApprovals({}));
        yield* sessions.decideApproval({
          sessionId: second.id,
          requestId: "inbox-b",
          decision: "approved",
          actor: "ops",
        });
        const after = ours(yield* sessions.listPendingApprovals({}));
        const clamped = yield* sessions.listPendingApprovals({ limit: 0 });
        const capped = yield* sessions.listPendingApprovals({
          limit: MAX_PAGE_SIZE + 50,
        });
        return { a, b, c, before, after, clamped, capped };
      }),
    );
    // Across sessions, newest ask first — not grouped by session.
    expect(outcome.before).toEqual([outcome.c, outcome.b, outcome.a]);
    expect(outcome.after).toEqual([outcome.c, outcome.a]);
    // A page is at least one row and at most the service's page cap.
    expect(outcome.clamped.approvals).toHaveLength(1);
    expect(outcome.capped.approvals.length).toBeLessThanOrEqual(MAX_PAGE_SIZE);
    // A page of one is the newest ask: stale requests cannot push a run that just parked off it.
    expect(outcome.clamped.approvals[0]).toEqual(outcome.c);
    // `total` counts every pending request, so a cut page says it was cut.
    expect(outcome.clamped.total).toBeGreaterThanOrEqual(2);
    expect(outcome.clamped.total).toBeGreaterThan(
      outcome.clamped.approvals.length,
    );
    expect(outcome.capped.total).toBeGreaterThanOrEqual(
      outcome.capped.approvals.length,
    );
  });

  it("decides without touching the session when the caller does not ask to resume it", async () => {
    const outcome = await program(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const created = yield* sessions.create({ title: "no resume" });
        yield* sessions.requestApproval({
          sessionId: created.id,
          requestId: "quiet",
          action: "push",
        });
        const decision = yield* sessions.decideApproval({
          sessionId: created.id,
          requestId: "quiet",
          decision: "approved",
          actor: "ops",
          resume: false,
        });
        return { decision, snapshot: yield* sessions.get(created.id) };
      }),
    );
    expect(outcome.decision.resumedWith).toBeUndefined();
    expect(outcome.decision.resumeFailed).toBeUndefined();
    expect(
      outcome.snapshot.entries.filter((entry) => entry.kind === "user"),
    ).toEqual([]);
  });

  it("answers a recorded decision whose resume failed with resumeFailed, not a failure", async () => {
    const outcome = await program(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const created = yield* sessions.create({ title: "resume fails" });
        // An action long enough that the follow-up naming it is over the message limit, so the
        // send after the commit is refused.
        yield* sessions.requestApproval({
          sessionId: created.id,
          requestId: "unsendable",
          action: "x".repeat(MAX_MESSAGE_CHARS),
        });
        const decide = sessions.decideApproval({
          sessionId: created.id,
          requestId: "unsendable",
          decision: "approved",
          actor: "ops",
          resume: true,
        });
        const decision = yield* decide;
        // The retry a caller is told to make: the same decision again, idempotent.
        const again = yield* decide;
        return {
          decision,
          again,
          pending: yield* sessions.listApprovals(created.id),
          snapshot: yield* sessions.get(created.id),
        };
      }),
    );
    // The decision is on file and no longer pending...
    expect(outcome.decision).toMatchObject({
      requestId: "unsendable",
      decision: "approved",
      actor: "ops",
    });
    expect(outcome.pending.approvals).toEqual([]);
    // ...and the answer says the session was not resumed, with the send's own code.
    expect(outcome.decision.resumedWith).toBeUndefined();
    expect(outcome.decision.resumeFailed?.code).toBe("invalid_input");
    expect(outcome.again.decidedAt).toBe(outcome.decision.decidedAt);
    expect(outcome.again.resumeFailed?.code).toBe("invalid_input");
    expect(
      outcome.snapshot.entries.filter((entry) => entry.kind === "user"),
    ).toEqual([]);
  });
});

/**
 * An approval is durable across release (LOB-147): the request is committed into the log, and both
 * answers to "what is waiting" are folds of it — the snapshot folds the entries, the list reads the
 * `session_approvals` row that indexes them, and `rebuildIndexes` re-derives the row from the log.
 */
describe("approvals after the owner is released", () => {
  it("reports the pending approval from the fold, twice, and re-asks for nothing", async () => {
    const outcome = await program(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const created = yield* sessions.create({ title: "durable approvals" });
        const request = yield* sessions.requestApproval({
          sessionId: created.id,
          requestId: "apr-durable",
          action: "push refs/heads/main",
          detail: "a person has to answer this",
        });
        // The row is written with the request, so the pending list answers before anything folds.
        const indexed = yield* sessions.listApprovals(created.id);

        // Release the owner: from here the session is read by folding its log (D8).
        yield* sessions.close;
        const folded = yield* sessions.get(created.id);
        const refolded = yield* sessions.get(created.id);
        const listed = yield* sessions.listApprovals(created.id);
        // A repeat after the release reads what the first request left behind — the row and the
        // entry — rather than asking again.
        const repeated = yield* sessions.requestApproval({
          sessionId: created.id,
          requestId: "apr-durable",
          action: "push refs/heads/main",
        });
        const entries = (yield* sessions.get(created.id)).entries.filter(
          (entry) => entry.kind === "other",
        ).length;
        // Leave no owner running: an owned session rewrites its own activity row on every event.
        yield* sessions.close;
        return {
          request,
          indexed,
          folded,
          refolded,
          listed,
          repeated,
          entries,
        };
      }),
    );

    expect(outcome.indexed.approvals).toEqual([outcome.request]);
    // The fold, not a remembered set: this snapshot comes from the log alone.
    expect(outcome.folded.session.mode).toBe("historical");
    expect(outcome.folded.approvals).toEqual([outcome.request]);
    // Folding the same log again yields the same list, id by id.
    expect(outcome.refolded.approvals).toEqual(outcome.folded.approvals);
    expect(outcome.listed.approvals).toEqual([outcome.request]);
    expect(outcome.repeated).toEqual(outcome.request);
    // One request, one entry: the retry was answered by the record, not appended beside it.
    expect(outcome.entries).toBe(1);
  }, 120_000);

  it("rebuilds the pending row from the log when the row is lost", async () => {
    const outcome = await program(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        const sessions = yield* SessionService;
        const created = yield* sessions.create({ title: "rebuilt approvals" });
        const request = yield* sessions.requestApproval({
          sessionId: created.id,
          requestId: "apr-rebuilt",
          action: "tag v1",
        });
        yield* sessions.close;
        // Lose the derived row, the way a dropped table or a write killed before it committed
        // loses it. The log still holds the request.
        yield* sql`DELETE FROM session_approvals WHERE session_id = ${created.id}`;
        const withoutRow = yield* sessions.listApprovals(created.id);
        const stillFolded = yield* sessions.get(created.id);
        const report = yield* rebuildIndexes;
        const rebuilt = yield* sessions.listApprovals(created.id);
        return { request, withoutRow, stillFolded, report, rebuilt };
      }),
    );

    // The list is an index: with the row gone it answers nothing until a rebuild refolds.
    expect(outcome.withoutRow.approvals).toEqual([]);
    // The snapshot never depended on the row — it folds the log.
    expect(outcome.stillFolded.approvals).toEqual([outcome.request]);
    expect(outcome.report.sessions).toBeGreaterThan(0);
    expect(outcome.rebuilt.approvals).toEqual([outcome.request]);
  }, 120_000);
});

/**
 * The run's prompt is resolved from its column (docs/board.md B6, LOB-174).
 *
 * The claim is about what the model was *told*, so it is read from the log rather than from the
 * extension that built it: `pi.system` entries are the system prompt Pi Durable replays before a
 * request, and they are committed, so a run that has already answered still says what it was told.
 *
 * Each case makes its own board instance over definition version 2
 * (`0010_seed_pipeline_skills.ts`), the version that binds the seeded skills to their stages, and
 * its own card. Sessions here are scratch ones (no repo), because the column is the only thing
 * under test — a repo would add a clone that says nothing about the prompt.
 */
/**
 * Cited knowledge pages (LOB-204, part 1 of LOB-47).
 *
 * A page is a log fact and a derived row: `recordPage` commits the `factory.page` document and the
 * entry that announces it, `listPages` reads the rows, and `rebuildIndexes` refills those rows from
 * the entries. The three cases below are the acceptance criteria in that order — round trip with
 * citations, a rebuild that reproduces pages after the rows are deleted, and a citation of a session
 * that does not exist still reading back.
 */
describe("cited pages", () => {
  it("records two pages with their citations and reads them back by name", async () => {
    const outcome = await program(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const sql = yield* SqlClient;
        const source = yield* sessions.create({
          title: "the session a page learned from",
        });
        const host = yield* sessions.create({ title: "cited pages" });
        // `ses_` with zeros is syntactically a session id and is nobody's: the citation is data.
        const unknown = "ses_0000000000000000";
        const traps = yield* sessions.recordPage({
          sessionId: host.id,
          name: "b-batch-the-fold",
          kind: "trap",
          content: "a per-batch delete clobbers another batch's rows",
          links: ["a-the-log-is-the-truth"],
          sources: [source.id],
        });
        const decisions = yield* sessions.recordPage({
          sessionId: host.id,
          name: "a-the-log-is-the-truth",
          kind: "decision",
          content: "the log is the truth; the rows are a cache",
          links: [],
          sources: [source.id, unknown],
        });
        const listed = yield* sessions.listPages({ sessionId: host.id });
        const rows = yield* sql<{ name: string }>`
          SELECT name FROM session_pages WHERE session_id = ${host.id}
        `;
        const empty = yield* sessions.create({ title: "no pages" });
        const nothing = yield* sessions.listPages({ sessionId: empty.id });
        return {
          traps,
          decisions,
          listed,
          nothing,
          rows: rows.length,
          sessionId: host.id,
        };
      }),
    );

    // Ordered by name, not by the order they were written: two logs that recorded them in a
    // different order read back the same way.
    expect(outcome.listed.pages.map((page) => page.name)).toEqual([
      "a-the-log-is-the-truth",
      "b-batch-the-fold",
    ]);
    expect(outcome.listed.pages[0]).toEqual({
      name: "a-the-log-is-the-truth",
      kind: "decision",
      content: "the log is the truth; the rows are a cache",
      links: [],
      sources: [outcome.decisions.sources[0], "ses_0000000000000000"],
    });
    // The citation of a session nobody can find is stored as given (criterion 3).
    expect(outcome.listed.pages[0]?.sources).toContain("ses_0000000000000000");
    expect(outcome.listed.pages[1]?.links).toEqual(["a-the-log-is-the-truth"]);
    expect(outcome.rows).toBe(2);
    // A session that taught nothing has no pages, and reads as none rather than as an error.
    expect(outcome.nothing.pages).toEqual([]);
  }, 120_000);

  it("replaces a page it already holds, and refuses one with no name", async () => {
    const outcome = await program(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const sql = yield* SqlClient;
        const created = yield* sessions.create({ title: "replace a page" });
        const first = yield* sessions.recordPage({
          sessionId: created.id,
          name: "a-page",
          kind: "guide",
          content: "first draft",
          links: [],
          sources: [],
        });
        const second = yield* sessions.recordPage({
          sessionId: created.id,
          name: "a-page",
          kind: "guide",
          content: "second draft",
          links: ["another-page"],
          sources: [],
        });
        const listed = yield* sessions.listPages({ sessionId: created.id });
        const rows = yield* sql<{ name: string }>`
          SELECT name FROM session_pages WHERE session_id = ${created.id}
        `;
        const refused = yield* Effect.exit(
          sessions.recordPage({
            sessionId: created.id,
            name: "  ",
            kind: "guide",
            content: "nobody can cite this",
            links: [],
            sources: [],
          }),
        );
        return { first, second, listed, rows: rows.length, refused };
      }),
    );

    expect(outcome.listed.pages).toHaveLength(1);
    expect(outcome.listed.pages[0]?.content).toBe("second draft");
    expect(outcome.rows).toBe(1);
    const failure = Exit.findErrorOption(outcome.refused);
    expect(Option.isSome(failure)).toBe(true);
    expect(Option.isSome(failure) ? failure.value._tag : undefined).toBe(
      "SessionError",
    );
  }, 120_000);

  it("reproduces the pages from the log after the derived rows are deleted", async () => {
    const outcome = await program(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const sql = yield* SqlClient;
        const source = yield* sessions.create({ title: "a citation to keep" });
        const host = yield* sessions.create({ title: "rebuild the pages" });
        yield* sessions.recordPage({
          sessionId: host.id,
          name: "b-second",
          kind: "trap",
          content: "the second page",
          links: ["a-first"],
          sources: [source.id],
        });
        yield* sessions.recordPage({
          sessionId: host.id,
          name: "a-first",
          kind: "decision",
          content: "the first page",
          links: [],
          sources: ["ses_0000000000000001"],
        });
        const before = yield* sessions.listPages({ sessionId: host.id });
        // The rows are the cache, so deleting them must cost nothing a rebuild cannot refill.
        yield* sql`DELETE FROM session_pages WHERE session_id = ${host.id}`;
        const blanked = yield* sessions.listPages({ sessionId: host.id });
        const report = yield* rebuildIndexes;
        const refolded = yield* sessions.listPages({ sessionId: host.id });
        return { before, blanked, report, refolded, sessionId: host.id };
      }),
    );

    expect(outcome.before.pages).toHaveLength(2);
    expect(outcome.blanked.pages).toEqual([]);
    expect(outcome.report.sessions).toBeGreaterThan(0);
    // Same pages, same citations, same order — from the `factory.page` entries in the log.
    expect(outcome.refolded.pages).toEqual(outcome.before.pages);
  }, 120_000);
});

/**
 * The pages a session carries reach its prompt (LOB-205, part 2 of LOB-47).
 *
 * The service reads `session_pages` on every owner acquisition and hands the pages to
 * `openSession`, so a session opened *after* its pages were recorded is told them. The proof is the
 * committed `pi.system` entry — the prompt Pi Durable replays before a request — rather than the
 * extension that built it: it is what the model was sent, and it survives the run that sent it.
 *
 * The owner is released between recording and sending (`sessions.close`) because a live owner is not
 * reopened: the read happens at open, which is exactly the freshness rule being tested — a page
 * curated since the session last ran reaches its next run.
 */
describe("the cited pages a session carries", () => {
  /** The prompt sections a session's own log leaves in effect, read the way a client would. */
  const promptSections = (
    sessionId: SessionId,
  ): Effect.Effect<Readonly<Record<string, string>>, SessionError, SqlClient> =>
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const storage = yield* Effect.promise(() =>
        PostgresStorage.reader(sql, sessionId),
      );
      return yield* readPromptSections(storage).pipe(
        Effect.ensuring(Effect.promise(() => storage.dispose())),
      );
    });

  it("tells the next run the pages the session holds, and says nothing about pages it lacks", async () => {
    const outcome = await program(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const source = yield* sessions.create({
          title: "the session that taught this",
        });
        const told = yield* sessions.create({ title: "a session with pages" });
        const bare = yield* sessions.create({ title: "a session with none" });
        yield* sessions.recordPage({
          sessionId: told.id,
          name: "a-the-log-is-the-truth",
          kind: "decision",
          content: "the log is the truth; the rows are a cache",
          links: ["b-batch-the-fold"],
          sources: [source.id],
        });
        yield* sessions.recordPage({
          sessionId: told.id,
          name: "b-batch-the-fold",
          kind: "trap",
          content: "a per-batch delete clobbers another batch's rows",
          links: [],
          sources: [source.id],
        });
        // Release every owner, so the next send opens a harness rather than reusing the one that was
        // open when the pages were written.
        yield* sessions.close;
        yield* sessions.send({ sessionId: told.id, content: "begin" });
        yield* sessions.send({ sessionId: bare.id, content: "begin" });
        yield* waitUntil(
          sessions
            .get(told.id)
            .pipe(Effect.map((snapshot) => !snapshot.live.busy)),
          "the paged run to settle",
        );
        yield* waitUntil(
          sessions
            .get(bare.id)
            .pipe(Effect.map((snapshot) => !snapshot.live.busy)),
          "the bare run to settle",
        );
        return {
          source: source.id,
          told: yield* promptSections(told.id),
          bare: yield* promptSections(bare.id),
        };
      }),
    );

    // The section is in the prompt the model was sent, with both pages and their citation — the
    // exact text, because "the prompt shows the pages it received" is what the run was told.
    expect(outcome.told["pages"]).toBe(
      [
        "<pages>",
        "## a-the-log-is-the-truth (decision)",
        "the log is the truth; the rows are a cache",
        "links: b-batch-the-fold",
        `sources: ${outcome.source}`,
        "",
        "## b-batch-the-fold (trap)",
        "a per-batch delete clobbers another batch's rows",
        `sources: ${outcome.source}`,
        "</pages>",
      ].join("\n"),
    );
    // A session with no pages is told nothing about pages: no section, not an empty one.
    expect(outcome.bare["pages"]).toBeUndefined();
  }, 120_000);
});

/**
 * The bounded curator pass (LOB-206, part 3 of LOB-47).
 *
 * The pass is one call over a finished session, and what it may write is bounded by `maxPages`. The
 * cases below are the acceptance criteria in order: a session that taught something writes at most
 * K pages for exactly one call, a session that taught nothing new writes nothing for exactly one
 * call, and the call's spend is charged to the curated session rather than to a curator's own.
 *
 * The request count is read from the model provider's counter, not from the pass's answer: a suite
 * that trusted the pass to report its own call count would pass a regression that made two.
 */
describe("the curator pass over a finished session", () => {
  const curateRoot = mkdtempSync(join(tmpdir(), "factory-core-curate-"));

  /** A service over a scripted model, so the cap and the "nothing new" answer can both happen. */
  const withCuration = (fauxCuration: string, fauxCommand?: string) => {
    const faux = createFauxModelAccess({
      fauxCuration,
      ...(fauxCommand === undefined ? {} : { fauxCommand }),
    });
    const runtime = ManagedRuntime.make(
      SessionServiceLive({ model: faux.access, sessionRoot: curateRoot }).pipe(
        Layer.provideMerge(DatabaseLayer),
      ),
    );
    const program = <A, E>(
      effect: Effect.Effect<A, E, SessionService | SqlClient>,
    ) => runtime.runPromise(effect);
    return { faux, runtime, program };
  };

  /** Three proposals, so a cap of two has work to do. */
  const threeProposals = JSON.stringify(
    Array.from({ length: 3 }, (_, index) => ({
      name: `page-${index}`,
      kind: "trap",
      content: `what the session taught number ${index}`,
      links: [],
      sources: [],
    })),
  );

  /** A session that ran one turn: a real transcript with a tool result in it. */
  const taught = (
    sessions: {
      create: (input: {
        title: string;
      }) => Effect.Effect<SessionSummary, SessionError>;
      send: (input: {
        sessionId: SessionId;
        content: string;
      }) => Effect.Effect<{ placement: string }, SessionError>;
      get: (id: SessionId) => Effect.Effect<SessionSnapshot, SessionError>;
    },
    title: string,
  ) =>
    Effect.gen(function* () {
      const created = yield* sessions.create({ title });
      yield* sessions.send({ sessionId: created.id, content: "do the work" });
      yield* waitUntil(
        sessions
          .get(created.id)
          .pipe(Effect.map((snapshot) => !snapshot.live.busy)),
        "the turn to settle",
      );
      return created;
    });

  it("writes at most maxPages from one call, and cites the session it curated", async () => {
    const { faux, runtime, program } = withCuration(threeProposals);
    try {
      const outcome = await program(
        Effect.gen(function* () {
          const sessions = yield* SessionService;
          const created = yield* taught(
            sessions,
            "a session that taught something",
          );
          const before = faux.faux.state.callCount;
          const curated = yield* sessions.curate({
            sessionId: created.id,
            maxPages: 2,
          });
          const calls = faux.faux.state.callCount - before;
          const pages = yield* sessions.listPages({ sessionId: created.id });
          return { curated, calls, pages: pages.pages, sessionId: created.id };
        }),
      );

      // K configured is K written, from a model that proposed more.
      expect(outcome.curated.pages.map((page) => page.name)).toEqual([
        "page-0",
        "page-1",
      ]);
      expect(outcome.curated.proposed).toBe(3);
      expect(outcome.calls).toBe(1);
      // The pages are the session's own: a derived row and a log fact, read back by `listPages`.
      expect(outcome.pages.map((page) => page.name)).toEqual([
        "page-0",
        "page-1",
      ]);
      for (const page of outcome.pages) {
        expect(page.sources).toEqual([outcome.sessionId]);
      }
    } finally {
      await runtime.dispose();
    }
  }, 120_000);

  it("commits nothing, for one call, when the session already holds what was proposed", async () => {
    const { faux, runtime, program } = withCuration(threeProposals);
    try {
      const outcome = await program(
        Effect.gen(function* () {
          const sessions = yield* SessionService;
          const created = yield* taught(sessions, "a session curated twice");
          const first = yield* sessions.curate({
            sessionId: created.id,
            maxPages: 3,
          });
          const before = faux.faux.state.callCount;
          const second = yield* sessions.curate({
            sessionId: created.id,
            maxPages: 3,
          });
          const calls = faux.faux.state.callCount - before;
          const pages = yield* sessions.listPages({ sessionId: created.id });
          return { first, second, calls, pages: pages.pages };
        }),
      );

      expect(outcome.first.pages).toHaveLength(3);
      // Learned nothing new: the second pass wrote no page, and still made exactly one call.
      expect(outcome.second.pages).toEqual([]);
      expect(outcome.second.proposed).toBe(3);
      expect(outcome.calls).toBe(1);
      expect(outcome.pages).toHaveLength(3);
    } finally {
      await runtime.dispose();
    }
  }, 120_000);

  it("charges the call to the curated session, and opens no session of its own", async () => {
    const { runtime, program } = withCuration(threeProposals);
    try {
      const outcome = await program(
        Effect.gen(function* () {
          const sessions = yield* SessionService;
          const created = yield* taught(
            sessions,
            "a session that pays for its curation",
          );
          const before = yield* sessions.get(created.id);
          const listedBefore = yield* sessions.list({ limit: 100 });
          yield* sessions.curate({ sessionId: created.id, maxPages: 3 });
          const after = yield* sessions.get(created.id);
          const listedAfter = yield* sessions.list({ limit: 100 });
          return { created, before, after, listedBefore, listedAfter };
        }),
      );

      const tokens = (usage: SessionUsage): number =>
        usage.models.reduce(
          (total, model) => total + model.usage.totalTokens,
          0,
        );
      // The spend is the curated session's: its own ledger grew by the call.
      expect(tokens(outcome.after.usage)).toBeGreaterThan(
        tokens(outcome.before.usage),
      );
      // And there is no curator session anywhere to carry it instead.
      expect(outcome.listedAfter.sessions).toHaveLength(
        outcome.listedBefore.sessions.length,
      );
      expect(
        outcome.listedAfter.sessions.some(
          (session) => session.id === outcome.created.id,
        ),
      ).toBe(true);
      // The index row agrees with the ledger: what `listSessions` reports as spend is what the log
      // says the session spent, curation included.
      const curatedRow = outcome.listedAfter.sessions.find(
        (session) => session.id === outcome.created.id,
      );
      const totalCost = outcome.after.usage.models.reduce(
        (total, model) => total + model.usage.costTotal,
        0,
      );
      expect(curatedRow?.costTotal).toBeCloseTo(totalCost);
      // A curated session has not started running: both its summary and the pass itself stay idle.
      expect(outcome.after.session.status).toBe("idle");
      expect(outcome.after.live.busy).toBe(false);
    } finally {
      await runtime.dispose();
    }
  }, 120_000);

  it("commits no page, for one call, when the model proposes nothing", async () => {
    const { faux, runtime, program } = withCuration("[]");
    try {
      const outcome = await program(
        Effect.gen(function* () {
          const sessions = yield* SessionService;
          const created = yield* sessions.create({
            title: "a session that taught nothing",
          });
          const before = faux.faux.state.callCount;
          const curated = yield* sessions.curate({ sessionId: created.id });
          const calls = faux.faux.state.callCount - before;
          const pages = yield* sessions.listPages({ sessionId: created.id });
          return { curated, calls, pages: pages.pages };
        }),
      );

      // An empty answer is an answer: no page, and the one call the pass is allowed to make.
      expect(outcome.curated.pages).toEqual([]);
      expect(outcome.calls).toBe(1);
      expect(outcome.pages).toEqual([]);
    } finally {
      await runtime.dispose();
    }
  }, 120_000);

  it("writes a page the model proposed twice only once", async () => {
    const twice = JSON.stringify([
      {
        name: "a-trap",
        kind: "trap",
        content: "the same lesson",
        links: [],
        sources: [],
      },
      {
        name: "a-trap",
        kind: "trap",
        content: "the same lesson",
        links: [],
        sources: [],
      },
      {
        name: "another",
        kind: "guide",
        content: "a second lesson",
        links: [],
        sources: [],
      },
    ]);
    const { runtime, program } = withCuration(twice);
    try {
      const outcome = await program(
        Effect.gen(function* () {
          const sessions = yield* SessionService;
          const created = yield* sessions.create({
            title: "a repeated proposal",
          });
          const curated = yield* sessions.curate({ sessionId: created.id });
          const pages = yield* sessions.listPages({ sessionId: created.id });
          return { curated, pages: pages.pages };
        }),
      );

      expect(outcome.curated.proposed).toBe(3);
      expect(outcome.curated.pages.map((page) => page.name)).toEqual([
        "a-trap",
        "another",
      ]);
      expect(outcome.pages.map((page) => page.name)).toEqual([
        "a-trap",
        "another",
      ]);
    } finally {
      await runtime.dispose();
    }
  }, 120_000);

  it("charges an answer it cannot read to the curated session, then refuses it", async () => {
    const { runtime, program } = withCuration(
      "I think the session taught one useful thing.",
    );
    try {
      const outcome = await program(
        Effect.gen(function* () {
          const sessions = yield* SessionService;
          const created = yield* sessions.create({
            title: "an unreadable curation",
          });
          const before = yield* sessions.get(created.id);
          const refused = yield* Effect.exit(
            sessions.curate({ sessionId: created.id }),
          );
          const after = yield* sessions.get(created.id);
          const pages = yield* sessions.listPages({ sessionId: created.id });
          return { refused, before, after, pages: pages.pages };
        }),
      );

      const failure = Exit.findErrorOption(outcome.refused);
      expect(Option.isSome(failure)).toBe(true);
      expect(Option.getOrThrow(failure).code).toBe("harness");
      // The call was made and billed, so the session carries it even though nothing was written.
      const tokens = (usage: SessionUsage): number =>
        usage.models.reduce(
          (total, model) => total + model.usage.totalTokens,
          0,
        );
      expect(tokens(outcome.after.usage)).toBeGreaterThan(
        tokens(outcome.before.usage),
      );
      expect(outcome.pages).toEqual([]);
    } finally {
      await runtime.dispose();
    }
  }, 120_000);

  it("refuses a session that is still running, without asking the model", async () => {
    // A command that takes long enough for a curation attempt to arrive while it runs.
    const { faux, runtime, program } = withCuration(threeProposals, "sleep 3");
    try {
      const outcome = await program(
        Effect.gen(function* () {
          const sessions = yield* SessionService;
          const created = yield* sessions.create({
            title: "a running session",
          });
          // The counter is read before the turn and after it settles: the in-flight turn spends its
          // own two calls (the tool call and the answer), so a third would be the refusal asking the
          // model anyway — which spends a call and writes nothing, worse than either answer.
          const before = faux.faux.state.callCount;
          yield* sessions.send({
            sessionId: created.id,
            content: "take your time",
          });
          yield* waitUntil(
            sessions
              .get(created.id)
              .pipe(Effect.map((snapshot) => snapshot.live.busy)),
            "the turn to start",
          );
          const refused = yield* Effect.exit(
            sessions.curate({ sessionId: created.id }),
          );
          const pages = yield* sessions.listPages({ sessionId: created.id });
          yield* waitUntil(
            sessions
              .get(created.id)
              .pipe(Effect.map((snapshot) => !snapshot.live.busy)),
            "the turn to settle",
          );
          const calls = faux.faux.state.callCount - before;
          return { refused, calls, pages: pages.pages };
        }),
      );

      const failure = Exit.findErrorOption(outcome.refused);
      expect(Option.isSome(failure)).toBe(true);
      const error = Option.getOrThrow(failure);
      expect(error._tag).toBe("SessionError");
      expect(error.code).toBe("busy");
      // Exactly the turn's own two calls: the refused curation added none.
      expect(outcome.calls).toBe(2);
      expect(outcome.pages).toEqual([]);
    } finally {
      await runtime.dispose();
    }
  }, 120_000);
});

describe("a run's prompt comes from its column", () => {
  /**
   * A board instance over `version` of the default pipeline, made by `TaskService.createBoard`
   * (LOB-208) — the one production writer of `board_instances` — rather than by an insert here.
   * Without a version, the definition's newest.
   */
  const createBoard = (version?: number) =>
    Effect.gen(function* () {
      const tasks = yield* TaskService;
      return yield* tasks.createBoard({
        repo: RepoSlugSchema.make(
          `factory-test/${randomBytes(3).toString("hex")}`,
        ),
        definitionId: DefinitionIdSchema.make(DEFAULT_DEFINITION_ID),
        ...(version === undefined ? {} : { definitionVersion: version }),
      });
    }).pipe(Effect.provide(TaskServiceLive));

  /** A board over the definition version that binds skills to the stages (0010). */
  const newBoard = createBoard(2).pipe(Effect.map((board) => board.id));

  /**
   * A card in `column` on `boardId`, pinned to the definition version it started under. The id's
   * shape is the domain's, not the table's.
   */
  const newCard = (boardId: string, column: string, version = 2) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const id = `tsk_${randomBytes(13).toString("hex")}`;
      yield* sql`
        INSERT INTO tasks (id, board_id, title, "column", definition_version, revision)
        VALUES (${id}, ${boardId}, ${`a card in ${column}`}, ${column}, ${version}, 1)
      `;
      return id;
    });

  /** Start a run on a card and let it settle, so the log holds the prompt it ran under. */
  const startRun = (
    cardId: string,
    column: string,
  ): Effect.Effect<SessionId, SessionError, SessionService> =>
    Effect.gen(function* () {
      const sessions = yield* SessionService;
      const created = yield* sessions.create({
        taskId: cardId,
        taskColumn: column,
      });
      yield* sessions.send({
        sessionId: created.id,
        content: `begin in ${column}`,
      });
      yield* waitUntil(
        sessions
          .get(created.id)
          .pipe(Effect.map((snapshot) => !snapshot.live.busy)),
        `the ${column} run to settle`,
      );
      return created.id;
    });

  /** The prompt sections the run's own log leaves in effect. */
  const promptSections = (
    sessionId: SessionId,
  ): Effect.Effect<Readonly<Record<string, string>>, SessionError, SqlClient> =>
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const storage = yield* Effect.promise(() =>
        PostgresStorage.reader(sql, sessionId),
      );
      return yield* readPromptSections(storage).pipe(
        Effect.ensuring(Effect.promise(() => storage.dispose())),
      );
    });

  /** Edit the `specify` skill's body through the service that owns it, returning what it was. */
  const editSpecifyBody = (body: string) =>
    runtime.runPromise(
      Effect.gen(function* () {
        const skills = yield* SkillService;
        const before = yield* skills.get("specify");
        yield* skills.upsert({ ...before, body });
        return before;
      }).pipe(Effect.provide(SkillServiceLive)),
    );

  it("tells a specifying run the specify skill, and a building run nothing of it", async () => {
    const prompts = await program(
      Effect.gen(function* () {
        const boardId = yield* newBoard;
        const specCard = yield* newCard(boardId, "specifying");
        const buildCard = yield* newCard(boardId, "building");
        return {
          specifying: yield* promptSections(
            yield* startRun(specCard, "specifying"),
          ),
          building: yield* promptSections(
            yield* startRun(buildCard, "building"),
          ),
        };
      }),
    );

    // 0009's seeded body, which is what "the run receives the specify skill text" means.
    expect(prompts.specifying["skill_specify"]).toContain(
      "Clarify the goal, scope, acceptance criteria",
    );
    expect(prompts.building["skill_specify"]).toBeUndefined();
    // The building run is not prompt-less: it carries its own column's skill, so the absence above
    // is the column's doing rather than a session that was told nothing at all.
    expect(prompts.building["skill_implement"]).toContain("smallest change");
  }, 120_000);

  /**
   * The whole production path, with no SQL written by the case (LOB-208): `createBoard` makes the
   * board at the default pipeline's newest version, `TaskService.create` puts a card on it, a person
   * moves the card to `specifying`, and the run started there is told the column's skill — which only
   * happens if the run-column join in `SessionService` finds the board `createBoard` wrote.
   *
   * Mutation: have `createBoard` pin the oldest version — version 1's columns bind no skills, so the
   * run's prompt carries no `skill_specify`. Mutation: write the instance under another definition
   * id — the join finds no definition row and the run is told nothing of its column.
   */
  it("tells a run on a card of a board createBoard made its column's skill, with no SQL", async () => {
    const outcome = await program(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const board = yield* createBoard();
        const card = yield* tasks.create({
          boardId: board.id,
          title: "a card on a made board",
          actor: "person:lukas",
        });
        const moved = yield* tasks.move({
          taskId: card.id,
          expectedRevision: card.revision,
          to: "specifying",
          actor: "person:lukas",
        });
        const sessionId = yield* startRun(moved.id, moved.column);
        return {
          board,
          card,
          prompt: yield* promptSections(sessionId),
        };
      }).pipe(Effect.provide(TaskServiceLive)),
    );

    // The run's prompt first: it is the claim, and the versions below only say why it holds.
    expect(outcome.prompt["skill_specify"]).toContain(
      "Clarify the goal, scope, acceptance criteria",
    );
    expect(outcome.board.definitionVersion).toBeGreaterThanOrEqual(2);
    expect(outcome.card.definitionVersion).toBe(
      outcome.board.definitionVersion,
    );
  }, 120_000);

  it("changes the next run's prompt when a seeded body is edited", async () => {
    const marker = `# Specify\n\nAsk about ${randomBytes(4).toString("hex")} before writing code.`;

    const before = await program(
      Effect.gen(function* () {
        const boardId = yield* newBoard;
        const cardId = yield* newCard(boardId, "specifying");
        return yield* promptSections(yield* startRun(cardId, "specifying"));
      }),
    );

    const seeded = await editSpecifyBody(marker);
    const after = await program(
      Effect.gen(function* () {
        // A new card and a new run: what a run is told is resolved when its session opens, so the
        // next run is where an edited body shows up.
        const boardId = yield* newBoard;
        const cardId = yield* newCard(boardId, "specifying");
        return yield* promptSections(yield* startRun(cardId, "specifying"));
      }),
    );
    // Put the seed back, so a later case reads what 0009 wrote rather than this one's text.
    await editSpecifyBody(seeded.body);

    expect(before["skill_specify"]).toContain(
      "Clarify the goal, scope, acceptance criteria",
    );
    expect(before["skill_specify"]).not.toContain(marker);
    expect(after["skill_specify"]).toContain(marker);
  }, 120_000);

  it("refuses to open a run whose column names a skill the factory does not hold", async () => {
    const outcome = await program(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        // A definition of its own, so the seeded pipeline is left exactly as 0010 wrote it.
        const definitionId = `dangling${randomBytes(3).toString("hex")}`;
        yield* sql`
          INSERT INTO board_definitions (id, version, name, columns)
          VALUES (
            ${definitionId}, 1, 'Dangling pipeline',
            ${JSON.stringify([
              { name: "intake", kind: "resting", skills: [], requires: [] },
              {
                name: "specifying",
                kind: "working",
                role: "specifier",
                skills: ["explain"],
                requires: [],
              },
            ])}::jsonb
          )
        `;
        const boardId = `brd_${randomBytes(13).toString("hex")}`;
        yield* sql`
          INSERT INTO board_instances (id, repo, definition_id, definition_version)
          VALUES (${boardId}, ${`factory-test/${randomBytes(3).toString("hex")}`}, ${definitionId}, 1)
        `;
        const cardId = yield* newCard(boardId, "specifying", 1);
        const sessions = yield* SessionService;
        return yield* Effect.exit(
          sessions.create({ taskId: cardId, taskColumn: "specifying" }),
        );
      }),
    );

    const failure = Exit.findErrorOption(outcome);
    expect(failure._tag).toBe("Some");
    if (failure._tag !== "Some") throw new Error("unreachable");
    expect(failure.value.code).toBe("invalid_input");
    expect(failure.value.message).toContain('skill "explain"');
  }, 120_000);

  /**
   * A model whose one `bash` call writes a file into the run's worktree, so the same call can be
   * watched being refused in one column and landing in another (LOB-74). The runtime is the real
   * service on the real database; only the column the run starts in differs between the two runs.
   */
  const STAGE_PROBE = "stage-probe.txt";
  const stageRoot = mkdtempSync(join(tmpdir(), "factory-core-stage-"));
  const stageRuntime = ManagedRuntime.make(
    SessionServiceLive({
      model: createFauxModelAccess({
        fauxCommand: `echo stage > ${STAGE_PROBE} && echo wrote ${STAGE_PROBE}`,
      }).access,
      sessionRoot: stageRoot,
    }).pipe(Layer.provideMerge(DatabaseLayer)),
  );
  afterAll(async () => {
    await stageRuntime.dispose();
  });

  it("refuses a specifying run's write, names the stage, and lets the same write land in building", async () => {
    const outcome = await stageRuntime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        const sessions = yield* SessionService;
        const boardId = yield* newBoard;
        const run = (column: string, version = 2) =>
          Effect.gen(function* () {
            const sessionId = yield* startRun(
              yield* newCard(boardId, column, version),
              column,
            );
            const worktree = (yield* sessions.get(sessionId)).workspace.path;
            // The log itself, read without the owner the way a rebuild reads it (D7): the refusal
            // has to be a fact of the run's log, not only of this process's live view.
            const storage = yield* Effect.promise(() =>
              PostgresStorage.reader(sql, sessionId),
            );
            const log = yield* readSessionLog(storage).pipe(
              Effect.ensuring(Effect.promise(() => storage.dispose())),
            );
            return {
              result: log.entries.find((entry) => entry.kind === "toolResult"),
              wrote: existsSync(join(worktree, STAGE_PROBE)),
            };
          });
        return {
          specifying: yield* run("specifying"),
          // Version 1 binds no skill to the column: the role alone makes it the stage.
          unskilled: yield* run("specifying", 1),
          building: yield* run("building"),
        };
      }),
    );

    // Refused in specifying, in the stage's own words, and nothing was written.
    expect(outcome.specifying.result?.isError).toBe(true);
    expect(outcome.specifying.result?.text).toContain("Tool call blocked");
    expect(outcome.specifying.result?.text).toContain(
      `redirecting output to ${STAGE_PROBE} is refused`,
    );
    expect(outcome.specifying.result?.text).toContain(
      "read-only specifying stage",
    );
    expect(outcome.specifying.result?.text).toContain('column "specifying"');
    expect(outcome.specifying.wrote).toBe(false);
    expect(outcome.unskilled.result?.text).toContain(
      "read-only specifying stage",
    );
    expect(outcome.unskilled.wrote).toBe(false);
    // The same call in building ran: the rule is the stage's, not the session's.
    expect(outcome.building.result?.isError).toBe(false);
    expect(outcome.building.result?.text).toContain(`wrote ${STAGE_PROBE}`);
    expect(outcome.building.wrote).toBe(true);
  }, 120_000);

  /**
   * One deployment whose role table gives the specifier its own model (LOB-207): the faux backend
   * publishing two models, and the table resolved against it the way `apps/api` resolves
   * `ROLE_MODELS` at boot. Every other role has no row.
   */
  const roleRoot = mkdtempSync(join(tmpdir(), "factory-core-roles-"));
  const roleAccess = createFauxModelAccess({
    fauxModels: ["faux-1", "faux-spec"],
  }).access;
  const roleRuntime = ManagedRuntime.make(
    SessionServiceLive({
      model: roleAccess,
      roleModels: Effect.runSync(
        resolveRoleModels(
          roleAccess,
          new Map([["specifier", "faux/faux-spec"]]),
        ),
      ),
      sessionRoot: roleRoot,
    }).pipe(Layer.provideMerge(DatabaseLayer)),
  );
  afterAll(async () => {
    await roleRuntime.dispose();
  });

  it("runs each card's run on its column's role's model, and an unconfigured role on the deployment's", async () => {
    const models = await roleRuntime.runPromise(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const boardId = yield* newBoard;
        const ran = (column: string) =>
          Effect.gen(function* () {
            const sessionId = yield* startRun(
              yield* newCard(boardId, column),
              column,
            );
            const snapshot = yield* sessions.get(sessionId);
            return snapshot.usage.models.map((entry) => entry.key);
          });
        return {
          specifying: yield* ran("specifying"),
          building: yield* ran("building"),
          review: yield* ran("review"),
          // A session with no card has no role at all.
          scratch: yield* Effect.gen(function* () {
            const created = yield* sessions.create({ title: "no card" });
            yield* sessions.send({ sessionId: created.id, content: "hello" });
            yield* waitUntil(
              sessions
                .get(created.id)
                .pipe(Effect.map((snapshot) => !snapshot.live.busy)),
              "the scratch run to settle",
            );
            const snapshot = yield* sessions.get(created.id);
            return snapshot.usage.models.map((entry) => entry.key);
          }),
        };
      }),
    );

    // `specifying` declares `specifier`, which has a row; `building` (`builder`) and `review`
    // (`reviewer`) have none, so they run the deployment's model, as a session with no card does.
    expect(models.specifying).toEqual(["faux/faux-spec"]);
    expect(models.building).toEqual(["faux/faux-1"]);
    expect(models.review).toEqual(["faux/faux-1"]);
    expect(models.scratch).toEqual(["faux/faux-1"]);
  }, 120_000);
});

describe("withdrawing a queued message", () => {
  // A turn that sleeps, so a second and third message arrive while the first run is still in
  // flight and genuinely queue (LOB-166). The faux model's own turn is too fast to queue behind.
  const withdrawRoot = mkdtempSync(join(tmpdir(), "factory-core-withdraw-"));
  const slow = ManagedRuntime.make(
    SessionServiceLive({
      model: createFauxModelAccess({ fauxCommand: "sleep 3 && echo faux-ok" })
        .access,
      sessionRoot: withdrawRoot,
    }).pipe(Layer.provideMerge(DatabaseLayer)),
  );
  afterAll(async () => {
    await slow.dispose();
  });

  const userTexts = (snapshot: SessionSnapshot): readonly string[] =>
    snapshot.entries
      .filter((entry) => entry.kind === "user")
      .map((entry) => entry.text);

  it("takes a queued message out of the queue, and only that one reaches no transcript", async () => {
    const outcome = await slow.runPromise(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const created = yield* sessions.create({ title: "a queue to edit" });
        const first = yield* sessions.send({
          sessionId: created.id,
          content: "take your time",
        });
        yield* waitUntil(
          sessions
            .get(created.id)
            .pipe(Effect.map((snapshot) => snapshot.live.busy)),
          "the first turn to start",
        );
        const dropped = yield* sessions.send({
          sessionId: created.id,
          content: "drop me",
          whenBusy: "followUp",
        });
        const kept = yield* sessions.send({
          sessionId: created.id,
          content: "keep me",
          whenBusy: "followUp",
        });
        const queuedBefore = (yield* sessions.get(created.id)).queued;

        const withdrawn = yield* sessions.withdraw({
          sessionId: created.id,
          submissionId: dropped.submissionId,
        });
        const queuedAfter = (yield* sessions.get(created.id)).queued;
        // The run owns the first message: it is an answer, not a withdrawal.
        const placed = yield* sessions.withdraw({
          sessionId: created.id,
          submissionId: first.submissionId,
        });
        // Withdrawing twice is not withdrawing twice: the second answers that it is over.
        const again = yield* sessions.withdraw({
          sessionId: created.id,
          submissionId: dropped.submissionId,
        });
        const unknown = yield* Effect.exit(
          sessions.withdraw({
            sessionId: created.id,
            submissionId: "999999",
          }),
        );
        const malformed = yield* Effect.exit(
          sessions.withdraw({
            sessionId: created.id,
            submissionId: "not-a-submission",
          }),
        );
        const unknownSession = yield* Effect.exit(
          sessions.withdraw({
            sessionId: SessionIdSchema.make("ses_00000000000000000000000000"),
            submissionId: dropped.submissionId,
          }),
        );

        // Both runs settle: the first, then the follow-up the withdrawal left in the queue.
        yield* waitUntil(
          sessions
            .get(created.id)
            .pipe(
              Effect.map(
                (snapshot) =>
                  !snapshot.live.busy &&
                  snapshot.queued.length === 0 &&
                  userTexts(snapshot).includes("keep me") &&
                  snapshot.entries.at(-1)?.kind === "assistant",
              ),
            ),
          "the follow-up run to settle",
        );
        const settled = yield* sessions.get(created.id);
        return {
          dropped,
          kept,
          queuedBefore,
          withdrawn,
          queuedAfter,
          placed,
          again,
          unknown,
          malformed,
          unknownSession,
          settled,
        };
      }),
    );

    expect(outcome.dropped.placement).toBe("followUp");
    expect(outcome.queuedBefore.map((q) => q.id)).toEqual([
      outcome.dropped.submissionId,
      outcome.kept.submissionId,
    ]);
    expect(outcome.queuedBefore[0]?.content).toBe("drop me");

    expect(outcome.withdrawn.outcome).toBe("withdrawn");
    expect(outcome.withdrawn.submissionId).toBe(outcome.dropped.submissionId);
    expect(outcome.queuedAfter.map((q) => q.id)).toEqual([
      outcome.kept.submissionId,
    ]);
    expect(outcome.placed.outcome).toBe("already_placed");
    expect(outcome.again.outcome).toBe("settled");

    for (const refused of [
      outcome.unknown,
      outcome.malformed,
      outcome.unknownSession,
    ]) {
      const failure = Exit.findErrorOption(refused);
      expect(Option.isSome(failure)).toBe(true);
      expect(Option.getOrThrow(failure).code).toBe("not_found");
    }

    // The message left before any run took it, so it never reached the transcript; the one left in
    // the queue did.
    const texts = userTexts(outcome.settled);
    expect(texts).toContain("take your time");
    expect(texts).toContain("keep me");
    expect(texts).not.toContain("drop me");
  }, 120_000);

  it("streams the queue shrinking to a watcher, and the steer never lands", async () => {
    const seen = await slow.runPromise(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const created = yield* sessions.create({ title: "a watched queue" });
        yield* sessions.send({
          sessionId: created.id,
          content: "take your time",
        });
        yield* waitUntil(
          sessions
            .get(created.id)
            .pipe(Effect.map((snapshot) => snapshot.live.busy)),
          "the turn to start",
        );
        const queued = yield* sessions.send({
          sessionId: created.id,
          content: "drop me",
          whenBusy: "steer",
        });
        const readings = yield* Ref.make<ReadonlyArray<readonly string[]>>([]);
        // Every user entry the watcher is sent. A steer the withdrawal missed would drain the queue
        // too — placed at the next tool boundary — so the drain alone does not tell the two apart.
        const userEntries = yield* Ref.make<readonly string[]>([]);
        const watcher = yield* sessions.events(created.id).pipe(
          Stream.runForEach((event) =>
            event._tag === "snapshot" || event._tag === "queued"
              ? Ref.update(readings, (all) => [
                  ...all,
                  event.queued.map((q) => q.id),
                ])
              : event._tag === "entry" && event.entry.kind === "user"
                ? Ref.update(userEntries, (all) => [...all, event.entry.text])
                : Effect.void,
          ),
          Effect.forkChild,
        );
        yield* waitUntil(
          Ref.get(readings).pipe(Effect.map((all) => all.length > 0)),
          "the watcher's snapshot",
        );
        yield* sessions.withdraw({
          sessionId: created.id,
          submissionId: queued.submissionId,
        });
        yield* waitUntil(
          Ref.get(readings).pipe(Effect.map((all) => all.at(-1)?.length === 0)),
          "the watcher to see the queue drain",
        );
        yield* waitUntil(
          sessions
            .get(created.id)
            .pipe(Effect.map((snapshot) => !snapshot.live.busy)),
          "the turn to settle",
        );
        yield* Fiber.interrupt(watcher);
        return {
          id: queued.submissionId,
          readings: yield* Ref.get(readings),
          userEntries: yield* Ref.get(userEntries),
          settled: yield* sessions.get(created.id),
        };
      }),
    );

    expect(seen.readings[0]).toEqual([seen.id]);
    expect(seen.readings.at(-1)).toEqual([]);
    expect(seen.userEntries).not.toContain("drop me");
    expect(userTexts(seen.settled)).toEqual(["take your time"]);
  }, 120_000);

  it("answers a withdraw on a session nobody owns from the log, without opening an owner", async () => {
    const outcome = await slow.runPromise(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const created = yield* sessions.create({ title: "an idle session" });
        const first = yield* sessions.send({
          sessionId: created.id,
          content: "quick one",
        });
        yield* waitUntil(
          sessions
            .get(created.id)
            .pipe(
              Effect.map(
                (snapshot) =>
                  !snapshot.live.busy &&
                  snapshot.entries.at(-1)?.kind === "assistant",
              ),
            ),
          "the turn to settle",
        );
        // Released, as an API restart or the idle sweep would leave it.
        yield* sessions.close;

        const settled = yield* sessions.withdraw({
          sessionId: created.id,
          submissionId: first.submissionId,
        });
        const unknown = yield* Effect.exit(
          sessions.withdraw({ sessionId: created.id, submissionId: "999999" }),
        );
        // Still historical: neither answer took the log or opened the workspace.
        const after = yield* sessions.get(created.id);
        return { settled, unknown, mode: after.session.mode };
      }),
    );

    expect(outcome.settled.outcome).toBe("settled");
    const failure = Exit.findErrorOption(outcome.unknown);
    expect(Option.isSome(failure)).toBe(true);
    expect(Option.getOrThrow(failure).code).toBe("not_found");
    expect(outcome.mode).toBe("historical");
  }, 120_000);
});

describe("a message that arrives while a run is in flight", () => {
  // The sleeping faux script (LOB-167): the model naps before each step of a turn, so a turn is
  // busy for about two seconds whatever the tool does, and a second message genuinely arrives
  // while the first run is in flight. The stock script answers too fast to send behind.
  const inFlightRoot = mkdtempSync(join(tmpdir(), "factory-core-in-flight-"));
  const sleeping = ManagedRuntime.make(
    SessionServiceLive({
      model: createFauxModelAccess({ fauxSleepMs: 1_000 }).access,
      sessionRoot: inFlightRoot,
    }).pipe(Layer.provideMerge(DatabaseLayer)),
  );
  afterAll(async () => {
    await sleeping.dispose();
  });

  const settledAfter = (
    sessions: SessionServiceShape,
    sessionId: SessionId,
    text: string,
  ) =>
    waitUntil(
      sessions
        .get(sessionId)
        .pipe(
          Effect.map(
            (snapshot) =>
              !snapshot.live.busy &&
              snapshot.queued.length === 0 &&
              snapshot.entries.some(
                (entry) => entry.kind === "user" && entry.text === text,
              ) &&
              snapshot.entries.at(-1)?.kind === "assistant",
          ),
        ),
      `the run that took "${text}" to settle`,
    );

  /** The answers in a transcript: assistant entries that call no tool. */
  const answers = (snapshot: SessionSnapshot): readonly string[] =>
    snapshot.entries
      .filter(
        (entry) => entry.kind === "assistant" && entry.toolCalls.length === 0,
      )
      .map((entry) => entry.text);

  it("places a steer in the running run, which answers it instead of starting another", async () => {
    const outcome = await sleeping.runPromise(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const created = yield* sessions.create({ title: "a run to steer" });
        const first = yield* sessions.send({
          sessionId: created.id,
          content: "take your time",
        });
        yield* waitUntil(
          sessions
            .get(created.id)
            .pipe(Effect.map((snapshot) => snapshot.live.busy)),
          "the first turn to start",
        );
        // Every queue reading a watcher is sent, from before the steer is admitted until the run
        // settles. Read from the stream, not one `get`: the steer's wait in the queue is a state
        // the watcher is told about, so no wall-clock window decides whether the test sees it.
        const readings = yield* Ref.make<
          ReadonlyArray<SessionSnapshot["queued"]>
        >([]);
        const watcher = yield* sessions.events(created.id).pipe(
          Stream.runForEach((event) =>
            event._tag === "snapshot" || event._tag === "queued"
              ? Ref.update(readings, (all) => [...all, event.queued])
              : Effect.void,
          ),
          Effect.forkChild,
        );
        yield* waitUntil(
          Ref.get(readings).pipe(Effect.map((all) => all.length > 0)),
          "the watcher's snapshot",
        );
        const steer = yield* sessions.send({
          sessionId: created.id,
          content: "use the steer",
          whenBusy: "steer",
        });
        yield* settledAfter(sessions, created.id, "use the steer");
        yield* waitUntil(
          Ref.get(readings).pipe(Effect.map((all) => all.at(-1)?.length === 0)),
          "the watcher to see the queue drain",
        );
        yield* Fiber.interrupt(watcher);
        return {
          first,
          steer,
          readings: yield* Ref.get(readings),
          settled: yield* sessions.get(created.id),
        };
      }),
    );

    expect(outcome.first.placement).toBe("run");
    expect(outcome.steer.placement).toBe("steer");
    // Until the tool round places it, the steer waits in the queue under its own mode; then the
    // queue drains.
    expect(outcome.readings).toContainEqual([
      {
        id: outcome.steer.submissionId,
        mode: "steer",
        content: "use the steer",
      },
    ]);
    expect(outcome.readings.at(-1)).toEqual([]);

    // One run: it called bash once and answered once, and the answer is the steer's. A follow-up
    // would have been a second run — two answers, the first one about "take your time".
    const kinds = outcome.settled.entries.map((entry) => entry.kind);
    expect(answers(outcome.settled)).toEqual(["faux-ok (re: use the steer)"]);
    expect(
      outcome.settled.entries.filter((entry) => entry.kind === "toolResult"),
    ).toHaveLength(1);
    // The steer joined after the tool round, not before the run's first step.
    const steerAt = outcome.settled.entries.findIndex(
      (entry) => entry.kind === "user" && entry.text === "use the steer",
    );
    expect(steerAt).toBeGreaterThan(kinds.indexOf("toolResult"));
    expect(steerAt).toBeLessThan(kinds.lastIndexOf("assistant"));
  }, 120_000);

  it("refuses whenBusy: reject with busy while the run is in flight, and queues nothing", async () => {
    const outcome = await sleeping.runPromise(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const created = yield* sessions.create({ title: "a run to refuse" });
        yield* sessions.send({
          sessionId: created.id,
          content: "take your time",
        });
        yield* waitUntil(
          sessions
            .get(created.id)
            .pipe(Effect.map((snapshot) => snapshot.live.busy)),
          "the first turn to start",
        );
        const refused = yield* Effect.exit(
          sessions.send({
            sessionId: created.id,
            content: "only if idle",
            whenBusy: "reject",
          }),
        );
        const during = yield* sessions.get(created.id);
        yield* settledAfter(sessions, created.id, "take your time");
        const settled = yield* sessions.get(created.id);
        // The same flag on the same session once it is idle starts a run: reject refuses only a
        // busy session, it is not a refusal of the message.
        const idle = yield* sessions.send({
          sessionId: created.id,
          content: "now that you are idle",
          whenBusy: "reject",
        });
        yield* settledAfter(sessions, created.id, "now that you are idle");
        return {
          refused,
          during,
          settled,
          idle,
          after: yield* sessions.get(created.id),
        };
      }),
    );

    const failure = Exit.findErrorOption(outcome.refused);
    expect(Option.isSome(failure)).toBe(true);
    expect(Option.getOrThrow(failure).code).toBe("busy");
    // Refused, so it never joined the queue and never reached the transcript.
    expect(outcome.during.live.busy).toBe(true);
    expect(outcome.during.queued).toEqual([]);
    const userTexts = (snapshot: SessionSnapshot) =>
      snapshot.entries
        .filter((entry) => entry.kind === "user")
        .map((entry) => entry.text);
    expect(userTexts(outcome.settled)).toEqual(["take your time"]);
    expect(answers(outcome.settled)).toEqual(["faux-ok (re: take your time)"]);

    expect(outcome.idle.placement).toBe("run");
    expect(userTexts(outcome.after)).toEqual([
      "take your time",
      "now that you are idle",
    ]);
  }, 120_000);
});

describe("request limits", () => {
  it("refuses a message over the length cap with a typed error", async () => {
    const outcome = await program(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const created = yield* sessions.create({ title: "too long" });
        return yield* Effect.exit(
          sessions.send({
            sessionId: created.id,
            content: "x".repeat(MAX_MESSAGE_CHARS + 1),
          }),
        );
      }),
    );
    expect(Exit.isFailure(outcome)).toBe(true);
    if (Exit.isSuccess(outcome)) throw new Error("unreachable");
    const failure = Exit.findErrorOption(outcome);
    if (failure._tag !== "Some") throw new Error("unreachable");
    expect(failure.value.code).toBe("invalid_input");
  });
});

/**
 * The pagination case's budget, guarded so it cannot silently go back to vitest's default (LOB-117).
 *
 * The case above reads `SELECT count(*) FROM session_activity` and issues one list statement per
 * page, so its cost is the shared table's, not the 280 fillers it writes. Measured 2026-10-07 at
 * ~2 883 rows: ~360 ms, i.e. ~0.125 ms per row — the 5 s default is reached at ~40 000 rows.
 * 30 000 is ~8x today's cost and gives the same headroom the rebuild guard used; a database of its
 * own per run (LOB-96) would also resolve it.
 *
 * What this cannot prove: that the declared budget is *enough*. No static check can — only the
 * page loop's cost on the database in front of it, which is why the case itself is what fails when
 * the deadline passes. Two other ways out of the problem satisfy the issue but not this reader, so
 * the guard has to be updated with them: a repo-wide `testTimeout` in `vitest.config.ts`, and
 * `it(name, { timeout }, fn)`. A skipped or excluded `describe("session list")` passes it as well,
 * because every byte it reads is still in the file.
 *
 * If LOB-96's isolation makes the shared table's row count bounded by this file's own rows, delete
 * this describe together with the case's third argument and the case comment that explains it, with
 * the page loop's new cost in the commit message.
 *
 * Mutation checked: deleting the case's `, 30_000` back to `  });` — the budget case below goes red
 * in 2-3 ms, with no database involved. `reads a budget only where one is declared` is the control
 * that keeps it from passing on a reader that answers unconditionally.
 */
const PAGINATION_CASE =
  "shows a new session without a poll, pages by cursor, one statement per page";

/**
 * The budget a case declares, or `undefined` when it would take vitest's default.
 *
 * The case's closing line is the first two-space-indented `}` after its `it(` — every nested
 * callback in the body closes deeper — and the budget is the optional third argument on it.
 */
const declaredPaginationBudget = (
  source: string,
  caseName: string,
): number | undefined => {
  const start = source.indexOf(`it("${caseName}"`);
  if (start < 0) return undefined;
  const closing = /^ {2}\}(?:, (\d[\d_]*))?\);/m.exec(source.slice(start));
  const digits = closing?.[1];
  return digits === undefined ? undefined : Number(digits.replaceAll("_", ""));
};

describe("the pagination case's budget", () => {
  const source = readFileSync(fileURLToPath(import.meta.url), "utf8");

  it("declares a timeout big enough for the shared table's page loop", () => {
    // The case has to be in the file at all, or the reader below would be reading nothing.
    expect(source).toContain(PAGINATION_CASE);
    const budget = declaredPaginationBudget(source, PAGINATION_CASE);
    expect(
      budget,
      `no third-argument timeout on "${PAGINATION_CASE}", so it would take vitest's 5 s default, which is under the shared table's page loop at scale: declare \`, 30_000)\` on the case, or update this guard as its header says.`,
    ).toBeDefined();
    if (budget === undefined) throw new Error("unreachable");
    // 30 000 is ~8x the ~360 ms the loop costs at ~2 883 rows. A smaller budget is a decision to
    // re-measure the loop against the run-context database, not an edit.
    expect(budget).toBeGreaterThanOrEqual(30_000);
  });

  it("reads a budget only where one is declared", () => {
    // Negative control for the reader, on a source shaped like this file: a case whose body closes
    // a nested callback first and then declares nothing. If this read as a budget, the case above
    // would pass on a file that declares none.
    const without = [
      'describe("x", () => {',
      `  it("${PAGINATION_CASE}", async () => {`,
      "    const nested = (() => {",
      "      return 1;",
      "    });",
      "  });",
      "});",
      "",
    ].join("\n");
    expect(declaredPaginationBudget(without, PAGINATION_CASE)).toBeUndefined();
    // The same source with the third argument back reads as that number, underscore and all.
    expect(
      declaredPaginationBudget(
        without.replace(/^ {2}\}\);$/m, "  }, 120_000);"),
        PAGINATION_CASE,
      ),
    ).toBe(120_000);
  });
});

/**
 * The run's own database, asserted rather than assumed (LOB-96).
 *
 * Everything above depends on it: the rebuild case empties `sessions` and the session-list case
 * writes 280 filler rows, so a run pointed at the configured database takes that database's
 * sessions with it and pays for its whole log. The block at the top of this file is what makes that
 * untrue, and the first two cases here are what notice if it stops being true.
 *
 * They read the isolation at run time, not the source, because the isolation is a property of the
 * connection and not of the text: pointing the suite's `DATABASE_URL` back at the configured
 * database is a one-line deletion that every comment in this file would go along with.
 *
 * The third case is not about isolation but about the duplication that makes it expressible: this
 * file spells `DatabaseConfig`'s default URL out again, and a comment asking the two to stay in
 * step is not enforcement.
 *
 * What this block cannot witness is the run's own drop. `afterAll` runs after every case in the
 * file, so no case here can observe whether the run's database went away, and a neutralised `DROP
 * DATABASE` leaves the suite green (measured). The sweep for *abandoned* databases has the mirror
 * problem, and worse: it runs at import, before any case exists. So neither is witnessed here —
 * they are driven by the drive in the PR body and by the shape of the sweep itself, which is
 * `CREATE`-first-per-run plus an hour of encoded age, not by anything a case in this file could see.
 *
 * Mutation checked: deleting the `process.env["DATABASE_URL"] = runDatabaseUrl;` line above. The
 * first case then reads the configured database's name from both pools and goes red on it. The
 * second goes red on the unrelated ids the rebuild case above deleted and no fold could put back —
 * a session with no commits is exactly that, so the ids have to be the witness and a count cannot
 * be (a refold raises the count again and hides the loss).
 * Do not apply it against the run-context database: that is the harm, live. Seed a scratch
 * database that already holds a session with no commits —
 * `INSERT INTO sessions (id, title, created_at) VALUES ('ses_seed_aaa', 'seeded', now() - interval
 * '2 hours')`, old enough to count as settled — and point `DATABASE_URL` at it.
 */
describe("this suite's database", () => {
  it("is one of its own, not the one DATABASE_URL names", async () => {
    const [here, there] = await Promise.all([
      program(currentDatabase),
      maintenance.runPromise(currentDatabase.pipe(Effect.orDie)),
    ]);
    // Two real reads, so the inequality cannot come from a client that never connected: a run that
    // could not reach the configured database does not get this far.
    //
    // The first comparison is conditional because `configuredDatabase` is `""` when the URL names
    // no database, and the server resolves that to the role's own — a name the URL cannot supply
    // and no substitute would match (measured: `expected 'factory' to be 'postgres'`). The
    // inequality below still holds, and it is the part that carries the claim.
    if (configuredDatabase !== "") expect(there).toBe(configuredDatabase);
    expect(here).toBe(runDatabaseName);
    expect(here).not.toBe(there);
  });

  it("leaves every session the configured database already had", async () => {
    // The ids read before a single case ran, asked about again after the rebuild case emptied
    // `sessions`. A suite pointed at the configured database has by now deleted the ones it cannot
    // rebuild; an unrelated suite *adding* sessions is not this file's harm, so the assertion is
    // about these ids and not about a total.
    //
    // This case can only fail if there was something to lose: on a configured database holding no
    // sessions — which is every first CI run, since `gate.yml` sets no `DATABASE_URL` — it reads
    // nothing twice and asserts nothing. That is a property of the data, not a hole that can be
    // bolted shut from here, because closing it would mean this file writing a row into the
    // database it exists not to write to. So it is stated rather than hidden: the count is in the
    // message below, and the case above is the one that holds unconditionally.
    const now = await maintenance.runPromise(sessionIds.pipe(Effect.orDie));
    const missing = configuredSessionIdsAtStart.filter(
      (id) => !now.includes(id),
    );
    expect(
      missing,
      `the configured database no longer holds ${missing.length} of the ${configuredSessionIdsAtStart.length} session(s) it held before this file ran, so this suite deleted rows that were never its own`,
    ).toEqual([]);
  });

  /**
   * `DatabaseConfig`'s own default URL, resolved with an *empty* environment.
   *
   * `fromEnvRecord({})` rather than the provider this file runs under: the claim is about the
   * default, so an inherited `DATABASE_URL` must not be able to answer for it — otherwise the case
   * below compares the literal with itself on every configured run and passes for the wrong reason.
   */
  it("keeps the fallback literal in step with DatabaseConfig's own default", async () => {
    const expected = await Effect.runPromise(
      DatabaseConfig.pipe(
        Effect.map((config) => Redacted.value(config.url)),
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromEnvRecord({}),
        ),
      ),
    );
    // Read out of this file rather than reusing `configuredUrl`, which *is* `DATABASE_URL` whenever
    // the environment has one — so comparing the two would be vacuous on every configured run.
    const source = readFileSync(fileURLToPath(import.meta.url), "utf8");
    const fallback =
      /process\.env\["DATABASE_URL"\] \?\?\s*\n\s*"([^"]+)"/.exec(source);
    expect(
      fallback?.[1],
      `the fallback literal this file reads DATABASE_URL against, which \`packages/storage-postgres/src/Database.ts\` also spells out`,
    ).toBe(expected);
  });
});

/**
 * The stamp in a run's database name, round-tripped and refused (LOB-134).
 *
 * The sweep reads an orphan's age out of its name and nothing else, so the only thing standing
 * between "a killed run's database" and "someone's database" is this decode. It has to fail *closed*
 * — a name it cannot read is one it must not drop — which is why every refusal below is a value, not
 * a throw: a throw at import would stop the run, which is the wrong failure for a bookkeeping step.
 *
 * These are pure functions over strings, so they are asserted here rather than through a real
 * `DROP DATABASE`. The end-to-end sweep is proved by the drive (a seeded orphan that outlives a run
 * is not something this file can stage for itself, since the sweep runs before the first case).
 *
 * Mutation checked: making `runStartedAt` return `0` for an unreadable tail instead of `undefined`.
 * The sweep would then read an unknown-age database as an hour-old one and drop it, and the last
 * case here goes red on it.
 */
describe("the abandoned-run sweep", () => {
  /** Create a database under this run's prefix, so the sweep below has something to decide about. */
  const createDecoy = (name: string) =>
    maintenance.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        yield* sql`CREATE DATABASE ${sql(name)}`;
      }).pipe(Effect.orDie),
    );

  /** Drop a decoy whatever the case did, so a red case is not also a leaked database. */
  const dropDecoy = (name: string) =>
    maintenance.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        yield* sql`DROP DATABASE IF EXISTS ${sql(name)} WITH (FORCE)`;
      }).pipe(Effect.orDie),
    );

  const databaseExists = (name: string) =>
    maintenance.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        const rows = yield* sql<{ present: boolean }>`
          SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = ${name}) AS present
        `;
        return rows[0]?.present ?? false;
      }).pipe(Effect.orDie),
    );

  /** The server's idea of now, read the way the sweep reads it. */
  const nowMillis = () => maintenance.runPromise(Clock.currentTimeMillis);

  /**
   * A fixed instant rather than the clock: the round trip is exact either way, and a literal makes
   * the encoding cases statements about the encoding rather than about when they happened to run.
   */
  const AN_INSTANT = 1_789_000_000_000;
  /** Far enough past the hour threshold that no run of this suite can make it young again. */
  const TWO_HOURS = 2 * 60 * 60 * 1000;

  /**
   * The sweep's own decisions, driven against real databases.
   *
   * This is the case the issue asks for under AC3 ("a seeded orphan that survives a run is the
   * shape"), and the reason it exists is that the module-level sweep runs at import — before any case
   * in this file exists — so a seeded orphan cannot be watched disappear by the real call. Calling
   * `sweepAbandonedRunDatabases` directly stages exactly what that call sees and nothing else, which
   * turns three conditions into three assertions instead of leaving them to a hand-run drive.
   *
   * Both ages come from the clock rather than from `AN_INSTANT`, because a literal that is "fresh"
   * today is an hour old next month, and a decoy meant to prove the age clause *keeps* a database
   * must never be able to drift into the set it drops. That is not hypothetical: the first version
   * of this case used a literal about ten days in the past and the sweep dropped its own "fresh"
   * decoy, which is the age clause working and the fixture lying.
   *
   * The cleanup runs in a `finally`: this file creates and drops databases for its own reasons, and a
   * case that leaked three more on failure would be the leak it exists to argue about.
   */
  it("drops only the database that is old, unclaimed and decodable", async () => {
    const now = await nowMillis();
    // Built through the same tail the sweep decodes, so the only thing separating these two is age.
    const old = `${runDatabasePrefix}${runDatabaseTail(now - TWO_HOURS)}`;
    const fresh = `${runDatabasePrefix}${runDatabaseTail(now)}`;
    // The shape a database minted before this file encoded a stamp has: prefix, random characters,
    // no `_`, so nothing decodes an age out of it. The random characters are load-bearing and not
    // decoration: a *fixed* literal here collides with a concurrent run of this same file on the
    // same server, which answers `42P04 database … already exists` and reds this case (measured,
    // and it is the shape the `runDatabaseName` doc comment's random-characters rationale prevents). The other
    // four decoys get their uniqueness from `runDatabaseTail` for the same reason.
    const unstamped = `${runDatabasePrefix}${randomBytes(3).toString("hex")}`;
    // Old, unclaimed and decodable like `old`, and *not* this file's: the prefix's first `_` is
    // spelled `X`, so the name differs by one character from anything this file can mint while still
    // matching the prefix under `LIKE`, where `_` is a single-character wildcard. It is here so the
    // sweep's `starts_with` has something a `LIKE` would take and it must not — the reach this
    // clause exists to prevent, which is dropping a database this file did not create.
    const wild = `${runDatabasePrefix.replace("_", "X")}${runDatabaseTail(now - TWO_HOURS)}`;
    // The same reach from the other side: a database under a *neighbouring* prefix, which a sweep
    // that matched one prefix too widely would collect. `LIKE` misses it (`_core_` is not a
    // wildcard-safe suffix for `%`) and `starts_with` on the real prefix does too, so only widening
    // the matched prefix reaches it.
    const neighbour = `${runDatabasePrefix.slice(0, -"_core_".length)}decoy_${runDatabaseTail(now - TWO_HOURS)}`;
    const decoys = [old, fresh, unstamped, wild, neighbour];
    try {
      for (const name of decoys) await createDecoy(name);
      // Nothing was created by accident: every decoy the verdicts below turn on has to exist first,
      // or "the fresh one survived" would pass on a database that was never there.
      //
      // `old` is deliberately excluded from this pre-check. It is a two-hour-old, zero-connection
      // database under the prefix — precisely what a *concurrent* run's import-time sweep collects —
      // so asserting its presence here races that sweep and would fail this case on the fixture
      // rather than on the sweep (a low-probability window, but the whole test body is inside it).
      // It needs no pre-check: its own verdict is `toBe(false)`, which cannot pass on a database
      // that was never there, and the four that must *survive* all would.
      for (const name of [fresh, unstamped, wild, neighbour]) {
        expect(await databaseExists(name), `${name} was never created`).toBe(
          true,
        );
      }
      await maintenance.runPromise(
        sweepAbandonedRunDatabases.pipe(Effect.orDie),
      );
      expect(
        await databaseExists(old),
        "the hour-old, connection-free, decodable database is what the sweep exists to collect",
      ).toBe(false);
      expect(await databaseExists(fresh), "too young to be abandoned").toBe(
        true,
      );
      expect(
        await databaseExists(unstamped),
        "no stamp, so no age to read, so not this sweep's to drop",
      ).toBe(true);
      expect(
        await databaseExists(wild),
        "old, unclaimed and decodable, but its name is not under the prefix — a LIKE would match it and drop a database this file never created",
      ).toBe(true);
      expect(
        await databaseExists(neighbour),
        "old, unclaimed and decodable, but under a neighbouring prefix — a sweep matching one prefix too widely would collect a database this file never created",
      ).toBe(true);
      // This run's own database is the one a sweep must never touch, and it is the one under test.
      expect(await databaseExists(runDatabaseName)).toBe(true);
    } finally {
      for (const name of decoys) await dropDecoy(name);
    }
  });

  /**
   * A live run's database is not an orphan however old it is.
   *
   * The connection is a real one, held by a second `PgClient` on the decoy's own URL, because the
   * condition under test is what `pg_stat_activity` reports — a faked count would test the faker.
   *
   * Staging it is a race this case has to win, and losing *that* is not a failure. The decoy must be
   * old (that is half of what is under test) and it cannot be connected to until it exists, so
   * between the `CREATE` and the first connect it is *old, unclaimed and decodable* — precisely the
   * set the sweep collects. Under two concurrent runs of this file the other run's module-level
   * sweep can land in that window (measured: `effect/sql/SqlError: PgConnection: Connection closed`,
   * which is the holder discovering the database it was told to connect to had been collected). The
   * sweep behaving as specified is not a red case, so **only the staging is retried** — bounded, with
   * the last attempt rethrown so a genuine inability to stage still surfaces.
   *
   * The retry deliberately stops before the sweep and the assertion. An earlier version had the
   * `expect` inside the retried `try`, which meant an *intermittent* misjudgement by the sweep —
   * dropping a database that really did hold a connection — would be swallowed as if it were a lost
   * staging race and retried until it passed. Only `createDecoy` and the holder's first connect are
   * the race; after the connection is established the case asserts once, and a red there is a real
   * finding. (`mutation-M3-connections-check-dropped` reddens deterministically and so never
   * exposed this; only the intermittent form would have.)
   */
  it("keeps a database that still has a connection, however old it is", async () => {
    const ATTEMPTS = 6;
    /** Every name this case minted, so a stranded one is dropped rather than left for the sweep. */
    const staged: string[] = [];
    // Set by the staging loop and read after it: a fresh holder per attempt is disposable, the
    // connected database it holds is not, so only the last one is kept for the assertion. The type is
    // `makeHolder`'s own inference rather than a written `ReturnType<typeof ManagedRuntime.make>`,
    // because `make` is generic and naming it directly widens the scope to `unknown`, which does not
    // assign back to the runtime it came from.
    const makeHolder = (name: string) => {
      const url = new URL(configuredUrl);
      url.pathname = `/${name}`;
      return ManagedRuntime.make(
        PgClient.layer({
          url: Redacted.make(url.toString()),
          maxConnections: 1,
        }).pipe(Layer.provide(BunServices.layer)),
      );
    };
    let held:
      | { name: string; holder: ReturnType<typeof makeHolder> }
      | undefined;
    let stagingError: unknown;
    try {
      for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
        // A fresh name per attempt, because a run's module-level sweep happens exactly once at
        // import: a decoy stranded after a lost race is collected by nobody afterwards, and a fixed
        // name would answer `42P04 already exists` on every retry (measured — twice in five
        // concurrent pairs, before this became per-attempt).
        const name = `${runDatabasePrefix}${runDatabaseTail((await nowMillis()) - TWO_HOURS)}`;
        staged.push(name);
        // A fresh runtime per attempt: a pool whose first connect landed on a collected database is
        // not a pool worth reusing, and rebuilding it costs a few milliseconds on a path that only
        // runs when a concurrent run won the race.
        const holder = makeHolder(name);
        try {
          await createDecoy(name);
          // Force the pool to open, so the backend exists and `pg_stat_activity` can count it.
          await holder.runPromise(
            Effect.gen(function* () {
              const sql = yield* SqlClient;
              yield* sql`SELECT 1`;
            }).pipe(Effect.orDie),
          );
          held = { name, holder };
          break;
        } catch (error) {
          // Disposal is inside this `catch` rather than a sibling `finally`: an exception thrown
          // from a `finally` is *not* caught by the `catch` beside it, so a failing `dispose` would
          // abandon the retry loop entirely instead of restaging.
          await holder.dispose().catch(() => undefined);
          await dropDecoy(name).catch(() => undefined);
          stagingError = error;
        }
      }
      if (held === undefined) throw stagingError;
      await maintenance.runPromise(
        sweepAbandonedRunDatabases.pipe(Effect.orDie),
      );
      expect(
        await databaseExists(held.name),
        "an old database with a live connection is a long run, not an orphan",
      ).toBe(true);
    } finally {
      // The disposal is `.catch`ed before the drop loop, not after it or in a sibling `finally`:
      // a rejecting `dispose` would abandon the loop and strand every name in `staged`, and a red
      // case leaking the databases it made is the exact class of leak this issue exists to collect.
      await held?.holder.dispose().catch(() => undefined);
      for (const name of staged) await dropDecoy(name);
    }
  }, 30_000);

  it("reads back the start time it encoded", () => {
    const at = AN_INSTANT;
    const name = `${runDatabasePrefix}${runDatabaseTail(at)}`;
    expect(name.startsWith(runDatabasePrefix)).toBe(true);
    // Exact, not approximate: an hour of margin on the age check is worth nothing if the round trip
    // is lossy, and the stamp is the only age there is.
    expect(runStartedAt(name.slice(runDatabasePrefix.length), at)).toBe(at);
  });

  it("refuses a tail it cannot read rather than guessing at its age", () => {
    // The shape a database minted before this file encoded a stamp has: prefix, random characters,
    // nothing else. Dropping it would mean deciding an unknown age is old, which is the exact
    // mistake the stamp exists to prevent.
    expect(runStartedAt("33d7d8", AN_INSTANT)).toBeUndefined();
    // Random characters with no separator, so the base-36 half is absent.
    expect(runStartedAt("33d7d8_", AN_INSTANT)).toBeUndefined();
    // Base 36 is dense enough that `notbase36` is nine *legal* digits, so it parses — to a year far
    // past any run, which is what makes rejecting it by width worth a case. What rejects it is the
    // width: no stamp this file mints is longer than the current one.
    expect(Number.parseInt("notbase36", 36)).toBeGreaterThan(AN_INSTANT);
    expect(runStartedAt("33d7d8_notbase36", AN_INSTANT)).toBeUndefined();
    // And a zero stamp is not a time, however well shaped.
    expect(runStartedAt("33d7d8_0", AN_INSTANT)).toBeUndefined();
  });

  /**
   * The sweep has to be *called*, and before the `CREATE`.
   *
   * The behaviour is proved by the drive in the PR body — seeding an orphan and watching a run
   * collect it cannot be staged from inside the file, because the sweep runs at import and no case
   * exists yet. What a case *can* do is refuse the wiring that behaviour depends on: a sweep that
   * stops being called, or moves below the `CREATE`, leaves the file green and the leak back.
   */
  it("runs before this file creates its own database", () => {
    const source = readFileSync(fileURLToPath(import.meta.url), "utf8");
    // Anchored to the start of a line, and for exactly that statement. A bare `indexOf` on the
    // callee's name is self-satisfying: this case's own failure message quotes the statement, so
    // deleting the real call would still leave the needle in the file and the guard would go green
    // on a sweep that no longer runs. Nothing here may quote the statement at the start of a line.
    const call =
      /^[ \t]*await maintenance\.runPromise\(sweepAbandonedRunDatabases/m.exec(
        source,
      );
    const create = /sql`CREATE DATABASE/.exec(source);
    expect(
      call?.index,
      "this file never calls the sweep at module scope, so a run killed between CREATE and afterAll leaks forever again: put the call back above the CREATE.",
    ).toBeDefined();
    expect(create?.index).toBeDefined();
    expect(
      call?.index,
      "the sweep must run before the CREATE, or this run's own seconds-old database is a candidate for its own sweep",
    ).toBeLessThan(create?.index ?? 0);
  });

  /**
   * The header's residual-leak claim, kept honest by being required.
   *
   * A sweep that only *reduces* a leak is the kind of thing a future reader upgrades to "collects
   * them" in their own summary. Two phrases the header must keep saying, so deleting either one —
   * which is what an over-claiming edit looks like — is a red test rather than a silent drift.
   */
  it("states in the header that the sweep is best-effort and leaks two ways", () => {
    const source = readFileSync(fileURLToPath(import.meta.url), "utf8");
    const header = source.slice(0, source.indexOf("import {"));
    for (const claim of [
      "Best-effort collection, not a guarantee",
      "no age to read",
    ]) {
      expect(
        header,
        `the header no longer says "${claim}", which is a claim about the sweep's limits rather than about what it does: put it back, or re-measure and rewrite the header.`,
      ).toContain(claim);
    }
  });

  it("keeps every name it can mint inside Postgres' 63-byte identifier limit", () => {
    // The limit applies to a quoted identifier too, and a truncated tail would collide two runs.
    // Asked with a base long enough to hit the limit, not the run-context database's short one, and
    // with the widest stamp base 36 can hold — nine digits — rather than today's eight.
    //
    // The reservation is asked of `runDatabasePrefixFor` rather than re-derived here, which is the
    // whole reason it is a function: a local `63 - reserved` would be a second copy of the
    // arithmetic, and narrowing the real one by a character would leave this case green over a name
    // Postgres truncates silently.
    const widestStamp = "zzzzzzzzz";
    const overlong = `${"a".repeat(63)}_core_${randomBytes(3).toString("hex")}_${widestStamp}`;
    expect(overlong.length).toBeGreaterThan(63);
    // `runDatabaseTail` is asked for an instant that renders as nine base-36 digits, so the name
    // measured here is the longest this file can ever mint, not merely the longest minted today.
    const widestInstant = Number.parseInt(widestStamp, 36);
    expect(`${runDatabaseTail(widestInstant)}`.length).toBe(
      RUN_RANDOM_CHARS + 1 + 9,
    );
    expect(
      `${runDatabasePrefixFor(overlong)}${runDatabaseTail(widestInstant)}`
        .length,
    ).toBeLessThanOrEqual(63);
  });
});

/**
 * The autonomy configuration is a config surface, not a constant (LOB-8, docs/design.md D11).
 *
 * `SessionServiceOptions.autonomy` is what a deployment narrows or widens, and nothing else in this
 * suite can tell whether it reaches the hook: D11's default *allows* a push to
 * `refs/heads/factory/**`, so the session below runs a command the default permits and the narrowed
 * configuration must refuse. A `SessionServiceLive` that forgot to hand the policy to
 * `openSession` would fall back to the default and fail here.
 */
describe("the autonomy configuration reaches the session's policy", () => {
  const autonomyRoot = mkdtempSync(join(tmpdir(), "factory-core-autonomy-"));
  const runtime = ManagedRuntime.make(
    SessionServiceLive({
      model: createModelAccess("faux", {
        fauxCommand: "git push origin refs/heads/factory/ses_1",
      }),
      sessionRoot: autonomyRoot,
      autonomy: { pushRefPrefixes: ["refs/heads/sandbox/"], allowedHosts: [] },
    }).pipe(Layer.provideMerge(DatabaseLayer)),
  );

  afterAll(async () => {
    await runtime.dispose();
  });

  it("refuses a push the default would allow", async () => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const created = yield* sessions.create({ title: "narrowed" });
        const sent = yield* sessions.send({
          sessionId: created.id,
          content: "push",
        });
        expect(sent.placement).toBe("run");
        yield* waitUntil(
          sessions
            .get(created.id)
            .pipe(Effect.map((snapshot) => !snapshot.live.busy)),
          "the turn to settle",
        );
        const snapshot = yield* sessions.get(created.id);
        return snapshot.entries.find((entry) => entry.kind === "toolResult");
      }),
    );

    expect(result?.isError).toBe(true);
    expect(result?.text).toContain(
      "pushing refs/heads/factory/ses_1 is refused",
    );
    expect(result?.text).toContain("refs/heads/sandbox/");
  });
});

/**
 * A gated call asks through the approvals service (D15, LOB-52).
 *
 * The faux run calls `bash` with a command the deployment gates, so the session's policy asks
 * instead of running it. What the suite holds the service to: the ask is the same row and log entry
 * an RPC `requestApproval` writes, so the pending list and the snapshot both carry it; the turn ends
 * rather than waiting on a person; a second turn that retries the same call records no second
 * request — in the index *or* in the log, which is counted as committed rows because the fold would
 * hide a duplicate — and is told so; once a person approves, the same call runs, once: the approval
 * is spent (in the log and the row, and a rebuild keeps it spent), and the turn after that asks a
 * person again under a new request id.
 */
describe("a gated call asks through the approvals service", () => {
  const gateRoot = mkdtempSync(join(tmpdir(), "factory-core-gate-"));
  const command = "sleep 0 && echo gated-ran";
  // The stock faux script calls `bash` on a session's first turn only; this one calls it on every
  // turn, which is what an agent retrying a gated call looks like.
  const faux = createFauxModelAccess({
    fauxCommand: command,
    fauxEveryTurn: true,
  });
  const runtime = ManagedRuntime.make(
    SessionServiceLive({
      model: faux.access,
      sessionRoot: gateRoot,
      autonomy: { ...DEFAULT_AUTONOMY, approvalRequired: ["sleep"] },
    }).pipe(Layer.provideMerge(DatabaseLayer)),
  );

  afterAll(async () => {
    await runtime.dispose();
  });

  /** How many commits in a session's log hold `kind`: the log, not its fold. */
  const commitsOf = (sessionId: string, kind: string) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const rows = yield* sql<{ count: number }>`
        SELECT count(*)::int AS count FROM commits
        WHERE log_id = ${sessionId} AND strpos(writes::text, ${kind}) > 0
      `;
      return rows[0]?.count ?? 0;
    });
  const requestCommits = (sessionId: string) =>
    commitsOf(sessionId, "factory.approval.requested");

  /** Whether the index row says the approval was spent. */
  const usedInIndex = (sessionId: string, requestId: string) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const rows = yield* sql<{ used: boolean }>`
        SELECT used_at IS NOT NULL AS used FROM session_approvals
        WHERE session_id = ${sessionId} AND request_id = ${requestId}
      `;
      return rows[0]?.used ?? false;
    });

  const turn = (sessionId: SessionId) =>
    Effect.gen(function* () {
      const sessions = yield* SessionService;
      const sent = yield* sessions.send({ sessionId, content: "publish" });
      expect(sent.placement).toBe("run");
      yield* waitUntil(
        sessions
          .get(sessionId)
          .pipe(Effect.map((snapshot) => !snapshot.live.busy)),
        "the turn to settle",
      );
      return yield* sessions.get(sessionId);
    });

  it("asks once, parks idle, re-asks nothing, and runs the call once it is approved", async () => {
    const outcome = await runtime.runPromise(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const created = yield* sessions.create({ title: "gated" });
        const first = yield* turn(created.id);
        const pendingFirst = yield* sessions.listApprovals(created.id);
        const commitsFirst = yield* requestCommits(created.id);
        const second = yield* turn(created.id);
        const pendingSecond = yield* sessions.listApprovals(created.id);
        const commitsSecond = yield* requestCommits(created.id);
        const requestId = pendingSecond.approvals[0]?.requestId ?? "";
        yield* sessions.decideApproval({
          sessionId: created.id,
          requestId,
          decision: "approved",
          actor: "ops@example",
        });
        const third = yield* turn(created.id);
        const pendingThird = yield* sessions.listApprovals(created.id);
        const commitsThird = yield* requestCommits(created.id);
        const usedCommits = yield* commitsOf(
          created.id,
          "factory.approval.used",
        );
        const usedThird = yield* usedInIndex(created.id, requestId);
        // Lose the row and refold it: the use is in the log, so the rebuilt row is still spent.
        const sql = yield* SqlClient;
        yield* sql`DELETE FROM session_approvals WHERE session_id = ${created.id}`;
        yield* rebuildIndexes;
        const usedRebuilt = yield* usedInIndex(created.id, requestId);
        const fourth = yield* turn(created.id);
        const pendingFourth = yield* sessions.listApprovals(created.id);
        return {
          first,
          second,
          third,
          fourth,
          requestId,
          pendingFirst,
          pendingSecond,
          pendingThird,
          pendingFourth,
          commitsFirst,
          commitsSecond,
          commitsThird,
          commitsFourth: yield* requestCommits(created.id),
          usedCommits,
          usedThird,
          usedRebuilt,
        };
      }),
    );

    const results = (snapshot: SessionSnapshot) =>
      snapshot.entries.filter((entry) => entry.kind === "toolResult");

    // The first turn asked, and the call did not run.
    expect(outcome.pendingFirst.approvals).toHaveLength(1);
    expect(outcome.pendingFirst.approvals[0]).toMatchObject({
      action: "sleep",
      detail: command,
    });
    expect(outcome.pendingFirst.approvals[0]?.requestId).toMatch(
      /^ask-bash-[0-9a-f]{32}$/,
    );
    expect(outcome.first.approvals).toEqual(outcome.pendingFirst.approvals);
    expect(outcome.first.session.status).toBe("idle");
    const asked = results(outcome.first)[0];
    expect(asked?.isError).toBe(true);
    expect(asked?.text).toContain("one has been asked for");
    expect(asked?.text).not.toContain("gated-ran");
    expect(outcome.commitsFirst).toBe(1);

    // The second turn retried the same call: still one request, in the index and in the log.
    expect(outcome.pendingSecond.approvals).toEqual(
      outcome.pendingFirst.approvals,
    );
    expect(outcome.commitsSecond).toBe(1);
    expect(results(outcome.second)).toHaveLength(2);
    expect(results(outcome.second)[1]?.isError).toBe(true);
    expect(results(outcome.second)[1]?.text).toContain(
      "is not asked for again",
    );

    // Approved: the same call runs, and asks nothing new.
    expect(outcome.pendingThird.approvals).toEqual([]);
    expect(outcome.commitsThird).toBe(1);
    const ran = results(outcome.third)[2];
    expect(ran?.isError).toBe(false);
    expect(ran?.text).toContain("gated-ran");
    // Spent: once in the log, in the row, and still after the row was refolded from the log.
    expect(outcome.usedCommits).toBe(1);
    expect(outcome.usedThird).toBe(true);
    expect(outcome.usedRebuilt).toBe(true);

    // The same call again is a new run, and a new run needs a new yes: asked under a new id.
    expect(outcome.pendingFourth.approvals).toHaveLength(1);
    expect(outcome.pendingFourth.approvals[0]).toMatchObject({
      requestId: `${outcome.requestId}-2`,
      action: "sleep",
      detail: command,
    });
    expect(outcome.commitsFourth).toBe(2);
    const askedAgain = results(outcome.fourth)[3];
    expect(askedAgain?.isError).toBe(true);
    expect(askedAgain?.text).toContain("one has been asked for");
    expect(askedAgain?.text).toContain(`${outcome.requestId}-2`);
    expect(askedAgain?.text).not.toContain("gated-ran");
  });

  /** A snapshot once the session is idle and its transcript holds `results` tool results. */
  const settledWith = (sessionId: SessionId, results: number) =>
    Effect.gen(function* () {
      const sessions = yield* SessionService;
      yield* waitUntil(
        sessions
          .get(sessionId)
          .pipe(
            Effect.map(
              (snapshot) =>
                !snapshot.live.busy &&
                snapshot.entries.filter((entry) => entry.kind === "toolResult")
                  .length >= results,
            ),
          ),
        `${results} tool results and an idle session`,
      );
      return yield* sessions.get(sessionId);
    });

  it("resumes the parked run with the decision, runs the call, and resumes once however often it is repeated", async () => {
    const outcome = await runtime.runPromise(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const created = yield* sessions.create({ title: "gated, resumed" });
        yield* turn(created.id);
        const request = (yield* sessions.listApprovals(created.id))
          .approvals[0];
        const decide = sessions.decideApproval({
          sessionId: created.id,
          requestId: request?.requestId ?? "",
          decision: "approved",
          actor: "ops@example",
          resume: true,
        });
        // No message from a person: the decision itself wakes the run.
        const decision = yield* decide;
        const resumed = yield* settledWith(created.id, 2);
        const again = yield* decide;
        const after = yield* sessions.get(created.id);
        return {
          request,
          decision,
          again,
          resumed,
          after,
          pending: yield* sessions.listApprovals(created.id),
        };
      }),
    );
    const users = (snapshot: SessionSnapshot) =>
      snapshot.entries.filter((entry) => entry.kind === "user");
    const results = (snapshot: SessionSnapshot) =>
      snapshot.entries.filter((entry) => entry.kind === "toolResult");

    expect(outcome.request).toBeDefined();
    if (outcome.request === undefined) throw new Error("unreachable");
    expect(outcome.decision.resumedWith).toBeDefined();
    // The follow-up is the decision, in the words the agent reads.
    expect(users(outcome.resumed).map((entry) => entry.text)).toEqual([
      "publish",
      approvalResumeMessage(outcome.request, outcome.decision),
    ]);
    // The resumed run retried the call, and it ran.
    const ran = results(outcome.resumed)[1];
    expect(ran?.isError).toBe(false);
    expect(ran?.text).toContain("gated-ran");
    expect(outcome.pending.approvals).toEqual([]);
    // A repeated decision is the same decision and the same follow-up: the session resumed once.
    expect(outcome.again.resumedWith).toBe(outcome.decision.resumedWith);
    expect(users(outcome.after)).toHaveLength(2);
    expect(results(outcome.after)).toHaveLength(2);
  });

  it("resumes a denied run with the denial, and the call stays refused", async () => {
    const outcome = await runtime.runPromise(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const created = yield* sessions.create({
          title: "gated, denied, resumed",
        });
        yield* turn(created.id);
        const request = (yield* sessions.listApprovals(created.id))
          .approvals[0];
        const decision = yield* sessions.decideApproval({
          sessionId: created.id,
          requestId: request?.requestId ?? "",
          decision: "denied",
          actor: "ops@example",
          resume: true,
        });
        return { decision, resumed: yield* settledWith(created.id, 2) };
      }),
    );
    expect(outcome.decision.resumedWith).toBeDefined();
    const users = outcome.resumed.entries.filter(
      (entry) => entry.kind === "user",
    );
    expect(users[1]?.text).toMatch(/^Denied: `sleep` \(request ask-bash-/);
    const refused = outcome.resumed.entries.filter(
      (entry) => entry.kind === "toolResult",
    )[1];
    expect(refused?.isError).toBe(true);
    expect(refused?.text).toContain("was denied by ops@example");
    expect(refused?.text).not.toContain("gated-ran");
  });

  it("refuses the same call for the rest of the session once it is denied, asking nothing new", async () => {
    const outcome = await runtime.runPromise(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const created = yield* sessions.create({ title: "gated, denied" });
        yield* turn(created.id);
        const pending = yield* sessions.listApprovals(created.id);
        yield* sessions.decideApproval({
          sessionId: created.id,
          requestId: pending.approvals[0]?.requestId ?? "",
          decision: "denied",
          actor: "ops@example",
        });
        const denied = yield* turn(created.id);
        const again = yield* turn(created.id);
        return {
          denied,
          again,
          pendingAfter: yield* sessions.listApprovals(created.id),
          commits: yield* requestCommits(created.id),
        };
      }),
    );

    const results = (snapshot: SessionSnapshot) =>
      snapshot.entries.filter((entry) => entry.kind === "toolResult");
    for (const result of [
      results(outcome.denied)[1],
      results(outcome.again)[2],
    ]) {
      expect(result?.isError).toBe(true);
      expect(result?.text).toContain("was denied by ops@example");
      expect(result?.text).not.toContain("gated-ran");
    }
    expect(outcome.pendingAfter.approvals).toEqual([]);
    expect(outcome.commits).toBe(1);
  });
});

/**
 * A session's directory and tool environment hold no credential (LOB-51, docs/design.md D14).
 *
 * The control plane resolves a token from `CredentialProvider` only at the point a caller needs one
 * (the push path, the PR client). Nothing hands it to a session, so a real `bash` call in a faux
 * session sees none of its bytes: not in the environment the command prints, not in any file under
 * the session's working directory, not in the path itself.
 */
describe("a session holds no credential", () => {
  const credentialRoot = mkdtempSync(
    join(tmpdir(), "factory-core-credential-"),
  );
  const token = "ghp_TESTONLY_static_token_0123456789";
  const provider = staticTokenProvider(Option.some(Redacted.make(token)));
  // oxlint-disable-next-line effecttsgo/process-env -- the test sets the variable the tool would inherit.
  const env = process.env;
  const previousEnv = env["GITHUB_TOKEN"];
  const runtime = ManagedRuntime.make(
    SessionServiceLive({
      model: createModelAccess("faux", {
        fauxCommand: "printenv; find . -type f -exec cat {} + 2>/dev/null; pwd",
      }),
      sessionRoot: credentialRoot,
    }).pipe(Layer.provideMerge(DatabaseLayer)),
  );

  beforeAll(() => {
    // The configured token sits in the process environment the tool would inherit, so the
    // assertions below are not vacuous: a leak through the environment would show up.
    env["GITHUB_TOKEN"] = token;
  });

  afterAll(async () => {
    if (previousEnv === undefined) delete env["GITHUB_TOKEN"];
    else env["GITHUB_TOKEN"] = previousEnv;
    await runtime.dispose();
  });

  it("runs a bash call that cannot see the configured token", async () => {
    expect(env["GITHUB_TOKEN"]).toBe(token);
    // The consumer resolves the token itself, as the push path would, and then does its work.
    const resolved = await Effect.runPromise(provider.tokenFor(factoryRepo));
    expect(Redacted.value(resolved)).toBe(token);

    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const created = yield* sessions.create({ title: "no credential" });
        yield* sessions.send({ sessionId: created.id, content: "look" });
        yield* waitUntil(
          sessions
            .get(created.id)
            .pipe(Effect.map((snapshot) => !snapshot.live.busy)),
          "the turn to settle",
        );
        const snapshot = yield* sessions.get(created.id);
        const toolResult = snapshot.entries.find(
          (entry) => entry.kind === "toolResult",
        );
        return { toolResult, workspace: snapshot.workspace.path };
      }),
    );

    // The tool ran: its output is the environment and the working directory.
    expect(result.toolResult?.isError).not.toBe(true);
    expect(result.toolResult?.text).toContain(result.workspace);
    expect(result.toolResult?.text).not.toContain(token);
    expect(result.workspace).not.toContain(token);

    // Every regular file under the session root (the session directory included) is free of it.
    const files = (
      readdirSync(credentialRoot, { recursive: true }) as string[]
    ).filter((file) => statSync(join(credentialRoot, file)).isFile());
    for (const file of files) {
      const contents = readFileSync(join(credentialRoot, file), "utf8");
      expect(contents).not.toContain(token);
    }
  });
});

/**
 * A mission over the service (LOB-230): start one, and read the phase it reached off the session's
 * snapshot rather than off a second call.
 *
 * The phases run as one durable task (`packages/harness/src/mission.ts`), so this is the case the
 * harness suite cannot make: the task is admitted by a service call, and the answer is read back
 * through the same `getSession` a client uses. A scratch session declares no `.factory/config`, so
 * the mission reaches `verify` and fails there for the honest reason — the repo declares no verify
 * command — which is a settled mission whose phase is still readable.
 */
describe("a mission on a session", () => {
  it("reports no mission for a session that never started one", async () => {
    const snapshots = await program(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const created = yield* sessions.create({ title: "no mission" });
        const live = yield* sessions.get(created.id);
        // The fold is a different read path and must not disagree about there being no mission.
        yield* sessions.close;
        const folded = yield* sessions.get(created.id);
        return { live, folded };
      }),
    );

    // Absent, not an empty phase: "no mission" and "a mission with no phase yet" are different
    // facts, and a client handed `phase: ""` would have to guess which one it got.
    expect(snapshots.live.mission).toBeUndefined();
    expect(snapshots.folded.mission).toBeUndefined();
    expect(snapshots.folded.session.mode).toBe("historical");
  }, 120_000);

  it("starts one, answers its id, and reports the phase it reached", async () => {
    const outcome = await program(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const created = yield* sessions.create({ title: "a mission" });
        const started = yield* sessions.startMission({
          sessionId: created.id,
          feature: "a mission over the service",
        });
        // The phase the mission is in, as it commits phases: `plan` first, and `verify` once the
        // phases have run. Read through the snapshot, which is the surface the contract names.
        yield* waitUntil(
          sessions
            .get(created.id)
            .pipe(
              Effect.map((snapshot) => snapshot.mission?.phase === "verify"),
            ),
          "the mission to reach verify",
        );
        const snapshot = yield* sessions.get(created.id);
        // The mission settles there: a scratch session declares no verify command, so the phase
        // that runs is the one that reports it. The task is gone from the live list, the record is
        // not — that is what makes the phase readable after the work has stopped.
        yield* waitUntil(
          sessions
            .get(created.id)
            .pipe(
              Effect.map(
                (state) =>
                  !state.tasks.some((task) => task.kind === "factory.mission"),
              ),
            ),
          "the mission to settle",
        );
        const settled = yield* sessions.get(created.id);
        // Release the owner: the mission's record is a document, so the fold reports it too.
        yield* sessions.close;
        const folded = yield* sessions.get(created.id);
        return { started, snapshot, settled, folded };
      }),
    );

    // The id the call answered is the mission's, and it is the one the snapshot names.
    expect(outcome.started.sessionId).toBe(outcome.snapshot.session.id);
    expect(outcome.started.taskId).toEqual(expect.any(String));
    expect(outcome.snapshot.mission).toEqual({
      taskId: outcome.started.taskId,
      phase: "verify",
      entered: ["plan", "implement", "verify"],
    });
    // A settled mission still reports the phase it reached, and the transcript says nothing about
    // it: a mission is not a turn (the phases that do work are LOB-231's).
    expect(outcome.settled.mission).toEqual(outcome.snapshot.mission);
    expect(outcome.settled.tasks.map((task) => task.kind)).not.toContain(
      "factory.mission",
    );
    expect(outcome.settled.entries.some((entry) => entry.kind === "user")).toBe(
      false,
    );
    // D8: the live read and the fold must not disagree about the mission either.
    expect(outcome.folded.session.mode).toBe("historical");
    expect(outcome.folded.mission).toEqual(outcome.snapshot.mission);
  }, 120_000);

  it("reports no mission on a fork of a session that ran one", async () => {
    const outcome = await program(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const created = yield* sessions.create({ title: "forked mission" });
        yield* sessions.startMission({
          sessionId: created.id,
          feature: "a mission the fork must not inherit",
        });
        yield* waitUntil(
          sessions
            .get(created.id)
            .pipe(Effect.map((snapshot) => snapshot.mission !== undefined)),
          "the parent to record its mission",
        );
        const parent = yield* sessions.get(created.id);
        const fork = yield* sessions.fork({
          sessionId: created.id,
          at: parent.entries[parent.entries.length - 1]?.id,
        });
        const forked = yield* sessions.get(fork.id);
        return { parent, forked };
      }),
    );

    // The parent has a mission; the fork has none. A fork is a new log whose entries are copied and
    // whose mission documents are not (`copyEntries`), so this also pins that: a fork that grew a
    // mission out of its parent's log would report a phase nothing in this log ever ran.
    expect(outcome.parent.mission?.taskId).toEqual(expect.any(String));
    expect(outcome.forked.mission).toBeUndefined();
  }, 120_000);

  it("refuses a mission with no feature, and answers no id for it", async () => {
    const outcome = await program(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const created = yield* sessions.create({ title: "blank mission" });
        const refused = yield* Effect.result(
          sessions.startMission({ sessionId: created.id, feature: "   " }),
        );
        const snapshot = yield* sessions.get(created.id);
        return { refused, snapshot };
      }),
    );

    // A blank feature is refused before a task is created: a mission whose phases and result are
    // about nothing is worse than a typed error.
    expect(outcome.refused._tag).toBe("Failure");
    expect(
      outcome.refused._tag === "Failure"
        ? outcome.refused.failure.message
        : undefined,
    ).toContain("feature");
    expect(outcome.snapshot.mission).toBeUndefined();
  }, 120_000);
});

/**
 * The `verify` tool is given the workspace the service resolved (LOB-78): the repo's declared
 * `verify` command, and the base ref the branch's changes are measured against.
 *
 * The repo declares a command *and* holds a verify skill for the same surface, and the two disagree
 * (the skill exits 9), so only the declared command reaching the tool can make this pass. The run's
 * change is committed on the session's branch by its own `bash` turn, so it is in the branch's diff
 * against `main` and in nothing uncommitted: only the base reaching the tool lets it see the change
 * at all. The record is read back out of the session's own log, the way part 2 (LOB-79) will.
 */
describe("the verify tool reads the session's workspace", () => {
  const verifyRoot = mkdtempSync(join(tmpdir(), "factory-core-verify-"));
  const verifyRepoRoot = mkdtempSync(join(tmpdir(), "factory-repo-verify-"));
  const verifyRepo = RepoSlugSchema.make("lobiklukas/verify-fixture");
  const declared =
    'echo "declared verify for $FACTORY_VERIFY_SURFACE covering $FACTORY_VERIFY_SURFACES"';

  beforeAll(() => {
    const git = (command: string) =>
      execSync(command, { cwd: verifyRepoRoot, stdio: "ignore" });
    git("git init -b main");
    git("git config user.email t@t.com");
    git("git config user.name t");
    mkdirSync(join(verifyRepoRoot, ".factory"), { recursive: true });
    writeFileSync(
      join(verifyRepoRoot, ".factory", "config"),
      JSON.stringify({ verify: declared }),
    );
    mkdirSync(join(verifyRepoRoot, ".pi", "skills", "verify-api"), {
      recursive: true,
    });
    writeFileSync(
      join(verifyRepoRoot, ".pi", "skills", "verify-api", "drive.sh"),
      'echo "the skill ran"\nexit 9\n',
    );
    git("git add -A");
    git("git commit -m base");
  });

  it("runs the declared command, not the skill, over the change committed on the branch", async () => {
    const faux = createFauxModelAccess({
      fauxVerify: true,
      // The run's change, committed in its own worktree: a branch diff against `main`, nothing else.
      fauxCommand:
        "mkdir -p apps/api && echo 'export const feature = 1;' > apps/api/feature.ts && " +
        "git add -A && git -c user.email=t@t.com -c user.name=t commit -q -m feature && echo committed",
    });
    const verifyRuntime = ManagedRuntime.make(
      SessionServiceLive({ model: faux.access, sessionRoot: verifyRoot }).pipe(
        Layer.provideMerge(DatabaseLayer),
      ),
    );
    try {
      const result = await verifyRuntime.runPromise(
        Effect.gen(function* () {
          const sessions = yield* SessionService;
          yield* sessions.registerRepo({
            repo: verifyRepo,
            url: "https://github.com/lobiklukas/verify-fixture.git",
            localPath: verifyRepoRoot,
          });
          const created = yield* sessions.create({
            repo: verifyRepo,
            baseRef: "main",
          });
          yield* sessions.send({
            sessionId: created.id,
            content: "make the change and verify it",
          });
          yield* waitUntil(
            Effect.map(
              sessions.get(created.id),
              (snapshot) =>
                snapshot.session.status === "idle" &&
                snapshot.entries.some(
                  (entry) => entry.kind === "assistant" && entry.text !== "",
                ),
            ),
            "the run to verify and answer",
          );
          const snapshot = yield* sessions.get(created.id);
          const sql = yield* SqlClient;
          const records = yield* Effect.acquireUseRelease(
            Effect.promise(() => PostgresStorage.reader(sql, created.id)),
            (storage) => readVerifyRecords(storage),
            (storage) => Effect.promise(() => storage.dispose()),
          );
          return { snapshot, records };
        }),
      );

      expect(result.snapshot.workspace.commands.verify).toBe(declared);
      expect(result.records).toEqual([
        {
          _tag: "VerifyReport",
          changed: ["apps/api/feature.ts"],
          changedCount: 1,
          results: [
            {
              _tag: "VerifyRan",
              // A declared command verifies the repo once, told which surfaces it covers.
              surface: ".",
              source: "workspace",
              directory: ".",
              command: declared,
              exitCode: 0,
              output: "declared verify for . covering api\n",
              truncated: false,
            },
          ],
        },
      ]);
    } finally {
      await verifyRuntime.dispose();
    }
  }, 120_000);

  it("hands the session's verify record to the PR step's write-back, and the Linear comment carries it (LOB-15)", async () => {
    const faux = createFauxModelAccess({
      fauxVerify: true,
      fauxCommand:
        "mkdir -p apps/api && echo 'export const reported = 1;' > apps/api/reported.ts && " +
        "git add -A && git -c user.email=t@t.com -c user.name=t commit -q -m reported && echo committed",
    });
    const url = "https://github.com/lobiklukas/verify-fixture/pull/79";
    const github = makeGithubFake(201, { number: 79, url });
    const reported: Array<readonly VerifyRecord[]> = [];
    const verifyRuntime = ManagedRuntime.make(
      SessionServiceLive({ model: faux.access, sessionRoot: verifyRoot }).pipe(
        Layer.provide(
          Layer.succeed(SessionWriteBack, {
            pullRequest: (input) =>
              Effect.map(input.evidence, (records) => {
                reported.push(records);
              }),
          }),
        ),
        Layer.provideMerge(DatabaseLayer),
      ),
    );
    try {
      const sessionId = await verifyRuntime.runPromise(
        Effect.gen(function* () {
          const sessions = yield* SessionService;
          yield* sessions.registerRepo({
            repo: verifyRepo,
            url: "https://github.com/lobiklukas/verify-fixture.git",
            localPath: verifyRepoRoot,
          });
          const created = yield* sessions.create({
            repo: verifyRepo,
            baseRef: "main",
          });
          yield* sessions.send({
            sessionId: created.id,
            content: "make the change, verify it, open the PR",
          });
          yield* waitUntil(
            Effect.map(
              sessions.get(created.id),
              (snapshot) =>
                snapshot.session.status === "idle" &&
                snapshot.entries.some(
                  (entry) => entry.kind === "assistant" && entry.text !== "",
                ),
            ),
            "the run to verify and answer",
          );
          yield* sessions
            .openPullRequest({
              sessionId: created.id,
              title: "factory: reported",
              head: `factory/${created.id}`,
              base: "main",
            })
            .pipe(Effect.provide(github.layer));
          return created.id;
        }),
      );

      expect(reported).toHaveLength(1);
      const records = reported[0] ?? [];
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        _tag: "VerifyReport",
        changed: ["apps/api/reported.ts"],
      });
      // What a Linear reader sees: the surface, its result, its exit code and the command.
      const comment = linearPullRequestComment(
        {
          apiUrl: "http://linear.test/graphql",
          apiKey: Redacted.make("unused"),
          states: DEFAULT_LINEAR_STATES,
        },
        { sessionId, pr: { number: 79, url }, evidence: records },
      );
      expect(comment).toContain(
        "Verification (the session's one `verify` call):",
      );
      expect(comment).toContain(
        `- \`.\` passed (exit 0): \`${declared}\` in \`.\``,
      );
      expect(comment).not.toContain("No verification was recorded");
    } finally {
      await verifyRuntime.dispose();
    }
  }, 120_000);
});

/**
 * The ask on the task (LOB-73, part 2 of LOB-46; docs/board.md B7).
 *
 * A run bound to a card is offered the `ask` tool; the faux script asks once its `bash` turn is done
 * (`fauxAsk`). The claims are the issue's, in its order: the run is **not busy** after it asks and
 * the card is blocked `needs_input` from the column it was in; the question is on the task; a person's
 * comment is the answer, and the *next* run's recorded prompt — the committed `pi.system` entries,
 * what the model was sent — quotes it verbatim. Between the ask and the answer the service is torn
 * down and a second one built over the same database, which is the restart the drive proves with two
 * processes (`.pi/skills/verify-board/ask.sh`): the question and the block are rows, so nothing an
 * owner held in memory is needed to answer them.
 */
describe("the ask on the task", () => {
  const askRoot = mkdtempSync(join(tmpdir(), "factory-core-ask-"));
  const QUESTION = "Which Postgres major does this target?";
  // Two lines, an em dash and trailing spaces: an answer that was trimmed, wrapped or re-encoded on
  // its way into the prompt would not be found verbatim.
  const ANSWER = "Postgres 16.\n  Keep port 5442 \u2014 it is shared.  ";
  const PERSON = "person:lukas";

  const askRuntime = (faux: ReturnType<typeof createFauxModelAccess>) =>
    ManagedRuntime.make(
      Layer.mergeAll(
        SessionServiceLive({ model: faux.access, sessionRoot: askRoot }),
        TaskServiceLive,
      ).pipe(Layer.provideMerge(DatabaseLayer)),
    );

  const promptOf = (
    sessionId: SessionId,
  ): Effect.Effect<Readonly<Record<string, string>>, SessionError, SqlClient> =>
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      return yield* Effect.acquireUseRelease(
        Effect.promise(() => PostgresStorage.reader(sql, sessionId)),
        (storage) => readPromptSections(storage),
        (storage) => Effect.promise(() => storage.dispose()),
      );
    });

  /** A card in `specifying`, on a board of its own, moved there by a person. */
  const cardInSpecifying = Effect.gen(function* () {
    const sql = yield* SqlClient;
    const tasks = yield* TaskService;
    const boardId = `brd_${randomBytes(13).toString("hex")}`;
    yield* sql`
      INSERT INTO board_instances (id, repo, definition_id, definition_version)
      VALUES (${boardId}, ${`factory-test/${randomBytes(6).toString("hex")}`}, 'default', 1)
    `;
    const card = yield* tasks.create({
      boardId,
      title: "a thin card",
      actor: PERSON,
    });
    return yield* tasks.move({
      taskId: card.id,
      expectedRevision: card.revision,
      to: "specifying",
      actor: PERSON,
    });
  });

  it("parks the run on the card, survives a restart, and quotes the answer into the next run", async () => {
    const first = createFauxModelAccess({ fauxAsk: QUESTION });
    const before = askRuntime(first);
    const asked = await before
      .runPromise(
        Effect.gen(function* () {
          const sessions = yield* SessionService;
          const tasks = yield* TaskService;
          const card = yield* cardInSpecifying;
          const run = yield* sessions.create({
            title: card.title,
            taskId: card.id,
            taskColumn: card.column,
          });
          yield* sessions.send({ sessionId: run.id, content: "specify it" });
          yield* waitUntil(
            Effect.map(
              tasks.get(card.id),
              (task) => task.blocked !== undefined,
            ),
            "the run to ask",
          );
          yield* waitUntil(
            Effect.map(sessions.get(run.id), (snapshot) => !snapshot.live.busy),
            "the asking run to settle",
          );
          return {
            card,
            runId: run.id,
            // Read while this process still owns the run: "not busy" is a claim about a live owner,
            // not about a released log, which reads idle by definition.
            snapshot: yield* sessions.get(run.id),
            blocked: yield* tasks.get(card.id),
            thread: yield* tasks.comments(card.id),
            requests: first.faux.state.callCount,
            prompt: yield* promptOf(run.id),
          };
        }),
      )
      .finally(() => before.dispose());

    // Parked, not hanging: the owner is live and idle, the ask's result is in the transcript, and
    // the model was asked twice — the `bash` turn and the ask — with no request after the ask.
    expect(asked.snapshot.session.mode).toBe("live");
    expect(asked.snapshot.live.busy).toBe(false);
    expect(asked.snapshot.session.status).toBe("idle");
    expect(
      asked.snapshot.entries.some(
        (entry) => entry.kind === "toolResult" && entry.toolName === "ask",
      ),
    ).toBe(true);
    expect(
      asked.snapshot.entries.filter((entry) => entry.kind === "assistant"),
    ).toHaveLength(2);
    expect(asked.requests).toBe(2);
    // The block is typed and names the column the card blocked from (B4).
    expect(asked.blocked.blocked?.reason).toBe("needs_input");
    expect(asked.blocked.blocked?.column).toBe("specifying");
    expect(asked.blocked.column).toBe("specifying");
    // The question is on the task, verbatim, written by the run.
    expect(asked.thread).toEqual([
      expect.objectContaining({
        kind: "question",
        actor: asked.runId,
        body: QUESTION,
      }),
    ]);
    // The asking run opened with no comments on the card, so its prompt had no thread.
    expect(asked.prompt["task_thread"]).toBeUndefined();

    // --- the restart: a new service over the same database ---------------------------------------
    const second = createFauxModelAccess({ fauxAsk: QUESTION });
    const after = askRuntime(second);
    const answered = await after
      .runPromise(
        Effect.gen(function* () {
          const sessions = yield* SessionService;
          const tasks = yield* TaskService;
          const reread = yield* tasks.get(asked.card.id);
          const rereadThread = yield* tasks.comments(asked.card.id);
          const unblocked = yield* tasks.comment({
            taskId: asked.card.id,
            expectedRevision: reread.revision,
            body: ANSWER,
            actor: PERSON,
          });
          const next = yield* sessions.create({
            title: reread.title,
            taskId: reread.id,
            taskColumn: reread.column,
          });
          yield* sessions.send({ sessionId: next.id, content: "go on" });
          yield* waitUntil(
            Effect.map(
              sessions.get(next.id),
              (snapshot) =>
                !snapshot.live.busy &&
                snapshot.entries.some(
                  (entry) => entry.kind === "assistant" && entry.text !== "",
                ),
            ),
            "the next run to answer",
          );
          return {
            reread,
            rereadThread,
            unblocked,
            nextId: next.id,
            card: yield* tasks.get(asked.card.id),
            thread: yield* tasks.comments(asked.card.id),
            prompt: yield* promptOf(next.id),
          };
        }),
      )
      .finally(() => after.dispose());

    // Neither the block nor the question was lost to the restart.
    expect(answered.reread.blocked).toEqual(asked.blocked.blocked);
    expect(answered.rereadThread).toEqual(asked.thread);
    // A person's comment on a `needs_input` card is the answer, and lifts the block.
    expect(answered.unblocked.blocked).toBeUndefined();
    expect(answered.thread.map((comment) => comment.kind)).toEqual([
      "question",
      "answer",
    ]);
    expect(answered.thread[1]?.body).toBe(ANSWER);
    // The next run was told the thread: the answer verbatim, after the question it answers.
    const told = answered.prompt["task_thread"] ?? "";
    expect(told).toContain(`\n${ANSWER}\n`);
    expect(told.indexOf(QUESTION)).toBeGreaterThan(-1);
    expect(told.indexOf(QUESTION)).toBeLessThan(told.indexOf(ANSWER));
    // And, holding the answer, it did not ask again: the card stays unblocked.
    expect(answered.card.blocked).toBeUndefined();
    expect(answered.thread).toHaveLength(2);
  }, 120_000);

  it("tells a parked run's live owner the answer when a person messages that same session", async () => {
    const faux = createFauxModelAccess({ fauxAsk: QUESTION });
    const live = askRuntime(faux);
    const outcome = await live
      .runPromise(
        Effect.gen(function* () {
          const sessions = yield* SessionService;
          const tasks = yield* TaskService;
          const card = yield* cardInSpecifying;
          const run = yield* sessions.create({
            title: card.title,
            taskId: card.id,
            taskColumn: card.column,
          });
          yield* sessions.send({ sessionId: run.id, content: "specify it" });
          yield* waitUntil(
            Effect.map(
              sessions.get(run.id),
              (snapshot) =>
                !snapshot.live.busy &&
                snapshot.entries.some(
                  (entry) =>
                    entry.kind === "toolResult" && entry.toolName === "ask",
                ),
            ),
            "the run to ask and settle",
          );
          const parked = yield* promptOf(run.id);
          const blocked = yield* tasks.get(card.id);
          yield* tasks.comment({
            taskId: card.id,
            expectedRevision: blocked.revision,
            body: ANSWER,
            actor: PERSON,
          });
          // The same session, its owner still live in this process: no `board start`, no reopen.
          yield* sessions.send({ sessionId: run.id, content: "go on" });
          yield* waitUntil(
            Effect.map(
              sessions.get(run.id),
              (snapshot) =>
                !snapshot.live.busy &&
                snapshot.entries.at(-1)?.kind === "assistant" &&
                snapshot.entries.at(-1)?.text !== "",
            ),
            "the answered run to reply",
          );
          return {
            mode: (yield* sessions.get(run.id)).session.mode,
            parked,
            told: yield* promptOf(run.id),
            card: yield* tasks.get(card.id),
          };
        }),
      )
      .finally(() => live.dispose());

    expect(outcome.mode).toBe("live");
    expect(outcome.parked["task_thread"]).toBeUndefined();
    const told = outcome.told["task_thread"] ?? "";
    expect(told).toContain(`\n${ANSWER}\n`);
    expect(told.indexOf(QUESTION)).toBeLessThan(told.indexOf(ANSWER));
    // Told the answer, the run did not ask again: the card stays unblocked.
    expect(outcome.card.blocked).toBeUndefined();
  }, 120_000);

  it("offers a session with no card no ask tool", async () => {
    const faux = createFauxModelAccess({ fauxAsk: QUESTION });
    const scratch = askRuntime(faux);
    const snapshot = await scratch
      .runPromise(
        Effect.gen(function* () {
          const sessions = yield* SessionService;
          const created = yield* sessions.create({ title: "no card" });
          yield* sessions.send({ sessionId: created.id, content: "hello" });
          yield* waitUntil(
            Effect.map(
              sessions.get(created.id),
              (current) =>
                !current.live.busy &&
                current.entries.some(
                  (entry) => entry.kind === "assistant" && entry.text !== "",
                ),
            ),
            "the scratch run to answer",
          );
          return yield* sessions.get(created.id);
        }),
      )
      .finally(() => scratch.dispose());

    // A scratch session has nobody to ask on, so the script — which would ask if it could — replies.
    expect(
      snapshot.entries.some(
        (entry) => entry.kind === "toolResult" && entry.toolName === "ask",
      ),
    ).toBe(false);
    expect(snapshot.entries.at(-1)?.text).toBe("faux-ok (re: hello)");
  }, 120_000);
});

/**
 * The PR states what was verified (LOB-79, part 2 of LOB-16), from the run's recorded `verify`
 * results and nothing the model wrote.
 *
 * Each case is a whole run through the real service: a fixture repo with a verify skill, a faux model
 * whose `bash` turn commits a change and whose next turn calls `verify`, then the PR step against the
 * in-process GitHub fake (`makeGithubFake`, the GitHub row of `docs/testing-third-parties.md`). The
 * body asserted is the one GitHub was *sent*; the evidence asserted beside it is the one the log
 * committed, read back by a reader that owns nothing.
 */
describe("the PR's evidence", () => {
  const evidenceRoot = mkdtempSync(join(tmpdir(), "factory-core-evidence-"));

  /** A repo whose `verify-api` skill is `drive`, committed on `main`. */
  const fixture = (name: string, drive: string): string => {
    const root = mkdtempSync(join(tmpdir(), `factory-repo-evidence-${name}-`));
    const git = (command: string) =>
      execSync(command, { cwd: root, stdio: "ignore" });
    git("git init -b main");
    git("git config user.email t@t.com");
    git("git config user.name t");
    mkdirSync(join(root, ".pi", "skills", "verify-api"), { recursive: true });
    writeFileSync(join(root, ".pi", "skills", "verify-api", "drive.sh"), drive);
    git("git add -A");
    git("git commit -m base");
    return root;
  };

  /** One run that changes `apps/api` and calls `verify`, then the PR step; the sent body and the log. */
  const verifiedPr = async (
    name: string,
    drive: string,
    number: number,
    /** Run in the session's worktree after the run verified and before the PR opens. */
    afterVerify?: string,
  ) => {
    const repoPath = fixture(name, drive);
    const repo = RepoSlugSchema.make(`lobiklukas/evidence-${name}`);
    const url = `https://github.com/lobiklukas/evidence-${name}/pull/${number}`;
    const github = makeGithubFake(201, { number, url });
    const faux = createFauxModelAccess({
      fauxVerify: true,
      fauxCommand:
        "mkdir -p apps/api && echo 'export const feature = 1;' > apps/api/feature.ts && " +
        "git add -A && git -c user.email=t@t.com -c user.name=t commit -q -m feature && echo committed",
    });
    const evidenceRuntime = ManagedRuntime.make(
      SessionServiceLive({
        model: faux.access,
        sessionRoot: evidenceRoot,
      }).pipe(Layer.provideMerge(DatabaseLayer)),
    );
    try {
      return await evidenceRuntime.runPromise(
        Effect.gen(function* () {
          const sessions = yield* SessionService;
          yield* sessions.registerRepo({
            repo,
            url: `https://github.com/lobiklukas/evidence-${name}.git`,
            localPath: repoPath,
          });
          const created = yield* sessions.create({ repo, baseRef: "main" });
          yield* sessions.send({
            sessionId: created.id,
            content: "make the change and verify it",
          });
          yield* waitUntil(
            Effect.map(
              sessions.get(created.id),
              (snapshot) =>
                snapshot.session.status === "idle" &&
                snapshot.entries.some(
                  (entry) => entry.kind === "assistant" && entry.text !== "",
                ),
            ),
            `the ${name} run to verify and answer`,
          );
          if (afterVerify !== undefined) {
            const { workspace } = yield* sessions.get(created.id);
            execSync(afterVerify, { cwd: workspace.path, stdio: "ignore" });
          }
          const answer = yield* sessions
            .openPullRequest({
              sessionId: created.id,
              title: `factory: ${name}`,
              head: `factory/${created.id}`,
              base: "main",
            })
            .pipe(Effect.provide(github.layer));
          const sql = yield* SqlClient;
          const { records, log } = yield* Effect.acquireUseRelease(
            Effect.promise(() => PostgresStorage.reader(sql, created.id)),
            (storage) =>
              Effect.all({
                records: readVerifyRecords(storage),
                log: readSessionLog(storage),
              }),
            (storage) => Effect.promise(() => storage.dispose()),
          );
          const sent = github.requests[0]?.body as
            | { readonly body: string }
            | undefined;
          return {
            answer,
            requests: github.requests.length,
            body: sent?.body ?? "",
            records,
            evidence: log.pr?.evidence,
          };
        }),
      );
    } finally {
      await evidenceRuntime.dispose();
    }
  };

  it("carries the skill name, the exit code and the output of the run's verify call", async () => {
    const result = await verifiedPr(
      "pass",
      'echo "verify-api fixture: 3/3 checks passed"\n',
      41,
    );

    expect(result.answer.outcome).toBe("opened");
    expect(result.requests).toBe(1);
    expect(result.body).toContain("## Verification");
    expect(result.body).toContain("### `verify-api`: exit 0");
    expect(result.body).toContain("- Surface: `api`");
    expect(result.body).toContain("- Exit code: 0");
    expect(result.body).toContain(
      "```text\nverify-api fixture: 3/3 checks passed\n```",
    );
    // The body's evidence is the log's: the committed document holds the value it was rendered from.
    expect(result.evidence).toEqual({
      _tag: "EvidenceRecorded",
      calls: 1,
      changedCount: 1,
      results: [
        {
          _tag: "VerificationRan",
          surface: "api",
          name: "verify-api",
          source: "skill",
          command: "bash drive.sh",
          exitCode: 0,
          excerpt: "verify-api fixture: 3/3 checks passed\n",
          truncated: false,
        },
      ],
      // The call measured the one path the PR publishes.
      coverage: { published: 1, covered: 1, missed: [] },
    });
    expect(result.body).not.toContain("**Stale.**");
  }, 120_000);

  it("says the verdict predates a change committed after the verify call", async () => {
    const result = await verifiedPr(
      "stale",
      'echo "verify-api fixture: 3/3 checks passed"\n',
      44,
      "mkdir -p apps/api && echo 'export const later = 2;' > apps/api/later.ts && " +
        "git add -A && git -c user.email=t@t.com -c user.name=t commit -q -m later",
    );

    expect(result.answer.outcome).toBe("opened");
    expect(result.body).toContain("### `verify-api`: exit 0");
    expect(result.body).toContain(
      "**Stale.** The cited call measured 1 of the 2 path(s) this PR changes; the run changed the rest after it verified, so the verdict below predates them: `apps/api/later.ts`.",
    );
    expect(result.evidence).toMatchObject({
      _tag: "EvidenceRecorded",
      coverage: { published: 2, covered: 1, missed: ["apps/api/later.ts"] },
    });
  }, 120_000);

  it("cuts a failing skill's long output to a bounded tail, visibly", async () => {
    const result = await verifiedPr(
      "fail",
      'for i in $(seq 1 400); do echo "check $i"; done\necho "FAIL: 1 required check failed"\nexit 3\n',
      42,
    );

    expect(result.body).toContain("### `verify-api`: exit 3 (failed)");
    expect(result.body).toContain(
      `Output (truncated: earlier output omitted, the last ${PR_EVIDENCE_EXCERPT.maxLines} line(s) shown):`,
    );
    expect(result.body).toContain("FAIL: 1 required check failed");
    expect(result.body).not.toContain("check 1\n");
    // Deterministic: the excerpt is exactly the PR bound's tail of the output the log recorded.
    const [record] = result.records;
    const recorded =
      record?._tag === "VerifyReport" ? record.results[0] : undefined;
    const output = recorded?._tag === "VerifyRan" ? recorded.output : "";
    expect(output).toContain("check 300\n");
    const excerpt = tailOf(output, PR_EVIDENCE_EXCERPT).output;
    expect(excerpt.split("\n").filter((line) => line !== "")).toHaveLength(
      PR_EVIDENCE_EXCERPT.maxLines,
    );
    expect(result.body).toContain(`\`\`\`text\n${excerpt}\`\`\``);
    expect(result.evidence).toMatchObject({
      _tag: "EvidenceRecorded",
      results: [{ exitCode: 3, excerpt, truncated: true }],
    });
  }, 120_000);

  it("says the run has no evidence when it never called verify", async () => {
    const url = "https://github.com/lobiklukas/factory/pull/43";
    const github = makeGithubFake(201, { number: 43, url });
    const result = await program(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        // A diff committed by hand: a PR exists to open, and no run ever verified it.
        const { created } = yield* sessionWithDiff("an unverified change");
        const answer = yield* sessions
          .openPullRequest({
            sessionId: created.id,
            title: "factory: an unverified change",
            head: `factory/${created.id}`,
            base: "main",
          })
          .pipe(Effect.provide(github.layer));
        const sql = yield* SqlClient;
        const log = yield* Effect.acquireUseRelease(
          Effect.promise(() => PostgresStorage.reader(sql, created.id)),
          (storage) => readSessionLog(storage),
          (storage) => Effect.promise(() => storage.dispose()),
        );
        return { answer, log };
      }),
    );

    expect(opened(result.answer).url).toBe(url);
    const sent = github.requests[0]?.body as { readonly body: string };
    expect(sent.body).toContain("## Verification");
    expect(sent.body).toContain(
      "**No verification evidence.** Nothing in this PR was verified by a recorded run: " +
        "the run never called the `verify` tool.",
    );
    expect(result.log.pr?.evidence).toEqual({
      _tag: "EvidenceNone",
      reason: "not-verified",
      message: "the run never called the `verify` tool",
    });
  }, 120_000);
});

/**
 * The budget cap through the service (LOB-163, part 3 of LOB-17).
 *
 * The harness suite (`packages/harness/src/budget.test.ts`) proves the stop itself on one harness;
 * these cases prove what the service adds: `create` commits the cap a request names, or the server's
 * default when it names none, before any message can start a run; the stop reaches the session's
 * snapshot, its activity row and its process log; and a second process over the same database
 * folds the same cap and stop — the cap is the log's, not an owner's memory. The faux model is priced
 * (`fauxCost`) so a cap can be reached at all, and its call count is the witness that the stopped
 * request was never sent.
 */
describe("the budget cap", () => {
  const budgetRoot = mkdtempSync(join(tmpdir(), "factory-core-budget-"));
  const COST = 0.01;

  const budgetRuntime = (
    faux: ReturnType<typeof createFauxModelAccess>,
    defaultBudget?: number,
  ) =>
    ManagedRuntime.make(
      SessionServiceLive({
        model: faux.access,
        sessionRoot: budgetRoot,
        ...(defaultBudget === undefined ? {} : { defaultBudget }),
      }).pipe(Layer.provideMerge(DatabaseLayer)),
    );

  const settled = (sessions: SessionServiceShape, id: SessionId) =>
    waitUntil(
      Effect.map(
        sessions.get(id),
        (snapshot) =>
          snapshot.session.status === "idle" &&
          snapshot.entries.some(
            (entry) =>
              entry.kind === "budget" ||
              (entry.kind === "assistant" && entry.text !== ""),
          ),
      ),
      "the run to settle",
    );

  it("stops a capped run, reports it, and a second process folds the same stop", async () => {
    const faux = createFauxModelAccess({ fauxCost: COST });
    const first = budgetRuntime(faux);
    let sessionId: SessionId | undefined;
    try {
      const result = await first.runPromise(
        Effect.gen(function* () {
          const sessions = yield* SessionService;
          const created = yield* sessions.create({ budget: COST });
          sessionId = created.id;
          // The cap is there before any run: a fresh session reports it, unspent.
          const fresh = yield* sessions.get(created.id);
          yield* sessions.send({ sessionId: created.id, content: "go" });
          yield* settled(sessions, created.id);
          const snapshot = yield* sessions.get(created.id);
          const sql = yield* SqlClient;
          const activity = yield* sql<{ costTotal: number }>`
            SELECT cost_total::float8 AS "costTotal" FROM session_activity
            WHERE session_id = ${created.id}
          `;
          return { fresh, snapshot, activity };
        }),
      );

      expect(result.fresh.budget).toEqual({ cap: COST, spent: 0 });
      // One request was sent and paid for; the reply's was not.
      expect(faux.faux.state.callCount).toBe(1);
      const kinds = result.snapshot.entries
        .map((entry) => entry.kind)
        .filter((kind) => kind !== "system" && kind !== "title");
      expect(kinds).toEqual(["user", "assistant", "toolResult", "budget"]);
      expect(result.snapshot.budget?.stopped?.cap).toBe(COST);
      expect(result.snapshot.budget?.spent).toBeCloseTo(COST, 10);
      // The list's cost is the same spend the cap was measured against.
      expect(result.activity[0]?.costTotal).toBeCloseTo(COST, 10);
    } finally {
      await first.dispose();
    }

    // A second process: no owner, so the read is a fold of the log.
    const second = budgetRuntime(createFauxModelAccess({ fauxCost: COST }));
    try {
      const folded = await second.runPromise(
        Effect.gen(function* () {
          const sessions = yield* SessionService;
          if (sessionId === undefined) return yield* Effect.die("no session");
          return yield* sessions.get(sessionId);
        }),
      );
      expect(folded.session.mode).toBe("historical");
      expect(folded.budget?.cap).toBe(COST);
      expect(folded.budget?.stopped?.spent).toBeCloseTo(COST, 10);
      expect(
        folded.entries.filter((entry) => entry.kind === "budget"),
      ).toHaveLength(1);
    } finally {
      await second.dispose();
    }
  }, 120_000);

  it("caps a session at the server's default when its create names none", async () => {
    const faux = createFauxModelAccess({ fauxCost: COST });
    const runtime = budgetRuntime(faux, COST);
    try {
      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const sessions = yield* SessionService;
          const defaulted = yield* sessions.create({});
          const named = yield* sessions.create({ budget: 5 * COST });
          yield* sessions.send({ sessionId: defaulted.id, content: "go" });
          yield* settled(sessions, defaulted.id);
          return {
            defaulted: yield* sessions.get(defaulted.id),
            named: yield* sessions.get(named.id),
          };
        }),
      );
      expect(result.defaulted.budget?.cap).toBe(COST);
      expect(result.defaulted.budget?.stopped).toBeDefined();
      // A create that names its own cap keeps it: the default is only for one that names none.
      expect(result.named.budget).toEqual({ cap: 5 * COST, spent: 0 });
    } finally {
      await runtime.dispose();
    }
  }, 120_000);

  it("holds a fork of a stopped session to its parent's cap and spend", async () => {
    const faux = createFauxModelAccess({ fauxCost: COST });
    const runtime = budgetRuntime(faux, 100 * COST);
    try {
      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const sessions = yield* SessionService;
          const parent = yield* sessions.create({ budget: COST });
          yield* sessions.send({ sessionId: parent.id, content: "go" });
          yield* settled(sessions, parent.id);
          const sentByParent = faux.faux.state.callCount;
          // A fork of the session the cap stopped: the operator's "keep going" must not spend.
          const fork = yield* sessions.fork({ sessionId: parent.id });
          const forked = yield* sessions.get(fork.id);
          yield* sessions.send({ sessionId: fork.id, content: "keep going" });
          yield* waitUntil(
            Effect.map(
              sessions.get(fork.id),
              (snapshot) =>
                snapshot.session.status === "idle" &&
                snapshot.budget?.stopped !== undefined,
            ),
            "the fork's run to be stopped",
          );
          const after = yield* sessions.get(fork.id);
          return {
            sentByParent,
            sentByFork: faux.faux.state.callCount - sentByParent,
            forked,
            after,
          };
        }),
      );
      expect(result.sentByParent).toBe(1);
      // The parent's cap, not the default, and the parent's spend carried: already reached.
      expect(result.forked.budget?.cap).toBe(COST);
      expect(result.forked.budget?.spent).toBeCloseTo(COST, 10);
      expect(result.sentByFork).toBe(0);
      expect(result.after.budget?.stopped?.spent).toBeCloseTo(COST, 10);
    } finally {
      await runtime.dispose();
    }
  }, 120_000);

  it("gives a fork of an uncapped session the server's default", async () => {
    // The parent is created by a server with no default, the fork by one with: the default is what a
    // session that names no cap gets, and a fork of an uncapped parent names none.
    const before = budgetRuntime(createFauxModelAccess({ fauxCost: COST }));
    let parentId: SessionId | undefined;
    try {
      parentId = await before.runPromise(
        Effect.gen(function* () {
          const sessions = yield* SessionService;
          return (yield* sessions.create({})).id;
        }),
      );
    } finally {
      await before.dispose();
    }
    const after = budgetRuntime(
      createFauxModelAccess({ fauxCost: COST }),
      3 * COST,
    );
    try {
      const result = await after.runPromise(
        Effect.gen(function* () {
          const sessions = yield* SessionService;
          if (parentId === undefined) return yield* Effect.die("no session");
          const fork = yield* sessions.fork({ sessionId: parentId });
          return {
            parent: yield* sessions.get(parentId),
            fork: yield* sessions.get(fork.id),
          };
        }),
      );
      expect(result.parent.budget).toBeUndefined();
      expect(result.fork.budget).toEqual({ cap: 3 * COST, spent: 0 });
    } finally {
      await after.dispose();
    }
  }, 120_000);

  it("leaves a session created without a cap uncapped, and its run answered", async () => {
    const faux = createFauxModelAccess({ fauxCost: COST });
    const runtime = budgetRuntime(faux);
    try {
      const snapshot = await runtime.runPromise(
        Effect.gen(function* () {
          const sessions = yield* SessionService;
          const created = yield* sessions.create({});
          yield* sessions.send({ sessionId: created.id, content: "go" });
          yield* settled(sessions, created.id);
          return yield* sessions.get(created.id);
        }),
      );
      expect(snapshot.budget).toBeUndefined();
      expect(faux.faux.state.callCount).toBe(2);
      expect(snapshot.entries.some((entry) => entry.kind === "budget")).toBe(
        false,
      );
    } finally {
      await runtime.dispose();
    }
  }, 120_000);
});

/**
 * Spend keyed by repo and actor (LOB-162, part 2 of LOB-17).
 *
 * `spend` is the list's own `cost_total` grouped by the session's repo and actor, so the oracle here
 * is the activity index read per session and added up by the test, against groups the test knows
 * from what it created: two actors on one repo, one actor on two repos, a session nobody was
 * attributed, a fork and a replay that take their source's actor, and a session a trigger started.
 * The faux model is priced (`fauxCost`) so a group's cost is a number a mistake would change. The
 * repos are this run's own, so the suite's other sessions are never in the groups asserted.
 *
 * Then the index forgets every actor and `rebuildIndexes` has to recover them from the log's
 * `factory.actor` documents: a fold that dropped them would move all of this spend to
 * "unattributed".
 */
describe("spend by repo and actor", () => {
  const spendRoot = mkdtempSync(join(tmpdir(), "factory-core-spend-"));
  const COST = 0.01;
  const tag = randomBytes(4).toString("hex");
  const web = RepoSlugSchema.make(`spend-${tag}/web`);
  const api = RepoSlugSchema.make(`spend-${tag}/api`);

  it("groups the list's cost by repo and actor, inherits the actor on a fork and a replay, and a rebuild recovers it", async () => {
    const faux = createFauxModelAccess({ fauxCost: COST });
    const spendRuntime = ManagedRuntime.make(
      TriggerSessionsFromSessionService.pipe(
        Layer.provideMerge(
          SessionServiceLive({
            model: faux.access,
            sessionRoot: spendRoot,
          }),
        ),
        Layer.provideMerge(DatabaseLayer),
      ),
    );
    try {
      const result = await spendRuntime.runPromise(
        Effect.gen(function* () {
          const sessions = yield* SessionService;
          const triggers = yield* TriggerSessions;
          const sql = yield* SqlClient;

          // Settled means answered *and* indexed: the reply is in the transcript, and the activity
          // row holds the spend the log does, so the oracle below reads the run's whole cost.
          const ran = (id: SessionId) =>
            waitUntil(
              Effect.gen(function* () {
                const snapshot = yield* sessions.get(id);
                const indexed = yield* sql<{ costTotal: number }>`
                  SELECT cost_total::float8 AS cost_total
                  FROM session_activity WHERE session_id = ${id}
                `;
                return (
                  !snapshot.live.busy &&
                  snapshot.entries.some(
                    (entry) => entry.kind === "assistant" && entry.text !== "",
                  ) &&
                  indexed[0]?.costTotal === usageCostTotal(snapshot.usage)
                );
              }),
              `session ${id} to run`,
            );
          const start = (input: {
            readonly repo: RepoSlug;
            readonly actor?: string;
          }) =>
            Effect.gen(function* () {
              const created = yield* sessions.create(input);
              yield* sessions.send({ sessionId: created.id, content: "go" });
              yield* ran(created.id);
              return created.id;
            });

          const amyWeb1 = yield* start({ repo: web, actor: "amy" });
          const amyWeb2 = yield* start({ repo: web, actor: "amy" });
          const amyApi = yield* start({ repo: api, actor: "amy" });
          const bobWeb = yield* start({ repo: web, actor: "bob" });
          // Nobody named: the pane's "unattributed", and it never ran, so it costs nothing.
          const nobody = (yield* sessions.create({ repo: web })).id;
          // A fork continues its parent's work; its own spend starts at nothing.
          const fork = (yield* sessions.fork({ sessionId: bobWeb })).id;
          // A replay runs its source's task again, and pays for that run.
          const replay = (yield* sessions.replay({ sessionId: amyApi })).id;
          yield* ran(replay);
          // A trigger's session, through the production port.
          const triggered = (yield* triggers
            .create({
              source: "linear",
              title: "a trigger's run",
              requestId: `trigger:spend-${tag}`,
              deliveryId: `spend-${tag}`,
              repo: api,
              baseRef: undefined,
            })
            .pipe(Effect.orDie)).id;
          yield* triggers
            .send({
              sessionId: triggered,
              content: "go",
              requestId: `trigger:spend-${tag}`,
            })
            .pipe(Effect.orDie);
          yield* ran(triggered);

          const groups: ReadonlyArray<{
            readonly repo: RepoSlug;
            readonly actor: string | undefined;
            readonly ids: ReadonlyArray<SessionId>;
          }> = [
            { repo: web, actor: "amy", ids: [amyWeb1, amyWeb2] },
            { repo: api, actor: "amy", ids: [amyApi, replay] },
            { repo: web, actor: "bob", ids: [bobWeb, fork] },
            { repo: web, actor: undefined, ids: [nobody] },
            { repo: api, actor: "trigger:linear", ids: [triggered] },
          ];
          const allIds = groups.flatMap((group) => group.ids);
          const costs = yield* sql<{ sessionId: string; costTotal: number }>`
            SELECT session_id, cost_total::float8 AS cost_total
            FROM session_activity WHERE session_id IN ${sql.in(allIds)}
          `;
          const costOf = (id: SessionId) =>
            costs.find((row) => row.sessionId === id)?.costTotal ?? NaN;
          const expected = groups.map((group) => ({
            repo: group.repo,
            actor: group.actor,
            sessions: group.ids.length,
            costTotal: group.ids.reduce((total, id) => total + costOf(id), 0),
          }));

          const ours = (report: SpendReport) =>
            report.rows.filter((row) => row.repo === web || row.repo === api);
          const before = yield* sessions.spend;

          // Forget every actor this case wrote, as a dropped index would, and refold.
          yield* sql`UPDATE sessions SET actor = NULL WHERE id IN ${sql.in(allIds)}`;
          const forgotten = yield* sessions.spend;
          yield* rebuildIndexes;
          const rebuilt = yield* sessions.spend;

          return {
            expected,
            before: ours(before),
            beforeReport: before,
            forgotten: ours(forgotten),
            rebuilt: ours(rebuilt),
            forkCost: costOf(fork),
            parentCost: costOf(bobWeb),
          };
        }),
      );

      const key = (row: {
        readonly repo?: string | undefined;
        readonly actor?: string | undefined;
      }) => `${row.repo ?? ""}|${row.actor ?? ""}`;
      const asMap = (
        rows: ReadonlyArray<{
          readonly repo?: string | undefined;
          readonly actor?: string | undefined;
          readonly sessions: number;
          readonly costTotal: number;
        }>,
      ) =>
        new Map(
          rows.map((row) => [
            key(row),
            { sessions: row.sessions, costTotal: row.costTotal },
          ]),
        );

      // Every run spent something, so a group's cost distinguishes it from its neighbours.
      for (const group of result.expected) {
        if (group.actor !== undefined)
          expect(group.costTotal).toBeGreaterThan(0);
      }
      expect(result.parentCost).toBeGreaterThan(0);
      // The fork's cost is its own (none yet), not its parent's again: the pair is not counted twice.
      expect(result.forkCost).toBe(0);

      // The pairs, exactly: no extra row, no missing one, each the list's numbers added up.
      expect(result.before).toHaveLength(result.expected.length);
      const before = asMap(result.before);
      for (const group of result.expected) {
        const row = before.get(key(group));
        expect(row?.sessions).toBe(group.sessions);
        expect(row?.costTotal).toBeCloseTo(group.costTotal, 10);
      }
      // The absent actor is absent on the wire, not an empty string.
      expect(
        result.before.find(
          (row) => row.repo === web && row.actor === undefined,
        ),
      ).not.toHaveProperty("actor");

      // Costliest first: the order is the report's contract.
      const costs = result.beforeReport.rows.map((row) => row.costTotal);
      expect(costs).toEqual([...costs].sort((left, right) => right - left));
      // The totals are the rows added.
      expect(result.beforeReport.sessions).toBe(
        result.beforeReport.rows.reduce(
          (total, row) => total + row.sessions,
          0,
        ),
      );
      expect(result.beforeReport.costTotal).toBeCloseTo(
        result.beforeReport.rows.reduce(
          (total, row) => total + row.costTotal,
          0,
        ),
        10,
      );

      // With the index's actors gone, every session of ours is unattributed — the witness that the
      // rebuild below had something to recover.
      expect(result.forgotten.every((row) => row.actor === undefined)).toBe(
        true,
      );
      // The log kept them: the rebuilt report is the one before.
      const rebuilt = asMap(result.rebuilt);
      expect(result.rebuilt).toHaveLength(result.expected.length);
      for (const group of result.expected) {
        const row = rebuilt.get(key(group));
        expect(row?.sessions).toBe(group.sessions);
        expect(row?.costTotal).toBeCloseTo(group.costTotal, 10);
      }
    } finally {
      await spendRuntime.dispose();
    }
  }, 180_000);

  it("refuses a corrupt actor in the index rather than moving its spend to unattributed", async () => {
    const exit = await program(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const sql = yield* SqlClient;
        const created = yield* sessions.create({
          repo: RepoSlugSchema.make(`spend-${tag}/corrupt`),
          actor: "amy",
        });
        yield* sql`UPDATE sessions SET actor = ${"  "} WHERE id = ${created.id}`;
        const answer = yield* Effect.exit(sessions.spend);
        // Put it back, so the suite's later reads of the whole index are not this case's problem.
        yield* sql`UPDATE sessions SET actor = ${"amy"} WHERE id = ${created.id}`;
        return answer;
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    const failure = Exit.findErrorOption(exit);
    expect(failure._tag === "Some" ? failure.value.code : "none").toBe(
      "storage",
    );
  }, 60_000);
});

/**
 * The trigger seam's production session port (LOB-218): its `send` carries the delivery's key to
 * Pi Durable's submission dedupe, so a delivery the seam retries after a failed write-back leaves
 * one user message. `TriggerService.test.ts` proves the seam passes the key; this proves the port
 * does not drop it on the way to the real session.
 */
describe("the trigger port's send", () => {
  it("admits one message per delivery, however many times the seam sends it", async () => {
    const requestId = sessionRequestIdOf(
      `lob-218-${randomBytes(4).toString("hex")}`,
    );
    const outcome = await program(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const port = yield* TriggerSessions;
        const created = yield* sessions.create({ title: "triggered" });
        const prompt = {
          sessionId: created.id,
          content: "fix the widget",
          requestId,
        };
        yield* port.send(prompt);
        yield* waitUntil(
          sessions
            .get(created.id)
            .pipe(Effect.map((snapshot) => !snapshot.live.busy)),
          "the trigger's turn to settle",
        );
        // The retry: same delivery, same key, after the first send's run has finished.
        yield* port.send(prompt);
        // A different delivery to the same session is a different message.
        yield* port.send({
          ...prompt,
          content: "and the gadget",
          requestId: `${requestId}-other`,
        });
        // Idle with an empty inbox: a message sent while a run is busy waits there as a follow-up,
        // not in the transcript, so a read before that would undercount a duplicate.
        yield* waitUntil(
          sessions
            .get(created.id)
            .pipe(
              Effect.map(
                (snapshot) =>
                  !snapshot.live.busy && snapshot.queued.length === 0,
              ),
            ),
          "the second turn to settle",
        );
        return yield* sessions.get(created.id);
      }).pipe(Effect.provide(TriggerSessionsFromSessionService)),
    );
    expect(
      outcome.entries
        .filter((entry) => entry.kind === "user")
        .map((entry) => entry.text),
    ).toEqual(["fix the widget", "and the gadget"]);
  }, 60_000);
});
