// Two API processes over one database, one owning a session and one not, both streaming it live
// (LOB-18, D12). Started by ./follow.sh, which owns both processes and passes the owner's pid, so
// this driver can stop the owner at the moment the story needs it to.
//
//   1. The owner creates a session; the follower attaches with `watchSession`. Its snapshot says
//      `live` though the follower owns nothing — the owner's presence lease says somebody does.
//   2. `getSession` on the follower reads `live` too; `sendMessage` there is refused as
//      `owned_elsewhere`: work goes where the session is owned.
//   3. A message to the owner runs; the follower's stream carries every entry the owner's transcript
//      holds, once each, and the run's start and end, as the owner's own stream would.
//   4. The owner is stopped (SIGTERM, so its shutdown releases its lease); the follower's stream ends
//      and a read is a fold again, the same transcript. A message to the follower now runs there: the
//      session changed hands, and the transcript carries on.
//
// Env: OWNER_URL, FOLLOWER_URL, OWNER_PID, EVIDENCE_DIR.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { SessionRpc } from "@repo/domain/Rpc";
import type { SessionEvent, SessionId } from "@repo/domain/Session";
import { Effect, Exit, Fiber, Layer, Stream } from "effect";
import { RpcClient } from "effect/rpc";
import { makeChecker, protocolFor, waitUntil } from "./harness.ts";
import type { CheckRecord } from "./harness.ts";

const OWNER_URL = process.env["OWNER_URL"] ?? "http://127.0.0.1:9510";
const FOLLOWER_URL = process.env["FOLLOWER_URL"] ?? "http://127.0.0.1:9511";
const OWNER_PID = Number(process.env["OWNER_PID"] ?? "0");
const EVIDENCE_DIR =
  process.env["EVIDENCE_DIR"] ?? ".verify/evidence/latest/api";

const PROMPT = "follow me from elsewhere";
const AFTER = "and now here";

await mkdir(EVIDENCE_DIR, { recursive: true });

const observed: {
  ownerUrl: string;
  followerUrl: string;
  sessionId: SessionId | null;
  streamed: ReadonlyArray<{ readonly tag: string; readonly detail: string }>;
  checks: Record<string, CheckRecord>;
} = {
  ownerUrl: OWNER_URL,
  followerUrl: FOLLOWER_URL,
  sessionId: null,
  streamed: [],
  checks: {},
};
const assert = makeChecker(observed);

/** One RPC client per API, each over a protocol built in the drive's own scope. */
const clientFor = (url: string) =>
  Effect.gen(function* () {
    const protocol = yield* Layer.build(protocolFor(url));
    return yield* RpcClient.make(SessionRpc).pipe(Effect.provide(protocol));
  });

/** The transcript a stream told its client: the snapshot's entries, then every entry event. */
const transcriptOf = (events: ReadonlyArray<SessionEvent>) =>
  events.flatMap((event) =>
    event._tag === "snapshot"
      ? event.entries.map((entry) => entry.id)
      : event._tag === "entry"
        ? [event.entry.id]
        : [],
  );

const describeEvent = (event: SessionEvent): string => {
  switch (event._tag) {
    case "snapshot":
      return `mode=${event.session.mode} status=${event.session.status} entries=${event.entries.length}`;
    case "entry":
      return `${event.entry.id} ${event.entry.kind}`;
    case "status":
      return event.status;
    case "live":
      return `busy=${event.live.busy}`;
    default:
      return "";
  }
};

