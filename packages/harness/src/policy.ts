/**
 * What a session may do unattended (docs/design.md D11, D15).
 *
 * D11 draws the boundary at the branch: everything inside the session worktree is unattended, a
 * push to `refs/heads/factory/<session-id>` is unattended, and everything that escapes is refused —
 * force-push, ref deletion, tag pushes, changing remotes, writes outside the worktree, and egress
 * to a host nobody allowlisted. D15 puts that decision in Pi Durable's `ToolTask` hooks and says the
 * decision must be *data*, so "what may run unattended" is a config surface rather than logic
 * scattered across handlers. That is the shape here:
 *
 * - `AutonomyConfig` is the deployment's choice; `AutonomyRules` is that choice resolved for one
 *   session's worktree. Both are plain data.
 * - `decideToolCall` is pure: rules and a call in, a `PolicyDecision` out. Every refusal below is
 *   a row in a test table, not a branch in a handler.
 * - `Policy` is the Effect service the control plane reads the configuration from, and
 *   `policyExtension` is the one place that touches Pi Durable.
 *
 * **This is not a security boundary, and D15 says so explicitly.** Pi Durable's own
 * `docs/security.md` is blunt: hooks run in the same process and trust domain as the tools they
 * gate. What stops a determined agent is the narrow, short-lived push credential (D14) and the
 * GitHub rulesets (D15); what this module stops is the accident, with a message the agent can
 * self-correct from. Three consequences worth naming, all deliberate:
 *
 * - A shell command is classified by reading its text. `eval`, a command inside `sh -c`, a variable
 *   holding a path or a command, a script written and then executed, and a symlink inside the
 *   worktree are all ways past it, and none of them is defended against here. An unquoted `$(...)`,
 *   a backtick substitution and a subshell are *not* among them: those are read as the commands
 *   they run.
 * - A push to a *named* remote (`git push origin ...`) is judged by its refspec, not by the remote's
 *   host: resolving a remote name to a URL means reading git config, which is the credential seam's
 *   job (LOB-51/LOB-54). A remote written out as a URL in the command *is* checked.
 * - The commands that write files are a table, not a proof: `sed -i`, `tar -C`, `unzip -d`, and a
 *   program that writes a file itself are not in it.
 * - A docs run's write allowlist (`DOCS_WRITE_ALLOWLIST`, LOB-195) narrows the same decision, so it
 *   stops what the same textual read stops: a `write` or `edit` of a code file, not a redirect or
 *   `sed -i` that writes one.
 * - A read-only stage (`READ_ONLY_ROLES`, LOB-74) refuses `write`, `edit` and `verify` outright, and
 *   reads `bash` the other way round: an allowlist of read commands (`STAGE_READ_COMMANDS`), so a
 *   command it does not know is refused rather than let through. It is still a reading of the text,
 *   so a `sed` script's own `w` command or a program named in an environment variable gets past.
 */
import { createHash } from "node:crypto";
import type { ToolCall } from "@earendil-works/pi-ai";
import type { Context as ChordContext } from "@earendil-works/chord";
import type { Extension, HookApi } from "@earendil-works/pi-durable";
import { defineExtension, hook, ToolTask } from "@earendil-works/pi-durable";
import { Context, Effect, Layer } from "effect";

/** The name the policy extension is installed under, so a conversation can select it by name. */
export const POLICY_EXTENSION = "policy";

/**
 * What the policy decided. Data, because that is what a test asserts and what a refusal is made of:
 * `block` carries the sentence the model reads, which has to be a correction it can act on.
 */
export type PolicyDecision =
  | { readonly _tag: "allow" }
  | { readonly _tag: "block"; readonly reason: string }
  /** A gated call: nothing is wrong with it, and a person has to say yes before it runs (LOB-52). */
  | {
      readonly _tag: "ask";
      readonly requestId: string;
      readonly action: string;
      readonly detail: string;
    };

const ALLOW: PolicyDecision = { _tag: "allow" };
const block = (reason: string): PolicyDecision => ({ _tag: "block", reason });

/**
 * The deployment's autonomy configuration (D11's "config surface").
 *
 * The defaults are the boundary as designed: only the session's own branch may be pushed, and only
 * the repository host may be reached. Widening either one is a deliberate act by whoever builds the
 * layer, not something a session can do to itself.
 */
export type AutonomyConfig = {
  /** Ref prefixes the agent may push to. Every other ref is refused. */
  readonly pushRefPrefixes: readonly string[];
  /** Hosts the agent may reach over the network. Every other host is refused. */
  readonly allowedHosts: readonly string[];
  /**
   * Command prefixes that run only once a person approved them (D15, LOB-52). A `bash` call one of
   * whose simple commands starts with one of these is neither refused nor run: the session asks, and
   * the call is blocked until a person approves it. Empty by default — a gate is a deployment's
   * choice, and an ungated deployment is the boundary D11 already draws.
   *
   * One approval covers one run of the call it names: the same call after that run asks again. A
   * denial stands for that exact call for the rest of the session. The match reads the command's
   * text (see `gateOf` for what it reads through and what it cannot see), so a gate stops the
   * accident; it is not a boundary (D15).
   */
  readonly approvalRequired?: readonly string[];
};

/** D11's boundary as configuration. */
export const DEFAULT_AUTONOMY: AutonomyConfig = {
  pushRefPrefixes: ["refs/heads/factory/"],
  allowedHosts: ["github.com", "api.github.com", "codeload.github.com"],
  approvalRequired: [],
};

/** The configuration resolved for one session: the same rules, with the worktree they apply to. */
export type AutonomyRules = {
  /** The session's working directory. Writes outside it are refused; pushes are relative to it. */
  readonly worktree: string;
  /**
   * The session this policy belongs to. Set, a push into `refs/heads/factory/` is allowed only to
   * `refs/heads/factory/<sessionId>`: D11's "push to `refs/heads/factory/<session-id>`", not any
   * session's branch. Absent (no session known), the prefixes alone decide.
   */
  readonly sessionId?: string;
  readonly pushRefPrefixes: readonly string[];
  readonly allowedHosts: readonly string[];
  /** Command prefixes that need a person's approval before they run (LOB-52), normalized. */
  readonly approvalRequired: readonly string[];
};

/** The namespace D11 gives sessions for their own branches. */
const SESSION_BRANCH_NAMESPACE = "refs/heads/factory/";

/** Resolve a deployment's configuration for one session's worktree. */
export const autonomyRules = (
  config: AutonomyConfig,
  worktree: string,
  sessionId?: string,
): AutonomyRules => ({
  worktree: normalize(worktree),
  ...(sessionId === undefined ? {} : { sessionId }),
  pushRefPrefixes: config.pushRefPrefixes,
  allowedHosts: config.allowedHosts.map((host) => host.toLowerCase()),
  approvalRequired: (config.approvalRequired ?? [])
    .map(normalizeGate)
    .filter((gate) => gate.length > 0),
});

// ---------------------------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------------------------

/**
 * Split a posix path into its segments, resolving `.` and `..` lexically.
 *
 * Lexical, so a symlink inside the worktree pointing out of it is not caught: that is D15's
 * "hooks stop the accident", not a sandbox escape. Written out rather than imported so this module
 * stays free of a platform path implementation — the sandbox is Linux and the worktree path is the
 * sandbox's, not the control plane's.
 */
const segments = (path: string): readonly string[] => {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out;
};

/** Normalize a posix path to an absolute one. `..` above the root stays at the root, like `path.resolve`. */
const normalize = (path: string): string => `/${segments(path).join("/")}`;

/** Resolve `target` against `base`, which must already be absolute. */
const resolvePath = (base: string, target: string): string =>
  target.startsWith("/") ? normalize(target) : normalize(`${base}/${target}`);

/** Whether `target` is `root` or inside it. Both must be normalized. */
const within = (root: string, target: string): boolean =>
  target === root || target.startsWith(root === "/" ? "/" : `${root}/`);

/**
 * Whether a path names a home directory rather than a place in the worktree. `~`, `~user`, `$HOME`
 * and `${HOME}` are all "somewhere else": the worktree is the sandbox's `/workspace/...` and the
 * home is the sandbox's `/root`, so a home path is never inside it. Refused without resolving it,
 * because resolving needs the home directory and nothing in the control plane owns that fact —
 * reading it from this process's environment would be the wrong process's answer.
 */
const isHomePath = (target: string): boolean =>
  target === "~" ||
  target.startsWith("~/") ||
  /^~[A-Za-z_]/.test(target) ||
  target === "$HOME" ||
  target.startsWith("$HOME/") ||
  target === "${HOME}" ||
  target.startsWith("${HOME}/");

/**
 * Character devices and file descriptors that are not writes in any sense a worktree cares about.
 * `/dev/null` matters most: a redirect to it is the single most common thing a shell command does.
 */
const NOT_A_WRITE = [
  "/dev/null",
  "/dev/zero",
  "/dev/random",
  "/dev/urandom",
  "/dev/stdin",
  "/dev/stdout",
  "/dev/stderr",
  "/dev/tty",
  "/dev/fd",
  "/proc/self/fd",
];

const isNotAWrite = (path: string): boolean =>
  NOT_A_WRITE.some(
    (device) => path === device || path.startsWith(`${device}/`),
  );

