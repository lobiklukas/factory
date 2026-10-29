import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

/**
 * `verify-board`'s `equivalence.sh` runs the surfaces' own drives rather than duplicating them, one
 * at a time, and exits non-zero on any miss (LOB-87).
 *
 * The phase's worth is in what it composes: verify-cli's drive, verify-web's drive and this skill's
 * drive (whose both-ways phase is the cross-check), each against an instance it brings up and down
 * before the next starts — the skills share `.verify/run/api.pid`, and verify-web's `down.sh`
 * removes `.verify/run` whole. These cases run the real script, copied into a scratch repo layout,
 * against fake `up.sh`/`drive.sh`/`down.sh` scripts (and a fake `node` for verify-web's `drive.mjs`)
 * that journal how they were called and exit as a case tells them to. No database, port or browser
 * is touched: the real drives are run by the skill's own proof, not by `bun run test`.
 *
 * Beside `verify-board-doctor.test.ts`, for the same reason: a repo-level claim about a skill script
 * that belongs to no package. Each case names the mutation it was checked against.
 */

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const SCRIPT = ".pi/skills/verify-board/equivalence.sh";

const created: string[] = [];
afterAll(() => {
  for (const root of created) rmSync(root, { recursive: true, force: true });
  // Past vitest's 10 s hook default on a loaded machine, as the cases' bounds are (DEFLAKE).
}, 60_000);

const writeExecutable = (file: string, body: string): void => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(file, 0o755);
};

/**
 * One journal line per call: the step's name and the environment the phase is meant to hand it.
 * The exit code is `FAKE_EXIT_<step>` (e.g. `FAKE_EXIT_web_drive`), 0 when the case sets none.
 */
const fake = (step: string): string =>
  [
    `printf '%s API_PORT=%s WEB_PORT=%s GITHUB_PORT=%s APPROVE_PORT=%s API_URL=%s WEB_URL=%s EVIDENCE_DIR=%s DATABASE_URL=%s\\n' \\`,
    `  ${step} "\${API_PORT:-}" "\${WEB_PORT:-}" "\${GITHUB_PORT:-}" "\${APPROVE_PORT:-}" \\`,
    `  "\${API_URL:-}" "\${WEB_URL:-}" "\${EVIDENCE_DIR:-}" "\${DATABASE_URL:-}" >> "$FAKE_JOURNAL"`,
    `exit "\${FAKE_EXIT_${step.replace("-", "_")}:-0}"`,
  ].join("\n");

/** A scratch repo holding the phase and a fake of every script it runs. */
const stage = (): { root: string; bin: string; journal: string } => {
  const root = mkdtempSync(path.join(tmpdir(), "factory-verify-equivalence-"));
  created.push(root);
  const staged = path.join(root, SCRIPT);
  mkdirSync(path.dirname(staged), { recursive: true });
  cpSync(path.join(REPO_ROOT, SCRIPT), staged);
  const skills = path.join(root, ".pi/skills");
  for (const [surface, skill] of [
    ["cli", "verify-cli"],
    ["web", "verify-web"],
    ["board", "verify-board"],
  ] as const) {
    writeExecutable(path.join(skills, skill, "up.sh"), fake(`${surface}-up`));
    writeExecutable(
      path.join(skills, skill, "down.sh"),
      fake(`${surface}-down`),
    );
  }
  writeExecutable(path.join(skills, "verify-cli/drive.sh"), fake("cli-drive"));
  writeExecutable(
    path.join(skills, "verify-board/drive.sh"),
    fake("board-drive"),
  );
  // verify-web's drive is `node drive.mjs`: the fake `node` journals only when handed that file.
  const bin = path.join(root, "bin");
  writeExecutable(
    path.join(bin, "node"),
    [
      `case "$1" in`,
      `  */.pi/skills/verify-web/drive.mjs) ;;`,
      `  *) echo "unexpected node $*" >> "$FAKE_JOURNAL"; exit 99 ;;`,
      `esac`,
      fake("web-drive"),
    ].join("\n"),
  );
  return { root, bin, journal: path.join(root, "journal") };
};

const run = (
  staged: { root: string; bin: string; journal: string },
  env: Readonly<Record<string, string>>,
) => {
  // `Object.entries`, not `process.env["NAME"]`: the repo's Effect lint reads a direct property
  // access as configuration, and a test inheriting the shell's environment configures nothing.
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined &&
        !/^(API_PORT|WEB_PORT|GITHUB_PORT|APPROVE_PORT|EVIDENCE_DIR|DATABASE_URL|FAKE_)/.test(
          entry[0],
        ),
    ),
  );
  writeFileSync(staged.journal, "");
  // The phase runs nine fake scripts, each its own `bash`: beside a full `bun run test` it outran the
  // 20 s this bound was, and the kill left a journal a step or more short (DEFLAKE). A kill is said
  // as one, below, rather than read as a phase that skipped its steps.
  const result = spawnSync("bash", [path.join(staged.root, SCRIPT)], {
    encoding: "utf8",
    timeout: 90_000,
    env: {
      ...inherited,
      PATH: `${staged.bin}${path.delimiter}${inherited["PATH"] ?? ""}`,
      FAKE_JOURNAL: staged.journal,
      ...env,
    },
  });
  expect(result.signal, `the phase was killed: ${result.stderr}`).toBeNull();
  const lines = readFileSync(staged.journal, "utf8")
    .split("\n")
    .filter((line) => line !== "");
  return {
    ...result,
    lines,
    steps: lines.map((line) => line.split(" ")[0]),
    line: (step: string) => lines.find((line) => line.startsWith(`${step} `)),
  };
};

