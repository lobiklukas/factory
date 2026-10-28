/**
 * What `factory handoff` (and the MCP server's `handoff` tool) takes from a local checkout
 * (S-local-agent-handoff-mcp): the work in progress as one git patch, where it was, and where the
 * factory's run of it should start.
 *
 * - **The patch is the working tree against the base.** The diff from the merge base of `HEAD` and
 *   the base branch to the files on disk: local commits not on the base, staged and unstaged edits,
 *   and untracked files git does not ignore. It is written through a scratch index
 *   (`GIT_INDEX_FILE`), so the operator's own index — what they staged — is never touched.
 *   `--binary --full-index` keeps binary files and every pre-image blob id, so the run's three-way
 *   apply (`@repo/core`'s `./handoff`) can take it on a base that moved since.
 * - **The base is the remote's default branch.** A PR from the factory's run merges into it, which is
 *   what handing work over means; `--base` names another. It is read from the checkout's remote
 *   (`origin` when it has one) rather than the local branch, which may be behind or ahead of what the
 *   factory's checkout holds; a base only the local repository knows is used as it stands.
 * - **The cap is measured before anything is sent.** `MAX_HANDOFF_PATCH_BYTES`, the server's own,
 *   counted as the server counts it — the patch once JSON-escaped, as the request carries it — with
 *   the server's words (`handoffCapRefusal`): a refused handoff makes no card and sends nothing.
 *   The diff is counted as it streams, never held past the cap.
 * - **Byte for byte, or not at all.** The patch travels as a string, so a text file that is not
 *   UTF-8 (git prints a Latin-1 file's bytes as they are) is refused, naming it, rather than sent
 *   with U+FFFD in place of its bytes.
 * - **Every git call runs no hook and no fsmonitor**, as the control plane's do (`@repo/core`'s
 *   `./git.ts`): reading a checkout must not execute it.
 */
import { Effect, Option, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { FileSystem, Path } from "effect";
import { RepoSlug } from "@repo/domain/Session";
import {
  handoffCapRefusal,
  handoffPatchFiles,
  MAX_HANDOFF_PATCH_BYTES,
  MAX_TASK_BODY_CHARS,
  MAX_TASK_TITLE_CHARS,
} from "@repo/domain/Task";
import type { TaskHandoffInput } from "@repo/domain/Task";

/**
 * Why a handoff was not taken: `code` is the word a script branches on (`reportFailures` prints a
 * tagged error's tag in snake case, so this one is `handoff_refused`), and `message` says what to do.
 */
export class HandoffRefused extends Schema.TaggedError<HandoffRefused>()(
  "HandoffRefused",
  { message: Schema.String },
) {}

/** No hook and no fsmonitor, whatever the checkout's config says (`@repo/core`'s `./git.ts`). */
const QUIET_GIT = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
] as const;

type GitRun = {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  /** The bytes stdout carried, counted in full even when `stdout` stopped at `limit`. */
  readonly bytes: number;
  /**
   * What stdout's bytes come to once JSON-escaped (`handoffPatchWireBytes`'s count, taken from the
   * bytes), counted in full like `bytes`: the size the handoff cap measures.
   */
  readonly wireBytes: number;
  /**
   * The paths of the `diff --git` sections of stdout that are not UTF-8 — a Latin-1 or Shift-JIS
   * text file, which git prints as it is. A string would carry them with U+FFFD in place of their
   * bytes, so the run would get a different file than the checkout has.
   */
  readonly notUtf8: ReadonlyArray<string>;
};

/**
 * One byte's size once JSON-escaped, in a UTF-8 stream: `"` and `\\` and the short control escapes
 * are two, every other control character six, every other byte itself (a multibyte character's
 * bytes are carried as they are). The same count as `handoffPatchWireBytes` gives the decoded text.
 */
const wireSize = (byte: number): number =>
  byte === 0x22 || byte === 0x5c
    ? 2
    : byte < 0x20
      ? byte === 0x08 ||
        byte === 0x09 ||
        byte === 0x0a ||
        byte === 0x0c ||
        byte === 0x0d
        ? 2
        : 6
      : 1;

/** `diff --git ` as bytes: where each file's section of a patch starts, at the start of a line. */
const DIFF_HEADER = [...new TextEncoder().encode("diff --git ")];

