/**
 * The session service, driven through its own interface against a real Postgres log.
 *
 * What this proves that the harness test cannot: a session created and driven here is readable
 * *the same way* after its owner is released, which is D8's live/historical pair — the live view
 * and the fold have to agree, or the dashboard shows two different sessions depending on whether
 * a sandbox happens to be running.
 *
 * Deterministic and offline (faux model), but it needs Postgres: `docker compose up -d --wait
 * postgres`. It creates a database of its own for the run and drops it at the end, so it never
 * writes a row of any table in whatever `DATABASE_URL` points at. It does write two things there
 * that are not rows: it adds and removes its own database in the shared `pg_database` catalogue,
 * and it reads that database five times over the run. Every statement it issues against the
 * configured database is one of five, and `describe("this suite's database")` at the end of this
 * file names all of them.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { BunServices } from "@effect/platform-bun";
import { PgClient } from "@effect/sql-pg";
import type {
  ListSessionsInput,
  ListSessionsOutput,
  SessionError,
  SessionEvent,
  SessionId,
  SessionListEntry,
} from "@repo/domain/Session";
import { RepoSlug as RepoSlugSchema } from "@repo/domain/Session";
import { DatabaseConfig, DatabaseLive } from "@repo/storage-postgres";
import {
  ConfigProvider,
  Effect,
  Exit,
  Fiber,
  Layer,
  ManagedRuntime,
  Redacted,
  Ref,
  Stream,
} from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";
import { afterAll, describe, expect, it } from "vitest";
import { createModelAccess } from "@repo/harness";
import { rebuildIndexes } from "./rebuild";
import {
  MAX_MESSAGE_CHARS,
  MAX_PAGE_SIZE,
  SessionService,
  SessionServiceLive,
} from "./SessionService";

const sessionRoot = mkdtempSync(join(tmpdir(), "factory-core-"));

/** A checkout the registry can point at, so a repo's own config is readable. */
const repoRoot = mkdtempSync(join(tmpdir(), "factory-repo-"));
mkdirSync(join(repoRoot, ".factory"), { recursive: true });
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

const DatabaseLayer = Layer.mergeAll(DatabaseLive, BunServices.layer);

/**
 * The URL `DATABASE_URL` resolves to, and the one the suite actually runs against (LOB-96).
 *
 * Every statement this file issues goes through one pool, and one case of it empties the `sessions`
 * index entirely, so the blast radius of a run is whatever database that pool opened. Sharing one
 * with everything else on the machine made that radius every session anyone else had, and the fold
 * that follows costs the whole shared log rather than the one session the case asserts on — which
 * is why that case carried a budget that expired as the shared database grew (LOB-113).
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
 * The database `DATABASE_URL` names, read from its URL path.
 *
 * `postgres` when the URL names none — not for legality (an empty path would not do) but because
 * `describe("this suite's database")` compares the configured database's own name against
 * `current_database()`, and an empty string there is a silent no-op rather than a failing one.
 */
