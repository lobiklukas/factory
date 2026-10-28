#!/usr/bin/env bun
// The facts `upgrade.sh` (D5) cannot read from a terminal, read straight from the tables — the oracle
// `factory board upgrade` and the settings page's Upgrade action are checked against — and the one
// fixture write the phase needs.
//
//   MODE=pin BOARD=…     the version the board instance pins.
//   MODE=card TASK=…     `<pinned version> <column> <revision> <event count>` for one card.
//   MODE=last TASK=…     the card's newest event as JSON: `{kind, actor, revision, payload}`.
//   MODE=seat TASK=…     put the card in `review` at its next revision, and print it like `card`.
//                        Setup, not the subject: building's exit needs a run with a diff and a PR,
//                        which requires.sh proves; this phase is about which review a card meets.
//                        A `moved` event is appended so the card's history still says where it is.
//
// Env: MODE, BOARD, TASK, DATABASE_URL. Exits non-zero when the read fails.
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { DatabaseLive } from "@repo/storage-postgres";

const MODE = process.env["MODE"] ?? "";
const BOARD = process.env["BOARD"] ?? "";
const TASK = process.env["TASK"] ?? "";

class ProbeError extends Schema.TaggedError<ProbeError>()("ProbeError", {
  message: Schema.String,
}) {}

const pin = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const rows = yield* sql<{ version: number }>`
    SELECT definition_version AS version FROM board_instances WHERE id = ${BOARD}
  `;
  return rows[0] === undefined ? "" : String(rows[0].version);
});

const card = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const rows = yield* sql<{
    version: number;
    column: string;
    revision: number;
    events: number;
  }>`
    SELECT t.definition_version AS version, t."column", t.revision,
           (SELECT count(*)::int FROM task_events e WHERE e.task_id = t.id) AS events
    FROM tasks t WHERE t.id = ${TASK}
  `;
  const row = rows[0];
  return row === undefined
    ? ""
    : `${row.version} ${row.column} ${row.revision} ${row.events}`;
});

const last = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const rows = yield* sql<{
    kind: string;
    actor: string;
    revision: number;
    payload: unknown;
  }>`
    SELECT kind, actor, revision, payload FROM task_events
    WHERE task_id = ${TASK} ORDER BY id DESC LIMIT 1
  `;
  const row = rows[0];
  if (row === undefined) return "";
  // One compact JSON line whatever the driver hands back for JSONB, so the shell's greps match.
  const payload: unknown =
    typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload;
  return JSON.stringify({ ...row, payload });
});

const seat = Effect.gen(function* () {
  const sql = yield* SqlClient;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      const rows = yield* sql<{ column: string; revision: number }>`
        SELECT "column", revision FROM tasks WHERE id = ${TASK} FOR UPDATE
      `;
      const row = rows[0];
      if (row === undefined)
        return yield* new ProbeError({ message: `no task ${TASK}` });
      yield* sql`
        UPDATE tasks SET "column" = 'review', revision = revision + 1, updated_at = now()
        WHERE id = ${TASK}
      `;
      const payload = JSON.stringify({
        _tag: "moved",
        taskId: TASK,
        from: row.column,
        to: "review",
        actor: "verify-board-fixture",
        revision: row.revision,
      });
      yield* sql`
        INSERT INTO task_events (task_id, kind, actor, revision, payload)
        VALUES (${TASK}, 'moved', 'verify-board-fixture', ${row.revision}, ${payload}::jsonb)
      `;
    }),
  );
  return yield* card;
});

const named = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.mapError((cause) => new ProbeError({ message: String(cause) })),
  );

const program: Effect.Effect<string, ProbeError, SqlClient> =
  MODE === "pin" && BOARD !== ""
    ? named(pin)
    : MODE === "card" && TASK !== ""
      ? named(card)
      : MODE === "last" && TASK !== ""
        ? named(last)
        : MODE === "seat" && TASK !== ""
          ? named(seat)
          : Effect.fail(
              new ProbeError({
                message: `MODE=pin BOARD=…, or MODE=card|last|seat TASK=…, not "${MODE}"`,
              }),
            );

Effect.runPromise(program.pipe(Effect.provide(DatabaseLive))).then(
  (out) => {
    if (out !== "") console.log(out);
    process.exit(0);
  },
  (error) => {
    console.error(`upgrade: ${String(error)}`);
    process.exit(1);
  },
);
