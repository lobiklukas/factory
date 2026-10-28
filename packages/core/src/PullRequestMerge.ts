/**
 * The factory's own record of a merge (LOB-44): when a PR a session opened merges, and when a later
 * PR reverts it. GitHub reports both on the `pull_request` webhook; this module writes them on the
 * sessions they belong to (`SessionService.recordMerge` → `factory.merge` and its two `sessions`
 * columns), so delegation-to-merge lead time, recovery and defect pressure are derived from the
 * factory's records and from no read of GitHub (`./outcomes`).
 *
 * - **A merge** is recorded on every session whose PR it is (`sessions.pr_url`, matched by page or
 *   by API resource, as the Linear mirror and the workspace release match it). A reviewer run is
 *   not one of them: it reviewed the PR, it did not open it.
 * - **A revert** is a merged PR whose body says `Reverts owner/repo#N` (GitHub's revert wording,
 *   `revertedPullRequest`): it is recorded on the sessions of PR `N`, whoever opened the revert —
 *   a person's revert of the factory's merge is exactly the defect signal.
 * - **An unmerged close** (F12) is recorded on the PR's sessions as a merge is, as the close
 *   (`sessions.pr_closed_at`): a card's later run then opens a new PR rather than adopting one nobody
 *   will review (`SessionService`'s `cardPullRequestFor`).
 *
 * Every write is idempotent: the first merge and the first revert stand, so GitHub redelivering an
 * event records nothing new. A session whose record fails is logged and the rest are still
 * recorded: the event already happened, and the delivery's answer is the Linear mirror's.
 */
import { DateTime, Effect, Option, Schema } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import type { SessionId } from "@repo/domain/Session";
import { SessionId as SessionIdSchema } from "@repo/domain/Session";
import type { MergeEvent } from "@repo/harness";
import {
  githubPullRequestLifecycle,
  refuseGitHubDelivery,
  type PullRequestLifecycle,
} from "./LinearSync";
import { SessionService } from "./SessionService";

/**
 * What one `pull_request` event recorded: how many sessions took a first merge, a first revert, and
 * (F12) a first unmerged close.
 */
export type MergeRecorded = {
  readonly merged: number;
  readonly reverted: number;
  readonly closed: number;
};

const NOTHING: MergeRecorded = { merged: 0, reverted: 0, closed: 0 };

/** The sessions whose recorded PR is `url` (or its API resource), oldest id first. */
const sessionsOfPullRequest = (
  url: string,
  apiUrl: string | undefined,
): Effect.Effect<ReadonlyArray<SessionId>, never, SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const rows = yield* sql<{ readonly id: string }>`
      SELECT id FROM sessions
      WHERE pr_url = ${url} OR pr_url = ${apiUrl ?? url}
      ORDER BY id
    `.pipe(
      Effect.catch((error) =>
        Effect.as(
          Effect.logWarning(
            `pull request ${url}: its sessions could not be read to record the merge: ${error.message}`,
          ),
          [],
        ),
      ),
    );
    return rows.flatMap((row) =>
      Schema.is(SessionIdSchema)(row.id) ? [row.id] : [],
    );
  });

/** Record one event on one session, logging rather than failing; `true` when it was the first. */
const recordLogged = (
  sessionId: SessionId,
  event: MergeEvent,
): Effect.Effect<boolean, never, SessionService> =>
  Effect.gen(function* () {
    const sessions = yield* SessionService;
    return yield* sessions.recordMerge({ sessionId, event }).pipe(
      Effect.map((recorded) => recorded.first),
      Effect.catch((error) =>
        Effect.as(
          Effect.logWarning(
            `session ${sessionId}: could not record the ${event._tag} of its pull request: ${error.message}`,
          ),
          false,
        ),
      ),
    );
  });

/**
 * Record one `pull_request` event's merge, and the revert it is, on the sessions they belong to —
 * or its unmerged close (F12). Anything else records nothing. `now` stands in for a merge or close
 * time the payload did not name.
 */
export const recordMergedPullRequest = (
  event: PullRequestLifecycle,
  now: string,
): Effect.Effect<MergeRecorded, never, SessionService | SqlClient> =>
  Effect.gen(function* () {
    if (event._tag === "closed") {
      const closedAt =
        event.closedAt !== undefined &&
        Option.isSome(DateTime.make(event.closedAt))
          ? event.closedAt
          : now;
      let closed = 0;
      for (const sessionId of yield* sessionsOfPullRequest(
        event.pr.url,
        event.apiUrl,
      )) {
        const first = yield* recordLogged(sessionId, {
          _tag: "closed",
          url: event.pr.url,
          number: event.pr.number,
          closedAt,
        });
        if (first) closed += 1;
      }
      return { ...NOTHING, closed };
    }
    if (event._tag !== "merged") return NOTHING;
    // GitHub's `merged_at` when it is an instant; `now` when it is absent or is not one, so a
    // malformed payload still records the merge rather than a value no rebuild could cast.
    const mergedAt =
      event.mergedAt !== undefined &&
      Option.isSome(DateTime.make(event.mergedAt))
        ? event.mergedAt
        : now;
    let merged = 0;
    for (const sessionId of yield* sessionsOfPullRequest(
      event.pr.url,
      event.apiUrl,
    )) {
      const first = yield* recordLogged(sessionId, {
        _tag: "merged",
        url: event.pr.url,
        number: event.pr.number,
        mergedAt,
        ...(event.commit === undefined ? {} : { commit: event.commit }),
      });
      if (first) merged += 1;
    }
    let reverted = 0;
    if (event.reverts !== undefined) {
      for (const sessionId of yield* sessionsOfPullRequest(
        event.reverts.url,
        undefined,
      )) {
        const first = yield* recordLogged(sessionId, {
          _tag: "reverted",
          by: event.pr.url,
          revertedAt: mergedAt,
        });
        if (first) reverted += 1;
      }
    }
    return { merged, reverted, closed: 0 };
  });

const JsonBody = Schema.fromJsonString(Schema.Unknown);

/**
 * The same, from one GitHub `pull_request` delivery as `POST /webhooks/github` receives it. The
 * signature is checked here, so nothing unsigned is recorded, and nothing else gates it: the merge
 * is recorded whatever the Linear mirror of the same delivery answered.
 */
export const recordMergedDelivery = (input: {
  readonly secret: string | undefined;
  readonly raw: string;
  readonly signature: string | undefined;
}): Effect.Effect<MergeRecorded, never, SessionService | SqlClient> =>
  Effect.gen(function* () {
    if (refuseGitHubDelivery(input) !== undefined) return NOTHING;
    const payload = yield* Schema.decodeEffect(JsonBody)(input.raw).pipe(
      Effect.orElseSucceed(() => undefined),
    );
    const lifecycle = githubPullRequestLifecycle(payload);
    if (lifecycle === undefined) return NOTHING;
    const now = DateTime.formatIso(yield* DateTime.now);
    return yield* recordMergedPullRequest(lifecycle, now);
  });
