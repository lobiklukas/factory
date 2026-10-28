import { Schema } from "effect";
import { Timestamp } from "@repo/domain/Ids";
import { SessionActor } from "@repo/domain/Session";

/**
 * A factory skill: a named, versioned skill document mirroring the on-disk
 * `.pi/skills/<name>/SKILL.md` shape (LOB-173, part 2 of LOB-48).
 *
 * **One row per edit.** A skill is keyed by `(name, version)`: a put adds version `newest + 1` and
 * never rewrites a row (`0037_version_skills.ts`), so a run that opened on version 2 is reopened on
 * version 2 after an operator put version 3 — docs/board.md B2's "in-flight runs keep the version
 * they opened with". The run's own log records which version it was given (`@repo/harness`'s
 * `factory.skills` document).
 */
export const SkillVersion = Schema.Int.pipe(
  Schema.check(Schema.isGreaterThan(0)),
);
export type SkillVersion = typeof SkillVersion.Type;

export const Skill = Schema.Struct({
  name: Schema.String,
  version: SkillVersion,
  description: Schema.String,
  body: Schema.String,
  attachments: Schema.Array(Schema.String),
});
export type Skill = typeof Skill.Type;

/**
 * The name a skill may be put under: lowercase words joined by `-` or `_`, as every shipped skill is
 * named (`specify`, `plan-freshness`). Checked on a write only — a read names whatever the table
 * holds. The shape is what keeps two names from folding into one prompt section (`@repo/harness`'s
 * `skillSectionKey` lowercases a name and replaces anything else), so `Specify` cannot be put beside
 * `specify` and silently share its section.
 */
export const SkillName = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[a-z][a-z0-9_-]*$/)),
  Schema.check(Schema.isMaxLength(64)),
);
export type SkillName = typeof SkillName.Type;

/** One stored version, with who put it and when, and the newest the skill holds: `getSkill`'s answer. */
export const SkillRecord = Schema.Struct({
  ...Skill.fields,
  /** When the version was put; a version that existed before `0037` carries the time it ran. */
  createdAt: Timestamp,
  /** The control-plane actor that put it (LOB-20); empty for a seed or an unattributed put. */
  author: Schema.String,
  /** The newest version the skill holds, so a reader of an old version can see that it is old. */
  newest: SkillVersion,
});
export type SkillRecord = typeof SkillRecord.Type;

/**
 * One skill as `factory skill ls` lists it: its newest version, and the columns of the default
 * definition's newest version that name it — which runs a put reaches.
 */
export const SkillSummary = Schema.Struct({
  name: Schema.String,
  version: SkillVersion,
  description: Schema.String,
  createdAt: Timestamp,
  /** The default definition's columns that bind the skill, in column order; empty for none. */
  columns: Schema.Array(Schema.String),
});
export type SkillSummary = typeof SkillSummary.Type;

/**
 * One version of a skill as its history lists it (D8): who put it, when, and what it described
 * itself as — everything `SkillRecord` holds except the body, so a skill with many versions is one
 * small read. A version's body is `getSkill` with that version.
 */
export const SkillVersionSummary = Schema.Struct({
  name: Schema.String,
  version: SkillVersion,
  description: Schema.String,
  createdAt: Timestamp,
  /** The control-plane actor that put it (LOB-20); empty for a seed or an unattributed put. */
  author: Schema.String,
});
export type SkillVersionSummary = typeof SkillVersionSummary.Type;

export const ListSkillsInput = Schema.Struct({});
export type ListSkillsInput = typeof ListSkillsInput.Type;

/** One skill by name: the version named, or by default the newest. */
export const GetSkillInput = Schema.Struct({
  name: Schema.String,
  version: Schema.optional(SkillVersion),
});
export type GetSkillInput = typeof GetSkillInput.Type;

/** Every version of one skill, newest first: its history. A name the factory lacks is `SkillNotFound`. */
export const ListSkillVersionsInput = Schema.Struct({
  name: Schema.String,
});
export type ListSkillVersionsInput = typeof ListSkillVersionsInput.Type;

/**
 * A new version of a skill: written as `newest + 1`, or as version 1 for a name the factory does not
 * hold yet. The input carries no version and has no way to name one, so a put cannot rewrite a
 * version a run may have opened on.
 */
export const PutSkillInput = Schema.Struct({
  name: SkillName,
  description: Schema.String,
  body: Schema.String,
  attachments: Schema.optional(Schema.Array(Schema.String)),
  /** Set by the control plane from the caller's credential (LOB-20), as a card write's actor is. */
  actor: Schema.optional(SessionActor),
});
export type PutSkillInput = typeof PutSkillInput.Type;

export class SkillNotFound extends Schema.TaggedError<SkillNotFound>()(
  "SkillNotFound",
  {
    name: Schema.String,
    version: Schema.optional(SkillVersion),
    message: Schema.String,
  },
) {}

/** A put refused before anything is written: a body with nothing in it. */
export class InvalidSkill extends Schema.TaggedError<InvalidSkill>()(
  "InvalidSkill",
  { name: Schema.String, message: Schema.String },
) {}

export class SkillStorageError extends Schema.TaggedError<SkillStorageError>()(
  "SkillStorageError",
  { message: Schema.String },
) {}

export type SkillError = SkillNotFound | InvalidSkill | SkillStorageError;

/** Every refusal the skills RPC group answers, on the wire. */
export const SkillErrorSchema = Schema.Union([
  SkillNotFound,
  InvalidSkill,
  SkillStorageError,
]);
