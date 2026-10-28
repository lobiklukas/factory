/**
 * What a review or a check says about the card's PR reaches the card (C21): the "review the PR" step
 * of the journey closes its loop, and a reviewer's requested changes — or a red CI run — are what the
 * next run on the card is told.
 *
 * Before this, `POST /webhooks/github` read `pull_request` and `push` alone and answered every other
 * event `202`: a person who requested changes in GitHub, or a check that failed on the PR, left the
 * card exactly as it was, and the next run on it knew nothing of either. Now five more events are
 * read (`githubPullRequestFeedback`), each as one `commented` note on the thread of the card whose
 * *current* PR it names (`cardsOfPullRequest`, C20's lookup):
 *
 * - **`pull_request_review` `submitted`.** A review that requests changes is a note naming the
 *   reviewer, the PR and the commit, with the review's body verbatim — and blocks the card
 *   `changes_requested`, its note naming the same, so the card shows in the attention view (the
 *   `review` row) and on its own face. A review that approves or comments is a note when it says
 *   something, and nothing when it does not (a bare approval, or the summary-less review GitHub
 *   wraps line comments in, which arrive as their own events). The factory's own reviewer (LOB-36)
 *   posts a `COMMENT` review with a hidden marker (`reviewMarker`); that review is the card's
 *   already — its verdict is in the reviewer run's log, which `review_verdict` reads — so it is not
 *   echoed back. Only a `COMMENT` review is skipped on the marker: the marker is predictable, and
 *   the factory reviewer never requests changes or approves (`./GitHubReview`), so a copy pasted
 *   into a review that does cannot keep it off the card.
 * - **`pull_request_review_comment` `created`.** A comment on a line of the change is a note naming
 *   the file and line, its body verbatim.
 * - **`check_run`, `check_suite` and `workflow_run` `completed` with a failing conclusion**
 *   (`failure`, `timed_out`, `action_required`, `startup_failure`; a `cancelled` run is most often
 *   one a newer push superseded) are a note naming the check, the commit and its page, with the
 *   check's own title and the start of its summary (`CHECK_SUMMARY_CHARS`; the rest is on the
 *   check's page — every later run is told the thread, so a suite of failing jobs must not fill it
 *   with CI output). A check of a commit the PR is no longer at says nothing about the PR and is
 *   skipped. One failure is one note across the three events, in whichever order GitHub delivers
 *   them (it promises none): a failing check run is keyed by its suite and its id, and the suite —
 *   or the workflow run, which names its suite — is keyed by the suite; the suite is recorded only
 *   when none of its check runs was, and a check run only when its suite was not. A check that
 *   later passes does not take its failure's note back (a follow-up: a "now passes" note per check
 *   name); the next run is told the failure with the commit it was on, and the PR's head says
 *   whether it is still red. A failing check does not
 *   block the card: CI is red on every intermediate push of a run still working, and a card blocked
 *   by each would page a person for what the run is about to fix. It is on the card's thread, which
 *   the pane and `factory board show` print, and which the next run is told.
 *
 * **Whose words reach a run.** A review's or a line comment's text becomes every later run's prompt,
 * and on a public repository anyone may review. So, as for an issue comment that asks for work
 * (`./GitHub`'s `githubIssueIntake`), only a reviewer with a standing on the repository — an owner,
 * member or collaborator (`author_association`, `GITHUB_TRUSTED_ASSOCIATIONS`) — reaches the card,
 * and only they can block it; anyone else's review or comment is `202` with the reason. And every
 * word that does reach it — a review, a comment, a check's name, title and summary — passes the
 * trigger seam's injection hygiene first (`sanitizeTriggerText`, S-trigger-trust-gating): what no
 * person reading the PR can see (an HTML comment, a zero-width or bidi run) is removed, and the note
 * says how much was. Every visible character stays as written.
 *
 * Every note is keyed by the item it carries (`commented.sourceId`), so a redelivery — GitHub's
 * retry, or a person's "Redeliver" — lands nothing twice (`TaskService.recordPullRequestFeedback`,
 * under the card's row lock). A finished card is not written to. A card that could not be written to
 * makes the delivery `500`, so GitHub shows it failed and a person can redeliver it.
 *
 * **The next run reads it.** Every run opened on a card is told the card's thread, verbatim, as its
 * `task_thread` prompt section (B7, `@repo/harness`'s `threadExtension`), so the review is in the
 * next run's prompt without anything pasted into it. Once that run's owner has opened, its start
 * lifts the `changes_requested` block (`TaskService.resumeAfterReview`, from `SessionService.create`)
 * — when its column writes code: a read-only column's run, or a review column's (one that requires
 * a review verdict), reviews rather than addresses the review, so the block stays and the person
 * starts the building run (`factory board start --column building`). The block is a prompt for a
 * person, not a gate on pushing: a run that settles while the card is blocked `changes_requested` —
 * one already in flight when the review came, or one a person steered — still pushes its PR (C18's
 * hold ignores the reason), since that push is what answers the review.
 */
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { cardsOfPullRequest } from "./cardPullRequest";
import { GITHUB_TRUSTED_ASSOCIATIONS } from "./GitHub";
import { type GitHubWebhookAnswer, refuseGitHubDelivery } from "./LinearSync";
import {
  type RecordPullRequestFeedbackInput,
  TaskService,
} from "./TaskService";
import { sanitizedNote, sanitizeTriggerText } from "./triggerText";

