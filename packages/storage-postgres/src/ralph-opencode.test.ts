import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

/**
 * `RALPH_AGENT=opencode` runs each ralph session through `opencode run` instead of `pi -p`
 * (`.pi/ralph/loop.sh`, `.pi/ralph/opencode-config.py`).
 *
 * No real `opencode`, model or network is involved: a shim on `PATH` plays the CLI and records what
 * it was handed, so the claims are about the driver's side of the seam — the command line, the
 * generated config, how the final text becomes a control tag, and when a failed run falls back to
 * the next model. What the real CLI does with that command line is proven by running it, not here
 * (see the PR for the run).
 *
 * Each case names the mutation it was checked against.
 */

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const LOOP = path.join(REPO_ROOT, ".pi/ralph/loop.sh");

const created: string[] = [];
afterAll(() => {
  for (const root of created) rmSync(root, { recursive: true, force: true });
});

interface Scratch {
  readonly root: string;
  readonly home: string;
  readonly bin: string;
  readonly worktree: string;
  readonly calls: string;
}

/**
 * A `opencode` shim. `run -m <model>` appends its argv, cwd and the prompt's length to the call log
 * and prints JSON events chosen by the model id; `debug paths db` prints `$OC_DB` (or fails when it
 * is unset). The behaviours:
 *
 * - `*-refused`: a top-level `error` event and exit 1, the way a refused model call looks.
 * - `*-prose`: a final text that does not end on a control line.
 * - `*-quiet`: the model going quiet mid-turn: a first run that ends on a `step_start` and exits 0, and,
 *   when it is resumed (`-s <session>`), a final text that ends on the control line.
 * - anything else: a final text whose last line is `` `<promise>NEXT</promise>` `` after prose.
 */
const writeShim = (scratch: Scratch): void => {
  const file = path.join(scratch.bin, "opencode");
  writeFileSync(
    file,
    [
      "#!/usr/bin/env bash",
      'if [ "$1" = debug ]; then',
      '  [ -n "${OC_DB:-}" ] || exit 1',
      '  echo "$OC_DB"; exit 0',
      "fi",
      'model=""; prev=""',
      'for a in "$@"; do [ "$prev" = -m ] && model="$a"; prev="$a"; done',
      `printf 'argv=%s\\tcwd=%s\\n' "$*" "$PWD" >> ${JSON.stringify(scratch.calls)}`,
      'case "$model" in',
      "  *-refused)",
      `    echo '{"type":"error","error":{"type":"provider.auth","message":"This model is not available in your country","status":403}}'`,
      "    exit 1 ;;",
      "  *-quiet)",
      '    case " $* " in',
      '      *" -s ses_test "*) printf \'%s\\n\' \'{"type":"text","sessionID":"ses_test","part":{"text":"Resumed.\\n<promise>NEXT</promise>"}}\' ;;',
      `      *) echo '{"type":"step_start","sessionID":"ses_test","part":{"type":"step-start"}}' ;;`,
      "    esac",
      "    exit 0 ;;",
      "  *-prose)",
      `    echo '{"type":"text","part":{"text":"All done, nothing more to say."}}'`,
      "    exit 0 ;;",
      "  *)",
      `    echo '{"type":"text","part":{"text":"first message"}}'`,
      `    echo '{"type":"tool_use","part":{"tool":"read","state":{"status":"completed"}}}'`,
      `    printf '%s\\n' '{"type":"text","part":{"text":"Handled LOB-1.\\n\\n\`<promise>NEXT</promise>\`\\n"}}'`,
      "    exit 0 ;;",
      "esac",
      "",
    ].join("\n"),
  );
  chmodSync(file, 0o755);
};

