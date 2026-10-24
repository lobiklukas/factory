// The Slack adapter end to end (LOB-191): a signed Slack message in, one session and one threaded
// reply out.
//
//   bun slack.ts
//
// What runs is the real seam, not a model of it: `TriggerService` on the run's Postgres, the real
// `SessionService` behind its `TriggerSessions` port (so the session, its log and its first message
// are real), the adapter's real signature check (`verifySlackSignature`, fed a signature computed
// the way Slack computes it) and the real `SlackWriteBack` over an Effect `HttpClient` pointed at
// `./slack-fake.ts` on loopback. Only the Slack Web API is fake.
//
// The checks:
//
//   1. a signed message in a watched channel starts a session, and it is named by the message
//   2. the session is the message's own words: first line as the title, the rendered rule first
//   3. the write-back replied once, in the message's thread, naming the session
//   4. Slack's own two calls: the thread is read first, then one reply is posted, as the bot token
//   5. the same message again — Slack's retry, with a new `event_id` — is a replay: one session,
//      one reply
//   6. a delivery whose timestamp is outside Slack's 5-minute window is refused, typed, and starts
//      nothing (a replayed delivery is one whose signature is *right*, so it must not read as
//      bad-signature)
//   7. a body changed after it was signed is refused as bad-signature, and no signature at all as
//      missing-signature
//   8. a message in a channel the filter does not watch is skipped, and the recorded reason says so
//   9. a message without the filter's phrase is skipped for that reason
//  10. a bot's own message in a watched channel starts nothing — the loop guard
//  11. a message that is already in a thread is answered in that thread
//  12. a reply that landed and whose acknowledgement was lost fails the delivery, and the retry
//      reads the thread, posts no second reply, and reuses the session
//
// Env: DATABASE_URL (via DatabaseLive), SESSION_ROOT, SLACK_FAKE_URL, SLACK_FAKE_LEDGER,
// SLACK_TRIGGER_REPO, SLACK_SIGNING_SECRET, EVIDENCE_DIR.
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { BunServices } from "@effect/platform-bun";
import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { FetchHttpClient } from "effect/http";
import { SqlClient } from "effect/sql/SqlClient";
import { RepoSlug as RepoSlugSchema } from "@repo/domain/Session";
import type { SessionId } from "@repo/domain/Session";
import type { TriggerDelivery, TriggerRule } from "@repo/domain/Trigger";
import {
  slackDelivery,
  SlackWriteBack,
  verifySlackSignature,
  slackSignature,
  SLACK_REPLAY_WINDOW_SECONDS,
  SessionService,
  SessionServiceLive,
  TriggerService,
  TriggerServiceLive,
  TriggerSessionsFromSessionService,
  type SlackFilter,
} from "@repo/core";
import { createModelAccess } from "@repo/harness";
import { DatabaseLive } from "@repo/storage-postgres";
import { makeChecker } from "./harness.ts";
import type { CheckRecord } from "./harness.ts";

const SESSION_ROOT =
  process.env["SESSION_ROOT"] ?? ".verify/run/slack/sessions";
/**
 * A per-run stamp. The repo carries it so the drive can be re-run against the same database: a
 * delivery id is stable for one run (which is what the replay checks need) and new for the next
 * one, and the repo starts with no sessions to count.
 */
const RUN_STAMP = String(process.env["SLACK_RUN_STAMP"] ?? Date.now());
const REPO = RepoSlugSchema.make(
  `${process.env["SLACK_TRIGGER_REPO"] ?? "acme/verify-api-slack"}-${RUN_STAMP}`,
);
const FAKE_URL = process.env["SLACK_FAKE_URL"] ?? "http://127.0.0.1:9414";
const LEDGER =
  process.env["SLACK_FAKE_LEDGER"] ?? ".verify/run/slack/slack-ledger.json";
const EVIDENCE_DIR =
  process.env["EVIDENCE_DIR"] ?? ".verify/evidence/latest/api";
const SIGNING_SECRET =
  process.env["SLACK_SIGNING_SECRET"] ?? "lob191-drive-signing-secret";
const BOT_TOKEN = "xoxb-drive-token";

