// The GitHub issues/labels adapter end to end (LOB-190): an issue event in, one session and one
// issue comment out.
//
//   bun github-issues.ts
//
// What runs is the real seam, not a model of it: `TriggerService` on the run's Postgres, the real
// `SessionService` behind its `TriggerSessions` port (so the session, its log and its first message
// are real), and the adapter's real `GitHubWriteBack` over an Effect `HttpClient` pointed at
// `./github-issues-fake.ts` on loopback. Only GitHub is fake.
//
// The checks:
//
//   1. an `opened` issue carrying the label starts a session, and the session's repo is the one in
//      the payload — the rule names a decoy repo on purpose, so a mapping that read `rule.repo`
//      would open the wrong checkout
//   2. the session is the issue's own words: title, and the rendered rule as its first message
//   3. the write-back posted exactly one comment, on the payload's issue, naming the session
//   4. GitHub's `labeled` twin delivery for the same issue is a replay: one session, one comment
//   5. re-running the `opened` delivery is a replay too
//   6. an `unlabeled` delivery is skipped, with GitHub's own action name in the reason
//   7. an issue opened with no label starts nothing, and
//   8. labelling that same issue afterwards does start work (the later label is a new intent)
//   9. a pull-request payload does not normalize to a delivery at all
//  10. a delivery whose comment landed but whose acknowledgement was lost fails, and the retry
//      reads the issue first and posts no second comment
//
// Env: DATABASE_URL (via DatabaseLive), SESSION_ROOT, GITHUB_ISSUES_FAKE_URL,
// GITHUB_ISSUES_FAKE_LEDGER, GITHUB_TRIGGER_REPO, EVIDENCE_DIR.
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { BunServices } from "@effect/platform-bun";
import { Effect, Layer, ManagedRuntime, Option, Redacted } from "effect";
import { FetchHttpClient } from "effect/http";
import { SqlClient } from "effect/sql/SqlClient";
import { RepoSlug as RepoSlugSchema } from "@repo/domain/Session";
import type { RepoSlug, SessionId } from "@repo/domain/Session";
import type { TriggerDelivery, TriggerRule } from "@repo/domain/Trigger";
import {
  CredentialProvider,
  githubDelivery,
  githubDeliveryFor,
  GitHubWriteBack,
  SessionService,
  SessionServiceLive,
  staticTokenProvider,
  TriggerService,
  TriggerServiceLive,
  TriggerSessionsFromSessionService,
} from "@repo/core";
import { createModelAccess } from "@repo/harness";
import { DatabaseLive } from "@repo/storage-postgres";
import { makeChecker } from "./harness.ts";
import type { CheckRecord } from "./harness.ts";

const SESSION_ROOT =
  process.env["SESSION_ROOT"] ?? ".verify/run/github-issues/sessions";
/**
 * A per-run stamp. The repo and the issue numbers carry it so the drive can be re-run against the
 * same database: a delivery id is stable for one run (which is what the replay checks need) and new
 * for the next one, and the repo starts with no sessions to count.
 */
const RUN_STAMP = Number(process.env["GITHUB_RUN_STAMP"] ?? Date.now());
const REPO = RepoSlugSchema.make(
  `${process.env["GITHUB_TRIGGER_REPO"] ?? "acme/verify-api-github"}-${RUN_STAMP}`,
);
/** The rule's repo: deliberately not the payload's, so criterion 3 is observable. */
const DECOY_REPO = RepoSlugSchema.make(`${REPO}-decoy`);
const FAKE_URL =
  process.env["GITHUB_ISSUES_FAKE_URL"] ?? "http://127.0.0.1:9413";
const LEDGER =
  process.env["GITHUB_ISSUES_FAKE_LEDGER"] ??
  ".verify/run/github-issues/github-issues-ledger.json";
const EVIDENCE_DIR =
  process.env["EVIDENCE_DIR"] ?? ".verify/evidence/latest/api";

await mkdir(EVIDENCE_DIR, { recursive: true });
await mkdir(path.dirname(LEDGER), { recursive: true });

const rules: ReadonlyArray<TriggerRule> = [
  {
    label: "factory",
    repo: DECOY_REPO,
    baseRef: "main",
    prompt: "Work on {{title}}:\n{{body}}",
  },
  // A second rule for the same installation: one issue must still be one session, whichever of
  // the two labels arrives first (reviewer round 2).
  {
    label: "deploy",
    repo: DECOY_REPO,
    prompt: "Deploy {{title}}",
  },
];

