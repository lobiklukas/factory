import { Schema } from "effect";

/**
 * A factory skill: a named, versioned skill document mirroring the on-disk
 * `.pi/skills/<name>/SKILL.md` shape (LOB-173, part 2 of LOB-48).
 */
export const Skill = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
  description: Schema.String,
  body: Schema.String,
  attachments: Schema.Array(Schema.String),
});
export type Skill = typeof Skill.Type;

export class SkillNotFound extends Schema.TaggedError<SkillNotFound>()(
  "SkillNotFound",
  { name: Schema.String, message: Schema.String },
) {}

export class SkillStorageError extends Schema.TaggedError<SkillStorageError>()(
  "SkillStorageError",
  { message: Schema.String },
) {}

export type SkillError = SkillNotFound | SkillStorageError;
