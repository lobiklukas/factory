/**
 * How ready a checkout is for an agent to work in (LOB-29): four checks, each with its reason.
 *
 * Read through the `FileSystem` and `Path` services (S-env-setup): the control plane scores a
 * registered checkout on every repo read, and a synchronous walk would hold the API's event loop once
 * per repo per poll. Nothing here fails: a path that cannot be read is a check that did not pass.
 */
import { Effect, FileSystem, Path } from "effect";

export interface ReadinessCheck {
  readonly name: string;
  readonly passed: boolean;
  readonly reason: string;
}

export interface ReadinessReport {
  readonly score: number;
  readonly max: number;
  readonly checks: readonly ReadinessCheck[];
}

type Deps = {
  readonly fs: FileSystem.FileSystem;
  readonly path: Path.Path;
};

const isType = (
  deps: Deps,
  file: string,
  type: FileSystem.File.Type,
): Effect.Effect<boolean> =>
  deps.fs.stat(file).pipe(
    Effect.map((info) => info.type === type),
    Effect.orElseSucceed(() => false),
  );

/** A file's text, or `undefined` when it is not a readable file. */
const fileText = (
  deps: Deps,
  file: string,
): Effect.Effect<string | undefined> =>
  Effect.gen(function* () {
    if (!(yield* isType(deps, file, "File"))) return undefined;
    return yield* deps.fs
      .readFileString(file)
      .pipe(Effect.orElseSucceed(() => undefined));
  });

const entries = (
  deps: Deps,
  dir: string,
): Effect.Effect<ReadonlyArray<string>> =>
  deps.fs.readDirectory(dir).pipe(Effect.orElseSucceed(() => []));

const someOf = (
  names: ReadonlyArray<string>,
  test: (name: string) => Effect.Effect<boolean>,
): Effect.Effect<boolean> =>
  Effect.map(
    Effect.forEach(names, test, { concurrency: "unbounded" }),
    (passed) => passed.some(Boolean),
  );

const hasVerifySkills = (deps: Deps, root: string): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const dir = deps.path.join(root, ".pi", "skills");
    const names = (yield* entries(deps, dir)).filter((name) =>
      name.startsWith("verify-"),
    );
    return yield* someOf(names, (name) =>
      isType(deps, deps.path.join(dir, name), "Directory"),
    );
  });

const hasSkillDir = (deps: Deps, root: string): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const dir = deps.path.join(root, ".pi", "skills");
    return yield* someOf(yield* entries(deps, dir), (name) =>
      isType(deps, deps.path.join(dir, name, "SKILL.md"), "File"),
    );
  });

const packageScripts = (
  text: string | undefined,
): { ok: boolean; reason: string } => {
  if (text === undefined || text.trim().length === 0)
    return { ok: false, reason: "no package.json" };
  try {
    const pkg = JSON.parse(text) as {
      scripts?: Record<string, string>;
    };
    const scripts = pkg.scripts ?? {};
    const missing: string[] = [];
    if (!scripts["test"]) missing.push("test");
    if (!scripts["build"]) missing.push("build");
    if (missing.length)
      return {
        ok: false,
        reason: `package.json missing scripts: ${missing.join(", ")}`,
      };
    return { ok: true, reason: "package.json has build and test scripts" };
  } catch {
    return { ok: false, reason: "package.json is not valid JSON" };
  }
};

export const scoreRepoReadiness = (
  root: string,
): Effect.Effect<ReadinessReport, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const deps: Deps = {
      fs: yield* FileSystem.FileSystem,
      path: yield* Path.Path,
    };
    const { agents, pkg, verify, skills } = yield* Effect.all(
      {
        agents: fileText(deps, deps.path.join(root, "AGENTS.md")),
        pkg: fileText(deps, deps.path.join(root, "package.json")),
        verify: hasVerifySkills(deps, root),
        skills: hasSkillDir(deps, root),
      },
      { concurrency: "unbounded" },
    );
    const agentsOk = (agents ?? "").trim().length > 0;
    const scripts = packageScripts(pkg);
    const checks: ReadinessCheck[] = [
      {
        name: "agents-md",
        passed: agentsOk,
        reason: agentsOk
          ? "AGENTS.md present and non-empty"
          : "missing or empty AGENTS.md",
      },
      {
        name: "package-scripts",
        passed: scripts.ok,
        reason: scripts.reason,
      },
      {
        name: "verify-skills",
        passed: verify,
        reason: verify
          ? "at least one .pi/skills/verify-* skill"
          : "no .pi/skills/verify-* skill directory",
      },
      {
        name: "skill-dir",
        passed: skills,
        reason: skills
          ? ".pi/skills contains a SKILL.md"
          : "no .pi/skills SKILL.md",
      },
    ];
    const score = checks.filter((c) => c.passed).length;
    return { score, max: checks.length, checks };
  });
