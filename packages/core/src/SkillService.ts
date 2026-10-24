import { Context, Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { Skill, SkillNotFound, SkillStorageError } from "@repo/domain/Skill";

export type SkillServiceShape = {
  readonly get: (
    name: string,
  ) => Effect.Effect<Skill, SkillNotFound | SkillStorageError>;
  readonly getSkill: (
    name: string,
  ) => Effect.Effect<Skill, SkillNotFound | SkillStorageError>;
  readonly list: () => Effect.Effect<readonly Skill[], SkillStorageError>;
  readonly listSkills: () => Effect.Effect<readonly Skill[], SkillStorageError>;
  readonly upsert: (skill: Skill) => Effect.Effect<void, SkillStorageError>;
  readonly upsertSkill: (
    skill: Skill,
  ) => Effect.Effect<void, SkillStorageError>;
  readonly save: (skill: Skill) => Effect.Effect<void, SkillStorageError>;
  readonly saveSkill: (skill: Skill) => Effect.Effect<void, SkillStorageError>;
  readonly write: (skill: Skill) => Effect.Effect<void, SkillStorageError>;
};

export class SkillService extends Context.Service<
  SkillService,
  SkillServiceShape
>()("@repo/core/SkillService") {}

const rowToSkill = (row: any): Skill => ({
  name: row.name,
  version: row.version,
  description: row.description,
  body: row.body,
  attachments: Array.isArray(row.attachments) ? row.attachments : [],
});

export const SkillServiceLive = Layer.effect(
  SkillService,
  Effect.gen(function* () {
    const sql = yield* SqlClient;

    const get = (name: string) =>
      Effect.gen(function* () {
        const rows =
          yield* sql`SELECT name, version, description, body, attachments FROM skills WHERE name = ${name}`.pipe(
            Effect.mapError(
              (e) => new SkillStorageError({ message: String(e) }),
            ),
          );
        if (rows.length === 0) {
          return yield* Effect.fail(
            new SkillNotFound({ name, message: `skill not found: ${name}` }),
          );
        }
        return rowToSkill(rows[0]);
      });

    const list = () =>
      Effect.gen(function* () {
        const rows =
          yield* sql`SELECT name, version, description, body, attachments FROM skills ORDER BY name`.pipe(
            Effect.mapError(
              (e) => new SkillStorageError({ message: String(e) }),
            ),
          );
        return rows.map(rowToSkill);
      });

    const upsert = (skill: Skill) =>
      Effect.gen(function* () {
        yield* sql`
          INSERT INTO skills (name, version, description, body, attachments)
          VALUES (${skill.name}, ${skill.version}, ${skill.description}, ${skill.body}, ${JSON.stringify(skill.attachments)}::jsonb)
          ON CONFLICT (name) DO UPDATE SET
            version = EXCLUDED.version,
            description = EXCLUDED.description,
            body = EXCLUDED.body,
            attachments = EXCLUDED.attachments
        `.pipe(
          Effect.mapError((e) => new SkillStorageError({ message: String(e) })),
        );
      });

    return {
      get,
      getSkill: get,
      list,
      listSkills: list,
      upsert,
      upsertSkill: upsert,
      save: upsert,
      saveSkill: upsert,
      write: upsert,
    };
  }),
);
