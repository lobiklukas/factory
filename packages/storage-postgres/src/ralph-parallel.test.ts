import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

/**
 * Parallel ralph workers (`RALPH_WORKER=N`, `.pi/ralph/claim.sh`, `.pi/ralph/loop.sh`'s `parallel`).
 *
 * No model, network or database: `claim.sh` is run for real against a scratch directory, and the
 * driver's functions are sourced the way `ralph-docker-env.test.ts` sources them, with a `gh` shim
 * where one is needed. Each case names the mutation it was checked against.
 */

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const LOOP = path.join(REPO_ROOT, ".pi/ralph/loop.sh");
const CLAIM = path.join(REPO_ROOT, ".pi/ralph/claim.sh");

const created: string[] = [];
afterAll(() => {
  for (const root of created) rmSync(root, { recursive: true, force: true });
});

interface Scratch {
  readonly root: string;
  readonly bin: string;
  readonly shared: string;
}

const mkScratch = (): Scratch => {
  const root = mkdtempSync(path.join(tmpdir(), "factory-ralph-parallel-"));
  created.push(root);
  const bin = path.join(root, "bin");
  mkdirSync(bin, { recursive: true });
  return { root, bin, shared: path.join(root, "shared") };
};

const baseEnv = (
  scratch: Scratch,
  extra: Record<string, string>,
): Record<string, string> => {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  for (const key of [
    "RALPH_WORKER",
    "RALPH_WORKTREE",
    "RALPH_DB",
    "RALPH_API_PORT",
    "RALPH_WEB_PORT",
    "RALPH_MERGE",
    "RALPH_SHARED",
    "RALPH_CLAIM_TTL",
    "RALPH_PRIMARY_WORKTREE",
  ]) {
    delete inherited[key];
  }
  return {
    ...inherited,
    PATH: `${scratch.bin}${path.delimiter}${inherited["PATH"] ?? ""}`,
    LOOP,
    CLAIM,
    RALPH_SHARED: scratch.shared,
    ...extra,
  };
};