/** The events this module reads (module doc), as `X-GitHub-Event` names them. */
export const PULL_REQUEST_FEEDBACK_EVENTS: ReadonlyArray<string> = [
  "pull_request_review",
  "pull_request_review_comment",
  "check_run",
  "check_suite",
  "workflow_run",
];

/** The check conclusions that are a failure the card is told of (module doc). */
export const FAILING_CONCLUSIONS: ReadonlyArray<string> = [
  "failure",
  "timed_out",
  "action_required",
  "startup_failure",
];

/** The hidden marker the factory's own reviewer posts its comment with (`@repo/harness`'s `reviewMarker`). */
const FACTORY_REVIEW_MARKER = "<!-- factory-review ";

/** How much of a review the block's note — and so the attention row — quotes. */
const NOTE_QUOTE_CHARS = 280;

/** How much of a check's output summary a note quotes; the rest is on the check's page. */
export const CHECK_SUMMARY_CHARS = 1000;

/** One PR a delivery names: its page, its API resource when the payload carries it, its number. */
export type FeedbackPullRequest = {
  readonly url: string;
  readonly apiUrl?: string;
  readonly number: number;
};

/** What one delivery says, as the card is told it. */
export type PullRequestFeedback =
  | {
      readonly _tag: "feedback";
      /** What the answer calls the delivery: `changes_requested`, `review_comment`, `check_failed`, … */
      readonly event: string;
      readonly prs: ReadonlyArray<FeedbackPullRequest>;
      /** The note, without the card: `RecordPullRequestFeedbackInput` less its `taskId`. */
      readonly note: Omit<RecordPullRequestFeedbackInput, "taskId">;
    }
  | { readonly _tag: "ignored"; readonly reason: string };

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const text = (value: unknown): string =>
  typeof value === "string" ? value : "";

const idOf = (value: unknown): string | undefined =>
  typeof value === "number" && Number.isSafeInteger(value)
    ? String(value)
    : typeof value === "string" && /^\d+$/.test(value)
      ? value
      : undefined;

const short = (sha: string): string => sha.slice(0, 12);

/** Removed-so-far counts across one note's pieces of outside text (`clean`). */
type Removed = { hidden: number; comments: number; markup: number };

/**
 * One piece of a delivery's text, as a run may be told it: the trigger seam's injection hygiene
 * (`sanitizeTriggerText`), what it removed added to `removed` so the note can say so.
 */
const clean = (value: unknown, removed: Removed): string => {
  const cleaned = sanitizeTriggerText(text(value));
  removed.hidden += cleaned.hidden;
  removed.comments += cleaned.comments;
  removed.markup += cleaned.markup;
  return cleaned.text;
};

const freshRemoved = (): Removed => ({ hidden: 0, comments: 0, markup: 0 });

/** The note's last line when `clean` removed anything, so a person reading the card knows. */
const removedLines = (removed: Removed): Array<string> => {
  const said = sanitizedNote(removed);
  return said === undefined ? [] : ["", `[the factory ${said}]`];
};

/**
 * Why a reviewer's words do not reach the card (module doc), or `undefined` for a reviewer with a
 * standing on the repository.
 */
const untrusted = (item: Record<string, unknown>): string | undefined => {
  const association = text(item["author_association"]).toUpperCase();
  return GITHUB_TRUSTED_ASSOCIATIONS.includes(association)
    ? undefined
    : `${loginOf(item["user"])} has no standing on the repository (author_association "${association === "" ? "none" : association}"), so their words do not reach the card`;
};

