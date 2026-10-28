/**
 * The review trigger (LOB-36): a `pull_request` event on a PR the factory opened starts one reviewer
 * run on the PR's card, at the PR's head.
 *
 * **Which PRs.** Only a PR whose page a factory session recorded (`sessions.pr_url`, LOB-177) and whose
 * session is a run of a card: the reviewer is a run of that card's reviewer column (the column whose
 * role is in `REVIEW_ROLES`, `review` in the default pipeline), because that is where its role — a
 * read-only stage on the role's model — and its card come from (B6). Any other PR is answered
 * `skipped` with the reason, and starts nothing.
 *
 * **Which actions.** `opened`, `reopened` and `ready_for_review` review the PR as it is; `synchronize`
 * — a push to its branch — reviews the new head. A draft is skipped until it is ready. Every other
 * action (`closed`, `edited`, `labeled`, …) is not a review's business and is ignored here (the Linear
 * mirror reads `closed`).
 *
 * **One run per head.** The delivery id is the head itself — `review-<owner>-<repo>-<number>-<sha>`,
 * built from validated values like the docs trigger's — so a redelivery of the same event, and a
 * `reopened` on a head already reviewed, is a replay of the run that head already has, and a new
 * commit is a new run on a new branch (`factory/review-<number>-<sha12>`). That is the re-review: a
 * `synchronize` opens the next head's run, the previous run's verdict is about a head the PR is no
 * longer at, and if the earlier reviewer is still working its post finds the PR moved and posts
 * nothing (`githubReviewPoster`'s `stale`). The run is told the PR, the base and the head, and its
 * worktree is cut at the head, so `git diff <base>...HEAD` there is exactly the change under review.
 * Because a replay opens no run, the run rows cannot say which head the PR is at after a push back
 * to a head it had before; every delivery on a card's PR records its head in `review_heads` first
 * (`recordReviewHead`), and that is the head the board's `review_verdict` judges the review of.
 *
 * **The head has to be here.** The worktree is cut from the repo's registered checkout, and a head
 * nobody committed on this machine — a person's push to the PR branch, GitHub's "Update branch" merge
 * — is not in it. So before the run starts, the head (and the base commit the event names) are
 * looked up there, and what is missing is fetched (`ReviewFetch`: the PR's head branch and its base,
 * with the worker's read credential in a deployment, `gitReviewFetch`). A head that is still not
 * there is answered `skipped`, naming the commit and why, instead of a session that fails to cut its
 * worktree. The diff is taken against the base *commit* the event names when the checkout has it, so
 * a stale or absent local base branch does not change what is reviewed; the base branch's name is
 * the fallback.
 *
 * It goes through the same seam as every other trigger (`TriggerServiceLive`), so the dedupe, the
 * claim and its release, and the one-prompt-per-delivery rule are the seam's, not this file's.
 */
import { Effect, type FileSystem, Layer, Option, Schema } from "effect";
import type { ChildProcessSpawner } from "effect/process";
import { SqlClient } from "effect/sql/SqlClient";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- whether a commit is in the checkout is a question for the local git CLI, the one `workspace.ts` cuts the worktree with.
import { execFileSync } from "node:child_process";
import {
  BranchName,
  type RepoSlug,
  RepoSlug as RepoSlugSchema,
} from "@repo/domain/Session";
import { BoardColumn } from "@repo/domain/Task";
import {
  TriggerError,
  type TriggerDelivery,
  type TriggerRule,
} from "@repo/domain/Trigger";
import { REVIEW_ROLES } from "@repo/harness";
import type { CredentialProvider } from "./credentials";
import { fetchBranch } from "./git";
import { triggerErrorOfSession, triggerFailureAnswer } from "./admission";
import { type GitHubWebhookAnswer, refuseGitHubDelivery } from "./LinearSync";
import { SessionService } from "./SessionService";
import {
  NoCards,
  NoWriteBack,
  TriggerService,
  TriggerServiceLive,
  TriggerSessions,
  triggerActorOf,
} from "./TriggerService";

/** The label a review rule claims, and the only label a review delivery carries. */
export const REVIEW_TRIGGER_LABEL = "review";

/** The `pull_request` actions that start a review (module doc). */
export const REVIEW_ACTIONS: ReadonlyArray<string> = [
  "opened",
  "reopened",
  "ready_for_review",
  "synchronize",
];

