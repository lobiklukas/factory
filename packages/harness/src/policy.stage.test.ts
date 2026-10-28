/**
 * The read-only stage as a table (docs/board.md B4, B6; LOB-74).
 *
 * `decideStageCall` is pure, so what a specifying run may and may not do is a row here: no harness,
 * no database, no model. `policy.hook.test.ts` proves the rule is selected at `openSession` and
 * delivered into a real transcript, and `.pi/skills/verify-policy`'s `stage` case proves it through
 * the session API on a real card in each column.
 *
 * The allow rows matter as much as the refusals: a specifying run reads the code, and a rule that
 * refused `grep … 2>/dev/null` or `git log` would leave the stage with nothing it can do. The
 * refusals matter the other way: `bash` is an allowlist, so the rows include the writes a model
 * refused `edit` reaches for next (`sed -i`, `patch`, `perl -pi`) and the read commands that write
 * with one flag (`find -delete`).
 */
import type { JsonObject, ToolCall } from "@earendil-works/pi-ai";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  autonomyPolicy,
  decideStageCall,
  DEFAULT_AUTONOMY,
  readOnlyStageOf,
  readOnlyStagePolicy,
  stageRefusalOf,
  type PolicyDecision,
  type ReadOnlyStage,
} from "./policy";
import { DEFAULT_ROLE_POLICIES, rolesWhere } from "./rolePolicy";

const call = (name: string, args: JsonObject): ToolCall => ({
  type: "toolCall",
  id: "call-1",
  name,
  arguments: args,
});

const bash = (command: string): ToolCall => call("bash", { command });

/** The default pipeline's specifying column, as `readOnlyStageOf` resolves it. */
const SPECIFYING: ReadOnlyStage = {
  stage: "specifying",
  column: "specifying",
  role: "specifier",
};

const refusalOf = (toolCall: ToolCall, stage = SPECIFYING) => {
  const decision = decideStageCall(stage, toolCall);
  if (decision._tag !== "block") {
    throw new Error(`expected a refusal for ${JSON.stringify(toolCall)}`);
  }
  return decision;
};

describe("which runs are a read-only stage", () => {
  it("is the specifier's column, named by the role rather than by the column", () => {
    expect(rolesWhere(DEFAULT_ROLE_POLICIES, "readOnly")).toEqual([
      "specifier",
      "planner",
    ]);
    expect(
      readOnlyStageOf({ column: "specifying", role: "specifier" }),
    ).toEqual(SPECIFYING);
    // A board that calls the column something else is still the specifying stage.
    expect(readOnlyStageOf({ column: "scoping", role: "specifier" })).toEqual({
      stage: "specifying",
      column: "scoping",
      role: "specifier",
    });
  });

  /** Mutation: drop the planner's `readOnly` row — the planning column would write (D10). */
  it("is the planner's column too, as the planning stage whatever the column is called (D10)", () => {
    expect(readOnlyStageOf({ column: "planning", role: "planner" })).toEqual({
      stage: "planning",
      column: "planning",
      role: "planner",
    });
    expect(readOnlyStageOf({ column: "design", role: "planner" })).toEqual({
      stage: "planning",
      column: "design",
      role: "planner",
    });
  });

  /** Mutation: read the default table whatever is passed — a deployment's row would not hold. */
  it("is a deployment's read-only role, named after its column when its row names no stage", () => {
    const extended = new Map([
      ...DEFAULT_ROLE_POLICIES,
      ["auditor", { readOnly: true }],
    ]);
    expect(
      readOnlyStageOf({ column: "audit", role: "auditor" }, extended),
    ).toEqual({ stage: "audit", column: "audit", role: "auditor" });
    expect(
      readOnlyStageOf({ column: "audit", role: "auditor" }),
    ).toBeUndefined();
  });

  it.each([
    ["a building run", { column: "building", role: "builder" }],
    ["a reviewing run", { column: "review", role: "reviewer" }],
    ["a column that declares no role", { column: "specifying" }],
    ["a role with no column", { role: "specifier" }],
    ["a session with no card", undefined],
    // A role is free text in a board definition; it must not find Object.prototype's keys.
    ["a role named constructor", { column: "c", role: "constructor" }],
    ["a role named toString", { column: "c", role: "toString" }],
    ["a role named __proto__", { column: "c", role: "__proto__" }],
  ])("is not %s", (_label, run) => {
    expect(readOnlyStageOf(run)).toBeUndefined();
  });
});

