/**
 * A handed-off card's patch, applied where its run works (S-local-agent-handoff-mcp).
 *
 * `factory handoff` sends a local agent's work in progress — the diff from the commit it started at
 * to its working tree — with a new card (`@repo/domain/Task`'s `TaskHandoff`). A run of the card cut
 * on a fresh branch (`factory/<session-id>`, D10) starts from the card's base, which holds none of
 * that work; this module puts it there before the agent's first turn, as one commit on the run's
 * branch:
 *
 * - **Applied, then committed.** A commit rather than a dirty tree because the card's change is its
 *   branch: `non_empty_diff` and the PR step measure `base...branch`, and uncommitted work is in
 *   neither (`./prStep`'s `diffSize`). Whether a branch has it is read from the branch — a commit
 *   carrying the card's `Factory-Handoff` trailer, or a tree that already holds the change — never
 *   from how the run came to be on it: a later run that continues the card's branch (C19) finds the
 *   commit there, and one that continues the branch of a refused or interrupted apply applies it.
 * - **Three-way.** The patch carries every pre-image blob id (`--full-index`), so a base that moved
 *   since the handoff still takes it when the change does not conflict. One that does conflict is
 *   refused, the worktree reset to the base, and the refusal names git's own reason.
 * - **Before the agent, by the control plane.** D10 makes the worktree the agent's and has the
 *   control plane read nothing in it (`./workspace`'s `removeWorkspace`); this runs only while the
 *   run has taken no turn — at its create, and again at a retried create or a first message — so
 *   nothing in it was written by the agent yet. Every call still runs with no hook and no fsmonitor (`./git.ts`'s rule), and the commit is
 *   `--no-verify` and unsigned, under a fixed identity, so no configuration decides what it is.
 */
import { Effect, Schema } from "effect";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- the apply is the local git CLI, the same one `workspace.ts` cuts the worktree with.
import { execFile } from "node:child_process";
import { handoffPatchFiles } from "@repo/domain/Task";

/** How long one git call of the apply may run before it is killed. */
const GIT_TIMEOUT_MS = 120_000;

/** No hook and no fsmonitor run on the control plane's behalf (`./git.ts`, `./workspace.ts`). */
const QUIET_GIT = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
] as const;

/** Who the handoff commit is by: the factory, whatever the host's git config says. */
const HANDOFF_IDENTITY = [
  "-c",
  "user.name=factory handoff",
  "-c",
  "user.email=handoff@factory.invalid",
  "-c",
  "commit.gpgSign=false",
] as const;

/** The trailer the commit carries, naming the card, so the branch's history says where it came from. */
export const HANDOFF_TRAILER = "Factory-Handoff";

/** Why a handoff did not land: what git said, in one sentence a refusal can carry. */
export class HandoffNotApplied extends Schema.TaggedError<HandoffNotApplied>()(
  "HandoffNotApplied",
  { message: Schema.String },
) {}

type GitRun = {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
};

/** One git call in `cwd`, with `input` on its stdin. A git that cannot start is exit `-1`. */
const git = (
  cwd: string,
  args: ReadonlyArray<string>,
  input?: string,
): Effect.Effect<GitRun> =>
  Effect.callback<GitRun>((resume, signal) => {
    const child = execFile(
      "git",
      [...QUIET_GIT, ...args],
      {
        cwd,
        encoding: "utf8",
        signal,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, stdout, stderr) =>
        resume(
          Effect.succeed({
            stdout,
            stderr,
            exitCode:
              error === null
                ? 0
                : typeof error.code === "number"
                  ? error.code
                  : -1,
          }),
        ),
    );
    child.stdin?.end(input ?? "");
  });

/** git's own diagnosis, first lines only: what a refusal quotes. */
const said = (run: GitRun): string =>
  (run.stderr.trim() || run.stdout.trim() || `exit ${run.exitCode}`)
    .split("\n")
    .slice(0, 6)
    .join("; ");

/**
 * What a run's branch holds of the card's handoff once `applyHandoff` is done with it:
 *
 * - `committed`: the patch was applied here, as `commit`.
 * - `carried`: the branch already had it — a commit carrying the card's trailer (`commit`), the one
 *   an earlier run of the card made on the branch it continues (C19), or, with no such commit, a tree
 *   that already holds the patch's change (the base took it, or the agent rewrote the commit), which
 *   `commit` is then absent for.
 */
export type HandoffOutcome =
  | {
      readonly _tag: "committed";
      readonly commit: string;
      readonly files: ReadonlyArray<string>;
    }
  | { readonly _tag: "carried"; readonly commit?: string | undefined };

