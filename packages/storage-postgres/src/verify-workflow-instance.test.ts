import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

/**
 * `verify-workflow`'s instance stops only what it started, and reads back what it recorded whole
 * (LOB-40).
 *
 * verify-workflow runs the loop on verify-board's instance, whose files live in `.verify/run` — one
 * per worktree. A verify-board instance that was already running there is someone else's: `up.sh`
 * must refuse before it makes anything, and `down.sh` must stop verify-board's instance only when
 * `up.sh` launched it (the `board-owned` marker), or a failed `up.sh` followed by `cycle.sh`'s
 * unconditional `down.sh` kills the other instance's API and deletes its sessions.
 *
 * `instance.json` holds the owner's text in live mode — the label, and the gate, which is a
 * comma-separated list of command prefixes (`APPROVAL_REQUIRED`) — so it is read as JSON: a value
 * holding a comma or a quote reads back whole, and the API is never started with an empty gate.
 *
 * Every case runs the real scripts copied into a scratch repo layout, against a `sleep` standing in
 * for the other instance's process, with `DATABASE_URL` at a closed port: nothing here needs, or can
 * reach, a database. Beside `verify-workflow-live.test.ts`, for the same reason. Each case names the
 * mutation it was checked against on a `// Mutation checked:` line.
 */

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const SKILL = ".pi/skills/verify-workflow";

const created: string[] = [];
const sleepers: ChildProcess[] = [];
afterAll(() => {
  for (const sleeper of sleepers) sleeper.kill("SIGKILL");
  for (const root of created) rmSync(root, { recursive: true, force: true });
}, 60_000);

/** A scratch repo holding the workflow skill, verify-board's scripts and the shared Postgres lib. */
const stage = (): string => {
  const root = mkdtempSync(
    path.join(tmpdir(), "factory-verify-workflow-instance-"),
  );
  created.push(root);
  for (const dir of [SKILL, ".pi/skills/verify-board", ".pi/skills/lib"]) {
    mkdirSync(path.join(root, dir), { recursive: true });
    cpSync(path.join(REPO_ROOT, dir), path.join(root, dir), {
      recursive: true,
    });
  }
  return root;
};

/** A process that is alive until the suite ends: the other instance's API, as far as a pidfile says. */
const sleeper = (): number => {
  const child = spawn("sleep", ["120"], { stdio: "ignore" });
  sleepers.push(child);
  if (child.pid === undefined) throw new Error("sleep did not start");
  return child.pid;
};

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** A running verify-board instance in the scratch repo: an API pidfile and a session root. */
const otherBoard = (root: string): number => {
  const run = path.join(root, ".verify/run");
  mkdirSync(path.join(run, "sessions"), { recursive: true });
  const pid = sleeper();
  writeFileSync(path.join(run, "api.pid"), `${pid}\n`);
  return pid;
};

const bash = (
  root: string,
  args: ReadonlyArray<string>,
  env: Record<string, string> = {},
) => {
  // Built from nothing but PATH and HOME, as `verify-workflow-live.test.ts` builds its own: nothing
  // in the developer's shell decides a case. `Object.entries` keeps the repo's Effect lint from
  // reading this as configuration.
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && (entry[0] === "PATH" || entry[0] === "HOME"),
    ),
  );
  const result = spawnSync("bash", [...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 60_000,
    env: {
      ...inherited,
      // A closed port: a script that got past its refusal finds no database rather than a real one.
      DATABASE_URL:
        "postgres://factory:factory@127.0.0.1:9/factory_instance_test",
      ...env,
    },
  });
  expect(result.signal, `bash ${args.join(" ")}: ${result.stderr}`).toBeNull();
  return result;
};

