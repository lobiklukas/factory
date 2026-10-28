#!/usr/bin/env bun
// The probes `feedback.sh` cannot make from a terminal (C21): sign the deliveries GitHub would send
// about the card's PR, and read what the next run's log says it was told.
//
//   MODE=deliver  a stranger's review (ignored, 202), a `changes_requested` review of PR_URL from a
//                 collaborator, delivered twice (the redelivery must write nothing), then a failing `check_run` on the PR's head and its failing `check_suite`
//                 (one failure: the suite writes nothing more), and an unsigned review (refused, 401).
//                 Checks each answer, and that the card's thread holds exactly the two notes.
//   MODE=told     SESSION_ID's run settled, and its committed `task_thread` prompt section quotes the
//                 review's body verbatim, after the line naming the reviewer, and the failing check.
//
// GitHub sends no webhooks to a loopback API, so this script signs the bodies GitHub would send —
// shaped from GitHub's webhook docs — with the instance's GITHUB_WEBHOOK_SECRET, as `merge.ts` and
// `review.ts` do. What a person reads — the block, the thread, the attention row, the lifted block —
// is read back by `feedback.sh` through `factory board`.
//
// Env: API_URL, MODE, GITHUB_WEBHOOK_SECRET, PR_URL (the PR's page), HEAD (the PR's head commit),
// TASK_ID, SESSION_ID, REVIEW_BODY, DATABASE_URL (for `told`'s log read), EVIDENCE_DIR. Writes
// `feedback-<mode>.json` and exits non-zero when a check fails.
import { createHmac, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Effect, Scope } from "effect";
import { RpcClient } from "effect/rpc";
import { SqlClient } from "effect/sql/SqlClient";
import { RpcApi } from "@repo/domain/Rpc";
import type { SessionId } from "@repo/domain/Session";
import type { TaskId } from "@repo/domain/Task";
import { readPromptSections, THREAD_SECTION_KEY } from "@repo/harness";
import { DatabaseLive, PostgresStorage } from "@repo/storage-postgres";
import { makeChecker, protocolFor } from "../verify-api/harness.ts";
import type { CheckRecord } from "../verify-api/harness.ts";

const API_URL = process.env["API_URL"] ?? "http://localhost:9406";
const MODE = process.env["MODE"] ?? "";
const SECRET = process.env["GITHUB_WEBHOOK_SECRET"] ?? "";
const PR_URL = process.env["PR_URL"] ?? "";
const PR_NUMBER = Number(PR_URL.split("/").at(-1) ?? "0");
const REPO_PAGE = PR_URL.replace(/\/pull\/\d+$/, "");
const HEAD = process.env["HEAD"] ?? "";
const TASK = (process.env["TASK_ID"] ?? "") as TaskId;
const SESSION = (process.env["SESSION_ID"] ?? "") as SessionId;
const REVIEW_BODY = process.env["REVIEW_BODY"] ?? "";
const EVIDENCE_DIR =
  process.env["EVIDENCE_DIR"] ?? ".verify/evidence/latest/board";

const observed: {
  mode: string;
  deliveries: Record<string, unknown>;
  facts: Record<string, unknown>;
  checks: Record<string, CheckRecord>;
} = { mode: MODE, deliveries: {}, facts: {}, checks: {} };
const check = makeChecker(observed);

/** One signed delivery of `event` to the instance's GitHub route. */
const deliver = async (
  event: string,
  body: unknown,
  sign: (raw: string) => string = (raw) =>
    `sha256=${createHmac("sha256", SECRET).update(raw).digest("hex")}`,
) => {
  const raw = JSON.stringify(body);
  const response = await fetch(`${API_URL}/webhooks/github`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-github-delivery": randomUUID(),
      "x-hub-signature-256": sign(raw),
    },
    body: raw,
  });
  return {
    status: response.status,
    answer: (await response.json().catch(() => null)) as Record<
      string,
      unknown
    > | null,
  };
};

const REVIEW_ID = 2_100_000 + PR_NUMBER;

