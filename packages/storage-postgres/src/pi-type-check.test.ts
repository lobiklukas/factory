import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
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
      // A new directory, so the case proves the include glob and not a list of today's files. The
      // probe never enters the checkout: a deliberately broken file under `.pi/skills` would fail a
      // `type-check`, `lint` or `format:check` running beside this suite, and would outlive a
      // SIGKILLed vitest. Instead `.pi/tsconfig.json` is mirrored into a temporary `.pi/` with its
      // `include` and `compilerOptions` verbatim, `extends` rebased and `typeRoots` named, so the glob under test
      // is the gate's own; the gate's tsc is run over the mirror exactly as `type-check:pi` runs it.
      const manifest = JSON.parse(
        readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"),
      ) as { readonly scripts: Readonly<Record<string, string>> };
      expect(manifest.scripts["type-check:pi"]).toBe(
        "tsc -p .pi/tsconfig.json",
      );
      const config = JSON.parse(
        readFileSync(path.join(REPO_ROOT, ".pi", "tsconfig.json"), "utf8"),
      ) as {
        readonly extends: string;
        readonly $schema?: string;
        readonly compilerOptions: Readonly<Record<string, unknown>>;
      };

      const mirror = mkdtempSync(path.join(tmpdir(), "pi-type-check-"));
      try {
        const piDir = path.join(mirror, ".pi");
        const skillDir = path.join(piDir, "skills", "type-check-probe");
        mkdirSync(skillDir, { recursive: true });
        const { $schema: _schema, ...rest } = config;
        writeFileSync(
          path.join(piDir, "tsconfig.json"),
          JSON.stringify({
            ...rest,
            extends: path.resolve(REPO_ROOT, ".pi", config.extends),
            compilerOptions: {
              ...config.compilerOptions,
              // A temporary directory has no `node_modules` above it; this names the one tsc walks
              // up to from the real `.pi/`, so `types: ["bun"]` resolves as it does in the gate.
              typeRoots: [path.join(REPO_ROOT, "node_modules", "@types")],
            },
          }),
        );
        const probe = path.join(skillDir, "probe.ts");
        writeFileSync(
          probe,
          'export const deliberatelyNotAType: number = "not a number";\n',
        );
        const result = spawnSync(
          path.join(REPO_ROOT, "node_modules", ".bin", "tsc"),
          ["-p", path.join(".pi", "tsconfig.json")],
          // `tsc` prints paths relative to its cwd, so the mirror root stands in for the repo root.
          { cwd: mirror, encoding: "utf8", timeout: 60_000 },
        );
        expect(result.error).toBeUndefined();
        expect(result.status).not.toBe(0);
        expect(result.stdout).toContain(
          `${path.relative(mirror, probe)}(1,14): error TS2322`,
        );
      } finally {
        rmSync(mirror, { recursive: true, force: true });
      }
    },
  );
});
