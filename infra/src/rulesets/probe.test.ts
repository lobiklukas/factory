/**
 * The force-push probe against a loopback forge that enforces the rulesets on `git push` (LOB-30).
 *
 * Real `git`, real smart-HTTP (`git http-backend`), a real `pre-receive` — the forge is
 * `../testing/githubFake.ts`, whose hook evaluates every ref update against the rulesets the
 * reconciler wrote. Nothing of the harness runs, so no session hook is in the way: a refusal here
 * can only be the forge's. The controls are what make the refusals mean something: with the
 * `factory/**` ruleset deleted, or the App added as a bypass actor, the same force-push lands and
 * the probe fails.
 */
import { BunServices } from "@effect/platform-bun";
import { Effect, Layer, Option, Redacted } from "effect";
import { FetchHttpClient } from "effect/http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CredentialProvider, staticTokenProvider } from "@repo/core";
import type { RepoSlug } from "@repo/domain/Session";
import { type GitHubFake, startGitHubFake } from "../testing/githubFake";
import { makeRulesetsClient } from "./github";
import { rulesetPolicy } from "./policy";
import { probeRulesets, type ProbeInput } from "./probe";
import { applyPlan, planRulesets } from "./reconcile";

const ADMIN = "admin-token-for-tests";
const WORKER = "worker-token-for-tests";
const SESSIONS = "factory: factory/** is append-only";
/** A probe is five network git calls through `http-backend` and a hook: seconds, not milliseconds. */
const GIT_TIMEOUT = 60_000;

let root: string;
let forge: GitHubFake;
let count = 0;
let repo: RepoSlug;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "rulesets-probe-"));
  forge = await startGitHubFake({
    root,
    workerToken: WORKER,
    adminToken: ADMIN,
  });
});

afterAll(async () => {
  await forge.close();
  rmSync(root, { recursive: true, force: true });
  // Removing the scratch checkout outran vitest's 10 s hook default on a loaded machine (DEFLAKE).
}, 60_000);

beforeEach(() => {
  count += 1;
  repo = `acme/probe-${count}` as RepoSlug;
  forge.createRepo(repo);
});

const applyPolicy = () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const client = yield* makeRulesetsClient({
        apiUrl: forge.url,
        token: Redacted.make(ADMIN),
      });
      const plan = yield* planRulesets(client, repo, rulesetPolicy());
      yield* applyPlan(client, plan, rulesetPolicy());
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  );

const probe = (input: Partial<ProbeInput> = {}, token = WORKER) =>
  Effect.runPromise(
    probeRulesets({ repo, url: forge.gitUrl(repo), ...input }).pipe(
      Effect.provide(
        Layer.mergeAll(
          BunServices.layer,
          Layer.succeed(
            CredentialProvider,
            staticTokenProvider(Option.some(Redacted.make(token))),
          ),
        ),
      ),
      Effect.result,
    ),
  );

const sessionsRulesetId = () => {
  const found = forge.rulesets(repo).find((each) => each.name === SESSIONS);
  if (found === undefined) throw new Error("the factory/** ruleset is absent");
  return found.id;
};

const editAsAdmin = async (method: string, id: number, body?: unknown) => {
  expect(await forge.editAsAdmin(repo, method, `/${id}`, body)).toBeLessThan(
    300,
  );
};

