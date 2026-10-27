import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The verify skills' TypeScript is part of the gate's `type-check` (LOB-176, half of LOB-141).
 *
 * The skills are the only evidence that a surface works (AGENTS.md), and before this none of the
 * seven `tsc --noEmit` projects reached `.pi`: a driver that no longer type-checked still reported
 * its checks as passing while `bun run type-check` stayed green. The root task `//#type-check:pi`
 * runs `tsc` over `.pi/tsconfig.json`, which includes `.pi/skills/**\/*.ts`.
 *
 * These cases drive the gate's own scripts, in the shape `turbo-env.test.ts` uses, so each one fails
 * if the coverage is undone a different way: the task dropped from `bun run type-check`, a skill
 * file left out of the project, or a project that no longer reports what it reads.
 */

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const PI_TASK = "//#type-check:pi";

/** `bun run <script> [...args]` at the repository root, without inheriting a parent turbo's state. */
const runScript = (script: string, args: readonly string[] = []) => {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("TURBO_")),
  );
  const result = spawnSync("bun", ["run", script, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...env, TURBO_TELEMETRY_DISABLED: "1", DO_NOT_TRACK: "1" },
    // `spawnSync` blocks the thread, so the vitest timeout cannot fire: the bound belongs here.
    timeout: 60_000,
  });
  if (result.error !== undefined) {
    throw new Error(`\`bun run ${script}\` failed: ${result.error.message}`);
  }
  return result;
};

interface DryRun {
  readonly tasks: readonly {
    readonly taskId: string;
    readonly command: string;
  }[];
}

describe("the gate's type-check covers the .pi skills", () => {
  it(
    "runs the .pi project as part of `bun run type-check`",
    { timeout: 90_000 },
    () => {
      const result = runScript("type-check", ["--", "--dry=json"]);
      expect(result.status, result.stderr).toBe(0);
      const dryRun = JSON.parse(result.stdout) as DryRun;
      const task = dryRun.tasks.find(
        (candidate) => candidate.taskId === PI_TASK,
      );
      expect(task?.command).toBe("tsc -p .pi/tsconfig.json");
    },
  );

  it(
    "reads every TypeScript file under .pi/skills",
    { timeout: 90_000 },
    () => {
      const tracked = spawnSync(
        "git",
        ["ls-files", "--", ":(glob).pi/skills/**/*.ts"],
        { cwd: REPO_ROOT, encoding: "utf8" },
      );
      expect(tracked.status, tracked.stderr).toBe(0);
      const skills = tracked.stdout.split("\n").filter((line) => line !== "");
      // The five files LOB-141 counted have grown since; an empty list would make this vacuous.
      expect(skills.length).toBeGreaterThanOrEqual(5);

      const listed = runScript("type-check:pi", ["--listFilesOnly"]);
      expect(listed.status, listed.stderr).toBe(0);
      const program = new Set(
        listed.stdout
          .split("\n")
          .filter((line) => line !== "")
          .map((file) => path.relative(REPO_ROOT, file)),
      );
      expect(skills.filter((file) => !program.has(file))).toEqual([]);
    },
  );

  it(
    "fails on a type error in a skill it has never seen",
    { timeout: 90_000 },
    () => {
      // A new directory, so the case proves the include glob and not a list of today's files. It is
      // removed whatever happens: a probe left behind would fail the next gate on purpose-built noise.
      const directory = mkdtempSync(
        path.join(REPO_ROOT, ".pi", "skills", "type-check-probe-"),
      );
      const probe = path.join(directory, "probe.ts");
      try {
        writeFileSync(
          probe,
          'export const deliberatelyNotAType: number = "not a number";\n',
        );
        const result = runScript("type-check:pi");
        expect(result.status).not.toBe(0);
        expect(result.stdout).toContain(
          `${path.relative(REPO_ROOT, probe)}(1,14): error TS2322`,
        );
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
});
