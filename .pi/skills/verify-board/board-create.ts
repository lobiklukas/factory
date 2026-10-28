#!/usr/bin/env bun
// The two facts `board-create.sh` cannot read from a terminal (LOB-208): which version of the
// default pipeline is the newest one in the database, and what a run's prompt was told.
//
//   MODE=newest                    the newest `default` version, read straight from
//                                  `board_definitions` — the oracle `factory board create` is checked
//                                  against, so it is a query of its own rather than the service's
//                                  answer. Prints the number.
//   MODE=prompt SESSION_ID=…       the prompt sections the run's own log leaves in effect, polled
//                                  until the run has opened (at most 30 s). Prints one JSON line:
//                                  {"sections":["…"],"skillSpecify":"…"}.
//   MODE=boards                    how many board instances the database holds — the oracle
//                                  `definitions.sh` (LOB-270) checks `factory board list` against.
//                                  Prints the number.
//
// Env: MODE, SESSION_ID, DATABASE_URL. Exits non-zero when the read fails.
import { Effect, Schedule, Schema } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { SessionId } from "@repo/domain/Session";
import { readPromptSections } from "@repo/harness";
import { DatabaseLive, PostgresStorage } from "@repo/storage-postgres";

const MODE = process.env["MODE"] ?? "";
const SESSION_RAW = process.env["SESSION_ID"] ?? "";

/** What this probe could not read, named, so the shell prints why it failed. */
class ProbeError extends Schema.TaggedError<ProbeError>()("ProbeError", {
  message: Schema.String,
}) {}

const newest = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const rows = yield* sql<{ version: number | null }>`
    SELECT max(version)::int AS version FROM board_definitions WHERE id = 'default'
  `;
  return String(rows[0]?.version ?? "");
});

const boards = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const rows = yield* sql<{ n: number }>`
    SELECT count(*)::int AS n FROM board_instances
  `;
  return String(rows[0]?.n ?? "");
});

const prompt = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const session = yield* Schema.decodeEffect(SessionId)(SESSION_RAW);
  // Retried until the run's log holds its prompt: `board start` returns when the turn is accepted,
  // which can be before the session has written anything.
  const sections = yield* Effect.gen(function* () {
    const read = yield* Effect.acquireUseRelease(
      Effect.promise(() => PostgresStorage.reader(sql, session)),
      (storage) => readPromptSections(storage),
      (storage) => Effect.promise(() => storage.dispose()),
    );
    if (Object.keys(read).length === 0) {
      return yield* new ProbeError({
        message: `no prompt in ${session}'s log yet`,
      });
    }
    return read;
  }).pipe(Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 60 }));
  return JSON.stringify({
    sections: Object.keys(sections).sort(),
    skillSpecify: sections["skill_specify"] ?? "",
  });
});

/** Every failure as a `ProbeError` carrying its own words, which is all the shell reads. */
const named = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.mapError((cause) => new ProbeError({ message: String(cause) })),
  );

const program: Effect.Effect<string, ProbeError, SqlClient> =
  MODE === "newest"
    ? named(newest)
    : MODE === "prompt"
      ? named(prompt)
      : MODE === "boards"
        ? named(boards)
        : Effect.fail(new ProbeError({ message: `unknown MODE "${MODE}"` }));

Effect.runPromise(program.pipe(Effect.provide(DatabaseLive))).then(
  (line) => {
    console.log(line);
    process.exit(0);
  },
  (error) => {
    console.error(`board-create: ${String(error)}`);
    process.exit(1);
  },
);