/** A regular expression that matches `text` literally. */
const literal = (text: string): string =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The commit on `HEAD` that carries the card's trailer, if any. Bounded by `since`, the card's
 * creation less a day: a handoff commit is written after its card was, and a rebase or an amend only
 * moves its committer date later, so the walk never has to read the history the base had before.
 */
const trailerCommit = (
  worktree: string,
  taskId: string,
  since: string | undefined,
): Effect.Effect<string | undefined> =>
  git(worktree, [
    "log",
    "-1",
    "--format=%H",
    "--extended-regexp",
    `--grep=^${literal(HANDOFF_TRAILER)}: ${literal(taskId)}$`,
    ...(since === undefined ? [] : [`--since=${since}`]),
    "HEAD",
    "--",
  ]).pipe(
    Effect.map((run) =>
      run.exitCode === 0 && run.stdout.trim() !== ""
        ? run.stdout.trim()
        : undefined,
    ),
  );

/** When the trailer walk may stop: a day before the card was made, so clock skew cannot cut it short. */
const sinceOf = (createdAt: string | undefined): string | undefined => {
  if (createdAt === undefined) return undefined;
  const millis = Date.parse(createdAt);
  return Number.isNaN(millis)
    ? undefined
    : new Date(millis - 86_400_000).toISOString();
};

/**
 * Make sure the branch `worktree` has checked out carries the card's handoff, and commit `patch` on
 * it when it does not. Whether it does is a fact about the branch, not about how the run came to be
 * on it: a run that continues the card's branch (C19) finds the commit an earlier run made and adds
 * none, while one that continues the branch of a run whose apply was refused, or of one that died
 * between cutting its worktree and committing, applies it there (or is refused in turn). A tree that
 * already holds the change — its reverse applies — is carried too, with nothing to commit.
 *
 * A patch that does not apply and a commit that fails are `HandoffNotApplied`, naming git's reason,
 * and leave the worktree at what its branch says.
 */
export const applyHandoff = (input: {
  readonly worktree: string;
  readonly patch: string;
  readonly taskId: string;
  readonly branch?: string | undefined;
  readonly baseCommit?: string | undefined;
  /** When the card was made (ISO 8601): bounds the walk for the trailer. */
  readonly createdAt?: string | undefined;
}): Effect.Effect<HandoffOutcome, HandoffNotApplied> =>
  Effect.gen(function* () {
    const carried = yield* trailerCommit(
      input.worktree,
      input.taskId,
      sinceOf(input.createdAt),
    );
    if (carried !== undefined) return { _tag: "carried", commit: carried };
    const reverse = yield* git(
      input.worktree,
      ["apply", "--reverse", "--check", "--whitespace=nowarn", "-"],
      input.patch,
    );
    if (reverse.exitCode === 0) return { _tag: "carried" };
    const applied = yield* git(
      input.worktree,
      ["apply", "--3way", "--index", "--whitespace=nowarn", "-"],
      input.patch,
    );
    if (applied.exitCode !== 0) {
      // A three-way apply that conflicted leaves the index and the files half-merged: back to the
      // branch's tip, so a refused run leaves a worktree that says what its branch says.
      yield* git(input.worktree, ["reset", "--quiet", "--hard", "HEAD"]);
      return yield* new HandoffNotApplied({
        message: `the card's handoff patch does not apply on this run's base: ${said(applied)}`,
      });
    }
    const staged = yield* git(input.worktree, ["diff", "--cached", "--quiet"]);
    if (staged.exitCode === 0) return { _tag: "carried" };
    const files = handoffPatchFiles(input.patch);
    const from =
      input.branch === undefined ? "a local checkout" : `local ${input.branch}`;
    const committed = yield* git(input.worktree, [
      ...HANDOFF_IDENTITY,
      "commit",
      "--quiet",
      "--no-verify",
      "-m",
      `Hand off ${files.length} file${files.length === 1 ? "" : "s"} from ${from}`,
      "-m",
      `The work in progress \`factory handoff\` sent with card ${input.taskId}${
        input.baseCommit === undefined
          ? ""
          : `, taken against ${input.baseCommit}`
      }, applied by the factory before the run's first turn.`,
      "-m",
      `${HANDOFF_TRAILER}: ${input.taskId}`,
    ]);
    if (committed.exitCode !== 0) {
      yield* git(input.worktree, ["reset", "--quiet", "--hard", "HEAD"]);
      return yield* new HandoffNotApplied({
        message: `the card's handoff patch applied but could not be committed: ${said(committed)}`,
      });
    }
    const head = yield* git(input.worktree, ["rev-parse", "HEAD"]);
    return { _tag: "committed", commit: head.stdout.trim(), files };
  });
