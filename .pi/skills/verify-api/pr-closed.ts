// A card's PR closed without merging, then a new run on the card (F12), driven against the service
// itself and the loopback GitHub fake (./github-fake.ts), whose ledger `./pr-closed.sh` reads back.
//
// 1. The card's first building run commits a change, and its PR step opens the card's PR on the fake.
// 2. A person closes the PR in GitHub (the fake's own `PATCH .../pulls/:number`), and GitHub's signed
//    `pull_request` closed delivery reaches the factory — here, the same two functions
//    `POST /webhooks/github` runs on it (`recordMergedDelivery`, `settleCardsOfDelivery`), signed with
//    the drive's own secret. The close is recorded on the run's session (`pr_closed_at`) and the card
//    is blocked `pr_closed` (C20).
// 3. A person unblocks the card and starts another building run. It continues the card's branch
//    (C19), and its PR step opens a fresh PR from it instead of adopting the closed one.
// 4. A third run, with that new PR open, adopts it (`already-open`) and asks GitHub for nothing.
//
// Env: DATABASE_URL (via DatabaseLive), GITHUB_API_URL (the fake), GH_FAKE_URL (the same, for the
// person's close), SESSION_ROOT, CHECKOUT (a git repository the runs are cut from), PR_CLOSED_REPO,
// EVIDENCE_DIR. Exits non-zero when a check fails.
import { BunServices } from "@effect/platform-bun";
import { createHmac } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Effect, Layer, ManagedRuntime, Option, Redacted } from "effect";
import { FetchHttpClient } from "effect/http";
import { SqlClient } from "effect/sql/SqlClient";
import { RepoSlug, type SessionId } from "@repo/domain/Session";
import {
  BoardInstanceId,
  DEFAULT_DEFINITION_ID,
  DefinitionId,
} from "@repo/domain/Task";
import { createFauxModelAccess } from "@repo/harness";
import { DatabaseLive } from "@repo/storage-postgres";
import {
  CredentialProvider,
  recordMergedDelivery,
  SessionService,
  SessionServiceLive,
  settleCardsOfDelivery,
  staticTokenProvider,
  TaskService,
  TaskServiceLive,
} from "@repo/core";
import { makeChecker } from "./harness.ts";
import type { CheckRecord } from "./harness.ts";

const SESSION_ROOT =
  process.env["SESSION_ROOT"] ?? ".verify/run/pr-closed/sessions";
const CHECKOUT = process.env["CHECKOUT"] ?? ".verify/run/pr-closed/checkout";
const GH_FAKE_URL = process.env["GH_FAKE_URL"] ?? "http://127.0.0.1:9411";
const REPO = RepoSlug.make(
  process.env["PR_CLOSED_REPO"] ?? "lobiklukas/factory-pr-closed",
);
const EVIDENCE_DIR =
  process.env["EVIDENCE_DIR"] ?? ".verify/evidence/latest/api";
/** The drive's own webhook secret: it signs the delivery and checks it, nothing else reads it. */
const SECRET = "pr-closed-drive-secret";

await mkdir(EVIDENCE_DIR, { recursive: true });

const observed: {
  taskId: string | null;
  runs: Array<string>;
  first: unknown;
  closedOnForge: unknown;
  recorded: unknown;
  settled: unknown;
  second: unknown;
  third: unknown;
  checks: Record<string, CheckRecord>;
} = {
  taskId: null,
  runs: [],
  first: null,
  closedOnForge: null,
  recorded: null,
  settled: null,
  second: null,
  third: null,
  checks: {},
};
const check = makeChecker(observed);

/** Each run's one command: commit one more numbered file than the branch holds. */
const COMMAND = [
  "n=$(ls change-*.txt 2>/dev/null | wc -l | tr -d ' ')",
  "n=$((n+1))",
  'echo "change $n" > "change-$n.txt"',
  'git add -A && git -c user.email=pr-closed@localhost -c user.name=pr-closed commit -qm "pr-closed change $n"',
  "echo faux-ok",
].join("; ");

const runtime = ManagedRuntime.make(
  TaskServiceLive.pipe(
    Layer.provideMerge(
      SessionServiceLive({
        model: createFauxModelAccess({ fauxCommand: COMMAND }).access,
        sessionRoot: SESSION_ROOT,
      }),
    ),
    Layer.provideMerge(Layer.mergeAll(DatabaseLive, BunServices.layer)),
  ),
);

const github = Layer.merge(
  Layer.succeed(
    CredentialProvider,
    staticTokenProvider(Option.some(Redacted.make("pr-closed-fake-token"))),
  ),
  FetchHttpClient.layer,
);

const waitSettled = (sessionId: SessionId) =>
  Effect.gen(function* () {
    const sessions = yield* SessionService;
    for (let attempt = 0; attempt < 600; attempt += 1) {
      const snapshot = yield* sessions.get(sessionId);
      if (
        !snapshot.live.busy &&
        snapshot.entries.some((entry) => entry.kind === "assistant")
      )
        return;
      yield* Effect.sleep(50);
    }
    return yield* Effect.die(new Error(`run ${sessionId} never settled`));
  });

