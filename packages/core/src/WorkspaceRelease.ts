/**
 * The terminal events that tear a session's worktree and branch down (LOB-268), wired to the
 * places they happen. `SessionService.releaseWorkspace` does the teardown; this module decides
 * when.
 *
 * - **A card reaches a terminal column** (`done`, `canceled`): every run of the card is released,
 *   with the column as the reason. `releaseFinishedCard` runs after the move committed, so it is
 *   the move's consequence and never its gate — a teardown that fails is logged, and the card is
 *   still where the person put it.
 * - **The PR merges**: every session whose recorded PR (`sessions.pr_url`, LOB-177) is the merged
 *   one is released as `merged`, and so is every reviewer run of that PR (LOB-36: one per head, on
 *   `factory/review-<number>-<sha12>` in the same repo), which records the PR as its review target
 *   rather than as a PR of its own. An unmerged close is not terminal — the card may still reopen
 *   it or open another — so it releases nothing.
 * - **An operator discards a session**: `discardSession` over RPC (`factory discard`), which calls
 *   `releaseWorkspace` directly.
 *
 * Nothing else releases a workspace: the idle sweep and a shutdown release the harness and the log
 * handle only, so a run's commits and uncommitted edits survive both.
 *
 * Every release is idempotent, so a merge followed by the card's `done` — or GitHub redelivering
 * the merge — tears down once and answers the first release's reason after that.
 */
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import type {
  ReleaseWorkspaceResult,
  SessionId,
  WorkspaceReleaseReason,
} from "@repo/domain/Session";
import { SessionId as SessionIdSchema } from "@repo/domain/Session";
import { isTerminalColumn, type Task } from "@repo/domain/Task";
import {
  githubPullRequestLifecycle,
  refuseGitHubDelivery,
  type PullRequestLifecycle,
} from "./LinearSync";
import { REVIEW_BRANCH_PREFIX } from "./ReviewTrigger";
import { SessionService } from "./SessionService";
import { TaskService } from "./TaskService";

/** Release one session's workspace, logging rather than failing: the event already happened. */
const releaseLogged = (
  sessionId: SessionId,
  reason: WorkspaceReleaseReason,
): Effect.Effect<ReleaseWorkspaceResult | undefined, never, SessionService> =>
  Effect.gen(function* () {
    const sessions = yield* SessionService;
    return yield* sessions
      .releaseWorkspace({ sessionId, reason })
      .pipe(
        Effect.catch((error) =>
          Effect.as(
            Effect.logWarning(
              `session ${sessionId}: could not release its workspace (${reason}): ${error.message}`,
            ),
            undefined,
          ),
        ),
      );
  });

/**
 * Release the workspaces of a card's runs when the card is in a terminal column, and do nothing
 * otherwise. Answers what each release reported, oldest run last, as `listRuns` orders them.
 */
export const releaseFinishedCard = (
  task: Task,
): Effect.Effect<
  ReadonlyArray<ReleaseWorkspaceResult>,
  never,
  SessionService | TaskService
> =>
  Effect.gen(function* () {
    if (!isTerminalColumn(task.column)) return [];
    const reason: WorkspaceReleaseReason =
      task.column === "done" ? "done" : "canceled";
    const tasks = yield* TaskService;
    const runs = yield* tasks
      .listRuns(task.id)
      .pipe(
        Effect.catch((error) =>
          Effect.as(
            Effect.logWarning(
              `card ${task.id} reached ${task.column}, but its runs could not be read to release their workspaces: ${error.message}`,
            ),
            [],
          ),
        ),
      );
    const released: ReleaseWorkspaceResult[] = [];
    for (const run of runs) {
      const result = yield* releaseLogged(run.sessionId, reason);
      if (result !== undefined) released.push(result);
    }
    return released;
  });

/**
 * Release the workspaces of the sessions that opened a PR that merged, and of the reviewer runs
 * that reviewed it. Answers how many sessions this call released — a redelivered merge finds them
 * released already and answers `0` — and anything but a merge releases none.
 */
export const releaseMergedPullRequest = (
  event: PullRequestLifecycle,
): Effect.Effect<number, never, SessionService | SqlClient> =>
  Effect.gen(function* () {
    if (event._tag !== "merged") return 0;
    const sql = yield* SqlClient;
    // Matched as the Linear mirror matches them (`syncPullRequestLifecycle`): by the PR's page, or
    // by its API resource for a session whose PR predates the step recording the page. A reviewer
    // run is matched by its branch, which names the PR's number, in the repo of a session that
    // opened the PR: the review trigger reviews only a PR the factory opened (`ReviewTrigger.ts`).
    const reviewBranches = `${REVIEW_BRANCH_PREFIX}${event.pr.number}-%`;
    const rows = yield* sql<{ readonly id: string }>`
      WITH opened AS (
        SELECT id, repo FROM sessions
        WHERE pr_url = ${event.pr.url} OR pr_url = ${event.apiUrl ?? event.pr.url}
      )
      SELECT id FROM opened
      UNION
      SELECT reviewer.id FROM sessions AS reviewer
      WHERE reviewer.branch LIKE ${reviewBranches}
        AND reviewer.repo IN (SELECT repo FROM opened WHERE repo IS NOT NULL)
      ORDER BY id
    `.pipe(
      Effect.catch((error) =>
        Effect.as(
          Effect.logWarning(
            `pull request ${event.pr.url} merged, but its sessions could not be read: ${error.message}`,
          ),
          [],
        ),
      ),
    );
    let released = 0;
    for (const row of rows) {
      if (!Schema.is(SessionIdSchema)(row.id)) continue;
      const result = yield* releaseLogged(row.id, "merged");
      if (result?.first === true) released += 1;
    }
    return released;
  });

const JsonBody = Schema.fromJsonString(Schema.Unknown);

/**
 * The same, from one GitHub `pull_request` delivery, as `POST /webhooks/github` receives it. The
 * delivery's signature is checked here, so nothing unsigned tears anything down, and nothing else
 * gates it: a merge releases its sessions whatever the Linear mirror of the same delivery answered,
 * because GitHub does not redeliver a failed delivery on its own.
 */
export const releaseMergedDelivery = (input: {
  readonly secret: string | undefined;
  readonly raw: string;
  readonly signature: string | undefined;
}): Effect.Effect<number, never, SessionService | SqlClient> =>
  Effect.gen(function* () {
    if (refuseGitHubDelivery(input) !== undefined) return 0;
    const payload = yield* Schema.decodeEffect(JsonBody)(input.raw).pipe(
      Effect.orElseSucceed(() => undefined),
    );
    const lifecycle = githubPullRequestLifecycle(payload);
    return lifecycle === undefined
      ? 0
      : yield* releaseMergedPullRequest(lifecycle);
  });
