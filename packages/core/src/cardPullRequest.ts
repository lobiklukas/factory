/**
 * A card follows its PR (C20): a merge moves the card to `done`, an unmerged close blocks it, and a
 * box GitHub cannot deliver webhooks to learns both by asking GitHub when the card is opened.
 *
 * Before this, merging in GitHub completed only the Linear issue (`./LinearSync`): the card sat in
 * `review` with its work on the base, and a person could move it to `done` while its PR was still
 * open, because the merge gate (B5) was enforced by actor alone. Now:
 *
 * - **A signed `pull_request` closed delivery settles the card** (`settleCardsOfDelivery`, which
 *   `POST /webhooks/github` runs after the merge is recorded on the PR's sessions). The card is the
 *   one whose *current* PR the event names: the newest PR a run of the card recorded
 *   (`sessions.pr_url`, matched by page or by API resource as every merge handler matches it). A PR
 *   a later run of the card replaced says nothing about the card when it closes or merges. A merge
 *   moves the card to `done` (`TaskService.settlePullRequest`, recorded by `mergeActor`) and releases
 *   its runs' workspaces (`releaseFinishedCard`), as a person's move into `done` does; an unmerged
 *   close blocks it `pr_closed`, naming the PR. Both are idempotent under the card's row lock, so a
 *   redelivery — or two at once — changes the card exactly once; a close blocks the card once per PR,
 *   so a person's unblock stands against every later report of the same close.
 * - **The card's PR is read from GitHub when the card is opened** (`refreshCardPullRequest`, run by
 *   `getTaskExit` — the card pane's checklist and `factory board show` — and before a move into
 *   `done`): a local box with no webhook has no other way to learn of the merge. A merge it finds is
 *   recorded on the PR's sessions (`SessionService.recordMerge`, the record `human_merge` reads) and,
 *   when the read settles, moves the card as the delivery would; a close blocks it. The read before a
 *   move only records, so the move that follows is the person's own. The read is `PullRequestStates`,
 *   which keeps each PR's answer for `STATE_TTL` so a pane open on a card does not ask GitHub on every
 *   poll — a move's read asks afresh, since the person may have merged a moment ago — and answers
 *   nothing, changing nothing, when GitHub cannot be read or does not answer within
 *   `STATE_READ_TIMEOUT` (a failure is kept for `FAILED_STATE_TTL` and warned once).
 *
 * `human_merge` itself is `./requirements`' check: a person's move into `done` needs the card's PR's
 * merge on record, so a move while the PR is open, or closed unmerged, is refused naming it.
 */
import {
  Cache,
  Context,
  DateTime,
  Duration,
  Effect,
  Exit,
  Layer,
  Redacted,
  Schema,
} from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { SqlClient } from "effect/sql/SqlClient";
import { SessionId } from "@repo/domain/Session";
import { isTerminalColumn } from "@repo/domain/Task";
import { CredentialProvider } from "./credentials";
import {
  githubPullRequestLifecycle,
  refuseGitHubDelivery,
  type PullRequestLifecycle,
} from "./LinearSync";
import { githubApiUrl, PrError } from "./pr";
import { pullRequestOf } from "./pullRequestUrl";
import { SessionService } from "./SessionService";
import { TaskService } from "./TaskService";
import { releaseFinishedCard } from "./WorkspaceRelease";

/** A PR as the card follows it: its number and its page. */
export type CardPullRequest = { readonly number: number; readonly url: string };

/** A PR's state as GitHub answers it now (C20). */
export type PullRequestState =
  | { readonly _tag: "open" }
  | { readonly _tag: "closed" }
  | {
      readonly _tag: "merged";
      readonly mergedAt: string;
      readonly commit?: string;
    };

/**
 * A PR's page as its owner, repository and number (`https://github.com/o/r/pull/7`, or the same path
 * on a GitHub Enterprise host) — or its API resource, which older sessions recorded — or `undefined`
 * for a URL that is neither (`./pullRequestUrl`).
 */
export const pullRequestOfPage = pullRequestOf;

/** How long one PR's answer stands before GitHub is asked again. */
export const STATE_TTL = Duration.seconds(30);

/**
 * How long a failure to read one PR stands (a box with no token, a link that is no PR, a forge that
 * errors), so an open pane does not ask — and warn — on every poll. A move's fresh read asks anyway.
 */
export const FAILED_STATE_TTL = Duration.minutes(2);

/**
 * How long one read of a PR's state may take: it sits on a person's move into `done` and on the card
 * pane's checklist, which answer on the recorded state rather than wait on a forge that hangs.
 */
