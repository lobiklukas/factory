// The PR step across a kill (LOB-179), driven against the service itself.
//
//   MODE=arm        create a session and call the step; the fake GitHub holds the request open, so
//                   the process is inside the call. ./pr-once.sh kills it there — after the request
//                   landed, before any acknowledgement could be recorded.
//   MODE=reopen     a fresh process, same database and session root: call the step again for the
//                   same session. The replayed step must land on the PR GitHub already has, leave
//                   exactly one `prOpened` in the log, and reach the log at all — the first
//                   process died before it could commit anything.
//   MODE=second     a genuinely second session, with its own head: it opens a second PR, because
//                   the guard is the session's log, not a global lock.
//
// The non-vacuity of that check is a mutation run, recorded in `.verify/evidence/lob-179/`:
// removing the recorded-document read from `prStep.ts` makes the replay's repeat post a second
// time and the script exit non-zero. A control call made from here would prove nothing — it would
// reach GitHub whether or not the step still held its guard.
//
// The service is the real one, on the run's Postgres and session root; only GitHub is a loopback
// fake (./github-fake.ts). Nothing here calls api.github.com.
//
// Env: MODE, PR_ONCE_STATE (the session id file), DATABASE_URL (via DatabaseLive), SESSION_ROOT,
// PR_ONCE_REPO, EVIDENCE_DIR.
import { BunServices } from "@effect/platform-bun";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Effect, Layer, ManagedRuntime, Option, Redacted } from "effect";
import { FetchHttpClient } from "effect/http";
import { RepoSlug as RepoSlugSchema } from "@repo/domain/Session";
import type { SessionId } from "@repo/domain/Session";
import { createModelAccess } from "@repo/harness";
import { DatabaseLive } from "@repo/storage-postgres";
import {
  CredentialProvider,
  SessionService,
  SessionServiceLive,
  type SessionServiceShape,
  staticTokenProvider,
} from "@repo/core";
import { makeChecker } from "./harness.ts";
import type { CheckRecord } from "./harness.ts";

const MODE = process.env["MODE"] ?? "arm";
const STATE = process.env["PR_ONCE_STATE"] ?? ".verify/run/pr-once/session-id";
const SESSION_ROOT =
  process.env["SESSION_ROOT"] ?? ".verify/run/pr-once/sessions";
const REPO = RepoSlugSchema.make(
  process.env["PR_ONCE_REPO"] ?? "lobiklukas/factory",
);
const EVIDENCE_DIR =
  process.env["EVIDENCE_DIR"] ?? ".verify/evidence/latest/api";
const TASK = "pr-once probe";

/** The head a session pushes: derived from the id, so both processes spell it the same way. */
const headFor = (sessionId: SessionId): string => `factory/${sessionId}`;

await mkdir(path.dirname(STATE), { recursive: true });
await mkdir(EVIDENCE_DIR, { recursive: true });

const observed: {
  mode: string;
  sessionId: SessionId | null;
  secondSessionId: SessionId | null;
  opened: { number: number; url: string; outcome: string } | null;
  repeated: { number: number; url: string; outcome: string } | null;
  prOpened: number;
  checks: Record<string, CheckRecord>;
} = {
  mode: MODE,
  sessionId: null,
  secondSessionId: null,
  opened: null,
  repeated: null,
  prOpened: 0,
  checks: {},
};
const assert = makeChecker(observed);

/**
 * The real session service over the run's database and session root, and a static token for GitHub
 * — the same provider `apps/api` wires (`CredentialProviderLive`), just with a value the fake never
 * reads. The fake is reached through `GITHUB_API_URL`, which `./pr-once.sh` points at loopback.
 */
const runtime = ManagedRuntime.make(
  SessionServiceLive({
    model: createModelAccess("faux"),
    sessionRoot: SESSION_ROOT,
  }).pipe(Layer.provideMerge(Layer.mergeAll(DatabaseLive, BunServices.layer))),
);

const github = Layer.merge(
  Layer.succeed(
    CredentialProvider,
    staticTokenProvider(Option.some(Redacted.make("pr-once-fake-token"))),
  ),
  FetchHttpClient.layer,
);

const readState = Effect.promise(() =>
  readFile(STATE, "utf8").then((value) => value.trim() as SessionId),
);

/**
 * The `prOpened` entries a folded transcript holds.
 *
 * The PR entry carries no model content (the agent never sees it), so the fold projects it as
 * `other` with empty text — that is the *only* entry of this shape a session here can hold, which
 * is what makes the count a count of `prOpened` entries rather than a guess. The exactly-once
 * emission itself is a harness case (`session.test.ts`); this counts it on a real log.
 */
const prEntries = (
  entries: ReadonlyArray<{ readonly kind: string; readonly text: string }>,
): number =>
  entries.filter((entry) => entry.kind === "other" && entry.text === "").length;

/**
 * One PR step, narrowed to the PR it answers. Every phase here has a diff under the cap, so an
 * `over-cap` or `no-change` answer is the step refusing work it should have done: the phase dies
 * with it rather than reading a number and a link that answer does not carry.
 */
const step = (sessions: SessionServiceShape, sessionId: SessionId) =>
  sessions
    .openPullRequest({
      sessionId,
      title: TASK,
      head: headFor(sessionId),
      base: "main",
    })
    .pipe(
      Effect.provide(github),
      Effect.flatMap((answer) =>
        answer.outcome === "opened" || answer.outcome === "already-open"
          ? Effect.succeed(answer)
          : Effect.die(
              new Error(`the PR step answered ${JSON.stringify(answer)}`),
            ),
      ),
    );