/** D11's write rule: inside the worktree, or not at all. */
const decideWrite = (
  rules: AutonomyRules,
  verb: string,
  target: string,
): PolicyDecision => {
  if (target.length === 0) return ALLOW;
  if (isHomePath(target)) {
    return block(
      `${verb} ${target} is refused: it names a home directory, which is outside this session's worktree (${rules.worktree}). Write inside the worktree instead.`,
    );
  }
  const resolved = resolvePath(rules.worktree, target);
  if (isNotAWrite(resolved) || within(rules.worktree, resolved)) return ALLOW;
  return block(
    `${verb} ${target} is refused: this session may only write inside its worktree (${rules.worktree}). Write inside the worktree instead.`,
  );
};

// ---------------------------------------------------------------------------------------------
// Shell commands
// ---------------------------------------------------------------------------------------------

/**
 * Tokens that end one simple command and begin the next. Parentheses and backticks are in here
 * because an unquoted substitution or subshell *runs* what it contains: `echo $(git push origin
 * main)` and `(cd /etc && echo x > shadow)` are both commands the policy has to see. Quoted ones
 * stay one word, which is the hole `sh -c` also has (see the module docstring).
 */
const SEGMENT_BREAK = new Set(["&&", "||", ";", "|", "&", "\n", "(", ")", "`"]);
/** Redirection operators, which are kept inside the segment that names their target. */
const REDIRECTIONS = new Set([">", ">>", "<", "<<"]);
/** `VAR=value` prefixes, which `env` and a bare assignment put before the command word. */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** Commands that only run another command; dropped before the real command word is read. */
const WRAPPERS = new Set([
  "sudo",
  "doas",
  "env",
  "nohup",
  "time",
  "command",
  "builtin",
  "exec",
  "nice",
  "ionice",
  "stdbuf",
]);

/** One simple command: its words, and the paths it redirects output into. */
type Segment = {
  readonly argv: readonly string[];
  readonly writeTargets: readonly string[];
};

/**
 * Split a shell command into simple commands, keeping quotes and escapes intact so that a word the
 * shell would treat as one argument is one token here. `&1` stays a word: it is a descriptor
 * duplication, not a path.
 */
const tokenize = (command: string): readonly string[] => {
  const tokens: string[] = [];
  let word = "";
  let started = false;
  let quote: "'" | '"' | undefined;
  const flush = (): void => {
    if (started) tokens.push(word);
    word = "";
    started = false;
  };

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index] ?? "";
    if (quote !== undefined) {
      if (character === quote) {
        quote = undefined;
        continue;
      }
      if (quote === '"' && character === "\\" && index + 1 < command.length) {
        word += command[index + 1] ?? "";
        index += 1;
        continue;
      }
      word += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      started = true;
      continue;
    }
    if (character === "\\" && index + 1 < command.length) {
      word += command[index + 1] ?? "";
      index += 1;
      started = true;
      continue;
    }
    if (character === " " || character === "\t") {
      flush();
      continue;
    }
    if (
      character === "\n" ||
      character === ";" ||
      character === "|" ||
      character === "(" ||
      character === ")" ||
      character === "`"
    ) {
      flush();
      const next = command[index + 1];
      const doubled =
        next === character && character !== "(" && character !== ")";
      tokens.push(doubled ? `${character}${character}` : character);
      if (doubled) index += 1;
      continue;
    }
    if (character === "&" || character === ">") {
      const next = command[index + 1] ?? "";
      if (character === "&" && /[0-9-]/.test(next)) {
        word += character;
        started = true;
        continue;
      }
      flush();
      // `>|` is noclobber's override, a redirect like `>`: read as `>` then `|`, the pipe would end
      // the segment and lose the target.
      if (character === ">" && next === "|") {
        tokens.push(">");
        index += 1;
        continue;
      }
      const doubled = next === character;
      tokens.push(doubled ? `${character}${character}` : character);
      if (doubled) index += 1;
      continue;
    }
    if (character === "<") {
      flush();
      const doubled = command[index + 1] === "<";
      tokens.push(doubled ? "<<" : "<");
      if (doubled) index += 1;
      continue;
    }
    word += character;
    started = true;
  }
  flush();
  return tokens;
};

/**
 * The simple commands in a token list. A `(` or an opening backtick starts a nested command and its
 * matching close resumes the one it interrupted, so the words after a substitution are still that
 * command's: in `rm $(cat list) /etc/passwd`, `/etc/passwd` is an argument of `rm`, not a command of
 * its own. An unmatched `)` (a `case` pattern) only ends the segment it is in.
 */
const segmentsOf = (tokens: readonly string[]): readonly Segment[] => {
  type Frame = {
    readonly argv: string[];
    readonly writeTargets: string[];
    readonly backtick: boolean;
  };
  const out: Segment[] = [];
  const stack: Frame[] = [];
  let argv: string[] = [];
  let writeTargets: string[] = [];
  let redirect: string | undefined;
  let backtick = false;

  const flush = (): void => {
    if (argv.length > 0 || writeTargets.length > 0) {
      out.push({ argv, writeTargets });
    }
    argv = [];
    writeTargets = [];
    redirect = undefined;
  };
  const open = (byBacktick: boolean): void => {
    stack.push({ argv, writeTargets, backtick });
    argv = [];
    writeTargets = [];
    redirect = undefined;
    backtick = byBacktick;
  };
  const close = (): void => {
    flush();
    const outer = stack.pop();
    if (outer === undefined) return;
    argv = outer.argv;
    writeTargets = outer.writeTargets;
    backtick = outer.backtick;
  };

  for (const token of tokens) {
    if (token === "(") {
      open(false);
      continue;
    }
    if (token === ")") {
      close();
      continue;
    }
    if (token === "`") {
      if (backtick) close();
      else open(true);
      continue;
    }
    if (SEGMENT_BREAK.has(token)) {
      flush();
      continue;
    }
    if (REDIRECTIONS.has(token)) {
      redirect = token;
      continue;
    }
    if (redirect !== undefined) {
      const writing = redirect === ">" || redirect === ">>";
      // `> &1` duplicates a descriptor rather than naming a file.
      if (writing && !token.startsWith("&")) writeTargets.push(token);
      redirect = undefined;
      continue;
    }
    argv.push(token);
  }
  while (stack.length > 0) close();
  flush();
  return out;
};

/** The last path component: `/usr/bin/git` is `git`. */
const baseName = (word: string): string => word.split("/").at(-1) ?? word;

/** The command word of a segment, with assignments and wrapper commands removed. */
const commandWords = (argv: readonly string[]): readonly string[] => {
  let index = 0;
  while (index < argv.length && ASSIGNMENT.test(argv[index] ?? "")) index += 1;
  let wrapped = false;
  while (index < argv.length && WRAPPERS.has(baseName(argv[index] ?? ""))) {
    wrapped = true;
    index += 1;
    while (
      index < argv.length &&
      ((argv[index] ?? "").startsWith("-") ||
        ASSIGNMENT.test(argv[index] ?? ""))
    ) {
      index += 1;
    }
  }
  // `sudo -u root git push`: a wrapper's value-taking flag leaves an argument where the command
  // word should be, so look just past it for a `git`. Only after a wrapper, so that
  // `echo git push origin main` is an `echo`.
  if (wrapped && baseName(argv[index] ?? "") !== "git") {
    const found = argv.findIndex((word) => baseName(word) === "git");
    if (found > index && found <= index + 2) index = found;
  }
  return argv.slice(index);
};

// ---------------------------------------------------------------------------------------------
// Git
// ---------------------------------------------------------------------------------------------

/** Global `git` flags that take a separate value, so the subcommand is read past them. */
const GIT_VALUE_FLAGS = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--exec-path",
]);
/** `git push` flags that take a separate value, so their value is not read as a refspec. */
const PUSH_VALUE_FLAGS = new Set([
  "-o",
  "--push-option",
  "--receive-pack",
  "--exec",
  "--repo",
]);
/** Flags that rewrite or destroy a ref. All of them are D11's "always blocked". */
const FORCE_FLAGS = new Set([
  "-f",
  "--force",
  "--force-with-lease",
  "--force-if-includes",
]);

const flagName = (word: string): string => {
  const equals = word.indexOf("=");
  return equals === -1 ? word : word.slice(0, equals);
};

/**
 * Whether a flag is `name`, counting the spellings git accepts for it: a long flag may be
 * abbreviated to any unambiguous prefix (`--force-w`), and a short flag may be clustered
 * (`-uf` is `-u -f`). Whole-word matching misses both, and a missed `-f` is a force-push.
 */
const isFlag = (flag: string, name: string): boolean => {
  if (flag === name) return true;
  if (name.startsWith("--")) return flag.startsWith(name);
  // A short flag is one dash and a cluster of letters; `-f` is in `-uf`, `-df` and `-f`.
  const short = name.slice(1);
  return (
    short.length === 1 && /^-[a-zA-Z]+$/.test(flag) && flag.includes(short)
  );
};

const gitSubcommand = (
  words: readonly string[],
): { readonly subcommand: string; readonly args: readonly string[] } => {
  let index = 0;
  while (index < words.length && (words[index] ?? "").startsWith("-")) {
    index += GIT_VALUE_FLAGS.has(words[index] ?? "") ? 2 : 1;
  }
  return { subcommand: words[index] ?? "", args: words.slice(index + 1) };
};

/** A refspec's source and destination; `undefined` means "not given", `""` means "deleted". */
const refspecSides = (
  refspec: string,
): { readonly source: string; readonly destination: string | undefined } => {
  const colon = refspec.indexOf(":");
  return colon === -1
    ? { source: refspec, destination: refspec }
    : {
        source: refspec.slice(0, colon),
        destination: refspec.slice(colon + 1),
      };
};

