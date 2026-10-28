#!/usr/bin/env bun
// The facts `define.sh` (D4) cannot read from a terminal: what `board_definitions` holds, read
// straight from the table — the oracle `factory board define` is checked against, so it is a query
// of its own rather than the service's answer.
//
//   MODE=rows                every row, one line each: `<id>@<version> <md5 of the whole row>`,
//                            ordered — two snapshots are equal exactly when no row changed, and a
//                            new row is one more line.
//   MODE=versions ID=…       the versions one id holds, oldest first, space-separated ("" for none).
//
// Env: MODE, ID, DATABASE_URL. Exits non-zero when the read fails.
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { DatabaseLive } from "@repo/storage-postgres";

const MODE = process.env["MODE"] ?? "";
const ID = process.env["ID"] ?? "";

/** What this probe could not read, named, so the shell prints why it failed. */
class ProbeError extends Schema.TaggedError<ProbeError>()("ProbeError", {
  message: Schema.String,
}) {}

const rows = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const all = yield* sql<{ key: string; digest: string }>`
    SELECT id || '@' || version AS key,
           md5(concat_ws('|', name, columns::text, initial_column, caps::text, created_at::text)) AS digest
    FROM board_definitions
    ORDER BY id COLLATE "C", version
  `;
  return all.map((row) => `${row.key} ${row.digest}`).join("\n");
});

const versions = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const all = yield* sql<{ version: number }>`
    SELECT version FROM board_definitions WHERE id = ${ID} ORDER BY version
  `;
  return all.map((row) => String(row.version)).join(" ");
});

/** Every failure as a `ProbeError` carrying its own words, which is all the shell reads. */
const named = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.mapError((cause) => new ProbeError({ message: String(cause) })),
  );

const program: Effect.Effect<string, ProbeError, SqlClient> =
  MODE === "rows"
    ? named(rows)
    : MODE === "versions" && ID !== ""
      ? named(versions)
      : Effect.fail(
          new ProbeError({
            message: `MODE=rows or MODE=versions ID=…, not "${MODE}"`,
          }),
        );

Effect.runPromise(program.pipe(Effect.provide(DatabaseLive))).then(
  (out) => {
    if (out !== "") console.log(out);
    process.exit(0);
  },
  (error) => {
    console.error(`define: ${String(error)}`);
    process.exit(1);
  },
);
