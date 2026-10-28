/**
 * The planning stage's artifact (D10): a typed plan a person can approve.
 *
 * B4's `planning` column exits on "a plan doc and a human move": the human move is B5's plan
 * approval gate, and this is what the person approves. Before it, a planning run could say what it
 * meant to do only in prose, and the person crossing the gate approved nothing they could see. The
 * plan names three things, each required, because each is what the approval is *of*:
 *
 * - `steps`: what the building run will do, in order. At least one: a plan with no step plans
 *   nothing, and is what an unwritten document holds (`PlanDoc`'s seed).
 * - `surfaces`: the parts of the repository the change touches (`apps/web`, `packages/core`, the
 *   `verify-<surface>` names). At least one: a change touches something, and the surfaces are what
 *   the building column's `verified` requirement will hold it to.
 * - `risks`: what could go wrong. **Required, `[]` when there are none**, for `gaps`' reason
 *   (`./spec`): a plan that says nothing about risk is a planner that never looked, and `[]` is the
 *   only way to say "none".
 *
 * Every list item must say something. `summary` is the plan in one statement.
 *
 * This module is the validator and nothing else — the shape, the refusal, and the decode. The tool
 * that commits it is `./planning`, and the stored token is `PlanDoc` in `./docs`. Nothing here
 * touches Pi Durable, so the decode can be called on a model's tool arguments or a stored document.
 */
import { Effect, Option, Schema } from "effect";
import { decodeFaults, type DecodeFault } from "./spec";

/**
 * A list with at least one entry. A check on the array rather than a non-empty tuple, so an empty
 * list is refused as the field itself (`steps` is invalid), not as a missing first item (`steps.0`).
 */
const AtLeastOne = Schema.Array(Schema.NonEmptyString).check(
  Schema.isMinLength(1, { message: "at least one entry is required" }),
);

/** A plan, as the planner declares it (module doc). */
export const Plan = Schema.Struct({
  summary: Schema.NonEmptyString,
  steps: AtLeastOne,
  surfaces: AtLeastOne,
  risks: Schema.Array(Schema.NonEmptyString),
});
export interface Plan extends Schema.Schema.Type<typeof Plan> {}

/**
 * A value the plan validator refused, naming the field it refused it for — `SpecRefused`'s shape:
 * `missing` is a field the value does not have, `invalid` one it has with the wrong shape (`steps:
 * []`, `risks: [""]`). `fields` names every fault, so a retry does not discover them one at a time;
 * the headline is an absent `risks` when there is one — the fault the stage exists to refuse — and
 * otherwise the first in field order.
 */
export class PlanRefused extends Schema.TaggedError<PlanRefused>()(
  "PlanRefused",
  {
    field: Schema.String,
    reason: Schema.Literals(["missing", "invalid"]),
    fields: Schema.Array(Schema.String),
    message: Schema.String,
  },
) {}

const isRisksMissing = (fault: DecodeFault): boolean =>
  fault.missing && fault.field === "risks";

const refusal = (error: Schema.SchemaError): PlanRefused => {
  const all = decodeFaults(error.issue, [], "plan");
  const fields = [...new Set(all.map((fault) => fault.field))];
  const headline = all.find(isRisksMissing) ??
    all[0] ?? { field: "plan", missing: false };
  const others = fields.filter((field) => field !== headline.field);
  const also =
    others.length === 0
      ? ""
      : ` (also refused: ${others.map((field) => `\`${field}\``).join(", ")})`;
  const field = headline.field;
  return headline.missing
    ? new PlanRefused({
        field,
        reason: "missing",
        fields,
        message:
          (field === "risks"
            ? "plan refused: `risks` is missing — declare the risks, `[]` when there are none"
            : `plan refused: \`${field}\` is missing`) + also,
      })
    : new PlanRefused({
        field,
        reason: "invalid",
        fields,
        message: `plan refused: \`${field}\` is invalid${also} — ${error.message}`,
      });
};

const decodeUnknown = Schema.decodeUnknownEffect(Plan);
const ALL_ERRORS = { errors: "all" } as const;

/**
 * Validate an untrusted value as a plan: a `Plan` when it is one, a `PlanRefused` naming the field
 * when it is not. The only way into `PlanDoc` goes through here (`./planning`'s tool).
 */
export const decodePlan = (input: unknown): Effect.Effect<Plan, PlanRefused> =>
  decodeUnknown(input, ALL_ERRORS).pipe(Effect.mapError(refusal));

/**
 * A stored document read as a plan, or `undefined` when it is not one: `PlanDoc`'s seed (no steps)
 * reads as no plan rather than as one the stage would have refused.
 */
export const projectPlan = (value: unknown): Plan | undefined =>
  Option.getOrUndefined(Schema.decodeUnknownOption(Plan)(value));