/** A ref as git resolves a bare name: `main` is `refs/heads/main`, `refs/tags/v1` is itself. */
const fullRef = (ref: string): string =>
  ref.startsWith("refs/") ? ref : `refs/heads/${ref}`;

const decidePush = (
  rules: AutonomyRules,
  args: readonly string[],
): PolicyDecision => {
  const flags: string[] = [];
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const word = args[index] ?? "";
    if (!word.startsWith("-")) {
      positional.push(word);
      continue;
    }
    const flag = flagName(word);
    flags.push(flag);
    if (PUSH_VALUE_FLAGS.has(flag) && !word.includes("=")) index += 1;
  }

  if (flags.some((flag) => isFlag(flag, "--mirror"))) {
    return block(
      "git push --mirror is refused: it pushes every ref, including ones this session does not own. Push refs/heads/factory/<session-id> instead.",
    );
  }
  const force = flags.find((flag) =>
    [...FORCE_FLAGS].some((name) => isFlag(flag, name)),
  );
  if (force !== undefined) {
    return block(
      `git push ${force} is refused: rewriting history on a shared ref cannot be undone. Push an ordinary commit on refs/heads/factory/<session-id> instead.`,
    );
  }
  if (flags.some((flag) => isFlag(flag, "--delete") || isFlag(flag, "-d"))) {
    return block(
      "git push --delete is refused: a deleted ref loses whatever it pointed at. Push a commit instead.",
    );
  }
  if (flags.some((flag) => isFlag(flag, "--tags"))) {
    return block(
      "git push --tags is refused: this session may only push refs/heads/factory/**. Push the branch instead.",
    );
  }
  if (flags.some((flag) => isFlag(flag, "--all"))) {
    return block(
      "git push --all is refused: it pushes every branch, including ones this session does not own. Name the ref: git push origin refs/heads/factory/<session-id>.",
    );
  }

  // `--repo=<url>` names the destination directly, so its host is checkable even though a remote
  // *name* is not.
  for (const word of args) {
    if (!word.startsWith("--repo=")) continue;
    const host = hostOf(word.slice("--repo=".length));
    if (host === undefined) continue;
    const decision = decideHost(rules, host, `git push ${word}`);
    if (decision._tag === "block") return decision;
  }

  // The first positional is the remote: a name, a URL, or a path. A URL or an scp-like target is
  // checked against the allowlist; a name is not, because resolving it means reading git config
  // (LOB-51's job). The refspec rules below are what keep a named remote safe.
  const remote = positional[0];
  if (remote !== undefined) {
    const host = hostOf(remote);
    if (host !== undefined) {
      const decision = decideHost(rules, host, `git push ${remote}`);
      if (decision._tag === "block") return decision;
    }
  }

  // The first positional is the remote; everything after it is a refspec.
  const refspecs = positional.slice(1);
  if (refspecs.length === 0) {
    return block(
      "git push with no ref is refused: it pushes whatever the current branch tracks, which may be main. Name the ref: git push origin refs/heads/factory/<session-id>.",
    );
  }
  for (const refspec of refspecs) {
    if (refspec.startsWith("+")) {
      return block(
        `git push ${refspec} is refused: a leading + forces the update. Push an ordinary commit on refs/heads/factory/<session-id> instead.`,
      );
    }
    const { source, destination } = refspecSides(refspec);
    if (
      source.length === 0 ||
      destination === undefined ||
      destination.length === 0
    ) {
      return block(
        `git push ${refspec} is refused: deleting a ref loses whatever it pointed at. Push a commit instead.`,
      );
    }
    const ref = fullRef(destination);
    if (ref.startsWith("refs/tags/")) {
      return block(
        `git push ${refspec} is refused: this session may only push refs/heads/factory/**. Push the branch instead.`,
      );
    }
    if (!rules.pushRefPrefixes.some((prefix) => ref.startsWith(prefix))) {
      return block(
        `pushing ${ref} is refused: this session may only push ${rules.pushRefPrefixes.join(", ")}. Push refs/heads/factory/<session-id> instead.`,
      );
    }
    if (
      rules.sessionId !== undefined &&
      ref.startsWith(SESSION_BRANCH_NAMESPACE) &&
      ref !== `${SESSION_BRANCH_NAMESPACE}${rules.sessionId}`
    ) {
      return block(
        `pushing ${ref} is refused: this session owns ${SESSION_BRANCH_NAMESPACE}${rules.sessionId} and may not push another session's branch. Push refs/heads/factory/${rules.sessionId} instead.`,
      );
    }
  }
  return ALLOW;
};

const decideGit = (
  rules: AutonomyRules,
  words: readonly string[],
): PolicyDecision => {
  const { subcommand, args } = gitSubcommand(words);
  switch (subcommand) {
    case "push":
      return decidePush(rules, args);
    case "remote": {
      const verb = args.find((word) => !word.startsWith("-"));
      if (
        verb === "add" ||
        verb === "set-url" ||
        verb === "remove" ||
        verb === "rm" ||
        verb === "rename"
      ) {
        return block(
          `git remote ${verb} is refused: changing remotes is always blocked (D11). The session's remote is fixed; push refs/heads/factory/<session-id> to it instead.`,
        );
      }
      return ALLOW;
    }
    case "config": {
      // `git config remote.origin.url <url>` and an `insteadOf` rewrite change where a name points
      // just as surely as `git remote set-url` does, and neither goes through that verb. A read
      // (`git config --get remote.origin.url`) has one positional and is left alone.
      const positional = args.filter((word) => !word.startsWith("-"));
      const key = positional[0]?.toLowerCase();
      if (
        positional.length >= 2 &&
        key !== undefined &&
        (key.endsWith(".url") ||
          key.endsWith(".pushurl") ||
          key.endsWith(".insteadof"))
      ) {
        return block(
          `git config ${key} is refused: it changes where a remote points, which is always blocked (D11). The session's remote is fixed; push refs/heads/factory/<session-id> to it instead.`,
        );
      }
      return ALLOW;
    }
    case "clone":
    case "fetch":
    case "pull":
    case "ls-remote": {
      for (const word of args) {
        const host = hostOf(word);
        if (host === undefined) continue;
        const decision = decideHost(rules, host, word);
        if (decision._tag === "block") return decision;
      }
      return ALLOW;
    }
    default:
      return ALLOW;
  }
};

// ---------------------------------------------------------------------------------------------
// Egress
// ---------------------------------------------------------------------------------------------

/** Commands whose arguments are somewhere to reach. */
const EGRESS_COMMANDS = new Set([
  "curl",
  "wget",
  "nc",
  "ncat",
  "netcat",
  "ssh",
  "scp",
  "sftp",
  "rsync",
  "telnet",
]);

/** A hostname, an IPv4 literal, or a bracketed IPv6 literal — not just any word with a dot in it. */
const HOSTNAME =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const IPV6 = /^\[[0-9a-f:]+\]$/i;

const isLoopback = (host: string): boolean =>
  host === "localhost" ||
  host === "127.0.0.1" ||
  host === "::1" ||
  host === "[::1]" ||
  host.endsWith(".localhost");

/**
 * The host an argument names, or `undefined` when it names no host. Deliberately strict: a JSON
 * body, a header or a relative path must not be mistaken for a destination, or every `curl -d`
 * would be refused.
 */
const hostOf = (value: string): string | undefined => {
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(value);
  let rest = scheme === null ? value : value.slice(scheme[0].length);
  const scpLike = /^[^\s/@]+@[^\s/]+:/.test(rest);
  if (
    scheme === null &&
    !scpLike &&
    !value.includes(".") &&
    !value.includes(":")
  ) {
    return undefined;
  }
  const at = rest.lastIndexOf("@");
  if (at !== -1) rest = rest.slice(at + 1);
  const authority = rest.split("/")[0] ?? "";
  const host = (
    authority.startsWith("[")
      ? (authority.match(/^\[[^\]]*\]/)?.[0] ?? "")
      : (authority.split(":")[0] ?? "")
  ).toLowerCase();
  if (host.length === 0) return undefined;
  return isLoopback(host) ||
    IPV4.test(host) ||
    IPV6.test(host) ||
    HOSTNAME.test(host)
    ? host
    : undefined;
};

const decideHost = (
  rules: AutonomyRules,
  host: string,
  where: string,
): PolicyDecision => {
  if (isLoopback(host)) return ALLOW;
  if (rules.allowedHosts.includes(host)) return ALLOW;
  return block(
    `network egress to ${host} (${where}) is refused: only ${rules.allowedHosts.join(", ")} may be reached from a session (D11). Use an allowlisted host, or ask a human to widen the allowlist.`,
  );
};

/**
 * Flags whose next word is a value, not a destination, per egress command. Without this, `curl -o
 * out.json https://github.com/x` is refused as egress to `out.json` — the policy would refuse the
 * ordinary way to write a downloaded file, and a policy nobody can work under is a policy that gets
 * removed.
 */
