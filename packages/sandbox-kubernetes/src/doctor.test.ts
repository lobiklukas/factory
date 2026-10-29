/**
 * `.pi/skills/verify-sandbox/doctor.sh` never skips (LOB-89): without kind it fails at once, naming
 * the tool, and with a cluster that is not this repository's it says `NOT READY` and exits 1.
 *
 * Hermetic: `PATH` is a fresh directory holding only the commands the case allows — symlinks to the
 * system's `dirname`, `tr`, `grep`, `awk` and `head`, and hand-written `kind`, `kubectl` and `docker` stubs where a case
 * needs them — so whatever is installed on the machine running the gate (CI images ship kind) plays
 * no part. The stubs model only what the doctor asks; what the real tools answer is the drive's.
 * Each case gets 30 s: a fresh executable's first run can take most of a second on macOS, and the
 * doctor runs a dozen.
 */
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const DOCTOR = join(
  import.meta.dirname,
  "../../../.pi/skills/verify-sandbox/doctor.sh",
);
const scratch = mkdtempSync(join(tmpdir(), "factory-doctor-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const which = (tool: string): string =>
  spawnSync("/bin/sh", ["-c", `command -v ${tool}`], {
    encoding: "utf8",
  }).stdout.trim();

/** A PATH directory with the basics the script needs and `stubs` as executables. */
const pathWith = (stubs: Record<string, string>): string => {
  const bin = mkdtempSync(join(scratch, "bin-"));
  for (const tool of ["dirname", "tr", "grep", "awk", "head"])
    symlinkSync(which(tool), join(bin, tool));
  for (const [name, body] of Object.entries(stubs)) {
    const file = join(bin, name);
    writeFileSync(file, `#!/bin/sh\n${body}\n`);
    chmodSync(file, 0o755);
  }
  return bin;
};

const doctor = (path: string) =>
  spawnSync("/bin/bash", [DOCTOR], {
    encoding: "utf8",
    env: { PATH: path, KIND_CLUSTER: "factory-sandbox" },
  });

describe("verify-sandbox doctor", { timeout: 30_000 }, () => {
  it("fails loudly, naming kind, when kind is not installed", () => {
    const run = doctor(pathWith({}));
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("kind:");
    expect(run.stdout).toContain("NOT INSTALLED");
    expect(run.stderr).toContain(
      "doctor: NOT READY — kind is required and missing",
    );
  });

  it("fails, naming the tool, when kind is there but kubectl is not", () => {
    const run = doctor(pathWith({ kind: "exit 0" }));
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("kubectl is required and missing");
  });

  it("fails when the cluster does not exist, rather than skipping the checks after it", () => {
    const run = doctor(
      pathWith({
        kind: 'case "$1" in version) echo "kind v0.33.0";; get) echo other-cluster;; esac',
        kubectl: "exit 1",
        docker: "exit 0",
      }),
    );
    expect(run.status).toBe(1);
    expect(run.stdout).toMatch(/cluster factory-sandbox:\s+MISSING/);
    expect(run.stderr).toContain("doctor: NOT READY");
  });

  it("is NOT READY when the cluster answers but holds no agent-sandbox controller or image", () => {
    const run = doctor(
      pathWith({
        kind: 'case "$1" in version) echo "kind v0.33.0";; get) echo factory-sandbox;; esac',
        // The API server answers; every resource the doctor asks about is missing.
        kubectl: 'case "$*" in *readyz*) exit 0;; *) exit 1;; esac',
        docker: 'case "$1" in info) exit 0;; *) exit 1;; esac',
      }),
    );
    expect(run.status).toBe(1);
    expect(run.stdout).toMatch(/Sandbox CRD:\s+MISSING/);
    expect(run.stdout).toMatch(/controller:\s+NOT AVAILABLE/);
    expect(run.stdout).toMatch(
      /sandbox image:\s+factory-sandbox:0\.1\.0 NOT LOADED/,
    );
    expect(run.stderr).toContain("doctor: NOT READY");
    expect(run.stdout).not.toContain("doctor: READY");
  });
});