const actorOf = (user: unknown): string => {
  const login = text(asRecord(user)?.["login"]).trim();
  return login === "" ? "github" : `github:${login}`;
};

const loginOf = (user: unknown): string => {
  const login = text(asRecord(user)?.["login"]).trim();
  return login === "" ? "a reviewer" : `@${login}`;
};

/** The PR of a `pull_request_review*` payload, by its page and its API resource. */
const reviewedPullRequest = (
  body: Record<string, unknown>,
): FeedbackPullRequest | undefined => {
  const pr = asRecord(body["pull_request"]);
  const url = pr?.["html_url"];
  const number = pr?.["number"];
  if (typeof url !== "string" || typeof number !== "number") return undefined;
  const apiUrl = pr?.["url"];
  return {
    url,
    number,
    ...(typeof apiUrl === "string" && apiUrl !== url ? { apiUrl } : {}),
  };
};

/**
 * The PRs a check names (`pull_requests[]`), by the page the repository's own page makes for each and
 * the API resource GitHub gives — only those whose head is the checked commit: a check of a commit
 * the PR has moved past says nothing about the PR as it is.
 */
const checkedPullRequests = (
  body: Record<string, unknown>,
  check: Record<string, unknown>,
  headSha: string,
): ReadonlyArray<FeedbackPullRequest> => {
  const repoPage = text(asRecord(body["repository"])?.["html_url"]).replace(
    /\/+$/,
    "",
  );
  const listed = check["pull_requests"];
  if (!Array.isArray(listed)) return [];
  return listed.flatMap((item: unknown): Array<FeedbackPullRequest> => {
    const pr = asRecord(item);
    const number = pr?.["number"];
    if (typeof number !== "number" || !Number.isSafeInteger(number)) return [];
    const head = text(asRecord(pr?.["head"])?.["sha"]);
    if (head !== "" && headSha !== "" && head !== headSha) return [];
    const apiUrl = text(pr?.["url"]);
    const url = repoPage === "" ? apiUrl : `${repoPage}/pull/${number}`;
    if (url === "") return [];
    return [
      {
        url,
        number,
        ...(apiUrl !== "" && apiUrl !== url ? { apiUrl } : {}),
      },
    ];
  });
};

const prList = (prs: ReadonlyArray<FeedbackPullRequest>): string =>
  prs.map((pr) => `#${pr.number}`).join(", ");

const reviewFeedback = (
  body: Record<string, unknown>,
): PullRequestFeedback | undefined => {
  const pr = reviewedPullRequest(body);
  const review = asRecord(body["review"]);
  const id = idOf(review?.["id"]);
  if (pr === undefined || review === undefined || id === undefined)
    return undefined;
  const action = text(body["action"]);
  if (action !== "submitted")
    return {
      _tag: "ignored",
      reason: `a review ${action === "" ? "event" : `"${action}"`} is not a submitted review`,
    };
  const state = text(review["state"]).toLowerCase();
  // Only a `COMMENT` review is the factory reviewer's (module doc): a predictable marker must not
  // keep a review that requests changes off the card.
  if (
    state === "commented" &&
    text(review["body"]).includes(FACTORY_REVIEW_MARKER)
  )
    return {
      _tag: "ignored",
      reason:
        "the review is the factory reviewer's own, which the card already holds",
    };
  const refused = untrusted(review);
  if (refused !== undefined) return { _tag: "ignored", reason: refused };
  const removed = freshRemoved();
  const said = clean(review["body"], removed);
  const who = loginOf(review["user"]);
  const page = text(review["html_url"]) || pr.url;
  const commit = text(review["commit_id"]);
  const at = commit === "" ? "" : ` at ${short(commit)}`;
  if (state === "changes_requested") {
    const quoted = said.trim();
    return {
      _tag: "feedback",
      event: "changes_requested",
      prs: [pr],
      note: {
        sourceId: `github:review:${id}`,
        actor: actorOf(review["user"]),
        body: [
          `Changes requested on pull request #${pr.number} by ${who}${at} (${page}):`,
          "",
          quoted === ""
            ? "(the review has no summary; its comments on the code are their own entries in this thread)"
            : said,
          ...removedLines(removed),
        ].join("\n"),
        block: {
          reason: "changes_requested",
          note:
            `${who} requested changes on pull request #${pr.number} (${page})` +
            (quoted === ""
              ? ""
              : `: ${quoted.length > NOTE_QUOTE_CHARS ? `${quoted.slice(0, NOTE_QUOTE_CHARS)}…` : quoted}`),
        },
      },
    };
  }
  if (state !== "approved" && state !== "commented")
    return {
      _tag: "ignored",
      reason: `a review in state "${state}" says nothing the card acts on`,
    };
  if (said.trim() === "")
    return {
      _tag: "ignored",
      reason: `a ${state === "approved" ? "bare approval" : "review with no summary"} says nothing the next run can use`,
    };
  return {
    _tag: "feedback",
    event: state === "approved" ? "approved" : "review_commented",
    prs: [pr],
    note: {
      sourceId: `github:review:${id}`,
      actor: actorOf(review["user"]),
      body: [
        `${state === "approved" ? "Approved" : "Reviewed"}: pull request #${pr.number} by ${who}${at} (${page}):`,
        "",
        said,
        ...removedLines(removed),
      ].join("\n"),
    },
  };
};