const EGRESS_VALUE_FLAGS: Readonly<Record<string, readonly string[]>> = {
  curl: [
    "-A",
    "-b",
    "-c",
    "-d",
    "-e",
    "-F",
    "-H",
    "-K",
    "-o",
    "-T",
    "-u",
    "-U",
    "-w",
    "-x",
    "--connect-timeout",
    "--cookie",
    "--cookie-jar",
    "--data",
    "--data-binary",
    "--data-raw",
    "--data-urlencode",
    "--form",
    "--header",
    "--interface",
    "--max-time",
    "--output",
    "--proxy",
    "--referer",
    "--request",
    "--resolve",
    "--retry",
    "--url",
    "--user",
    "--user-agent",
    "--write-out",
  ],
  wget: [
    "-O",
    "-o",
    "-a",
    "-P",
    "-U",
    "-e",
    "--output-document",
    "--output-file",
    "--append-output",
    "--directory-prefix",
    "--user-agent",
    "--header",
    "--post-data",
    "--post-file",
    "--body-data",
    "--body-file",
    "--method",
    "--user",
    "--password",
    "--timeout",
    "--tries",
  ],
  ssh: [
    "-b",
    "-c",
    "-D",
    "-e",
    "-F",
    "-i",
    "-J",
    "-L",
    "-l",
    "-m",
    "-O",
    "-o",
    "-p",
    "-Q",
    "-R",
    "-S",
    "-W",
    "-w",
  ],
  scp: ["-c", "-F", "-i", "-J", "-l", "-o", "-P", "-S"],
  sftp: ["-b", "-c", "-F", "-i", "-J", "-l", "-o", "-P", "-S"],
  rsync: [
    "-e",
    "--rsh",
    "--exclude",
    "--include",
    "--files-from",
    "--port",
    "--bwlimit",
    "--log-file",
    "--password-file",
    "--timeout",
  ],
  nc: ["-p", "-s", "-w", "-q", "-I", "-O", "-M"],
  ncat: ["-p", "-s", "-w", "-q"],
  netcat: ["-p", "-s", "-w", "-q"],
  telnet: ["-l"],
};

/**
 * Which positional arguments of an egress command are destinations. `curl` and `wget` take URLs
 * anywhere; `ssh` and `nc` take `[user@]host` first and a command after it; `scp` and `rsync` take
 * sources first and the destination last — reading `scp f.txt host:/tmp/f` as "egress to f.txt"
 * was a false refusal.
 */
const EGRESS_TARGETS: Readonly<Record<string, "all" | "first" | "last">> = {
  curl: "all",
  wget: "all",
  nc: "first",
  ncat: "first",
  netcat: "first",
  ssh: "first",
  telnet: "first",
  scp: "last",
  sftp: "last",
  rsync: "last",
};

/** The positional arguments of a command, with flag values removed. */
const positionalOf = (
  name: string,
  args: readonly string[],
): readonly string[] => {
  const valueFlags = new Set(EGRESS_VALUE_FLAGS[name] ?? []);
  const out: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const word = args[index] ?? "";
    if (word.startsWith("-")) {
      if (valueFlags.has(word) && !word.includes("=")) index += 1;
      continue;
    }
    out.push(word);
  }
  return out;
};

/** Flags whose value is itself a destination: a proxy is where the traffic really goes. */
const EGRESS_PROXY_FLAGS = new Set(["-x", "--proxy"]);

/** D11's egress rule, applied to the destinations a command actually names. */
const decideEgress = (
  rules: AutonomyRules,
  name: string,
  args: readonly string[],
): PolicyDecision => {
  for (let index = 0; index < args.length; index += 1) {
    const word = args[index] ?? "";
    const flag = flagName(word);
    if (!EGRESS_PROXY_FLAGS.has(flag)) continue;
    const value = word.includes("=")
      ? word.slice(word.indexOf("=") + 1)
      : args[index + 1];
    if (value === undefined) continue;
    const host = hostOf(value);
    if (host === undefined) continue;
    const decision = decideHost(rules, host, `${name} ${flag} ${value}`);
    if (decision._tag === "block") return decision;
  }

  const positional = positionalOf(name, args);
  const mode = EGRESS_TARGETS[name] ?? "all";
  const targets =
    mode === "first"
      ? positional.slice(0, 1)
      : mode === "last"
        ? positional.slice(-1)
        : positional;
  for (const target of targets) {
    const host = hostOf(target);
    if (host === undefined) continue;
    const decision = decideHost(rules, host, `${name} ${target}`);
    if (decision._tag === "block") return decision;
  }
  return ALLOW;
};

// ---------------------------------------------------------------------------------------------
// Commands that write files
// ---------------------------------------------------------------------------------------------

/** Commands whose arguments name files they write, and which of those arguments are targets. */
const WRITE_COMMANDS: Readonly<Record<string, "all" | "last">> = {
  tee: "all",
  rm: "all",
  rmdir: "all",
  mkdir: "all",
  touch: "all",
  chmod: "all",
  chown: "all",
  truncate: "all",
  shred: "all",
  cp: "last",
  mv: "last",
  ln: "last",
  install: "last",
};

/**
 * `cd` out of the worktree is refused (D11). Without this, `cd /tmp && echo x > escaped.txt` writes
 * wherever it likes: the write rules judge a path as written, and the path is relative to a
 * directory the shell has just moved to. Refusing the move is the only place the policy can see it.
 * `cd` inside the worktree is allowed, and the write rules still judge every later path against the
 * worktree rather than against the moved-to directory — which is conservative, never permissive.
 */
const decideCd = (
  rules: AutonomyRules,
  name: string,
  args: readonly string[],
): PolicyDecision => {
  const target = args.find((word) => !word.startsWith("-"));
  if (target === undefined) {
    return block(
      `${name} without a directory is refused: the directory it moves to is not one this session can name, so it is not the worktree (${rules.worktree}). Stay in the worktree.`,
    );
  }
  if (isHomePath(target)) {
    return block(
      `${name} ${target} is refused: it names a home directory, which is outside this session's worktree (${rules.worktree}). Stay in the worktree.`,
    );
  }
  const resolved = resolvePath(rules.worktree, target);
  if (within(rules.worktree, resolved)) return ALLOW;
  return block(
    `${name} ${target} is refused: it leaves this session's worktree (${rules.worktree}), where every write and every command belongs. Stay in the worktree, or name a path inside it.`,
  );
};

const decideBash = (rules: AutonomyRules, command: string): PolicyDecision => {
  for (const segment of segmentsOf(tokenize(command))) {
    for (const target of segment.writeTargets) {
      const decision = decideWrite(rules, "redirecting output to", target);
      if (decision._tag === "block") return decision;
    }

    const words = commandWords(segment.argv);
    const name = baseName(words[0] ?? "");
    if (name.length === 0) continue;
    const args = words.slice(1);

    if (name === "git") {
      const decision = decideGit(rules, args);
      if (decision._tag === "block") return decision;
      continue;
    }
    if (name === "cd" || name === "pushd") {
      const decision = decideCd(rules, name, args);
      if (decision._tag === "block") return decision;
      continue;
    }
    if (EGRESS_COMMANDS.has(name)) {
      const decision = decideEgress(rules, name, args);
      if (decision._tag === "block") return decision;
      continue;
    }
    if (name === "dd") {
      for (const word of args) {
        if (!word.startsWith("of=")) continue;
        const decision = decideWrite(rules, "dd writing", word.slice(3));
        if (decision._tag === "block") return decision;
      }
      continue;
    }
    const mode = WRITE_COMMANDS[name];
    if (mode === undefined) continue;
    const targets =
      mode === "last"
        ? args.slice(-1)
        : args.filter((word) => !word.startsWith("-"));
    for (const target of targets) {
      const decision = decideWrite(rules, `${name} writing`, target);
      if (decision._tag === "block") return decision;
    }
  }
  return ALLOW;
};

// ---------------------------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------------------------

/** The tools whose arguments name a file the call will write. */
const WRITE_TOOLS = new Set(["write", "edit"]);

/** A call's argument as a string, or `undefined` when it is absent or anything else. */
const stringField = (
  args: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined => {
  const value = args[key];
  return typeof value === "string" ? value : undefined;
};

/**
 * The decision for one tool call. Pure: the same rules and the same call always give the same
 * answer, which is what makes the whole boundary a table in a test.
 *
 * A call this module does not recognise is allowed: D11 gates what escapes, and a tool the policy
 * has never heard of has not escaped anything yet.
 */
export const decideToolCall = (
  rules: AutonomyRules,
  call: ToolCall,
): PolicyDecision => {
  const refusal = decideRefusal(rules, call);
  // A refusal outranks a gate: asking a person about a call D11 refuses would offer them the power
  // to widen D11 per call, which is the opposite of what D11 is for.
  return refusal._tag === "allow" ? decideGate(rules, call) : refusal;
};

const decideRefusal = (
  rules: AutonomyRules,
  call: ToolCall,
): PolicyDecision => {
  const args = call.arguments;
  if (WRITE_TOOLS.has(call.name)) {
    const path = stringField(args, "path");
    // No path: the tool's own validation refuses the call, and a second message would only confuse.
    if (path === undefined) return ALLOW;
    return decideWrite(rules, `${call.name} writing`, path);
  }
  if (call.name === "bash") {
    const command = stringField(args, "command");
    if (command === undefined) return ALLOW;
    return decideBash(rules, command);
  }
  return ALLOW;
};

// ---------------------------------------------------------------------------------------------
// The gate (D15, LOB-52)
// ---------------------------------------------------------------------------------------------

/** A command as the gate compares it: trimmed, with runs of whitespace read as one space. */
const normalizeCommand = (command: string): string =>
  command.trim().replace(/\s+/g, " ");

/**
 * A configured gate in the form it is matched in: normalized, with its command word read as a
 * command is — `/usr/bin/npm publish` gates what `npm publish` gates.
 */
const normalizeGate = (gate: string): string => {
  const [first = "", ...rest] = normalizeCommand(gate).split(" ");
  return [baseName(first), ...rest].join(" ").trim();
};

/**
 * Words that open or close a compound command rather than name one: `then npm publish` and
 * `{ npm publish; }` run `npm publish`.
 */
const SHELL_KEYWORDS = new Set([
  "{",
  "}",
  "!",
  "if",
  "then",
  "else",
  "elif",
  "fi",
  "do",
  "done",
  "while",
  "until",
]);

/** Shells whose `-c` argument is a command line of its own: `bash -c 'npm publish'` runs it. */
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);