/** Every reviewer branch starts here; the rest names the PR and the head under review. */
export const REVIEW_BRANCH_PREFIX = "factory/review-";

/** What the reviewer is told. The rubric is the `review` tool's description, not repeated here. */
export const REVIEW_PROMPT =
  "Review pull request {{key}}: {{title}}\n\n" +
  "{{body}}\n\n" +
  "Your worktree is checked out at the head. Read the whole change (`git diff` against the base, " +
  "and the files it touches), then call the review tool once with your verdict for each dimension. " +
  "You review; you do not change anything.";

/** A `pull_request` event, as far as the review reads it. */
export type PullRequestUpdate = {
  readonly action: string;
  readonly repo: RepoSlug;
  readonly number: number;
  /** The PR's page (`html_url`), which `sessions.pr_url` records. */
  readonly url: string;
  /** The PR's API resource (`url`), matched as well, as the Linear mirror does. */
  readonly apiUrl?: string;
  readonly title: string;
  /** The branch the PR merges into. */
  readonly base: string;
  /** The base branch's commit when the event was sent (`base.sha`), when the payload names one. */
  readonly baseSha?: string;
  readonly head: string;
  /** The PR's head branch (`head.ref`), fetched when the head commit is not in the checkout. */
  readonly headRef?: string;
  /** Whether the head branch is in the PR's own repository (not a fork), so it can be fetched there. */
  readonly headInRepo?: boolean;
  readonly draft: boolean;
  /**
   * When the PR last changed (`updated_at`), when the payload names a valid time: what orders two
   * deliveries' heads in `review_heads` (LOB-241), so a redelivered past event does not move it back.
   */
  readonly updatedAt?: string;
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const text = (
  record: Record<string, unknown> | undefined,
  name: string,
): string | undefined => {
  const value = record?.[name];
  return typeof value === "string" ? value : undefined;
};

const SHA = /^[0-9a-f]{40}$/;

/**
 * A `pull_request` payload, read — or `undefined` when it does not name a pull request with a
 * repository, a number, a base ref and a 40-hex head commit.
 */
export const pullRequestUpdate = (
  payload: unknown,
): PullRequestUpdate | undefined => {
  const body = asRecord(payload);
  const pr = asRecord(body?.["pull_request"]);
  const number = pr?.["number"];
  const url = text(pr, "html_url");
  const base = text(asRecord(pr?.["base"]), "ref");
  const head = text(asRecord(pr?.["head"]), "sha");
  const fullName = text(asRecord(body?.["repository"]), "full_name");
  if (
    typeof number !== "number" ||
    !Number.isInteger(number) ||
    number <= 0 ||
    url === undefined ||
    base === undefined ||
    base === "" ||
    head === undefined ||
    !SHA.test(head) ||
    fullName === undefined
  )
    return undefined;
  const repo = Schema.decodeOption(RepoSlugSchema)(fullName.toLowerCase());
  if (Option.isNone(repo)) return undefined;
  const apiUrl = text(pr, "url");
  const baseSha = text(asRecord(pr?.["base"]), "sha");
  const headRef = text(asRecord(pr?.["head"]), "ref");
  const updatedAt = text(pr, "updated_at");
  const headRepo = text(
    asRecord(asRecord(pr?.["head"])?.["repo"]),
    "full_name",
  );
  return {
    action: text(body, "action") ?? "",
    repo: repo.value,
    number,
    url,
    ...(apiUrl === undefined || apiUrl === url ? {} : { apiUrl }),
    title: text(pr, "title") ?? "",
    base,
    ...(baseSha !== undefined && SHA.test(baseSha) ? { baseSha } : {}),
    head,
    ...(headRef === undefined || headRef === "" ? {} : { headRef }),
    ...(headRepo === undefined
      ? {}
      : { headInRepo: headRepo.toLowerCase() === repo.value }),
    draft: pr?.["draft"] === true,
    ...(updatedAt === undefined || Number.isNaN(Date.parse(updatedAt))
      ? {}
      : { updatedAt }),
  };
};

/** The delivery id of one head of one PR: the run that reviews it, and its dedupe key. */
export const reviewToken = (update: PullRequestUpdate): string =>
  `review-${update.repo.replace("/", "-")}-${update.number}-${update.head}`;

/** The reviewer run's branch: the PR and the head, so two heads never share a worktree. */
export const reviewBranch = (update: PullRequestUpdate): string =>
  `${REVIEW_BRANCH_PREFIX}${update.number}-${update.head.slice(0, 12)}`;

/**
 * One head of one PR, as the seam takes it. `diffBase` is what the change is measured against: the
 * base commit when the checkout has it (`prepareReviewCheckout`), the base branch otherwise.
 */
export const reviewDelivery = (
  update: PullRequestUpdate,
  diffBase: string = update.base,
): TriggerDelivery => ({
  requestId: reviewToken(update),
  event: {
    source: "github",
    key: `${update.repo}#${update.number}`,
    action: update.action,
    title: update.title === "" ? `#${update.number}` : update.title,
    body:
      `${update.url}\n` +
      `It merges ${update.head} into ${update.base}${diffBase === update.base ? "" : ` (at ${diffBase})`}: the change under review is \`git diff ${diffBase}...HEAD\`.`,
    labels: [REVIEW_TRIGGER_LABEL],
    repo: update.repo,
  },
  // The id is the head, so GitHub has no fresh delivery of it to offer (as the docs push's).
  keyedByWork: true,
});

/** The review rule for one head: the PR's repo, cut at the head, told the review prompt. */
export const reviewTriggerRules = (
  update: PullRequestUpdate,
): ReadonlyArray<TriggerRule> => [
  {
    label: REVIEW_TRIGGER_LABEL,
    repo: update.repo,
    baseRef: update.head,
    prompt: REVIEW_PROMPT,
    startsWorkFor: [...REVIEW_ACTIONS],
  },
];

/** The card a reviewer run joins: the card, and the column whose role reviews. */
export type ReviewCard = {
  readonly taskId: string;
  readonly column: string;
};

/** Why a PR has no reviewer run to start, or the card it would join. */
export type ReviewCardLookup =
  | { readonly _tag: "card"; readonly card: ReviewCard }
  | { readonly _tag: "none"; readonly reason: string };

/**
 * The card of the run that opened this PR, and its reviewer column under the card's pinned
 * definition (module doc). The newest such run when several recorded the same PR.
 */
export const reviewCardOf = (
  update: PullRequestUpdate,
): Effect.Effect<ReviewCardLookup, TriggerError, SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const rows = yield* sql<{
      readonly id: string;
      readonly taskId: string | null;
      readonly columns: string | null;
    }>`
      SELECT s.id, tr.task_id, bd.columns::text AS columns
      FROM sessions s
      LEFT JOIN task_runs tr ON tr.session_id = s.id
      LEFT JOIN tasks t ON t.id = tr.task_id
      LEFT JOIN board_instances bi ON bi.id = t.board_id
      LEFT JOIN board_definitions bd
        ON bd.id = bi.definition_id AND bd.version = t.definition_version
      WHERE s.pr_url = ${update.url} OR s.pr_url = ${update.apiUrl ?? update.url}
      ORDER BY s.created_at DESC, s.id DESC
    `.pipe(
      Effect.mapError(
        (cause) =>
          new TriggerError({
            code: "storage",
            message: `read the sessions of ${update.url}: ${cause.message}`,
          }),
      ),
    );
    const where = `${update.repo}#${update.number}`;
    if (rows.length === 0)
      return {
        _tag: "none",
        reason: `${where} is not a pull request the factory opened, so it has no card to review on`,
      };
    const run = rows.find((row) => row.taskId !== null && row.columns !== null);
    if (run === undefined || run.taskId === null || run.columns === null)
      return {
        _tag: "none",
        reason: `${where} was opened by session ${rows[0]?.id ?? ""}, which is a run of no card: a review is a run of the card's reviewer column`,
      };
    const columns = yield* Schema.decodeEffect(
      Schema.fromJsonString(Schema.Array(BoardColumn)),
    )(run.columns).pipe(
      Effect.mapError(
        (cause) =>
          new TriggerError({
            code: "storage",
            message: `task ${run.taskId}'s board definition holds an invalid column set: ${String(cause)}`,
          }),
      ),
    );
    const column = columns.find(
      (candidate) =>
        candidate.role !== undefined && REVIEW_ROLES.has(candidate.role),
    );
    if (column === undefined)
      return {
        _tag: "none",
        reason: `task ${run.taskId}'s board declares no column whose role reviews (${[...REVIEW_ROLES].join(", ")})`,
      };
    return { _tag: "card", card: { taskId: run.taskId, column: column.name } };
  });