const reviewCommentFeedback = (
  body: Record<string, unknown>,
): PullRequestFeedback | undefined => {
  const pr = reviewedPullRequest(body);
  const comment = asRecord(body["comment"]);
  const id = idOf(comment?.["id"]);
  if (pr === undefined || comment === undefined || id === undefined)
    return undefined;
  const action = text(body["action"]);
  if (action !== "created")
    return {
      _tag: "ignored",
      reason: `a review comment "${action}" is not a new comment`,
    };
  if (text(comment["body"]).includes(FACTORY_REVIEW_MARKER))
    return {
      _tag: "ignored",
      reason: "the review comment is the factory reviewer's own",
    };
  const refused = untrusted(comment);
  if (refused !== undefined) return { _tag: "ignored", reason: refused };
  const removed = freshRemoved();
  const said = clean(comment["body"], removed);
  if (said.trim() === "")
    return {
      _tag: "ignored",
      reason: "the review comment says nothing the next run can use",
    };
  const path = clean(comment["path"], removed);
  const line = comment["line"] ?? comment["original_line"];
  const where =
    path === ""
      ? ""
      : ` on ${path}${typeof line === "number" ? `:${line}` : ""}`;
  const page = text(comment["html_url"]) || pr.url;
  return {
    _tag: "feedback",
    event: "review_comment",
    prs: [pr],
    note: {
      sourceId: `github:review_comment:${id}`,
      actor: actorOf(comment["user"]),
      body: [
        `Review comment on pull request #${pr.number} by ${loginOf(comment["user"])}${where} (${page}):`,
        "",
        said,
        ...removedLines(removed),
      ].join("\n"),
    },
  };
};

/** A completed check's conclusion, or the reason the delivery is not a failure the card is told of. */
const failingConclusion = (
  body: Record<string, unknown>,
  check: Record<string, unknown>,
  what: string,
): { readonly conclusion: string } | { readonly ignored: string } => {
  const action = text(body["action"]);
  if (action !== "completed")
    return { ignored: `a ${what} "${action}" has not completed` };
  const conclusion = text(check["conclusion"]);
  return FAILING_CONCLUSIONS.includes(conclusion)
    ? { conclusion }
    : { ignored: `a ${what} that concluded "${conclusion}" is no failure` };
};

const noPullRequest = (what: string): PullRequestFeedback => ({
  _tag: "ignored",
  reason: `the ${what} names no pull request at its head commit`,
});

/**
 * The check's own words, under the note's first line: its output's title and the start of its
 * summary (`CHECK_SUMMARY_CHARS`), cleaned (`clean`).
 */
const outputLines = (
  check: Record<string, unknown>,
  removed: Removed,
): Array<string> => {
  const output = asRecord(check["output"]);
  const summary = clean(output?.["summary"], removed);
  const lines = [
    clean(output?.["title"], removed),
    summary.length > CHECK_SUMMARY_CHARS
      ? `${summary.slice(0, CHECK_SUMMARY_CHARS)}… (the rest is on the check's page)`
      : summary,
  ].filter((line) => line.trim() !== "");
  return lines.length === 0 ? [] : ["", ...lines];
};