/** `xargs` flags that take a separate value, so the command it runs is read past them. */
const XARGS_VALUE_FLAGS = new Set([
  "-I",
  "-n",
  "-P",
  "-L",
  "-d",
  "-a",
  "-E",
  "-s",
]);
/** `timeout` flags that take a separate value. */
const TIMEOUT_VALUE_FLAGS = new Set(["-s", "-k", "--signal", "--kill-after"]);

/** `argv` past its leading flags, and past each flag's value when `valued` says it takes one. */
const pastFlags = (
  argv: readonly string[],
  valued: ReadonlySet<string>,
): readonly string[] => {
  let index = 0;
  while ((argv[index] ?? "").startsWith("-")) {
    index += valued.has(argv[index] ?? "") ? 2 : 1;
  }
  return argv.slice(index);
};

/**
 * The words of the command a segment really runs, for the gate: assignments, wrappers and compound
 * keywords dropped, and `timeout` and `xargs` read through to the command they start — so
 * `timeout 60 npm publish` and `xargs npm publish` are the `npm publish` they run. Bounded, because
 * every pass drops at least one word.
 */
const gateWords = (argv: readonly string[]): readonly string[] => {
  let words = argv;
  for (let pass = 0; pass < argv.length; pass += 1) {
    while (SHELL_KEYWORDS.has(words[0] ?? "")) words = words.slice(1);
    words = commandWords(words);
    const head = baseName(words[0] ?? "");
    if (head === "timeout") {
      // `timeout [flags] DURATION command…`
      words = pastFlags(words.slice(1), TIMEOUT_VALUE_FLAGS).slice(1);
    } else if (head === "xargs") {
      words = pastFlags(words.slice(1), XARGS_VALUE_FLAGS);
    } else {
      return words;
    }
  }
  return words;
};

/** `bash -c 'npm publish'`'s command line, or `undefined` for anything that is not a shell's `-c`. */
const shellScriptOf = (words: readonly string[]): string | undefined => {
  if (!SHELLS.has(baseName(words[0] ?? ""))) return undefined;
  const flag = words.findIndex(
    (word, index) => index > 0 && /^-[A-Za-z]*c[A-Za-z]*$/.test(word),
  );
  return flag === -1 ? undefined : words[flag + 1];
};

/**
 * Whether `words` runs `gate`: the same command word, then each of the gate's further words in order,
 * with only flags between them — `terraform -chdir=infra apply` and `npm --registry x publish` run
 * `terraform apply` and `npm publish`. A flag may take the word after it as its value (`--registry
 * x`), which is skipped as long as it is not the gate's next word. Any other word in between ends the
 * match: `npm run publish` is not `npm publish`, and `npm publishing` is not either.
 */
const runsGate = (words: readonly string[], gate: string): boolean => {
  const [command, ...rest] = gate.split(" ");
  if (command === undefined || command.length === 0) return false;
  if (baseName(words[0] ?? "") !== command) return false;
  let index = 1;
  for (const expected of rest) {
    for (;;) {
      const word = words[index];
      if (word === undefined) return false;
      if (word === expected) break;
      if (!word.startsWith("-")) return false;
      index += 1;
      const value = words[index];
      if (
        !word.includes("=") &&
        value !== undefined &&
        value !== expected &&
        !value.startsWith("-")
      )
        index += 1;
    }
    index += 1;
  }
  return true;
};

/**
 * The gate a command hits, if any: the first configured gate that one of its simple commands runs.
 *
 * Read per simple command, with assignments, wrappers and compound keywords dropped, by the same
 * reading the refusals use — so `cd pkg && npm publish`, `sudo npm publish`, `timeout 60 npm
 * publish` and `if …; then npm publish; fi` are the `npm publish` they run, `bash -c 'npm publish'`
 * is read into, and `echo npm publish` is an `echo`.
 *
 * What it cannot see, the text-reading caveats in this module's docstring name: a command spelled
 * through a variable (`$NPM publish`), an alias or function, `eval`, a script or Makefile that runs
 * it, or another interpreter (`node -e`). A gate is a prompt that stops the accident, not a boundary
 * (D15); a deployment that needs the boundary puts it outside the agent.
 */
const gateOf = (
  rules: AutonomyRules,
  command: string,
  depth = 0,
): string | undefined => {
  for (const segment of segmentsOf(tokenize(command))) {
    const words = gateWords(segment.argv);
    if (words.length === 0) continue;
    const script = shellScriptOf(words);
    if (script !== undefined && depth < 3) {
      const inner = gateOf(rules, script, depth + 1);
      if (inner !== undefined) return inner;
    }
    const gate = rules.approvalRequired.find((entry) => runsGate(words, entry));
    if (gate !== undefined) return gate;
  }
  return undefined;
};

/**
 * A call's arguments in a fixed form — sorted keys, no incidental whitespace — so the same call is
 * always the same text.
 *
 * A request id has to survive the retry, the resume and the restart that made LOB-52 worth doing:
 * the same gated call must name the same request each time it is attempted, or every attempt would
 * be a new ask.
 */
const canonical = (value: unknown): string => {
  if (value === null || typeof value !== "object")
    return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
};

/**
 * The id of the ask for this call. Derived from the call and nothing else, so a retried, resumed or
 * restarted attempt asks the same question and one answer settles every attempt. SHA-256 rather
 * than a short hash, because an approval for one command must never be read as an approval for
 * another that happened to collide with it.
 */
export const approvalRequestId = (call: ToolCall): string =>
  `ask-${call.name}-${createHash("sha256")
    .update(canonical(call.arguments))
    .digest("hex")
    .slice(0, 32)}`;

/** A gated command asks; everything else is allowed, because the refusal already ran. */
const decideGate = (rules: AutonomyRules, call: ToolCall): PolicyDecision => {
  if (rules.approvalRequired.length === 0) return ALLOW;
  if (call.name !== "bash") return ALLOW;
  const command = stringField(call.arguments, "command");
  if (command === undefined) return ALLOW;
  const gate = gateOf(rules, command);
  if (gate === undefined) return ALLOW;
  return {
    _tag: "ask",
    requestId: approvalRequestId(call),
    action: gate,
    detail: normalizeCommand(command),
  };
};

// ---------------------------------------------------------------------------------------------
// The docs rule (LOB-195)
// ---------------------------------------------------------------------------------------------

/** The factory skill (seeded by `0015_seed_docs_skill.ts`, LOB-225) that makes a run a docs run. */
export const DOCS_SKILL = "docs";

/**
 * What a run holding the `docs` skill may write (LOB-195): everything under `docs/`, and any
 * markdown file at the repository root.
 *
 * An entry ending in `/**` is a subtree of the worktree, a `*.<ext>` entry is a file at the
 * worktree root, and anything else is that exact worktree-relative path. Declared as a list so that
 * widening a docs run's reach is an edit here rather than a change to the check, and so the refusal
 * can print it — the sentence that lets the model write in the right place on its next try.
 */
export const DOCS_WRITE_ALLOWLIST: readonly string[] = ["docs/**", "*.md"];

/** Whether a normalized worktree-relative path falls inside one allowlist entry. */
const inAllowlist = (entry: string, path: string): boolean => {
  if (entry.endsWith("/**")) {
    const root = entry.slice(0, -3);
    return path === root || path.startsWith(`${root}/`);
  }
  if (entry.startsWith("*."))
    return !path.includes("/") && path.endsWith(entry.slice(1));
  return path === entry;
};

/** `target`, which must be `root` or inside it, as a path relative to it. */
const relativeTo = (root: string, target: string): string =>
  root === "/" ? target.slice(1) : target.slice(root.length + 1);

/**
 * The docs rule: inside the worktree, a documentation run writes documentation only (LOB-195).
 *
 * Two things are deliberate. It reads only the `write` and `edit` tools' `path` argument, so a
 * `bash` redirect or a `sed -i` is not covered: the rule is textual, exactly like the write table
 * it sits beside, and claims nothing more. It also resolves that path lexically, as the worktree
 * rule does, so a symlink under `docs/` pointing into the code is not caught — and it judges only
 * paths D11's worktree rule has already allowed, because a write that escapes the worktree is that
 * rule's refusal, not this one, which is why `docsPolicy` composes them in that order.
 */
const decideDocsWrite = (
  rules: AutonomyRules,
  call: ToolCall,
): PolicyDecision => {
  if (!WRITE_TOOLS.has(call.name)) return ALLOW;
  const path = stringField(call.arguments, "path");
  if (path === undefined) return ALLOW;
  const resolved = resolvePath(rules.worktree, path);
  // Outside the worktree is not this rule's to refuse: the worktree rule owns that sentence.
  if (!within(rules.worktree, resolved)) return ALLOW;
  if (
    DOCS_WRITE_ALLOWLIST.some((entry) =>
      inAllowlist(entry, relativeTo(rules.worktree, resolved)),
    )
  )
    return ALLOW;
  return block(
    `${call.name} writing ${path} is refused by the docs rule: this run holds the ${DOCS_SKILL} skill, so it may write documentation only (${DOCS_WRITE_ALLOWLIST.join(", ")}). Write that documentation instead.`,
  );
};