/**
 * Record `update.head` as the head the card's PR was last reported at (`review_heads`, LOB-241): the
 * head `review_verdict` judges the review of. Written for every review delivery on a card's PR —
 * before its run is opened, and for a replay or a skip too — because a replay opens no run, so the
 * run rows alone cannot say that a push took the PR back to a head it had before. A delivery older
 * than the row (by `pull_request.updated_at`) leaves it.
 */
export const recordReviewHead = (
  update: PullRequestUpdate,
  card: ReviewCard,
): Effect.Effect<void, TriggerError, SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql`
      INSERT INTO review_heads (pr_url, api_url, task_id, head, reported_at)
      VALUES (
        ${update.url}, ${update.apiUrl ?? null}, ${card.taskId}, ${update.head},
        COALESCE(${update.updatedAt ?? null}::timestamptz, now())
      )
      ON CONFLICT (pr_url) DO UPDATE
        SET api_url = EXCLUDED.api_url, task_id = EXCLUDED.task_id,
            head = EXCLUDED.head, reported_at = EXCLUDED.reported_at
        WHERE EXCLUDED.reported_at >= review_heads.reported_at
    `.pipe(
      Effect.asVoid,
      Effect.mapError(
        (cause) =>
          new TriggerError({
            code: "storage",
            message: `record ${update.repo}#${update.number}'s head ${update.head.slice(0, 12)}: ${cause.message}`,
          }),
      ),
    );
  });

