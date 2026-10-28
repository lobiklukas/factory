// The GitHub issues adapter over HTTP (LOB-190, served by LOB-259): a signed `issues` or
// `issue_comment` delivery posted at a running API's `POST /webhooks/github`, one session and one
// issue comment out.
//
//   MODE=configured bun github-issues.ts     # the API booted with the secret and the comment API at the fake
//   MODE=unconfigured bun github-issues.ts   # the same API with `GITHUB_WEBHOOK_SECRET` unset
//
// (`./github-issues.sh` boots the API and the fake and runs both.) What runs is the real thing: the
// route, GitHub's signature check (`X-Hub-Signature-256`), `TriggerService` on the API's Postgres, the
// real `SessionService`, and the real `GitHubWriteBack` over HTTP to `./github-issues-fake.ts` on
// loopback. Only GitHub is fake, and this driver is its sender.
//
// The checks, `configured`:
//
//   1. a signed `opened` issue carrying the label is processed and names the session, whose repo is
//      the payload's — the rules name a decoy repo on purpose, so a mapping that read `rule.repo`
//      would open the wrong checkout
//   2. the session is the issue's own words: title, and the rendered rule as its first message
//   3. the write-back posted exactly one comment, on the payload's issue, naming and linking the
//      session, after reading the issue, to GitHub's own path with the token and API version
//   4. GitHub's `labeled` twin delivery for the same issue is a replay: one session, one comment
//   5. a redelivery of the `opened` delivery is a replay too; a second label does not open another
//   6. two rules cannot start two sessions on one issue, whichever label arrives first
//   7. `unlabeled` and `edited` deliveries answer 202 and record nothing
//   8. an issue opened with no label is skipped, and labelling it afterwards does start work
//   9. a pull-request payload on the issues event is 400
//  10. an `@factory` comment on an issue with no label opens one session and one comment; a second
//      mention on the issue is a replay; a bot's mention, a stranger's (author_association NONE) and a comment with none are 202
//  11. a missing and a wrong signature are 401, and record no delivery
//  12. a comment that landed whose acknowledgement was lost fails the delivery (500 write-back); the
//      retry is processed, reuses the session, and posts no second comment
//  13. a stored route whose trust gate admits GitHub users with write (S-trigger-trust-gating): an
//      issue labelled by a user whose role on the repo is read opens nothing, and the reason names
//      them and their role; one labelled by a writer opens its session. Both roles were asked of
//      the fake's collaborator-permission endpoint, with the token
//
// `unconfigured`: a delivery signed with the empty key — what an unset secret degrades to — is 503
// naming `GITHUB_WEBHOOK_SECRET`, and opens nothing.
//
// Env: API_URL, DATABASE_URL, GITHUB_ISSUES_FAKE_LEDGER, GITHUB_WEBHOOK_SECRET, GITHUB_TRIGGER_REPO
// (the run's own repo), GITHUB_RUN_STAMP, EVIDENCE_DIR.
import { createHmac } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { TriggerRoutesRpc } from "@repo/domain/Rpc";
import { RepoSlug } from "@repo/domain/Session";
import { Effect } from "effect";
import { RpcClient } from "effect/rpc";
import {
  deliveryRows,
  field,
  postRaw,
  readLedger,
  sessionClient,
  sessionIdOf,
  sessionsOf,
  type Answer,
} from "./adapter-http.ts";
import { makeChecker, protocolFor } from "./harness.ts";
import type { CheckRecord } from "./harness.ts";

const MODE = process.env["MODE"] ?? "configured";
const API_URL = process.env["API_URL"] ?? "http://127.0.0.1:9426";
const DATABASE_URL =
  process.env["DATABASE_URL"] ??
  "postgres://factory:factory@localhost:5442/factory";
const LEDGER =
  process.env["GITHUB_ISSUES_FAKE_LEDGER"] ??
  ".verify/run/github-issues/github-issues-ledger.json";
