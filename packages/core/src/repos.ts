/**
 * What a registered repo's local checkout says about itself (LOB-253): whether it is a git work tree
 * a session's worktree can be cut from, and whether it declares its commands in `.factory/config`.
 *
 * These are read from the disk each time a registry row is answered and never stored: the checkout
 * is operator state outside the factory, and a path that was a repository when it was registered can
 * be moved or deleted since. `registerRepo` uses the same check to refuse a path that is not one, so
 * the registry never gains a checkout `workspace.ts` would fail to cut a worktree from.
 *
 * The git call carries `core.hooksPath=/dev/null` and `core.fsmonitor=false` as `git.ts`'s
 * uncredentialed calls do: the path is the operator's, but nothing about it is the control plane's
 * to run.
 */
import { Effect } from "effect";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- a sync probe, as `workspace.ts`'s is.
import { execFileSync } from "node:child_process";
import { CONFIG_FILE, type WorkspaceDeps } from "./workspace";

/** What a checkout says about itself; both `false` when there is no checkout. */
export type CheckoutFacts = {
  readonly localPathIsGit: boolean;
  readonly hasFactoryConfig: boolean;
};

const NO_CHECKOUT: CheckoutFacts = {
  localPathIsGit: false,
  hasFactoryConfig: false,
};

/** How long `rev-parse` may take before the path is answered as not a work tree. */
const GIT_TIMEOUT_MS = 10_000;

/**
 * Whether `directory` is inside a git work tree. `rev-parse --is-inside-work-tree` prints `false`
 * (and exits 0) inside a `.git` directory, so the answer is the printed word, not the exit code; a
 * missing directory, a plain one, or a git that cannot run is `false`.
 */
export const isGitWorkTree = (directory: string): Effect.Effect<boolean> =>
  Effect.sync(() => {
    try {
      const answer = execFileSync(
        "git",
        [
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "core.fsmonitor=false",
          "-C",
          directory,
          "rev-parse",
          "--is-inside-work-tree",
        ],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: GIT_TIMEOUT_MS,
        },
      );
      return answer.trim() === "true";
    } catch {
      return false;
    }
  });

/** Read both facts about a checkout, or answer `NO_CHECKOUT` for a repo that has none. */
export const inspectCheckout = (
  localPath: string | undefined,
  deps: WorkspaceDeps,
): Effect.Effect<CheckoutFacts> =>
  localPath === undefined
    ? Effect.succeed(NO_CHECKOUT)
    : Effect.all(
        {
          localPathIsGit: isGitWorkTree(localPath),
          hasFactoryConfig: deps.fs
            .exists(deps.path.join(localPath, ...CONFIG_FILE))
            .pipe(Effect.orElseSucceed(() => false)),
        },
        { concurrency: "unbounded" },
      );