/**
 * The seam's session port for one review: `SessionService.create` on the card's reviewer column, on
 * the review branch, at the head, with the PR as the session's review target.
 */
export const ReviewSessionsFromSessionService = (
  update: PullRequestUpdate,
  card: ReviewCard,
  diffBase: string = update.base,
) =>
  Layer.effect(
    TriggerSessions,
    Effect.gen(function* () {
      const sessions = yield* SessionService;
      const failed = (cause: { readonly message: string }) =>
        new TriggerError({ code: "session-create", message: cause.message });
      return TriggerSessions.of({
        create: (input) => {
          const branch = Schema.decodeOption(BranchName)(reviewBranch(update));
          if (Option.isNone(branch))
            return Effect.fail(
              failed({
                message: `${reviewBranch(update)} cannot name a review branch`,
              }),
            );
          return sessions
            .create({
              // The run names the PR and the head it reviews, so a list of runs tells two heads apart.
              title: `review ${update.repo}#${update.number} at ${update.head.slice(0, 12)}`,
              requestId: input.requestId,
              repo: input.repo,
              baseRef: update.head,
              branch: branch.value,
              taskId: card.taskId,
              taskColumn: card.column,
              review: {
                number: update.number,
                url: update.url,
                base: diffBase,
                head: update.head,
              },
              actor: triggerActorOf(input.source),
            })
            .pipe(
              Effect.map((summary) => ({ id: summary.id })),
              // `at_capacity` stays `at-capacity` (LOB-70), which the route answers `503`.
              Effect.mapError(triggerErrorOfSession),
            );
        },
        // A trigger never waits for a worktree's setup (S-env-setup): its sender would give
        // up first, taking the prompt with it. The message is sent once the setup succeeds.
        send: (input) =>
          sessions
            .sendDeferringSetup({
              sessionId: input.sessionId,
              content: input.content,
              requestId: input.requestId,
            })
            .pipe(Effect.asVoid, Effect.mapError(triggerErrorOfSession)),
      });
    }),
  );

/** The seam one review goes through: the review rule, on the review port, with no write-back. */
export const ReviewTriggerLive = (
  update: PullRequestUpdate,
  card: ReviewCard,
  diffBase: string = update.base,
) =>
  TriggerServiceLive({ rules: reviewTriggerRules(update) }).pipe(
    Layer.provide(ReviewSessionsFromSessionService(update, card, diffBase)),
    Layer.provide(Layer.mergeAll(NoWriteBack, NoCards)),
  );