const DATABASE_URL = "postgres://factory:factory@localhost:1/factory_scratch";
const PORTS = {
  API_PORT: "9500",
  WEB_PORT: "3500",
  APPROVE_PORT: "9501",
  GITHUB_PORT: "9503",
};

describe("verify-board's equivalence phase", () => {
  it(
    "runs verify-cli, verify-web and the board drive, one instance at a time, and passes when all do",
    { timeout: 120_000 },
    () => {
      // Mutation checked: dropping the `surface web` line reddens the order assertion (the phase
      // would no longer run verify-web), and running a surface's down.sh before its drive reddens it
      // too; handing verify-cli's drive no APPROVE_PORT reddens the env assertion.
      const staged = stage();
      const result = run(staged, { DATABASE_URL, ...PORTS });
      expect(result.steps).toEqual([
        "cli-up",
        "cli-drive",
        "cli-down",
        "web-up",
        "web-drive",
        "web-down",
        "board-up",
        "board-drive",
        "board-down",
      ]);
      const evidence = path.join(staged.root, ".verify/evidence/latest");
      expect(result.line("cli-up")).toContain("API_PORT=9500");
      expect(result.line("cli-drive")).toContain(
        `API_URL=http://localhost:9500`,
      );
      expect(result.line("cli-drive")).toContain("APPROVE_PORT=9501");
      expect(result.line("cli-drive")).toContain(`EVIDENCE_DIR=${evidence} `);
      expect(result.line("web-up")).toContain("WEB_PORT=3500");
      expect(result.line("web-drive")).toContain(
        "WEB_URL=http://localhost:3500",
      );
      expect(result.line("web-drive")).toContain(
        `EVIDENCE_DIR=${evidence}/web `,
      );
      expect(result.line("board-up")).toContain("GITHUB_PORT=9503");
      expect(result.line("board-drive")).toContain(
        "WEB_URL=http://localhost:3500",
      );
      for (const line of result.lines)
        expect(line).toContain(`DATABASE_URL=${DATABASE_URL}`);
      const observed = JSON.parse(
        readFileSync(path.join(evidence, "equivalence/observed.json"), "utf8"),
      ) as { steps: Record<string, number> };
      expect(Object.keys(observed.steps)).toEqual(result.steps);
      expect(Object.values(observed.steps).every((rc) => rc === 0)).toBe(true);
      expect(result.stdout).toContain(
        "equivalence: verify-cli, verify-web and verify-board all passed",
      );
      expect(result.status).toBe(0);
    },
  );

  it(
    "exits non-zero when one surface's drive fails, and still runs the others",
    { timeout: 120_000 },
    () => {
      // Mutation checked: dropping `failed=1` from run_step makes the phase exit 0 here, and
      // stopping at the first failure drops the board's steps from the journal.
      const staged = stage();
      const result = run(staged, {
        DATABASE_URL,
        ...PORTS,
        FAKE_EXIT_web_drive: "3",
      });
      expect(result.steps).toEqual([
        "cli-up",
        "cli-drive",
        "cli-down",
        "web-up",
        "web-drive",
        "web-down",
        "board-up",
        "board-drive",
        "board-down",
      ]);
      const observed = JSON.parse(
        readFileSync(
          path.join(
            staged.root,
            ".verify/evidence/latest/equivalence/observed.json",
          ),
          "utf8",
        ),
      ) as { steps: Record<string, number> };
      expect(observed.steps["web-drive"]).toBe(3);
      expect(result.stdout).toMatch(/FAIL {2}web-drive +exit=3/);
      expect(result.stderr).toContain("equivalence: FAILURES");
      expect(result.status).toBe(1);
    },
  );

  it(
    "does not drive a surface whose instance did not come up, and still brings it down",
    { timeout: 120_000 },
    () => {
      // Mutation checked: running the drive whatever up.sh returned puts `board-drive` in the
      // journal; skipping down.sh after a failed up drops `board-down` — a half-started instance
      // would be left holding the ports and the pid file.
      const staged = stage();
      const result = run(staged, {
        DATABASE_URL,
        ...PORTS,
        FAKE_EXIT_board_up: "1",
      });
      expect(result.steps.slice(-2)).toEqual(["board-up", "board-down"]);
      expect(result.steps).not.toContain("board-drive");
      expect(result.status).toBe(1);
    },
  );

  it(
    "refuses to start without a database, or while another instance is up",
    { timeout: 120_000 },
    () => {
      // Mutation checked: removing either guard runs the fakes, and the journal is no longer empty.
      const staged = stage();
      const noDatabase = run(staged, PORTS);
      expect(noDatabase.stderr).toContain("DATABASE_URL is not set");
      expect(noDatabase.lines).toEqual([]);
      expect(noDatabase.status).toBe(1);

      const runDir = path.join(staged.root, ".verify/run");
      mkdirSync(runDir, { recursive: true });
      writeFileSync(path.join(runDir, "api.pid"), String(process.pid));
      const busy = run(staged, { DATABASE_URL, ...PORTS });
      expect(busy.stderr).toContain("an instance is already up");
      expect(busy.lines).toEqual([]);
      expect(busy.status).toBe(1);
    },
  );
});
