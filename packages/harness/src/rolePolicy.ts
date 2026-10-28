/**
 * What a column's role may do (docs/board.md B6; D10): one declarative table, keyed by role.
 *
 * B6 says a role resolves to its model and its tool policy in one place. The model half is the
 * deployment's `ROLE_MODELS` (`./loader`'s `RoleModels`); this is the tool-policy half. It replaces
 * the per-feature sets that grew one per stage — `READ_ONLY_ROLES` (LOB-74), `SPEC_ROLES` (LOB-238)
 * — so a role that only reads and writes a plan is one row, not an entry in two sets that a third
 * feature would have to remember to add a third to.
 *
 * - `readOnly` makes the role's runs a read-only stage (`./policy`'s `readOnlyStageOf`): they are
 *   not offered `write`, `edit` or `verify`, and their `bash` may only read. `stage` names the stage
 *   in the refusal's sentence; a row with none is named after the run's column.
 * - `writesSpec` offers the `spec` tool (`./specify`), `writesPlan` the `plan` tool (`./planning`).
 *   Each also needs a card to post on, so a scratch session is never offered either.
 *
 * **A deployment extends it, never rewrites it** (`ROLE_POLICIES`, `parseRolePolicies`): it may add
 * rows for roles of its own boards, and a row for a role the default table already holds is refused.
 * The built-in rows are what the default pipeline's exits are checked against (`spec_doc`,
 * `plan_doc`), so a deployment that made the planner write would hold a card to a plan from a run
 * that may also have changed the code the plan was about.
 *
 * Maps rather than object literals, because a role is free text in a board definition and
 * `constructor` must not find `Object.prototype`'s.
 */
import { Effect, Schema } from "effect";

/** One role's tool policy. Every field absent is a role that writes and is offered no stage tool. */
export type RolePolicy = {
  /** The role's runs only read (LOB-74). */
  readonly readOnly?: boolean;
  /** The read-only stage's name in a refusal; absent is the run's column. */
  readonly stage?: string;
  /** The role's runs are offered the `spec` tool (LOB-238). */
  readonly writesSpec?: boolean;
  /** The role's runs are offered the `plan` tool (D10). */
  readonly writesPlan?: boolean;
};

/** Role → its policy. A role with no row writes, and is offered no stage tool. */
export type RolePolicies = ReadonlyMap<string, RolePolicy>;

/**
 * The factory's own rows (B4): the specifier only reads and declares the spec, the planner only
 * reads and declares the plan. The builder and the reviewer have no row: a builder writes, and a
 * review run is read-only because it is a review (`RunProfile.reviewing`), whatever its role.
 */
export const DEFAULT_ROLE_POLICIES: RolePolicies = new Map<string, RolePolicy>(
  [
    ["specifier", { readOnly: true, stage: "specifying", writesSpec: true }],
    ["planner", { readOnly: true, stage: "planning", writesPlan: true }],
  ],
);

/** The policy `role` has under `policies`, or `undefined` when it has no row (or there is no role). */
export const rolePolicyOf = (
  role: string | undefined,
  policies: RolePolicies = DEFAULT_ROLE_POLICIES,
): RolePolicy | undefined =>
  role === undefined ? undefined : policies.get(role);

/** The roles in `policies` whose row says `flag`, in table order. */
export const rolesWhere = (
  policies: RolePolicies,
  flag: "readOnly" | "writesSpec" | "writesPlan",
): readonly string[] =>
  [...policies].flatMap(([role, policy]) =>
    policy[flag] === true ? [role] : [],
  );

/** The deployment's role policy table is malformed, or redefines a role the factory defines. */
export class InvalidRolePolicies extends Schema.TaggedError<InvalidRolePolicies>()(
  "InvalidRolePolicies",
  { message: Schema.String },
) {}

/** A flag as a deployment writes it in `ROLE_POLICIES`, and the field it sets. */
const FLAGS: ReadonlyMap<string, "readOnly" | "writesSpec" | "writesPlan"> =
  new Map([
    ["read-only", "readOnly"],
    ["spec", "writesSpec"],
    ["plan", "writesPlan"],
  ]);

/**
 * Read the deployment's extra rows as it writes them (`ROLE_POLICIES`): a comma-separated list of
 * `role=flag+flag`, in the shape `ROLE_MODELS` uses, where a flag is `read-only`, `spec` or `plan`
 * (`auditor=read-only`, `architect=read-only+plan`). Blank entries are skipped, so an empty value is
 * no extra rows. A row with no `=`, an empty side, an unknown flag, a role named twice, or a role
 * the default table holds is refused rather than guessed at.
 */
export const parseRolePolicies = (
  text: string,
): Effect.Effect<RolePolicies, InvalidRolePolicies> =>
  Effect.gen(function* () {
    const table = new Map<string, RolePolicy>();
    for (const raw of text.split(",")) {
      const entry = raw.trim();
      if (entry.length === 0) continue;
      const equals = entry.indexOf("=");
      const role = equals < 0 ? "" : entry.slice(0, equals).trim();
      const flags = equals < 0 ? "" : entry.slice(equals + 1).trim();
      if (role.length === 0 || flags.length === 0) {
        return yield* new InvalidRolePolicies({
          message: `role policy "${entry}" is not role=flag[+flag] (flags: ${[...FLAGS.keys()].join(", ")})`,
        });
      }
      if (table.has(role)) {
        return yield* new InvalidRolePolicies({
          message: `role ${role} is given a policy twice`,
        });
      }
      if (DEFAULT_ROLE_POLICIES.has(role)) {
        return yield* new InvalidRolePolicies({
          message: `role ${role} is the factory's own (its policy is built in); name a role of your own`,
        });
      }
      const policy: {
        readOnly?: boolean;
        writesSpec?: boolean;
        writesPlan?: boolean;
      } = {};
      for (const flag of flags.split("+").map((part) => part.trim())) {
        const field = FLAGS.get(flag);
        if (field === undefined) {
          return yield* new InvalidRolePolicies({
            message: `role ${role}: "${flag}" is not a role flag (flags: ${[...FLAGS.keys()].join(", ")})`,
          });
        }
        policy[field] = true;
      }
      table.set(role, policy);
    }
    return table;
  });

/**
 * The default table with a deployment's rows added (`parseRolePolicies` already refused a row that
 * redefines a default one; one that slipped past is dropped here, so the default always holds).
 */
export const extendRolePolicies = (
  extra: RolePolicies,
  base: RolePolicies = DEFAULT_ROLE_POLICIES,
): RolePolicies =>
  extra.size === 0
    ? base
    : new Map([
        ...base,
        ...[...extra].filter(([role]) => !base.has(role)),
      ]);