/** The paths of the sections of `bytes` (a whole patch) whose bytes are not UTF-8. */
const notUtf8Sections = (bytes: Uint8Array): ReadonlyArray<string> => {
  const starts: Array<number> = [];
  for (let at = 0; at < bytes.length; at += 1) {
    if (
      (at === 0 || bytes[at - 1] === 0x0a) &&
      DIFF_HEADER.every((byte, offset) => bytes[at + offset] === byte)
    )
      starts.push(at);
  }
  if (starts[0] !== 0) starts.unshift(0);
  const strict = new TextDecoder("utf-8", { fatal: true });
  const lenient = new TextDecoder();
  const found: Array<string> = [];
  for (const [index, start] of starts.entries()) {
    const section = bytes.subarray(start, starts[index + 1] ?? bytes.length);
    try {
      strict.decode(section);
    } catch {
      const header = lenient.decode(section).split("\n")[0] ?? "";
      found.push(handoffPatchFiles(`${header}\n`)[0] ?? header);
    }
  }
  return found;
};

/**
 * One git call in `cwd`. `limit` bounds what of stdout is kept (the rest is counted, not held); a
 * git that cannot start is exit `-1` with the platform's message as stderr.
 */
const git = (
  cwd: string,
  args: ReadonlyArray<string>,
  options: {
    readonly env?: Record<string, string>;
    readonly limit?: number;
  } = {},
): Effect.Effect<GitRun, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const handle = yield* spawner.spawn(
      ChildProcess.make("git", [...QUIET_GIT, ...args], {
        cwd,
        extendEnv: true,
        env: { GIT_TERMINAL_PROMPT: "0", ...options.env },
        stdin: "ignore",
      }),
    );
    const limit = options.limit ?? Number.POSITIVE_INFINITY;
    const [out, stderr, exitCode] = yield* Effect.all(
      [
        handle.stdout.pipe(
          Stream.runFold(
            () => ({
              chunks: [] as Array<Uint8Array>,
              bytes: 0,
              wireBytes: 0,
            }),
            (acc, chunk: Uint8Array) => {
              if (acc.bytes < limit)
                acc.chunks.push(chunk.slice(0, limit - acc.bytes));
              let wire = 0;
              for (const byte of chunk) wire += wireSize(byte);
              return {
                chunks: acc.chunks,
                bytes: acc.bytes + chunk.byteLength,
                wireBytes: acc.wireBytes + wire,
              };
            },
          ),
        ),
        handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
        handle.exitCode,
      ],
      { concurrency: "unbounded" },
    );
    const held = new Uint8Array(
      out.chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0),
    );
    let offset = 0;
    for (const chunk of out.chunks) {
      held.set(chunk, offset);
      offset += chunk.byteLength;
    }
    // Only a whole output is judged: a cut one may end inside a character, and is refused by its
    // size anyway.
    const notUtf8 = out.bytes > limit ? [] : notUtf8Sections(held);
    return {
      stdout: new TextDecoder().decode(held),
      stderr,
      exitCode: Number(exitCode),
      bytes: out.bytes,
      wireBytes: out.wireBytes,
      notUtf8,
    };
  }).pipe(
    Effect.scoped,
    Effect.catch((error) =>
      Effect.succeed({
        stdout: "",
        stderr: String(error),
        exitCode: -1,
        bytes: 0,
        wireBytes: 0,
        notUtf8: [],
      }),
    ),
  );

/** git's first line of diagnosis, for a refusal to quote. */
const said = (run: GitRun): string =>
  run.stderr.trim().split("\n")[0] ?? `exit ${run.exitCode}`;

/**
 * The repository a remote URL names, as `owner/name`: a GitHub-style `https://host/owner/name(.git)`
 * or `git@host:owner/name(.git)`. `undefined` for anything else (a local path, a nested group).
 */
export const repoFromRemoteUrl = (url: string): RepoSlug | undefined => {
  const trimmed = url
    .trim()
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "");
  const scp = /^[^@/\s]+@[^:/\s]+:([^/\s]+\/[^/\s]+)$/.exec(trimmed);
  const web = /^[a-z][a-z0-9+.-]*:\/\/[^/\s]+\/([^/\s]+\/[^/\s]+)$/i.exec(
    trimmed,
  );
  const slug = scp?.[1] ?? web?.[1];
  return slug === undefined
    ? undefined
    : Option.getOrUndefined(Schema.decodeOption(RepoSlug)(slug));
};

/** The remote a checkout's base is read from: `origin` when it has one, else its first, else none. */
const remoteOf = (
  cwd: string,
): Effect.Effect<
  string | undefined,
  never,
  ChildProcessSpawner.ChildProcessSpawner
> =>
  git(cwd, ["remote"]).pipe(
    Effect.map((run) => {
      const remotes = run.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "");
      return remotes.includes("origin") ? "origin" : remotes[0];
    }),
  );

/**
 * The repository the checkout at `cwd` is a clone of, as its remote's URL names it
 * (`repoFromRemoteUrl`); `undefined` outside a checkout, with no remote, or with one that names none.
 */
