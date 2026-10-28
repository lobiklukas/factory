/**
 * The role policy table (D10): one row per role says whether its runs only read and which stage tool
 * they are offered, and a deployment extends it (`ROLE_POLICIES`) without rewriting the factory's own
 * rows. Pure, so the table and its parser are rows here; `roles.test.ts` proves the install site.
 */
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_ROLE_POLICIES,
  extendRolePolicies,
  parseRolePolicies,
  rolePolicyOf,
  rolesWhere,
} from "./rolePolicy";

const parsed = (text: string) =>
  Effect.runSync(
    parseRolePolicies(text).pipe(
      Effect.match({
        onFailure: (error) => ({ error: error.message }),
        onSuccess: (value) => ({ ok: [...value] }),
      }),
    ),
  );

describe("the factory's role policy table", () => {
  /** Mutation: give the spec tool to the planner, or the plan tool to the specifier. */
  it("makes the specifier and the planner read-only, each with its own stage tool", () => {
    expect(rolesWhere(DEFAULT_ROLE_POLICIES, "readOnly")).toEqual([
      "specifier",
      "planner",
    ]);
    expect(rolesWhere(DEFAULT_ROLE_POLICIES, "writesSpec")).toEqual([
      "specifier",
    ]);
    expect(rolesWhere(DEFAULT_ROLE_POLICIES, "writesPlan")).toEqual([
      "planner",
    ]);
    expect(rolePolicyOf("planner")?.stage).toBe("planning");
    expect(rolePolicyOf("builder")).toBeUndefined();
    expect(rolePolicyOf("constructor")).toBeUndefined();
    expect(rolePolicyOf(undefined)).toBeUndefined();
  });
});

describe("a deployment's ROLE_POLICIES", () => {
  it("reads role=flag+flag rows, skipping blanks", () => {
    expect(parsed(" auditor = read-only ,, architect=read-only+plan")).toEqual({
      ok: [
        ["auditor", { readOnly: true }],
        ["architect", { readOnly: true, writesPlan: true }],
      ],
    });
    expect(parsed("")).toEqual({ ok: [] });
  });

  /** Mutation: let a row redefine `planner` — a deployment could make the planning stage write. */
  it("refuses a row it cannot read, an unknown flag, a role twice, and a factory role", () => {
    expect(parsed("auditor")).toEqual({
      error:
        'role policy "auditor" is not role=flag[+flag] (flags: read-only, spec, plan)',
    });
    expect(parsed("auditor=write")).toEqual({
      error:
        'role auditor: "write" is not a role flag (flags: read-only, spec, plan)',
    });
    expect(parsed("a=read-only,a=plan")).toEqual({
      error: "role a is given a policy twice",
    });
    expect(parsed("planner=spec")).toEqual({
      error:
        "role planner is the factory's own (its policy is built in); name a role of your own",
    });
  });

  /**
   * Mutation: drop the read-only requirement — `architect=plan` is a row whose runs may change the
   * code and still post the plan that meets `plan_doc`.
   */
  it("refuses a role that declares the spec or the plan without read-only", () => {
    expect(parsed("architect=plan")).toEqual({
      error:
        "role architect: plan needs read-only (a run that declares the plan only reads)",
    });
    expect(parsed("drafter=spec")).toEqual({
      error:
        "role drafter: spec needs read-only (a run that declares the spec only reads)",
    });
    expect(parsed("architect=plan+read-only")).toEqual({
      ok: [["architect", { writesPlan: true, readOnly: true }]],
    });
  });

  it("extends the factory's table, keeping its rows whatever the extension says", () => {
    const extended = extendRolePolicies(
      new Map([
        ["auditor", { readOnly: true }],
        ["planner", {}],
      ]),
    );
    expect(rolePolicyOf("auditor", extended)).toEqual({ readOnly: true });
    expect(rolePolicyOf("planner", extended)).toEqual(
      DEFAULT_ROLE_POLICIES.get("planner"),
    );
    expect(extendRolePolicies(new Map())).toBe(DEFAULT_ROLE_POLICIES);
  });
});