describe("a read-only stage refuses what writes", () => {
  it.each([
    [
      "the write tool",
      call("write", { path: "SPEC.md", content: "x" }),
      "write SPEC.md",
    ],
    [
      "the edit tool",
      call("edit", { path: "src/a.ts", edits: [] }),
      "edit src/a.ts",
    ],
    ["the verify tool", call("verify", {}), "verify"],
    // Redirects, every spelling.
    ["a redirect", bash("echo x > notes.md"), "redirecting output to notes.md"],
    ["an append", bash("echo x >> notes.md"), "redirecting output to notes.md"],
    [
      "a noclobber override redirect",
      bash("echo x >| f.txt"),
      "redirecting output to f.txt",
    ],
    [
      "a write after a read",
      bash("ls && echo x > out.txt"),
      "redirecting output to out.txt",
    ],
    [
      "a write inside sh -c",
      bash("sh -c 'echo x > out.txt'"),
      "redirecting output to out.txt",
    ],
    [
      "a heredoc into a file",
      bash("cat <<EOF > notes.md\nx\nEOF"),
      "redirecting output to notes.md",
    ],
    // A command that is not a read, whatever it writes: the allowlist fails closed.
    ["a write-table command", bash("touch notes.md"), "running touch"],
    ["a removal", bash("rm -rf src"), "running rm"],
    ["a copy", bash("cp a.txt b.txt"), "running cp"],
    [
      "a truncation, named by its command",
      bash("truncate -s 0 f"),
      "running truncate",
    ],
    ["dd", bash("dd if=/dev/zero of=disk.img"), "running dd"],
    ["a write behind a wrapper", bash("sudo rm notes.md"), "running rm"],
    ["a write behind xargs", bash("git ls-files | xargs rm"), "running rm"],
    ["perl in place", bash("perl -pi -e s/a/b/ f.txt"), "running perl"],
    ["a patch", bash("patch -p1 < x.diff"), "running patch"],
    ["an archive extracted", bash("tar -xf a.tar"), "running tar"],
    ["an unzip", bash("unzip a.zip"), "running unzip"],
    ["an rsync", bash("rsync -a a/ b/"), "running rsync"],
    ["an eval", bash("eval 'echo x > f.txt'"), "running eval"],
    [
      "an interpreter",
      bash("python3 -c \"open('f','w').write('x')\""),
      "running python3",
    ],
    [
      "awk, which is an interpreter",
      bash("awk '{print > \"f\"}' a"),
      "running awk",
    ],
    ["a package install", bash("bun add lodash"), "running bun"],
    ["npm", bash("npm install"), "running npm"],
    ["a download", bash("curl -o f https://github.com/x"), "running curl"],
    ["a script", bash("./scripts/gen.sh"), "running gen.sh"],
    ["a shell running a script file", bash("bash gen.sh"), "running bash"],
    ["a write inside a substitution", bash("echo $(rm f)"), "running rm"],
    ["a command run by a substitution", bash("$(echo rm) f"), "running $"],
    // Read commands with the flag that makes them write.
    ["sed in place", bash("sed -i s/a/b/ src/a.ts"), "sed -i"],
    [
      "sed in place with a suffix",
      bash("sed -i.bak s/a/b/ src/a.ts"),
      "sed -i",
    ],
    ["sed in place, clustered", bash("sed -ni s/a/b/p src/a.ts"), "sed -i"],
    ["sed in place, long", bash("sed --in-place s/a/b/ a"), "sed --in-place"],
    ["find -delete", bash("find . -name '*.ts' -delete"), "find -delete"],
    ["find -exec", bash("find . -exec rm {} \\;"), "find -exec"],
    ["find -execdir", bash("find . -execdir rm {} +"), "find -execdir"],
    ["sort into a file", bash("sort -o out.txt in.txt"), "sort -o"],
    ["rg with a preprocessor", bash("rg --pre ./x foo"), "rg --pre"],
    ["tee into a file", bash("echo x | tee notes.md"), "tee writing notes.md"],
    ["uniq into a file", bash("uniq in.txt out.txt"), "uniq writing out.txt"],
    // git: a subcommand not known to read is refused.
    ["a commit", bash("git commit -am wip"), "git commit"],
    ["a push", bash("git push origin refs/heads/factory/ses_1"), "git push"],
    ["a checkout", bash("git -C . checkout -b x"), "git checkout"],
    ["a fetch", bash("git fetch"), "git fetch"],
    [
      "an update-ref",
      bash("git update-ref refs/heads/x HEAD"),
      "git update-ref",
    ],
    [
      "an update-index",
      bash("git update-index --assume-unchanged a"),
      "git update-index",
    ],
    ["a format-patch", bash("git format-patch -1"), "git format-patch"],
    ["a gc", bash("git gc"), "git gc"],
    ["a stash", bash("git stash"), "git stash"],
    ["a stash pop", bash("git stash pop"), "git stash pop"],
    ["a bisect", bash("git bisect start"), "git bisect start"],
    [
      "a submodule update",
      bash("git submodule update --init"),
      "git submodule update",
    ],
    [
      "a sparse-checkout",
      bash("git sparse-checkout set a"),
      "git sparse-checkout set",
    ],
    ["a worktree add", bash("git worktree add ../x"), "git worktree add"],
    ["a notes add", bash("git notes add -m x"), "git notes add"],
    ["a remote add", bash("git remote add x https://x"), "git remote add"],
    ["a branch created", bash("git branch feature"), "git branch feature"],
    ["a branch deleted", bash("git branch -D main"), "git branch -D"],
    ["a branch renamed", bash("git branch -m a b"), "git branch -m"],
    ["a tag created", bash("git tag v1"), "git tag v1"],
    ["a tag deleted", bash("git tag -d v1"), "git tag -d"],
    ["a config set", bash("git config user.name x"), "git config user.name"],
    [
      "a config unset",
      bash("git config --unset user.name"),
      "git config --unset",
    ],
    [
      "a diff into a file",
      bash("git diff --output=x.diff"),
      "git diff --output",
    ],
    [
      "a config override, which can name a program",
      bash("git -c core.pager=x log"),
      "git -c",
    ],
  ])("refuses %s", (_label, toolCall, what) => {
    expect(stageRefusalOf(SPECIFYING, toolCall)).toEqual({
      _tag: "ReadOnlyStage",
      stage: "specifying",
      column: "specifying",
      role: "specifier",
      call: toolCall.name,
      what,
    });
    expect(refusalOf(toolCall).reason).toContain(`${what} is refused`);
  });

  it("names the stage, the column and the role, not just that it refused", () => {
    const { reason } = refusalOf(
      call("write", { path: "SPEC.md", content: "x" }),
      {
        stage: "specifying",
        column: "scoping",
        role: "specifier",
      },
    );
    expect(reason).toBe(
      'write SPEC.md is refused: this run is in the read-only specifying stage (column "scoping", role specifier), which reads the workspace and changes nothing in it. Read and search instead, and put what you found in your answer or ask a question with the ask tool.',
    );
  });

  it("tells a refused bash call what its bash may run", () => {
    expect(refusalOf(bash("sed -i s/a/b/ a.ts")).reason).toBe(
      'sed -i is refused: this run is in the read-only specifying stage (column "specifying", role specifier), which reads the workspace and changes nothing in it. Its bash runs only commands that read (ls, cat, head, tail, grep, rg, find, wc, git log, show, diff, status, blame, grep) and redirects nothing into a file. Read and search instead, and put what you found in your answer or ask a question with the ask tool.',
    );
  });
});