export const remoteRepo = (
  cwd: string,
): Effect.Effect<
  RepoSlug | undefined,
  never,
  ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.gen(function* () {
    const remote = yield* remoteOf(cwd);
    if (remote === undefined) return undefined;
    const url = yield* git(cwd, ["remote", "get-url", remote]);
    return url.exitCode === 0 ? repoFromRemoteUrl(url.stdout) : undefined;
  });

/** What a checkout hands off, before it becomes a card. */
export type CollectedHandoff = {
  /** The checkout's top level, where every git call ran. */
  readonly root: string;
  readonly handoff: TaskHandoffInput;
  /** The ref the card's runs start from: the base branch's name, never a remote-tracking ref. */
  readonly baseRef: string;
  readonly files: ReadonlyArray<string>;
  readonly bytes: number;
  /** The repository the checkout's remote names, when it names one (`repoFromRemoteUrl`). */
  readonly repo?: RepoSlug | undefined;
};

/**
 * Read a checkout's work in progress (module doc). `cwd` is any directory inside it; `base` the
 * branch the factory's run starts from, absent for the remote's default. `maxBytes` is the cap,
 * `MAX_HANDOFF_PATCH_BYTES` unless a test names a smaller one.
 */
export const collectHandoff = (input: {
  readonly cwd: string;
  readonly base?: string | undefined;
  readonly maxBytes?: number | undefined;
  /**
   * `false` leaves untracked files out: only what the checkout already tracks travels, so a stray
   * unignored file (a `.env.local`, a scratch dump) is not swept into the card. Default `true`.
   */
  readonly untracked?: boolean | undefined;
}): Effect.Effect<
  CollectedHandoff,
  HandoffRefused,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const maxBytes = input.maxBytes ?? MAX_HANDOFF_PATCH_BYTES;
    const top = yield* git(input.cwd, ["rev-parse", "--show-toplevel"]);
    if (top.exitCode !== 0) {
      return yield* new HandoffRefused({
        message: `${input.cwd} is not inside a git checkout, so there is no work to hand off: run it from the repository (${said(top)})`,
      });
    }
    const root = top.stdout.trim();
    const run = (args: ReadonlyArray<string>) => git(root, args);
    const head = yield* run(["rev-parse", "--verify", "--quiet", "HEAD"]);
    if (head.exitCode !== 0) {
      return yield* new HandoffRefused({
        message:
          "the checkout has no commit yet, so there is no base a run could start from: commit the base first",
      });
    }
    const symbolic = yield* run(["symbolic-ref", "--quiet", "--short", "HEAD"]);
    const branch =
      symbolic.exitCode === 0 && symbolic.stdout.trim() !== ""
        ? symbolic.stdout.trim()
        : undefined;
    const remote = yield* remoteOf(root);
    const remoteDefault =
      remote === undefined
        ? undefined
        : (yield* run([
            "symbolic-ref",
            "--quiet",
            "--short",
            `refs/remotes/${remote}/HEAD`,
          ])).stdout
            .trim()
            .replace(new RegExp(`^${remote}/`), "");
    const baseRef = input.base ?? (remoteDefault || "main");
    // Where the base is as the factory will see it: the remote's copy when there is one, which is
    // what its checkout fetches; the local branch otherwise.
    const candidates = [
      ...(remote === undefined ? [] : [`refs/remotes/${remote}/${baseRef}`]),
      baseRef,
    ];
    let baseTip: string | undefined;
    for (const candidate of candidates) {
      const resolved = yield* run([
        "rev-parse",
        "--verify",
        "--quiet",
        "--end-of-options",
        `${candidate}^{commit}`,
      ]);
      if (resolved.exitCode === 0) {
        baseTip = resolved.stdout.trim();
        break;
      }
    }
    if (baseTip === undefined) {
      return yield* new HandoffRefused({
        message: `the base ${baseRef} is not a branch this checkout knows (${candidates.join(", ")}): name the branch the run should start from with --base`,
      });
    }
    const mergeBase = yield* run(["merge-base", "HEAD", baseTip]);
    if (mergeBase.exitCode !== 0) {
      return yield* new HandoffRefused({
        message: `HEAD shares no history with ${baseRef}, so its work cannot be applied there: name the base it was branched from with --base`,
      });
    }
    const baseCommit = mergeBase.stdout.trim();
    // The scratch index: HEAD's tree, then every file on disk git does not ignore, so the diff is
    // the working tree's whatever the operator staged — and their own index is left as it was.
    const scratch = yield* fs
      .makeTempDirectory({ prefix: "factory-handoff-" })
      .pipe(
        Effect.mapError(
          (cause) =>
            new HandoffRefused({
              message: `no scratch directory for the handoff's index: ${cause.message}`,
            }),
        ),
      );
    const env = { GIT_INDEX_FILE: path.join(scratch, "index") };
    const diff = yield* Effect.gen(function* () {
      for (const args of [
        ["read-tree", "HEAD"],
        input.untracked === false
          ? ["add", "--update", "--", "."]
          : ["add", "--all", "--", "."],
      ]) {
        const step = yield* git(root, args, { env });
        if (step.exitCode !== 0) {
          return yield* new HandoffRefused({
            message: `git ${args[0]} could not read the working tree: ${said(step)}`,
          });
        }
      }
      return yield* git(
        root,
        [
          "diff",
          "--cached",
          "--binary",
          "--full-index",
          "--no-color",
          "--no-ext-diff",
          "--no-textconv",
          baseCommit,
        ],
        { env, limit: maxBytes + 1 },
      );
    }).pipe(
      Effect.ensuring(
        fs.remove(scratch, { recursive: true }).pipe(Effect.ignore),
      ),
    );
    if (diff.exitCode !== 0) {
      return yield* new HandoffRefused({
        message: `git diff could not read the work in progress: ${said(diff)}`,
      });
    }
    // `git diff` ends its output with the last hunk's newline; the patch keeps it, so it applies.
    // The cap counts the patch as the request carries it, escaped (`handoffPatchWireBytes`), as the
    // server does; `bytes` is its size on disk, which the card reports.
    const bytes = diff.bytes;
    if (diff.wireBytes > maxBytes) {
      return yield* new HandoffRefused({
        message:
          maxBytes === MAX_HANDOFF_PATCH_BYTES
            ? handoffCapRefusal(diff.wireBytes)
            : `the handoff patch is ${diff.wireBytes} bytes as a card carries it, over the ${maxBytes}-byte cap`,
      });
    }
    if (diff.notUtf8.length > 0) {
      return yield* new HandoffRefused({
        message: `${diff.notUtf8.join(", ")} ${diff.notUtf8.length === 1 ? "is a text file" : "are text files"} that ${diff.notUtf8.length === 1 ? "is" : "are"} not UTF-8, which a handoff patch cannot carry byte for byte: commit and push the work to a branch and hand off from it (--base), or convert ${diff.notUtf8.length === 1 ? "it" : "them"} to UTF-8`,
      });
    }
    const patch = diff.stdout;
    const files = handoffPatchFiles(patch);
    if (files.length === 0) {
      return yield* new HandoffRefused({
        message: `there is no work to hand off: the working tree is the same as ${baseRef} at ${baseCommit.slice(0, 12)}. Use \`factory board add\` for a card with no patch`,
      });
    }
    const repo = yield* remoteRepo(root);
    return {
      root,
      handoff: {
        patch,
        ...(branch === undefined ? {} : { branch }),
        baseCommit,
      },
      baseRef,
      files,
      bytes,
      repo,
    };
  });

