/**
 * Declared rulesets against live ones (LOB-30): the diff, the plan, the apply, and the read-back.
 *
 * `planRulesets` reads every ruleset the repository has and pairs each declared one with the live
 * ruleset of the same name: absent is `create`, different is `update` (with the differences
 * named), equal is `keep`, and a live ruleset under `RULESET_PREFIX` that the policy no longer
 * declares is `delete`. `applyPlan` performs exactly the plan's writes. `verifyRulesets` is the
 * read-back: the same plan, which must contain nothing but `keep` — a deleted ruleset, a rule
 * switched off, an actor added to the bypass list, or enforcement moved to `evaluate` each
 * surfaces as a change that would have to be made, and fails it.
 *
 * Equality is what the policy declares, not every byte GitHub answers: GitHub fills in rule
 * parameters it has defaults for (`allowed_merge_methods`, `required_reviewers`, …), so a rule's
 * parameters are compared on the keys the policy sets. The rule *types* are compared as sets in
 * both directions, and so are the ref patterns: an extra rule is drift too, since the code is the
 * record of what is there. Bypass is compared strictly. A ruleset read without `bypass_actors` —
 * a token that may not see them — is drift rather than a pass, because "nobody can bypass" is the
 * claim, and an unread list does not prove it.
 */
import { Effect } from "effect";
import type { LiveRuleset, RulesetsApiError, RulesetsClient } from "./github";
import { type DeclaredRuleset, RULESET_PREFIX } from "./policy";

export type RulesetChange =
  | { readonly action: "create"; readonly name: string }
  | {
      readonly action: "update";
      readonly name: string;
      readonly id: number;
      /** What differs, one line each. */
      readonly drift: ReadonlyArray<string>;
    }
  | { readonly action: "keep"; readonly name: string; readonly id: number }
  | { readonly action: "delete"; readonly name: string; readonly id: number };

export type RulesetPlan = {
  readonly repo: string;
  readonly changes: ReadonlyArray<RulesetChange>;
};

const sorted = (values: ReadonlyArray<string> | undefined) =>
  [...(values ?? [])].sort();

const sameSet = (
  a: ReadonlyArray<string> | undefined,
  b: ReadonlyArray<string> | undefined,
) => {
  const left = sorted(a);
  const right = sorted(b);
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
};

/** A rule parameter as a line shows it: GitHub's are scalars; anything else is named, not dumped. */
const scalar = (value: unknown): string =>
  value === undefined
    ? "unset"
    : typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean"
      ? String(value)
      : "a non-scalar value";

const show = (values: ReadonlyArray<string> | undefined) =>
  `[${sorted(values).join(", ")}]`;

/**
 * What differs between a declared ruleset and the live one of the same name, one line per
 * difference. Empty means the live ruleset is what the code says.
 */
export const diffRuleset = (
  declared: DeclaredRuleset,
  live: LiveRuleset,
): ReadonlyArray<string> => {
  const drift: Array<string> = [];
  if (live.enforcement !== declared.enforcement)
    drift.push(
      `enforcement is ${live.enforcement}, declared ${declared.enforcement}`,
    );
  const target = live.target ?? "branch";
  if (target !== declared.target)
    drift.push(`target is ${target}, declared ${declared.target}`);

  const refName = live.conditions?.ref_name;
  const { include, exclude } = declared.conditions.ref_name;
  if (!sameSet(refName?.include, include))
    drift.push(`includes ${show(refName?.include)}, declared ${show(include)}`);
  if (!sameSet(refName?.exclude, exclude))
    drift.push(`excludes ${show(refName?.exclude)}, declared ${show(exclude)}`);

  if (live.bypass_actors === undefined)
    drift.push(
      "bypass_actors was not answered (the token cannot read it), so no bypass is proven absent",
    );
  else
    for (const actor of live.bypass_actors)
      drift.push(
        `bypass actor ${actor.actor_type}${actor.actor_id === undefined || actor.actor_id === null ? "" : ` ${actor.actor_id}`} (${actor.bypass_mode ?? "always"}), declared none`,
      );
  if (
    live.current_user_can_bypass !== undefined &&
    live.current_user_can_bypass !== "never"
  )
    drift.push(
      `the reading token can bypass it (${live.current_user_can_bypass}), declared nobody`,
    );

  const liveRules = live.rules ?? [];
  const liveTypes = liveRules.map((rule) => rule.type);
  for (const rule of declared.rules) {
    const found = liveRules.find((candidate) => candidate.type === rule.type);
    if (found === undefined) {
      drift.push(`rule ${rule.type} is missing`);
      continue;
    }
    for (const [key, value] of Object.entries(rule.parameters ?? {})) {
      const actual = found.parameters?.[key];
      if (actual !== value)
        drift.push(
          `rule ${rule.type}: ${key} is ${scalar(actual)}, declared ${String(value)}`,
        );
    }
  }
  for (const type of liveTypes)
    if (!declared.rules.some((rule) => rule.type === type))
      drift.push(`rule ${type} is not declared`);
  return drift;
};

