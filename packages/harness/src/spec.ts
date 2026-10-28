/**
 * The specifying stage's artifact (LOB-72, part 1 of LOB-46): a typed spec whose gaps are declared,
 * not implied.
 *
 * B4's `specifying` column exits on "a `spec` doc, gaps declared (explicitly `[]` when there are
 * none)". The rule is in the second half: a spec that says nothing about gaps is not a spec with no
 * gaps, it is a specifier that never looked — Devin's `megaplan` rule and Hermes's silent fallback are
 * the two sides of that (docs/features.md). So `gaps` has no default anywhere in this module: a value
 * without the field is refused with the field's name, and `gaps: []` is the only way to say "none".
 *
 * This module is the validator and nothing else — the shape, the refusal, and the decode. The commit
 * and the read are in `./session` (`writeSpec`, `readSpec`), beside the other documents a session
 * writes, and the stored token is `SpecDoc` in `./docs`. Nothing here touches Pi Durable, so the
 * decode can be called on a model's tool arguments, a request body, or a raw stored document alike.
 */
import { Effect, Option, Schema, SchemaIssue } from "effect";

/**
 * A spec, as the specifier declares it.
 *
 * - `goal` is what the card is for, in one statement. Empty is refused: it is also what an unwritten
 *   document holds (`SpecDoc`'s seed), so a spec with no goal could not be told from no spec at all.
 * - `acceptance` is the criteria the work is checked against. Empty is allowed — a thin card has
 *   none — and is exactly what a gap then names.
 * - `gaps` is what the card is missing that the specifier could not supply. **Required**, empty when
 *   there are none: absent is refused, which is the point of the stage.
 * - `openQuestions` is what the specifier would ask a person to close those gaps (the ask itself is
 *   LOB-73's). Required for the same reason: `[]` says "nothing to ask", absent says nothing.
 *
 * Every list item must say something: an empty string is a declared gap with no content, which is
 * the undeclared case dressed up as a declared one.
 */
export const Spec = Schema.Struct({
  goal: Schema.NonEmptyString,
  acceptance: Schema.Array(Schema.NonEmptyString),
  gaps: Schema.Array(Schema.NonEmptyString),
  openQuestions: Schema.Array(Schema.NonEmptyString),
});
export interface Spec extends Schema.Schema.Type<typeof Spec> {}

/**
 * A value the spec validator refused, naming the field it refused it for.
 *
 * `reason` keeps the two cases the stage cares about apart: `missing` is a field the value does not
 * have at all (`gaps` absent), `invalid` is a field it has with the wrong shape (`gaps: null`,
 * `gaps: [""]`). `gaps: []` is neither — it decodes. `field` is the dotted path to the fault
 * (`gaps.0` for a bad item), and `spec` itself when the value is not an object at all.
 *
 * A value can be wrong in several places at once, and the caller is told every one in `fields`, so
 * fixing `goal` does not reveal on the retry that `gaps` was missing too. `field` and `reason` are
 * the headline fault: an absent `gaps` when there is one — it is the fault the stage exists to
 * refuse — and otherwise the first in field order.
 */
export class SpecRefused extends Schema.TaggedError<SpecRefused>()(
  "SpecRefused",
  {
    field: Schema.String,
    reason: Schema.Literals(["missing", "invalid"]),
    fields: Schema.Array(Schema.String),
    message: Schema.String,
  },
) {}

/** One field a decode refused: its dotted path, and whether the key was absent altogether. */
export interface DecodeFault {
  readonly field: string;
  readonly missing: boolean;
}

/**
 * Every fault an issue tree names, in field order: the dotted path, and whether the key was absent.
 * `root` names the value itself, for a fault with no path. Shared with the plan's validator
 * (`./plan`), so the two stage documents name a refused field the same way.
 */
export const decodeFaults = (
  issue: SchemaIssue.Issue,
  path: ReadonlyArray<PropertyKey> = [],
  root = "spec",
): ReadonlyArray<DecodeFault> => {
  switch (issue._tag) {
    case "Pointer":
      return decodeFaults(issue.issue, [...path, ...issue.path], root);
    case "Composite":
      return issue.issues.flatMap((inner) => decodeFaults(inner, path, root));
    case "Filter":
    case "Encoding":
      return decodeFaults(issue.issue, path, root);
    default:
      return [
        {
          field: path.length === 0 ? root : path.map(String).join("."),
          missing: issue._tag === "MissingKey",
        },
      ];
  }
};

const isGapsMissing = (fault: DecodeFault): boolean =>
  fault.missing && fault.field === "gaps";

const refusal = (error: Schema.SchemaError): SpecRefused => {
  const all = decodeFaults(error.issue);
  const fields = [...new Set(all.map((fault) => fault.field))];
  const headline = all.find(isGapsMissing) ??
    all[0] ?? { field: "spec", missing: false };
  const others = fields.filter((field) => field !== headline.field);
  const also =
    others.length === 0
      ? ""
      : ` (also refused: ${others.map((field) => `\`${field}\``).join(", ")})`;
  const field = headline.field;
  return headline.missing
    ? new SpecRefused({
        field,
        reason: "missing",
        fields,
        message:
          (field === "gaps"
            ? "spec refused: `gaps` is missing — declare the gaps, `[]` when there are none"
            : `spec refused: \`${field}\` is missing`) + also,
      })
    : new SpecRefused({
        field,
        reason: "invalid",
        fields,
        message: `spec refused: \`${field}\` is invalid${also} — ${error.message}`,
      });
};

// `errors: "all"` so a refusal can name every faulted field, not only the first the decoder met.
const decodeUnknown = Schema.decodeUnknownEffect(Spec);
const ALL_ERRORS = { errors: "all" } as const;

/**
 * Validate an untrusted value as a spec: a `Spec` when it is one, a `SpecRefused` naming the field
 * when it is not. The only way into `SpecDoc` goes through here (`writeSpec`).
 */
export const decodeSpec = (input: unknown): Effect.Effect<Spec, SpecRefused> =>
  decodeUnknown(input, ALL_ERRORS).pipe(Effect.mapError(refusal));

/**
 * A stored document read as a spec, or `undefined` when it is not one.
 *
 * The reader's half of the same rule: `SpecDoc`'s seed (empty `goal`) and any value a writer that
 * bypassed `decodeSpec` could have left are not specs, so they read as none rather than as a spec the
 * stage would have refused.
 */
export const projectSpec = (value: unknown): Spec | undefined =>
  Option.getOrUndefined(Schema.decodeUnknownOption(Spec)(value));
