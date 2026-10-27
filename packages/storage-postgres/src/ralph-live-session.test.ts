import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

/**
 * A restarted ralph run must not take a worktree a previous run's worker session is still in
 * (LOB-120).
 *
 * `.pi/ralph/loop.sh`'s `lock` belongs to the driver: a driver killed mid-iteration leaves a dead
 * pid in it, which the next run reads as stale, while the `pi` it launched keeps working in `$WT`.
 * The next run then reset the worktree under that session — switched its branch, committed its
 * half-done work as WIP — and launched a second session beside it. The driver now records the
 * session's pid and start time in `$STATE/session` while it runs (`with_timeout`), and
 * `take_worktree` refuses `run`, `setup` and `audit` while that record names a live process.
 *
 * No model, network or database. `pi` is a fake first on `PATH` that logs each call and either
 * answers `<promise>NEXT</promise>` or plays a live session: it checks out a `ralph/*` branch, leaves
 * a file in the tree, leaves the driver's process group and sleeps. `$HOME` is a scratch directory,
 * `origin` is a bare repository in it, and `$WT` is a clone of that, so `reset_worktree`'s fetch and
 * switch run for real. The driver is sourced the way `ralph-parallel.test.ts` sources it, with
 * `ensure_db`, `release_idle_claims` and `arm_automerge` stubbed — the three that reach Postgres
 * and GitHub. Each case names the mutation it was checked against.
 */

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const LOOP = path.join(REPO_ROOT, ".pi/ralph/loop.sh");

const created: string[] = [];
const spawned: number[] = [];
afterAll(() => {
  for (const pid of spawned) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // already gone
    }
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  for (const root of created) rmSync(root, { recursive: true, force: true });
});

interface Scratch {
  readonly root: string;
  readonly home: string;
  readonly bin: string;
  /** The worktree the driver takes: a clone of `origin`. */
  readonly wt: string;
  /** One line per `pi` call: `<pid> <cwd>`. */
  readonly piCalls: string;
}

const IDENTITY = {
  GIT_AUTHOR_NAME: "ralph-test",
  GIT_AUTHOR_EMAIL: "ralph-test@localhost",
  GIT_COMMITTER_NAME: "ralph-test",
  GIT_COMMITTER_EMAIL: "ralph-test@localhost",
};

const git = (cwd: string, ...args: string[]): string => {
  const run = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...cleanEnv(), ...IDENTITY },
  });
  if (run.status !== 0) {
    throw new Error(`git ${args.join(" ")}: ${run.stderr}`);
  }
  return run.stdout.trim();
};

/** The parent's environment without anything that would steer the driver, `pi` or git. */
const cleanEnv = (): Record<string, string> => {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  for (const key of Object.keys(env)) {
    if (/^(RALPH_|PI_|GIT_)/.test(key) || key === "DOCKER_HOST") {
      delete env[key];
    }
  }
  return env;
};

/** The fake `pi`. `FAKE_PI_HOLD=<file>`: play a live session and touch `<file>` once it is in place. */
const FAKE_PI = [
  "#!/usr/bin/env bash",
  'echo "$$ $PWD" >> "$PI_CALLS"',
  'if [ -n "${FAKE_PI_HOLD:-}" ]; then',
  "  git switch -q -c ralph/LOB-1 && echo half-done > wip.txt",
  // Out of the driver's process group, and only then ready, so killing the driver's group leaves
  // this one working; the pid survives both `exec`s, so it is the pid the driver recorded.
  '  exec perl -MPOSIX -e \'POSIX::setsid(); open(my $f, ">", $ENV{FAKE_PI_HOLD}) or die; close($f); exec "sleep", "120"\'',
  "fi",
  "echo '<promise>NEXT</promise>'",
  "",
].join("\n");

