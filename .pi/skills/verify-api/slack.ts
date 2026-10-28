// The Slack adapter over HTTP (LOB-191, served by LOB-259): a signed Slack Events API delivery posted
// at a running API's `POST /webhooks/slack`, one session and one threaded reply out, and the PR's
// link in the same thread once the session's PR opens.
//
//   MODE=configured bun slack.ts     # the API booted with the signing secret, the bot token, a watched channel
//   MODE=unconfigured bun slack.ts   # the same API with `SLACK_SIGNING_SECRET` unset
//
// (`./slack.sh` boots the API and the fakes and runs both.) What runs is the real thing: the route,
// Slack's own signature check, `TriggerService` on the API's Postgres, the real `SessionService`, the
// real `SlackWriteBack` over HTTP to `./slack-fake.ts`, and the PR step over HTTP to `./github-fake.ts`.
// Only Slack and GitHub are fake, and this driver is Slack's sender: it signs `v0:<ts>:<body>` the way
// Slack does (`slackSignature`).
//
// The checks, `configured`:
//
//   1. Slack's `url_verification` handshake is answered with its challenge; unsigned, it is refused
//   2. a signed message in a watched channel opens a session, named by the message, in the rule's repo
//   3. the session is the message's own words: first line as the title, the rendered rule first
//   4. the write-back replied once, in the message's thread, naming and linking the session; the
//      thread was read first and the reply posted as the bot token
//   5. the same message again — Slack's retry, a new event_id — is a replay: one session, one reply
//   6. a delivery outside Slack's five-minute window is 401 outside-window, and starts nothing; one
//      inside it passes
//   7. a body changed after signing is 401 bad-signature, no signature 401 missing-signature, and
//      neither records a delivery
//   8. a message in a channel the filter does not watch is skipped, naming the filter
//   9. a bot's own message in a watched channel starts nothing — the loop guard
//  10. a message already in a thread is answered in that thread
//  11. an @mention opens a session, and the `message` twin Slack sends for it is the same delivery
//  12. a payload that carries no event is answered 200 and ignored
//  13. a reply that landed and whose acknowledgement was lost fails the delivery (500 write-back);
//      the retry is processed, posts no second reply, and reuses the session
//  14. the session's PR opened over RPC posts its link in the thread that started it, once: opening it
//      again answers `already-open` and posts nothing more
//
// `unconfigured`: a delivery and the handshake, signed with the empty key — what an unset secret
// degrades to — are 503 naming `SLACK_SIGNING_SECRET`, and open nothing.
//
// Env: API_URL, DATABASE_URL, SLACK_FAKE_LEDGER, SLACK_GITHUB_LEDGER, SLACK_TRIGGER_REPO,
// SLACK_RUN_STAMP, SLACK_SIGNING_SECRET, EVIDENCE_DIR.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { slackSignature, SLACK_REPLAY_WINDOW_SECONDS } from "@repo/core";
import { RepoSlug } from "@repo/domain/Session";
import { Effect } from "effect";
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
import { makeChecker, protocolFor, waitUntil } from "./harness.ts";
import type { CheckRecord } from "./harness.ts";

const MODE = process.env["MODE"] ?? "configured";
const API_URL = process.env["API_URL"] ?? "http://127.0.0.1:9425";
const DATABASE_URL =
  process.env["DATABASE_URL"] ??
  "postgres://factory:factory@localhost:5442/factory";
const LEDGER =
  process.env["SLACK_FAKE_LEDGER"] ?? ".verify/run/slack/slack-ledger.json";
const GITHUB_LEDGER =
  process.env["SLACK_GITHUB_LEDGER"] ?? ".verify/run/slack/github-ledger.json";
const SIGNING_SECRET =
  process.env["SLACK_SIGNING_SECRET"] ?? "lob259-drive-signing-secret";
const RUN_STAMP = String(process.env["SLACK_RUN_STAMP"] ?? Date.now());
const REPO = RepoSlug.make(
  process.env["SLACK_TRIGGER_REPO"] ?? `acme/verify-api-slack-${RUN_STAMP}`,
);
const EVIDENCE_DIR = process.env["EVIDENCE_DIR"] ?? ".verify/evidence/lob-259";