const observed: {
  sessionId: SessionId | null;
  sessionRepo: string | null;
  skipped: Array<{ why: string; status: string; reason: string | undefined }>;
  comments: unknown;
  ledger: unknown;
  checks: Record<string, CheckRecord>;
} = {
  sessionId: null,
  sessionRepo: null,
  skipped: [],
  comments: null,
  ledger: null,
  checks: {},
};
const assert = makeChecker(observed);

/** The session layer, the seam, and the adapter's own write-back client — one runtime. */
const base = SessionServiceLive({
  model: createModelAccess("faux"),
  sessionRoot: SESSION_ROOT,
}).pipe(Layer.provideMerge(Layer.mergeAll(DatabaseLive, BunServices.layer)));

// A layer's dependencies must be provided *to* it, not merged beside it: siblings in one
// `mergeAll` are built in the outer context and cannot see each other's outputs, so the write-back
// client takes the HTTP client and the credential provider explicitly.
const credentials = Layer.succeed(
  CredentialProvider,
  CredentialProvider.of(
    staticTokenProvider(Option.some(Redacted.make("ghs-drive-token"))),
  ),
);
const triggers = TriggerServiceLive({ rules }).pipe(
  Layer.provide(
    Layer.mergeAll(
      TriggerSessionsFromSessionService,
      GitHubWriteBack({
        apiUrl: FAKE_URL,
        sessionUrlBase: "http://localhost:3000/sessions",
      }).pipe(Layer.provide(Layer.merge(FetchHttpClient.layer, credentials))),
    ),
  ),
  Layer.provideMerge(base),
);

const runtime = ManagedRuntime.make(triggers);

/** GitHub's `issues` webhook payload, `opened` unless told otherwise. */
const githubPayload = (over: {
  readonly action?: string;
  readonly number?: number;
  readonly labels?: ReadonlyArray<string>;
  readonly pullRequest?: boolean;
}): Record<string, unknown> => ({
  action: over.action ?? "opened",
  issue: {
    number: over.number ?? 7,
    title: "The widget wobbles",
    body: "It wobbles when it spins.",
    labels: (over.labels ?? ["factory"]).map((name, index) => ({
      id: index + 1,
      name,
    })),
    ...(over.pullRequest === true
      ? {
          pull_request: { url: `https://api.github.com/repos/${REPO}/pulls/9` },
        }
      : {}),
  },
  repository: {
    id: 1,
    name: "verify-api-github",
    full_name: REPO,
    owner: { login: "acme" },
  },
});

type Ledger = {
  readonly requests: ReadonlyArray<{
    readonly method: string;
    readonly path: string;
    readonly authorization: string | undefined;
    readonly accept: string | undefined;
    readonly apiVersion: string | undefined;
  }>;
  readonly comments: ReadonlyArray<{
    readonly id: number;
    readonly issue: string;
    readonly body: unknown;
  }>;
};

const readLedger = (): Ledger => {
  try {
    return JSON.parse(readFileSync(LEDGER, "utf8")) as Ledger;
  } catch {
    return { requests: [], comments: [] };
  }
};

const toDelivery = githubDeliveryFor(rules);

const delivery = (payload: unknown): TriggerDelivery => {
  const normalized = toDelivery(payload);
  if (normalized === undefined) {
    throw new Error(
      `the payload did not normalize: ${JSON.stringify(payload)}`,
    );
  }
  return normalized;
};

const deliver = (payload: unknown) =>
  Effect.gen(function* () {
    const service = yield* TriggerService;
    return yield* service.deliver(delivery(payload));
  });

const sessionCount = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const rows = yield* sql<{ count: number }>`
    SELECT count(*)::int AS count FROM sessions WHERE repo = ${REPO}
  `;
  return rows[0]?.count ?? 0;
});

const firstMessage = (entries: ReadonlyArray<{ kind: string; text: string }>) =>
  entries.find((entry) => entry.kind === "user")?.text;

const issue = (number: number) => `${REPO}#${number}`;

