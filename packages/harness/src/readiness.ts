import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

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

function fileNonEmpty(path: string): boolean {
  try {
    return statSync(path).isFile() && readFileSync(path, "utf8").trim().length > 0;
  } catch {
    return false;
  }
}

function hasVerifySkills(root: string): boolean {
  const dir = join(root, ".pi", "skills");
  try {
    return readdirSync(dir).some((name) => name.startsWith("verify-") && statSync(join(dir, name)).isDirectory());
  } catch {
    return false;
  }
}

function hasSkillDir(root: string): boolean {
  const dir = join(root, ".pi", "skills");
  try {
    return statSync(dir).isDirectory() && readdirSync(dir).some((name) => existsSync(join(dir, name, "SKILL.md")));
  } catch {
    return false;
  }
}

function hasPackageScripts(root: string): { ok: boolean; reason: string } {
  const pkgPath = join(root, "package.json");
  if (!fileNonEmpty(pkgPath)) return { ok: false, reason: "no package.json" };
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { scripts?: Record<string, string> };
    const scripts = pkg.scripts ?? {};
    const missing: string[] = [];
    if (!scripts["test"]) missing.push("test");
    if (!scripts["build"]) missing.push("build");
    if (missing.length) return { ok: false, reason: `package.json missing scripts: ${missing.join(", ")}` };
    return { ok: true, reason: "package.json has build and test scripts" };
  } catch {
    return { ok: false, reason: "package.json is not valid JSON" };
  }
}

export function scoreRepoReadiness(root: string): ReadinessReport {
  const checks: ReadinessCheck[] = [];

  const agentsPath = join(root, "AGENTS.md");
  const agentsOk = fileNonEmpty(agentsPath);
  checks.push({
    name: "agents-md",
    passed: agentsOk,
    reason: agentsOk ? "AGENTS.md present and non-empty" : "missing or empty AGENTS.md",
  });

  const scripts = hasPackageScripts(root);
  checks.push({ name: "package-scripts", passed: scripts.ok, reason: scripts.reason });

  const verify = hasVerifySkills(root);
  checks.push({
    name: "verify-skills",
    passed: verify,
    reason: verify ? "at least one .pi/skills/verify-* skill" : "no .pi/skills/verify-* skill directory",
  });

  const skills = hasSkillDir(root);
  checks.push({
    name: "skill-dir",
    passed: skills,
    reason: skills ? ".pi/skills contains a SKILL.md" : "no .pi/skills SKILL.md",
  });

  const score = checks.filter((c) => c.passed).length;
  return { score, max: checks.length, checks };
}
