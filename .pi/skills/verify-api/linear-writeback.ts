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
//  11. every request carried the configured key, verbatim
//
// Env: DATABASE_URL (via DatabaseLive), SESSION_ROOT, REPO_DIR, LINEAR_FAKE_URL, LINEAR_FAKE_LEDGER,
// LINEAR_RUN_STAMP, LINEAR_LOSE_ACK_ISSUE, GITHUB_API_URL (read by the PR client), EVIDENCE_DIR.
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync as writeSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { BunServices } from "@effect/platform-bun";
import { Effect, Layer, ManagedRuntime, Option, Redacted } from "effect";
import { FetchHttpClient } from "effect/http";
import { RepoSlug as RepoSlugSchema } from "@repo/domain/Session";
import type { SessionId } from "@repo/domain/Session";
import type { TriggerRule } from "@repo/domain/Trigger";
import {
  CredentialProvider,
  DEFAULT_LINEAR_STATES,
  githubPullRequestLifecycle,
  linearDelivery,
  LinearIssueSyncLive,
  LinearSessionWriteBack,
  LinearTriggerWriteBack,
  SessionService,
  SessionServiceLive,
  staticTokenProvider,
  syncPullRequestLifecycle,
  TriggerService,
  TriggerServiceLive,
  TriggerSessionsFromSessionService,
} from "@repo/core";
import { createModelAccess } from "@repo/harness";
import { DatabaseLive } from "@repo/storage-postgres";
import { makeChecker, waitUntil } from "./harness.ts";
import type { CheckRecord } from "./harness.ts";

const SESSION_ROOT =
  process.env["SESSION_ROOT"] ?? ".verify/run/linear-writeback/sessions";
const REPO_DIR = process.env["REPO_DIR"] ?? ".verify/run/linear-writeback/repo";
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

await mkdir(EVIDENCE_DIR, { recursive: true });

const rules: ReadonlyArray<TriggerRule> = [
  {
    label: "factory",
    repo: REPO,
    baseRef: "main",
    prompt: "Linear issue {{key}}: {{title}}",
  },
];

const observed: {
  sessions: Record<string, SessionId | null>;
  pr: { number: number; url: string } | null;
  checks: Record<string, CheckRecord>;
} = { sessions: {}, pr: null, checks: {} };
const assert = makeChecker(observed);

/** One sync, shared by both write-backs, as `apps/api` wires it. */
const sync = LinearIssueSyncLive({
  apiUrl: `${FAKE_URL}/graphql`,
  apiKey: Redacted.make(API_KEY),
  states: DEFAULT_LINEAR_STATES,
  sessionUrlBase: "http://localhost:3000/sessions",
}).pipe(Layer.provide(FetchHttpClient.layer));

const database = Layer.mergeAll(DatabaseLive, BunServices.layer);

const sessions = SessionServiceLive({
  model: createModelAccess("faux"),
  sessionRoot: SESSION_ROOT,
}).pipe(
  Layer.provide(LinearSessionWriteBack.pipe(Layer.provide(sync))),
  Layer.provideMerge(database),
);

const runtime = ManagedRuntime.make(
  Layer.mergeAll(
    TriggerServiceLive({ rules }).pipe(
      Layer.provide(
        Layer.mergeAll(
          TriggerSessionsFromSessionService,
          LinearTriggerWriteBack.pipe(Layer.provide(sync)),
        ),
      ),
    ),
    sync,
  ).pipe(Layer.provideMerge(sessions)),
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
const issuePayload = (key: string, title: string) => ({
  action: "create",
  type: "Issue",
  webhookTimestamp: Date.now(),
  data: {
    id: key,
    identifier: key,
    title,
    description: "Delegated from Linear in the LOB-15 drive.",
    labels: [{ id: "label-factory", name: "factory" }],
    labelIds: ["label-factory"],
  },
});

const deliver = (key: string, title: string) =>
  Effect.gen(function* () {
    const delivery = linearDelivery(issuePayload(key, title), rules);
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

  // 9–10: the PR's life after it opened, as GitHub's `pull_request` events say it.
  const number = observed.pr?.number ?? 0;
  const before = writesTo(DELIVERED);
  const pushed = githubPullRequestLifecycle({
    action: "synchronize",
    pull_request: { number, html_url: prUrl, merged: false },
  });
  const pushedCount =
    pushed === undefined ? -1 : yield* syncPullRequestLifecycle(pushed);
  assert(
    "a new commit on the PR writes nothing to the issue: its state is the task's, not the review's",
    pushedCount === 0 &&
      writesTo(DELIVERED) === before &&
      issue(DELIVERED)?.state.name === "In Review",
    `synced=${pushedCount} state=${String(issue(DELIVERED)?.state.name)}`,
  );
  const merged = githubPullRequestLifecycle({
    action: "closed",
    pull_request: { number, html_url: prUrl, merged: true },
  });
  const mergedCount =
    merged === undefined ? -1 : yield* syncPullRequestLifecycle(merged);
  assert(
    "the PR's merge moves the issue to Done",
    mergedCount === 1 && issue(DELIVERED)?.state.name === "Done",
    `synced=${mergedCount} state=${String(issue(DELIVERED)?.state.name)}`,
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

const exit = await runtime.runPromiseExit(run);
if (exit._tag === "Failure") {
  console.error(exit.cause);
}
await runtime.dispose();

const checks = Object.values(observed.checks);
const failed = checks.filter((check) => !check.passed).length;
await writeFile(
  path.join(EVIDENCE_DIR, "linear-writeback-observed.json"),
  `${JSON.stringify({ ...observed, failed }, null, 2)}\n`,
);
console.log(
  `\nlinear-writeback: ${checks.length - failed}/${checks.length} checks passed — evidence in ${EVIDENCE_DIR}`,
);
process.exit(failed === 0 && exit._tag === "Success" ? 0 : 1);