const run = Effect.gen(function* () {
  const sessions = yield* SessionService;
  yield* sessions.registerRepo({ repo: REPO, defaultBaseRef: "main" });

  // 1 + 2: the opening delivery starts one real session carrying the issue's own words — in the
  // payload's repo, not the rule's.
  const created = yield* deliver(githubPayload({}));
  observed.sessionId = created.sessionId ?? null;
  assert(
    "an opened issue carrying the label starts a session and names it",
    created.status === "processed" && created.sessionId !== undefined,
    `status=${created.status} session=${String(created.sessionId)} reason=${String(created.reason)}`,
  );
  if (created.sessionId === undefined) {
    return yield* Effect.die(new Error("no session: the rest proves nothing"));
  }
  const sessionId = created.sessionId;
  const read = yield* sessions.get(sessionId);
  observed.sessionRepo = read.session.repo ?? null;
  assert(
    "the session's repo is the payload's, not the rule's decoy",
    read.session.repo === REPO,
    `repo=${String(read.session.repo)} decoy=${DECOY_REPO}`,
  );
  assert(
    "the session is the issue's own title",
    read.session.title === "The widget wobbles",
    `title=${JSON.stringify(read.session.title)}`,
  );
  assert(
    "and its first message is the rule's rendered prompt",
    firstMessage(read.entries) ===
      "Work on The widget wobbles:\nIt wobbles when it spins.",
    `first=${JSON.stringify(firstMessage(read.entries))}`,
  );

  // 3: one comment, on the payload's issue, naming the session, as GitHub's comment API takes it.
  const afterCreate = readLedger();
  const comment = afterCreate.comments.find(
    (entry) => entry.issue === issue(7),
  );
  assert(
    "the write-back posted exactly one comment on the payload's issue",
    afterCreate.comments.length === 1 && comment !== undefined,
    `comments=${afterCreate.comments.length} issues=${afterCreate.comments.map((entry) => entry.issue).join(",")}`,
  );
  assert(
    "the comment names the session and links to it",
    typeof comment?.body === "string" &&
      comment.body.includes(sessionId) &&
      comment.body.includes(`http://localhost:3000/sessions/${sessionId}`),
    String(comment?.body),
  );
  const createPosts = afterCreate.requests.filter(
    (request) => request.method === "POST",
  );
  assert(
    "the write-back read the issue, then posted once, to GitHub's own path, as an App token",
    afterCreate.requests[0]?.method === "GET" &&
      createPosts.length === 1 &&
      createPosts[0]?.path === `/repos/${REPO}/issues/7/comments` &&
      createPosts[0]?.authorization === "Bearer ghs-drive-token" &&
      createPosts[0]?.apiVersion === "2022-11-28",
    `methods=${afterCreate.requests.map((request) => request.method).join(",")} path=${String(
      createPosts[0]?.path,
    )} auth=${String(createPosts[0]?.authorization).slice(0, 16)}…`,
  );

  // 4: GitHub's `labeled` twin for the same issue is the same intent, not a second delivery.
  const twin = yield* deliver(githubPayload({ action: "labeled" }));
  assert(
    "the labeled twin of the opened delivery is a replay, not a second session",
    twin.replayed === true && (yield* sessionCount) === 1,
    `replayed=${String(twin.replayed)} sessions=${yield* sessionCount}`,
  );

  // 5: re-running the opened delivery is a replay too, and comments nothing more.
  const replayed = yield* deliver(githubPayload({}));
  assert(
    "the same payload again is a replay: one session, still one comment",
    replayed.replayed === true &&
      (yield* sessionCount) === 1 &&
      readLedger().comments.length === 1,
    `replayed=${String(replayed.replayed)} sessions=${yield* sessionCount} comments=${readLedger().comments.length}`,
  );

  // 5b: a second label the same rule claims is still the same intent — GitHub sends one `labeled`
  // delivery per label, so keying on the label set would open a second session for one issue
  // (reviewer P1 on this diff).
  const secondLabel = yield* deliver(
    githubPayload({ action: "labeled", number: 7, labels: ["factory", "bug"] }),
  );
  assert(
    "a second label the same rule claims is a replay, not a second session",
    secondLabel.replayed === true &&
      (yield* sessionCount) === 1 &&
      readLedger().comments.length === 1,
    `replayed=${String(secondLabel.replayed)} sessions=${yield* sessionCount}`,
  );

  // 5c: a second rule's label does not open a second session on an issue that already has one.
  const deployFirst = yield* deliver(
    githubPayload({ action: "labeled", number: 10, labels: ["deploy"] }),
  );
  const factoryAfter = yield* deliver(
    githubPayload({
      action: "labeled",
      number: 10,
      labels: ["deploy", "factory"],
    }),
  );
  assert(
    "two rules cannot start two sessions on one issue, whichever label arrives first",
    deployFirst.status === "processed" &&
      factoryAfter.replayed === true &&
      (yield* sessionCount) === 2,
    `first=${deployFirst.status} second replayed=${String(factoryAfter.replayed)} sessions=${yield* sessionCount}`,
  );

  // 6: removing the label starts nothing, and the reason names GitHub's own action.
  const unlabeled = yield* deliver(
    githubPayload({ action: "unlabeled", number: 7, labels: [] }),
  );
  observed.skipped.push({
    why: "unlabeled",
    status: unlabeled.status,
    reason: unlabeled.reason,
  });
  assert(
    "an unlabeled delivery is skipped, naming GitHub's own action",
    unlabeled.status === "skipped" &&
      (unlabeled.reason ?? "").includes('"unlabeled"'),
    `status=${unlabeled.status} reason=${String(unlabeled.reason)}`,
  );

  // 7: an issue opened with no label starts nothing — and the skip is recorded against that label
  // set, not against the issue, so the label arriving later is work.
  const bare = yield* deliver(
    githubPayload({ number: 8, labels: [], action: "opened" }),
  );
  observed.skipped.push({
    why: "unmappable",
    status: bare.status,
    reason: bare.reason,
  });
  assert(
    "an issue opened with no mapped label is skipped, saying it carries none",
    bare.status === "skipped" &&
      (bare.reason ?? "").includes("the event carries no labels"),
    `status=${bare.status} reason=${String(bare.reason)}`,
  );

  // 8: labelling that same issue afterwards does start work, on the same issue.
  const later = yield* deliver(
    githubPayload({ number: 8, action: "labeled", labels: ["factory"] }),
  );
  assert(
    "labelling an issue after it was opened starts a session on the same issue",
    later.status === "processed" &&
      later.sessionId !== undefined &&
      (yield* sessionCount) === 3,
    `status=${later.status} sessions=${yield* sessionCount} reason=${String(later.reason)}`,
  );

  // 9: a pull request is an issue to GitHub, and not one to this adapter.
  assert(
    "a pull-request payload does not normalize to a delivery",
    githubDelivery(githubPayload({ pullRequest: true }), rules) === undefined,
    "githubDelivery(pull request) === undefined",
  );

  // 10: the comment landed and its acknowledgement did not (the fake records it, then answers 500).
  // The seam gives the claim back, so the sender's retry runs the delivery again — and must find
  // its own comment rather than posting a second one.
  const lostPayload = githubPayload({ number: 9 });
  const lost = yield* Effect.exit(deliver(lostPayload));
  assert(
    "a delivery whose comment landed but whose answer was lost fails",
    lost._tag === "Failure",
    lost._tag === "Failure"
      ? String(lost.cause).includes("write-back")
        ? "write-back error"
        : String(lost.cause).slice(0, 120)
      : "the delivery answered success",
  );
  const retried = yield* deliver(lostPayload);
  const retryLedger = readLedger();
  const forIssue = (method: string) =>
    retryLedger.requests.filter(
      (request) =>
        request.method === method &&
        request.path.endsWith("/issues/9/comments"),
    ).length;
  assert(
    "the retry reads the issue's comments before it posts",
    forIssue("GET") >= 1 && forIssue("POST") === 1,
    `gets=${forIssue("GET")} posts=${forIssue("POST")}`,
  );
  assert(
    "and posts no second comment: the issue still carries exactly one",
    retryLedger.comments.filter((entry) => entry.issue === issue(9)).length ===
      1,
    `comments=${retryLedger.comments.filter((entry) => entry.issue === issue(9)).length}`,
  );
  assert(
    "the retry is processed and reuses the session the failed attempt opened",
    retried.status === "processed" && (yield* sessionCount) === 4,
    `status=${retried.status} sessions=${yield* sessionCount}`,
  );

  observed.comments = readLedger().comments;
  observed.ledger = readLedger().requests;
});

const exit = await runtime.runPromiseExit(run);
if (exit._tag === "Failure") {
  console.error(exit.cause);
}
await runtime.dispose();

const checks = Object.values(observed.checks);
const failed = checks.filter((check) => !check.passed).length;
await writeFile(
  path.join(EVIDENCE_DIR, "github-issues-observed.json"),
  `${JSON.stringify({ ...observed, failed }, null, 2)}\n`,
);
console.log(
  `\ngithub-issues: ${checks.length - failed}/${checks.length} checks passed — evidence in ${EVIDENCE_DIR}`,
);
process.exit(failed === 0 && exit._tag === "Success" ? 0 : 1);