/**
 * A message `ts` for this run. Slack's `ts` is what the seam dedupes a message by, and it is the
 * one thing a payload does not carry from the repo, so it has to be run-stamped or a second run
 * against the same database would replay the first run's deliveries instead of starting clean (the
 * `github-issues.ts` `RUN_STAMP` convention). `slack.sh` stamps the same value into
 * `SLACK_FAKE_FAIL_AFTER_WRITE` as `messageTs(9)`, so the lost-acknowledgement case cannot silently
 * stop firing.
 */
const messageTs = (n: number): string =>
  `${RUN_STAMP}.${String(n).padStart(4, "0")}`;

/** The opening message's `ts`; it is also the root of the thread the threaded case replies in. */
const ROOT_TS = messageTs(1);
/** The message whose reply the fake records and then answers `500` for (see `messageTs`). */
const LOST_ACK_TS = messageTs(9);

await mkdir(EVIDENCE_DIR, { recursive: true });
await mkdir(path.dirname(LEDGER), { recursive: true });

/** The channel the operator watches: the label a mapping rule matches, as Slack spells it. */
const WATCHED = "C0ENG";
const UNWATCHED = "C0RANDOM";

const filter: SlackFilter = { channels: [WATCHED] };
const withPhrase: SlackFilter = { channels: [WATCHED], text: "deploy" };

const rules: ReadonlyArray<TriggerRule> = [
  {
    label: WATCHED,
    repo: REPO,
    baseRef: "main",
    prompt: "Work on {{title}}:\n{{body}}",
  },
];

const observed: {
  sessionId: SessionId | null;
  sessionRepo: string | null;
  refusals: Record<string, string>;
  skipped: Array<{ why: string; status: string; reason: string | undefined }>;
  replies: unknown;
  checks: Record<string, CheckRecord>;
} = {
  sessionId: null,
  sessionRepo: null,
  refusals: {},
  skipped: [],
  replies: null,
  checks: {},
};
const assert = makeChecker(observed);

/** The session layer, the seam, and the adapter's own write-back client — one runtime. */
const base = SessionServiceLive({
  model: createModelAccess("faux"),
  sessionRoot: SESSION_ROOT,
}).pipe(Layer.provideMerge(Layer.mergeAll(DatabaseLive, BunServices.layer)));

const triggers = TriggerServiceLive({ rules }).pipe(
  Layer.provide(
    Layer.mergeAll(
      TriggerSessionsFromSessionService,
      SlackWriteBack({
        apiUrl: FAKE_URL,
        botToken: Redacted.make(BOT_TOKEN),
        sessionUrlBase: "http://localhost:3000/sessions",
      }).pipe(Layer.provide(FetchHttpClient.layer)),
    ),
  ),
  Layer.provideMerge(base),
);

const runtime = ManagedRuntime.make(triggers);

/** The moment every delivery in this run is signed at; the window checks move around it. */
const NOW = Math.floor(Date.now() / 1000);

/** Slack's `event_callback` for a message, shaped as the Events API documents it. */
const payload = (over: {
  readonly channel?: string;
  readonly ts?: string;
  readonly threadTs?: string;
  readonly text?: string;
  readonly botId?: string;
  readonly eventId?: string;
}): Record<string, unknown> => ({
  token: "verification-token",
  team_id: "T0ACME",
  api_app_id: "A0ACME",
  type: "event_callback",
  event_id: over.eventId ?? `Ev${String(over.ts ?? ROOT_TS)}`,
  event_time: NOW,
  event: {
    type: "message",
    channel: over.channel ?? WATCHED,
    user: "U0ALICE",
    text: over.text ?? "Fix the widget\nIt wobbles when it spins.",
    ts: over.ts ?? ROOT_TS,
    ...(over.threadTs === undefined ? {} : { thread_ts: over.threadTs }),
    ...(over.botId === undefined ? {} : { bot_id: over.botId }),
  },
});

type Ledger = {
  readonly requests: ReadonlyArray<{
    readonly method: string;
    readonly path: string;
    readonly query: string;
    readonly authorization: string | undefined;
  }>;
  readonly replies: ReadonlyArray<{
    readonly ts: string;
    readonly channel: string;
    readonly root: string;
    readonly text: string;
  }>;
};

