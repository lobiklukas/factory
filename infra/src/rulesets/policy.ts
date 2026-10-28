/**
 * The GitHub rulesets the factory's enforcement boundary rests on (docs/design.md D15, R3; LOB-30).
 *
 * D15 puts policy in the harness's hooks and the *boundary* at GitHub: a hook stops an accident with
 * an error the agent can correct, but it runs in the agent's own trust domain, so what stops a
 * bypass is GitHub refusing the ref update whatever sent it. That half lives in repository
 * settings, and a setting someone clicked off in the UI leaves no trace in the code — the boundary
 * is silently absent (R3). So the rulesets are declared here, reviewed like any other change, and
 * reconciled and read back by `reconcile.ts`:
 *
 * - **The default branch is PR-only, with no bypass.** Matched as `~DEFAULT_BRANCH`, not by name, so
 *   the ruleset follows the repository's default branch and its name never depends on an input: a
 *   mistyped branch cannot rename it, which would make apply delete the real protection as an
 *   undeclared prefixed ruleset and pass its own read-back. A `pull_request` rule (so no push lands on it
 *   directly, the factory App's included), plus `deletion` and `non_fast_forward`. The PR rule asks
 *   for one approval and for the last push to be approved by someone other than its pusher: the
 *   factory's own identity cannot approve the PR it opened, and the reviewer agent only ever posts a
 *   `COMMENT` (LOB-36), so the approval that merges is a person's (B5's human merge gate).
 * - **`factory/**` cannot be rewritten or deleted.** `non_fast_forward` and `deletion`. A session's
 *   branch is the record of what it pushed; the control plane never forces or deletes one
 *   (`packages/core/src/git.ts`), so nothing legitimate is refused, and anything that tries — an
 *   agent with a token, a hook that was bypassed — is.
 *
 * Neither ruleset names a bypass actor: `bypass_actors` is empty, and the read-back treats an
 * actor in it as drift. Creating new branches stays allowed (D15's stated residual risk).
 *
 * The rulesets are owned by name: every one this module declares starts with `RULESET_PREFIX`, and
 * a live ruleset with that prefix that the policy no longer declares is deleted on apply. Rulesets
 * without the prefix are someone else's and are never touched.
 */

/** A ref-update rule, in the shape GitHub's REST API takes and answers. */
export type DeclaredRule = {
  readonly type: string;
  readonly parameters?: Readonly<Record<string, boolean | number | string>>;
};

/** One repository ruleset, in the body `POST /repos/{owner}/{repo}/rulesets` takes. */
export type DeclaredRuleset = {
  readonly name: string;
  readonly target: "branch";
  readonly enforcement: "active";
  readonly bypass_actors: ReadonlyArray<never>;
  readonly conditions: {
    readonly ref_name: {
      readonly include: ReadonlyArray<string>;
      readonly exclude: ReadonlyArray<string>;
    };
  };
  readonly rules: ReadonlyArray<DeclaredRule>;
};

/** The name prefix that marks a ruleset as this module's to create, update and delete. */
export const RULESET_PREFIX = "factory: ";

/** The branch namespace a session pushes to (`SESSION_BRANCH_PREFIX` in `@repo/core`). */
export const SESSION_BRANCH_PATTERN = "refs/heads/factory/**";

/** The pattern GitHub resolves to the repository's default branch, whatever it is called. */
export const DEFAULT_BRANCH_PATTERN = "~DEFAULT_BRANCH";

export type PolicyOptions = {
  /** Approvals the PR rule requires before a merge. Defaults to 1; 0 lets an author merge alone. */
  readonly requiredApprovals?: number;
};

/** The declared rulesets for one repository. */
export const rulesetPolicy = (
  options: PolicyOptions = {},
): ReadonlyArray<DeclaredRuleset> => {
  return [
    {
      name: `${RULESET_PREFIX}the default branch is PR-only`,
      target: "branch",
      enforcement: "active",
      bypass_actors: [],
      conditions: {
        ref_name: { include: [DEFAULT_BRANCH_PATTERN], exclude: [] },
      },
      rules: [
        { type: "deletion" },
        { type: "non_fast_forward" },
        {
          type: "pull_request",
          parameters: {
            required_approving_review_count: options.requiredApprovals ?? 1,
            dismiss_stale_reviews_on_push: true,
            require_code_owner_review: false,
            require_last_push_approval: true,
            required_review_thread_resolution: false,
          },
        },
      ],
    },
    {
      name: `${RULESET_PREFIX}factory/** is append-only`,
      target: "branch",
      enforcement: "active",
      bypass_actors: [],
      conditions: {
        ref_name: { include: [SESSION_BRANCH_PATTERN], exclude: [] },
      },
      rules: [{ type: "deletion" }, { type: "non_fast_forward" }],
    },
  ];
};
