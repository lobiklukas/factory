/**
 * Skills: read and write the named, versioned skill documents in the `skills` table (LOB-173,
 * part 2 of LOB-48).
 *
 * A skill mirrors its on-disk shape, `.pi/skills/<name>/SKILL.md`: a name, a version, a one-line
 * description, the markdown body, and the attachments it links. `name` is the primary key, so a
 * write is an upsert — writing an existing name replaces the document in place, and writing a new
 * one adds it.
 *
 * The rows come from `0009_create_skills.ts`, which seeds the three stage skills (`specify`,
 * `implement`, `review`), and `0015_seed_docs_skill.ts`, which seeds the `docs` prompt a
 * documentation run holds (LOB-225). Postgres only: the tests run against the real schema, not a
 * mock.
 *
 * `attachments` is a jsonb column but is read and written as JSON text, encoded and decoded by a
 * Schema codec, so a stored value always round-trips through `readonly string[]` rather than
 * whatever the driver chose to do with the column.
 */
import { Context, Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import {
  Skill,
  SkillNotFound,
  SkillStorageError,
  type SkillError,
} from "@repo/domain/Skill";

export type SkillServiceShape = {
  /** One skill by name, or a `SkillNotFound` naming it. */
  readonly get: (
    name: string,
  ) => Effect.Effect<Skill, SkillNotFound | SkillStorageError>;
  /** Every skill, ordered by name. An Effect value: each run reads the table again. */
  readonly list: Effect.Effect<ReadonlyArray<Skill>, SkillStorageError>;
  /** Writes a skill, replacing the document of the same name. Adds it when it is new. */
  readonly upsert: (skill: Skill) => Effect.Effect<void, SkillStorageError>;
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
  readonly version: string;
  readonly description: string;
  readonly body: string;
  readonly attachments: string;
};

/**
 * The column list, with `attachments` cast to text. Spelled out once so every read returns the
 * same shape.
 */
const SKILL_COLUMNS = [
  "name",
  "version",
  "description",
  "body",
  "attachments::text AS attachments",
].join(", ");

export const SkillServiceLive = Layer.effect(
  SkillService,
  Effect.gen(function* () {
    const sql = yield* SqlClient;

    const decodeAttachments = Schema.decodeUnknownEffect(AttachmentsJson);
    const encodeAttachments = Schema.encodeEffect(AttachmentsJson);
    const decodeSkill = Schema.decodeUnknownEffect(Skill);

    /** Turns a driver failure into a storage failure and leaves the typed refusals alone. */
    const withStorage = <A, E extends SkillError>(
      effect: Effect.Effect<A, E | SqlError>,
    ): Effect.Effect<A, E | SkillStorageError> =>
      effect.pipe(
        Effect.catchTag("SqlError", (cause) =>
          Effect.fail(new SkillStorageError({ message: cause.message })),
        ),
      );

    const toSkill = (row: SkillRow): Effect.Effect<Skill, SkillStorageError> =>
      Effect.gen(function* () {
        const attachments = yield* decodeAttachments(row.attachments);
        return yield* decodeSkill({
          name: row.name,
          version: row.version,
          description: row.description,
          body: row.body,
          attachments,
        });
      }).pipe(
        Effect.mapError(
          (cause) =>
            new SkillStorageError({
              message: `the skills table holds an invalid row ${row.name}: ${String(cause)}`,
            }),
        ),
      );

    const get = (
      name: string,
    ): Effect.Effect<Skill, SkillNotFound | SkillStorageError> =>
      withStorage(
        Effect.gen(function* () {
          const rows = yield* sql<SkillRow>`
            SELECT ${sql.literal(SKILL_COLUMNS)} FROM skills WHERE name = ${name}
          `;
          const row = rows[0];
          if (row === undefined) {
            return yield* new SkillNotFound({
              name,
              message: `no skill named "${name}"`,
            });
          }
          return yield* toSkill(row);
        }),
      );

    const list: Effect.Effect<
      ReadonlyArray<Skill>,
      SkillStorageError
    > = withStorage(
      Effect.gen(function* () {
        const rows = yield* sql<SkillRow>`
            SELECT ${sql.literal(SKILL_COLUMNS)} FROM skills ORDER BY name
          `;
        return yield* Effect.forEach(rows, toSkill);
      }),
    );

    const upsert = (skill: Skill): Effect.Effect<void, SkillStorageError> =>
      withStorage(
        Effect.gen(function* () {
          const attachments = yield* encodeAttachments(skill.attachments).pipe(
            Effect.mapError(
              (cause) =>
                new SkillStorageError({
                  message: `the attachments of skill "${skill.name}" do not encode: ${String(cause)}`,
                }),
            ),
          );
          yield* sql`
            INSERT INTO skills (name, version, description, body, attachments)
            VALUES (
              ${skill.name}, ${skill.version}, ${skill.description},
              ${skill.body}, ${attachments}::jsonb
            )
            ON CONFLICT (name) DO UPDATE SET
              version = EXCLUDED.version,
              description = EXCLUDED.description,
              body = EXCLUDED.body,
              attachments = EXCLUDED.attachments
          `;
        }),
      );

    return SkillService.of({ get, list, upsert });
  }),
);
