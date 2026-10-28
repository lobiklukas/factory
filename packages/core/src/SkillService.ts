/**
 * Skills: read and write the named, versioned skill documents in the `skills` table (LOB-173,
 * part 2 of LOB-48; versioned by D7).
 *
 * A skill mirrors its on-disk shape, `.pi/skills/<name>/SKILL.md`: a name, a version, a one-line
 * description, the markdown body, and the attachments it links. The table is keyed by
 * `(name, version)` (`0037_version_skills.ts`): a write is `put`, which adds version `newest + 1`
 * and never rewrites a row, so the body a run opened with is still there when the run is reopened
 * (docs/board.md B2). A read names a version, or takes the newest.
 *
 * The rows come from `0009_create_skills.ts`, which seeds the three stage skills (`specify`,
 * `implement`, `review`), and the seeds after it (`docs`, `decompose`, `plan-freshness`), each at
 * version 1; every later version is an operator's `putSkill`. Postgres only: the tests run against
 * the real schema, not a mock.
 *
 * `attachments` is a jsonb column but is read and written as JSON text, encoded and decoded by a
 * Schema codec, so a stored value always round-trips through `readonly string[]` rather than
 * whatever the driver chose to do with the column.
 */
import { Context, DateTime, Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import {
  InvalidSkill,
  SkillNotFound,
  SkillRecord,
  SkillStorageError,
  SkillVersionSummary,
  type PutSkillInput,
  type SkillSummary,
} from "@repo/domain/Skill";
import type { BoardColumn } from "@repo/domain/Task";

export type SkillServiceShape = {
  /**
   * One skill by name: the version named, or the newest. A name the table does not hold, or a
   * version it does not hold of it, is a `SkillNotFound` naming both.
   */
  readonly get: (
    name: string,
    version?: number,
  ) => Effect.Effect<SkillRecord, SkillNotFound | SkillStorageError>;
  /**
   * Every skill at its newest version, ordered by name. An Effect value: each run reads the table
   * again, so a version put since the last read is the one it answers.
   */
  readonly list: Effect.Effect<ReadonlyArray<SkillRecord>, SkillStorageError>;
  /**
   * Every version of one skill, newest first, without the bodies (D8): who put each and when. A name
   * the table does not hold is `SkillNotFound`, so an empty history is never an answer.
   */
  readonly versions: (
    name: string,
  ) => Effect.Effect<
    ReadonlyArray<SkillVersionSummary>,
    SkillNotFound | SkillStorageError
  >;
  /**
   * Add a version: `newest + 1`, or 1 for a name the table does not hold. Never an update — no row
   * a run may have opened on is touched. A blank body is `InvalidSkill`, and nothing is written.
   */
  readonly put: (
    input: PutSkillInput,
  ) => Effect.Effect<SkillRecord, InvalidSkill | SkillStorageError>;
};

export class SkillService extends Context.Service<
  SkillService,
  SkillServiceShape
>()("@repo/core/SkillService") {}

/**
 * The `attachments` jsonb column, as JSON text. Encoding turns `readonly string[]` into a string
 * for Postgres; decoding turns the string back, and fails loudly on anything that is not an array
 * of strings rather than trusting the column.
 */
const AttachmentsJson = Schema.fromJsonString(Schema.Array(Schema.String));

/** One `skills` row as the driver returns it; `attachments` is selected as text. */
type SkillRow = {
  readonly name: string;
  readonly version: number;
  readonly description: string;
  readonly body: string;
  readonly attachments: string;
  readonly createdAt: Date | string;
  readonly author: string;
  readonly newest: number;
};

/**
 * The column list, with `attachments` cast to text and the name's newest version beside each row.
 * Spelled out once so every read returns the same shape; `s` is the `skills` row being read.
 */
const SKILL_COLUMNS = [
  "s.name",
  "s.version",
  "s.description",
  "s.body",
  "s.attachments::text AS attachments",
  "s.created_at",
  "s.author",
  "(SELECT max(n.version) FROM skills n WHERE n.name = s.name) AS newest",
].join(", ");

/**
 * How many times a put asks again after a concurrent put took the version it computed. Each retry
 * reads the newest version afresh, so it loses only to another put that committed in between; a
 * put that loses this many times in a row is reported rather than spun on.
 */
const PUT_ATTEMPTS = 5;

const iso = (value: Date | string): string =>
  DateTime.formatIso(DateTime.makeUnsafe(value));

/**
 * Which columns of a definition bind each skill, in column order (D7): what `factory skill ls`
 * prints beside a skill, so an operator can see which runs a put reaches before making it. Pure, so
 * the join is a table in a test; a skill no column names maps to `[]`.
 */
export const summarizeSkills = (
  skills: ReadonlyArray<SkillRecord>,
  columns: ReadonlyArray<Pick<BoardColumn, "name" | "skills">>,
): ReadonlyArray<SkillSummary> =>
  skills.map((skill) => ({
    name: skill.name,
    version: skill.version,
    description: skill.description,
    createdAt: skill.createdAt,
    columns: columns
      .filter((column) => column.skills.includes(skill.name))
      .map((column) => column.name),
  }));

export const SkillServiceLive = Layer.effect(
  SkillService,
  Effect.gen(function* () {
    const sql = yield* SqlClient;

    const decodeAttachments = Schema.decodeUnknownEffect(AttachmentsJson);
    const encodeAttachments = Schema.encodeEffect(AttachmentsJson);
    const decodeSkill = Schema.decodeUnknownEffect(SkillRecord);
    const decodeVersions = Schema.decodeUnknownEffect(
      Schema.Array(SkillVersionSummary),
    );

    /** Turns a driver failure into a storage failure. */
    const withStorage = <A>(
      effect: Effect.Effect<A, SqlError>,
    ): Effect.Effect<A, SkillStorageError> =>
      effect.pipe(
        Effect.catchTag("SqlError", (cause) =>
          Effect.fail(new SkillStorageError({ message: cause.message })),
        ),
      );

    const toSkill = (
      row: SkillRow,
    ): Effect.Effect<SkillRecord, SkillStorageError> =>
      Effect.gen(function* () {
        const attachments = yield* decodeAttachments(row.attachments);
        return yield* decodeSkill({
          name: row.name,
          version: row.version,
          description: row.description,
          body: row.body,
          attachments,
          createdAt: iso(row.createdAt),
          author: row.author,
          newest: row.newest,
        });
      }).pipe(
        Effect.mapError(
          (cause) =>
            new SkillStorageError({
              message: `the skills table holds an invalid row ${row.name}@${row.version}: ${String(cause)}`,
            }),
        ),
      );

    const get = Effect.fn("SkillService.get")(function* (
      name: string,
      version?: number,
    ) {
      const rows = yield* withStorage(
        version === undefined
          ? sql<SkillRow>`
              SELECT ${sql.literal(SKILL_COLUMNS)} FROM skills s
              WHERE s.name = ${name}
              ORDER BY s.version DESC
              LIMIT 1
            `
          : sql<SkillRow>`
              SELECT ${sql.literal(SKILL_COLUMNS)} FROM skills s
              WHERE s.name = ${name} AND s.version = ${version}
            `,
      );
      const row = rows[0];
      if (row === undefined) {
        return yield* version === undefined
          ? new SkillNotFound({ name, message: `no skill named "${name}"` })
          : new SkillNotFound({
              name,
              version,
              message: `skill "${name}" has no version ${version}`,
            });
      }
      return yield* toSkill(row);
    });

    const list: Effect.Effect<
      ReadonlyArray<SkillRecord>,
      SkillStorageError
    > = Effect.gen(function* () {
      // `DISTINCT ON` keeps the first row of each name in the `ORDER BY`, which is its newest.
      const rows = yield* withStorage(
        sql<SkillRow>`
          SELECT DISTINCT ON (s.name) ${sql.literal(SKILL_COLUMNS)} FROM skills s
          ORDER BY s.name, s.version DESC
        `,
      );
      return yield* Effect.forEach(rows, toSkill);
    });

    const versions = Effect.fn("SkillService.versions")(function* (
      name: string,
    ) {
      const rows = yield* withStorage(
        sql<{
          readonly name: string;
          readonly version: number;
          readonly description: string;
          readonly createdAt: Date | string;
          readonly author: string;
        }>`
          SELECT s.name, s.version, s.description, s.created_at, s.author FROM skills s
          WHERE s.name = ${name}
          ORDER BY s.version DESC
        `,
      );
      if (rows.length === 0) {
        return yield* new SkillNotFound({
          name,
          message: `no skill named "${name}"`,
        });
      }
      return yield* decodeVersions(
        rows.map((row) => ({ ...row, createdAt: iso(row.createdAt) })),
      ).pipe(
        Effect.mapError(
          (cause) =>
            new SkillStorageError({
              message: `the skills table holds an invalid version of ${name}: ${String(cause)}`,
            }),
        ),
      );
    });

    const put = Effect.fn("SkillService.put")(function* (input: PutSkillInput) {
      if (input.body.trim().length === 0) {
        return yield* new InvalidSkill({
          name: input.name,
          message: `skill "${input.name}" has an empty body: a run would be told nothing`,
        });
      }
      const attachments = yield* encodeAttachments(
        input.attachments ?? [],
      ).pipe(
        Effect.mapError(
          (cause) =>
            new SkillStorageError({
              message: `the attachments of skill "${input.name}" do not encode: ${String(cause)}`,
            }),
        ),
      );
      // One statement computes `newest + 1` and inserts it. Two puts of one name at once can compute
      // the same number: the second meets the primary key, inserts nothing (`DO NOTHING`), and asks
      // again — after the first committed, so it reads the first's version as the newest.
      for (let attempt = 1; attempt <= PUT_ATTEMPTS; attempt += 1) {
        const inserted = yield* withStorage(
          sql<{ version: number }>`
            INSERT INTO skills (name, version, description, body, attachments, author)
            SELECT
              ${input.name},
              COALESCE((SELECT max(version) FROM skills WHERE name = ${input.name}), 0) + 1,
              ${input.description},
              ${input.body},
              ${attachments}::jsonb,
              ${input.actor ?? ""}
            ON CONFLICT (name, version) DO NOTHING
            RETURNING version
          `,
        );
        const written = inserted[0];
        if (written !== undefined) {
          return yield* get(input.name, written.version).pipe(
            Effect.catchTag("SkillNotFound", (missing) =>
              Effect.fail(
                new SkillStorageError({
                  message: `the version just put is gone: ${missing.message}`,
                }),
              ),
            ),
          );
        }
      }
      return yield* new SkillStorageError({
        message: `skill "${input.name}": ${PUT_ATTEMPTS} concurrent puts took every version this put computed; try again`,
      });
    });

    return SkillService.of({ get, list, versions, put });
  }),
);