const SECRET = process.env["GITHUB_WEBHOOK_SECRET"] ?? "";
const RUN_STAMP = Number(process.env["GITHUB_RUN_STAMP"] ?? Date.now());
const REPO = RepoSlug.make(
  process.env["GITHUB_TRIGGER_REPO"] ?? `acme/verify-api-github-${RUN_STAMP}`,
);
const EVIDENCE_DIR = process.env["EVIDENCE_DIR"] ?? ".verify/evidence/lob-259";

await mkdir(EVIDENCE_DIR, { recursive: true });

const observed: {
  mode: string;
  apiUrl: string;
  repo: string;
  deliveries: Array<{ what: string; status: number; body: unknown }>;
  comments: unknown;
  checks: Record<string, CheckRecord>;
} = {
  mode: MODE,
  apiUrl: API_URL,
  repo: REPO,
  deliveries: [],
  comments: null,
  checks: {},
};
const assert = makeChecker(observed);

type Ledger = {
  readonly requests: ReadonlyArray<{
    readonly method: string;
    readonly path: string;
    readonly authorization: string | undefined;
    readonly apiVersion: string | undefined;
  }>;
  readonly comments: ReadonlyArray<{
    readonly id: number;
    readonly issue: string;
    readonly body: unknown;
  }>;
};
const ledger = (): Ledger => readLedger(LEDGER, { requests: [], comments: [] });

/** GitHub's `X-Hub-Signature-256`: `sha256=` and the body's hex HMAC under the webhook's secret. */
const sign = (raw: string, secret: string = SECRET): string =>
  `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;

const post = async (
  what: string,
  event: "issues" | "issue_comment",
  body: unknown,
  signature: ((raw: string) => string | null) | null = sign,
): Promise<Answer> => {
  const raw = JSON.stringify(body);
  const signed = signature?.(raw) ?? null;
  const answer = await postRaw(`${API_URL}/webhooks/github`, raw, {
    "x-github-event": event,
    "x-github-delivery": `drive-${RUN_STAMP}-${observed.deliveries.length}`,
    ...(signed === null ? {} : { "x-hub-signature-256": signed }),
  });
  observed.deliveries.push({ what, status: answer.status, body: answer.body });
  return answer;
};

const repository = {
  id: 1,
  name: "verify-api-github",
  full_name: REPO,
  owner: { login: "acme" },
};

/** GitHub's `issues` webhook payload, `opened` unless told otherwise. */
const issuePayload = (over: {
  readonly action?: string;
  readonly number?: number;
  readonly labels?: ReadonlyArray<string>;
  readonly pullRequest?: boolean;
  /** Who opened or labelled it (GitHub's `sender`); absent leaves it out, as the older checks do. */
  readonly sender?: string;
}): Record<string, unknown> => ({
  action: over.action ?? "opened",
  ...(over.sender === undefined
    ? {}
    : {
        sender: {
          login: over.sender,
          id: 9_000 + (over.number ?? 7),
          type: "User",
        },
      }),
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
  repository,
});

/** GitHub's `issue_comment` webhook payload. */
const commentPayload = (over: {
  readonly number: number;
  readonly text: string;
  readonly userType?: string;
  readonly association?: string;
}): Record<string, unknown> => ({
  action: "created",
  issue: {
    number: over.number,
    title: "The widget wobbles",
    body: "It wobbles when it spins.",
    labels: [],
  },
  comment: {
    body: over.text,
    user: { login: "alice", type: over.userType ?? "User" },
    author_association: over.association ?? "MEMBER",
  },
  sender: { login: "alice", type: over.userType ?? "User" },
  repository,
});

const issue = (number: number) => `${REPO}#${number}`;
const commentsOn = (number: number) =>
  ledger().comments.filter((entry) => entry.issue === issue(number));

const firstMessage = (entries: ReadonlyArray<{ kind: string; text: string }>) =>
  entries.find((entry) => entry.kind === "user")?.text;