/** The most files the card's body lists by name; the rest are counted. */
const LISTED_FILES = 50;

/**
 * The card a handoff becomes: its title (the one given, else the note's first line, else the branch)
 * and its body — the note, then what was handed off, so every run of the card is told in its prompt
 * that its worktree starts with that work committed and is to continue it rather than redo it.
 */
export const handoffCardText = (input: {
  readonly collected: CollectedHandoff;
  readonly note?: string | undefined;
  readonly title?: string | undefined;
}): { readonly title: string; readonly body: string } => {
  const { collected } = input;
  const note = input.note?.trim() ?? "";
  const branch = collected.handoff.branch;
  const firstLine = note.split("\n")[0]?.trim() ?? "";
  const title = (
    input.title?.trim() ||
    firstLine ||
    `Continue ${branch ?? "the handed-off work"}`
  ).slice(0, MAX_TASK_TITLE_CHARS);
  const listed = collected.files.slice(0, LISTED_FILES);
  const more = collected.files.length - listed.length;
  const handedOff = [
    `Handed off from a local checkout${branch === undefined ? "" : ` on \`${branch}\``}, taken against \`${collected.handoff.baseCommit ?? collected.baseRef}\` (base \`${collected.baseRef}\`): ${collected.files.length} file${collected.files.length === 1 ? "" : "s"}, ${collected.bytes} bytes.`,
    "The run's worktree starts with that work committed on its branch: continue it rather than redo it.",
    "",
    ...listed.map((file) => `- ${file}`),
    ...(more > 0 ? [`- … and ${more} more`] : []),
  ].join("\n");
  const body = note === "" ? handedOff : `${note}\n\n${handedOff}`;
  return { title, body: body.slice(0, MAX_TASK_BODY_CHARS) };
};
