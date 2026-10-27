// The docs trigger's callers over real HTTP (LOB-234): the API's own schedule daemon and its signed
// GitHub push route, against a booted API.
//
//   bun docs-trigger-http.ts        (docs-trigger-http.sh boots the API for each phase first)
//
// `DOCS_HTTP_PHASE` picks what the API was booted with, because the schedule is boot configuration:
//
//   on   — `DOCS_SCHEDULE_MS=400`, `DOCS_SCHEDULE_REPO`, `GITHUB_WEBHOOK_SECRET`:
//          1. before its repo is registered the schedule starts nothing (each tick is a skip)
//          2. once it is, the daemon starts `factory/doc-schedule-<interval>` sessions, one per
//             interval: distinct intervals, each a multiple of 400 ms, as many as the wall clock
//             allows (less the interval it was registered in and the one in flight) and no more
//          3. a signed `push` to the default branch on `POST /webhooks/github` answers
//             `{status: "processed", sessionId}`, and that session is on `factory/doc-push-…`
//          4. GitHub's redelivery of it — a fresh `X-GitHub-Delivery` — answers `replayed: true`
//          5. a push to a non-default branch is `400 not-default-branch` and starts nothing
//          6. a wrong `X-Hub-Signature-256`, and GitHub's digest without its `sha256=` prefix, are `401`
//          7. another event (`ping`) still reaches the `pull_request` handler, which ignores it (`202`)
//          8. the merge commit of a `factory/doc-*` pull request is `200 skipped` and starts nothing
//          9. a push to a repo not yet registered is skipped, and GitHub's redelivery of it once the
//             repo is registered starts its one run
//         10. the push repo has exactly the one session the push earned
//   off  — `DOCS_SCHEDULE_MS` unset (the repo set and registered): no schedule session in the same
//          wall clock.
//
// Env: API_URL, EVIDENCE_DIR, DOCS_HTTP_PHASE, DOCS_SCHEDULE_REPO, DOCS_PUSH_REPO,
// GITHUB_WEBHOOK_SECRET, DOCS_SCHEDULE_MS (the interval the `on` boot used).
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { SessionRpc } from "@repo/domain/Rpc";
import { RepoSlug, SessionId } from "@repo/domain/Session";
import { Effect, Option, Schema } from "effect";
import { RpcClient } from "effect/rpc";
import { makeChecker, protocolFor } from "./harness.ts";

const API_URL = process.env["API_URL"] ?? "http://localhost:9422";
const EVIDENCE_DIR = process.env["EVIDENCE_DIR"] ?? ".verify/evidence/latest";
const PHASE = process.env["DOCS_HTTP_PHASE"] ?? "on";
const SCHEDULE_REPO = RepoSlug.make(
  process.env["DOCS_SCHEDULE_REPO"] ?? "acme/verify-api-docs-schedule",
);
const PUSH_REPO = RepoSlug.make(
  process.env["DOCS_PUSH_REPO"] ?? "acme/verify-api-docs-push",
);
const SECRET = process.env["GITHUB_WEBHOOK_SECRET"] ?? "";
const EVERY_MS = Number(process.env["DOCS_SCHEDULE_MS"] ?? "400");
/** How long the drive watches the clock: five intervals of the `on` boot. */
const WATCH_MS = 5 * 400;

await mkdir(EVIDENCE_DIR, { recursive: true });

const observed = {
  apiUrl: API_URL,
  phase: PHASE,
  scheduleRepo: SCHEDULE_REPO,
  pushRepo: PUSH_REPO,
  checks: {},
  schedule: null as unknown,
  deliveries: [] as Array<unknown>,
};
const assert = makeChecker(observed);

/** A 40-hex commit for this run's push: a reused database must not answer it as a replay. */
const SHA = randomBytes(20).toString("hex");

/** GitHub's `push` body, shaped from its webhook docs: the fields the adapter reads, and a few more. */
const pushBody = (
  over: {
    readonly ref?: string;
    readonly repo?: RepoSlug;
    readonly sha?: string;
    readonly headMessage?: string;
  } = {},
) => {
  const repo = over.repo ?? PUSH_REPO;
  const sha = over.sha ?? SHA;
  const message = over.headMessage ?? "feat: a change worth a docs pass";
  return {
    ref: over.ref ?? "refs/heads/main",
    before: "0".repeat(40),
    after: sha,
    created: false,
    deleted: false,
    forced: false,
    compare: `https://github.com/${repo}/compare/0000000...${sha.slice(0, 7)}`,
    commits: [{ id: sha, message: `${message}\n\nwith a body nobody reads` }],
    head_commit: { id: sha, message },
    repository: {
      id: 1,
      name: repo.split("/")[1],
      full_name: repo,
      default_branch: "main",
      master_branch: "main",
    },
    pusher: { name: "verify-api", email: "verify-api@localhost" },
    sender: { login: "verify-api", type: "User" },
  };
};

/** A repo the push reaches before anyone registered it: skipped, then redelivered once it is. */
const LATE_REPO = RepoSlug.make(`${PUSH_REPO}-late`);