const mkScratch = (): Scratch => {
  const root = mkdtempSync(path.join(tmpdir(), "factory-ralph-live-session-"));
  created.push(root);
  const home = path.join(root, "home");
  const bin = path.join(root, "bin");
  mkdirSync(home, { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(bin, "pi"), FAKE_PI);
  chmodSync(path.join(bin, "pi"), 0o755);
  writeFileSync(path.join(bin, "gh"), "#!/usr/bin/env bash\nexit 0\n");
  chmodSync(path.join(bin, "gh"), 0o755);

  const seed = path.join(root, "seed");
  mkdirSync(path.join(seed, ".pi/ralph"), { recursive: true });
  writeFileSync(path.join(seed, ".pi/ralph/work.prompt.md"), "work\n");
  git(seed, "init", "-q", "-b", "main");
  git(seed, "add", ".");
  git(seed, "commit", "-q", "-m", "seed");
  const origin = path.join(root, "origin.git");
  git(root, "clone", "-q", "--bare", seed, origin);
  const wt = path.join(root, "wt");
  git(root, "clone", "-q", origin, wt);
  return { root, home, bin, wt, piCalls: path.join(root, "pi-calls.txt") };
};

const env = (
  scratch: Scratch,
  extra: Record<string, string>,
): Record<string, string> => ({
  ...cleanEnv(),
  ...IDENTITY,
  PATH: `${scratch.bin}${path.delimiter}${cleanEnv()["PATH"] ?? ""}`,
  HOME: scratch.home,
  LOOP,
  PI_CALLS: scratch.piCalls,
  RALPH_WORKTREE: scratch.wt,
  RALPH_SHARED: path.join(scratch.root, "shared"),
  RALPH_MAX_ITER: "1",
  RALPH_SLEEP: "0",
  RALPH_FALLBACK_MODELS: "",
  RALPH_PUSH: "0",
  RALPH_MERGE: "0",
  ...extra,
});

/** `loop.sh run`, minus the three calls that reach Postgres and GitHub. */
const RUN = [
  'source "$LOOP"',
  "ensure_db() { :; }; release_idle_claims() { :; }; arm_automerge() { :; }",
  "cmd_run",
].join("\n");

const sh = (
  scratch: Scratch,
  body: string,
  extra: Record<string, string> = {},
) => {
  const run = spawnSync("bash", ["-c", body], {
    cwd: scratch.root,
    encoding: "utf8",
    timeout: 60_000,
    env: env(scratch, extra),
  });
  return {
    status: run.status ?? -1,
    stdout: run.stdout,
    stderr: run.stderr,
  };
};

const piCalls = (scratch: Scratch): string[] =>
  existsSync(scratch.piCalls)
    ? readFileSync(scratch.piCalls, "utf8").split("\n").filter(Boolean)
    : [];

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Wait until `ok` holds, attempt-counted like `ralph-ensure-db.test.ts`'s `waitFor` (20 s at most). */
const until = async (what: string, ok: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (ok()) return;
    // `node:timers/promises`: the lint denies a bare `setTimeout` and `new Promise`.
    await delay(50);
  }
  throw new Error(`timed out waiting for ${what}`);
};

/** A process of our own in a group of its own, standing in for a session or a loop. */
const sleeper = (): number => {
  const child = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
  child.unref();
  const pid = child.pid;
  if (pid === undefined) throw new Error("could not spawn sleep");
  spawned.push(pid);
  return pid;
};

const startedAt = (pid: number): string =>
  spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8",
  }).stdout.trim();

const record = (scratch: Scratch): string =>
  path.join(scratch.wt, ".ralph/session");

const writeRecord = (scratch: Scratch, pid: number, started: string) => {
  mkdirSync(path.dirname(record(scratch)), { recursive: true });
  writeFileSync(record(scratch), `${String(pid)}\n${started}\n`);
};

const branchOf = (scratch: Scratch): string =>
  git(scratch.wt, "branch", "--show-current");