const drive = Effect.gen(function* () {
  const owner = yield* clientFor(OWNER_URL);
  const follower = yield* clientFor(FOLLOWER_URL);

  const created = yield* owner.createSession({ title: PROMPT });
  observed.sessionId = created.id;

  const events: SessionEvent[] = [];
  const watching = yield* follower.watchSession({ sessionId: created.id }).pipe(
    Stream.runForEach((event) =>
      Effect.sync(() => {
        events.push(event);
      }),
    ),
    Effect.forkChild,
  );
  const first = yield* waitUntil(
    Effect.sync(() => events[0]),
    "the follower's snapshot",
  );
  assert(
    "the follower's stream starts live, though another process owns the session",
    first._tag === "snapshot" && first.session.mode === "live",
    describeEvent(first),
  );

  const followedRead = yield* follower.getSession({ sessionId: created.id });
  assert(
    "a read on the follower is live too",
    followedRead.session.mode === "live",
    `mode=${followedRead.session.mode}`,
  );
  const refused = yield* Effect.exit(
    follower.sendMessage({ sessionId: created.id, content: "not here" }),
  );
  const refusal =
    Exit.isFailure(refused) && refused.cause.reasons[0]?._tag === "Fail"
      ? refused.cause.reasons[0].error
      : undefined;
  assert(
    "work sent to the follower is refused as owned elsewhere",
    refusal !== undefined &&
      "code" in refusal &&
      refusal.code === "owned_elsewhere",
    refusal === undefined ? "accepted" : String(refusal.message),
  );

  yield* owner.sendMessage({ sessionId: created.id, content: PROMPT });
  const settled = yield* waitUntil(
    owner
      .getSession({ sessionId: created.id })
      .pipe(
        Effect.map(
          (snapshot) =>
            !snapshot.live.busy &&
            snapshot.entries.at(-1)?.kind === "assistant" &&
            snapshot,
        ),
      ),
    "the owner's run to settle",
  );
  yield* waitUntil(
    Effect.sync(
      () =>
        transcriptOf(events).length >= settled.entries.length &&
        events.some(
          (event) => event._tag === "status" && event.status === "idle",
        ),
    ),
    "the follower to catch up",
  );
  const streamed = transcriptOf(events);
  const expected = settled.entries.map((entry) => entry.id);
  assert(
    "the follower streamed the owner's transcript entry for entry, each once",
    JSON.stringify(streamed) === JSON.stringify(expected),
    `follower=${streamed.length} owner=${expected.length}`,
  );
  const users = events.flatMap((event) =>
    event._tag === "entry" && event.entry.kind === "user"
      ? [event.entry.text]
      : [],
  );
  assert(
    "the message the owner took reached the follower as an entry event",
    users.length === 1 && users[0] === PROMPT,
    JSON.stringify(users),
  );
  const statuses = events.flatMap((event) =>
    event._tag === "status" ? [event.status] : [],
  );
  assert(
    "the follower saw the run start and stop",
    JSON.stringify(statuses) === JSON.stringify(["busy", "idle"]),
    JSON.stringify(statuses),
  );

  // The owner goes away the way a replica is replaced: SIGTERM, whose shutdown gives its lease back.
  process.kill(OWNER_PID, "SIGTERM");
  const ended = yield* Fiber.await(watching).pipe(
    Effect.timeout("30 seconds"),
    Effect.exit,
  );
  assert(
    "the follower's stream ends once the owner has let go",
    Exit.isSuccess(ended) && Exit.isSuccess(ended.value),
    Exit.isSuccess(ended) ? "ended" : "still streaming after 30s",
  );
  observed.streamed = events.map((event) => ({
    tag: event._tag,
    detail: describeEvent(event),
  }));

  const folded = yield* follower.getSession({ sessionId: created.id });
  assert(
    "with nobody owning it, the follower reads a fold of the same transcript",
    folded.session.mode === "historical" &&
      JSON.stringify(folded.entries.map((entry) => entry.id)) ===
        JSON.stringify(expected),
    `mode=${folded.session.mode} entries=${folded.entries.length}`,
  );

  yield* follower.sendMessage({ sessionId: created.id, content: AFTER });
  const continued = yield* waitUntil(
    follower
      .getSession({ sessionId: created.id })
      .pipe(
        Effect.map(
          (snapshot) =>
            snapshot.session.mode === "live" &&
            !snapshot.live.busy &&
            snapshot.entries.at(-1)?.kind === "assistant" &&
            snapshot.entries.some(
              (entry) => entry.kind === "user" && entry.text === AFTER,
            ) &&
            snapshot,
        ),
      ),
    "the follower's own run to settle",
  );
  assert(
    "the session changed hands: the former follower owns it and the transcript carries on",
    continued.session.mode === "live" &&
      expected.every((id, index) => continued.entries[index]?.id === id),
    `entries=${continued.entries.length}`,
  );
  return created.id;
});

try {
  await Effect.runPromise(drive.pipe(Effect.scoped));
} catch (error) {
  assert("the drive completed", false, `threw: ${String(error)}`);
}

await writeFile(
  path.join(EVIDENCE_DIR, "follow.json"),
  `${JSON.stringify(observed, null, 2)}\n`,
);

const failed = Object.entries(observed.checks).filter(
  ([, check]) => !check.passed,
);
if (failed.length > 0) {
  console.error(`\n${failed.length} required check(s) failed`);
  process.exitCode = 1;
}