const readLedger = (): Ledger => {
  try {
    return JSON.parse(readFileSync(LEDGER, "utf8")) as Ledger;
  } catch {
    return { requests: [], replies: [] };
  }
};

/**
 * Sign a payload the way Slack does, then check it the way a route would: this is the one place the
 * drive and the adapter must agree, so it computes nothing itself.
 */
const signed = (body: Record<string, unknown>, at: number = NOW) => {
  const raw = JSON.stringify(body);
  const timestamp = String(at);
  const signature = slackSignature(raw, timestamp, SIGNING_SECRET);
  return {
    raw,
    verdict: verifySlackSignature({
      raw,
      signature,
      timestamp,
      signingSecret: SIGNING_SECRET,
      nowSeconds: NOW,
    }),
    signedRaw: raw,
    timestamp,
    signature,
  };
};

/** The delivery a signed payload makes, when its signature was accepted. */
const deliveryOf = (
  body: Record<string, unknown>,
  which: SlackFilter = filter,
  at: number = NOW,
): TriggerDelivery | undefined => {
  const check = signed(body, at);
  if (!check.verdict.ok) return undefined;
  return slackDelivery(body, which);
};

const deliver = (
  body: Record<string, unknown>,
  which: SlackFilter = filter,
) => {
  const delivery = deliveryOf(body, which);
  if (delivery === undefined) {
    throw new Error(`the payload did not normalize: ${JSON.stringify(body)}`);
  }
  return Effect.gen(function* () {
    const service = yield* TriggerService;
    return yield* service.deliver(delivery);
  });
};

const sessionCount = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const rows = yield* sql<{ count: number }>`
    SELECT count(*)::int AS count FROM sessions WHERE repo = ${REPO}
  `;
  return rows[0]?.count ?? 0;
});

const firstMessage = (entries: ReadonlyArray<{ kind: string; text: string }>) =>
  entries.find((entry) => entry.kind === "user")?.text;