describe("a read-only stage leaves reading alone", () => {
  it.each([
    ["the read tool", call("read", { path: "src/a.ts" })],
    ["the ask tool", call("ask", { question: "which repo?" })],
    ["a tool the rule has never heard of", call("spec", { goal: "x" })],
    ["a listing", bash("ls -la")],
    ["a search with its errors discarded", bash("grep -rn foo . 2>/dev/null")],
    ["a pipeline of readers", bash("git log --oneline | head -20")],
    ["a diff", bash("git diff main...HEAD --stat")],
    ["the stash list", bash("git stash list")],
    ["tee with no file", bash("echo x | tee")],
    ["a write to a device", bash("echo x | tee /dev/null")],
    ["a cat of a file", bash("cat src/a.ts")],
    ["a line range", bash("sed -n '10,40p' src/a.ts")],
    ["a search with rg", bash("rg -n 'export const' packages --glob '*.ts'")],
    [
      "a find that only lists",
      bash("find . -name '*.ts' -not -path './node_modules/*'"),
    ],
    ["a count", bash("grep -c foo a.ts | sort -rn | uniq -c | head")],
    ["a read through xargs", bash("git ls-files | xargs grep -l foo")],
    ["a loop of reads", bash("for f in a b; do wc -l $f; done")],
    [
      "a while loop of reads",
      bash("git ls-files | while read -r f; do head -1 $f; done"),
    ],
    ["a cd inside the worktree, then a read", bash("cd packages && ls")],
    ["a read in a substitution", bash("grep foo $(git ls-files '*.ts') -n")],
    [
      "an assignment from a substitution",
      bash("head=$(git rev-parse HEAD) && echo $head"),
    ],
    ["a read inside sh -c", bash("sh -c 'ls | wc -l'")],
    ["a status", bash("git status --short")],
    ["a show", bash("git show HEAD:src/a.ts")],
    ["a blame", bash("git blame -L 1,10 src/a.ts")],
    ["a git grep", bash("git grep -n foo")],
    ["the branch list", bash("git branch -a --contains abc")],
    ["the current branch", bash("git branch --show-current")],
    ["a tag list", bash("git tag -l 'v*'")],
    ["a config read", bash("git config user.name")],
    ["a config read, explicit", bash("git config --get remote.origin.url")],
    ["the remotes", bash("git remote -v")],
    ["the worktree list", bash("git worktree list")],
    ["the reflog", bash("git reflog -10")],
    ["a submodule status", bash("git submodule status")],
    ["a git global flag before a read", bash("git -C packages log -1")],
    ["a json read", bash("jq .name package.json")],
    ["an echo that mentions a write", bash("echo 'rm -rf src'")],
    ["a bash call with no command", call("bash", {})],
  ])("allows %s", (_label, toolCall) => {
    expect(decideStageCall(SPECIFYING, toolCall)).toEqual({ _tag: "allow" });
  });
});

