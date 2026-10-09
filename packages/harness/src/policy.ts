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
 */
import type { ToolCall } from "@earendil-works/pi-ai";
import type { Extension } from "@earendil-works/pi-durable";
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
  | { readonly _tag: "block"; readonly reason: string };

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
};

/** D11's boundary as configuration. */
export const DEFAULT_AUTONOMY: AutonomyConfig = {
  pushRefPrefixes: ["refs/heads/factory/"],
  allowedHosts: ["github.com", "api.github.com", "codeload.github.com"],
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

const segmentsOf = (tokens: readonly string[]): readonly Segment[] => {
  const out: Segment[] = [];
  let argv: string[] = [];
  let writeTargets: string[] = [];
  let redirect: string | undefined;

  const flush = (): void => {
    if (argv.length > 0 || writeTargets.length > 0) {
      out.push({ argv, writeTargets });
    }
    argv = [];
    writeTargets = [];
    redirect = undefined;
  };

  for (const token of tokens) {
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
 * The one place this module touches Pi Durable: a `ToolTask` hook beside `CodingTools`.
 *
 * `beforeTool` is the decision, and its refusal becomes Pi Durable's `blocked` result — a message
 * the model reads and can correct from. `afterTool` changes nothing today, and is registered
 * because it is the seam the approval outcome and the egress audit write through (D15, LOB-52);
 * returning the result untouched is also the invariant that keeps the policy from altering what a
 * tool reported.
 */
export const policyExtension = (policy: SessionPolicy): Extension =>
  defineExtension({
    name: POLICY_EXTENSION,
    hooks: [
      hook(ToolTask, {
        beforeTool: (call) =>
          Effect.runPromise(policy.decide(call)).then((decision) =>
            decision._tag === "block" ? { block: decision.reason } : undefined,
          ),
        afterTool: (_call, result) => result,
      }),
    ],
  });
