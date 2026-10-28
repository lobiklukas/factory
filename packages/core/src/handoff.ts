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
 *   neither (`./prStep`'s `diffSize`). A later run of the card that continues the branch (C19) has
 *   it already; a run that cuts a fresh one applies it again.
 * - **Three-way.** The patch carries every pre-image blob id (`--full-index`), so a base that moved
 *   since the handoff still takes it when the change does not conflict. One that does conflict is
 *   refused, the worktree reset to the base, and the refusal names git's own reason.
 * - **Before the agent, by the control plane.** D10 makes the worktree the agent's and has the
 *   control plane read nothing in it (`./workspace`'s `removeWorkspace`); this runs once, right after
 *   the worktree was cut and before the run took any turn, so nothing in it was written by the agent
 *   yet. Every call still runs with no hook and no fsmonitor (`./git.ts`'s rule), and the commit is
 *   `--no-verify` and unsigned, under a fixed identity, so no configuration decides what it is.
 */
import { Data, Effect } from "effect";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- the apply is the local git CLI, the same one `workspace.ts` cuts the worktree with.
import { execFile } from "node:child_process";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- the checkout root is a filesystem fact, not a URL.
import { existsSync } from "node:fs";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- as above: `.git` is joined onto a directory this module was handed.
import { join } from "node:path";
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
export class HandoffNotApplied extends Data.TaggedError("HandoffNotApplied")<{
  readonly message: string;
}> {}

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

export type AppliedHandoff = {
  /** The commit the patch became on the run's branch. */
  readonly commit: string;
  readonly files: ReadonlyArray<string>;
};

/**
 * Apply `patch` in `worktree` and commit it on the branch the worktree has checked out. `undefined`
 * when it applied and changed nothing — the base already holds the change — so there is nothing to
 * commit. A worktree that is no checkout, a patch that does not apply, and a commit that fails are
 * `HandoffNotApplied`; the first two leave the worktree at its base.
 */
export const applyHandoff = (input: {
  readonly worktree: string;
  readonly patch: string;
  readonly taskId: string;
  readonly branch?: string | undefined;
  readonly baseCommit?: string | undefined;
}): Effect.Effect<AppliedHandoff | undefined, HandoffNotApplied> =>
  Effect.gen(function* () {
    if (!existsSync(join(input.worktree, ".git"))) {
      return yield* new HandoffNotApplied({
        message: `${input.worktree} is not a worktree, so there is nowhere to apply the card's handoff patch: register the repo's checkout (factory repo add <repo> --path <dir>) and start a new run`,
      });
    }
    const applied = yield* git(
      input.worktree,
      ["apply", "--3way", "--index", "--whitespace=nowarn", "-"],
      input.patch,
    );
    if (applied.exitCode !== 0) {
      // A three-way apply that conflicted leaves the index and the files half-merged: back to the
      // base, so a refused run leaves a worktree that says what the base says.
      yield* git(input.worktree, ["reset", "--quiet", "--hard", "HEAD"]);
      return yield* new HandoffNotApplied({
        message: `the card's handoff patch does not apply on this run's base: ${said(applied)}`,
      });
    }
    const staged = yield* git(input.worktree, [
      "diff",
      "--cached",
      "--quiet",
    ]);
    if (staged.exitCode === 0) return undefined;
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
    return { commit: head.stdout.trim(), files };
  });
