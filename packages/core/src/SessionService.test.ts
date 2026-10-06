/**
 * The session service, driven through its own interface against a real Postgres log.
 *
 * What this proves that the harness test cannot: a session created and driven here is readable
 * *the same way* after its owner is released, which is D8's live/historical pair — the live view
 * and the fold have to agree, or the dashboard shows two different sessions depending on whether
 * a sandbox happens to be running.
 *
 * Deterministic and offline (faux model), but it needs Postgres:
 * `docker compose up -d --wait postgres`.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BunServices } from "@effect/platform-bun";
import type {
  ListSessionsInput,
  ListSessionsOutput,
  SessionError,
  SessionEvent,
  SessionId,
  SessionListEntry,
} from "@repo/domain/Session";
import { RepoSlug as RepoSlugSchema } from "@repo/domain/Session";
import { DatabaseLive } from "@repo/storage-postgres";
import {
  Effect,
  Exit,
  Fiber,
  Layer,
  ManagedRuntime,
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

afterAll(async () => {
  await runtime.dispose();
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
 * rather than by a constant. The shared database may hold anything on top of these.
 */
const FILLERS = 280;

describe("session list", () => {
  it("shows a new session without a poll, pages by cursor, one statement per page", async () => {
    const result = await program(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const sql = yield* SqlClient;
        // Hermetic across runs: the filler rows are this test's, and the database is shared.
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
        // their own, whatever the shared database already holds.
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
        // The fillers go whether this test passes, fails or dies: 280 rows left behind on a red run
        // would grow the shared table for every later run as well.
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
    // in the shared rows behind the fillers as much as in the fillers themselves.
    expect(entries.length).toBeGreaterThanOrEqual(result.visible);
    // Every filler row this test wrote comes back exactly once, so a list that stops early inside
    // them cannot pass by landing on the three sessions below.
    expect(entries.filter((entry) => entry.id.startsWith("ses_f")).length).toBe(
      FILLERS,
    );
    // Cost is one statement per page whatever the row count: never a fold per session (R6).
    for (const page of result.pages) expect(page.statements).toBe(1);

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
  // Every case below pages over the *whole* shared table to prove the group is not dropped in
  // passing, so each one carries a budget: the table grew from 1 628 to 2 011 rows during this
  // iteration, and vitest's 5 s default turned that into `Test timed out in 5000ms` on three of
  // them. The budget is a ceiling, not a target — the cases run in milliseconds when the table
  // is small. The durable fix is LOB-96 (a database per run).
  it(
    "returns every row of a same-millisecond group exactly once",
    { timeout: 60_000 },
    async () => {
      const result = await program(
        Effect.gen(function* () {
          const sessions = yield* SessionService;
          const sql = yield* SqlClient;
          // Hermetic across runs: these rows are this test's, and the database is shared.
          yield* sql`DELETE FROM sessions WHERE id LIKE 'ses\_ms%'`;

          // One timestamp for the whole group, with non-zero microseconds. Both halves matter: a
          // timestamp whose millisecond rendering is already lossless would not trigger the bug,
          // and the group has to be newer than whatever the shared database holds so that the page
          // boundary falls inside it rather than below it.
          const [groupAt] = yield* sql<{ at: string }>`
          SELECT to_char(
            '2027-01-01T00:00:00.123456Z'::timestamptz AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
          ) AS at
        `;
          if (groupAt === undefined) throw new Error("unreachable");

          const GROUP = 12;
          // Zero-padded, so the id tiebreak orders them contiguously and a four-row page boundary
          // lands inside the group.
          yield* sql`
          INSERT INTO sessions (id, title)
          SELECT 'ses_ms' || lpad(n::text, 24, '0'), 'same millisecond ' || n
          FROM generate_series(0, ${GROUP - 1}) AS g(n)
        `;
          yield* sql`
          INSERT INTO session_activity (session_id, last_activity_at)
          SELECT 'ses_ms' || lpad(n::text, 24, '0'), ${groupAt.at}::timestamptz
          FROM generate_series(0, ${GROUP - 1}) AS g(n)
        `;

          const expected = Array.from(
            { length: GROUP },
            (_, n) => `ses_ms${String(n).padStart(24, "0")}`,
          );
          const LIMIT = 4;
          const budget = Math.ceil(GROUP / LIMIT) + 2;
          const seen: string[] = [];
          const statements: number[] = [];
          let cursor: string | undefined = undefined;
          let exhausted = false;
          for (let page = 0; page < budget; page += 1) {
            const input: ListSessionsInput =
              cursor === undefined
                ? { limit: LIMIT }
                : { limit: LIMIT, cursor };
            const counted = yield* countStatements(sessions.list(input));
            statements.push(counted.statements);
            for (const entry of counted.value.sessions) {
              if (entry.id.startsWith("ses_ms")) seen.push(entry.id);
            }
            cursor = counted.value.nextCursor;
            if (new Set(seen).size === GROUP) break;
            if (cursor === undefined) {
              exhausted = true;
              break;
            }
          }
          return { expected, seen, exhausted, statements };
        }).pipe(
          Effect.ensuring(
            Effect.gen(function* () {
              const sql = yield* SqlClient;
              yield* sql`DELETE FROM sessions WHERE id LIKE 'ses\_ms%'`;
            }).pipe(Effect.orDie),
          ),
        ),
      );

      // Every row of the group came back, exactly once, in the keyset's own order (id descending
      // inside the tie). A cursor truncated to the millisecond stopped the page at the boundary
      // and dropped the rest of the group.
      expect(result.seen).toEqual([...result.expected].sort().reverse());
      expect(new Set(result.seen).size).toBe(result.seen.length);
      // The loop ended because the group was complete, not because the cursor ran out first.
      expect(result.exhausted).toBe(false);
      // Cost is one statement per page whatever the row count: never a fold per session (R6).
      for (const count of result.statements) expect(count).toBe(1);
    },
  );

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
   * The database is shared, so a run that leaves its rows behind collides with the next run's
   * `sessions_pkey` — and, worse, silently changes the row count every other case pages over.
   */
  const deleteSeeded = Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql`DELETE FROM sessions WHERE id LIKE ${GROUP_PATTERN} OR id LIKE ${OLDER_PATTERN} OR id LIKE ${NEWER_PATTERN}`;
  });

  /**
   * Seed `n` sessions whose `last_activity_at` is one literal instant.
   *
   * The instant is a parameter because one case needs a group at the *end* of the ordering, which
   * only the database can place: `min(last_activity_at) - 1 hour` is however old the shared table
   * already is, and a fixed year would stop being the end the day something older is written.
   */
  const seedGroup = (n: number, at: string) =>
    Effect.gen(function* () {
      yield* deleteSeeded;
      const sql = yield* SqlClient;
      // The prefix is cast, not quoted: as a bare parameter Postgres cannot infer a type for
      // `$1 || lpad(…)` and rejects the statement with 42P18 before it runs.
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
   * of splitting it. What it pins is the ordinary path — the group is the head of page 1, and
   * every row below it still comes back — so a fix that special-cased same-millisecond groups and
   * broke the walk fails here rather than in the two cases below.
   */
  it(
    "mints the cursor from the exact instant when the group is exactly one page",
    { timeout: 60_000 },
    async () => {
      const result = await program(
        withGroup(
          Effect.gen(function* () {
            const sql = yield* SqlClient;
            const GROUP = 4;
            const LIMIT = 4;
            // Newer than anything the shared table holds, with non-zero microseconds: a timestamp
            // whose millisecond rendering is already lossless would not trigger the bug.
            yield* seedGroup(GROUP, "2027-01-01T00:00:00.123456Z");
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
      const group = entries.filter((entry) =>
        entry.id.startsWith(GROUP_PREFIX),
      );
      // The whole group, exactly once, in the keyset's own order.
      expect(group.map((entry) => entry.id)).toEqual(
        groupIdsDescending(result.GROUP),
      );
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
    },
  );

  /**
   * A group paged one row at a time, so every single page boundary falls inside the group.
   *
   * This is the sharpest form of the defect: the cursor is minted from a group row on every page,
   * and a millisecond-truncated one drops the rest of the group every time, not once.
   */
  it(
    "returns a same-millisecond group one row at a time",
    { timeout: 60_000 },
    async () => {
      const result = await program(
        withGroup(
          Effect.gen(function* () {
            const sessions = yield* SessionService;
            const sql = yield* SqlClient;
            const GROUP = 5;
            yield* seedGroup(GROUP, "2027-01-01T00:00:00.123456Z");
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
      const group = entries.filter((entry) =>
        entry.id.startsWith(GROUP_PREFIX),
      );
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
    },
  );

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
  it(
    "returns a same-millisecond group that sits inside a larger page",
    { timeout: 60_000 },
    async () => {
      const result = await program(
        withGroup(
          Effect.gen(function* () {
            const sql = yield* SqlClient;
            const GROUP = 3;
            yield* seedGroup(GROUP, "2027-01-01T00:00:00.123456Z");
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
      const group = entries.filter((entry) =>
        entry.id.startsWith(GROUP_PREFIX),
      );
      expect(group.map((entry) => entry.id)).toEqual(
        groupIdsDescending(result.GROUP),
      );
      expect(new Set(group).size).toBe(group.length);
      expect(result.exhausted).toBe(true);
      expect(entries.length).toBeGreaterThanOrEqual(result.visible);
      for (const page of result.pages) expect(page.statements).toBe(1);
    },
  );

  /**
   * A group at the very end of the ordering — the oldest rows, not the newest.
   *
   * The cursor that reaches this group is minted from a row *above* it, so a different instant,
   * and the group is found by comparison rather than by being the head of the first page. The
   * page that starts inside the group then mints a cursor from a group row, and the next page has
   * to come back for the rest of the group instead of skipping past it.
   */
  it(
    "returns a same-millisecond group at the end of the ordering",
    { timeout: 60_000 },
    async () => {
      const result = await program(
        withGroup(
          Effect.gen(function* () {
            const sql = yield* SqlClient;
            const GROUP = 5;
            // However old the shared table already is: the group has to be the end of the ordering,
            // whatever else is in it.
            // The subtraction is parenthesised: `AT TIME ZONE` binds to the interval on its left,
            // so without them Postgres reads `interval '1 hour' AT TIME ZONE 'UTC'` and rejects the
            // statement (42883) rather than shifting the instant.
            //
            // The sub-millisecond part is pinned rather than inherited. `min(last_activity_at)` in
            // this shared database is `…28.945000`, so a group placed at `min - 1 hour` renders
            // losslessly at millisecond precision and the truncated cursor drops nothing — the
            // case would pass against the unfixed code. Truncating to the second and adding a
            // fixed `.123456` makes the loss deterministic whatever the table holds.
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
      const group = entries.filter((entry) =>
        entry.id.startsWith(GROUP_PREFIX),
      );

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
    },
  );

  /**
   * A cursor in the old millisecond-only format, fed back in.
   *
   * This pins the boundary of the fix rather than a behaviour anyone wanted. `parseCursor` checks
   * only that the cursor has a `|` and a well-formed id, so a truncated `at` is *accepted* — and
   * then loses every remaining row of that millisecond, because the stored `timestamptz` is
   * strictly greater than the truncated cursor. The code says so itself: nothing can repair a value
   * that has already been rounded. The contrast with the exact cursor on the same page is what
   * makes that visible in one test.
   */
  it(
    "accepts a millisecond-truncated cursor and loses the rest of that millisecond",
    { timeout: 60_000 },
    async () => {
      const result = await program(
        withGroup(
          Effect.gen(function* () {
            const sessions = yield* SessionService;
            const GROUP = 6;
            const LIMIT = 4;
            yield* seedGroup(GROUP, "2027-01-01T00:00:00.123456Z");

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
      expect(
        groupOf(result.exactNext.sessions).map((entry) => entry.id),
      ).toEqual(groupIdsDescending(result.GROUP).slice(4));
      // The truncated cursor is accepted, and its page holds no row of the group at all: the two rows
      // above are skipped by the keyset comparison.
      expect(groupOf(result.oldFormat.sessions)).toEqual([]);
      // Paging on from it, the group is still absent — the loss is permanent for that cursor, not
      // deferred to the next page.
      expect(
        groupOf(result.pages.flatMap((page) => page.output.sessions)),
      ).toEqual([]);
    },
  );

  /**
   * The smallest group the defect needs: two rows sharing a millisecond, with the page boundary
   * between them.
   *
   * Every other case here seeds at least three rows, so a boundary that splits a *pair* — one row
   * on each side of it — is the sharpest form of the repro, and the one the issue measured. A fix
   * that only held for a group larger than the page would pass all of them and still drop the
   * second row here.
   */
  it(
    "returns a two-row same-millisecond group split by the page boundary",
    { timeout: 60_000 },
    async () => {
      const result = await program(
        withGroup(
          Effect.gen(function* () {
            const GROUP = 2;
            const LIMIT = 1;
            yield* seedGroup(GROUP, "2027-01-01T00:00:00.123456Z");
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
      const group = entries.filter((entry) =>
        entry.id.startsWith(GROUP_PREFIX),
      );
      expect(group.map((entry) => entry.id)).toEqual(
        groupIdsDescending(result.GROUP),
      );
      expect(new Set(group).size).toBe(group.length);
      expect(result.exhausted).toBe(true);
      expect(entries.length).toBeGreaterThanOrEqual(result.visible);
      for (const page of result.pages) expect(page.statements).toBe(1);
    },
  );

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
  it(
    "returns a group whose millisecond rendering is already lossless",
    { timeout: 60_000 },
    async () => {
      const result = await program(
        withGroup(
          Effect.gen(function* () {
            const GROUP = 6;
            const LIMIT = 4;
            // `.123000`: the millisecond rendering *is* the value, so the truncated cursor an
            // older build minted was already exact and the bug had nothing to bite on.
            yield* seedGroup(GROUP, "2027-01-01T00:00:00.123000Z");
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
      const group = entries.filter((entry) =>
        entry.id.startsWith(GROUP_PREFIX),
      );
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
    },
  );

  /**
   * A group straddling the page-size cap, and a limit larger than the table.
   *
   * `MAX_PAGE_SIZE` is where `Math.min` stops, so the query fetches `MAX_PAGE_SIZE + 1` rows and
   * `rows.length > limit` is decided a hundred rows into the group rather than four. The group
   * is deliberately bigger than the cap, so the boundary falls inside it at the largest limit the
   * service will honour. The second half pins the clamp itself: a limit above the cap is answered
   * with a capped page, not with the whole table.
   */
  it(
    "returns a same-millisecond group straddling the page-size cap",
    { timeout: 60_000 },
    async () => {
      const result = await program(
        withGroup(
          Effect.gen(function* () {
            const sessions = yield* SessionService;
            // A literal, not `MAX_PAGE_SIZE + 3`: the seed's `generate_series(0, n - 1)` needs a
            // type it can infer, and an expression typed `number` goes over the wire as double
            // precision, which Postgres rejects (42883).
            const GROUP = 103;
            yield* seedGroup(GROUP, "2027-01-01T00:00:00.123456Z");
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
      const group = entries.filter((entry) =>
        entry.id.startsWith(GROUP_PREFIX),
      );
      expect(group.map((entry) => entry.id)).toEqual(
        groupIdsDescending(result.GROUP),
      );
      expect(new Set(group).size).toBe(group.length);
      expect(result.exhausted).toBe(true);
      expect(entries.length).toBeGreaterThanOrEqual(result.visible);
      for (const page of result.pages) expect(page.statements).toBe(1);

      expect(result.clamped.sessions.length).toBe(MAX_PAGE_SIZE);
      expect(result.clamped.nextCursor).toBeDefined();
    },
  );

  /**
   * Refuse a same-millisecond case that declares no budget.
   *
   * The budgets above are load-bearing rather than decorative: with the shared table at ~2 000
   * rows, vitest's 5 s default timed out three of these cases and took the whole gate red. This
   * reads the file back and fails when a case in this group loses its `timeout:`.
   */
  it("gives every same-millisecond case a budget", () => {
    const source = readFileSync(new URL(import.meta.url), "utf8");
    // Anchor on the declaration, not the bare name: this case's own body quotes both names, and
    // a bare `indexOf` would find that instead and read a 105-character slice of itself.
    const first =
      'it("returns every row of a same-millisecond group exactly once", {';
    const start = source.indexOf(first);
    const end = source.indexOf('it("refuses a cursor it did not mint"', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const group = source.slice(start, end);
    const cases = [...group.matchAll(/\bit\("[^"]+", \{ timeout:/g)];
    const bare = [...group.matchAll(/\bit\("[^"]+", async/g)];
    expect(bare).toEqual([]);
    expect(cases.length).toBe(9);
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
  // log by log, so this case's cost is the whole shared log's, not the one session it asserts on.
  // Measured 2026-10-06 at ~670 session logs / 11 754 commits: 5.8-6.0 s, i.e. 6-7.5 ms per session
  // log and almost nothing per commit row. Vitest's 5 s default was under that, so the gate went
  // red for every iteration — and the abort is destructive, because the case's own
  // `DELETE FROM sessions` has already run when the timeout fires. 30 000 is ~5x today's fold and
  // the budget expires at ~4 050 session logs (the guard at the end of this file pins it); a
  // database of its own per run is the durable fix (LOB-96).
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

        // Drop the derived rows, as losing an index table would.
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
  }, 30_000);
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
 * The rebuild case's budget, guarded so it cannot silently go back to vitest's default (LOB-113).
 *
 * The case above empties the shared `sessions` index and refolds *every* session log the database
 * holds, so its cost is the database's, not the case's — the case comment has the measurement.
 * Deleting the case's third argument is silent while the database is small (the LOB-107 iteration
 * saw the case pass in 2.06 s against a database created empty for the run) and reddens only once
 * the shared database has grown past the default, so the deletion is invisible exactly when it is
 * made. Reading this file back is the shape `postgres-up.test.ts` already uses for its own header.
 *
 * What this cannot prove: that the declared budget is *enough*. No static check can — only the
 * fold's cost on the database in front of it, which is why the case itself is what fails when the
 * deadline passes. Two other ways out of the problem satisfy the issue but not this reader, so the
 * guard has to be updated with them: a repo-wide `testTimeout` in `vitest.config.ts`, and
 * `it(name, { timeout }, fn)`. A skipped or excluded `describe("session list")` passes it as well,
 * because every byte it reads is still in the file.
 *
 * If LOB-96 lands and `@repo/core` gets a database of its own per run, delete this describe
 * together with the case's third argument and the case comment that explains it, with the fold's
 * new cost in the commit message.
 *
 * Mutation checked: deleting the case's `, 30_000` back to `  });` — the budget case below goes red
 * in 2-3 ms, with no database involved. `reads a budget only where one is declared` is the control
 * that keeps it from passing on a reader that answers unconditionally.
 */
const REBUILD_CASE =
  "rebuilds the index from the log after the index tables are emptied";

/**
 * The budget a case declares, or `undefined` when it would take vitest's default.
 *
 * The case's closing line is the first two-space-indented `}` after its `it(` — every nested
 * callback in the body closes deeper — and the budget is the optional third argument on it.
 */
const declaredBudget = (
  source: string,
  caseName: string,
): number | undefined => {
  const start = source.indexOf(`it("${caseName}"`);
  if (start < 0) return undefined;
  const closing = /^ {2}\}(?:, (\d[\d_]*))?\);/m.exec(source.slice(start));
  const digits = closing?.[1];
  return digits === undefined ? undefined : Number(digits.replaceAll("_", ""));
};

describe("the rebuild case's budget", () => {
  const source = readFileSync(fileURLToPath(import.meta.url), "utf8");

  it("declares a timeout big enough for a shared database's whole-log fold", () => {
    // The case has to be in the file at all, or the reader below would be reading nothing.
    expect(source).toContain(REBUILD_CASE);
    const budget = declaredBudget(source, REBUILD_CASE);
    expect(
      budget,
      `no third-argument timeout on "${REBUILD_CASE}", so it would take vitest's 5 s default, which is under the shared database's whole-log fold: declare \`, 30_000)\` on the case, or update this guard as its header says.`,
    ).toBeDefined();
    if (budget === undefined) throw new Error("unreachable");
    // 30 000 is what LOB-113 chose: ~5x the 5.9 s the fold costs at ~670 session logs. A smaller
    // budget is a decision to re-measure the fold against the run-context database, not an edit.
    expect(budget).toBeGreaterThanOrEqual(30_000);
  });

  it("reads a budget only where one is declared", () => {
    // Negative control for the reader, on a source shaped like this file: a case whose body closes
    // a nested callback first and then declares nothing. If this read as a budget, the case above
    // would pass on a file that declares none.
    const without = [
      'describe("x", () => {',
      `  it("${REBUILD_CASE}", async () => {`,
      "    const nested = (() => {",
      "      return 1;",
      "    });",
      "  });",
      "});",
      "",
    ].join("\n");
    expect(declaredBudget(without, REBUILD_CASE)).toBeUndefined();
    // The same source with the third argument back reads as that number, underscore and all.
    expect(
      declaredBudget(
        without.replace(/^ {2}\}\);$/m, "  }, 120_000);"),
        REBUILD_CASE,
      ),
    ).toBe(120_000);
  });
});