/**
 * A message `ts` for this run. Slack's `ts` is what the seam dedupes a message by, and it is the one
 * thing a payload does not carry from the repo, so it has to be run-stamped or a second run against
 * the same database would replay the first run's deliveries. `slack.sh` stamps the same value into
 * `SLACK_FAKE_FAIL_AFTER_WRITE` as `messageTs(9)`, so the lost-acknowledgement case cannot silently
 * stop firing.
 */
const messageTs = (n: number): string =>
  `${RUN_STAMP}.${String(n).padStart(4, "0")}`;
const ROOT_TS = messageTs(1);
const LOST_ACK_TS = messageTs(9);

/** The watched channel is the label a mapping rule matches, as Slack spells it. */
const WATCHED = "C0ENG";
const UNWATCHED = "C0RANDOM";

await mkdir(EVIDENCE_DIR, { recursive: true });

const observed: {
  mode: string;
  apiUrl: string;
  repo: string;
  deliveries: Array<{ what: string; status: number; body: unknown }>;
  replies: unknown;
  pullRequest: unknown;
  checks: Record<string, CheckRecord>;
} = {
  mode: MODE,
  apiUrl: API_URL,
  repo: REPO,
  deliveries: [],
  replies: null,
  pullRequest: null,
  checks: {},
};
const assert = makeChecker(observed);

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
const ledger = (): Ledger => readLedger(LEDGER, { requests: [], replies: [] });

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

/** Slack's `event_callback` for a message (or a mention), shaped as the Events API documents it. */
const payload = (over: {
  readonly type?: "message" | "app_mention";
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
  event_time: nowSeconds(),
  event: {
    type: over.type ?? "message",
    channel: over.channel ?? WATCHED,
    user: "U0ALICE",
    text: over.text ?? "Fix the widget\nIt wobbles when it spins.",
    ts: over.ts ?? ROOT_TS,
    ...(over.threadTs === undefined ? {} : { thread_ts: over.threadTs }),
    ...(over.botId === undefined ? {} : { bot_id: over.botId }),
  },
});

/**
 * One signed POST. `secret` is what the body is signed with (`null`: no signature at all), `at` the
 * timestamp it is signed for, and `tamper` changes the body after it was signed.
 */
const post = async (
  what: string,
  body: Record<string, unknown>,
  options: {
    readonly secret?: string | null;
    readonly at?: number;
    readonly tamper?: boolean;
  } = {},
): Promise<Answer> => {
  const raw = JSON.stringify(body);
  const timestamp = String(options.at ?? nowSeconds());
  const secret = options.secret === undefined ? SIGNING_SECRET : options.secret;
  const answer = await postRaw(
    `${API_URL}/webhooks/slack`,
    options.tamper === true ? `${raw} ` : raw,
    {
      "x-slack-request-timestamp": timestamp,
      ...(secret === null
        ? {}
        : { "x-slack-signature": slackSignature(raw, timestamp, secret) }),
    },
  );
  observed.deliveries.push({ what, status: answer.status, body: answer.body });
  return answer;
};

const firstMessage = (entries: ReadonlyArray<{ kind: string; text: string }>) =>
  entries.find((entry) => entry.kind === "user")?.text;