const program = Effect.gen(function* () {
  const client = yield* sessionClient;
  const sessionCount = sessionsOf(client, REPO);

  if (MODE === "unconfigured") {
    const before = yield* sessionCount;
    const refused = yield* Effect.promise(() =>
      post("unset secret", "issues", issuePayload({ number: 90 }), (raw) =>
        sign(raw, ""),
      ),
    );
    assert(
      "with GITHUB_WEBHOOK_SECRET unset an issue delivery is 503 not-configured, naming the variable",
      refused.status === 503 &&
        field(refused, "code") === "not-configured" &&
        JSON.stringify(refused.body).includes("GITHUB_WEBHOOK_SECRET"),
      `status=${refused.status} body=${JSON.stringify(refused.body)}`,
    );
    const mention = yield* Effect.promise(() =>
      post(
        "unset secret, mention",
        "issue_comment",
        commentPayload({ number: 91, text: "@factory go" }),
        (raw) => sign(raw, ""),
      ),
    );
    const rows = yield* Effect.promise(() =>
      deliveryRows(DATABASE_URL, [
        `github:${issue(90)}:mapped`,
        `github:${issue(91)}:mapped`,
      ]),
    );
    assert(
      "and so is a mention, and neither records a delivery or opens a session",
      mention.status === 503 &&
        rows.length === 0 &&
        (yield* sessionCount) === before,
      `mention=${mention.status} rows=${rows.length} sessions=${before}→${yield* sessionCount}`,
    );
    return;
  }

  yield* client.registerRepo({ repo: REPO, defaultBaseRef: "main" });

  // 1 + 2: the signed opening delivery starts one real session carrying the issue's own words — in
  // the payload's repo, which the rule's decoy is not.
  const created = yield* Effect.promise(() =>
    post("opened", "issues", issuePayload({})),
  );
  const sessionId = sessionIdOf(created);
  assert(
    "a signed opened issue carrying the label is processed and names the session",
    created.status === 200 &&
      field(created, "status") === "processed" &&
      field(created, "replayed") === false &&
      sessionId !== undefined,
    `status=${created.status} body=${JSON.stringify(created.body)}`,
  );
  if (sessionId === undefined) {
    return yield* Effect.die(new Error("no session: the rest proves nothing"));
  }
  const read = yield* client.getSession({ sessionId });
  assert(
    "the session's repo is the payload's, not the rule's decoy",
    read.session.repo === REPO,
    `repo=${String(read.session.repo)} decoy=${REPO}-decoy`,
  );
  assert(
    "the session is the issue's own title, and its first message the rule's rendered prompt",
    read.session.title === "The widget wobbles" &&
      firstMessage(read.entries) ===
        "Work on The widget wobbles:\nIt wobbles when it spins.",
    `title=${JSON.stringify(read.session.title)} first=${JSON.stringify(firstMessage(read.entries))}`,
  );

  // 3: one comment, on the payload's issue, naming the session, as GitHub's comment API takes it.
  const afterCreate = ledger();
  const comment = commentsOn(7)[0];
  assert(
    "the write-back posted exactly one comment on the payload's issue, naming and linking the session",
    afterCreate.comments.length === 1 &&
      typeof comment?.body === "string" &&
      comment.body.includes(sessionId) &&
      comment.body.includes(`http://localhost:3000/sessions/${sessionId}`),
    `comments=${afterCreate.comments.length} body=${String(comment?.body)}`,
  );
  const posts = afterCreate.requests.filter(
    (request) => request.method === "POST",
  );
  assert(
    "the write-back read the issue, then posted once, to GitHub's own path, with the token and API version",
    afterCreate.requests[0]?.method === "GET" &&
      posts.length === 1 &&
      posts[0]?.path === `/repos/${REPO}/issues/7/comments` &&
      posts[0]?.authorization === "Bearer ghs-drive-token" &&
      posts[0]?.apiVersion === "2022-11-28",
    `methods=${afterCreate.requests.map((request) => request.method).join(",")} path=${String(posts[0]?.path)} auth=${String(posts[0]?.authorization).slice(0, 16)}…`,
  );

  // 4 + 5: GitHub's `labeled` twin, a redelivery and a second label are the same intent.
  const twin = yield* Effect.promise(() =>
    post("labeled twin", "issues", issuePayload({ action: "labeled" })),
  );
  const redelivered = yield* Effect.promise(() =>
    post("redelivered", "issues", issuePayload({})),
  );
  const secondLabel = yield* Effect.promise(() =>
    post(
      "second label",
      "issues",
      issuePayload({ action: "labeled", labels: ["factory", "bug"] }),
    ),
  );
  assert(
    "the labeled twin, a redelivery and a second label are replays: one session, one comment",
    [twin, redelivered, secondLabel].every(
      (answer) => answer.status === 200 && field(answer, "replayed") === true,
    ) &&
      (yield* sessionCount) === 1 &&
      ledger().comments.length === 1,
    `replayed=${[twin, redelivered, secondLabel].map((answer) => String(field(answer, "replayed"))).join(",")} sessions=${yield* sessionCount} comments=${ledger().comments.length}`,
  );

  // 6: a second rule's label does not open a second session on an issue that already has one.
  const deployFirst = yield* Effect.promise(() =>
    post(
      "deploy first",
      "issues",
      issuePayload({ action: "labeled", number: 10, labels: ["deploy"] }),
    ),
  );
  const factoryAfter = yield* Effect.promise(() =>
    post(
      "factory after",
      "issues",
      issuePayload({
        action: "labeled",
        number: 10,
        labels: ["deploy", "factory"],
      }),
    ),
  );
  assert(
    "two rules cannot start two sessions on one issue, whichever label arrives first",
    field(deployFirst, "status") === "processed" &&
      field(factoryAfter, "replayed") === true &&
      (yield* sessionCount) === 2,
    `first=${String(field(deployFirst, "status"))} second replayed=${String(field(factoryAfter, "replayed"))} sessions=${yield* sessionCount}`,
  );

  // 7: removing the label, or editing the issue, asks for nothing and records nothing.
  const unlabeled = yield* Effect.promise(() =>
    post(
      "unlabeled",
      "issues",
      issuePayload({ action: "unlabeled", number: 11, labels: [] }),
    ),
  );
  const edited = yield* Effect.promise(() =>
    post("edited", "issues", issuePayload({ action: "edited", number: 11 })),
  );
  const ignoredRows = yield* Effect.promise(() =>
    deliveryRows(DATABASE_URL, [
      `github:${issue(11)}:mapped`,
      `github:${issue(11)}:unmapped:no-labels`,
    ]),
  );
  assert(
    "an unlabeled and an edited delivery are 202 ignored, and record no delivery",
    unlabeled.status === 202 &&
      edited.status === 202 &&
      ignoredRows.length === 0 &&
      (yield* sessionCount) === 2,
    `status=${unlabeled.status}/${edited.status} rows=${ignoredRows.length}`,
  );

  // 8: an issue opened with no label starts nothing — and the label arriving later is work.
  const bare = yield* Effect.promise(() =>
    post("bare", "issues", issuePayload({ number: 8, labels: [] })),
  );
  const later = yield* Effect.promise(() =>
    post(
      "labelled later",
      "issues",
      issuePayload({ number: 8, action: "labeled", labels: ["factory"] }),
    ),
  );
  assert(
    "an issue opened with no label is skipped, and labelling it afterwards starts a session",
    field(bare, "status") === "skipped" &&
      String(field(bare, "reason")).includes("the event carries no labels") &&
      field(later, "status") === "processed" &&
      (yield* sessionCount) === 3,
    `bare=${String(field(bare, "status"))} later=${String(field(later, "status"))} sessions=${yield* sessionCount}`,
  );

  // 9: a pull request is an issue to GitHub, and not one to this adapter.
  const pull = yield* Effect.promise(() =>
    post("pull request", "issues", issuePayload({ pullRequest: true })),
  );
  assert(
    "a pull-request payload on the issues event is 400 bad-payload",
    pull.status === 400 && field(pull, "code") === "bad-payload",
    `status=${pull.status} body=${JSON.stringify(pull.body)}`,
  );

  // 10: an @factory comment is the same ask, on an issue that carries no label.
  const mention = yield* Effect.promise(() =>
    post(
      "mention",
      "issue_comment",
      commentPayload({ number: 12, text: "@factory please take this" }),
    ),
  );
  const mentionId = sessionIdOf(mention);
  const again = yield* Effect.promise(() =>
    post(
      "mention again",
      "issue_comment",
      commentPayload({ number: 12, text: "@factory ping" }),
    ),
  );
  const bot = yield* Effect.promise(() =>
    post(
      "bot mention",
      "issue_comment",
      commentPayload({ number: 13, text: "@factory go", userType: "Bot" }),
    ),
  );
  const stranger = yield* Effect.promise(() =>
    post(
      "stranger mention",
      "issue_comment",
      commentPayload({
        number: 13,
        text: "@factory go",
        association: "NONE",
      }),
    ),
  );
  const chatter = yield* Effect.promise(() =>
    post(
      "no mention",
      "issue_comment",
      commentPayload({ number: 13, text: "looks like a wobble" }),
    ),
  );
  assert(
    "an @factory comment opens one session and one comment; a second mention is a replay; a bot's mention, a stranger's (author_association NONE) and a comment with none are 202",
    mention.status === 200 &&
      field(mention, "status") === "processed" &&
      mentionId !== undefined &&
      commentsOn(12).length === 1 &&
      field(again, "replayed") === true &&
      bot.status === 202 &&
      stranger.status === 202 &&
      chatter.status === 202 &&
      commentsOn(13).length === 0 &&
      (yield* sessionCount) === 4,
    `mention=${String(field(mention, "status"))} comments=${commentsOn(12).length} again=${String(field(again, "replayed"))} bot=${bot.status} stranger=${stranger.status} chatter=${chatter.status} sessions=${yield* sessionCount}`,
  );
  if (mentionId !== undefined) {
    const mentioned = yield* client.getSession({ sessionId: mentionId });
    assert(
      "and that session's prompt carries the issue and the comment that asked",
      (firstMessage(mentioned.entries) ?? "").includes(
        "@factory please take this",
      ) &&
        (firstMessage(mentioned.entries) ?? "").includes(
          "It wobbles when it spins.",
        ),
      `first=${JSON.stringify(firstMessage(mentioned.entries))}`,
    );
  }

  // 11: a delivery that does not authenticate is refused before anything is recorded.
  const refusedPayload = issuePayload({ number: 14 });
  const missing = yield* Effect.promise(() =>
    post("unsigned", "issues", refusedPayload, null),
  );
  const wrong = yield* Effect.promise(() =>
    post("wrong secret", "issues", refusedPayload, (raw) =>
      sign(raw, "another"),
    ),
  );
  const refusedRows = yield* Effect.promise(() =>
    deliveryRows(DATABASE_URL, [`github:${issue(14)}:mapped`]),
  );
  assert(
    "a missing and a wrong signature are 401, and record no delivery",
    missing.status === 401 &&
      wrong.status === 401 &&
      refusedRows.length === 0 &&
      (yield* sessionCount) === 4,
    `${missing.status}/${wrong.status} rows=${refusedRows.length}`,
  );

  // 12: the comment landed and its acknowledgement did not (the fake records it, then answers 500).
  // The seam gives the claim back, so the sender's retry runs the delivery again — and must find its
  // own comment rather than posting a second one.
  const lostPayload = issuePayload({ number: 9 });
  const lost = yield* Effect.promise(() =>
    post("lost ack", "issues", lostPayload),
  );
  assert(
    "a delivery whose comment landed but whose answer was lost is 500 write-back",
    lost.status === 500 && field(lost, "code") === "write-back",
    `status=${lost.status} body=${JSON.stringify(lost.body)}`,
  );
  const retried = yield* Effect.promise(() =>
    post("lost ack, retried", "issues", lostPayload),
  );
  const retryLedger = ledger();
  const forIssue = (method: string) =>
    retryLedger.requests.filter(
      (request) =>
        request.method === method &&
        request.path.endsWith("/issues/9/comments"),
    ).length;
  assert(
    "the retry is processed, reads the issue's comments, posts no second comment, and reuses the session",
    retried.status === 200 &&
      field(retried, "status") === "processed" &&
      forIssue("GET") >= 1 &&
      forIssue("POST") === 1 &&
      commentsOn(9).length === 1 &&
      (yield* sessionCount) === 5,
    `status=${retried.status} gets=${forIssue("GET")} posts=${forIssue("POST")} comments=${commentsOn(9).length} sessions=${yield* sessionCount}`,
  );

  // 13: the trust gate's GitHub role, asked of the forge (S-trigger-trust-gating).
  const routes = yield* RpcClient.make(TriggerRoutesRpc);
  const trustedLabel = `trusted-${RUN_STAMP}`;
  const trustRoute = yield* routes.addTriggerRoute({
    label: trustedLabel,
    repo: REPO,
    prompt: "Trusted {{title}}",
    trust: { githubPermission: "write" },
  });
  const beforeTrust = yield* sessionCount;
  const byReader = yield* Effect.promise(() =>
    post(
      "labelled by a reader",
      "issues",
      issuePayload({
        number: 20,
        labels: [trustedLabel],
        sender: "verify-reader",
      }),
    ),
  );
  const afterReader = yield* sessionCount;
  const byWriter = yield* Effect.promise(() =>
    post(
      "labelled by a writer",
      "issues",
      issuePayload({
        number: 21,
        labels: [trustedLabel],
        sender: "verify-writer",
      }),
    ),
  );
  const asked = ledger().requests.filter((request) =>
    request.path.endsWith("/permission"),
  );
  assert(
    "a GitHub issue labelled by a user with read opens nothing and the reason names them and their role; a writer's opens its session",
    byReader.status === 200 &&
      field(byReader, "status") === "skipped" &&
      field(byReader, "reason") ===
        `untrusted author verify-reader (9020): rule "${trustedLabel}" (route ${trustRoute.id}) admits only GitHub users with write or higher on the repo; their role on ${REPO} is read` &&
      afterReader === beforeTrust &&
      byWriter.status === 200 &&
      field(byWriter, "status") === "processed" &&
      (yield* sessionCount) === beforeTrust + 1 &&
      asked.map((request) => request.path).join(" ") ===
        `/repos/${REPO}/collaborators/verify-reader/permission /repos/${REPO}/collaborators/verify-writer/permission` &&
      asked.every(
        (request) => request.authorization === "Bearer ghs-drive-token",
      ),
    `reader=${JSON.stringify(byReader.body)} writer=${JSON.stringify(byWriter.body)} asked=${JSON.stringify(asked)}`,
  );
  yield* routes.removeTriggerRoute({ id: trustRoute.id });

  observed.comments = ledger().comments;
});

const exit = await Effect.runPromiseExit(
  program.pipe(Effect.provide(protocolFor(API_URL)), Effect.scoped),
);
if (exit._tag === "Failure") console.error(exit.cause);

const checks = Object.values(observed.checks);
const failed = checks.filter((check) => !check.passed).length;
await writeFile(
  path.join(EVIDENCE_DIR, `github-issues-${MODE}-observed.json`),
  `${JSON.stringify({ ...observed, failed }, null, 2)}\n`,
);
console.log(
  `\ngithub-issues (${MODE}): ${checks.length - failed}/${checks.length} checks passed — evidence in ${EVIDENCE_DIR}`,
);
process.exit(failed === 0 && exit._tag === "Success" ? 0 : 1);