describe("verify-workflow stops only what it started", () => {
  it(
    "up.sh refuses, before it makes anything, when a verify-board instance is already running",
    { timeout: 90_000 },
    () => {
      // Mutation checked: removing `board_alive`'s refusal from up.sh lets it through to the port
      // and Postgres checks, which create `.verify/run/workflow` (the `mkdir -p "$WF_DIR"`) and exit
      // without naming the other instance — both assertions below redden.
      const root = stage();
      const pid = otherBoard(root);
      const result = bash(root, [path.join(root, SKILL, "up.sh")]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        `a verify-board instance is already running`,
      );
      expect(result.stderr).toContain(`api pid ${pid}`);
      expect(existsSync(path.join(root, ".verify/run/workflow"))).toBe(false);
      expect(alive(pid)).toBe(true);
    },
  );

  it(
    "down.sh leaves a verify-board instance it did not launch alone",
    { timeout: 90_000 },
    () => {
      // Mutation checked: calling verify-board's down.sh unconditionally (the reviewed bug) kills
      // the sleeper and deletes `sessions`; both assertions redden.
      const root = stage();
      const pid = otherBoard(root);
      mkdirSync(path.join(root, ".verify/run/workflow"), { recursive: true });
      const result = bash(root, [path.join(root, SKILL, "down.sh")]);
      expect(result.status, result.stderr).toBe(0);
      expect(alive(pid)).toBe(true);
      expect(existsSync(path.join(root, ".verify/run/sessions"))).toBe(true);
      expect(existsSync(path.join(root, ".verify/run/api.pid"))).toBe(true);
    },
  );

  it(
    "down.sh stops verify-board's instance when up.sh launched it (the control)",
    { timeout: 90_000 },
    () => {
      // Mutation checked: a down.sh that never stops verify-board's instance (the marker test
      // inverted, or the call dropped) leaves the sleeper alive; without this case the one above
      // could pass vacuously.
      const root = stage();
      const pid = otherBoard(root);
      const workflow = path.join(root, ".verify/run/workflow");
      mkdirSync(workflow, { recursive: true });
      writeFileSync(path.join(workflow, "board-owned"), "");
      const result = bash(root, [path.join(root, SKILL, "down.sh")]);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(`stopped api (pid ${pid})`);
      expect(existsSync(path.join(root, ".verify/run/sessions"))).toBe(false);
      expect(existsSync(workflow)).toBe(false);
    },
  );
});

describe("verify-workflow's instance.json reads back whole", () => {
  it(
    "a comma-separated gate and a label with a comma and a quote reach the API's environment intact",
    { timeout: 90_000 },
    () => {
      // Mutation checked: the old sed reader (`[^\",]*`) answers an empty APPROVAL_REQUIRED and an
      // empty label for these values, which reddens the first two assertions.
      const root = stage();
      const workflow = path.join(root, ".verify/run/workflow");
      mkdirSync(workflow, { recursive: true });
      writeFileSync(
        path.join(workflow, "instance.json"),
        JSON.stringify(
          {
            mode: "faux",
            apiUrl: "http://localhost:9500",
            webUrl: "http://localhost:3500",
            apiPort: 9500,
            webPort: 3500,
            githubPort: 9501,
            linearPort: 9502,
            gitPort: 9503,
            database: "factory_wf_1",
            repo: "verify-workflow/run-1",
            label: 'factory, "now"',
            approvalRequired: "git commit,git push",
            stamp: "1",
          },
          null,
          2,
        ),
      );
      writeFileSync(path.join(workflow, "linear-secret"), "secret\n");
      writeFileSync(path.join(workflow, "forge-token"), "token\n");
      const result = bash(root, [
        "-c",
        [
          `ROOT="${root}" WF_DIR="${workflow}"`,
          `WORKFLOW_BASE_URL="postgres://u:p@127.0.0.1:9/base"`,
          `source "${path.join(root, SKILL, "instance-env.sh")}"`,
          "workflow_export_env",
          `printf 'gate=%s\\n' "$APPROVAL_REQUIRED"`,
          `printf 'rules=%s\\n' "$TRIGGER_RULES"`,
          `printf 'db=%s\\n' "$DATABASE_URL"`,
          `printf 'port=%s\\n' "$API_PORT"`,
          `printf 'missing=[%s]\\n' "$(workflow_field nothing)"`,
        ].join("; "),
      ]);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("gate=git commit,git push\n");
      const rules = /^rules=(.*)$/m.exec(result.stdout)?.[1] ?? "[]";
      expect(JSON.parse(rules)).toEqual([
        {
          label: 'factory, "now"',
          repo: "verify-workflow/run-1",
          baseRef: "main",
          prompt: "",
          mode: "card",
        },
      ]);
      expect(result.stdout).toContain(
        "db=postgres://u:p@127.0.0.1:9/factory_wf_1\n",
      );
      expect(result.stdout).toContain("port=9500\n");
      expect(result.stdout).toContain("missing=[]\n");
    },
  );
});