/**
 * Compose the docs rule into a session's policy: a run whose column holds the `docs` skill may
 * write documentation and nothing else (LOB-195).
 *
 * Composed, not substituted. The wrapped policy decides first, so every D11 refusal keeps its own
 * wording and a write that escapes the worktree is still refused as that; the docs rule is then
 * consulted for a call the wrapped policy allowed, and its refusal names itself and the allowlist.
 * `rules` is the wrapped policy's, unchanged: the narrowing lives in `decide`, and a policy that
 * reported rules it does not decide by would be a lie a reader has to check against `decide`.
 */
export const docsPolicy = (policy: SessionPolicy): SessionPolicy => ({
  rules: policy.rules,
  decide: (call) =>
    Effect.flatMap(policy.decide(call), (decision) =>
      decision._tag === "allow"
        ? Effect.sync(() => decideDocsWrite(policy.rules, call))
        : Effect.succeed(decision),
    ),
});

// ---------------------------------------------------------------------------------------------
// The read-only stage (LOB-74)
// ---------------------------------------------------------------------------------------------

/**
 * The roles whose stage only reads (docs/board.md B4, B6; LOB-74), each with the stage it is.
 *
 * Keyed by role because B6 says a role resolves to tool policy in one place: a column that declares
 * the `specifier` role is the specifying stage whatever the column is called, and a board that
 * renames the column keeps the rule. This is the tool-policy half of LOB-207's role table, for the
 * one role the MVP pipeline needs to be read-only; widening it is an edit here, not a change to
 * the check. A map rather than an object literal, because a role is free text in a board definition
 * and `constructor` must not find `Object.prototype`'s.
 */
export const READ_ONLY_ROLES: ReadonlyMap<string, string> = new Map([
  ["specifier", "specifying"],
]);

/** A run in a read-only stage: the stage, and the column and role that made it one. */
export type ReadOnlyStage = {
  readonly stage: string;
  readonly column: string;
  readonly role: string;
};

/**
 * The read-only stage a run is in, or `undefined` when its column's role writes (or it has no
 * column at all — a scratch session is not a stage).
 */
export const readOnlyStageOf = (
  run:
    | { readonly column?: string | undefined; readonly role?: string }
    | undefined,
): ReadOnlyStage | undefined => {
  if (run?.column === undefined || run.role === undefined) return undefined;
  const stage = READ_ONLY_ROLES.get(run.role);
  return stage === undefined
    ? undefined
    : { stage, column: run.column, role: run.role };
};

/**
 * A stage's refusal as data (LOB-74): which stage refused which call. `call` is the tool's name and
 * `what` is what the policy refused in it — the tool and its path, a redirect's target, the command
 * that is not a read, or the flag that makes a read command write.
 *
 * This is what the refusal's sentence is built from (`stageSentence`), and it stays inside this
 * module: Pi Durable's `beforeTool` takes a `block` string and nothing else, so the run's log
 * records the sentence. The sentence names every field, which is what the log and the model need.
 */
export type StageRefusal = {
  readonly _tag: "ReadOnlyStage";
  readonly stage: string;
  readonly column: string;
  readonly role: string;
  readonly call: string;
  readonly what: string;
};

/**
 * Tools that change the workspace whatever their arguments: `write` and `edit` by definition, and
 * `verify` because what it runs is the worktree's own scripts (see `./verify`), which a read-only
 * stage has no change of its own to prove with. `read`, `ask` and `bash` stay: reading the code and
 * asking about it is the stage's whole job, and `bash` is judged by `stageBashRefusalOf`.
 */
const STAGE_REFUSED_TOOLS = new Set(["write", "edit", "verify"]);

/**
 * The commands a read-only stage's `bash` may run, each with the flags that make it write or run
 * another program (`find -delete`, `sed -i`, `sort -o`, `rg --pre`). **An allowlist, so it fails
 * closed:** a command that is not here is refused, which is what keeps `perl -pi`, `patch`, `tar x`,
 * `npm install`, `python3 -c` and every program nobody thought of out of a stage that writes
 * nothing. The cost is that an unusual read is refused too, and the refusal says what reads instead.
 *
 * No interpreter is here, `awk` included: what an interpreter does is its program, not its command
 * line. `git` is judged by its subcommand (`stageGitRefusalOf`); a shell is judged by its `-c`
 * script, and refused without one.
 */
const STAGE_READ_COMMANDS: ReadonlyMap<string, readonly string[]> = new Map([
  ...[
    ":",
    "[",
    "[[",
    "basename",
    "cat",
    "cd",
    "cksum",
    "cmp",
    "column",
    "comm",
    "cut",
    "df",
    "diff",
    "dirname",
    "du",
    "echo",
    "egrep",
    "exit",
    "expand",
    "export",
    "false",
    "fgrep",
    "fold",
    "grep",
    "head",
    "hexdump",
    "id",
    "jq",
    "join",
    "ls",
    "md5sum",
    "nl",
    "od",
    "paste",
    "popd",
    "printenv",
    "printf",
    "pushd",
    "pwd",
    "read",
    "readlink",
    "realpath",
    "rev",
    "seq",
    "set",
    "sha1sum",
    "sha256sum",
    "shasum",
    "sleep",
    "stat",
    "strings",
    "tac",
    "tail",
    "tee",
    "test",
    "tr",
    "true",
    "type",
    "uname",
    "unexpand",
    "uniq",
    "wc",
    "which",
    "whoami",
  ].map((name): [string, readonly string[]] => [name, []]),
  ["date", ["-s", "--set"]],
  ["file", ["-C", "--compile"]],
  [
    "find",
    [
      "-delete",
      "-exec",
      "-execdir",
      "-ok",
      "-okdir",
      "-fprint",
      "-fprint0",
      "-fprintf",
      "-fls",
    ],
  ],
  ["fd", ["-x", "-X", "--exec", "--exec-batch"]],
  ["rg", ["--pre"]],
  ["sed", ["-i", "--in-place"]],
  ["sort", ["-o", "--output"]],
  ["tree", ["-o"]],
]);

/**
 * Whether `word` is the flag `flag`, as the command line spells it: a long flag with or without
 * `=value` or abbreviated, a one-letter flag inside a cluster or with its value attached (`-ni`,
 * `-i.bak`, `-ofile`), and a one-dash word flag (`find -delete`) only as itself.
 */
const spellsFlag = (word: string, flag: string): boolean => {
  if (flag.startsWith("--")) {
    const name = flagName(word);
    return name.startsWith("--") && name.length > 2 && flag.startsWith(name);
  }
  if (flag.length > 2) return word === flag;
  if (word.startsWith("--")) return false;
  const cluster = /^-([A-Za-z]+)/.exec(word)?.[1];
  return cluster !== undefined && cluster.includes(flag.slice(1));
};

/** The first of `flags` that `args` gives, as the refusal names it. */
const refusedFlagOf = (
  args: readonly string[],
  flags: readonly string[],
): string | undefined =>
  flags.find((flag) => args.some((word) => spellsFlag(word, flag)));

/** `git` subcommands that only read, whatever their arguments (`--output` aside). */
const GIT_READS = new Set([
  "annotate",
  "blame",
  "cat-file",
  "check-attr",
  "check-ignore",
  "cherry",
  "count-objects",
  "describe",
  "diff",
  "diff-files",
  "diff-index",
  "diff-tree",
  "for-each-ref",
  "grep",
  "help",
  "log",
  "ls-files",
  "ls-tree",
  "merge-base",
  "name-rev",
  "range-diff",
  "rev-list",
  "rev-parse",
  "shortlog",
  "show",
  "show-branch",
  "show-ref",
  "status",
  "var",
  "version",
  "whatchanged",
]);

/**
 * `git` subcommands that read or write by their verb, with the verbs that read; `""` is the verb
 * left out, which for each of these is a listing (`git remote`, `git notes`).
 */
const GIT_READ_VERBS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["bisect", new Set(["log"])],
  ["notes", new Set(["", "list", "show"])],
  ["reflog", new Set(["", "show", "exists"])],
  ["remote", new Set(["", "show", "get-url"])],
  ["sparse-checkout", new Set(["list"])],
  ["stash", new Set(["list", "show"])],
  ["submodule", new Set(["", "status", "summary"])],
  ["worktree", new Set(["list"])],
]);

/**
 * `git branch`, `git tag` and `git config` both list and write. Each is a read when it gives none
 * of its writing flags and either asks to list or names no more than a read takes.
 */
type GitListing = {
  readonly writes: readonly string[];
  readonly lists: readonly string[];
  /** Flags whose value is the next word, so that word is not counted as an operand. */
  readonly valued: ReadonlySet<string>;
  /** The most operands a read gives: `git config user.name` reads, `git config user.name x` sets. */
  readonly operands: number;
};

