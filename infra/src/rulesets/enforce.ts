/**
 * What GitHub does with a ref update under a set of rulesets, as far as the factory's rules go
 * (LOB-30). It is the model the loopback forge (`../testing/githubFake.ts`) enforces pushes with,
 * and what the policy's own cases assert against — so "a force-push to `factory/x` is refused" is a
 * statement about the declared rulesets, not about a hook.
 *
 * Modelled, from GitHub's ruleset documentation: `enforcement: active` binds and `evaluate` /
 * `disabled` do not; `ref_name.include` / `exclude` patterns in fnmatch form (`*` within one path
 * segment, `**` across them), plus `~ALL` and `~DEFAULT_BRANCH`; a bypass actor in `always` or
 * `exempt` mode is skipped; and five rules — `deletion`, `non_fast_forward`, `pull_request` (no push
 * lands on the branch outside a PR merge), `creation`, `update`. Every other rule type is ignored,
 * so a model that refused a push GitHub would refuse for an unmodelled reason is not claimed here.
 * The messages are GitHub's own (`GH013`), so a probe reads a fake rejection the way it reads a
 * real one. The live probe (`probe.ts`) is what checks GitHub itself.
 */

/** How a pushed ref moved: GitHub's distinction, read off the old and new tips. */
export type RefUpdateKind = "create" | "fast-forward" | "force" | "delete";

export type RefUpdate = {
  /** The full ref: `refs/heads/factory/x`. */
  readonly ref: string;
  readonly kind: RefUpdateKind;
};

/** A ruleset as the model needs it: GitHub's JSON shape, the parts that bind. */
export type EnforcedRuleset = {
  readonly name: string;
  readonly target?: string | undefined;
  readonly enforcement: string;
  readonly conditions?:
    | {
        readonly ref_name?:
          | {
              readonly include?: ReadonlyArray<string> | undefined;
              readonly exclude?: ReadonlyArray<string> | undefined;
            }
          | undefined;
      }
    | null
    | undefined;
  readonly rules?: ReadonlyArray<{ readonly type: string }> | undefined;
  readonly bypass_actors?:
    | ReadonlyArray<{
        readonly actor_id?: number | null | undefined;
        readonly actor_type: string;
        readonly bypass_mode?: string | undefined;
      }>
    | undefined;
};

/** Who pushed: GitHub matches it against `bypass_actors`. */
export type Pusher = {
  readonly actorType: string;
  readonly actorId: number;
};

export type RefContext = {
  /** The repository's default branch name, for `~DEFAULT_BRANCH`. */
  readonly defaultBranch: string;
  readonly pusher?: Pusher;
};

export type Violation = {
  readonly ruleset: string;
  readonly rule: string;
  /** GitHub's line for it, as `git push` shows it after `remote: - `. */
  readonly message: string;
};

const escape = (text: string) => text.replace(/[.+^${}()|[\]\\]/g, "\\$&");

/** fnmatch with `FNM_PATHNAME`: `*` and `?` stay inside one segment, `**` crosses them. */
const patternRegExp = (pattern: string): RegExp => {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern.charAt(index);
    if (char === "*" && pattern.charAt(index + 1) === "*") {
      source += ".*";
      index += 1;
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += escape(char);
  }
  return new RegExp(`^${source}$`);
};

/** Whether one `ref_name` pattern names `ref`. */
export const matchesRef = (
  pattern: string,
  ref: string,
  defaultBranch: string,
): boolean => {
  if (pattern === "~ALL") return ref.startsWith("refs/heads/");
  if (pattern === "~DEFAULT_BRANCH")
    return ref === `refs/heads/${defaultBranch}`;
  return patternRegExp(pattern).test(ref);
};

const applies = (
  ruleset: EnforcedRuleset,
  update: RefUpdate,
  context: RefContext,
): boolean => {
  if (ruleset.enforcement !== "active") return false;
  if ((ruleset.target ?? "branch") !== "branch") return false;
  const refName = ruleset.conditions?.ref_name;
  const included = (refName?.include ?? []).some((pattern) =>
    matchesRef(pattern, update.ref, context.defaultBranch),
  );
  const excluded = (refName?.exclude ?? []).some((pattern) =>
    matchesRef(pattern, update.ref, context.defaultBranch),
  );
  if (!included || excluded) return false;
  const pusher = context.pusher;
  if (pusher === undefined) return true;
  return !(ruleset.bypass_actors ?? []).some(
    (actor) =>
      actor.actor_type === pusher.actorType &&
      actor.actor_id === pusher.actorId &&
      (actor.bypass_mode ?? "always") !== "pull_request",
  );
};

const RULE_MESSAGES: Readonly<
  Record<string, { kinds: ReadonlyArray<RefUpdateKind>; message: string }>
> = {
  deletion: { kinds: ["delete"], message: "Cannot delete this branch" },
  non_fast_forward: {
    kinds: ["force"],
    message: "Cannot force-push to this branch",
  },
  pull_request: {
    kinds: ["create", "fast-forward", "force"],
    message: "Changes must be made through a pull request.",
  },
  creation: {
    kinds: ["create"],
    message: "Cannot create ref due to creations being restricted.",
  },
  update: {
    kinds: ["fast-forward", "force"],
    message: "Cannot update this protected ref.",
  },
};

/** Every rule that refuses `update`, across the rulesets that bind it. Empty means it is allowed. */
export const evaluateRefUpdate = (
  rulesets: ReadonlyArray<EnforcedRuleset>,
  update: RefUpdate,
  context: RefContext,
): ReadonlyArray<Violation> =>
  rulesets
    .filter((ruleset) => applies(ruleset, update, context))
    .flatMap((ruleset) =>
      (ruleset.rules ?? []).flatMap((rule) => {
        const effect = RULE_MESSAGES[rule.type];
        return effect !== undefined && effect.kinds.includes(update.kind)
          ? [
              {
                ruleset: ruleset.name,
                rule: rule.type,
                message: effect.message,
              },
            ]
          : [];
      }),
    );

/** The lines GitHub's pre-receive prints for a refused ref (`GH013`), without git's `remote: `. */
export const rejectionLines = (
  repo: string,
  ref: string,
  violations: ReadonlyArray<Violation>,
): ReadonlyArray<string> => [
  `error: GH013: Repository rule violations found for ${ref}.`,
  `Review all repository rules at https://github.com/${repo}/rules?ref=${encodeURIComponent(ref)}`,
  "",
  ...[...new Set(violations.map((violation) => violation.message))].map(
    (message) => `- ${message}`,
  ),
  "",
];