export const STATE_READ_TIMEOUT = Duration.seconds(5);

/** GitHub's pull request, as far as its state goes. */
const GitHubPullRequestState = Schema.Struct({
  state: Schema.String,
  merged: Schema.optional(Schema.NullOr(Schema.Boolean)),
  merged_at: Schema.optional(Schema.NullOr(Schema.String)),
  merge_commit_sha: Schema.optional(Schema.NullOr(Schema.String)),
});

/**
 * Ask GitHub for one PR's state (`GET /repos/:owner/:repo/pulls/:number` on `GITHUB_API_URL`), with
 * the token the PR step opens it with. A PR whose page is not a GitHub pull request page, a token that
 * cannot be resolved, and an answer that does not read are each a `PrError` naming the PR.
 */
export const readPullRequestState = (
  url: string,
): Effect.Effect<
  PullRequestState,
  PrError,
  CredentialProvider | HttpClient.HttpClient
> => {
  const fail = (message: string) =>
    new PrError({ operation: "readPullRequestState", ref: url, message });
  return Effect.gen(function* () {
    const page = pullRequestOfPage(url);
    if (page === undefined)
      return yield* fail("the PR's link is not a GitHub pull request page");
    const provider = yield* CredentialProvider;
    const http = yield* HttpClient.HttpClient;
    const token = yield* provider
      .tokenFor(page.repo)
      .pipe(Effect.mapError((error) => fail(error.message)));
    const request = HttpClientRequest.get(
      `${githubApiUrl()}/repos/${page.repo}/pulls/${page.number}`,
      {
        headers: {
          authorization: `Bearer ${Redacted.value(token)}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
        },
      },
    );
    const pr = yield* http.execute(request).pipe(
      Effect.mapError(() => fail("GitHub could not be reached")),
      Effect.flatMap((response) =>
        response.status >= 200 && response.status < 300
          ? HttpClientResponse.schemaBodyJson(GitHubPullRequestState)(
              response,
            ).pipe(
              Effect.mapError(() =>
                fail("GitHub's answer for the PR could not be read"),
              ),
            )
          : Effect.fail(fail(`GitHub answered ${response.status}`)),
      ),
    );
    if (pr.merged === true || (pr.merged_at ?? "") !== "") {
      return {
        _tag: "merged",
        mergedAt: pr.merged_at ?? "",
        ...((pr.merge_commit_sha ?? "") === ""
          ? {}
          : { commit: pr.merge_commit_sha ?? "" }),
      } satisfies PullRequestState;
    }
    return pr.state === "closed"
      ? ({ _tag: "closed" } satisfies PullRequestState)
      : ({ _tag: "open" } satisfies PullRequestState);
  }).pipe(
    // The whole read is bounded, the token included: a GitHub App mints its installation token over
    // the network, and a forge that hangs there must not hold a move or the pane any longer.
    Effect.timeoutOrElse({
      duration: STATE_READ_TIMEOUT,
      orElse: () =>
        Effect.fail(
          fail(
            `GitHub did not answer within ${Duration.toSeconds(STATE_READ_TIMEOUT)}s`,
          ),
        ),
    }),
  );
};

/** The forge read the card follows its PR with when no webhook told it (module doc). */
export type PullRequestStatesShape = {
  /**
   * The PR's state, by its page, or `undefined` when GitHub could not be read (logged once per
   * failed lookup) or did not answer within `STATE_READ_TIMEOUT`. `fresh`
   * asks GitHub whatever answer is kept: a person's move into `done` right after a merge must not be
   * judged on the open PR a pane read a moment before.
   */
  readonly read: (
    url: string,
    options?: { readonly fresh?: boolean },
  ) => Effect.Effect<PullRequestState | undefined>;
};

export class PullRequestStates extends Context.Service<
  PullRequestStates,
  PullRequestStatesShape
>()("@repo/core/PullRequestStates") {}

/**
 * `PullRequestStates` over GitHub's REST API, one answer per PR per `STATE_TTL` (a failure, per
 * `FAILED_STATE_TTL`).
 */
export const PullRequestStatesLive = Layer.effect(
  PullRequestStates,
  Effect.gen(function* () {
    const context = yield* Effect.context<
      CredentialProvider | HttpClient.HttpClient
    >();
    // Warned once per failed lookup, not per read: a kept failure answers quietly until it lapses.
    const cache = yield* Cache.makeWith(
      (url: string) =>
        readPullRequestState(url).pipe(
          Effect.provideContext(context),
          Effect.tapError((error) =>
            Effect.logWarning(
              `pull request ${url}: its state could not be read: ${error.message}`,
            ),
          ),
        ),
      {
        capacity: 1024,
        timeToLive: (exit) =>
          Exit.isSuccess(exit) ? STATE_TTL : FAILED_STATE_TTL,
      },
    );
    return PullRequestStates.of({
      read: (url, options) =>
        (options?.fresh === true
          ? Effect.andThen(Cache.invalidate(cache, url), Cache.get(cache, url))
          : Cache.get(cache, url)
        ).pipe(Effect.orElseSucceed(() => undefined)),
    });
  }),
);

/** What one settle did across the cards it reached: how many it moved to done, and blocked. */
export type CardsSettled = { readonly done: number; readonly blocked: number };

const NOTHING: CardsSettled = { done: 0, blocked: 0 };

/**
 * The cards whose current PR is `url` (or its API resource): the newest PR a run of each recorded
 * (module doc), oldest card id first. A PR a later run of the card replaced names no card. Shared
 * with the review and check deliveries (C21, `./pullRequestFeedback`), which reach the same card.
 */
export const cardsOfPullRequest = (
  url: string,
  apiUrl: string | undefined,
): Effect.Effect<ReadonlyArray<string>, never, SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const other = apiUrl ?? url;
    const rows = yield* sql<{ readonly taskId: string }>`
      WITH latest AS (
        SELECT DISTINCT ON (tr.task_id) tr.task_id, s.pr_url
        FROM task_runs tr
        JOIN sessions s ON s.id = tr.session_id
        WHERE s.pr_url IS NOT NULL AND tr.task_id IN (
          SELECT tr2.task_id FROM task_runs tr2
          JOIN sessions s2 ON s2.id = tr2.session_id
          WHERE s2.pr_url = ${url} OR s2.pr_url = ${other}
        )
        ORDER BY tr.task_id, tr.started_at DESC, tr.id DESC
      )
      SELECT task_id FROM latest
      WHERE pr_url = ${url} OR pr_url = ${other}
      ORDER BY task_id
    `.pipe(
      Effect.catch((error) =>
        Effect.as(
          Effect.logWarning(
            `pull request ${url}: its cards could not be read: ${error.message}`,
          ),
          [],
        ),
      ),
    );
    return rows.map((row) => row.taskId);
  });

/**
 * Settle one card on its PR's outcome, logging rather than failing — the event already happened —
 * and releasing its runs' workspaces once a merge moved it. Answers whether the card changed.
 */
const settleCard = (
  taskId: string,
  outcome: "merged" | "closed",
  pr: CardPullRequest,
): Effect.Effect<boolean, never, TaskService | SessionService> =>
  Effect.gen(function* () {
    const tasks = yield* TaskService;
    const settled = yield* tasks
      .settlePullRequest({ taskId, outcome, pr })
      .pipe(
        Effect.catch((error) =>
          Effect.as(
            Effect.logWarning(
              `card ${taskId}: its PR ${pr.url} ${outcome === "merged" ? "merged" : "closed unmerged"}, but the card could not be settled: ${error.message}`,
            ),
            undefined,
          ),
        ),
      );
    if (settled === undefined || !settled.changed) return false;
    if (outcome === "merged") yield* releaseFinishedCard(settled.task);
    return true;
  });

/**
 * Settle the cards one `pull_request` event names (module doc): a merge moves each to `done`, an
 * unmerged close blocks each, and anything else changes nothing.
 */
export const settleCardsOfPullRequest = (
  event: PullRequestLifecycle,
): Effect.Effect<
  CardsSettled,
  never,
  TaskService | SessionService | SqlClient
> =>
  Effect.gen(function* () {
    if (event._tag === "other") return NOTHING;
    let changed = 0;
    for (const taskId of yield* cardsOfPullRequest(
      event.pr.url,
      event.apiUrl,
    )) {
      if (yield* settleCard(taskId, event._tag, event.pr)) changed += 1;
    }
    return event._tag === "merged"
      ? { done: changed, blocked: 0 }
      : { done: 0, blocked: changed };
  });

const JsonBody = Schema.fromJsonString(Schema.Unknown);

/**
 * The same, from one GitHub `pull_request` delivery as `POST /webhooks/github` receives it. The
 * signature is checked here, so nothing unsigned moves a card, and nothing else gates it: the card
 * follows its PR whatever the Linear mirror of the same delivery answered.
 */
export const settleCardsOfDelivery = (input: {
  readonly secret: string | undefined;
  readonly raw: string;
  readonly signature: string | undefined;
}): Effect.Effect<
  CardsSettled,
  never,
  TaskService | SessionService | SqlClient
> =>
  Effect.gen(function* () {
    if (refuseGitHubDelivery(input) !== undefined) return NOTHING;
    const payload = yield* Schema.decodeEffect(JsonBody)(input.raw).pipe(
      Effect.orElseSucceed(() => undefined),
    );
    const lifecycle = githubPullRequestLifecycle(payload);
    return lifecycle === undefined
      ? NOTHING
      : yield* settleCardsOfPullRequest(lifecycle);
  });

/** What one read of a card's PR found (C20): the PR, its state, and whether the card changed. */
export type CardPullRequestRefresh = {
  /** The card's current PR by its page; absent for a finished card, or one with no PR. */
  readonly pr?: string;
  /** Its state, from the recorded merge or GitHub's answer; absent when neither could say. */
  readonly state?: PullRequestState["_tag"];
  /** Whether the read moved the card to done or blocked it. */
  readonly changed: boolean;
};

/**
 * Read the card's current PR's state and follow it (module doc): a merge on record or reported by
 * GitHub is recorded on the PR's sessions and, with `settle`, moves the card to `done`; a close
 * reported by GitHub, with `settle`, blocks it. A finished card and a card with no PR read nothing.
 * `fresh` asks GitHub past any kept answer (`PullRequestStatesShape.read`). Never fails: what could
 * not be read is logged and changes nothing.
 */
export const refreshCardPullRequest = (
  taskId: string,
  options: { readonly settle: boolean; readonly fresh?: boolean },
): Effect.Effect<
  CardPullRequestRefresh,
  never,
  TaskService | SessionService | PullRequestStates | SqlClient
> =>
  Effect.gen(function* () {
    const tasks = yield* TaskService;
    const card = yield* tasks
      .get(taskId)
      .pipe(Effect.orElseSucceed(() => undefined));
    if (card === undefined || isTerminalColumn(card.column))
      return { changed: false };
    const sql = yield* SqlClient;
    const rows = yield* sql<{
      readonly id: string;
      readonly prUrl: string;
      readonly prMergedAt: Date | string | null;
    }>`
      SELECT s.id, s.pr_url, s.pr_merged_at
      FROM task_runs tr
      JOIN sessions s ON s.id = tr.session_id
      WHERE tr.task_id = ${taskId} AND s.pr_url IS NOT NULL
      ORDER BY tr.started_at DESC, tr.id DESC
    `.pipe(
      Effect.catch((error) =>
        Effect.as(
          Effect.logWarning(
            `card ${taskId}: its PR could not be read: ${error.message}`,
          ),
          [],
        ),
      ),
    );
    const url = rows[0]?.prUrl;
    if (url === undefined) return { changed: false };
    const page = pullRequestOfPage(url);
    const pr: CardPullRequest = { url, number: page?.number ?? 0 };
    const ofPr = rows.filter((row) => row.prUrl === url);
    const recorded = ofPr.some((row) => row.prMergedAt !== null);
    const state: PullRequestState | undefined = recorded
      ? { _tag: "merged", mergedAt: "" }
      : yield* (yield* PullRequestStates).read(url, {
          fresh: options.fresh === true,
        });
    if (state === undefined) return { pr: url, changed: false };
    if (state._tag === "open")
      return { pr: url, state: "open", changed: false };
    if (state._tag === "merged" && !recorded) {
      const sessions = yield* SessionService;
      // GitHub's `merged_at`, or now when it named none: `recordMerge` takes an instant.
      const mergedAt =
        state.mergedAt === ""
          ? DateTime.formatIso(yield* DateTime.now)
          : state.mergedAt;
      for (const row of ofPr) {
        if (!Schema.is(SessionId)(row.id)) continue;
        yield* sessions
          .recordMerge({
            sessionId: row.id,
            event: {
              _tag: "merged",
              url,
              number: pr.number,
              mergedAt,
              ...(state.commit === undefined ? {} : { commit: state.commit }),
            },
          })
          .pipe(
            Effect.catch((error) =>
              Effect.logWarning(
                `session ${row.id}: could not record the merge of ${url} GitHub reported: ${error.message}`,
              ),
            ),
          );
      }
    }
    const changed = options.settle
      ? yield* settleCard(taskId, state._tag, pr)
      : false;
    return { pr: url, state: state._tag, changed };
  });