const checkRunFeedback = (
  body: Record<string, unknown>,
): PullRequestFeedback | undefined => {
  const check = asRecord(body["check_run"]);
  const id = idOf(check?.["id"]);
  if (check === undefined || id === undefined) return undefined;
  const failing = failingConclusion(body, check, "check run");
  if ("ignored" in failing) return { _tag: "ignored", reason: failing.ignored };
  const head = text(check["head_sha"]);
  const prs = checkedPullRequests(body, check, head);
  if (prs.length === 0) return noPullRequest("check run");
  const suite = idOf(asRecord(check["check_suite"])?.["id"]);
  const page = text(check["html_url"]) || text(check["details_url"]);
  const removed = freshRemoved();
  const name = clean(check["name"], removed) || id;
  const output = outputLines(check, removed);
  return {
    _tag: "feedback",
    event: "check_failed",
    prs,
    note: {
      sourceId: `github:check_run:${suite ?? "none"}:${id}`,
      // Its suite's (or workflow run's) note, delivered first, already says this failure.
      ...(suite === undefined
        ? {}
        : { coveredBySourceId: `github:check_suite:${suite}` }),
      actor: "github:checks",
      body: [
        `Check "${name}" failed (${failing.conclusion}) on ${short(head)} of pull request ${prList(prs)}${page === "" ? "" : `: ${page}`}`,
        ...output,
        ...removedLines(removed),
      ].join("\n"),
    },
  };
};

const checkSuiteFeedback = (
  body: Record<string, unknown>,
): PullRequestFeedback | undefined => {
  const suite = asRecord(body["check_suite"]);
  const id = idOf(suite?.["id"]);
  if (suite === undefined || id === undefined) return undefined;
  const failing = failingConclusion(body, suite, "check suite");
  if ("ignored" in failing) return { _tag: "ignored", reason: failing.ignored };
  const head = text(suite["head_sha"]);
  const prs = checkedPullRequests(body, suite, head);
  if (prs.length === 0) return noPullRequest("check suite");
  const removed = freshRemoved();
  const app = clean(asRecord(suite["app"])?.["name"], removed);
  return {
    _tag: "feedback",
    event: "check_failed",
    prs,
    note: {
      sourceId: `github:check_suite:${id}`,
      coveredBy: `github:check_run:${id}:`,
      actor: "github:checks",
      body: [
        `The checks${app === "" ? "" : ` of ${app}`} failed (${failing.conclusion}) on ${short(head)} of pull request ${prList(prs)}`,
        ...removedLines(removed),
      ].join("\n"),
    },
  };
};

const workflowRunFeedback = (
  body: Record<string, unknown>,
): PullRequestFeedback | undefined => {
  const run = asRecord(body["workflow_run"]);
  const id = idOf(run?.["id"]);
  if (run === undefined || id === undefined) return undefined;
  const failing = failingConclusion(body, run, "workflow run");
  if ("ignored" in failing) return { _tag: "ignored", reason: failing.ignored };
  const head = text(run["head_sha"]);
  const prs = checkedPullRequests(body, run, head);
  if (prs.length === 0) return noPullRequest("workflow run");
  // Keyed by its check suite, as the suite's own delivery is: the two are one failure.
  const suite = idOf(run["check_suite_id"]);
  const page = text(run["html_url"]);
  const removed = freshRemoved();
  const name = clean(run["name"], removed) || id;
  return {
    _tag: "feedback",
    event: "check_failed",
    prs,
    note: {
      sourceId:
        suite === undefined
          ? `github:workflow_run:${id}`
          : `github:check_suite:${suite}`,
      ...(suite === undefined
        ? {}
        : { coveredBy: `github:check_run:${suite}:` }),
      actor: "github:checks",
      body: [
        `Workflow "${name}" failed (${failing.conclusion}) on ${short(head)} of pull request ${prList(prs)}${page === "" ? "" : `: ${page}`}`,
        ...removedLines(removed),
      ].join("\n"),
    },
  };
};

/**
 * One review or check delivery, read for what the card is told (module doc). `undefined` is a
 * payload that is not the event it says it is (no PR on a review, no id on a check); `ignored` is a
 * well-formed delivery that says nothing the card acts on, with the reason.
 */
