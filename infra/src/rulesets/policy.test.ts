/**
 * The declared rulesets, pinned, and what they refuse under GitHub's enforcement model (LOB-30).
 *
 * The first case is the policy as data: a ruleset deleted from the code, a rule dropped, a bypass
 * actor added or the pattern narrowed fails it, which is what makes the boundary a reviewed change
 * rather than an edit nobody looks at. The rest run the declared policy through `enforce.ts`, the
 * model the loopback forge enforces pushes with: a force-push or a deletion of `factory/x` is
 * refused, the factory's own fast-forward push is not, and nothing lands on `main` outside a PR.
 */
import { describe, expect, it } from "vitest";
import {
  type EnforcedRuleset,
  evaluateRefUpdate,
  matchesRef,
  type RefUpdate,
  rejectionLines,
} from "./enforce";
import { rulesetPolicy, RULESET_PREFIX } from "./policy";

const APP = { actorType: "Integration", actorId: 4242 };
const CONTEXT = { defaultBranch: "main", pusher: APP };

const refused = (
  update: RefUpdate,
  rulesets: ReadonlyArray<EnforcedRuleset> = rulesetPolicy(),
) =>
  evaluateRefUpdate(rulesets, update, CONTEXT).map(
    (violation) => violation.rule,
  );

describe("the declared rulesets", () => {
  it("are exactly D15's two, active, with nobody able to bypass them", () => {
    expect(rulesetPolicy()).toEqual([
      {
        name: "factory: main is PR-only",
        target: "branch",
        enforcement: "active",
        bypass_actors: [],
        conditions: { ref_name: { include: ["refs/heads/main"], exclude: [] } },
        rules: [
          { type: "deletion" },
          { type: "non_fast_forward" },
          {
            type: "pull_request",
            parameters: {
              required_approving_review_count: 1,
              dismiss_stale_reviews_on_push: true,
              require_code_owner_review: false,
              require_last_push_approval: true,
              required_review_thread_resolution: false,
            },
          },
        ],
      },
      {
        name: "factory: factory/** is append-only",
        target: "branch",
        enforcement: "active",
        bypass_actors: [],
        conditions: {
          ref_name: { include: ["refs/heads/factory/**"], exclude: [] },
        },
        rules: [{ type: "deletion" }, { type: "non_fast_forward" }],
      },
    ]);
  });

  it("follow the branch and approval count they are given, and keep the owned prefix", () => {
    const [main] = rulesetPolicy({
      defaultBranch: "trunk",
      requiredApprovals: 2,
    });
    expect(main?.name).toBe("factory: trunk is PR-only");
    expect(main?.conditions.ref_name.include).toEqual(["refs/heads/trunk"]);
    expect(
      main?.rules.find((rule) => rule.type === "pull_request")?.parameters?.[
        "required_approving_review_count"
      ],
    ).toBe(2);
    for (const ruleset of rulesetPolicy())
      expect(ruleset.name.startsWith(RULESET_PREFIX)).toBe(true);
  });
});

describe("what the declared rulesets refuse", () => {
  it("refuses a force-push to factory/x, at any depth", () => {
    expect(refused({ ref: "refs/heads/factory/x", kind: "force" })).toEqual([
      "non_fast_forward",
    ]);
    expect(
      refused({ ref: "refs/heads/factory/review-7/abc", kind: "force" }),
    ).toEqual(["non_fast_forward"]);
  });

  it("refuses deleting a factory/ branch", () => {
    expect(refused({ ref: "refs/heads/factory/x", kind: "delete" })).toEqual([
      "deletion",
    ]);
  });

  it("lets the factory create and fast-forward its own branches", () => {
    expect(refused({ ref: "refs/heads/factory/x", kind: "create" })).toEqual(
      [],
    );
    expect(
      refused({ ref: "refs/heads/factory/x", kind: "fast-forward" }),
    ).toEqual([]);
  });

  it("refuses every direct push to main, the factory App's included", () => {
    expect(refused({ ref: "refs/heads/main", kind: "fast-forward" })).toEqual([
      "pull_request",
    ]);
    expect(refused({ ref: "refs/heads/main", kind: "force" })).toEqual([
      "non_fast_forward",
      "pull_request",
    ]);
    expect(refused({ ref: "refs/heads/main", kind: "delete" })).toEqual([
      "deletion",
    ]);
  });

  it("binds nothing outside the two namespaces", () => {
    expect(refused({ ref: "refs/heads/feature/x", kind: "force" })).toEqual([]);
    expect(refused({ ref: "refs/heads/factoryx", kind: "delete" })).toEqual([]);
    expect(refused({ ref: "refs/heads/main-2", kind: "force" })).toEqual([]);
  });

  it("lets a listed bypass actor through, which is why the policy lists none", () => {
    const withBypass = rulesetPolicy().map((ruleset) => ({
      ...ruleset,
      bypass_actors: [
        { actor_type: "Integration", actor_id: 4242, bypass_mode: "always" },
      ],
    }));
    expect(
      refused({ ref: "refs/heads/factory/x", kind: "force" }, withBypass),
    ).toEqual([]);
    // A PR-only bypass does not cover a push.
    const prOnly = rulesetPolicy().map((ruleset) => ({
      ...ruleset,
      bypass_actors: [
        {
          actor_type: "Integration",
          actor_id: 4242,
          bypass_mode: "pull_request",
        },
      ],
    }));
    expect(
      refused({ ref: "refs/heads/factory/x", kind: "force" }, prOnly),
    ).toEqual(["non_fast_forward"]);
  });

  it("does not bind under evaluate enforcement", () => {
    const evaluate = rulesetPolicy().map((ruleset) => ({
      ...ruleset,
      enforcement: "evaluate",
    }));
    expect(
      refused({ ref: "refs/heads/factory/x", kind: "force" }, evaluate),
    ).toEqual([]);
  });
});

describe("ref patterns", () => {
  it("match fnmatch-style, with GitHub's two specials", () => {
    expect(
      matchesRef("refs/heads/factory/*", "refs/heads/factory/x", "main"),
    ).toBe(true);
    expect(
      matchesRef("refs/heads/factory/*", "refs/heads/factory/x/y", "main"),
    ).toBe(false);
    expect(
      matchesRef("refs/heads/factory/**", "refs/heads/factory/x/y", "main"),
    ).toBe(true);
    expect(matchesRef("refs/heads/v?.x", "refs/heads/v1.x", "main")).toBe(true);
    expect(matchesRef("refs/heads/v?.x", "refs/heads/v1-x", "main")).toBe(
      false,
    );
    expect(matchesRef("~DEFAULT_BRANCH", "refs/heads/trunk", "trunk")).toBe(
      true,
    );
    expect(matchesRef("~DEFAULT_BRANCH", "refs/heads/main", "trunk")).toBe(
      false,
    );
    expect(matchesRef("~ALL", "refs/heads/anything/at/all", "main")).toBe(true);
  });
});

describe("the rejection GitHub prints", () => {
  it("carries GH013 and one line per refused rule", () => {
    const lines = rejectionLines(
      "acme/app",
      "refs/heads/main",
      evaluateRefUpdate(
        rulesetPolicy(),
        { ref: "refs/heads/main", kind: "force" },
        CONTEXT,
      ),
    );
    expect(lines[0]).toBe(
      "error: GH013: Repository rule violations found for refs/heads/main.",
    );
    expect(lines).toContain("- Cannot force-push to this branch");
    expect(lines).toContain("- Changes must be made through a pull request.");
  });
});
