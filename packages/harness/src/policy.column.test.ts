/**
 * A column's autonomy (docs/board.md B6, C22): what a column's runs may do without asking, declared
 * on the board definition and merged over the deployment's configuration (D11's config surface).
 *
 * Pure, like the rest of the policy: a configuration and a call in, a decision out. What the suite
 * holds the merge to is the direction — a column adds gates and narrows scopes and never widens what
 * the deployment allows — and that the policy the control plane builds for a run (`Policy`'s
 * `forWorktree`) is the narrowed one. That the run's column reaches `forWorktree` is
 * `SessionService.test.ts`'s, across two columns on a real database.
 */
import type { ToolCall } from "@earendil-works/pi-ai";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { ColumnAutonomy } from "@repo/domain/Task";
import {
  autonomyRules,
  columnAutonomy,
  columnWriteScope,
  decideToolCall,
  DEFAULT_AUTONOMY,
  Policy,
  PolicyLive,
  readOnlyStageOf,
  withColumnAutonomy,
} from "./policy";
import { resolveRole } from "./loader";
import { createModelAccess } from "./models";

const bash = (command: string): ToolCall => ({
  type: "toolCall",
  id: "call_1",
  name: "bash",
  arguments: { command },
});

/** A push the default allows: the session's own branch. */
const OWN_PUSH = "git push origin HEAD:refs/heads/factory/ses_1";

const decide = (autonomy: ColumnAutonomy | undefined, command: string) =>
  decideToolCall(
    autonomyRules(
      withColumnAutonomy(DEFAULT_AUTONOMY, autonomy),
      "/work/ses_1",
      "ses_1",
    ),
    bash(command),
  );

describe("a column's gates are added to the deployment's", () => {
  /** Mutation: ignore `autonomy.approvalRequired` — the push runs unasked. */
  it("asks before a push in a column that gates `git push`, and runs it in one that does not", () => {
    expect(decide({ approvalRequired: ["git push"] }, OWN_PUSH)).toMatchObject(
      { _tag: "ask", action: "git push", detail: OWN_PUSH },
    );
    expect(decide(undefined, OWN_PUSH)._tag).toBe("allow");
    expect(decide({}, OWN_PUSH)._tag).toBe("allow");
  });

  /** Mutation: replace the deployment's gates with the column's — `npm publish` runs unasked. */
  it("keeps every deployment gate: a column cannot lift one", () => {
    const deployment = { ...DEFAULT_AUTONOMY, approvalRequired: ["npm publish"] };
    const merged = withColumnAutonomy(deployment, {
      approvalRequired: ["git push"],
    });
    expect(merged.approvalRequired).toEqual(["npm publish", "git push"]);
    // A column that declares no gates still meets the deployment's.
    expect(withColumnAutonomy(deployment, {}).approvalRequired).toEqual([
      "npm publish",
    ]);
  });

  it("adds a gate the deployment already holds once, and drops a blank one", () => {
    const deployment = { ...DEFAULT_AUTONOMY, approvalRequired: ["npm publish"] };
    expect(
      withColumnAutonomy(deployment, {
        approvalRequired: ["/usr/bin/npm  publish", " ", "git push"],
      }).approvalRequired,
    ).toEqual(["npm publish", "git push"]);
  });

  /** A refusal still outranks a column's gate (LOB-52): nobody is asked to approve what D11 refuses. */
  it("refuses another session's branch rather than asking about it", () => {
    expect(
      decide(
        { approvalRequired: ["git push"] },
        "git push origin HEAD:refs/heads/factory/ses_2",
      )._tag,
    ).toBe("block");
  });
});

describe("a column's push scope", () => {
  /** Mutation: leave `pushRefPrefixes` alone for `push: "none"` — the session's own push runs. */
  it("refuses every push in a `push: none` column, the session's own branch included", () => {
    const refused = decide({ push: "none" }, OWN_PUSH);
    expect(refused._tag).toBe("block");
    expect(refused).toMatchObject({
      reason: expect.stringContaining("this session may push no ref"),
    });
    expect(decide({ push: "branch" }, OWN_PUSH)._tag).toBe("allow");
  });

  it("leaves every other command alone", () => {
    expect(decide({ push: "none" }, "git commit -m change")._tag).toBe(
      "allow",
    );
  });

  /** Nothing a column declares widens D11: hosts and prefixes are the deployment's. */
  it("never widens the deployment's hosts or prefixes", () => {
    const merged = withColumnAutonomy(DEFAULT_AUTONOMY, {
      push: "branch",
      write: "worktree",
      approvalRequired: [],
    });
    expect(merged.pushRefPrefixes).toEqual(DEFAULT_AUTONOMY.pushRefPrefixes);
    expect(merged.allowedHosts).toEqual(DEFAULT_AUTONOMY.allowedHosts);
  });
});