/** One building run on the card: started, sent its prompt, settled, and its PR step called. */
const runAndStep = (taskId: string, prompt: string) =>
  Effect.gen(function* () {
    const sessions = yield* SessionService;
    const run = yield* sessions.create({ taskId, taskColumn: "building" });
    observed.runs.push(run.id);
    yield* sessions.send({ sessionId: run.id, content: prompt });
    yield* waitSettled(run.id);
    const step = yield* sessions
      .openPullRequest({ sessionId: run.id, title: "pr-closed probe" })
      .pipe(Effect.provide(github));
    const snapshot = yield* sessions.get(run.id);
    return {
      sessionId: run.id,
      step,
      branch: snapshot.workspace.branch ?? `factory/${run.id}`,
    };
  });

/** The person's close in GitHub: the fake's `PATCH .../pulls/:number`, recorded for its reads. */
const closeOnForge = async (number: number) => {
  const response = await fetch(`${GH_FAKE_URL}/repos/${REPO}/pulls/${number}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ state: "closed" }),
  });
  return {
    status: response.status,
    body: (await response.json().catch(() => null)) as {
      state?: string;
    } | null,
  };
};

const sign = (raw: string) =>
  `sha256=${createHmac("sha256", SECRET).update(raw).digest("hex")}`;

const drive = Effect.gen(function* () {
  const sessions = yield* SessionService;
  const tasks = yield* TaskService;
  const sql = yield* SqlClient;
  yield* sessions.registerRepo({ repo: REPO, localPath: CHECKOUT });
  const board = yield* tasks.createBoard({
    repo: REPO,
    definitionId: DefinitionId.make(DEFAULT_DEFINITION_ID),
  });
  const card = yield* tasks.create({
    boardId: BoardInstanceId.make(board.id),
    title: "pr-closed probe",
    actor: "person:pr-closed",
  });
  observed.taskId = card.id;
  // Seated in building by the row: the walk there is verify-board's, not this drive's.
  yield* sql`UPDATE tasks SET "column" = 'building' WHERE id = ${card.id}`;

  // 1. The card's PR.
  const first = yield* runAndStep(card.id, "build it");
  observed.first = first;
  const firstPr = first.step.outcome === "opened" ? first.step : undefined;
  check(
    "the card's first run opens the card's PR on the fake",
    firstPr !== undefined,
    JSON.stringify(first.step),
  );
  if (firstPr === undefined) return;

  // 2. Closed in GitHub, and GitHub's signed delivery of the close.
  const closed = yield* Effect.promise(() => closeOnForge(firstPr.number));
  observed.closedOnForge = closed;
  check(
    "the person's close in GitHub is recorded on the fake",
    closed.status === 200 && closed.body?.state === "closed",
    `status=${closed.status} state=${String(closed.body?.state)}`,
  );
  const raw = JSON.stringify({
    action: "closed",
    number: firstPr.number,
    pull_request: {
      number: firstPr.number,
      html_url: firstPr.url,
      url: `https://api.github.com/repos/${REPO}/pulls/${firstPr.number}`,
      state: "closed",
      merged: false,
      merged_at: null,
      closed_at: "2026-10-28T12:00:00Z",
    },
    repository: { full_name: REPO, default_branch: "main" },
  });
  const delivery = { secret: SECRET, raw, signature: sign(raw) };
  const recorded = yield* recordMergedDelivery(delivery);
  const settled = yield* settleCardsOfDelivery(delivery);
  observed.recorded = recorded;
  observed.settled = settled;
  const row = yield* sql<{ closedAt: string | null }>`
    SELECT to_char(pr_closed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS closed_at
    FROM sessions WHERE id = ${first.sessionId}
  `;
  check(
    "the signed close is recorded on the run's session (pr_closed_at)",
    recorded.closed === 1 && row[0]?.closedAt === "2026-10-28T12:00:00Z",
    `recorded=${JSON.stringify(recorded)} pr_closed_at=${String(row[0]?.closedAt)}`,
  );
  const blocked = yield* tasks.get(card.id);
  check(
    "and it blocks the card pr_closed (C20)",
    settled.blocked === 1 && blocked.blocked?.reason === "pr_closed",
    `settled=${JSON.stringify(settled)} blocked=${String(blocked.blocked?.reason)}`,
  );

  // 3. Unblocked by a person, and a new run on the card.
  yield* tasks.unblock({
    taskId: card.id,
    expectedRevision: blocked.revision,
    actor: "person:pr-closed",
  });
  const second = yield* runAndStep(card.id, "try again");
  observed.second = second;
  check(
    "the next run continues the card's branch",
    second.branch === first.branch,
    `first=${first.branch} second=${second.branch}`,
  );
  const secondPr = second.step.outcome === "opened" ? second.step : undefined;
  check(
    "and opens a new PR from it rather than adopting the closed one",
    secondPr !== undefined &&
      secondPr.url !== firstPr.url &&
      secondPr.number !== firstPr.number,
    JSON.stringify(second.step),
  );

  // 4. With the new PR open, a later run adopts it.
  const third = yield* runAndStep(card.id, "polish it");
  observed.third = third;
  check(
    "a later run with the new PR open adopts it (already-open)",
    third.step.outcome === "already-open" &&
      secondPr !== undefined &&
      "url" in third.step &&
      third.step.url === secondPr.url,
    JSON.stringify(third.step),
  );
});

await runtime
  .runPromise(
    drive.pipe(
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          check("the drive ran", false, String(cause));
        }),
      ),
    ),
  )
  .finally(() => runtime.dispose());

await writeFile(
  path.join(EVIDENCE_DIR, "pr-closed.json"),
  `${JSON.stringify(observed, null, 2)}\n`,
);
process.exit(Object.values(observed.checks).some((c) => !c.passed) ? 1 : 0);