describe("the probe, with the policy applied", { timeout: GIT_TIMEOUT }, () => {
  it("is refused the force-push and the deletion by a repository rule, and the branch is intact, run after run", async () => {
    await applyPolicy();
    const result = await probe();
    if (result._tag !== "Success") throw new Error(String(result.failure));
    const report = result.success;
    expect(report.ref).toBe("refs/heads/factory/ruleset-probe");
    expect(
      report.steps.map((step) => [
        step.step,
        step.outcome,
        step.ruleViolation,
        step.passed,
      ]),
    ).toEqual([
      ["seed", "accepted", false, true],
      ["force-push", "rejected", true, true],
      ["delete", "rejected", true, true],
      ["intact", "accepted", false, true],
    ]);
    expect(report.passed).toBe(true);
    expect(report.steps[1]?.detail).toContain(
      "remote: - Cannot force-push to this branch",
    );
    expect(report.steps[2]?.detail).toContain(
      "remote: - Cannot delete this branch",
    );
    // The forge saw a create, a force and a delete — classified by git's own ancestry, not told.
    expect(
      forge.pushes
        .filter((push) => push.repo === repo)
        .map((push) => [push.updates[0]?.kind, push.allowed]),
    ).toEqual([
      ["create", true],
      ["force", false],
      ["delete", false],
    ]);
    // The token reached git through its environment only: nothing the probe reports carries it.
    expect(JSON.stringify(report)).not.toContain(WORKER);

    // The next run reuses the branch: its seed is a fast-forward of the first run's, and the
    // force-push and deletion are refused again.
    const again = await probe();
    if (again._tag !== "Success") throw new Error(String(again.failure));
    expect(again.success.passed).toBe(true);
    expect(
      forge.pushes.filter((push) => push.repo === repo).at(3)?.updates[0]?.kind,
    ).toBe("fast-forward");
  });
});

describe(
  "the controls: the refusal is the ruleset's",
  { timeout: GIT_TIMEOUT },
  () => {
    it("fails when the factory/** ruleset is deleted: the force-push lands", async () => {
      await applyPolicy();
      await editAsAdmin("DELETE", sessionsRulesetId());
      const result = await probe();
      if (result._tag !== "Success") throw new Error(String(result.failure));
      expect(result.success.passed).toBe(false);
      expect(result.success.steps[1]).toMatchObject({
        step: "force-push",
        outcome: "accepted",
        passed: false,
      });
    });

    it("fails when the factory's App is a bypass actor", async () => {
      await applyPolicy();
      await editAsAdmin("PUT", sessionsRulesetId(), {
        bypass_actors: [
          { actor_type: "Integration", actor_id: 4242, bypass_mode: "always" },
        ],
      });
      const result = await probe();
      if (result._tag !== "Success") throw new Error(String(result.failure));
      expect(result.success.passed).toBe(false);
      expect(
        result.success.steps
          .filter((step) => !step.passed)
          .map((step) => step.step),
      ).toEqual(["force-push", "delete", "intact"]);
    });

    it("fails on a bare repo with no rulesets at all", async () => {
      const result = await probe();
      if (result._tag !== "Success") throw new Error(String(result.failure));
      expect(result.success.passed).toBe(false);
    });

    it("does not count a refusal that names no repository rule", async () => {
      // A forge that refuses every update but a creation, for a reason that is not a ruleset: the
      // force-push and the deletion are refused, and still prove nothing about the boundary.
      writeFileSync(
        join(root, `${repo}.git`, "hooks", "pre-receive"),
        `#!/bin/sh\nwhile read old new ref; do case "$old" in 0000000000000000000000000000000000000000) ;; *) echo "declined by an unrelated hook" >&2; exit 1;; esac; done\n`,
      );
      const result = await probe();
      if (result._tag !== "Success") throw new Error(String(result.failure));
      expect(
        result.success.steps.map((step) => [
          step.step,
          step.outcome,
          step.ruleViolation,
          step.passed,
        ]),
      ).toEqual([
        ["seed", "accepted", false, true],
        ["force-push", "rejected", false, false],
        ["delete", "rejected", false, false],
        ["intact", "accepted", false, true],
      ]);
      expect(result.success.passed).toBe(false);
    });
  },
);

describe("refusals before any push", { timeout: GIT_TIMEOUT }, () => {
  it("refuses a probe branch outside factory/", async () => {
    const before = forge.pushes.length;
    const result = await probe({ branch: "main" });
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure")
      expect(result.failure).toMatchObject({ _tag: "ProbeError" });
    expect(forge.pushes.length).toBe(before);
  });

  it("refuses a URL that is neither GitHub nor loopback", async () => {
    const result = await probe({ url: `https://evil.example/${repo}.git` });
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure")
      expect(String(result.failure.message)).toContain("refused");
  });

  it("is not a pass when the forge refuses the credential", async () => {
    await applyPolicy();
    const result = await probe({}, "wrong-token");
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure")
      expect(result.failure).toMatchObject({ _tag: "ProbeError" });
  });
});