/** GitHub's `pull_request_review` submitted body for a review that requests changes. */
const review = {
  action: "submitted",
  review: {
    id: REVIEW_ID,
    user: { login: "verify-reviewer", type: "User" },
    // A reviewer with a standing on the repository: anyone else's review does not reach the card.
    author_association: "COLLABORATOR",
    body: REVIEW_BODY,
    state: "changes_requested",
    html_url: `${PR_URL}#pullrequestreview-${REVIEW_ID}`,
    commit_id: HEAD,
  },
  pull_request: {
    number: PR_NUMBER,
    html_url: PR_URL,
    state: "open",
    head: { sha: HEAD },
  },
  repository: { html_url: REPO_PAGE },
  sender: { login: "verify-reviewer", type: "User" },
};

const SUITE = 2_200_000 + PR_NUMBER;

/** GitHub's `check_run` completed body for a failing check on the PR's head. */
const checkRun = {
  action: "completed",
  check_run: {
    id: SUITE + 1,
    name: "gate",
    head_sha: HEAD,
    status: "completed",
    conclusion: "failure",
    html_url: `${REPO_PAGE}/runs/${SUITE + 1}`,
    output: { title: "1 test failed", summary: "built.test.ts: expected 1" },
    check_suite: { id: SUITE },
    pull_requests: [{ number: PR_NUMBER, head: { sha: HEAD } }],
  },
  repository: { html_url: REPO_PAGE },
};

/** The same failure's `check_suite` completed body. */
const checkSuite = {
  action: "completed",
  check_suite: {
    id: SUITE,
    head_sha: HEAD,
    conclusion: "failure",
    app: { name: "GitHub Actions" },
    pull_requests: [{ number: PR_NUMBER, head: { sha: HEAD } }],
  },
  repository: { html_url: REPO_PAGE },
};

const feedbackOf = (delivery: { answer: Record<string, unknown> | null }) =>
  JSON.stringify(delivery.answer?.["feedback"]);

const deliverAll = Effect.gen(function* () {
  const client = yield* RpcClient.make(RpcApi);
  const unsigned = yield* Effect.promise(() =>
    deliver("pull_request_review", review, () => "sha256=00"),
  );
  observed.deliveries["unsigned"] = unsigned;
  check(
    "an unsigned review is refused, 401",
    unsigned.status === 401,
    `status=${unsigned.status}`,
  );
  // A stranger's review (no standing on the repository) reaches nothing: on a public repository
  // anyone may review, and the review's words would be every later run's prompt.
  const stranger = yield* Effect.promise(() =>
    deliver("pull_request_review", {
      ...review,
      review: {
        ...review.review,
        id: REVIEW_ID + 1,
        user: { login: "verify-stranger", type: "User" },
        author_association: "NONE",
      },
    }),
  );
  observed.deliveries["stranger"] = stranger;
  check(
    "a review from someone with no standing on the repository is ignored, 202",
    stranger.status === 202,
    `status=${stranger.status}`,
  );
  const first = yield* Effect.promise(() =>
    deliver("pull_request_review", review),
  );
  const again = yield* Effect.promise(() =>
    deliver("pull_request_review", review),
  );
  observed.deliveries["review"] = first;
  observed.deliveries["reviewAgain"] = again;
  check(
    "the signed changes_requested review lands one note and blocks the card",
    first.status === 200 &&
      first.answer?.["event"] === "changes_requested" &&
      feedbackOf(first) ===
        JSON.stringify({ recorded: 1, blocked: 1, failed: 0 }),
    `status=${first.status} feedback=${feedbackOf(first)}`,
  );
  check(
    "its redelivery writes nothing",
    again.status === 200 &&
      feedbackOf(again) ===
        JSON.stringify({ recorded: 0, blocked: 0, failed: 0 }),
    `status=${again.status} feedback=${feedbackOf(again)}`,
  );
  const failed = yield* Effect.promise(() => deliver("check_run", checkRun));
  const suite = yield* Effect.promise(() => deliver("check_suite", checkSuite));
  observed.deliveries["checkRun"] = failed;
  observed.deliveries["checkSuite"] = suite;
  check(
    "the failing check run on the PR's head lands one note and blocks nothing",
    failed.status === 200 &&
      failed.answer?.["event"] === "check_failed" &&
      feedbackOf(failed) ===
        JSON.stringify({ recorded: 1, blocked: 0, failed: 0 }),
    `status=${failed.status} feedback=${feedbackOf(failed)}`,
  );
  check(
    "its suite's failure is the same failure: nothing more lands",
    suite.status === 200 &&
      feedbackOf(suite) ===
        JSON.stringify({ recorded: 0, blocked: 0, failed: 0 }),
    `status=${suite.status} feedback=${feedbackOf(suite)}`,
  );
  const thread = yield* client.listTaskComments({ taskId: TASK });
  observed.facts["thread"] = thread;
  check(
    "the card's thread holds the review, verbatim, then the failing check",
    thread.length === 2 &&
      thread[0]?.actor === "github:verify-reviewer" &&
      thread[0].body.includes(`\n${REVIEW_BODY}`) &&
      thread[1]?.actor === "github:checks" &&
      thread[1].body.startsWith(`Check "gate" failed (failure)`),
    `comments=${thread.length} actors=${thread.map((c) => c.actor).join(",")}`,
  );
});