/**
 * How the review brings one branch of the PR's repository into its registered checkout, when a commit
 * the event names is not there (module doc). A failure is a reason, not an error: the review is then
 * skipped, naming it.
 */
export type ReviewFetch = (input: {
  readonly repo: RepoSlug;
  readonly localPath: string;
  readonly branch: string;
}) => Effect.Effect<void, { readonly message: string }>;

/**
 * The deployment's `ReviewFetch`: `fetchBranch` from the repo's forge into
 * `refs/remotes/origin/<branch>` of the checkout, with the worker's credential — a read of the
 * worker's own repository, never a post, so it is not the reviewer's identity that is needed.
 */
export const gitReviewFetch: Effect.Effect<
  ReviewFetch,
  never,
  | CredentialProvider
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
> = Effect.gen(function* () {
  const context = yield* Effect.context<
    | CredentialProvider
    | ChildProcessSpawner.ChildProcessSpawner
    | FileSystem.FileSystem
  >();
  return (input) =>
    fetchBranch({
      worktree: input.localPath,
      repo: input.repo,
      branch: input.branch,
    }).pipe(
      Effect.asVoid,
      Effect.mapError((error) => ({ message: error.message })),
      Effect.provideContext(context),
    );
});

/** Whether `sha` names a commit the checkout at `localPath` has. */
const hasCommit = (localPath: string, sha: string): Effect.Effect<boolean> =>
  Effect.sync(() => {
    try {
      execFileSync("git", ["cat-file", "-e", `${sha}^{commit}`], {
        cwd: localPath,
        stdio: "ignore",
      });
      return true;
    } catch {
      return false;
    }
  });

/** The checkout is ready at the head, and the change is measured against `diffBase`; or why not. */
export type ReviewCheckout =
  | { readonly _tag: "ready"; readonly diffBase: string }
  | { readonly _tag: "missing"; readonly reason: string };

/**
 * Make sure the registered checkout has the head (and the base commit) the event names, fetching
 * what it lacks (module doc). A repo nobody registered is left to the seam, which skips it naming the
 * repo.
 */
export const prepareReviewCheckout = (
  update: PullRequestUpdate,
  fetch: ReviewFetch | undefined,
): Effect.Effect<ReviewCheckout, TriggerError, SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const rows = yield* sql<{ readonly localPath: string | null }>`
      SELECT local_path FROM repos WHERE slug = ${update.repo}
    `.pipe(
      Effect.mapError(
        (cause) =>
          new TriggerError({
            code: "storage",
            message: `read the registration of ${update.repo}: ${cause.message}`,
          }),
      ),
    );
    const localPath = rows[0]?.localPath ?? undefined;
    if (localPath === undefined)
      return { _tag: "ready", diffBase: update.base };
    const baseSha = update.baseSha;
    const wanted = [
      ...((yield* hasCommit(localPath, update.head))
        ? []
        : [
            update.headRef !== undefined && update.headInRepo !== false
              ? { branch: update.headRef }
              : {
                  unfetchable:
                    update.headRef === undefined
                      ? "the event names no head branch to fetch it from"
                      : `its branch ${update.headRef} is in a fork, which the factory does not fetch`,
                },
          ]),
      ...(baseSha === undefined || (yield* hasCommit(localPath, baseSha))
        ? []
        : [{ branch: update.base }]),
    ];
    const why: string[] = [];
    for (const want of wanted) {
      if ("unfetchable" in want) {
        why.push(want.unfetchable);
        continue;
      }
      if (fetch === undefined) {
        why.push(`no fetch is configured to bring ${want.branch} here`);
        continue;
      }
      const fetched = yield* fetch({
        repo: update.repo,
        localPath,
        branch: want.branch,
      }).pipe(Effect.result);
      if (fetched._tag === "Failure")
        why.push(`fetching ${want.branch} failed: ${fetched.failure.message}`);
    }
    if (!(yield* hasCommit(localPath, update.head)))
      return {
        _tag: "missing",
        reason: `${update.repo}#${update.number}'s head ${update.head.slice(0, 12)} is not in the registered checkout ${localPath}${why.length === 0 ? "" : ` (${why.join("; ")})`}, so it cannot be reviewed there`,
      };
    return {
      _tag: "ready",
      diffBase:
        baseSha !== undefined && (yield* hasCommit(localPath, baseSha))
          ? baseSha
          : update.base,
    };
  });