describe("the stage composed into a session's policy", () => {
  const decide = (
    toolCall: ToolCall,
    approvalRequired: readonly string[] = [],
  ): PolicyDecision =>
    Effect.runSync(
      readOnlyStagePolicy(
        autonomyPolicy(
          { ...DEFAULT_AUTONOMY, approvalRequired },
          "/work/ses_1",
          "ses_1",
        ),
        SPECIFYING,
      ).decide(toolCall),
    );

  it("words a write outside the worktree as the stage's, which is the refusal the run can act on", () => {
    const decision = decide(
      call("write", { path: "/etc/passwd", content: "x" }),
    );
    expect(decision._tag).toBe("block");
    if (decision._tag !== "block") return;
    expect(decision.reason).toContain("read-only specifying stage");
    expect(decision.reason).not.toContain("Write inside the worktree");
  });

  it("still refuses what D11 refuses when the stage allows it", () => {
    const decision = decide(bash("cd /etc && ls"));
    expect(decision).toMatchObject({ _tag: "block" });
    if (decision._tag !== "block") return;
    expect(decision.reason).toContain("cd /etc is refused");
    expect(decision.reason).not.toContain("read-only specifying stage");
  });

  it("still asks for a gated call the stage allows, and never for one it refuses", () => {
    expect(decide(bash("git status"), ["git status"])).toMatchObject({
      _tag: "ask",
      action: "git status",
    });
    const refused = decide(bash("npm publish"), ["npm publish"]);
    expect(refused._tag).toBe("block");
    if (refused._tag !== "block") return;
    expect(refused.reason).toContain(
      "running npm is refused: this run is in the read-only specifying stage",
    );
  });

  it("keeps the wrapped policy's rules, because the narrowing lives in decide", () => {
    const wrapped = autonomyPolicy(DEFAULT_AUTONOMY, "/work/ses_1");
    expect(readOnlyStagePolicy(wrapped, SPECIFYING).rules).toBe(wrapped.rules);
  });
});
