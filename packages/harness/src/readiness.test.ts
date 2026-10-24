import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scoreRepoReadiness } from "./readiness.js";

describe("scoreRepoReadiness", () => {
  it("scores this repo highly", () => {
    const report = scoreRepoReadiness("/opt/dev/factory-ralph");
    expect(report.score).toBe(4);
    expect(report.checks.length).toBe(4);
  });

  it("scores an empty repo zero with specific reasons", () => {
    const root = mkdtempSync(join(tmpdir(), "rr-"));
    const report = scoreRepoReadiness(root);
    expect(report.score).toBe(0);
    expect(report.checks.every((c) => !c.passed)).toBe(true);
    expect(report.checks.map((c) => c.reason).every((r) => r.length > 0)).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("rewards a configured repo", () => {
    const root = mkdtempSync(join(tmpdir(), "rr-"));
    writeFileSync(join(root, "AGENTS.md"), "# agents");
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { build: "x", test: "y" } }));
    mkdirSync(join(root, ".pi", "skills", "verify-x"), { recursive: true });
    writeFileSync(join(root, ".pi", "skills", "verify-x", "SKILL.md"), "---\nname: verify-x\n---\n");
    const report = scoreRepoReadiness(root);
    expect(report.score).toBe(4);
    rmSync(root, { recursive: true, force: true });
  });

  it("differs between repos", () => {
    const empty = mkdtempSync(join(tmpdir(), "rr-"));
    const full = mkdtempSync(join(tmpdir(), "rr-"));
    writeFileSync(join(full, "AGENTS.md"), "# agents");
    const a = scoreRepoReadiness(empty);
    const b = scoreRepoReadiness(full);
    expect(a.score).not.toBe(b.score);
    rmSync(empty, { recursive: true, force: true });
    rmSync(full, { recursive: true, force: true });
  });
});
