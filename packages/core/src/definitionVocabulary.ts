/**
 * What an authored definition version may name besides skills (D6): the requirement keys and roles
 * `defineBoard`'s rules (`./boardDefine`) accept, as `getDefinitionVocabulary` answers them, so the
 * dashboard's editor offers a picker of exactly those and a person never types a key or a role the
 * server would refuse.
 *
 * Every list is read from the set the rules check against — `KNOWN_REQUIREMENTS`, the checked and
 * human-gate subsets, `HARNESS_ROLES` — so a key a later change teaches the factory reaches the
 * picker with it. A key's description is only where a column that picks it starts: the seeded
 * pipeline's wording for its keys, and the key itself for one this table does not word.
 *
 * Pure: the role table and the roles held definitions declare are the caller's.
 */
import type { DefinitionVocabulary } from "@repo/domain/Task";
import { HARNESS_ROLES } from "./boardDefine";
import {
  CHECKED_REQUIREMENTS,
  HUMAN_GATE_REQUIREMENTS,
  KNOWN_REQUIREMENTS,
} from "./requirements";

/** The seeded pipeline's descriptions of its keys (0007, 0018): what a newly picked key starts as. */
export const REQUIREMENT_DESCRIPTIONS: Readonly<Record<string, string>> = {
  spec_doc: "a spec doc, gaps declared (explicitly [] when there are none)",
  plan_doc: "a plan doc",
  human_move: "a human move (a gate on a move out)",
  run_completed: "a run that completed",
  non_empty_diff: "a non-empty diff",
  pr_link: "a PR link",
  verified: "a passing verification of every surface the card's change touched",
  review_verdict: "a review verdict",
  human_merge: "a human merge (a gate on a move out)",
};

/**
 * The vocabulary, keys and roles each sorted: every known requirement key with its starting
 * description and whether it is checked or a gate label, and every role `defineBoard` accepts
 * whatever the role table says — `HARNESS_ROLES`, the held definitions' `declared` roles — plus the
 * role table's own (`table`, empty for a deployment with none). `rolesOpen` is that emptiness: with no
 * table `defineBoard` takes any role (`./boardDefine`), so the list is a suggestion and not the whole
 * of what is accepted. `declared` also holds the deployment's own role policy rows (D10), which the
 * rules accept beside the table's.
 */
export const definitionVocabulary = (roles: {
  readonly table: ReadonlySet<string>;
  readonly declared: ReadonlySet<string>;
}): DefinitionVocabulary => ({
  rolesOpen: roles.table.size === 0,
  requirements: [...KNOWN_REQUIREMENTS].toSorted().map((key) => ({
    key,
    description: REQUIREMENT_DESCRIPTIONS[key] ?? key,
    checked: CHECKED_REQUIREMENTS.has(key),
    humanGate: HUMAN_GATE_REQUIREMENTS.has(key),
  })),
  roles: [
    ...new Set([...HARNESS_ROLES, ...roles.declared, ...roles.table]),
  ].toSorted(),
});