const sign = (raw: string, key = SECRET) =>
  `sha256=${createHmac("sha256", key).update(raw).digest("hex")}`;

/** One delivery as GitHub sends it: the raw body, `X-Hub-Signature-256`, and a fresh delivery id. */
const deliver = async (
  label: string,
  body: unknown,
  options: { readonly event?: string; readonly signature?: string } = {},
) => {
  const raw = JSON.stringify(body);
  const delivery = randomUUID();
  const response = await fetch(`${API_URL}/webhooks/github`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": "GitHub-Hookshot/verify-api",
      "x-github-event": options.event ?? "push",
      "x-github-delivery": delivery,
      "x-hub-signature-256": options.signature ?? sign(raw),
    },
    body: raw,
  });
  const answer = (await response.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  observed.deliveries.push({
    label,
    delivery,
    status: response.status,
    answer,
  });
  return { status: response.status, body: answer };
};

const program = Effect.gen(function* () {
  const client = yield* RpcClient.make(SessionRpc);

  /** Every session on `repo` with the branch its workspace is on. */
  const sessionsOn = (repo: RepoSlug) =>
    Effect.gen(function* () {
      const listed = yield* client.listSessions({ limit: 200 });
      const mine = listed.sessions.filter((entry) => entry.repo === repo);
      return yield* Effect.forEach(mine, (entry) =>
        Effect.map(client.getSession({ sessionId: entry.id }), (snapshot) => ({
          id: entry.id,
          branch: snapshot.workspace.branch,
        })),
      );
    });

  const scheduled = (repo: RepoSlug) =>
    Effect.map(sessionsOn(repo), (sessions) =>
      sessions.filter(
        (entry) => entry.branch?.startsWith("factory/doc-schedule-") === true,
      ),
    );

  if (PHASE === "off") {
    yield* client.registerRepo({ repo: SCHEDULE_REPO, defaultBaseRef: "main" });
    yield* Effect.sleep(`${WATCH_MS} millis`);
    const sessions = yield* scheduled(SCHEDULE_REPO);
    observed.schedule = { watchedMs: WATCH_MS, sessions };
    assert(
      "with DOCS_SCHEDULE_MS unset, a booted API starts no schedule session",
      sessions.length === 0,
      `${sessions.length} session(s) in ${WATCH_MS}ms on ${SCHEDULE_REPO}`,
    );
    return;
  }

  // 1: the daemon has been ticking since boot, at a repo nobody registered.
  const unregistered = yield* scheduled(SCHEDULE_REPO);
  assert(
    "before its repo is registered, the schedule starts nothing",
    unregistered.length === 0,
    `${unregistered.length} session(s) on ${SCHEDULE_REPO}`,
  );

  // 2: register it, and watch the clock.
  yield* client.registerRepo({ repo: SCHEDULE_REPO, defaultBaseRef: "main" });
  const registeredAt = Date.now();
  yield* Effect.sleep(`${WATCH_MS} millis`);
  // A tick is a real session, and on a loaded machine one can outlast its interval: keep watching
  // (up to 15 s more) until two have landed, and let the bound below decide "once per interval".
  let sessions = yield* scheduled(SCHEDULE_REPO);
  for (let waited = 0; sessions.length < 2 && waited < 15_000; waited += 250) {
    yield* Effect.sleep("250 millis");
    sessions = yield* scheduled(SCHEDULE_REPO);
  }
  const elapsed = Date.now() - registeredAt;
  const intervals = sessions
    .map((entry) => Number(entry.branch?.split("-").pop()))
    .sort((a, b) => a - b);
  observed.schedule = { everyMs: EVERY_MS, elapsed, sessions, intervals };
  assert(
    "with DOCS_SCHEDULE_MS=400, the booted API starts factory/doc-schedule-* sessions",
    sessions.length >= 2,
    `${sessions.length} session(s) in ${elapsed}ms`,
  );
  // Both bounds: no more ticks than the clock had intervals, and — the clock aligned to the
  // interval boundaries — no fewer than its whole intervals less the one it was registered inside
  // and the one still in flight when the drive looked.
  const atMost = Math.ceil(elapsed / EVERY_MS) + 1;
  const atLeast = Math.floor(elapsed / EVERY_MS) - 1;
  assert(
    "once per interval: each names its own interval, a multiple of the period, as many as the clock allows and no more",
    new Set(intervals).size === intervals.length &&
      intervals.every(
        (interval) => Number.isInteger(interval) && interval % EVERY_MS === 0,
      ) &&
      intervals.length <= atMost &&
      intervals.length >= atLeast,
    `intervals=${intervals.join(",")} (between ${atLeast} and ${atMost} in ${elapsed}ms)`,
  );

  // 3: a signed push to the default branch.
  yield* client.registerRepo({ repo: PUSH_REPO, defaultBaseRef: "main" });
  const first = yield* Effect.promise(() => deliver("push", pushBody()));
  const sessionId = Option.getOrUndefined(
    Schema.decodeUnknownOption(SessionId)(first.body?.["sessionId"]),
  );
  assert(
    "a signed push to the default branch answers {status: processed, sessionId}",
    first.status === 200 &&
      first.body?.["status"] === "processed" &&
      first.body?.["replayed"] === false &&
      sessionId !== undefined,
    `status=${first.status} body=${JSON.stringify(first.body)}`,
  );
  if (sessionId !== undefined) {
    const snapshot = yield* client.getSession({ sessionId });
    const expected = `factory/doc-push-${PUSH_REPO.replace("/", "-")}-${SHA}`;
    assert(
      "and its session works on factory/doc-<the push>",
      snapshot.workspace.branch === expected,
      `${String(snapshot.workspace.branch)} (expected ${expected})`,
    );
  }

  // 4: GitHub's redelivery: the same body, a new delivery id.
  const again = yield* Effect.promise(() => deliver("redelivery", pushBody()));
  assert(
    "a redelivery of the push answers replayed: true",
    again.status === 200 &&
      again.body?.["replayed"] === true &&
      again.body?.["status"] === "processed",
    `status=${again.status} body=${JSON.stringify(again.body)}`,
  );

  // 5: a push to another branch — a session's own, say.
  const other = yield* Effect.promise(() =>
    deliver("other-branch", pushBody({ ref: "refs/heads/factory/ses_x" })),
  );
  assert(
    "a push to a non-default branch is 400 and refused",
    other.status === 400 && other.body?.["code"] === "not-default-branch",
    `status=${other.status} body=${JSON.stringify(other.body)}`,
  );

  // 6: signatures.
  const forged = yield* Effect.promise(() =>
    deliver("forged", pushBody(), {
      signature: sign(JSON.stringify(pushBody()), "not-the-secret"),
    }),
  );
  const bare = yield* Effect.promise(() =>
    deliver("bare-hex", pushBody(), {
      signature: sign(JSON.stringify(pushBody())).slice("sha256=".length),
    }),
  );
  assert(
    "a wrong X-Hub-Signature-256 is 401, and so is the digest without sha256=",
    forged.status === 401 && bare.status === 401,
    `forged=${forged.status} bare=${bare.status}`,
  );

  // 7: the pull_request handler still owns every other event.
  const ping = yield* Effect.promise(() =>
    deliver("ping", { zen: "Keep it logically awesome." }, { event: "ping" }),
  );
  assert(
    "another event still reaches the pull_request handler (ping is 202, ignored)",
    ping.status === 202 && typeof ping.body?.["ignored"] === "string",
    `status=${ping.status} body=${JSON.stringify(ping.body)}`,
  );

  // 8: the merge of a docs run's own PR is a push to main too, and must not start the next pass.
  const merge = yield* Effect.promise(() =>
    deliver(
      "docs-pr-merge",
      pushBody({
        sha: randomBytes(20).toString("hex"),
        headMessage: `Merge pull request #12 from ${PUSH_REPO.split("/")[0]}/factory/doc-push-${PUSH_REPO.replace("/", "-")}-${SHA}`,
      }),
    ),
  );
  assert(
    "the merge of a factory/doc-* pull request is 200 skipped, naming why",
    merge.status === 200 &&
      merge.body?.["status"] === "skipped" &&
      String(merge.body?.["reason"]).includes("factory/doc-"),
    `status=${merge.status} body=${JSON.stringify(merge.body)}`,
  );

  // 9: a push that beat the repo's registration, redelivered from GitHub's log once it is.
  const late = pushBody({ repo: LATE_REPO });
  const early = yield* Effect.promise(() => deliver("late-unregistered", late));
  yield* client.registerRepo({ repo: LATE_REPO, defaultBaseRef: "main" });
  const redelivered = yield* Effect.promise(() =>
    deliver("late-redelivered", late),
  );
  const lateSessions = yield* sessionsOn(LATE_REPO);
  assert(
    "a push to an unregistered repo is skipped, and its redelivery after registering starts one run",
    early.status === 200 &&
      early.body?.["status"] === "skipped" &&
      redelivered.status === 200 &&
      redelivered.body?.["status"] === "processed" &&
      redelivered.body?.["replayed"] === false &&
      lateSessions.length === 1,
    `early=${JSON.stringify(early.body)} redelivered=${JSON.stringify(redelivered.body)} sessions=${lateSessions.length}`,
  );

  // 10: the count.
  const pushed = yield* sessionsOn(PUSH_REPO);
  assert(
    "the push repo has exactly the one session the push earned",
    pushed.length === 1 && pushed[0]?.id === sessionId,
    `sessions=${JSON.stringify(pushed)}`,
  );
});

try {
  await Effect.runPromise(
    program.pipe(Effect.provide(protocolFor(API_URL)), Effect.scoped),
  );
} catch (error) {
  assert("drive completed", false, `threw: ${String(error)}`);
}

await writeFile(
  path.join(EVIDENCE_DIR, `docs-trigger-http-${PHASE}.json`),
  `${JSON.stringify(observed, null, 2)}\n`,
);

const failed = Object.entries(observed.checks).filter(
  ([, check]) => !(check as { passed: boolean }).passed,
);
if (failed.length > 0) {
  console.error(`\n${failed.length} required check(s) failed`);
  process.exitCode = 1;
} else {
  console.log(`${Object.keys(observed.checks).length} checks passed`);
}