const mkScratch = (): Scratch => {
  const root = mkdtempSync(path.join(tmpdir(), "factory-ralph-opencode-"));
  created.push(root);
  const home = path.join(root, "home");
  const bin = path.join(root, "bin");
  const worktree = path.join(root, "worktree");
  mkdirSync(bin, { recursive: true });
  mkdirSync(path.join(home, ".config/opencode"), { recursive: true });
  mkdirSync(path.join(worktree, ".pi/ralph"), { recursive: true });
  mkdirSync(path.join(worktree, ".pi/agents"), { recursive: true });
  mkdirSync(path.join(worktree, ".pi/skills"), { recursive: true });
  mkdirSync(path.join(worktree, ".ralph/logs"), { recursive: true });
  writeFileSync(path.join(worktree, ".pi/ralph/work.prompt.md"), "PROMPT\n");
  writeFileSync(
    path.join(worktree, ".pi/agents/ralph-reviewer.md"),
    [
      "---",
      "name: ralph-reviewer",
      "description: Reviews one angle of a diff",
      "model: opencode-go/longcat-2.5-preview-free",
      "tools: read, grep, find, ls, bash",
      "---",
      "You are the reviewer.",
      "",
    ].join("\n"),
  );
  // The user's global opencode config: a server that must not reach an unattended loop.
  writeFileSync(
    path.join(home, ".config/opencode/opencode.json"),
    JSON.stringify({
      mcp: { github: { type: "remote", url: "https://example.invalid/mcp" } },
    }),
  );
  const scratch = {
    root,
    home,
    bin,
    worktree,
    calls: path.join(root, "calls.txt"),
  };
  writeShim(scratch);
  return scratch;
};

