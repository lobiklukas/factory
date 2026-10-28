#!/usr/bin/env bun
// The reviewer's verdict, the way a deployment gets one (LOB-241): GitHub tells the API about the
// card's PR, the review trigger opens a faux reviewer run on the card at the PR's head (LOB-36), and
// the run commits its verdict to its log's `factory.review` — which is what `review → done` checks.
//
//   MODE=review ACTION=opened|synchronize HEAD=<sha> …   deliver one signed `pull_request` on
//                                                        `POST /webhooks/github`, wait for the
//                                                        reviewer run it starts to settle, and check
//                                                        the verdict its log records on that head.
//                                                        Prints `reviewer <session id>`.
//
// What `requires.sh` and `drive.sh` cannot do from a terminal: sign a GitHub delivery (the secret is
// the instance's own, `GITHUB_WEBHOOK_SECRET`, set by the script that started it), and read the run's
// log. Everything a person reads — the refusal naming `review_verdict`, the move that goes through —
// is read back through `factory board` by the calling script.
//
// Env: API_URL, GITHUB_WEBHOOK_SECRET, REPO (the PR's repository slug), PR_URL (its page, which the
// build run's PR step recorded), PR_NUMBER, ACTION, HEAD, HEAD_REF, BASE_SHA, EXPECT (`pass`,
// `fail`, or `replay`: a head already reviewed, whose run the delivery replays and does not wait
// for), LABEL, EVIDENCE_DIR, DATABASE_URL. Exits non-zero when a check fails.
import { createHmac, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Effect, Scope } from "effect";
import { RpcClient } from "effect/rpc";
import { SqlClient } from "effect/sql/SqlClient";
import { RpcApi } from "@repo/domain/Rpc";
import type { SessionId } from "@repo/domain/Session";
import { readRecordedReview } from "@repo/harness";
import { DatabaseLive, PostgresStorage } from "@repo/storage-postgres";
import { makeChecker, protocolFor, waitUntil } from "../verify-api/harness.ts";
import type { CheckRecord } from "../verify-api/harness.ts";

const API_URL = process.env["API_URL"] ?? "http://localhost:9400";
const MODE = process.env["MODE"] ?? "";
const SECRET = process.env["GITHUB_WEBHOOK_SECRET"] ?? "";
const REPO = process.env["REPO"] ?? "";
const PR_URL = process.env["PR_URL"] ?? "";
const PR_NUMBER = Number(process.env["PR_NUMBER"] ?? "0");
const ACTION = process.env["ACTION"] ?? "opened";
const HEAD = process.env["HEAD"] ?? "";
const HEAD_REF = process.env["HEAD_REF"] ?? "";
const BASE_SHA = process.env["BASE_SHA"] ?? "";
const EXPECT = process.env["EXPECT"] ?? "pass";
const LABEL = process.env["LABEL"] ?? "review";
const EVIDENCE_DIR =
  process.env["EVIDENCE_DIR"] ?? ".verify/evidence/latest/board";

const observed: {
  label: string;
  delivery: unknown;
  reviewer: string;
  recorded: unknown;
  checks: Record<string, CheckRecord>;
} = { label: LABEL, delivery: null, reviewer: "", recorded: null, checks: {} };
const check = makeChecker(observed);

/** GitHub's `pull_request` body, shaped from its webhook docs: the fields the review trigger reads. */
const payload = {
  action: ACTION,
  number: PR_NUMBER,
  pull_request: {
    number: PR_NUMBER,
    html_url: PR_URL,
    title: `verify-board ${LABEL}`,
    state: "open",
    draft: false,
    merged: false,
    base: { ref: "main", sha: BASE_SHA },
    head: { ref: HEAD_REF, sha: HEAD, repo: { full_name: REPO } },
  },
  repository: { full_name: REPO, default_branch: "main" },
  sender: { login: "verify-board", type: "User" },
};

const deliver = async () => {
  const raw = JSON.stringify(payload);
  const response = await fetch(`${API_URL}/webhooks/github`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": "pull_request",
      "x-github-delivery": randomUUID(),
      "x-hub-signature-256": `sha256=${createHmac("sha256", SECRET).update(raw).digest("hex")}`,
    },
    body: raw,
  });
  const answer = (await response.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  return { status: response.status, answer };
};

/** The review its log records, read out of Postgres rather than off the API. */
const recordedReview = (sessionId: SessionId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    return yield* Effect.acquireUseRelease(
      Effect.promise(() => PostgresStorage.reader(sql, sessionId)),
      readRecordedReview,
      (storage) => Effect.promise(() => storage.dispose()),
    );
  }).pipe(Effect.provide(DatabaseLive));

const review = Effect.gen(function* () {
  const client = yield* RpcClient.make(RpcApi);
  const delivered = yield* Effect.promise(deliver);
  observed.delivery = delivered;
  const answered = (delivered.answer?.["review"] ?? {}) as Record<
    string,
    unknown
  >;
  const sessionId = answered["sessionId"] as SessionId | undefined;
  if (EXPECT === "replay") {
    // A push back to a head already reviewed: the trigger replays that head's run and opens none,
    // and records the head as the PR's again (`review_heads`) — the head the gate then judges.
    check(
      `the signed ${ACTION} back to a head already reviewed replays its run`,
      delivered.status === 200 &&
        answered["status"] === "processed" &&
        answered["replayed"] === true &&
        answered["head"] === HEAD,
      `status=${delivered.status} review=${JSON.stringify(answered)}`,
    );
    return;
  }
  check(
    `the signed ${ACTION} on the card's PR starts a reviewer run`,
    delivered.status === 200 &&
      answered["status"] === "processed" &&
      sessionId !== undefined,
    `status=${delivered.status} review=${JSON.stringify(answered)}`,
  );
  if (sessionId === undefined) return;
  observed.reviewer = sessionId;
  console.log(`reviewer ${sessionId}`);
  // Settled: its review tool call has a result and the run is idle again.
  const snapshot = yield* waitUntil(
    Effect.map(client.getSession({ sessionId }), (snapshot) =>
      !snapshot.live.busy &&
      snapshot.entries.some(
        (entry) =>
          entry.kind === "toolResult" &&
          entry.toolName === "review" &&
          !entry.isError,
      )
        ? snapshot
        : undefined,
    ),
    `reviewer ${sessionId} to record its verdict`,
  );
  check(
    "the reviewer is cut at the head the delivery names",
    snapshot.workspace.baseRef === HEAD,
    `baseRef=${snapshot.workspace.baseRef}`,
  );
  const recorded = yield* recordedReview(sessionId);
  observed.recorded = recorded ?? null;
  check(
    `its log records a ${EXPECT} on that head (factory.review)`,
    recorded?.target.head === HEAD &&
      recorded.target.url === PR_URL &&
      recorded.verdict === EXPECT,
    `head=${recorded?.target.head ?? "-"} verdict=${recorded?.verdict ?? "none"} outcome=${recorded?.outcome ?? "-"} failing=${(recorded?.failing ?? []).join(",") || "-"}`,
  );
});

const failed = () => Object.values(observed.checks).some((c) => !c.passed);

const runScoped = <E>(
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

if (MODE === "review") {
  await runScoped(review);
  await mkdir(EVIDENCE_DIR, { recursive: true });
  await writeFile(
    path.join(EVIDENCE_DIR, `review-${LABEL}.json`),
    `${JSON.stringify(observed, null, 2)}\n`,
  );
  process.exit(failed() ? 1 : 0);
} else {
  console.error("review.ts: MODE must be review");
  process.exit(2);
}