describe("a ralph run and the worker session a previous run left behind", () => {
  // Mutation: drop `take_worktree` from `cmd_run` — run 2 switches the worktree off `ralph/LOB-1`
  // under the live session, commits its `wip.txt` as WIP, and launches a second `pi`: every
  // assertion after `refused` reddens. Mutation: make `live_session` succeed on any record, alive or
  // not — run 3 is refused too. Mutation: drop the `rm -f` of the record at the end of
  // `with_timeout` — the record outlives run 3's session and the last assertion reddens.
  it(
    "refuses to start while the session is alive, naming its pid, and takes over once it is gone",
    { timeout: 60_000 },
    async () => {
      const scratch = mkScratch();
      const ready = path.join(scratch.root, "pi-ready");

      // Run 1: its session checks out ralph/LOB-1, starts working, and outlives its driver.
      const first = spawn("bash", ["-c", RUN], {
        cwd: scratch.root,
        detached: true,
        stdio: "ignore",
        env: env(scratch, { FAKE_PI_HOLD: ready }),
      });
      const driver = first.pid;
      if (driver === undefined) throw new Error("could not spawn run 1");
      spawned.push(driver);
      await until("run 1's session", () => existsSync(ready));
      const session = Number(piCalls(scratch)[0]?.split(" ")[0]);
      spawned.push(session);
      process.kill(-driver, "SIGKILL");
      await until("run 1's driver to die", () => !alive(driver));
      expect(alive(session)).toBe(true);
      expect(readFileSync(record(scratch), "utf8").split("\n")[0]).toBe(
        String(session),
      );

      // Run 2: refused, on one line naming the session's pid, with the worktree untouched.
      const refused = sh(scratch, RUN);
      expect(refused.status, refused.stderr).toBe(1);
      const errors = refused.stderr
        .split("\n")
        .filter((line) => line.includes("error:"));
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain(`pi pid ${String(session)}`);
      expect(branchOf(scratch)).toBe("ralph/LOB-1");
      expect(git(scratch.wt, "status", "--porcelain")).toContain("wip.txt");
      expect(piCalls(scratch)).toHaveLength(1);
      expect(existsSync(path.join(scratch.wt, ".ralph/lock"))).toBe(false);

      // The session ends. Run 3 takes the worktree: the session's work kept on its branch, the
      // worktree back on the base ref, a new session launched in it.
      process.kill(session, "SIGKILL");
      await until("run 1's session to end", () => !alive(session));
      const takeover = sh(scratch, RUN);
      expect(takeover.status, takeover.stderr).toBe(0);
      expect(takeover.stderr).toContain(
        `removing stale session record (pid ${String(session)})`,
      );
      expect(takeover.stderr).toContain("done after 1 iteration(s)");
      expect(piCalls(scratch)).toHaveLength(2);
      expect(piCalls(scratch)[1]).toMatch(
        new RegExp(` ${scratch.wt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`),
      );
      expect(branchOf(scratch)).toBe("");
      expect(git(scratch.wt, "log", "-1", "--format=%s", "ralph/LOB-1")).toBe(
        "wip(ralph/LOB-1): unfinished work preserved after an interrupted iteration",
      );
      expect(existsSync(record(scratch))).toBe(false);
    },
  );

  // Mutation: drop the `rm -f` of the record at the end of `with_timeout` — the first run's record
  // outlives its session and the first `existsSync` reddens. The second run must then neither be
  // refused nor have anything stale to clear: a normal exit leaves the worktree free, not merely
  // free once a liveness check has looked.
  it(
    "lets a second run started right after the first exits take the worktree normally",
    { timeout: 60_000 },
    () => {
      const scratch = mkScratch();
      const first = sh(scratch, RUN);
      expect(first.status, first.stderr).toBe(0);
      expect(existsSync(record(scratch))).toBe(false);
      const second = sh(scratch, RUN);
      expect(second.status, second.stderr).toBe(0);
      expect(second.stderr).not.toContain("error:");
      expect(second.stderr).not.toContain("stale session record");
      expect(piCalls(scratch)).toHaveLength(2);
      expect(existsSync(record(scratch))).toBe(false);
    },
  );

  // Mutation: compare only the pid in `live_session`, not the start time — a pid the system handed
  // to another process after the session ended reads as the session, and the run is refused.
  it(
    "reads a record whose pid now belongs to another process as stale",
    { timeout: 30_000 },
    () => {
      const scratch = mkScratch();
      const other = sleeper();
      writeRecord(scratch, other, "Thu Jan  1 00:00:00 1970");
      const run = sh(scratch, RUN);
      expect(run.status, run.stderr).toBe(0);
      expect(run.stderr).toContain(
        `removing stale session record (pid ${String(other)})`,
      );
      expect(piCalls(scratch)).toHaveLength(1);
    },
  );

  // Mutation: drop `take_worktree` from `cmd_setup` — setup stashes the session's work and switches
  // the worktree to the base ref under it. Mutation: drop it from `cmd_audit` — the same, for audit.
  it(
    "refuses setup and audit while the session is alive, before touching the worktree",
    { timeout: 30_000 },
    () => {
      const scratch = mkScratch();
      git(scratch.wt, "switch", "-q", "-c", "ralph/LOB-1");
      writeFileSync(path.join(scratch.wt, "README"), "edited by the session\n");
      git(scratch.wt, "add", "README");
      const session = sleeper();
      writeRecord(scratch, session, startedAt(session));
      for (const body of [
        // MAIN_ROOT points at the scratch clone, so not even a mutated setup fetches this repo.
        `source "$LOOP"; MAIN_ROOT="$RALPH_WORKTREE"; cmd_setup`,
        `source "$LOOP"; ensure_db() { :; }; cmd_audit`,
      ]) {
        const run = sh(scratch, body);
        expect(run.status, body).toBe(1);
        expect(run.stderr, body).toContain(`pi pid ${String(session)}`);
        expect(branchOf(scratch), body).toBe("ralph/LOB-1");
        expect(git(scratch.wt, "status", "--porcelain"), body).toContain(
          "README",
        );
      }
      expect(piCalls(scratch)).toEqual([]);
    },
  );

  // Mutation: drop the session branch from `cmd_kill` — a session whose driver is not in the loop's
  // process group (a foreground `run` that was killed) survives `kill`, and the next run is refused.
  it(
    "stops the recorded session on kill, even outside the loop's process group",
    { timeout: 30_000 },
    async () => {
      const scratch = mkScratch();
      const loop = sleeper();
      const session = sleeper();
      mkdirSync(path.join(scratch.wt, ".ralph"), { recursive: true });
      writeFileSync(path.join(scratch.wt, ".ralph/loop.pid"), String(loop));
      writeRecord(scratch, session, startedAt(session));
      const run = sh(scratch, 'source "$LOOP"; cmd_kill');
      expect(run.status, run.stderr).toBe(0);
      expect(run.stderr).toContain(
        `killed worker session pi pid ${String(session)}`,
      );
      await until("the session to end", () => !alive(session));
      await until("the loop to end", () => !alive(loop));
      expect(existsSync(record(scratch))).toBe(false);
    },
  );
});