const arm = Effect.gen(function* () {
  const sessions = yield* SessionService;
  const created = yield* sessions.create({
    repo: REPO,
    baseRef: "main",
    title: TASK,
  });
  observed.sessionId = created.id;
  yield* Effect.promise(() => writeFile(STATE, created.id));
  console.log(
    `armed ${created.id}: calling GitHub — the kill is safe once the ledger shows the POST`,
  );
  // Held open by the fake; the process is killed here, so nothing after this line runs.
  const opened = yield* step(sessions, created.id);
  console.log(`the call returned after all: ${JSON.stringify(opened)}`);
});

const reopen = Effect.gen(function* () {
  const sessions = yield* SessionService;
  const sessionId = yield* readState;
  observed.sessionId = sessionId;

  const reopened = yield* sessions.get(sessionId);
  assert(
    "the killed process left a session a fresh process can read",
    reopened.session.id === sessionId,
    `status=${reopened.session.status} entries=${reopened.entries.length}`,
  );
  assert(
    "and it recorded no PR of its own: the first attempt died before its commit",
    prEntries(reopened.entries) === 0 && reopened.session.prUrl === undefined,
    `prUrl=${String(reopened.session.prUrl)} prOpened=${prEntries(reopened.entries)}`,
  );

  const opened = yield* step(sessions, sessionId);
  observed.opened = opened;

  assert(
    "and it says it made the GitHub call, rather than reading a record (LOB-212)",
    opened.outcome === "opened",
    `outcome=${opened.outcome}`,
  );
  const after = yield* sessions.get(sessionId);
  observed.prOpened = prEntries(after.entries);

  assert(
    "the replayed step answers the PR GitHub already had",
    opened.number > 0 && opened.url.includes("/pull/"),
    `number=${opened.number} url=${opened.url}`,
  );
  assert(
    "the session's log holds exactly one prOpened entry",
    observed.prOpened === 1,
    `${observed.prOpened} entries of that shape`,
  );
  assert(
    "the index carries the same link",
    after.session.prUrl === opened.url,
    `prUrl=${String(after.session.prUrl)}`,
  );

  // The same step again, in the same process: the record now exists, so it is read and nothing is
  // asked of GitHub (the shell counts the requests the fake saw).
  const repeated = yield* step(sessions, sessionId);
  observed.repeated = repeated;
  assert(
    "a repeated step returns the same PR",
    repeated.number === opened.number && repeated.url === opened.url,
    `number=${repeated.number} url=${repeated.url}`,
  );
  // The tag is what a caller could not get before it: the repeat is answered by the log, so the
  // link is the same and the path is not.
  assert(
    "and the repeat is tagged already-open: the log answered it, GitHub was not asked (LOB-212)",
    repeated.outcome === "already-open",
    `outcome=${repeated.outcome}`,
  );
  const settled = yield* sessions.get(sessionId);
  assert(
    "and it adds no second prOpened entry",
    prEntries(settled.entries) === 1,
    `${prEntries(settled.entries)} entries of that shape`,
  );
});

const second = Effect.gen(function* () {
  const sessions = yield* SessionService;
  const first = yield* readState;
  observed.sessionId = first;

  const another = yield* sessions.create({
    repo: REPO,
    baseRef: "main",
    title: `${TASK} (second session)`,
  });
  observed.secondSessionId = another.id;
  const opened = yield* step(sessions, another.id);
  observed.opened = opened;

  const itsOwn = yield* sessions.get(another.id);
  assert(
    "a second session opens a PR of its own",
    opened.number !== 1 && opened.url.includes(`/pull/${opened.number}`),
    `number=${opened.number} url=${opened.url} first=${first}`,
  );
  assert(
    "and records it in its own log, exactly once",
    prEntries(itsOwn.entries) === 1,
    `prUrl=${String(itsOwn.session.prUrl)} prOpened=${prEntries(itsOwn.entries)}`,
  );
  // The guard is the session's own log, so this session had nothing recorded to read: it is
  // `opened` on the same branch the first session already opened a PR from (LOB-212).
  assert(
    "and it is tagged opened for its own call, not borrowed from the first session's record",
    opened.outcome === "opened",
    `outcome=${opened.outcome}`,
  );
  // The first session is untouched by the second one's step.
  const firstSession = yield* sessions.get(first);
  assert(
    "the first session's log is unchanged by it",
    prEntries(firstSession.entries) === 1,
    `${prEntries(firstSession.entries)} entries of that shape`,
  );
});

const phase = MODE === "arm" ? arm : MODE === "reopen" ? reopen : second;

try {
  await runtime.runPromise(phase);
} catch (error) {
  assert(`${MODE} phase completed`, false, `threw: ${String(error)}`);
} finally {
  await runtime.dispose();
}

await writeFile(
  path.join(EVIDENCE_DIR, `pr-once-${MODE}.json`),
  `${JSON.stringify(observed, null, 2)}\n`,
);

const failed = Object.entries(observed.checks).filter(
  ([, check]) => !check.passed,
);
if (failed.length > 0) {
  console.error(`\n${failed.length} required check(s) failed (${MODE})`);
  process.exitCode = 1;
}