const GIT_LISTINGS: ReadonlyMap<string, GitListing> = new Map([
  [
    "branch",
    {
      writes: [
        "-d",
        "-D",
        "-m",
        "-M",
        "-c",
        "-C",
        "-f",
        "-u",
        "--delete",
        "--move",
        "--copy",
        "--force",
        "--set-upstream-to",
        "--unset-upstream",
        "--edit-description",
        "--track",
        "--create-reflog",
      ],
      lists: ["-l", "--list", "--show-current"],
      valued: new Set([
        "--contains",
        "--no-contains",
        "--merged",
        "--no-merged",
        "--points-at",
        "--sort",
        "--format",
      ]),
      operands: 0,
    },
  ],
  [
    "tag",
    {
      writes: [
        "-d",
        "-a",
        "-s",
        "-u",
        "-f",
        "-m",
        "-F",
        "-e",
        "--delete",
        "--annotate",
        "--sign",
        "--local-user",
        "--force",
        "--message",
        "--file",
        "--edit",
        "--create-reflog",
      ],
      lists: ["-l", "--list", "-v", "--verify"],
      valued: new Set([
        "--contains",
        "--no-contains",
        "--merged",
        "--no-merged",
        "--points-at",
        "--sort",
        "--format",
      ]),
      operands: 0,
    },
  ],
  [
    "config",
    {
      writes: [
        "-e",
        "--add",
        "--unset",
        "--unset-all",
        "--replace-all",
        "--rename-section",
        "--remove-section",
        "--edit",
      ],
      lists: [
        "-l",
        "--list",
        "--get",
        "--get-all",
        "--get-regexp",
        "--get-urlmatch",
      ],
      valued: new Set(["-f", "--file", "--blob", "--type", "--default"]),
      operands: 1,
    },
  ],
]);

/** The words of `args` that are not flags and not a `valued` flag's value. */
const operandsOf = (
  args: readonly string[],
  valued: ReadonlySet<string>,
): readonly string[] => {
  const out: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const word = args[index] ?? "";
    if (!word.startsWith("-")) out.push(word);
    else if (valued.has(word)) index += 1;
  }
  return out;
};

/**
 * What a `git` invocation does that a read-only stage refuses, or `undefined` when it only reads.
 * Fails closed like the command table: a subcommand that is not known to read is refused. A global
 * `-c` is refused too, because a config value can name a program git runs (`core.pager`,
 * `diff.external`), and so is `--output`, which makes a `diff` or a `log` write a file.
 */
const stageGitRefusalOf = (words: readonly string[]): string | undefined => {
  const { subcommand, args } = gitSubcommand(words);
  const globals = words.slice(0, words.length - args.length - 1);
  if (globals.includes("-c")) return "git -c";
  if (subcommand.length === 0) return undefined;
  if (args.some((word) => spellsFlag(word, "--output"))) {
    return `git ${subcommand} --output`;
  }
  if (GIT_READS.has(subcommand)) return undefined;
  const verbs = GIT_READ_VERBS.get(subcommand);
  if (verbs !== undefined) {
    const verb = args.find((word) => !word.startsWith("-")) ?? "";
    return verbs.has(verb)
      ? undefined
      : `git ${[subcommand, verb].filter((part) => part.length > 0).join(" ")}`;
  }
  const listing = GIT_LISTINGS.get(subcommand);
  if (listing !== undefined) {
    const write = refusedFlagOf(args, listing.writes);
    if (write !== undefined) return `git ${subcommand} ${write}`;
    const operands = operandsOf(args, listing.valued);
    const verb = operands[0] ?? "";
    // `git config get` and `git config list` are the newer spelling of a read.
    if (subcommand === "config" && (verb === "get" || verb === "list")) {
      return undefined;
    }
    if (refusedFlagOf(args, listing.lists) !== undefined) return undefined;
    return operands.length <= listing.operands
      ? undefined
      : `git ${subcommand} ${verb}`;
  }
  return `git ${subcommand}`;
};

/** Words that only head a `for` or `select` loop: the loop's name and its list, not a command. */
const LOOP_HEADS = new Set(["for", "select"]);

/**
 * What a read-only stage refuses in a `bash` command, or `undefined` when every simple command in it
 * reads (LOB-74): a redirect into a file, a command that is not in `STAGE_READ_COMMANDS`, a read
 * command given a flag that makes it write, or a `git` that is not a read — and the same inside a
 * shell's `-c` script, `$(…)`, backticks or a subshell.
 *
 * What it does not see is what the text does not show: a `sed` script's own `w` command, a program
 * named in an environment variable (`GIT_PAGER=…`), or a path that is a symlink. A heredoc's body is
 * read as commands, so a heredoc is refused unless every line of it is a read.
 */
const stageBashRefusalOf = (command: string, depth = 0): string | undefined => {
  for (const segment of segmentsOf(tokenize(command))) {
    const redirect = segment.writeTargets.find(
      (target) => !isNotAWrite(target),
    );
    if (redirect !== undefined) return `redirecting output to ${redirect}`;
    const words = gateWords(segment.argv);
    const name = baseName(words[0] ?? "");
    if (name.length === 0 || LOOP_HEADS.has(name)) continue;
    const args = words.slice(1);
    if (SHELLS.has(name)) {
      const script = shellScriptOf(words);
      if (script === undefined || depth >= 3) return `running ${name}`;
      const inner = stageBashRefusalOf(script, depth + 1);
      if (inner !== undefined) return inner;
      continue;
    }
    if (name === "git") {
      const refusal = stageGitRefusalOf(args);
      if (refusal !== undefined) return refusal;
      continue;
    }
    const flags = STAGE_READ_COMMANDS.get(name);
    if (flags === undefined) return `running ${name}`;
    const flag = refusedFlagOf(args, flags);
    if (flag !== undefined) return `${name} ${flag}`;
    // `tee FILE` and `uniq INPUT OUTPUT` write the file an operand names; `tee` to a pipe or a
    // device, and `uniq` reading one file, only read.
    const operands = args.filter((word) => !word.startsWith("-"));
    const written = name === "tee" ? operands : operands.slice(1);
    const target = written.find((word) => !isNotAWrite(word));
    if ((name === "tee" || name === "uniq") && target !== undefined) {
      return `${name} writing ${target}`;
    }
  }
  return undefined;
};

/** What a stage's refusal of a `bash` call adds: what its `bash` may run instead. */
const STAGE_BASH_HINT =
  " Its bash runs only commands that read (ls, cat, head, tail, grep, rg, find, wc, git log, show, diff, status, blame, grep) and redirects nothing into a file.";

/** The sentence a stage's refusal is: what was refused, which stage and column, and what to do. */
const stageSentence = (refusal: StageRefusal): string =>
  `${refusal.what} is refused: this run is in the read-only ${refusal.stage} stage (column "${refusal.column}", role ${refusal.role}), which reads the workspace and changes nothing in it.${refusal.call === "bash" ? STAGE_BASH_HINT : ""} Read and search instead, and put what you found in your answer or ask a question with the ask tool.`;

/**
 * What a read-only stage refuses in one call, as data, or `undefined` when the stage lets it through
 * to the session's own policy (LOB-74). Pure, like `decideToolCall`.
 */
export const stageRefusalOf = (
  stage: ReadOnlyStage,
  call: ToolCall,
): StageRefusal | undefined => {
  const what = STAGE_REFUSED_TOOLS.has(call.name)
    ? [call.name, stringField(call.arguments, "path")]
        .filter((part) => part !== undefined)
        .join(" ")
    : call.name === "bash"
      ? stageBashRefusalOf(stringField(call.arguments, "command") ?? "")
      : undefined;
  return what === undefined
    ? undefined
    : { _tag: "ReadOnlyStage", ...stage, call: call.name, what };
};

/**
 * The read-only stage's decision for one call (LOB-74): a refusal naming the stage and the column,
 * or `allow`, which hands the call on to the session's own policy.
 */
export const decideStageCall = (
  stage: ReadOnlyStage,
  call: ToolCall,
): PolicyDecision => {
  const refusal = stageRefusalOf(stage, call);
  return refusal === undefined ? ALLOW : block(stageSentence(refusal));
};

/**
 * Compose a read-only stage into a session's policy (LOB-74): a run whose column's role is a
 * read-only stage is refused `write`, `edit`, `verify` and every `bash` that is not a known read,
 * and its refusal says which stage and which column.
 *
 * The stage decides **first**, unlike the docs rule. A docs run may write, so a write that escapes
 * the worktree is D11's to word ("write inside the worktree instead"); a read-only run may write
 * nowhere, and that advice would send it to a second refusal. The stage's sentence is the one the
 * model can act on. A call the stage allows goes to the wrapped policy unchanged, so every D11
 * refusal and every gate still holds in a read-only run, and a gated call a stage refuses is never
 * asked about — nobody should be asked to approve what the stage forbids.
 */
export const readOnlyStagePolicy = (
  policy: SessionPolicy,
  stage: ReadOnlyStage,
): SessionPolicy => ({
  rules: policy.rules,
  decide: (call) =>
    Effect.flatMap(
      Effect.sync(() => decideStageCall(stage, call)),
      (decision) =>
        decision._tag === "allow"
          ? policy.decide(call)
          : Effect.succeed(decision),
    ),
});

// ---------------------------------------------------------------------------------------------
// The seam
// ---------------------------------------------------------------------------------------------

/**
 * The policy one session runs under: the rules its worktree resolved, and the decision point.
 *
 * `decide` is an Effect rather than a plain function so that the policy that replaces this one can
 * await something durable — an approval recorded with `api.memo` (D15, LOB-52) — without the hook
 * adapter changing.
 */
export type SessionPolicy = {
  readonly rules: AutonomyRules;
  readonly decide: (call: ToolCall) => Effect.Effect<PolicyDecision>;
};