/** Poll `probe` every 100 ms for up to `seconds`, returning the first value it accepts. */
const poll = <A, E>(
  probe: Effect.Effect<A, E>,
  accept: (value: A) => boolean,
  seconds: number,
): Effect.Effect<{ value: A; met: boolean }, E> =>
  Effect.gen(function* () {
    const started = Date.now();
    let value = yield* probe;
    while (!accept(value) && Date.now() - started < seconds * 1000) {
      yield* Effect.sleep(100);
      value = yield* probe;
    }
    return { value, met: accept(value) };
  });

/** The prompt sections the run's own log leaves in effect: what the model was sent. */
const promptOf = (sessionId: SessionId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    return yield* Effect.acquireUseRelease(
      Effect.promise(() => PostgresStorage.reader(sql, sessionId)),
      (storage) => readPromptSections(storage),
      (storage) => Effect.promise(() => storage.dispose()),
    );
  }).pipe(Effect.provide(DatabaseLive));

const told = Effect.gen(function* () {
  const client = yield* RpcClient.make(RpcApi);
  const settled = yield* poll(
    client.getSession({ sessionId: SESSION }),
    (snapshot) =>
      !snapshot.live.busy &&
      snapshot.entries.some(
        (entry) => entry.kind === "assistant" && entry.text !== "",
      ),
    60,
  );
  check(
    "the next run settled with a reply",
    settled.met,
    `busy=${settled.value.live.busy}`,
  );
  const sections = yield* promptOf(SESSION);
  const thread = sections[THREAD_SECTION_KEY] ?? "";
  observed.facts["recordedThreadSection"] = thread;
  const header = `Changes requested on pull request #${PR_NUMBER} by @verify-reviewer`;
  check(
    "the next run's recorded prompt quotes the review verbatim, after the line naming the reviewer",
    thread.includes(`\n${REVIEW_BODY}`) &&
      thread.indexOf(header) > -1 &&
      thread.indexOf(header) < thread.indexOf(REVIEW_BODY),
    `task_thread section ${thread.length} chars`,
  );
  check(
    "and the failing check",
    thread.includes(`Check "gate" failed (failure)`),
    "check note in the section",
  );
});

const run = <E>(
  phase: Effect.Effect<void, E, RpcClient.Protocol | Scope.Scope>,
): Promise<void> =>
  Effect.runPromise(
    Effect.scoped(phase).pipe(
      Effect.provide(protocolFor(API_URL)),
      Effect.catch((error) =>
        Effect.sync(() => {
          check(`the ${MODE} probe ran`, false, String(error));
        }),
      ),
    ),
  );

if (MODE === "deliver") await run(deliverAll);
else if (MODE === "told") await run(told);
else {
  console.error("feedback.ts: MODE must be deliver or told");
  process.exit(2);
}

await mkdir(EVIDENCE_DIR, { recursive: true });
await writeFile(
  path.join(EVIDENCE_DIR, `feedback-${MODE}.json`),
  `${JSON.stringify(observed, null, 2)}\n`,
);
process.exit(Object.values(observed.checks).every((c) => c.passed) ? 0 : 1);
