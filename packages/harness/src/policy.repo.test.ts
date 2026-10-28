/**
 * A repository's policy (S-factory-config-as-code): what its `.factory/config` declares at the
 * session's base, merged under the deployment's configuration with tighten-only semantics, and the
 * deny list it can add.
 *
 * Pure, like the rest of the policy. What the suite holds the merge to is the direction — a
 * repository adds gates and denials and narrows the allowlist, and never reaches a host the
 * deployment refuses — and the order `Policy.forWorktree` composes it in: deployment, repository,
 * column. That the policy is read at the base and pinned in the log is `@repo/core`'s, on a real
 * database (`SessionService.repoPolicy.test.ts`).
 */
import type { ToolCall } from "@earendil-works/pi-ai";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  autonomyRules,
  decideToolCall,
  DEFAULT_AUTONOMY,
  NO_REPO_POLICY,
  Policy,
  PolicyLive,
  repoPolicyWidening,
  withRepoPolicy,
  type AutonomyConfig,
  type RepoPolicy,
} from "./policy";

const bash = (command: string): ToolCall => ({
  type: "toolCall",
  id: "call_1",
  name: "bash",
  arguments: { command },
});

const decide = (
  repo: RepoPolicy | undefined,
  command: string,
  config: AutonomyConfig = DEFAULT_AUTONOMY,
) =>
  decideToolCall(
    autonomyRules(withRepoPolicy(config, repo), "/work/ses_1", "ses_1"),
    bash(command),
  );

describe("a repository's gates are added to the deployment's", () => {
  /** Mutation: ignore `policy.approvalRequired` — `bun publish` runs unasked. */
  it("asks before `bun publish` in a repository that gates it, and not in one that does not", () => {
    const gated = { ...NO_REPO_POLICY, approvalRequired: ["bun publish"] };
    expect(decide(gated, "bun publish --access public")).toMatchObject({
      _tag: "ask",
      action: "bun publish",
      detail: "bun publish --access public",
    });
    expect(decide(gated, "./bin/bun publish")).toMatchObject({ _tag: "ask" });
    expect(decide(NO_REPO_POLICY, "bun publish")._tag).toBe("allow");
    expect(decide(undefined, "bun publish")._tag).toBe("allow");
  });

  /** Mutation: replace the deployment's gates with the repository's — `npm publish` runs unasked. */
  it("keeps every deployment gate, once", () => {
    const merged = withRepoPolicy(
      { ...DEFAULT_AUTONOMY, approvalRequired: ["npm publish"] },
      { ...NO_REPO_POLICY, approvalRequired: ["/usr/bin/npm publish", "bun publish"] },
    );
    expect(merged.approvalRequired).toEqual(["npm publish", "bun publish"]);
  });
});

describe("a repository's deny list refuses outright", () => {
  const denying = { ...NO_REPO_POLICY, denied: ["terraform destroy"] };

  /** Mutation: drop `decideDenied` from `decideRefusal` — the command runs. */
  it("refuses a denied command however it is spelled, and allows what it does not name", () => {
    for (const command of [
      "terraform destroy",
      "cd infra && terraform -chdir=x destroy -auto-approve",
      "sudo terraform destroy",
      "sh -c 'terraform destroy'",
    ]) {
      const decision = decide(denying, command);
      expect(decision._tag, command).toBe("block");
      expect(decision).toMatchObject({
        reason: expect.stringContaining("terraform destroy is refused"),
      });
    }
    expect(decide(denying, "terraform plan")._tag).toBe("allow");
    expect(decide(denying, "echo terraform destroy")._tag).toBe("allow");
  });

  /** Mutation: check the gate before the denial — a person is asked to lift a denial. */
  it("outranks a gate on the same command: nobody is asked to lift a denial", () => {
    const decision = decide(
      { ...denying, approvalRequired: ["terraform destroy"] },
      "terraform destroy",
    );
    expect(decision._tag).toBe("block");
  });
});

describe("a repository narrows the allowlist and never widens it", () => {
  /** Mutation: let `allowedHosts` replace the deployment's — `codeload.github.com` stays reachable. */
  it("keeps only the hosts the repository names", () => {
    const narrowed = { ...NO_REPO_POLICY, allowedHosts: ["GitHub.com"] };
    expect(withRepoPolicy(DEFAULT_AUTONOMY, narrowed).allowedHosts).toEqual([
      "github.com",
    ]);
    expect(decide(narrowed, "curl https://github.com/x")._tag).toBe("allow");
    expect(decide(narrowed, "curl https://codeload.github.com/x")._tag).toBe(
      "block",
    );
    expect(decide(NO_REPO_POLICY, "curl https://codeload.github.com/x")._tag).toBe(
      "allow",
    );
  });

  /** Mutation: append the repository's hosts — evil.example becomes reachable. */
  it("cannot reach a host the deployment refuses, even unchecked", () => {
    const widening = { ...NO_REPO_POLICY, allowedHosts: ["github.com", "evil.example"] };
    expect(withRepoPolicy(DEFAULT_AUTONOMY, widening).allowedHosts).toEqual([
      "github.com",
    ]);
    expect(decide(widening, "curl https://evil.example/x")._tag).toBe("block");
  });

  /** Mutation: `repoPolicyWidening` answers `[]` — a widening config loads. */
  it("names each host it would widen to, and nothing for a narrowing", () => {
    expect(
      repoPolicyWidening(DEFAULT_AUTONOMY, {
        ...NO_REPO_POLICY,
        allowedHosts: ["github.com", "evil.example", "EVIL2.example"],
      }),
    ).toEqual([
      expect.stringContaining("allowedHosts names evil.example"),
      expect.stringContaining("allowedHosts names EVIL2.example"),
    ]);
    expect(
      repoPolicyWidening(DEFAULT_AUTONOMY, {
        ...NO_REPO_POLICY,
        allowedHosts: ["API.github.com"],
      }),
    ).toEqual([]);
    expect(repoPolicyWidening(DEFAULT_AUTONOMY, NO_REPO_POLICY)).toEqual([]);
  });
});

describe("Policy.forWorktree composes deployment, repository, column", () => {
  /** Mutation: drop the `repo` argument in `PolicyLive` — the repository's gate is not met. */
  it("builds the run's rules from all three", async () => {
    const rules = await Effect.runPromise(
      Effect.gen(function* () {
        const policy = yield* Policy;
        return policy.forWorktree(
          "/work/ses_1",
          "ses_1",
          { approvalRequired: ["git push"], push: "none" },
          {
            approvalRequired: ["bun publish"],
            denied: ["rm -rf"],
            allowedHosts: ["github.com"],
          },
        ).rules;
      }).pipe(
        Effect.provide(
          PolicyLive({ ...DEFAULT_AUTONOMY, approvalRequired: ["npm publish"] }),
        ),
      ),
    );
    expect(rules.approvalRequired).toEqual([
      "npm publish",
      "bun publish",
      "git push",
    ]);
    expect(rules.denied).toEqual(["rm -rf"]);
    expect(rules.allowedHosts).toEqual(["github.com"]);
    expect(rules.pushRefPrefixes).toEqual([]);
  });
});