/** Read the repository's rulesets and pair them with the policy. */
export const planRulesets = (
  client: RulesetsClient,
  repo: string,
  policy: ReadonlyArray<DeclaredRuleset>,
): Effect.Effect<RulesetPlan, RulesetsApiError> =>
  Effect.gen(function* () {
    const summaries = yield* client.list(repo);
    // A ruleset an organization defines is listed with the repo's when parents are included; the
    // list asks for the repo's own, and the source check keeps a fake or an older API honest.
    const own = summaries.filter(
      (summary) =>
        summary.source_type === undefined ||
        summary.source_type === "Repository",
    );
    const changes: Array<RulesetChange> = [];
    for (const declared of policy) {
      const summary = own.find((candidate) => candidate.name === declared.name);
      if (summary === undefined) {
        changes.push({ action: "create", name: declared.name });
        continue;
      }
      const live = yield* client.get(repo, summary.id);
      const drift = diffRuleset(declared, live);
      changes.push(
        drift.length === 0
          ? { action: "keep", name: declared.name, id: summary.id }
          : { action: "update", name: declared.name, id: summary.id, drift },
      );
    }
    for (const summary of own)
      if (
        summary.name.startsWith(RULESET_PREFIX) &&
        !policy.some((declared) => declared.name === summary.name)
      )
        changes.push({ action: "delete", name: summary.name, id: summary.id });
    return { repo, changes };
  });

/** What one write of an apply did. */
export type AppliedChange = {
  readonly action: "created" | "updated" | "deleted";
  readonly name: string;
  readonly id: number;
};

/** Make the plan's writes, in its order. `keep` writes nothing. */
export const applyPlan = (
  client: RulesetsClient,
  plan: RulesetPlan,
  policy: ReadonlyArray<DeclaredRuleset>,
): Effect.Effect<ReadonlyArray<AppliedChange>, RulesetsApiError> =>
  Effect.gen(function* () {
    const applied: Array<AppliedChange> = [];
    const declaredNamed = (name: string) =>
      policy.find((declared) => declared.name === name);
    for (const change of plan.changes) {
      if (change.action === "keep") continue;
      if (change.action === "delete") {
        yield* client.remove(plan.repo, change.id);
        applied.push({ action: "deleted", name: change.name, id: change.id });
        continue;
      }
      const declared = declaredNamed(change.name);
      if (declared === undefined) continue;
      const written =
        change.action === "create"
          ? yield* client.create(plan.repo, declared)
          : yield* client.update(plan.repo, change.id, declared);
      applied.push({
        action: change.action === "create" ? "created" : "updated",
        name: change.name,
        id: written.id,
      });
    }
    return applied;
  });

/** The read-back's verdict: `ok` only when the live rulesets are the declared ones. */
export type RulesetVerification = {
  readonly repo: string;
  readonly ok: boolean;
  /** One line per finding: `missing`, `drift` or `undeclared`. Empty when `ok`. */
  readonly findings: ReadonlyArray<string>;
  readonly plan: RulesetPlan;
};

/** Read the live rulesets back and say whether they are what the policy declares. */
export const verifyRulesets = (
  client: RulesetsClient,
  repo: string,
  policy: ReadonlyArray<DeclaredRuleset>,
): Effect.Effect<RulesetVerification, RulesetsApiError> =>
  planRulesets(client, repo, policy).pipe(
    Effect.map((plan) => {
      const findings = plan.changes.flatMap((change): ReadonlyArray<string> => {
        switch (change.action) {
          case "keep":
            return [];
          case "create":
            return [
              `missing: "${change.name}" is not on ${repo} (deleted, or never applied)`,
            ];
          case "update":
            return change.drift.map(
              (line) => `drift: "${change.name}": ${line}`,
            );
          case "delete":
            return [
              `undeclared: "${change.name}" (id ${change.id}) carries the factory prefix but is not in the policy`,
            ];
        }
      });
      return { repo, ok: findings.length === 0, findings, plan };
    }),
  );