const sh = (
  scratch: Scratch,
  body: string,
  extra: Record<string, string> = {},
) => {
  const result = spawnSync("bash", ["-c", body], {
    cwd: scratch.root,
    encoding: "utf8",
    timeout: 30_000,
    env: baseEnv(scratch, extra),
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
};

const claim = (
  scratch: Scratch,
  worker: string,
  args: string,
  extra: Record<string, string> = {},
) => sh(scratch, `bash "$CLAIM" ${args}`, { RALPH_WORKER: worker, ...extra });

describe("claim.sh", () => {
  // Mutation: replace `mkdir "$d"` with a check-then-write (`[ -d ] || ...`): two claims race and
  // both win; with the sequential calls here it shows as the second worker getting exit 0.
  it(
    "gives an issue to the first worker that asks and refuses the second",
    { timeout: 30_000 },
    () => {
      const scratch = mkScratch();
      expect(claim(scratch, "1", "claim LOB-7").status).toBe(0);
      const second = claim(scratch, "2", "claim LOB-7");
      expect(second.status).toBe(1);
      expect(second.stderr).toContain("LOB-7 is claimed by worker 1");
      // Another issue is free, and the holder may claim its own again.
      expect(claim(scratch, "2", "claim LOB-8").status).toBe(0);
      expect(claim(scratch, "1", "claim LOB-7").status).toBe(0);
    },
  );

  // Mutation: drop the owner check in `release` (any worker frees any claim), or make `--any` a no-op
  // (the merging worker could not free the PR author's claim).
  it(
    "lets only the holder release, unless told --any",
    { timeout: 30_000 },
    () => {
      const scratch = mkScratch();
      claim(scratch, "1", "claim LOB-7");
      claim(scratch, "2", "release LOB-7");
      expect(claim(scratch, "2", "claim LOB-7").status).toBe(1);
      claim(scratch, "2", "release --any LOB-7");
      expect(claim(scratch, "2", "claim LOB-7").status).toBe(0);
      claim(scratch, "2", "release LOB-7");
      expect(claim(scratch, "1", "claim LOB-7").status).toBe(0);
    },
  );

  // Mutation: ignore the TTL — a killed worker would hold its issue forever.
  it(
    "lets another worker take over a claim older than the TTL",
    { timeout: 30_000 },
    () => {
      const scratch = mkScratch();
      claim(scratch, "1", "claim LOB-7");
      expect(claim(scratch, "2", "claim LOB-7").status).toBe(1);
      // Everything is older than a zero TTL.
      const takeover = claim(scratch, "2", "claim LOB-7", {
        RALPH_CLAIM_TTL: "0",
      });
      expect(takeover.status).toBe(0);
      const listed = claim(scratch, "2", "list");
      expect(listed.stdout).toMatch(/^LOB-7 worker=2 age=\d+$/m);
    },
  );

  // Mutation: delete the id check — `../x` would escape the claims directory.
  it("rejects an id that is not an issue id", { timeout: 30_000 }, () => {
    const scratch = mkScratch();
    for (const id of ["../escape", "a b", ""]) {
      expect(claim(scratch, "1", `claim '${id}'`).status).toBe(64);
    }
    expect(existsSync(path.join(scratch.root, "escape"))).toBe(false);
  });
});

describe("worker identity in loop.sh", () => {
  const facts =
    'source "$LOOP"; printf "%s\\n" "$WT" "$DATABASE_URL" "$RALPH_API_PORT" "$RALPH_WEB_PORT" "$RALPH_MERGE"';

  // Mutation: derive nothing from RALPH_WORKER — two workers would share one worktree, database and
  // port, and both would merge. Worker 1 must stay exactly what the loop has always used.
  it(
    "keeps worker 1 as it always was and gives worker 2 its own worktree, database, ports and no merge",
    { timeout: 30_000 },
    () => {
      const scratch = mkScratch();
      const one = sh(scratch, facts, {
        RALPH_PRIMARY_WORKTREE: "/x/repo-ralph",
      });
      expect(one.stdout.trim().split("\n")).toEqual([
        "/x/repo-ralph",
        "postgres://factory:factory@localhost:5442/factory_ralph",
        "9400",
        "3400",
        "1",
      ]);
      const three = sh(scratch, facts, {
        RALPH_WORKER: "3",
        RALPH_PRIMARY_WORKTREE: "/x/repo-ralph",
      });
      expect(three.stdout.trim().split("\n")).toEqual([
        "/x/repo-ralph-3",
        "postgres://factory:factory@localhost:5442/factory_ralph_3",
        "9420",
        "3420",
        "0",
      ]);
    },
  );

  it(
    "refuses a worker number that is not a positive integer",
    { timeout: 30_000 },
    () => {
      const scratch = mkScratch();
      for (const bad of ["0", "two", "-1"]) {
        const result = sh(scratch, 'source "$LOOP"', { RALPH_WORKER: bad });
        expect(result.status, bad).toBe(64);
        expect(result.stderr).toContain(
          "RALPH_WORKER must be a positive integer",
        );
      }
    },
  );

  // Mutation: skip the symlinks — worker 2 would plan and note in a private copy and never see worker
  // 1's queue; or link `logs` too, and the workers would interleave one log.
  it(
    "shares worker 1's plan, notes and research with worker 2, and nothing else",
    { timeout: 30_000 },
    () => {
      const scratch = mkScratch();
      const primary = path.join(scratch.root, "repo-ralph");
      const second = path.join(scratch.root, "repo-ralph-2");
      mkdirSync(path.join(primary, ".ralph"), { recursive: true });
      mkdirSync(path.join(second, ".ralph/logs"), { recursive: true });
      writeFileSync(path.join(primary, ".ralph/plan.md"), "| 1 | LOB-1 |\n");
      const result = sh(
        scratch,
        'source "$LOOP"; mkdir -p "$STATE"; share_state',
        {
          RALPH_WORKER: "2",
          RALPH_PRIMARY_WORKTREE: primary,
          RALPH_WORKTREE: second,
        },
      );
      expect(result.status, result.stderr).toBe(0);
      for (const name of ["plan.md", "progress.md", "polish.md", "research"]) {
        const link = path.join(second, ".ralph", name);
        expect(lstatSync(link).isSymbolicLink(), name).toBe(true);
        expect(readlinkSync(link), name).toBe(
          path.join(primary, ".ralph", name),
        );
      }
      expect(lstatSync(path.join(second, ".ralph/logs")).isSymbolicLink()).toBe(
        false,
      );
    },
  );

  // Mutation: release every claim of this worker at the end of an iteration, PR or no PR — the issue
  // whose PR is under review could then be picked up by another worker and worked twice.
  it(
    "releases this worker's claims that have no open PR and keeps the rest",
    { timeout: 30_000 },
    () => {
      const scratch = mkScratch();
      const worktree = path.join(scratch.root, "repo-ralph");
      mkdirSync(worktree, { recursive: true });
      // `gh pr list --head ralph/LOB-2` reports one open PR; every other branch reports none.
      const gh = path.join(scratch.bin, "gh");
      writeFileSync(
        gh,
        [
          "#!/usr/bin/env bash",
          'case "$*" in *"--head ralph/LOB-2 "*) echo 1 ;; *) echo 0 ;; esac',
          "",
        ].join("\n"),
      );
      chmodSync(gh, 0o755);
      claim(scratch, "1", "claim LOB-1");
      claim(scratch, "1", "claim LOB-2");
      claim(scratch, "2", "claim LOB-3");
      const result = sh(scratch, 'source "$LOOP"; release_idle_claims', {
        RALPH_WORKER: "1",
        RALPH_WORKTREE: worktree,
      });
      expect(result.status, result.stderr).toBe(0);
      const left = claim(scratch, "1", "list").stdout;
      expect(left).not.toContain("LOB-1 ");
      expect(left).toContain("LOB-2 worker=1");
      // Worker 2's claim is not worker 1's to release, whatever its PR state (`claim.sh release` also
      // refuses a non-holder, so no mutation of the driver's own filter alone shows here).
      expect(left).toContain("LOB-3 worker=2");
    },
  );
});

describe("review_ok in loop.sh", () => {
  const FULL = "88b91cc8c486f95bae1e9be260b6c28d916d7b3b";

  // The record as a reviewer posts it: a summary, then one JSON line in an HTML comment.
  const record = (head: string) =>
    `Review summary.\n\n<!-- ralph-review: ${JSON.stringify({
      head,
      spec: "OK",
      standards: "OK",
      tests: "OK",
      design: "n/a",
      p0p1_open: 0,
      gate: "green",
    })} -->\n`;

  // `review_ok 34 <PR head>`, with `gh pr view` answering with `body` as the PR's last comment.
  const reviewOk = (scratch: Scratch, body: string, prHead = FULL) => {
    const file = path.join(scratch.root, "record.txt");
    writeFileSync(file, body);
    const gh = path.join(scratch.bin, "gh");
    writeFileSync(
      gh,
      ["#!/usr/bin/env bash", `cat ${JSON.stringify(file)}`, ""].join("\n"),
    );
    chmodSync(gh, 0o755);
    const result = sh(
      scratch,
      'source "$LOOP"; why="$(review_ok 34 "$PR_HEAD")" && rc=0 || rc=$?; printf "rc=%s\\n%s" "$rc" "$why"',
      { PR_HEAD: prHead },
    );
    expect(result.status, result.stderr).toBe(0);
    const [first = "", ...rest] = result.stdout.split("\n");
    return {
      rc: Number(first.slice("rc=".length)),
      message: rest.join("\n").trimEnd(),
    };
  };

  // Mutation: keep `d.get("head") != head` — a 7-character record is then refused with rc 2 as "the head
  // moved", which is the defect LOB-144 was filed for.
  it(
    "accepts a record that names the PR head by its seven-character abbreviation, or in full",
    { timeout: 30_000 },
    () => {
      const scratch = mkScratch();
      expect(reviewOk(scratch, record("88b91cc"))).toEqual({
        rc: 0,
        message: "",
      });
      expect(reviewOk(scratch, record(FULL))).toEqual({ rc: 0, message: "" });
      expect(reviewOk(scratch, record(FULL.slice(0, 12)))).toEqual({
        rc: 0,
        message: "",
      });
    },
  );

  // Mutation: accept any head (drop the prefix test) — `88b91cd` and a full sha for another commit then
  // pass, and the "head moved" refusal this driver relies on is gone.
  it(
    "refuses a record for a different commit, whether it is abbreviated or in full",
    { timeout: 30_000 },
    () => {
      const scratch = mkScratch();
      expect(reviewOk(scratch, record("88b91cd")).rc).toBe(2);
      expect(reviewOk(scratch, record(`${FULL.slice(0, 39)}0`)).rc).toBe(2);
    },
  );

  // Mutation: drop the seven-character floor — a three- or six-character prefix of the head is then
  // accepted, and a short sha can name more than one commit.
  it(
    "refuses a record whose head is shorter than seven characters, even when it is a prefix",
    { timeout: 30_000 },
    () => {
      const scratch = mkScratch();
      expect(reviewOk(scratch, record("88b")).rc).toBe(2);
      expect(reviewOk(scratch, record("88b91c")).rc).toBe(2);
    },
  );

  // Mutation: truncate both shas to seven characters again — the message then prints the short forms and
  // fails the exact-message assertion below, so the full-length, labelled message is what this case pins.
  it(
    "states both heads in full, with their lengths, when it refuses",
    { timeout: 30_000 },
    () => {
      const scratch = mkScratch();
      expect(reviewOk(scratch, record("88b91cd"))).toEqual({
        rc: 2,
        message: `review record is for 88b91cd (7 chars), PR head is ${FULL} (40 chars)`,
      });
    },
  );
});