const run = Effect.gen(function* () {
  const sessions = yield* SessionService;
  yield* sessions.registerRepo({ repo: REPO, defaultBaseRef: "main" });

  // 1 + 2: the signed message starts one real session carrying the message's own words.
  const created = yield* deliver(payload({}));
  observed.sessionId = created.sessionId ?? null;
  assert(
    "a signed message in a watched channel starts a session and names it",
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
    "the session is in the rule's repo, mapped by the channel",
    read.session.repo === REPO,
    `repo=${String(read.session.repo)} rule=${REPO}`,
  );
  assert(
    "its title is the message's first line, and its first message the rendered rule",
    read.session.title === "Fix the widget" &&
      firstMessage(read.entries) ===
        "Work on Fix the widget:\nFix the widget\nIt wobbles when it spins.",
    `title=${JSON.stringify(read.session.title)} first=${JSON.stringify(firstMessage(read.entries))}`,
  );

  // 3 + 4: one reply, in the message's own thread, through Slack's own two calls.
  const afterCreate = readLedger();
  const reply = afterCreate.replies[0];
  assert(
    "the write-back replied exactly once, in the message's thread",
    afterCreate.replies.length === 1 &&
      reply?.channel === WATCHED &&
      reply?.root === ROOT_TS,
    `replies=${afterCreate.replies.length} channel=${String(reply?.channel)} root=${String(reply?.root)}`,
  );
  assert(
    "the reply names the session and links to it",
    typeof reply?.text === "string" &&
      reply.text.includes(sessionId) &&
      reply.text.includes(`http://localhost:3000/sessions/${sessionId}`),
    String(reply?.text),
  );
  const posts = afterCreate.requests.filter(
    (request) => request.method === "POST",
  );
  assert(
    "Slack's two calls: the thread is read first, then one chat.postMessage, as the bot token",
    afterCreate.requests[0]?.method === "GET" &&
      afterCreate.requests[0]?.path === "/api/conversations.replies" &&
      (afterCreate.requests[0]?.query ?? "").includes(`channel=${WATCHED}`) &&
      posts.length === 1 &&
      posts[0]?.path === "/api/chat.postMessage" &&
      posts[0]?.authorization === `Bearer ${BOT_TOKEN}`,
    `methods=${afterCreate.requests.map((request) => request.method).join(",")} posts=${posts.length} auth=${String(posts[0]?.authorization).slice(0, 20)}…`,
  );

  // 5: Slack's retry of the same message carries a new `event_id`; it is the same delivery.
  const retried = yield* deliver(
    payload({
      eventId: "Ev0RETRY",
      text: "Fix the widget\nIt wobbles when it spins.",
    }),
  );
  assert(
    "the same message again — a new event_id, a fresh signature — is a replay",
    retried.replayed === true &&
      (yield* sessionCount) === 1 &&
      readLedger().replies.length === 1,
    `replayed=${String(retried.replayed)} sessions=${yield* sessionCount} replies=${readLedger().replies.length}`,
  );

  // 6: a delivery captured and replayed later is refused before its body is read, and says so.
  const staleAt = NOW - SLACK_REPLAY_WINDOW_SECONDS - 1;
  const stale = signed(payload({ ts: messageTs(2) }), staleAt);
  observed.refusals["outside-window"] = stale.verdict.ok
    ? "accepted"
    : stale.verdict.refusal;
  assert(
    "a delivery outside Slack's five-minute window is refused, as outside-window",
    stale.verdict.ok === false && stale.verdict.refusal === "outside-window",
    stale.verdict.ok ? "accepted" : stale.verdict.refusal,
  );
  assert(
    "and the refused delivery starts nothing, because no delivery was made from it",
    deliveryOf(payload({ ts: messageTs(2) }), filter, staleAt) === undefined &&
      (yield* sessionCount) === 1,
    `sessions=${yield* sessionCount}`,
  );
  // The window is symmetric and Slack's own edge is inclusive: one second inside it still passes.
  const edge = signed(
    payload({ ts: messageTs(3) }),
    NOW - SLACK_REPLAY_WINDOW_SECONDS,
  );
  assert(
    "a delivery exactly at the edge of the window is still accepted",
    edge.verdict.ok === true,
    edge.verdict.ok ? "accepted at the edge" : edge.verdict.refusal,
  );

  // 7: the two other ways a signature fails are told apart.
  const tampered = signed(payload({ ts: messageTs(4) }));
  const tamperedVerdict = verifySlackSignature({
    raw: `${tampered.raw} `,
    signature: tampered.signature,
    timestamp: tampered.timestamp,
    signingSecret: SIGNING_SECRET,
    nowSeconds: NOW,
  });
  observed.refusals["bad-signature"] = tamperedVerdict.ok
    ? "accepted"
    : tamperedVerdict.refusal;
  const unsigned = verifySlackSignature({
    raw: tampered.raw,
    signature: undefined,
    timestamp: undefined,
    signingSecret: SIGNING_SECRET,
    nowSeconds: NOW,
  });
  observed.refusals["missing-signature"] = unsigned.ok
    ? "accepted"
    : unsigned.refusal;
  assert(
    "a body changed after signing is bad-signature, and no signature is missing-signature",
    tamperedVerdict.ok === false &&
      tamperedVerdict.refusal === "bad-signature" &&
      unsigned.ok === false &&
      unsigned.refusal === "missing-signature",
    `${tamperedVerdict.ok ? "accepted" : tamperedVerdict.refusal} / ${unsigned.ok ? "accepted" : unsigned.refusal}`,
  );

  // 8: a message in a channel the filter does not watch creates nothing, and the skip says why.
  const unwatched = yield* deliver(
    payload({ channel: UNWATCHED, ts: messageTs(5) }),
  );
  observed.skipped.push({
    why: "unwatched channel",
    status: unwatched.status,
    reason: unwatched.reason,
  });
  assert(
    "a message in a channel the filter does not watch is skipped, naming the filter",
    unwatched.status === "skipped" &&
      (unwatched.reason ?? "").includes("filtered:channel"),
    `status=${unwatched.status} reason=${String(unwatched.reason)}`,
  );

  // 9: the phrase filter refuses a message that does not carry it.
  const noPhrase = yield* deliver(
    payload({ ts: messageTs(6), text: "the widgets look fine" }),
    withPhrase,
  );
  observed.skipped.push({
    why: "missing phrase",
    status: noPhrase.status,
    reason: noPhrase.reason,
  });
  assert(
    "a message without the filter's phrase is skipped, naming the filter",
    noPhrase.status === "skipped" &&
      (noPhrase.reason ?? "").includes("filtered:text"),
    `status=${noPhrase.status} reason=${String(noPhrase.reason)}`,
  );

  // 10: the loop guard — the bot's own message in a watched channel starts nothing.
  const botMessage = yield* deliver(
    payload({
      ts: messageTs(7),
      text: "Factory started session 01J8ZOTHER for this message.",
      botId: "B0ACME",
    }),
  );
  observed.skipped.push({
    why: "bot message",
    status: botMessage.status,
    reason: botMessage.reason,
  });
  assert(
    "a bot's own message in a watched channel starts nothing",
    botMessage.status === "skipped" &&
      (botMessage.reason ?? "").includes("filtered:bot") &&
      (yield* sessionCount) === 1 &&
      readLedger().replies.length === 1,
    `status=${botMessage.status} reason=${String(botMessage.reason)} sessions=${yield* sessionCount}`,
  );

  // 11: a message already in a thread is answered in that thread, not in a new one.
  const threaded = yield* deliver(
    payload({
      ts: messageTs(8),
      threadTs: ROOT_TS,
      text: "Also the left widget wobbles.",
    }),
  );
  const threadedReply = readLedger().replies.at(-1);
  assert(
    "a message in a thread is answered in that thread",
    threaded.status === "processed" &&
      threadedReply?.root === ROOT_TS &&
      threadedReply.channel === WATCHED,
    `status=${threaded.status} root=${String(threadedReply?.root)} sessions=${yield* sessionCount}`,
  );

  // 12: the reply landed and its acknowledgement did not (the fake records it, then answers 500).
  // The seam gives the claim back, so the sender's retry runs the delivery again — and must find
  // its own reply rather than posting a second one.
  const lost = payload({ ts: LOST_ACK_TS });
  const lostAttempt = yield* Effect.exit(deliver(lost));
  assert(
    "a delivery whose reply landed but whose answer was lost fails",
    lostAttempt._tag === "Failure",
    lostAttempt._tag === "Failure"
      ? String(lostAttempt.cause).includes("write-back")
        ? "write-back error"
        : String(lostAttempt.cause).slice(0, 120)
      : "the delivery answered success",
  );
  const beforeRetry = yield* sessionCount;
  const retry = yield* deliver(lost);
  const retryLedger = readLedger();
  const forThread = (method: string) =>
    retryLedger.requests.filter(
      (request) =>
        request.method === method &&
        (request.path === "/api/chat.postMessage"
          ? true
          : (request.query ?? "").includes(`ts=${LOST_ACK_TS}`)),
    ).length;
  assert(
    "the retry reads the thread before it replies, and posts no second reply",
    forThread("GET") >= 2 &&
      retryLedger.replies.filter((entry) => entry.root === LOST_ACK_TS)
        .length === 1,
    `gets=${forThread("GET")} repliesInThread=${retryLedger.replies.filter((entry) => entry.root === LOST_ACK_TS).length}`,
  );
  assert(
    "and the retry is processed, reusing the session the failed attempt opened",
    retry.status === "processed" && (yield* sessionCount) === beforeRetry,
    `status=${retry.status} sessions=${yield* sessionCount} before=${beforeRetry}`,
  );

  observed.replies = readLedger().replies;
});

const exit = await runtime.runPromiseExit(run);
if (exit._tag === "Failure") {
  console.error(exit.cause);
}
await runtime.dispose();

const checks = Object.values(observed.checks);
const failed = checks.filter((check) => !check.passed).length;
await writeFile(
  path.join(EVIDENCE_DIR, "slack-observed.json"),
  `${JSON.stringify({ ...observed, failed }, null, 2)}\n`,
);
console.log(
  `\nslack: ${checks.length - failed}/${checks.length} checks passed — evidence in ${EVIDENCE_DIR}`,
);
process.exit(failed === 0 && exit._tag === "Success" ? 0 : 1);