const run = (
  scratch: Scratch,
  body: string,
  extra: Record<string, string> = {},
) => {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  const result = spawnSync("bash", ["-c", body], {
    cwd: scratch.root,
    encoding: "utf8",
    timeout: 30_000,
    env: {
      ...inherited,
      PATH: `${scratch.bin}${path.delimiter}${inherited["PATH"] ?? ""}`,
      HOME: scratch.home,
      LOOP,
      RALPH_AGENT: "opencode",
      RALPH_WORKTREE: scratch.worktree,
      RALPH_FALLBACK_MODELS: "",
      RALPH_TIMEOUT: "20",
      ...extra,
    },
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
};

/** One record per shim call; the prompt inside a record spans lines, so split on the record marker. */
const readCalls = (scratch: Scratch): string[] =>
  readFileSync(scratch.calls, "utf8")
    .split(/^argv=/m)
    .filter((record) => record.length > 0);

const readRuns = (scratch: Scratch): ReadonlyArray<Record<string, unknown>> =>
  readFileSync(path.join(scratch.worktree, ".ralph/runs.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);

describe("RALPH_AGENT=opencode", () => {
  // Mutation: delete `--standalone`, `--auto` or `--format json` from the `opencode run` line, or
  // pass `-m "$RALPH_MODEL"` instead of the attempt's `$m`.
  it("runs opencode with a private server, auto-approval, JSON events and the attempt's model", () => {
    const scratch = mkScratch();
    const result = run(scratch, 'source "$LOOP"; session 3 work', {
      RALPH_MODEL: "opencode/free-ok",
    });
    expect(result.stdout.trim()).toBe("NEXT");
    const calls = readCalls(scratch);
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call).toContain(
      "run --standalone --auto --format json -m opencode/free-ok --title ralph-work-3",
    );
    // The prompt is the file plus the Run context, which carries the opencode tool mapping.
    expect(call).toContain("PROMPT");
    expect(call).toContain("agent CLI: opencode (not pi)");
    expect(call).toContain("`linear_get_issue`");
    expect(call).toContain(`cwd=${scratch.worktree}`);
  });

  // Mutation: read the last line of the whole log instead of the final `text` event (the log's last
  // line is JSON, so every iteration would count as a missing control line), or stop stripping the
  // backticks the shim wraps the tag in.
  it("takes the control tag from the last line of the final text, backticks and all", () => {
    const scratch = mkScratch();
    const ok = run(scratch, 'source "$LOOP"; session 1 work', {
      RALPH_MODEL: "opencode/free-ok",
    });
    expect(ok.stdout.trim()).toBe("NEXT");
    const prose = run(scratch, 'source "$LOOP"; session 2 work', {
      RALPH_MODEL: "opencode/free-prose",
    });
    expect(prose.stdout.trim()).toBe("NONE");
    const records = readRuns(scratch);
    expect(records.map((r) => r["tag"])).toEqual(["NEXT", "NONE"]);
    expect(records.map((r) => r["exit"])).toEqual([0, 0]);
    // Ending on text without a control line is the model's answer, not a cut-off: no resume.
    expect(readCalls(scratch)).toHaveLength(2);
  });

  // Mutation: delete the `oc_cut_short` loop (the iteration ends NONE after one call and the whole
  // orientation is redone), resume without `-s "$sid"` (a new session, not the same one), or drop the
  // `RALPH_OC_RESUMES` bound.
  it("resumes the same session when the model returns nothing mid-turn", () => {
    const scratch = mkScratch();
    const result = run(scratch, 'source "$LOOP"; session 1 work', {
      RALPH_MODEL: "opencode/free-quiet",
    });
    expect(result.stdout.trim()).toBe("NEXT");
    expect(result.stderr).toContain(
      "opencode ended mid-turn on opencode/free-quiet (the model returned nothing); resuming ses_test (1/3)",
    );
    const calls = readCalls(scratch);
    expect(calls).toHaveLength(2);
    expect(calls[0]).not.toContain(" -s ");
    expect(calls[1]).toContain("-m opencode/free-quiet -s ses_test");
    const [record] = readRuns(scratch);
    expect(record).toMatchObject({ tag: "NEXT", exit: 0, attempts: 1 });
  });

  it("stops resuming after RALPH_OC_RESUMES and leaves the iteration without a control line", () => {
    const scratch = mkScratch();
    // The shim answers a resume with the control line, so cap the resumes at zero: the first
    // cut-off run is then final, which is what a bound of `n` does after `n` cut-offs.
    const result = run(scratch, 'source "$LOOP"; session 1 work', {
      RALPH_MODEL: "opencode/free-quiet",
      RALPH_OC_RESUMES: "0",
    });
    expect(result.stdout.trim()).toBe("NONE");
    expect(readCalls(scratch)).toHaveLength(1);
  });

  // Mutation: delete the `^{"type":"error"` clause from `provider_failed` — the shim's refusal
  // ("not available in your country") matches none of the text patterns, so the run ends NONE on
  // the first model instead of falling back.
  it("falls back to the next model when a run ends in an error event", () => {
    const scratch = mkScratch();
    const result = run(scratch, 'source "$LOOP"; session 1 work', {
      RALPH_MODEL: "opencode/free-refused",
      RALPH_FALLBACK_MODELS: "opencode/free-ok",
    });
    expect(result.stdout.trim()).toBe("NEXT");
    expect(result.stderr).toContain(
      "provider error on opencode/free-refused; falling back to opencode/free-ok",
    );
    const [record] = readRuns(scratch);
    expect(record).toMatchObject({
      tag: "NEXT",
      model: "opencode/free-ok",
      attempts: 2,
    });
  });

  // Mutation: pin the subagents to the model in the pi frontmatter instead of `--model` (a fallback
  // model would then leave its subagents on the one that just failed), re-enable the global `github`
  // server, drop `codemode: false`, or let a subagent keep the shell after `tools:` dropped it.
  it("writes the config: subagents on the attempt's model, global MCP servers disabled, Linear direct", () => {
    const scratch = mkScratch();
    run(scratch, 'source "$LOOP"; session 1 work', {
      RALPH_MODEL: "opencode/free-ok",
    });
    const config = JSON.parse(
      readFileSync(
        path.join(scratch.worktree, ".opencode/opencode.jsonc"),
        "utf8",
      ),
    ) as {
      model: string;
      default_agent: string;
      mcp: { servers: Record<string, Record<string, unknown>> };
      agents: Record<
        string,
        {
          mode: string;
          model: string;
          system: string;
          permissions: ReadonlyArray<{ action: string; effect: string }>;
        }
      >;
    };
    expect(config.model).toBe("opencode/free-ok");
    expect(config.default_agent).toBe("build");
    expect(config.mcp.servers["github"]).toMatchObject({ disabled: true });
    expect(config.mcp.servers["linear"]).toMatchObject({
      type: "remote",
      url: "https://mcp.linear.app/mcp",
      codemode: false,
    });
    const reviewer = config.agents["ralph-reviewer"];
    expect(reviewer).toBeDefined();
    expect(reviewer?.mode).toBe("subagent");
    expect(reviewer?.model).toBe("opencode/free-ok");
    expect(reviewer?.system).toBe("You are the reviewer.\n");
    // `tools: read, grep, find, ls, bash` — and nothing else — is what it may do.
    const allowed = reviewer?.permissions
      .filter((rule) => rule.effect === "allow")
      .map((rule) => rule.action);
    expect(allowed).toEqual(["glob", "grep", "read", "shell", "skill"]);
    expect(reviewer?.permissions[0]).toMatchObject({
      action: "*",
      effect: "deny",
    });
  });

  // Mutation: drop the `session_v2` join (a subagent's child session would not count as activity, so
  // a parent waiting on a long subagent would be killed as stalled), or compare `directory` loosely.
  it("reads activity from the session database, children included, for this directory only", () => {
    const scratch = mkScratch();
    const db = path.join(scratch.root, "opencode.db");
    // `pwd -P`, as the driver reads it: on macOS the tmpdir is behind a symlink.
    const dir = realpathSync(scratch.worktree);
    const sql = [
      "create table session_v2 (id text primary key, directory text not null, parent_id text);",
      "create table session_message (id text primary key, session_id text not null, time_updated integer not null);",
      `insert into session_v2 values ('parent', '${dir}', null), ('child', '${dir}', 'parent'), ('other', '/elsewhere', null);`,
      "insert into session_message values ('a', 'parent', 1000000), ('b', 'child', 5000000), ('c', 'other', 9000000);",
    ].join("\n");
    const made = spawnSync("sqlite3", [db, sql], { encoding: "utf8" });
    expect(made.status, made.stderr).toBe(0);
    const result = run(scratch, `source "$LOOP"; oc_activity "${dir}"`, {
      OC_DB: db,
    });
    // The child's row wins over the parent's; the other directory's is ignored. Milliseconds in the
    // database, seconds out.
    expect(result.stdout.trim()).toBe("5000");
  });

  // Mutation: return `0` (or nothing) when the database cannot be read — the watchdog would then see
  // "no activity since 1970" and kill the first iteration it checks.
  it("reports now, never a stall, when the database cannot be read", () => {
    const scratch = mkScratch();
    // The wall clock, read the way the driver reads it (`date +%s`): `Date` is Effect's `Clock` in this repo.
    const clock = () =>
      Number(spawnSync("date", ["+%s"], { encoding: "utf8" }).stdout.trim());
    const before = clock();
    const result = run(
      scratch,
      `source "$LOOP"; oc_activity "${scratch.worktree}"`,
    );
    const seen = Number(result.stdout.trim());
    expect(seen).toBeGreaterThanOrEqual(before);
    expect(seen).toBeLessThanOrEqual(before + 10);
  });

  // Mutation: delete the `case "$RALPH_AGENT"` guard — a typo then silently runs pi.
  it("refuses an agent it does not know", () => {
    const scratch = mkScratch();
    const result = run(scratch, 'bash "$LOOP" status', {
      RALPH_AGENT: "cursor",
    });
    expect(result.status).toBe(64);
    expect(result.stderr).toContain("RALPH_AGENT must be pi or opencode");
    expect(existsSync(scratch.calls)).toBe(false);
  });
});