/** What one `pull_request` event did for review: started (or replayed) a run, or why it did not. */
export type ReviewTriggerOutcome =
  | { readonly status: "ignored"; readonly reason: string }
  | { readonly status: "skipped"; readonly reason: string }
  | {
      readonly status: "processed" | "received";
      readonly replayed: boolean;
      readonly sessionId?: string;
      readonly head: string;
    };

/** Start the reviewer run one PR event asks for, or say why it asks for none (module doc). */
export const reviewPullRequest = (
  update: PullRequestUpdate,
  fetch?: ReviewFetch,
): Effect.Effect<
  ReviewTriggerOutcome,
  TriggerError,
  SessionService | SqlClient
> =>
  Effect.gen(function* () {
    if (!REVIEW_ACTIONS.includes(update.action))
      return {
        status: "ignored",
        reason: `action "${update.action}" starts no review`,
      };
    const lookup = yield* reviewCardOf(update);
    // The head is the PR's now, whatever this delivery goes on to do: a draft's push, a head that
    // cannot be fetched and a replay all leave the gate judging this head (`recordReviewHead`).
    if (lookup._tag === "card") yield* recordReviewHead(update, lookup.card);
    if (update.draft)
      return {
        status: "skipped",
        reason: `${update.repo}#${update.number} is a draft; it is reviewed when it is ready`,
      };
    if (lookup._tag === "none")
      return { status: "skipped", reason: lookup.reason };
    const checkout = yield* prepareReviewCheckout(update, fetch);
    if (checkout._tag === "missing")
      return { status: "skipped", reason: checkout.reason };
    const delivered = yield* Effect.gen(function* () {
      const trigger = yield* TriggerService;
      return yield* trigger.deliver(reviewDelivery(update, checkout.diffBase));
    }).pipe(
      Effect.provide(ReviewTriggerLive(update, lookup.card, checkout.diffBase)),
    );
    if (delivered.status === "skipped")
      return { status: "skipped", reason: delivered.reason ?? "skipped" };
    return {
      status: delivered.status,
      replayed: delivered.replayed,
      ...(delivered.sessionId === undefined
        ? {}
        : { sessionId: delivered.sessionId }),
      head: update.head,
    };
  });

const PullJson = Schema.fromJsonString(Schema.Unknown);

/**
 * One `pull_request` delivery, as `POST /webhooks/github` hands it to the review (beside the Linear
 * mirror): authenticated with the same refusals (`503` unconfigured, `401` unsigned), `400` for a
 * payload that names no reviewable PR, `200` with the outcome otherwise, and `500` for a real failure
 * so GitHub's delivery log shows it.
 */
export const handlePullRequestReviewWebhook = (input: {
  readonly secret: string | undefined;
  readonly raw: string;
  readonly signature: string | undefined;
  /** How a head the checkout lacks is fetched (`gitReviewFetch`); absent, it is skipped. */
  readonly fetch?: ReviewFetch;
}): Effect.Effect<GitHubWebhookAnswer, never, SessionService | SqlClient> =>
  Effect.gen(function* () {
    const refused = refuseGitHubDelivery(input);
    if (refused !== undefined) return refused;
    const payload = yield* Schema.decodeEffect(PullJson)(input.raw).pipe(
      Effect.orElseSucceed(() => undefined),
    );
    const update = pullRequestUpdate(payload);
    if (update === undefined)
      return {
        status: 400,
        body: {
          ok: false,
          error:
            "the payload names no pull request with a repository, a base ref and a head commit",
          code: "bad-payload",
        },
      };
    return yield* reviewPullRequest(update, input.fetch).pipe(
      Effect.map((outcome): GitHubWebhookAnswer => ({
        status: 200,
        body: { ok: true, ...outcome },
      })),
      // `500` for a failure, or `503` with `Retry-After` at capacity (LOB-70).
      Effect.catchTag("TriggerError", (cause) =>
        Effect.logError(
          `review: ${update.repo}#${update.number} at ${update.head} failed: ${cause.message}`,
        ).pipe(Effect.as(triggerFailureAnswer(cause))),
      ),
    );
  });
