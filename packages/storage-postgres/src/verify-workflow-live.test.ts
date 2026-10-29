import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

/**
 * `verify-workflow`'s `--live` mode refuses without the owner's variables, naming each one (LOB-40).
 *
 * The live run talks to Linear, GitHub and Anthropic with the owner's credentials, so no agent and no
 * CI ever runs it; what can be proven here is that it never starts half-configured. Every case runs
 * the real scripts — `up.sh --live`, `doctor.sh --live` and `drive.sh --live` — copied into a scratch
 * repo layout, under an environment built from nothing (`PATH` and `HOME` alone, plus what the case
 * sets), so a developer's own `GITHUB_TOKEN` can neither satisfy nor leak into a case. The values the
 * cases set are placeholders; one of them is a sentinel that must never appear in what the scripts
 * print, because the refusal reads whether a variable is set and never what it holds.
 *
 * Beside `verify-board-doctor.test.ts`, for the same reason: a repo-level claim about a skill script
 * that belongs to no package and needs no database. Each case names the mutation it was checked
 * against on a `// Mutation checked:` line.
 */

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const SKILL = ".pi/skills/verify-workflow";

/** Every variable the live run requires, as the refusal names them. */
const REQUIRED = [
  "LINEAR_API_KEY",
  "LINEAR_WEBHOOK_SECRET",
  "GITHUB_TOKEN",
  "GITHUB_WEBHOOK_SECRET",
  "WORKFLOW_GITHUB_REPO",
  "WORKFLOW_PUBLIC_URL",
] as const;
const ANTHROPIC = "ANTHROPIC_API_KEY (or ANTHROPIC_OAUTH_TOKEN, or ANTHROPIC_AUTH_TOKEN)";
const SENTINEL = "sentinel-value-never-printed";

const created: string[] = [];
afterAll(() => {
  for (const root of created) rmSync(root, { recursive: true, force: true });
}, 60_000);

/** A scratch repo holding the workflow skill, verify-board's doctor and the shared Postgres lib. */
const stage = (): string => {
  const root = mkdtempSync(path.join(tmpdir(), "factory-verify-workflow-live-"));
  created.push(root);
  for (const dir of [SKILL, ".pi/skills/verify-board", ".pi/skills/lib"]) {
    mkdirSync(path.join(root, dir), { recursive: true });
    cpSync(path.join(REPO_ROOT, dir), path.join(root, dir), { recursive: true });
  }
  return root;
};

/** Every variable set to a placeholder (the key to the sentinel), minus `omit`. */
const liveEnv = (omit: ReadonlyArray<string> = []): Record<string, string> => {
  const all: Record<string, string> = {
    LINEAR_API_KEY: SENTINEL,
    LINEAR_WEBHOOK_SECRET: "placeholder",
    GITHUB_TOKEN: "placeholder",
    GITHUB_WEBHOOK_SECRET: "placeholder",
    WORKFLOW_GITHUB_REPO: "acme/scratch",
    WORKFLOW_PUBLIC_URL: "https://tunnel.invalid",
    ANTHROPIC_API_KEY: "placeholder",
  };
  for (const name of omit) delete all[name];
  return all;
};

const run = (root: string, script: string, env: Record<string, string>) => {
  // Built from nothing, not from `process.env`: a credential in the developer's shell must not
  // decide a case. `Object.entries` keeps the repo's Effect lint from reading this as configuration.
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && (entry[0] === "PATH" || entry[0] === "HOME"),
    ),
  );
  const result = spawnSync("bash", [path.join(root, SKILL, script), "--live"], {
    encoding: "utf8",
    timeout: 60_000,
    env: {
      ...inherited,
      // A closed port: should a refusal fail open, the script would find no database rather than
      // the developer's.
      DATABASE_URL: "postgres://factory:factory@127.0.0.1:9/factory_live_test",
      ...env,
    },
  });
  expect(result.signal, `${script} was killed: ${result.stderr}`).toBeNull();
  return result;
};

describe("verify-workflow --live without its variables", () => {
  for (const script of ["up.sh", "doctor.sh", "drive.sh"] as const) {
    it(
      `${script} --live refuses, naming every missing variable, and starts nothing`,
      { timeout: 90_000 },
      () => {
        // Mutation checked: dropping a name from LIVE_REQUIRED in live-env.sh, or calling
        // `live_refusal` after the instance is read (or not at all) in any of the three scripts,
        // reddens this case: the name goes missing from stderr, or the status is not 2.
        const root = stage();
        const result = run(root, script, {});
        expect(result.status).toBe(2);
        expect(result.stderr).toContain(`${script} --live refuses`);
        for (const name of REQUIRED) {
          expect(result.stderr).toContain(`  missing: ${name}\n`);
        }
        expect(result.stderr).toContain(`  missing: ${ANTHROPIC}`);
        // Nothing was started or recorded: the refusal comes before the instance.
        expect(existsSync(path.join(root, ".verify/run/workflow"))).toBe(false);
      },
    );
  }

  it(
    "names only what is missing, and never prints a value it was given",
    { timeout: 90_000 },
    () => {
      // Mutation checked: a refusal that listed every required name regardless of what is set
      // reddens the `not.toContain` assertions; one that echoed `${!name}` instead of the name
      // prints the sentinel and reddens the last two.
      const root = stage();
      const result = run(
        root,
        "up.sh",
        liveEnv(["GITHUB_WEBHOOK_SECRET", "ANTHROPIC_API_KEY"]),
      );
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("  missing: GITHUB_WEBHOOK_SECRET\n");
      expect(result.stderr).toContain(`  missing: ${ANTHROPIC}`);
      expect(result.stderr).not.toContain("missing: GITHUB_TOKEN\n");
      expect(result.stderr).not.toContain("missing: LINEAR_API_KEY");
      expect(result.stdout).not.toContain(SENTINEL);
      expect(result.stderr).not.toContain(SENTINEL);
    },
  );

  it(
    "refuses a scratch repo that is not owner/name",
    { timeout: 90_000 },
    () => {
      // Mutation checked: dropping the owner/name test from `live_missing` lets this through to
      // the instance check (status 1, not 2).
      const root = stage();
      const result = run(root, "drive.sh", {
        ...liveEnv(),
        WORKFLOW_GITHUB_REPO: "not-a-slug",
      });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain(
        "  missing: WORKFLOW_GITHUB_REPO (set, but not owner/name)",
      );
    },
  );

  it(
    "with every variable set, the gate lets the live drive through to its next check (the control)",
    { timeout: 90_000 },
    () => {
      // Mutation checked: a `live_refusal` that refused unconditionally makes this exit 2 with the
      // refusal; without this case the ones above could pass vacuously. The drive then stops at the
      // missing instance (status 1), which is the scratch repo's, not a live one.
      const root = stage();
      const result = run(root, "drive.sh", liveEnv());
      expect(result.stderr).not.toContain("refuses");
      expect(result.stderr).toContain("no workflow instance");
      expect(result.status).toBe(1);
      expect(result.stdout).not.toContain(SENTINEL);
      expect(result.stderr).not.toContain(SENTINEL);
    },
  );
});