export const githubPullRequestFeedback = (
  event: string,
  payload: unknown,
): PullRequestFeedback | undefined => {
  const body = asRecord(payload);
  if (body === undefined) return undefined;
  switch (event) {
    case "pull_request_review":
      return reviewFeedback(body);
    case "pull_request_review_comment":
      return reviewCommentFeedback(body);
    case "check_run":
      return checkRunFeedback(body);
    case "check_suite":
      return checkSuiteFeedback(body);
    case "workflow_run":
      return workflowRunFeedback(body);
    default:
      return { _tag: "ignored", reason: `event "${event}" is not feedback` };
  }
};

/**
 * What one delivery wrote across the cards it reached: notes recorded, cards blocked, and cards that
 * could not be written to (a storage failure), which the route answers `500` for.
 */
export type FeedbackRecorded = {
  readonly recorded: number;
  readonly blocked: number;
  readonly failed: number;
};

/**
 * Write one delivery's note on every card whose current PR it names. A card that could not be
 * written to is logged and counted (`failed`) rather than stopping the others: the review already
 * happened, and the other cards should still hear of it.
 */
export const recordPullRequestFeedback = (
  feedback: Extract<PullRequestFeedback, { readonly _tag: "feedback" }>,
): Effect.Effect<FeedbackRecorded, never, TaskService | SqlClient> =>
  Effect.gen(function* () {
    const tasks = yield* TaskService;
    let recorded = 0;
    let blocked = 0;
    let failed = 0;
    const reached = new Set<string>();
    for (const pr of feedback.prs) {
      for (const taskId of yield* cardsOfPullRequest(pr.url, pr.apiUrl)) {
        if (reached.has(taskId)) continue;
        reached.add(taskId);
        const wrote = yield* tasks
          .recordPullRequestFeedback({ ...feedback.note, taskId })
          .pipe(
            Effect.catch((error) =>
              Effect.gen(function* () {
                failed += 1;
                yield* Effect.logWarning(
                  `card ${taskId}: ${feedback.event} on pull request #${pr.number} could not be recorded: ${error.message}`,
                );
                return undefined;
              }),
            ),
          );
        if (wrote?.recorded === true) recorded += 1;
        if (wrote?.blocked === true) blocked += 1;
      }
    }
    return { recorded, blocked, failed };
  });

const JsonBody = Schema.fromJsonString(Schema.Unknown);

/**
 * One review or check delivery as `POST /webhooks/github` receives it (module doc). In the order each
 * step refuses more, as the route's other handlers do: no secret is `503`, a bad signature `401`, a
 * body that is not the event it names `400`, a delivery that says nothing the card acts on `202`
 * with the reason (`ignored`), and otherwise `200` with how many notes it recorded and cards it
 * blocked (`feedback`) — zero of each for a PR no card follows, or a redelivery. A card that could
 * not be written to makes it `500` (`code: "not-recorded"`, with the same counts): GitHub does not
 * retry on its own, so a failed delivery in its list is what tells a person to redeliver it, and a
 * redelivery lands nothing twice on the cards that were written.
 */
export const handlePullRequestFeedbackWebhook = (input: {
  readonly secret: string | undefined;
  readonly raw: string;
  readonly signature: string | undefined;
  readonly event: string;
}): Effect.Effect<GitHubWebhookAnswer, never, TaskService | SqlClient> =>
  Effect.gen(function* () {
    const refused = refuseGitHubDelivery(input);
    if (refused !== undefined) return refused;
    const payload = yield* Schema.decodeEffect(JsonBody)(input.raw).pipe(
      Effect.orElseSucceed(() => undefined),
    );
    const feedback = githubPullRequestFeedback(input.event, payload);
    if (feedback === undefined) {
      return {
        status: 400,
        body: {
          ok: false,
          error: `the payload is not a ${input.event} delivery`,
          code: "bad-payload",
        },
      };
    }
    if (feedback._tag === "ignored") {
      return { status: 202, body: { ok: true, ignored: feedback.reason } };
    }
    const written = yield* recordPullRequestFeedback(feedback);
    if (written.recorded > 0) {
      yield* Effect.logInfo(
        `github: ${input.event} (${feedback.event}) on ${prList(feedback.prs)} recorded on ${written.recorded} card(s), blocking ${written.blocked}`,
      );
    }
    if (written.failed > 0) {
      return {
        status: 500,
        body: {
          ok: false,
          error: `${written.failed} card(s) could not be written to; redeliver once storage is back`,
          code: "not-recorded",
          event: feedback.event,
          feedback: written,
        },
      };
    }
    return {
      status: 200,
      body: { ok: true, event: feedback.event, feedback: written },
    };
  });