const program = Effect.gen(function* () {
  const client = yield* sessionClient;
  const sessionCount = sessionsOf(client, REPO);

  if (MODE === "unconfigured") {
    const before = yield* sessionCount;
    const message = yield* Effect.promise(() =>
      post("unset secret", payload({ ts: messageTs(20) }), { secret: "" }),
    );
    const handshake = yield* Effect.promise(() =>
      post(
        "unset secret, handshake",
        { type: "url_verification", challenge: "abc" },
        { secret: "" },
      ),
    );
    assert(
      "with SLACK_SIGNING_SECRET unset a delivery and the handshake are 503 not-configured, naming the variable",
      message.status === 503 &&
        handshake.status === 503 &&
        field(message, "code") === "not-configured" &&
        JSON.stringify(handshake.body).includes("SLACK_SIGNING_SECRET"),
      `status=${message.status}/${handshake.status} body=${JSON.stringify(message.body)}`,
    );
    const rows = yield* Effect.promise(() =>
      deliveryRows(DATABASE_URL, [
        `slack:${WATCHED}:${messageTs(20)}:${messageTs(20)}`,
      ]),
    );
    assert(
      "and they record no delivery and open no session",
      rows.length === 0 && (yield* sessionCount) === before,
      `rows=${rows.length} sessions=${before}→${yield* sessionCount}`,
    );
    return;
  }

  yield* client.registerRepo({ repo: REPO, defaultBaseRef: "main" });

  // 1: the handshake Slack makes when an operator enters the Request URL.
  const challenge = "3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P";
  const handshake = yield* Effect.promise(() =>
    post("handshake", { type: "url_verification", challenge }),
  );
  const strangers = yield* Effect.promise(() =>
    post(
      "handshake, unsigned",
      { type: "url_verification", challenge: "stranger" },
      { secret: null },
    ),
  );
  assert(
    "Slack's url_verification handshake is answered with its challenge; unsigned, it is refused",
    handshake.status === 200 &&
      field(handshake, "challenge") === challenge &&
      strangers.status === 401 &&
      !JSON.stringify(strangers.body).includes("stranger"),
    `handshake=${handshake.status} ${JSON.stringify(handshake.body)} unsigned=${strangers.status}`,
  );

  // 2 + 3: the signed message opens one real session carrying the message's own words.
  const created = yield* Effect.promise(() => post("created", payload({})));
  const sessionId = sessionIdOf(created);
  assert(
    "a signed message in a watched channel is processed and names the session",
    created.status === 200 &&
      field(created, "status") === "processed" &&
      sessionId !== undefined,
    `status=${created.status} body=${JSON.stringify(created.body)}`,
  );
  if (sessionId === undefined) {
    return yield* Effect.die(new Error("no session: the rest proves nothing"));
  }
  const read = yield* client.getSession({ sessionId });
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

  // 4: one reply, in the message's own thread, through Slack's own two calls.
  const afterCreate = ledger();
  const reply = afterCreate.replies[0];
  assert(
    "the write-back replied exactly once, in the message's thread, naming and linking the session",
    afterCreate.replies.length === 1 &&
      reply?.channel === WATCHED &&
      reply?.root === ROOT_TS &&
      reply.text.includes(sessionId) &&
      reply.text.includes(`http://localhost:3000/sessions/${sessionId}`),
    `replies=${afterCreate.replies.length} root=${String(reply?.root)} text=${String(reply?.text)}`,
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
      posts[0]?.authorization === "Bearer xoxb-drive-token",
    `methods=${afterCreate.requests.map((request) => request.method).join(",")} posts=${posts.length} auth=${String(posts[0]?.authorization).slice(0, 20)}…`,
  );

  // 5: Slack's retry of the same message carries a new `event_id`; it is the same delivery.
  const retried = yield* Effect.promise(() =>
    post("retried", payload({ eventId: "Ev0RETRY" })),
  );
  assert(
    "the same message again — a new event_id, a fresh signature — is a replay: one session, one reply",
    retried.status === 200 &&
      field(retried, "replayed") === true &&
      (yield* sessionCount) === 1 &&
      ledger().replies.length === 1,
    `status=${retried.status} replayed=${String(field(retried, "replayed"))} sessions=${yield* sessionCount} replies=${ledger().replies.length}`,
  );

  // 6: a delivery captured and replayed later is refused, and says so; one inside the window passes.
  const staleTs = messageTs(2);
  const stale = yield* Effect.promise(() =>
    post("stale", payload({ ts: staleTs }), {
      at: nowSeconds() - SLACK_REPLAY_WINDOW_SECONDS - 5,
    }),
  );
  const staleRows = yield* Effect.promise(() =>
    deliveryRows(DATABASE_URL, [`slack:${WATCHED}:${staleTs}:${staleTs}`]),
  );
  assert(
    "a delivery outside Slack's five-minute window is 401 outside-window and records nothing",
    stale.status === 401 &&
      field(stale, "code") === "outside-window" &&
      staleRows.length === 0 &&
      (yield* sessionCount) === 1,
    `status=${stale.status} code=${String(field(stale, "code"))} rows=${staleRows.length}`,
  );
  const insideTs = messageTs(3);
  const inside = yield* Effect.promise(() =>
    post("inside the window", payload({ ts: insideTs }), {
      at: nowSeconds() - SLACK_REPLAY_WINDOW_SECONDS + 20,
    }),
  );
  assert(
    "a delivery inside the window is accepted",
    inside.status === 200 && field(inside, "status") === "processed",
    `status=${inside.status} body=${JSON.stringify(inside.body)}`,
  );

  // 7: the two other ways a signature fails are told apart, and record nothing.
  const forgedTs = messageTs(4);
  const tampered = yield* Effect.promise(() =>
    post("tampered", payload({ ts: forgedTs }), { tamper: true }),
  );
  const unsigned = yield* Effect.promise(() =>
    post("unsigned", payload({ ts: forgedTs }), { secret: null }),
  );
  const forgedRows = yield* Effect.promise(() =>
    deliveryRows(DATABASE_URL, [`slack:${WATCHED}:${forgedTs}:${forgedTs}`]),
  );
  assert(
    "a body changed after signing is 401 bad-signature, no signature 401 missing-signature, and neither records a delivery",
    tampered.status === 401 &&
      field(tampered, "code") === "bad-signature" &&
      unsigned.status === 401 &&
      field(unsigned, "code") === "missing-signature" &&
      forgedRows.length === 0,
    `${String(field(tampered, "code"))} / ${String(field(unsigned, "code"))} rows=${forgedRows.length}`,
  );

  // 8: a message in a channel the filter does not watch creates nothing, and the skip says why.
  const sessionsBefore = yield* sessionCount;
  const unwatched = yield* Effect.promise(() =>
    post("unwatched", payload({ channel: UNWATCHED, ts: messageTs(5) })),
  );
  assert(
    "a message in a channel the filter does not watch is skipped, naming the filter",
    unwatched.status === 200 &&
      field(unwatched, "status") === "skipped" &&
      String(field(unwatched, "reason")).includes("filtered:channel") &&
      (yield* sessionCount) === sessionsBefore,
    `status=${unwatched.status} reason=${String(field(unwatched, "reason"))}`,
  );

  // 9: the loop guard — the bot's own message in a watched channel starts nothing.
  const repliesBefore = ledger().replies.length;
  const botMessage = yield* Effect.promise(() =>
    post(
      "bot",
      payload({
        ts: messageTs(6),
        text: "Factory started session 01J8ZOTHER for this message.",
        botId: "B0ACME",
      }),
    ),
  );
  assert(
    "a bot's own message in a watched channel starts nothing",
    botMessage.status === 200 &&
      field(botMessage, "status") === "skipped" &&
      String(field(botMessage, "reason")).includes("filtered:bot") &&
      (yield* sessionCount) === sessionsBefore &&
      ledger().replies.length === repliesBefore,
    `status=${botMessage.status} reason=${String(field(botMessage, "reason"))}`,
  );

  // 10: a message already in a thread is answered in that thread, not in a new one.
  const threaded = yield* Effect.promise(() =>
    post(
      "threaded",
      payload({
        ts: messageTs(8),
        threadTs: ROOT_TS,
        text: "Also the left widget wobbles.",
      }),
    ),
  );
  const threadedReply = ledger().replies.at(-1);
  assert(
    "a message in a thread is answered in that thread",
    threaded.status === 200 &&
      field(threaded, "status") === "processed" &&
      threadedReply?.root === ROOT_TS &&
      threadedReply.channel === WATCHED,
    `status=${threaded.status} root=${String(threadedReply?.root)}`,
  );

  // 11: an @mention is the same ask, and the message twin Slack sends for it is the same delivery.
  const mentionTs = messageTs(10);
  const countBeforeMention = yield* sessionCount;
  const mention = yield* Effect.promise(() =>
    post(
      "mention",
      payload({
        type: "app_mention",
        ts: mentionTs,
        threadTs: ROOT_TS,
        text: "<@U0FACTORY> please take this one",
      }),
    ),
  );
  const twin = yield* Effect.promise(() =>
    post(
      "mention's message twin",
      payload({
        ts: mentionTs,
        threadTs: ROOT_TS,
        text: "<@U0FACTORY> please take this one",
        eventId: "Ev0TWIN",
      }),
    ),
  );
  assert(
    "an @mention opens one session, and the message twin Slack sends for it is a replay",
    mention.status === 200 &&
      field(mention, "status") === "processed" &&
      twin.status === 200 &&
      field(twin, "replayed") === true &&
      (yield* sessionCount) === countBeforeMention + 1,
    `mention=${String(field(mention, "status"))} twin replayed=${String(field(twin, "replayed"))} sessions=${countBeforeMention}→${yield* sessionCount}`,
  );

  // 12: a signed payload that carries no event is answered, not retried.
  const limited = yield* Effect.promise(() =>
    post("app_rate_limited", {
      type: "app_rate_limited",
      minute_rate_limited: nowSeconds(),
    }),
  );
  assert(
    "a signed payload that carries no event is answered 200 and ignored",
    limited.status === 200 && field(limited, "ok") === true,
    `status=${limited.status} body=${JSON.stringify(limited.body)}`,
  );

  // 13: the reply landed and its acknowledgement did not (the fake records it, then answers 500).
  // The seam gives the claim back, so the sender's retry runs the delivery again — and must find its
  // own reply rather than posting a second one.
  const lost = payload({ ts: LOST_ACK_TS });
  const lostAttempt = yield* Effect.promise(() => post("lost ack", lost));
  assert(
    "a delivery whose reply landed but whose answer was lost is 500 write-back",
    lostAttempt.status === 500 && field(lostAttempt, "code") === "write-back",
    `status=${lostAttempt.status} body=${JSON.stringify(lostAttempt.body)}`,
  );
  const beforeRetry = yield* sessionCount;
  const retry = yield* Effect.promise(() => post("lost ack, retried", lost));
  const retryLedger = ledger();
  const gets = retryLedger.requests.filter(
    (request) =>
      request.method === "GET" && request.query.includes(`ts=${LOST_ACK_TS}`),
  ).length;
  const inThread = retryLedger.replies.filter(
    (entry) => entry.root === LOST_ACK_TS,
  ).length;
  assert(
    "the retry is processed, reads the thread before it replies, posts no second reply, and reuses the session",
    retry.status === 200 &&
      field(retry, "status") === "processed" &&
      gets >= 2 &&
      inThread === 1 &&
      (yield* sessionCount) === beforeRetry,
    `status=${retry.status} gets=${gets} repliesInThread=${inThread} sessions=${beforeRetry}→${yield* sessionCount}`,
  );

  // 14: the session's PR is opened over RPC (the fake GitHub answers), and its link is posted in the
  // thread of the message that started the session — once, however often the step is asked.
  const opened = yield* client.openPullRequest({
    sessionId,
    title: "factory: the widget",
  });
  const prUrl =
    opened.outcome === "opened" || opened.outcome === "already-open"
      ? opened.url
      : undefined;
  observed.pullRequest = opened;
  const threadReplies = yield* waitUntil(
    Effect.sync(() => {
      const replies = ledger().replies.filter(
        (entry) => entry.root === ROOT_TS && entry.text.includes(prUrl ?? "?"),
      );
      return replies.length > 0 ? replies : undefined;
    }),
    "the PR's link in the thread",
  );
  const again = yield* client.openPullRequest({
    sessionId,
    title: "factory: the widget",
  });
  yield* Effect.sleep(1500);
  const prReplies = ledger().replies.filter(
    (entry) => entry.root === ROOT_TS && entry.text.includes(prUrl ?? "?"),
  );
  assert(
    "the PR's link is posted in the thread that started the session, once, and a repeat of the step posts nothing",
    opened.outcome === "opened" &&
      again.outcome === "already-open" &&
      threadReplies.length === 1 &&
      prReplies.length === 1 &&
      (threadReplies[0]?.text ?? "").includes("pull request"),
    `outcome=${opened.outcome}/${again.outcome} url=${String(prUrl)} replies=${prReplies.length}`,
  );
  const github = readLedger<{
    readonly pulls: ReadonlyArray<{ readonly url: string }>;
  }>(GITHUB_LEDGER, { pulls: [] });
  assert(
    "and the PR is the fake GitHub's one PR for the session's repo",
    github.pulls.filter((pull) => pull.url.includes(`/${REPO}/pull/`))
      .length === 1,
    `pulls=${github.pulls.length}`,
  );

  observed.replies = ledger().replies;
});

const exit = await Effect.runPromiseExit(
  program.pipe(Effect.provide(protocolFor(API_URL)), Effect.scoped),
);
if (exit._tag === "Failure") console.error(exit.cause);

const checks = Object.values(observed.checks);
const failed = checks.filter((check) => !check.passed).length;
await writeFile(
  path.join(EVIDENCE_DIR, `slack-${MODE}-observed.json`),
  `${JSON.stringify({ ...observed, failed }, null, 2)}\n`,
);
console.log(
  `\nslack (${MODE}): ${checks.length - failed}/${checks.length} checks passed — evidence in ${EVIDENCE_DIR}`,
);
process.exit(failed === 0 && exit._tag === "Success" ? 0 : 1);
