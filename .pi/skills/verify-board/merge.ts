#!/usr/bin/env bun
// The merge, the way a deployment gets one (C20): a person merges the card's PR in GitHub — here the
// loopback fake's own `PUT /repos/:owner/:repo/pulls/:number/merge`, GitHub's merge endpoint — and
// GitHub tells the API with a signed `pull_request` closed delivery, which moves the card to `done`.
// The fake sends no webhooks, so this script signs the delivery GitHub would send, with the
// instance's `GITHUB_WEBHOOK_SECRET`, and delivers it twice: the redelivery must change nothing.
//
//   MODE=merge   merge the PR on the fake, deliver the merge twice, and check that the card reached
//                `done` once, at the revision after EXPECT_REVISION, recorded by `merge:<PR page>`.
//
// What `drive.sh` cannot do from a terminal: sign a GitHub delivery and count the card's events. What
// a person reads — `factory board show` printing `done` — is read back by the calling script.
//
// Env: API_URL, GITHUB_WEBHOOK_SECRET, FORGE_URL (the fake's root), REPO (the PR's repository slug),
// PR_URL (its page), TASK_ID, EXPECT_REVISION (the card's revision before the merge), LABEL,
// EVIDENCE_DIR, DATABASE_URL. Exits non-zero when a check fails.
import { createHmac, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Effect, Scope } from "effect";
import { RpcClient } from "effect/rpc";
import { SqlClient } from "effect/sql/SqlClient";
import { RpcApi } from "@repo/domain/Rpc";
import { TaskId } from "@repo/domain/Task";
import { DatabaseLive } from "@repo/storage-postgres";
import { makeChecker, protocolFor } from "../verify-api/harness.ts";
import type { CheckRecord } from "../verify-api/harness.ts";

const API_URL = process.env["API_URL"] ?? "http://localhost:9400";
const MODE = process.env["MODE"] ?? "";
const SECRET = process.env["GITHUB_WEBHOOK_SECRET"] ?? "";
const FORGE_URL = process.env["FORGE_URL"] ?? "";
const REPO = process.env["REPO"] ?? "";
const PR_URL = process.env["PR_URL"] ?? "";
const PR_NUMBER = Number(PR_URL.split("/").at(-1) ?? "0");
const TASK_ID = process.env["TASK_ID"] ?? "";
const EXPECT_REVISION = Number(process.env["EXPECT_REVISION"] ?? "0");
const LABEL = process.env["LABEL"] ?? "merge";
const EVIDENCE_DIR =
  process.env["EVIDENCE_DIR"] ?? ".verify/evidence/latest/board";

const observed: {
  label: string;
  merged: unknown;
  deliveries: Array<unknown>;
  card: unknown;
  moves: unknown;
  checks: Record<string, CheckRecord>;
} = {
  label: LABEL,
  merged: null,
  deliveries: [],
  card: null,
  moves: null,
  checks: {},
};
const check = makeChecker(observed);

/** The person's merge in GitHub: the fake's merge endpoint, which records it for the state read. */
const mergeOnForge = async () => {
  const response = await fetch(
    `${FORGE_URL}/repos/${REPO}/pulls/${PR_NUMBER}/merge`,
    { method: "PUT", headers: { "content-type": "application/json" } },
  );
  return {
    status: response.status,
    answer: (await response.json().catch(() => null)) as Record<
      string,
      unknown
    > | null,
  };
};

/** GitHub's `pull_request` closed body for a merge, shaped from its webhook docs. */
const payload = (mergeSha: string) => ({
  action: "closed",
  number: PR_NUMBER,
  pull_request: {
    number: PR_NUMBER,
    html_url: PR_URL,
    url: `https://api.github.com/repos/${REPO}/pulls/${PR_NUMBER}`,
    state: "closed",
    merged: true,
    merged_at: new Date().toISOString(),
    merge_commit_sha: mergeSha,
    body: null,
  },
  repository: { full_name: REPO, default_branch: "main" },
  sender: { login: "verify-board", type: "User" },
});

const deliver = async (body: unknown) => {
  const raw = JSON.stringify(body);
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
  return {
    status: response.status,
    answer: (await response.json().catch(() => null)) as Record<
      string,
      unknown
    > | null,
  };
};

/** The card's `moved` events, as their actor and target, read out of Postgres. */
const moves = Effect.gen(function* () {
  const sql = yield* SqlClient;
  return yield* sql<{ actor: string; to: string }>`
    SELECT actor, payload->>'to' AS to FROM task_events
    WHERE task_id = ${TASK_ID} AND kind = 'moved' AND revision >= ${EXPECT_REVISION}
    ORDER BY id
  `;
}).pipe(Effect.provide(DatabaseLive));

const merge = Effect.gen(function* () {
  const client = yield* RpcClient.make(RpcApi);
  const merged = yield* Effect.promise(mergeOnForge);
  observed.merged = merged;
  check(
    "the person's merge in GitHub is recorded on the fake (PUT .../merge)",
    merged.status === 200 && merged.answer?.["merged"] === true,
    `status=${merged.status} ${JSON.stringify(merged.answer)}`,
  );
  const body = payload(String(merged.answer?.["sha"] ?? ""));
  const first = yield* Effect.promise(() => deliver(body));
  const again = yield* Effect.promise(() => deliver(body));
  observed.deliveries = [first, again];
  check(
    "the signed pull_request merge moves the PR's card to done",
    first.status === 200 &&
      JSON.stringify(first.answer?.["cards"]) ===
        JSON.stringify({ done: 1, blocked: 0 }),
    `status=${first.status} cards=${JSON.stringify(first.answer?.["cards"])}`,
  );
  check(
    "its redelivery settles no card again",
    again.status === 200 && again.answer?.["cards"] === undefined,
    `status=${again.status} cards=${JSON.stringify(again.answer?.["cards"])}`,
  );
  const card = yield* client.getTask({ taskId: TaskId.make(TASK_ID) });
  observed.card = card;
  check(
    "the card is in done, one revision on from where the merge found it",
    card.column === "done" && card.revision === EXPECT_REVISION + 1,
    `column=${card.column} revision=${card.revision} (was ${EXPECT_REVISION})`,
  );
  const recorded = yield* moves;
  observed.moves = recorded;
  check(
    "exactly one move into done, recorded by the merge (merge:<PR page>)",
    recorded.length === 1 &&
      recorded[0]?.actor === `merge:${PR_URL}` &&
      recorded[0]?.to === "done",
    JSON.stringify(recorded),
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

if (MODE === "merge") {
  await runScoped(merge);
  await mkdir(EVIDENCE_DIR, { recursive: true });
  await writeFile(
    path.join(EVIDENCE_DIR, `merge-${LABEL}.json`),
    `${JSON.stringify(observed, null, 2)}\n`,
  );
  process.exit(failed() ? 1 : 0);
} else {
  console.error("merge.ts: MODE must be merge");
  process.exit(2);
}
