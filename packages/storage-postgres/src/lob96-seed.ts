/**
 * LOB-96 acceptance driver, part 1: create `lob96_seed`, migrate it with the repo's own migrator
 * and put unrelated sessions in it — the rows the rebuild case used to delete.
 *
 * Usage: DATABASE_URL=postgres://factory:factory@localhost:5442/lob96_seed bun src/lob96-seed.ts
 * (run from `packages/storage-postgres`)
 *
 * Step 1 cannot go through `PostgresLive`, which connects to the database named by `DATABASE_URL` —
 * the one that does not exist yet. It uses an explicit-URL client on `postgres` instead, exactly as
 * the suite's own maintenance client does.
 */
import { BunServices } from "@effect/platform-bun";
import { PgClient } from "@effect/sql-pg";
import { SqlClient } from "effect/sql/SqlClient";
import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { MigrationsLive, PostgresLive } from "@repo/storage-postgres";

const configured = process.env["DATABASE_URL"] ?? "";
const configuredUrl = new URL(configured);
const seedName = configuredUrl.pathname.replace(/^\//, "") || "postgres";

const admin = ManagedRuntime.make(
  PgClient.layer({
    url: Redacted.make(
      `postgres://factory:factory@${configuredUrl.host}/postgres`,
    ),
    maxConnections: 2,
  }).pipe(Layer.provide(BunServices.layer)),
);

await admin.runPromise(
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    // Identifiers, not parameters: Postgres has no placeholder for them.
    yield* sql`DROP DATABASE IF EXISTS ${sql(seedName)} WITH (FORCE)`;
    yield* sql`CREATE DATABASE ${sql(seedName)}`;
  }),
);

// From here the database exists, so the repo's own layers can migrate and seed it.
const pg = ManagedRuntime.make(Layer.mergeAll(PostgresLive, BunServices.layer));
const migrator = ManagedRuntime.make(
  MigrationsLive.pipe(Layer.provide(PostgresLive), Layer.orDie),
);

await migrator.runPromise(Effect.void);

// Unrelated rows, in the position the issue names: sessions that exist and have no commits, so the
// fold could never have restored them.
const seeded = await pg.runPromise(
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql`
      INSERT INTO sessions (id, title)
      SELECT 'ses_seed_' || n, 'unrelated ' || n FROM generate_series(1, 4) AS g(n)
    `;
    yield* sql`
      INSERT INTO session_activity (session_id, last_activity_at)
      SELECT 'ses_seed_' || n, now() - make_interval(secs => n)
      FROM generate_series(1, 4) AS g(n)
    `;
    yield* sql`
      INSERT INTO repos (slug, url, default_base_ref)
      VALUES ('lobiklukas/unrelated', 'https://example.invalid/unrelated.git', 'main')
      ON CONFLICT (slug) DO NOTHING
    `;
    const rows = yield* sql<{
      id: string;
    }>`SELECT id FROM sessions ORDER BY id`;
    return rows.map((row) => row.id);
  }),
);

console.log(JSON.stringify({ database: seedName, seeded }, null, 1));
await pg.dispose();
await migrator.dispose();
await admin.dispose();