describe("a column's write scope", () => {
  it.each([
    // [role, skills, declared, effective]
    [undefined, [], undefined, "worktree"],
    [undefined, [], "docs", "docs"],
    [undefined, [], "none", "none"],
    [undefined, ["docs"], undefined, "docs"],
    // Declared wider than the skill makes it: the skill's.
    [undefined, ["docs"], "worktree", "docs"],
    [undefined, ["docs"], "none", "none"],
    ["specifier", [], undefined, "none"],
    // A specifier column that says it writes is still the read-only stage.
    ["specifier", [], "worktree", "none"],
    ["builder", [], "docs", "docs"],
  ] as const)(
    "role %s, skills %j, declared %s: %s",
    (role, skills, write, effective) => {
      expect(
        columnWriteScope({
          role,
          skills,
          ...(write === undefined ? {} : { autonomy: { write } }),
        }),
      ).toBe(effective);
    },
  );

  /**
   * `write: none` makes the run a read-only stage named after its column: the stage's hook refuses
   * its writes and `resolveRole` withholds the stage's tools. Mutation: drop the autonomy branch of
   * `readOnlyStageOf` — the review column writes.
   */
  it("makes a `write: none` column a read-only stage, its tools withheld", () => {
    const run = {
      column: "review",
      role: "reviewer",
      skills: [],
      autonomy: { write: "none" },
    } as const;
    expect(readOnlyStageOf(run)).toEqual({
      stage: "review",
      column: "review",
      role: "reviewer",
    });
    const resolved = resolveRole(run, createModelAccess("faux"));
    expect(resolved.stage).toEqual(readOnlyStageOf(run));
    expect(resolved.withheldTools.has("write")).toBe(true);
    // The same column declaring nothing writes as before.
    expect(
      readOnlyStageOf({ column: "review", role: "reviewer" }),
    ).toBeUndefined();
    // A specifier keeps its own stage's name whatever the column declares.
    expect(
      readOnlyStageOf({
        column: "specifying",
        role: "specifier",
        autonomy: { write: "none" },
      }),
    ).toEqual({ stage: "specifying", column: "specifying", role: "specifier" });
  });
});

describe("the policy a run is built with is the column's", () => {
  /** Mutation: have `forWorktree` ignore its third argument — the gated column's push runs. */
  it("narrows `Policy.forWorktree` by the column it is handed", async () => {
    const decisions = await Effect.runPromise(
      Effect.gen(function* () {
        const policy = yield* Policy;
        const gated = policy.forWorktree("/work/ses_1", "ses_1", {
          approvalRequired: ["git push"],
        });
        const plain = policy.forWorktree("/work/ses_1", "ses_1");
        return {
          gated: yield* gated.decide(bash(OWN_PUSH)),
          plain: yield* plain.decide(bash(OWN_PUSH)),
          rules: gated.rules.approvalRequired,
        };
      }).pipe(Effect.provide(PolicyLive())),
    );
    expect(decisions.gated._tag).toBe("ask");
    expect(decisions.plain._tag).toBe("allow");
    expect(decisions.rules).toEqual(["git push"]);
  });

  /** The description is built from the same merge: what a reader is told is what the run meets. */
  it("describes the column with the gates and scopes the run's policy holds", () => {
    const deployment = { ...DEFAULT_AUTONOMY, approvalRequired: ["npm publish"] };
    const column = {
      role: "builder",
      skills: [],
      autonomy: { approvalRequired: ["git push"], push: "none" },
    } as const;
    const described = columnAutonomy(deployment, column);
    const rules = autonomyRules(
      withColumnAutonomy(deployment, column.autonomy),
      "/work/ses_1",
    );
    expect(described.approvalRequired.map((gate) => gate.command)).toEqual(
      rules.approvalRequired,
    );
    expect(described).toEqual({
      approvalRequired: [
        { command: "npm publish", source: "deployment" },
        { command: "git push", source: "column" },
      ],
      write: "worktree",
      push: "none",
    });
    // A deployment that pushes nothing at all is described as pushing nothing in every column.
    expect(
      columnAutonomy(
        { ...DEFAULT_AUTONOMY, pushRefPrefixes: [] },
        { skills: [] },
      ).push,
    ).toBe("none");
  });
});
