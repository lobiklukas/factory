// Session → Linear end to end (LOB-15): a delegated issue reaches In Review with its PR on it, a
// failed run explains itself, and no retry writes anything twice.
//
//   bun linear-writeback.ts        (linear-writeback.sh starts the two fakes first)
//
// What runs is the real thing everywhere but the two vendors: `TriggerService` on the run's Postgres
// with the Linear adapter's own delivery (`linearDelivery`), the real `SessionService` (faux model)
// whose PR step runs in a real worktree of a throwaway repo, and the real write-back —
// `LinearIssueSyncLive` behind both `LinearTriggerWriteBack` and `LinearSessionWriteBack` — over an
// Effect `HttpClient` pointed at `./linear-api-fake.ts`. GitHub is `./github-fake.ts`, reached
// through `GITHUB_API_URL`. Nothing here reaches linear.app or api.github.com.
//
// The checks:
//
//   1. a Linear issue delivery opens a session, and the issue moves Todo → In Progress
//   2. the session's PR step opens a PR, and the issue gets the PR as an attachment
//   3. … and exactly one comment, carrying the PR link, the session and its verification evidence
//   4. … and reaches In Review — no human touched the fake Linear
//   5. a retried PR step (`already-open`) and Linear's redelivery of the issue write nothing more:
//      one comment, one attachment, and the issue stays In Review (a late "started" does not drag it
//      back)
//   6. a run that changed nothing leaves one explanatory comment saying so, and the issue stays
//      In Progress — a failure is not a review
//   7. the same failure reported again leaves no second comment
//   8. a comment that landed and whose acknowledgement was lost is not posted twice: the sync
//      retries, re-reads, and finds it
//   9. a new commit on the PR (`synchronize`) writes nothing to the issue: its state is the task's,
//      not the review's
//  10. the PR's merge moves the issue to Done
//
// 9 and 10 arrive as GitHub sends them: a signed `pull_request` webhook body, through
// `handleGitHubPullRequestWebhook` — the code `POST /webhooks/github` runs — and a delivery with a
// wrong signature is refused without a write.
//  11. every request carried the configured key, verbatim
//
// The card path (LOB-254): a rule in `card` mode puts the issue on the repo's board instead of
// opening a session, and the write-back follows the card's run.
//
//  12. a mapped Linear issue create files exactly one card in intake — external ref `linear:<id>`,
//      the description as its body, the issue's link — opens no session, and writes nothing to
//      Linear yet (the issue moves when the card's run opens its PR)
//  13. a replay of that delivery and a second, distinct delivery for the same issue file no second
//      card
//  14. starting a run on the card and opening its PR moves the issue to In Review, with the PR as
//      an attachment and exactly one comment carrying the PR link — and a retried PR step adds none
//
// The Linear-delegated run's questions and an issue's blockers (T5):
//
//  15. a mapped delivery for an issue with an open `blockedBy` relation is skipped with `blocked by
//      <id>` and files no card — the blocker read is Linear's real query against the loopback fake
//  16. once the blocker is Done in Linear, the same delivery, arriving again, files the card — and a
//      replay of that is a replay
//  17. a run on a card filed from a Linear issue that calls `ask` parks the card `needs_input` on its
//      question and posts exactly one agent activity of type `elicitation` into Linear, in an agent
//      session opened on that issue, carrying the question verbatim
//  18. the ask replayed (the ask write-back called again with the same ask id) posts nothing: still one
//      activity, still one session
//  19. a person's reply, as Linear's `AgentSessionEvent` `prompted` event, lifts the block: it is the
//      card's `answer` comment, verbatim, and it cost no request to Linear — the reply is an event,
//      never a comment read back
//  20. Linear's redelivery of that reply, and a second reply to the answered wait, record nothing: the
//      thread keeps one answer
//
// Env: DATABASE_URL (via DatabaseLive), SESSION_ROOT, REPO_DIR, LINEAR_FAKE_URL, LINEAR_FAKE_LEDGER,
// LINEAR_RUN_STAMP, LINEAR_LOSE_ACK_ISSUE, GITHUB_API_URL (read by the PR client), EVIDENCE_DIR.
import { execSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { readFileSync, writeFileSync as writeSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { BunServices } from "@effect/platform-bun";
import { Effect, Layer, ManagedRuntime, Option, Redacted } from "effect";
import { FetchHttpClient } from "effect/http";
import { SqlClient } from "effect/sql/SqlClient";
import { RepoSlug as RepoSlugSchema } from "@repo/domain/Session";
import type { SessionId } from "@repo/domain/Session";
import type { TriggerRule } from "@repo/domain/Trigger";
import {
  AskWriteBack,
  CredentialProvider,
  DEFAULT_LINEAR_STATES,
  handleGitHubPullRequestWebhook,
  linearDelivery,
  LinearAskWriteBack,
  LinearIssueSync,
  LinearIssueSyncLive,
  LinearSessionWriteBack,
  LinearTriggerBlockers,
  LinearTriggerReplies,
  LinearTriggerWriteBack,
  SessionService,
  SessionServiceLive,
  staticTokenProvider,
  TaskService,
  TaskServiceLive,
  TriggerCardsFromTaskService,
  TriggerService,
  TriggerServiceLive,
  TriggerSessionsFromSessionService,
} from "@repo/core";
import { DEFAULT_DEFINITION_ID, DefinitionId } from "@repo/domain/Task";
import { createFauxModelAccess, createModelAccess } from "@repo/harness";
import { DatabaseLive } from "@repo/storage-postgres";
import { makeChecker, waitUntil } from "./harness.ts";
import type { CheckRecord } from "./harness.ts";

const SESSION_ROOT =
  process.env["SESSION_ROOT"] ?? ".verify/run/linear-writeback/sessions";
// Absolute, because `registerRepo` refuses a relative checkout (LOB-253).
const REPO_DIR = path.resolve(
  process.env["REPO_DIR"] ?? ".verify/run/linear-writeback/repo",
);
const STAMP = process.env["LINEAR_RUN_STAMP"] ?? String(Date.now());
const REPO = RepoSlugSchema.make(`acme/verify-linear-writeback-${STAMP}`);
const FAKE_URL = process.env["LINEAR_FAKE_URL"] ?? "http://127.0.0.1:9416";
const LEDGER =
  process.env["LINEAR_FAKE_LEDGER"] ??
  ".verify/run/linear-writeback/linear-ledger.json";
const EVIDENCE_DIR = process.env["EVIDENCE_DIR"] ?? ".verify/evidence/lob-15";
const API_KEY = "lin_api_drive_key";
/** The issue whose first comment's acknowledgement the fake loses (`linear-writeback.sh`). */
const LOSE_ACK_ISSUE = process.env["LINEAR_LOSE_ACK_ISSUE"] ?? `LOSE-${STAMP}`;

const DELIVERED = `ENG-${STAMP}`;
const NO_CHANGE = `NOP-${STAMP}`;
/** The issue the card path files (LOB-254): its own label, so only the card rule claims it. */
const CARDED = `CRD-${STAMP}`;
const CARD_DESCRIPTION =
  "## Goal\n\nFiled onto the board by the LOB-254 drive — **verbatim**.\n";

await mkdir(EVIDENCE_DIR, { recursive: true });

const rules: ReadonlyArray<TriggerRule> = [
  {
    label: "factory",
    repo: REPO,
    baseRef: "main",
    prompt: "Linear issue {{key}}: {{title}}",
  },
  // The card path (LOB-254): the issue lands on the repo's board, and no session opens.
  {
    label: "factory-card",
    repo: REPO,
    baseRef: "main",
    prompt: "",
    mode: "card",
  },
];

const observed: {
  sessions: Record<string, SessionId | null>;
  card: unknown;
  pr: { number: number; url: string } | null;
  checks: Record<string, CheckRecord>;
} = { sessions: {}, card: null, pr: null, checks: {} };
const assert = makeChecker(observed);

/** One sync, shared by both write-backs, as `apps/api` wires it. */
const sync = LinearIssueSyncLive({
  apiUrl: `${FAKE_URL}/graphql`,
  apiKey: Redacted.make(API_KEY),
  states: DEFAULT_LINEAR_STATES,
  sessionUrlBase: "http://localhost:3000/sessions",
}).pipe(Layer.provide(FetchHttpClient.layer));

const database = Layer.mergeAll(DatabaseLive, BunServices.layer);

// The card port and the drive's own board reads: `TaskService` over the same database, which the
// session layer provides (`provideMerge`).
const tasks = TaskServiceLive;

/**
 * The process as `apps/api` wires it, over a model: the seam (with the Linear write-back, the blocker
 * gate and the reply port), the session layer (with both Linear write-backs: the PR step's and the
 * ask's), and the board. The T5 section runs a second one whose model asks.
 */
const runtimeOver = (model: ReturnType<typeof createModelAccess>) => {
  const sessions = SessionServiceLive({
    model,
    sessionRoot: SESSION_ROOT,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(
        LinearSessionWriteBack.pipe(Layer.provide(sync)),
        LinearAskWriteBack.pipe(Layer.provide(sync)),
      ),
    ),
    Layer.provideMerge(database),
  );
  return ManagedRuntime.make(
    Layer.mergeAll(
      TriggerServiceLive({ rules }).pipe(
        Layer.provide(
          Layer.mergeAll(
            TriggerSessionsFromSessionService,
            TriggerCardsFromTaskService.pipe(Layer.provide(tasks)),
            LinearTriggerWriteBack.pipe(Layer.provide(sync)),
            LinearTriggerBlockers.pipe(Layer.provide(sync)),
            LinearTriggerReplies.pipe(Layer.provide(tasks)),
          ),
        ),
      ),
      sync,
      tasks,
    ).pipe(Layer.provideMerge(sessions)),
  );
};

const runtime = runtimeOver(createModelAccess("faux"));
/** The T5 section's: a model that calls `ask` with `QUESTION` once its first turn is done. */
const QUESTION = "Which Postgres major does this target?";
const askRuntime = runtimeOver(
  createFauxModelAccess({ fauxAsk: QUESTION }).access,
);

const github = Layer.merge(
  Layer.succeed(
    CredentialProvider,
    staticTokenProvider(
      Option.some(Redacted.make("linear-writeback-gh-token")),
    ),
  ),
  FetchHttpClient.layer,
);

type LedgerIssue = {
  readonly identifier: string;
  readonly state: { readonly name: string };
  readonly comments: readonly string[];
  readonly attachments: ReadonlyArray<{
    readonly url: string;
    readonly title: string;
  }>;
};
type Ledger = {
  readonly requests: ReadonlyArray<{
    readonly operation: string;
    readonly authorization: string | null;
  }>;
  readonly issues: Record<string, LedgerIssue>;
  readonly lostAcks: readonly string[];
  readonly agentSessions: ReadonlyArray<{
    readonly id: string;
    readonly issueId: string;
  }>;
  readonly activities: ReadonlyArray<{
    readonly agentSessionId: string;
    readonly content: Record<string, unknown>;
  }>;
};

const ledger = (): Ledger => JSON.parse(readFileSync(LEDGER, "utf8")) as Ledger;
const issue = (key: string): LedgerIssue | undefined => ledger().issues[key];
const writesTo = (key: string): number => {
  const found = issue(key);
  return found === undefined
    ? 0
    : found.comments.length + found.attachments.length;
};

/** Linear's `Issue` `create` webhook body for a labelled issue, as the adapter reads it. */
const issuePayload = (
  key: string,
  title: string,
  label = "factory",
  description = "Delegated from Linear in the LOB-15 drive.",
) => ({
  action: "create",
  type: "Issue",
  webhookTimestamp: Date.now(),
  url: `https://linear.app/acme/issue/${key}`,
  data: {
    id: key,
    identifier: key,
    title,
    description,
    url: `https://linear.app/acme/issue/${key}/drive`,
    labels: [{ id: `label-${label}`, name: label }],
    labelIds: [`label-${label}`],
  },
});

const deliver = (
  key: string,
  title: string,
  label?: string,
  description?: string,
) =>
  Effect.gen(function* () {
    const delivery = linearDelivery(
      issuePayload(key, title, label, description),
      rules,
    );
    if (delivery === undefined) {
      return yield* Effect.die(
        new Error(`the ${key} payload did not normalize`),
      );
    }
    return yield* (yield* TriggerService).deliver(delivery);
  });

/** The faux run the delivery started, settled, so the worktree is the drive's to commit in. */
const settled = (sessionId: SessionId) =>
  Effect.gen(function* () {
    const service = yield* SessionService;
    return yield* waitUntil(
      Effect.map(service.get(sessionId), (snapshot) =>
        snapshot.session.status === "busy" ? false : snapshot,
      ),
      `${sessionId} to settle`,
    );
  });

const openPr = (sessionId: SessionId) =>
  Effect.gen(function* () {
    const service = yield* SessionService;
    return yield* service
      .openPullRequest({
        sessionId,
        title: `factory: ${sessionId}`,
        head: `factory/${sessionId}`,
        base: "main",
      })
      .pipe(Effect.provide(github));
  });

const GITHUB_WEBHOOK_SECRET = "linear-writeback-gh-webhook-secret";

/** One `pull_request` delivery, signed as GitHub signs it, through the route's handler. */
const githubHook = (payload: unknown, key = GITHUB_WEBHOOK_SECRET) => {
  const raw = JSON.stringify(payload);
  return handleGitHubPullRequestWebhook({
    secret: GITHUB_WEBHOOK_SECRET,
    raw,
    signature: `sha256=${createHmac("sha256", key).update(raw).digest("hex")}`,
    event: "pull_request",
  });
};

const commitChange = (worktree: string) => {
  writeSync(
    path.join(worktree, "CHANGE.md"),
    `# A change\n\nMade at ${STAMP}.\n`,
  );
  execSync("git add CHANGE.md && git commit -q -m 'a change for LOB-15'", {
    cwd: worktree,
    stdio: "ignore",
  });
};

const run = Effect.gen(function* () {
  const service = yield* SessionService;
  yield* service.registerRepo({
    repo: REPO,
    url: "https://github.com/acme/verify-linear-writeback.git",
    localPath: REPO_DIR,
    defaultBaseRef: "main",
  });

  // 1: the delivery opens the session and the issue moves to started.
  const created = yield* deliver(DELIVERED, "Close the loop in Linear");
  const sessionId = created.sessionId;
  observed.sessions[DELIVERED] = sessionId ?? null;
  assert(
    "a delegated Linear issue opens a session, and the issue moves to In Progress",
    created.status === "processed" &&
      sessionId !== undefined &&
      issue(DELIVERED)?.state.name === "In Progress",
    `status=${created.status} session=${String(sessionId)} state=${String(issue(DELIVERED)?.state.name)}`,
  );
  if (sessionId === undefined) {
    return yield* Effect.die(new Error("no session: the rest proves nothing"));
  }

  // 2–4: the PR step opens a PR and the issue shows it, without anyone touching Linear.
  const snapshot = yield* settled(sessionId);
  commitChange(snapshot.workspace.path);
  const opened = yield* openPr(sessionId);
  observed.pr =
    opened.outcome === "opened"
      ? { number: opened.number, url: opened.url }
      : null;
  const afterPr = issue(DELIVERED);
  const prUrl = observed.pr?.url ?? "(no PR)";
  // What GitHub itself calls this PR, spelled here rather than read back from the factory: the page
  // a person opens and a webhook names as `html_url`, and the API resource it names as `url`. The
  // fake answers both, so a client that recorded the wrong one fails here and at the merge below.
  const prPage = `https://github.com/${REPO}/pull/${observed.pr?.number ?? 0}`;
  const prApi = `https://api.github.com/repos/${REPO}/pulls/${observed.pr?.number ?? 0}`;
  assert(
    "the session records the PR's page, not GitHub's API resource",
    prUrl === prPage,
    `recorded=${prUrl} page=${prPage}`,
  );
  assert(
    "the PR step opens a PR, and the issue carries it as an attachment",
    opened.outcome === "opened" &&
      afterPr?.attachments.length === 1 &&
      afterPr.attachments[0]?.url === prUrl,
    `outcome=${opened.outcome} attachments=${JSON.stringify(afterPr?.attachments)}`,
  );
  const comment = afterPr?.comments[0] ?? "";
  assert(
    "one comment carries the PR link, the session and the verification evidence",
    afterPr?.comments.length === 1 &&
      comment.includes(prUrl) &&
      comment.includes(`http://localhost:3000/sessions/${sessionId}`) &&
      comment.includes("No verification was recorded in the session.") &&
      comment.includes(`factory:${sessionId}:pr`),
    JSON.stringify(comment),
  );
  assert(
    'the issue reaches "In Review" with no human touching Linear',
    afterPr?.state.name === "In Review",
    `state=${String(afterPr?.state.name)}`,
  );

  // 5: retries — the PR step again, and Linear's redelivery of the issue.
  const repeated = yield* openPr(sessionId);
  const redelivered = yield* deliver(DELIVERED, "Close the loop in Linear");
  const afterRetry = issue(DELIVERED);
  assert(
    "a retried PR step and a redelivered issue write nothing more, and the issue stays In Review",
    repeated.outcome === "already-open" &&
      redelivered.replayed &&
      afterRetry?.comments.length === 1 &&
      afterRetry.attachments.length === 1 &&
      afterRetry.state.name === "In Review",
    `repeat=${repeated.outcome} replayed=${redelivered.replayed} comments=${afterRetry?.comments.length} attachments=${afterRetry?.attachments.length} state=${afterRetry?.state.name}`,
  );

  // 6–7: a run that changed nothing explains itself, once.
  const quiet = yield* deliver(NO_CHANGE, "Nothing to change here");
  const quietId = quiet.sessionId;
  observed.sessions[NO_CHANGE] = quietId ?? null;
  if (quietId === undefined) {
    return yield* Effect.die(new Error(`no session for ${NO_CHANGE}`));
  }
  yield* settled(quietId);
  const empty = yield* openPr(quietId);
  const afterEmpty = issue(NO_CHANGE);
  assert(
    "a run that changed nothing leaves one comment saying why, and the issue stays In Progress",
    empty.outcome === "no-change" &&
      afterEmpty?.comments.length === 1 &&
      (afterEmpty.comments[0] ?? "").includes(
        "did not produce a pull request: the run changed no file against its base branch",
      ) &&
      afterEmpty.state.name === "In Progress",
    `outcome=${empty.outcome} comments=${JSON.stringify(afterEmpty?.comments)} state=${String(afterEmpty?.state.name)}`,
  );
  yield* openPr(quietId);
  assert(
    "the same failure reported again leaves no second comment",
    issue(NO_CHANGE)?.comments.length === 1,
    `comments=${issue(NO_CHANGE)?.comments.length}`,
  );

  // 8: the lost acknowledgement.
  const lossy = yield* deliver(
    LOSE_ACK_ISSUE,
    "A comment whose answer is lost",
  );
  const lossyId = lossy.sessionId;
  observed.sessions[LOSE_ACK_ISSUE] = lossyId ?? null;
  if (lossyId === undefined) {
    return yield* Effect.die(new Error(`no session for ${LOSE_ACK_ISSUE}`));
  }
  yield* settled(lossyId);
  yield* openPr(lossyId);
  const posted = ledger().requests.filter(
    (request) => request.operation === "commentCreate",
  ).length;
  assert(
    "a comment that landed and lost its acknowledgement is not posted twice by the retry",
    // The fake really did lose the answer — otherwise one comment would prove nothing.
    ledger().lostAcks.includes(LOSE_ACK_ISSUE) &&
      issue(LOSE_ACK_ISSUE)?.comments.length === 1,
    `lostAcks=${JSON.stringify(ledger().lostAcks)} comments=${issue(LOSE_ACK_ISSUE)?.comments.length} commentCreate calls so far=${posted}`,
  );

  // 9–10: the PR's life after it opened, as GitHub's signed `pull_request` webhooks say it.
  const number = observed.pr?.number ?? 0;
  const before = writesTo(DELIVERED);
  const pushed = yield* githubHook({
    action: "synchronize",
    pull_request: { number, url: prApi, html_url: prPage, merged: false },
  });
  assert(
    "a new commit on the PR writes nothing to the issue: its state is the task's, not the review's",
    pushed.status === 200 &&
      pushed.body["synced"] === 0 &&
      writesTo(DELIVERED) === before &&
      issue(DELIVERED)?.state.name === "In Review",
    `answer=${JSON.stringify(pushed)} state=${String(issue(DELIVERED)?.state.name)}`,
  );
  const mergedBody = {
    action: "closed",
    pull_request: { number, url: prApi, html_url: prPage, merged: true },
  };
  const forged = yield* githubHook(mergedBody, "not-the-secret");
  const stillInReview = issue(DELIVERED)?.state.name === "In Review";
  const merged = yield* githubHook(mergedBody);
  assert(
    "the PR's merge moves the issue to Done (a forged merge event is refused first)",
    forged.status === 401 &&
      stillInReview &&
      merged.status === 200 &&
      merged.body["synced"] === 1 &&
      issue(DELIVERED)?.state.name === "Done",
    `forged=${forged.status} merged=${JSON.stringify(merged)} state=${String(issue(DELIVERED)?.state.name)}`,
  );

  // 12–14: the card path (LOB-254). The board is the repo's one board, made as an operator would.
  const board = yield* (yield* TaskService).createBoard({
    repo: REPO,
    definitionId: DefinitionId.make(DEFAULT_DEFINITION_ID),
  });
  /** Sessions any delivery about the carded issue opened: the card path must open none. */
  const triggerSessions = Effect.gen(function* () {
    const sql = yield* SqlClient;
    const rows = yield* sql<{ count: number }>`
      SELECT count(*)::int AS count FROM sessions
      WHERE request_id LIKE ${`trigger:%${CARDED}%`}
    `;
    return rows[0]?.count ?? -1;
  });
  const carded = yield* deliver(
    CARDED,
    "File me on the board",
    "factory-card",
    CARD_DESCRIPTION,
  );
  const onBoard = yield* (yield* TaskService).list({ boardId: board.id });
  const card = onBoard[0];
  observed.card = card ?? null;
  assert(
    "a mapped Linear issue create files exactly one card in intake, with its ref, body and link, and opens no session",
    carded.status === "processed" &&
      carded.sessionId === undefined &&
      carded.taskId === card?.id &&
      onBoard.length === 1 &&
      card?.column === "intake" &&
      card.externalRef === `linear:${CARDED}` &&
      card.body === CARD_DESCRIPTION &&
      card.externalUrl === `https://linear.app/acme/issue/${CARDED}/drive` &&
      (yield* triggerSessions) === 0,
    `outcome=${JSON.stringify(carded)} cards=${JSON.stringify(onBoard)}`,
  );
  // The blocker gate reads the issue's relations (a read), so Linear may have seen the issue; what it
  // must not have is a write: no comment, no attachment, and no move out of Todo.
  const filedIssue = issue(CARDED);
  assert(
    "filing the card writes nothing to Linear: the issue moves when the card's run opens its PR",
    filedIssue === undefined ||
      (filedIssue.state.name === "Todo" &&
        filedIssue.comments.length === 0 &&
        filedIssue.attachments.length === 0),
    `issue=${JSON.stringify(filedIssue)}`,
  );
  if (card === undefined) {
    return yield* Effect.die(new Error("no card: the rest proves nothing"));
  }

  const replayedCard = yield* deliver(
    CARDED,
    "File me on the board",
    "factory-card",
    CARD_DESCRIPTION,
  );
  const cardDelivery = linearDelivery(
    issuePayload(CARDED, "File me on the board", "factory-card"),
    rules,
  );
  // A second, distinct delivery for the same issue: a key the claim has never seen.
  const distinctCard = yield* (yield* TriggerService).deliver({
    requestId: `linear-writeback-distinct-${STAMP}`,
    event: cardDelivery!.event,
  });
  const stillOne = yield* (yield* TaskService).list({ boardId: board.id });
  assert(
    "a replayed delivery and a second, distinct delivery for the same issue file no second card",
    replayedCard.replayed &&
      !distinctCard.replayed &&
      distinctCard.taskId === card.id &&
      stillOne.length === 1 &&
      (yield* triggerSessions) === 0,
    `replay=${JSON.stringify(replayedCard)} distinct=${JSON.stringify(distinctCard)} cards=${stillOne.length}`,
  );

  // The run starts from the card, as `factory board start --task` starts it.
  const cardRun = yield* service.create({
    title: card.title,
    taskId: card.id,
    taskColumn: card.column,
    repo: REPO,
    actor: "person:linear-writeback-drive",
  });
  observed.sessions[CARDED] = cardRun.id;
  const cardSnapshot = yield* settled(cardRun.id);
  commitChange(cardSnapshot.workspace.path);
  const cardPr = yield* openPr(cardRun.id);
  yield* openPr(cardRun.id);
  const afterCardPr = issue(CARDED);
  const cardPrUrl = cardPr.outcome === "opened" ? cardPr.url : "(no PR)";
  assert(
    "starting a run on the card and opening its PR moves the issue to In Review, with one PR comment",
    cardPr.outcome === "opened" &&
      cardSnapshot.workspace.baseRef === "main" &&
      afterCardPr?.state.name === "In Review" &&
      afterCardPr.attachments.length === 1 &&
      afterCardPr.attachments[0]?.url === cardPrUrl &&
      afterCardPr.comments.length === 1 &&
      (afterCardPr.comments[0] ?? "").includes(cardPrUrl) &&
      (afterCardPr.comments[0] ?? "").includes(`factory:${cardRun.id}:pr`),
    `outcome=${cardPr.outcome} issue=${JSON.stringify(afterCardPr)}`,
  );

  // 15–16: an issue with an open blocker does not start (T5).
  const BLOCKED = `BLK-${STAMP}`;
  const BLOCKER = `DEP-${STAMP}`;
  // Linear mints a UUID per issue; the fake's is `uuid-<key>`, and a relation names its ends by it.
  const ref = (key: string) => ({ id: `uuid-${key}`, identifier: key });
  const linear = yield* LinearIssueSync;
  yield* linear.openBlockers({ issueId: BLOCKER });
  yield* linear.openBlockers({ issueId: BLOCKED });
  yield* linear.blocks({ blocker: ref(BLOCKER), blocked: ref(BLOCKED) });
  const cardsBefore = (yield* (yield* TaskService).list({ boardId: board.id }))
    .length;
  const heldBack = yield* deliver(
    BLOCKED,
    "Wait for the blocker",
    "factory-card",
    CARD_DESCRIPTION,
  );
  const cardsHeld = (yield* (yield* TaskService).list({ boardId: board.id }))
    .length;
  assert(
    "a mapped issue with an open blockedBy relation is skipped with `blocked by <id>` and files no card",
    heldBack.status === "skipped" &&
      heldBack.reason === `blocked by ${BLOCKER}` &&
      heldBack.taskId === undefined &&
      cardsHeld === cardsBefore &&
      (yield* triggerSessions) === 0,
    `outcome=${JSON.stringify(heldBack)} cards ${cardsBefore} → ${cardsHeld}`,
  );
  // The blocker's PR merges: Linear moves it to Done, and the blocked issue's delivery comes again.
  yield* linear.merged({ issueId: BLOCKER, sessionId, pr: observed.pr! });
  const released = yield* deliver(
    BLOCKED,
    "Wait for the blocker",
    "factory-card",
    CARD_DESCRIPTION,
  );
  const afterRelease = yield* (yield* TaskService).list({ boardId: board.id });
  const releasedAgain = yield* deliver(
    BLOCKED,
    "Wait for the blocker",
    "factory-card",
    CARD_DESCRIPTION,
  );
  assert(
    "once the blocker is Done the same delivery files the card, and a redelivery of that is a replay",
    issue(BLOCKER)?.state.name === "Done" &&
      released.status === "processed" &&
      !released.replayed &&
      afterRelease.length === cardsBefore + 1 &&
      afterRelease.some((one) => one.externalRef === `linear:${BLOCKED}`) &&
      releasedAgain.replayed,
    `released=${JSON.stringify(released)} cards=${afterRelease.length} again=${JSON.stringify(releasedAgain)}`,
  );

  // 11
  const keys = new Set(
    ledger().requests.map((request) => request.authorization),
  );
  assert(
    "every request carried the configured key, verbatim",
    keys.size === 1 && keys.has(API_KEY),
    `authorization values=${JSON.stringify([...keys])}`,
  );
});

/**
 * 17–20: the Linear-delegated run's question (T5), on a runtime whose model asks. The card is filed by
 * the same Linear delivery as above, then a real run on it calls `ask`.
 */
const ASKED = `ASK-${STAMP}`;
const ANSWER = "Postgres 16.\n  Keep port 5442 \u2014 it is shared.  ";
const askRun = Effect.gen(function* () {
  const service = yield* SessionService;
  const tasksService = yield* TaskService;
  const sql = yield* SqlClient;
  const filed = yield* deliver(
    ASKED,
    "Ask me something",
    "factory-card",
    CARD_DESCRIPTION,
  );
  if (filed.taskId === undefined) {
    return yield* Effect.die(new Error("no card for the ask section"));
  }
  const filedCard = yield* tasksService.get(filed.taskId);
  // As a person moves it to where a run asks (the `ask` drives do the same): `specifying`.
  const card = yield* tasksService.move({
    taskId: filedCard.id,
    expectedRevision: filedCard.revision,
    to: "specifying",
    actor: "person:linear-writeback-drive",
  });
  const run = yield* service.create({
    title: card.title,
    taskId: card.id,
    taskColumn: card.column,
    repo: REPO,
    actor: "person:linear-writeback-drive",
  });
  observed.sessions[ASKED] = run.id;
  yield* service.send({ sessionId: run.id, content: "specify it" });
  const parked = yield* waitUntil(
    Effect.map(tasksService.get(card.id), (task) =>
      task.blocked === undefined ? false : task,
    ),
    "the run to ask",
  );
  const thread = yield* tasksService.comments(card.id);
  const activities = () => ledger().activities;
  const sessionsOpened = () => ledger().agentSessions;
  // The card parks first and the question is mirrored to Linear right after (best effort, after the
  // ask is on the card): wait for the ledger row that says the mirror finished before counting.
  yield* waitUntil(
    Effect.map(
      sql`SELECT 1 FROM linear_elicitations WHERE task_id = ${card.id}`,
      (rows) => (rows.length > 0 ? true : false),
    ),
    "the question to reach Linear",
  );
  assert(
    "a run's ask on a Linear-sourced card parks it needs_input and posts exactly one elicitation, verbatim, in an agent session on the issue",
    parked.blocked?.reason === "needs_input" &&
      thread.length === 1 &&
      thread[0]?.kind === "question" &&
      thread[0].body === QUESTION &&
      activities().length === 1 &&
      activities()[0]?.content["type"] === "elicitation" &&
      activities()[0]?.content["body"] === QUESTION &&
      sessionsOpened().length === 1 &&
      sessionsOpened()[0]?.issueId === ASKED &&
      activities()[0]?.agentSessionId === sessionsOpened()[0]?.id,
    `blocked=${JSON.stringify(parked.blocked)} thread=${JSON.stringify(thread)} activities=${JSON.stringify(activities())} sessions=${JSON.stringify(sessionsOpened())}`,
  );

  // 18: the ask replayed. The ledger names the ask id the run used; the port is called with it again.
  const asks = yield* sql<{ askId: string }>`
    SELECT ask_id FROM linear_elicitations WHERE task_id = ${card.id}
  `;
  const replay = Layer.build(
    LinearAskWriteBack.pipe(Layer.provide(sync), Layer.provide(database)),
  );
  yield* Effect.scoped(
    Effect.gen(function* () {
      const context = yield* replay;
      const writeBack = yield* Effect.provide(AskWriteBack, context);
      yield* writeBack.asked({
        sessionId: run.id,
        taskId: card.id,
        askId: asks[0]?.askId ?? "(no ask id)",
        question: QUESTION,
      });
    }),
  );
  assert(
    "the ask replayed posts nothing: still one activity and one agent session",
    asks.length === 1 &&
      activities().length === 1 &&
      sessionsOpened().length === 1,
    `asks=${JSON.stringify(asks)} activities=${activities().length} sessions=${sessionsOpened().length}`,
  );

  // 19: the reply is an event.
  const requestsBefore = ledger().requests.length;
  const replyPayload = {
    type: "AgentSessionEvent",
    action: "prompted",
    webhookTimestamp: Date.now(),
    agentSession: {
      id: sessionsOpened()[0]?.id ?? "(none)",
      issue: { id: ASKED, identifier: ASKED },
    },
    agentActivity: {
      id: `act-${STAMP}-answer`,
      content: { type: "prompt", body: ANSWER },
    },
  };
  const trigger = yield* TriggerService;
  const replyDelivery = linearDelivery(replyPayload, rules);
  if (replyDelivery === undefined) {
    return yield* Effect.die(new Error("the reply did not normalize"));
  }
  const answered = yield* trigger.deliver(replyDelivery);
  const unblocked = yield* tasksService.get(card.id);
  const answers = yield* tasksService.comments(card.id);
  assert(
    "a reply event lifts needs_input as the card's verbatim answer, and cost no request to Linear",
    answered.status === "processed" &&
      answered.taskId === card.id &&
      unblocked.blocked === undefined &&
      answers.map((comment) => comment.kind).join() === "question,answer" &&
      answers[1]?.body === ANSWER &&
      answers[1].actor === "trigger:linear" &&
      ledger().requests.length === requestsBefore,
    `answer=${JSON.stringify(answered)} thread=${JSON.stringify(answers)} requests ${requestsBefore} → ${ledger().requests.length}`,
  );

  // 20: redelivery, and a second reply once the wait is answered.
  const again = yield* trigger.deliver(replyDelivery);
  const lateDelivery = linearDelivery(
    {
      ...replyPayload,
      agentActivity: {
        id: `act-${STAMP}-late`,
        content: { type: "prompt", body: "Actually 15." },
      },
    },
    rules,
  );
  const late = yield* trigger.deliver(lateDelivery!);
  assert(
    "a redelivered reply and a second reply to the answered wait record nothing: one answer",
    again.replayed &&
      late.status === "skipped" &&
      (yield* tasksService.comments(card.id)).length === 2,
    `again=${JSON.stringify(again)} late=${JSON.stringify(late)}`,
  );
});

const exit = await runtime.runPromiseExit(run);
if (exit._tag === "Failure") {
  console.error(exit.cause);
}
await runtime.dispose();
const askExit = await askRuntime.runPromiseExit(askRun);
if (askExit._tag === "Failure") {
  console.error(askExit.cause);
}
await askRuntime.dispose();

const checks = Object.values(observed.checks);
const failed = checks.filter((check) => !check.passed).length;
await writeFile(
  path.join(EVIDENCE_DIR, "linear-writeback-observed.json"),
  `${JSON.stringify({ ...observed, failed }, null, 2)}\n`,
);
console.log(
  `\nlinear-writeback: ${checks.length - failed}/${checks.length} checks passed — evidence in ${EVIDENCE_DIR}`,
);
process.exit(
  failed === 0 && exit._tag === "Success" && askExit._tag === "Success" ? 0 : 1,
);