/** D11's rules as a session policy. */
export const autonomyPolicy = (
  config: AutonomyConfig,
  worktree: string,
  sessionId?: string,
): SessionPolicy => {
  const rules = autonomyRules(config, worktree, sessionId);
  return {
    rules,
    decide: (call) => Effect.sync(() => decideToolCall(rules, call)),
  };
};

/**
 * The policy service: what may run unattended, as a service so the control plane reads it from the
 * context instead of importing a constant (D11's config surface).
 */
export type PolicyShape = {
  /** The configuration this deployment runs under. */
  readonly config: AutonomyConfig;
  /** The policy for one session's worktree, and the session that owns its branch. */
  readonly forWorktree: (worktree: string, sessionId?: string) => SessionPolicy;
};

export class Policy extends Context.Service<Policy, PolicyShape>()(
  "@repo/harness/Policy",
) {}

/** The default policy layer: D11's rules, with `config` widening or narrowing them. */
export const PolicyLive = (
  config: AutonomyConfig = DEFAULT_AUTONOMY,
): Layer.Layer<Policy> =>
  Layer.succeed(Policy, {
    config,
    forWorktree: (worktree, sessionId) =>
      autonomyPolicy(config, worktree, sessionId),
  });

/**
 * What a gated call asks a person: the call's identity, and what it would run.
 *
 * `requestId` names the call, not one ask of it: the same call is the same id on every attempt. An
 * approval covers one run (see `ApprovalAsker`), so the recorder may record a later run of the same
 * call under a request id of its own; the answer says which id it recorded.
 */
export type ApprovalAsk = {
  readonly requestId: string;
  readonly action: string;
  readonly detail: string;
};

/**
 * Where an ask stands, as the recorder answers it, under the request id it recorded the ask as.
 *
 * - `pending`: waiting for a person. `fresh` is whether this ask recorded the request; a retry of a
 *   call already waiting records nothing and is told so.
 * - `approved`: a person said yes, and this answer spent the approval — the call runs once on it.
 * - `denied`: a person said no. A denial stands for that exact call for the rest of the session.
 * - `unrecorded`: the recorder could not record the ask, which is not an answer — the call stays
 *   blocked, nothing is memoized, and the next attempt asks again.
 */
export type ApprovalAnswer =
  | {
      readonly _tag: "pending";
      readonly requestId: string;
      readonly fresh: boolean;
    }
  | {
      readonly _tag: "approved";
      readonly requestId: string;
      readonly actor: string;
    }
  | {
      readonly _tag: "denied";
      readonly requestId: string;
      readonly actor: string;
    }
  | { readonly _tag: "unrecorded"; readonly reason: string };

/**
 * How a session records the ask. A function rather than a service, because the recorder lives in the
 * control plane (`packages/core`) and this module must not depend on it; the control plane closes
 * over its own approvals service and hands the session this.
 *
 * It answers with where the request stands, because the same call asked again — the agent retrying
 * once a person decided — has to run if they said yes and be refused if they said no, rather than
 * ask a second time. Recording an ask whose id is already recorded and still pending must record
 * nothing.
 *
 * An approval is good for one run (D15): the recorder that answers `approved` marks the approval
 * used in the same step, so the next identical call — a later turn, possibly after the agent changed
 * what the command acts on — asks a person again rather than running on the old yes.
 *
 * Absent: a caller that has no approval channel, in which case a gated call is blocked with a
 * sentence saying so rather than run ungated.
 */
export type ApprovalAsker = (ask: ApprovalAsk) => Effect.Effect<ApprovalAnswer>;

/**
 * What a tool task remembers about its ask, in `api.memo` (D15): the question and the settled
 * answer it got. The memo is the asking task's, so it lives exactly as long as the call can still
 * run — Pi Durable drops a task's memos when it settles — and survives what that call survives.
 *
 * Only a settled answer is memoized. An approval is spent when it is answered, so a recovery that
 * reruns the task's first phase after a crash or a restart has to read its `approved` back rather
 * than ask: asked again, the recorder would find the approval used and ask a person afresh. A
 * `pending` answer is not memoized, because asking again costs nothing (the recorder answers from
 * the request it holds) and is how an approval given while the process was down takes effect.
 */
type ApprovalMemo = {
  readonly requestId: string;
  readonly action: string;
  readonly detail: string;
  readonly answer: "approved" | "denied";
  readonly actor: string;
};

/** The memo name for one ask. Exported so a test can read the memo the hook wrote. */
export const approvalMemoKey = (requestId: string): string =>
  `factory.approval:${requestId}`;

/** An ask as one recorded request: the action and detail it asked about, under the recorded id. */
type Asked = {
  readonly requestId: string;
  readonly action: string;
};

const askedSentence = (ask: Asked): string =>
  `\`${ask.action}\` needs a person's approval, and one has been asked for (request ${ask.requestId}). It did not run. Do not retry it until you are told it was approved; carry on with work that does not need it, or end your turn and say what is waiting.`;

const pendingSentence = (ask: Asked): string =>
  `\`${ask.action}\` is still waiting for a person's approval (request ${ask.requestId}); it was asked for once and is not asked for again. It did not run. Carry on with work that does not need it, or end your turn and say what is waiting.`;

const deniedSentence = (ask: Asked, actor: string): string =>
  `\`${ask.action}\` was denied by ${actor} (request ${ask.requestId}), so it did not run. Do not retry it; find a way that does not need it, or say why it is needed.`;

const unrecordedSentence = (ask: Asked, reason: string): string =>
  `\`${ask.action}\` needs a person's approval, and the request could not be recorded (${reason}), so it did not run. Try it again later.`;

const ungatedSentence = (ask: Asked): string =>
  `\`${ask.action}\` needs a person's approval and this session has no approval channel, so it did not run (request ${ask.requestId}). Ask a human to run it.`;

/** What the hook returns for a settled answer: an approved call runs, a denied one is blocked. */
const outcomeOf = (
  memo: ApprovalMemo,
): { readonly block: string } | undefined =>
  memo.answer === "approved"
    ? undefined
    : { block: deniedSentence(memo, memo.actor) };

/**
 * A gated call's ask, once per tool task (D15, LOB-52).
 *
 * Read the memo first: a task that already got a settled answer — this is a recovery rerunning its
 * first phase — reuses it and does not ask again, which is what keeps a crash mid-run from spending
 * a second approval. Otherwise ask. A pending answer blocks the call and is not memoized; a settled
 * one is memoized, then acted on. Ask before memoizing, because an ask that could not be recorded
 * must stay retryable; a crash between an `approved` answer and its memo leaves a spent approval and
 * no memo, so the rerun asks a person again — it fails closed, never into a second unasked run.
 */
const askOnce = (
  decision: ApprovalAsk,
  api: HookApi,
  context: ChordContext,
  ask: ApprovalAsker | undefined,
): Effect.Effect<{ readonly block: string } | undefined> =>
  Effect.gen(function* () {
    const key = approvalMemoKey(decision.requestId);
    const remembered = yield* Effect.promise(() =>
      api.memo<ApprovalMemo>(key, context),
    );
    if (remembered !== undefined) return outcomeOf(remembered);
    if (ask === undefined) return { block: ungatedSentence(decision) };
    const answer = yield* ask({
      requestId: decision.requestId,
      action: decision.action,
      detail: decision.detail,
    });
    switch (answer._tag) {
      case "unrecorded":
        return { block: unrecordedSentence(decision, answer.reason) };
      case "pending": {
        const asked = { requestId: answer.requestId, action: decision.action };
        return {
          block: answer.fresh ? askedSentence(asked) : pendingSentence(asked),
        };
      }
      case "approved":
      case "denied": {
        // First writer wins: if a concurrent attempt memoized first, its answer is the one this
        // task got.
        const memo = yield* Effect.promise(() =>
          api.memo<ApprovalMemo>(
            key,
            {
              requestId: answer.requestId,
              action: decision.action,
              detail: decision.detail,
              answer: answer._tag,
              actor: answer.actor,
            },
            context,
          ),
        );
        return outcomeOf(memo);
      }
    }
  });

/**
 * The one place this module touches Pi Durable: a `ToolTask` hook beside `CodingTools`.
 *
 * `beforeTool` is the decision, and its refusal becomes Pi Durable's `blocked` result — a message
 * the model reads and can correct from. A gated call is a third outcome (LOB-52): the request is
 * recorded through `ask` (`askOnce`), and the call is blocked while the answer is pending. The tool
 * never runs and the hook does not wait, so a run waiting on a person ends its turn and is not busy:
 * the session parks idle with the approval pending in its log. Once a person approves, the next
 * attempt at the same call runs — once; the settled answer is memoized with `api.memo` so a
 * recovered rerun of that task does not ask again. `afterTool` changes nothing today,
 * and is registered because it is the seam the egress audit writes through; returning the result
 * untouched is also the invariant that keeps the policy from altering what a tool reported.
 */
export const policyExtension = (
  policy: SessionPolicy,
  ask?: ApprovalAsker,
): Extension =>
  defineExtension({
    name: POLICY_EXTENSION,
    hooks: [
      hook(ToolTask, {
        beforeTool: (call, api, context) =>
          Effect.runPromise(
            Effect.gen(function* () {
              const decision = yield* policy.decide(call);
              if (decision._tag === "block") return { block: decision.reason };
              if (decision._tag === "allow") return undefined;
              return yield* askOnce(decision, api, context, ask);
            }),
          ),
        afterTool: (_call, result) => result,
      }),
    ],
  });