const configuredDatabase =
  new URL(configuredUrl).pathname.replace(/^\//, "") || "postgres";

/**
 * A database name for this run: the configured one, a marker, and six random characters, so two
 * runs of this suite against one server cannot collide (measured: two concurrent runs of this file,
 * and two concurrent gates, both clean).
 *
 * Every identifier this file issues is quoted — `sql(name)` escapes it — so Postgres does not fold
 * the name to lower case and does not need it folded. What *is* real is the 63-byte limit, which
 * applies to a quoted identifier too: it truncates silently, and a truncated tail would collide.
 * So the base is cut to `63 - tail.length` characters and the replacement below keeps characters
 * and bytes the same length, which is what makes that cut exact for a name that was not plain ASCII
 * to begin with.
 */
const runDatabaseName = (() => {
  const tail = `_core_${randomBytes(3).toString("hex")}`;
  const base = configuredDatabase
    .replaceAll(/[^a-z0-9_]/g, "_")
    .slice(0, 63 - tail.length);
  return `${base}${tail}`;
})();

/** The same URL with a different database on it, and every other parameter left alone. */
const runDatabaseUrl = (() => {
  const url = new URL(configuredUrl);
  url.pathname = `/${runDatabaseName}`;
  return url.toString();
})();

/**
 * The only connection to the configured database this file ever opens.
 *
 * `PgClient.layer` with an explicit URL, never `DatabaseLive`: this client creates and drops the
 * run's own database, and migrating somebody else's would be the very reach this change is about.
 * It never writes a `sessions` row either. Five statements reach the configured database and no
 * more: `CREATE DATABASE` and `DROP DATABASE` for the run's own, `current_database()`, a
 * `to_regclass('public.sessions')` probe and a `SELECT id FROM sessions` — the last two in one
 * helper that the witness below runs once before any case and once after them. Every one of the
 * five is named in `describe("this suite's database")` at the end of this file.
 */
const maintenance = ManagedRuntime.make(
  PgClient.layer({
    url: Redacted.make(configuredUrl),
    maxConnections: 2,
  }).pipe(Layer.provide(BunServices.layer)),
);

/**
 * Create the run's database, loudly.
 *
 * A failure here is the loop's Postgres precondition failing, which the gate must not paper over:
 * there is no fallback to the configured database, because pointing at that is the defect.
 */
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
  SessionServiceLive({ model: createModelAccess("faux"), sessionRoot }).pipe(
    Layer.provideMerge(DatabaseLayer),
  ),
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

/**
 * The ids the *configured* database held before a single case ran.
 *
 * A witness for the isolation, not the isolation itself: the case below asks whether they are all
 * still there, and `sessions` is the table the rebuild case empties. Read before anything runs, so
 * another suite adding rows while this file runs is not this file's harm — only a *deletion* of one
 * of these ids is.
 */
const configuredSessionIdsAtStart = await maintenance.runPromise(
  sessionIds.pipe(Effect.orDie),
);

afterAll(async () => {
  // The run's own pool holds connections to the database being dropped, so it goes first.
  await runtime.dispose();
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

/** The page size this loop drives the list with, and the page size the old bound assumed. */
const PAGE_SIZE = 25;
/**
 * Filler rows this test writes itself. More than the old fixed budget of ten pages (`10 × 25`),
 * so the test fails on a database of *any* size unless the loop is bounded by the data it reads
 * rather than by a constant. The table may hold anything on top of these.
 */
const FILLERS = 280;

describe("session list", () => {
  it("shows a new session without a poll, pages by cursor, one statement per page", async () => {
    const result = await program(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const sql = yield* SqlClient;
        // The filler rows are this test's, so its own leftovers are the only ones to clear here.
        yield* sql`DELETE FROM sessions WHERE id LIKE 'ses\_f%'`;

        const first = yield* sessions.create({ title: "older" });
        const second = yield* sessions.create({ title: "newer" });
        const third = yield* sessions.create({ title: "newest" });
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
          SELECT 'ses_f' || lpad(n::text, 25, '0'), 'filler ' || n
          FROM generate_series(0, ${FILLERS - 1}) AS g(n)
        `;
        yield* sql`
          INSERT INTO session_activity (session_id, last_activity_at)
          SELECT 'ses_f' || lpad(n::text, 25, '0'), now() - make_interval(secs => 300 + n)
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
        return { first, second, third, immediately, pages, exhausted, visible };
      }).pipe(
        // The fillers go whether this test passes, fails or dies: the cases below page over the
        // whole table, so 280 rows left behind are rows they read and this case does not own.
        Effect.ensuring(
          Effect.gen(function* () {
            const sql = yield* SqlClient;
            yield* sql`DELETE FROM sessions WHERE id LIKE 'ses\_f%'`;
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
    // Ordering contract, page after page: newest activity first, id descending to break ties.
    expect(keys).toEqual([...keys].sort().reverse());
    expect(new Set(keys).size).toBe(keys.length);
    // The loop ended because the cursor ran out, not because it hit its budget: the list pages to
    // the end of a database of any size. This is the assertion the old constant bound broke.
    expect(result.exhausted).toBe(true);
    expect(result.pages.at(-1)?.value.nextCursor).toBeUndefined();
    expect(result.pages.length).toBeGreaterThan(1);
    // Every row the list can see comes back. `session_activity.session_id` is the primary key, so
    // its count is exactly the set the list pages over, and a shortfall means rows were dropped —
    // in the rows behind the fillers as much as in the fillers themselves.
    expect(entries.length).toBeGreaterThanOrEqual(result.visible);
    // Every filler row this test wrote comes back exactly once, so a list that stops early inside
    // them cannot pass by landing on the three sessions below.
    expect(entries.filter((entry) => entry.id.startsWith("ses_f")).length).toBe(
      FILLERS,
    );
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
  });

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
  // `describe("this suite's database")` at the end of this file is what notices if that stops being
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
          return { GROUP, pages, exhausted };
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
          return { GROUP, LIMIT, pages, exhausted, visible };
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
    expect(entries.length).toBeGreaterThanOrEqual(result.visible);
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
          return { GROUP, pages, exhausted, clamped };
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
          return { GROUP, pages, exhausted, visible };
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
    expect(entries.length).toBeGreaterThanOrEqual(result.visible);
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
          return { GROUP, pages, exhausted, visible };
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
    expect(entries.length).toBeGreaterThanOrEqual(result.visible);
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
          return { GROUP, pages, exhausted, visible };
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
    expect(entries.length).toBeGreaterThanOrEqual(result.visible);
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
          return { GROUP, pages, exhausted, visible };
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
    expect(entries.length).toBeGreaterThanOrEqual(result.visible);
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
          return { GROUP, pages, exhausted, visible, clamped };
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
    expect(entries.length).toBeGreaterThanOrEqual(result.visible);
    for (const page of result.pages) expect(page.statements).toBe(1);

    expect(result.clamped.sessions.length).toBe(MAX_PAGE_SIZE);
    expect(result.clamped.nextCursor).toBeDefined();
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
  // every session on the machine (LOB-96). Both costs go with the same fix: this file runs against
  // a database of its own (the block above), so the delete below and the fold that follows are
  // about this run's rows — 157 ms measured, against vitest's 5 s default, where it used to take
  // 20 s against the run-context database's 2 883 sessions.
  //
  // Mutation checked: `rebuild.ts`'s `if (!Schema.is(SessionId)(log.logId)) continue;` to
  // `if (true) continue;`, which makes the fold restore nothing — this case goes red on
  // `result.after` being undefined, and `describe("this suite's database")` stays green, because the
  // fold's job and the isolation's are separate claims and each is worth its own case.
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
        const created = yield* sessions.create({
          repo: factoryRepo,
          baseRef: "main",
          title: "rebuild me",
        });
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
        return { before, empty, report, after, repos };
      }),
    );

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
    // the rebuilt one when its first commit landed. Milliseconds apart, not a different session.
    expect(
      Math.abs(
        Date.parse(result.before.createdAt) -
          Date.parse(result.after.createdAt),
      ),
    ).toBeLessThan(1000);
    // A slug the log names is back with no URL; an operator's URL survives.
    expect(result.repos[0]?.slug).toBe("lobiklukas/factory");
    expect(result.repos[0]?.url).toBe(
      "https://github.com/lobiklukas/factory.git",
    );
    expect(result.repos[0]?.defaultBaseRef).toBe("main");
  });
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
/** The name of the database a client is connected to: what the two pools below are compared on. */
const currentDatabase = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const rows = yield* sql<{ name: string }>`SELECT current_database() AS name`;
  const name = rows[0]?.name;
  if (name === undefined) throw new Error("unreachable");
  return name;
});

/**
 * The run's own database, asserted rather than assumed (LOB-96).
 *
 * Everything above depends on it: the rebuild case empties `sessions` and the session-list case
 * writes 280 filler rows, so a run pointed at the configured database takes that database's
 * sessions with it and pays for its whole log. The block at the top of this file is what makes that
 * untrue, and these two cases are what notice if it stops being true.
 *
 * They read the isolation at run time, not the source, because the isolation is a property of the
 * connection and not of the text: pointing the suite's `DATABASE_URL` back at the configured
 * database is a one-line deletion that every comment in this file would go along with.
 *
 * The third case is not about isolation but about the duplication that makes it expressible: this
 * file spells `DatabaseConfig`'s default URL out again, and a comment asking the two to stay in
 * step is not enforcement.
 *
 * What this block cannot witness is the drop itself. `afterAll` runs after every case in the file,
 * so no case here can observe whether the run's database went away, and a neutralised `DROP
 * DATABASE` leaves the suite green (measured). A run killed between `CREATE DATABASE` and
 * `afterAll` — a signal, a crash — therefore leaves one database behind, and nothing collects it.
 * That is a leak of *empty databases* in the shared catalogue, not of session rows, which is what
 * the two cases below are about; LOB-135 owns the sweep that would collect them.
 *
 * Mutation checked: deleting the `process.env["DATABASE_URL"] = runDatabaseUrl;` line above. The
 * first case then reads the configured database's name from both pools and goes red on it. The
 * second goes red on the unrelated ids the rebuild case above deleted and no fold could put back —
 * a session with no commits is exactly that, so the ids have to be the witness and a count cannot
 * be (a refold raises the count again and hides the loss; measured, `.verify/evidence/lob-96/`).
 * Do not apply it against the run-context database: that is the harm, live. Seed a scratch
 * database with a session that has no commits and point `DATABASE_URL` at that.
 */
describe("this suite's database", () => {
  it("is one of its own, not the one DATABASE_URL names", async () => {
    const [here, there] = await Promise.all([
      program(currentDatabase),
      maintenance.runPromise(currentDatabase.pipe(Effect.orDie)),
    ]);
    // Two real reads, so the inequality cannot come from a client that never connected: a run that
    // could not reach the configured database does not get this far.
    expect(there).toBe(configuredDatabase);
    expect(here).toBe(runDatabaseName);
    expect(here).not.toBe(there);
  });

  it("leaves every session the configured database already had", async () => {
    // The ids read before a single case ran, asked about again after the rebuild case emptied
    // `sessions`. A suite pointed at the configured database has by now deleted the ones it cannot
    // rebuild; an unrelated suite *adding* sessions is not this file's harm, so the assertion is
    // about these ids and not about a total.
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
