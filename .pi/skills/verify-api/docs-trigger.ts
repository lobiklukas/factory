// A push and a schedule start a docs run (LOB-197, part 3 of LOB-37).
//
//   bun docs-trigger.ts
//
// What this drives, and why it is not a unit test: the seam, the docs session port, the real
// `SessionService` on the run's `DATABASE_URL`, a real git worktree cut on `factory/doc-<id>`, and
// the real PR step over a loopback GitHub fake whose ledger is a file. Only GitHub and the model are
// fakes, and both are in-process: nothing here reaches a network or needs a key.
//
// Three phases, each with its own assertions:
//
//   1. push     — one GitHub `push` delivery to the default branch, twice. Exactly one session, the
//                 second answer a replay, the worktree really on `factory/doc-<id>` (git says so),
//                 and the PR step opens one PR whose head is that branch and whose base is `main`.
//   2. schedule — the interval schedule on a shortened clock starts one session per interval, and
//                 the same disabled clock starts nothing.
//   3. ledger   — every request GitHub received, read from the fake: the PR create and (at most) its
//                 lookup, nothing that writes a ref or a file, and never `main` as a head.
//
// Env: DATABASE_URL, SESSION_ROOT, DOCS_TRIGGER_REPO_DIR, DOCS_TRIGGER_REPO, EVIDENCE_DIR,
// GITHUB_API_URL, GITHUB_FAKE_LEDGER.
import { BunServices } from "@effect/platform-bun";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Effect, Fiber, Layer, ManagedRuntime, Option, Redacted } from "effect";
import { FetchHttpClient } from "effect/http";
import { SqlClient } from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import { RepoSlug as RepoSlugSchema } from "@repo/domain/Session";
import type { SessionError, SessionId } from "@repo/domain/Session";
import type { TriggerDelivery } from "@repo/domain/Trigger";
import { createModelAccess } from "@repo/harness";
import { DatabaseLive } from "@repo/storage-postgres";
import {
  type CredentialError,
  CredentialProvider,
  DocsSessionsFromSessionService,
  type PrError,
  SessionService,
  SessionServiceLive,
  NoWriteBack,
  TriggerService,
  TriggerServiceLive,
  docsPushDelivery,
  docsSchedule,
  docsTriggerRules,
  staticTokenProvider,
} from "@repo/core";
import { makeChecker } from "./harness.ts";
import type { CheckRecord } from "./harness.ts";

const SESSION_ROOT =
  process.env["SESSION_ROOT"] ?? ".verify/run/docs-trigger/sessions";
// Absolute, because `registerRepo` refuses a relative checkout (LOB-253).
const REPO_DIR = path.resolve(
  process.env["DOCS_TRIGGER_REPO_DIR"] ?? ".verify/run/docs-trigger/repo",
);
const REPO = RepoSlugSchema.make(
  process.env["DOCS_TRIGGER_REPO"] ?? "lobiklukas/factory",
);
const EVIDENCE_DIR =
  process.env["EVIDENCE_DIR"] ?? ".verify/evidence/latest/api";
const LEDGER = process.env["GITHUB_FAKE_LEDGER"] ?? "";

/** The commit the push names: the repo's own HEAD, so the branch is cut from something real. */
const headCommit = execSync("git rev-parse HEAD", { cwd: REPO_DIR })
  .toString()
  .trim();

/** The GitHub `push` body, as GitHub sends one for a push to `main`. */
const pushPayload = (sha: string) => ({
  ref: "refs/heads/main",
  before: "0".repeat(40),
  after: sha,
  deleted: false,
  repository: { full_name: REPO, default_branch: "main" },
  commits: [{ message: "feat: something worth documenting" }],
});

const observed: {
  repo: string;
  push: unknown;
  schedule: unknown;
  branches: readonly (string | undefined)[];
  worktreeBranches: readonly (string | undefined)[];
  pr: unknown;
  prUrl: string | null;
  ledger: unknown;
  checks: Record<string, CheckRecord>;
} = {
  repo: REPO,
  push: null,
  schedule: null,
  branches: [],
  worktreeBranches: [],
  pr: null,
  prUrl: null,
  ledger: null,
  checks: {},
};
const assert = makeChecker(observed);

const runtime = ManagedRuntime.make(
  TriggerServiceLive({ rules: docsTriggerRules(REPO) }).pipe(
    Layer.provide(DocsSessionsFromSessionService),
    Layer.provide(NoWriteBack),
    Layer.provideMerge(
      SessionServiceLive({
        model: createModelAccess("faux"),
        sessionRoot: SESSION_ROOT,
      }).pipe(Layer.provideMerge(DatabaseLive)),
    ),
    Layer.provideMerge(BunServices.layer),
  ),
);

const github = Layer.merge(
  Layer.succeed(
    CredentialProvider,
    staticTokenProvider(Option.some(Redacted.make("docs-trigger-fake-token"))),
  ),
  FetchHttpClient.layer,
);

const run = <A, E>(
  effect: Effect.Effect<A, E, SessionService | TriggerService | SqlClient>,
) => runtime.runPromise(effect);

/** The sessions this run's repo has, as the index holds them. */
const sessionCount = () =>
  run(
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const rows = yield* sql<{ count: string }>`
        SELECT count(*)::text AS count FROM sessions WHERE repo = ${REPO}
      `;
      return Number(rows[0]?.count ?? "0");
    }),
  );

/** One delivery through the seam, as an adapter hands it over. */
const deliver = (delivery: TriggerDelivery) =>
  run(
    Effect.gen(function* () {
      const trigger = yield* TriggerService;
      return yield* trigger.deliver(delivery);
    }),
  );

const snapshot = (sessionId: SessionId) =>
  run(
    Effect.gen(function* () {
      const sessions = yield* SessionService;
      return yield* sessions.get(sessionId);
    }),
  );

// ---------------------------------------------------------------------------------------------
// 1. A push to the default branch
// ---------------------------------------------------------------------------------------------

const push = Effect.gen(function* () {
  const sessions = yield* SessionService;
  yield* sessions.registerRepo({ repo: REPO, localPath: REPO_DIR });
  const delivery = docsPushDelivery({
    payload: pushPayload(headCommit),
    defaultBranch: "main",
  });
  if (delivery === undefined) {
    assert("the push normalizes into a delivery", false, "undefined");
    return;
  }
  const first = yield* Effect.promise(() => deliver(delivery));
  observed.push = first;
  const sessionId = first.sessionId;
  if (first.status !== "processed" || sessionId === undefined) {
    assert("the push starts one docs session", false, JSON.stringify(first));
    return;
  }
  assert(
    "the push starts one docs session, on the default branch's delivery",
    first.replayed === false,
    JSON.stringify(first),
  );

  const opened = yield* Effect.promise(() => snapshot(sessionId));
  const branch = opened.workspace.branch;
  observed.branches = [branch];
  observed.worktreeBranches = [
    execSync("git rev-parse --abbrev-ref HEAD", { cwd: opened.workspace.path })
      .toString()
      .trim(),
  ];
  const expected = `factory/doc-${delivery.requestId}`;
  assert(
    "the run's branch is factory/doc-<the delivery id>",
    branch === expected && expected.startsWith("factory/doc-"),
    `${String(branch)} (expected ${expected})`,
  );
  assert(
    "and the worktree git cut really is on it, not on main",
    observed.worktreeBranches[0] === expected,
    String(observed.worktreeBranches[0]),
  );
  assert(
    "the run was told why it exists: the rule's prompt is its first message",
    opened.entries
      .map((entry) => entry.text)
      .join("\n")
      .includes("documentation only"),
    `${opened.entries.length} entries`,
  );

  const again = yield* Effect.promise(() => deliver(delivery));
  assert(
    "a redelivery of the same push starts none",
    again.replayed === true && (yield* Effect.promise(sessionCount)) === 1,
    `replayed=${String(again.replayed)} sessions=${yield* Effect.promise(
      sessionCount,
    )}`,
  );

  // What the control plane's git plumbing would leave: a commit on the session's own branch. The PR
  // step measures the branch, so an uncommitted change would be measured as nothing (LOB-196).
  yield* Effect.promise(async () => {
    await mkdir(path.join(opened.workspace.path, "docs"), { recursive: true });
    await writeFile(
      path.join(opened.workspace.path, "docs", "trigger.md"),
      "# Starting a docs run\n\nThe push did it.\n",
    );
    execSync("git add -A", { cwd: opened.workspace.path, stdio: "ignore" });
    execSync(
      "git -c user.email=docs-trigger@localhost -c user.name=docs-trigger commit -q -m 'docs: from a push'",
      {
        cwd: opened.workspace.path,
        stdio: "ignore",
      },
    );
  });

  const answer = yield* sessions
    .openPullRequest({
      sessionId,
      title: "docs: from a push",
      head: expected,
      base: "main",
    })
    .pipe(Effect.provide(github));
  observed.pr = answer;
  const after = yield* Effect.promise(() => snapshot(sessionId));
  observed.prUrl = after.session.prUrl ?? null;
  assert(
    "the docs run opened one PR from its own branch",
    answer.outcome === "opened" && answer.number > 0,
    JSON.stringify(answer),
  );
  assert(
    "and the session's index row carries the link",
    after.session.prUrl !== undefined &&
      after.session.prUrl === (answer.outcome === "opened" ? answer.url : null),
    String(observed.prUrl),
  );
  assert(
    "the docs file the run wrote is in the worktree",
    existsSync(path.join(opened.workspace.path, "docs", "trigger.md")),
    path.join(opened.workspace.path, "docs", "trigger.md"),
  );
});

// ---------------------------------------------------------------------------------------------
// 2. The interval schedule, on a shortened clock
// ---------------------------------------------------------------------------------------------

const schedule = Effect.gen(function* () {
  // Read once and handed over as a plain function, because the schedule's
  // `deliver` may carry no requirements (`DocsScheduleOptions`).
  const trigger = yield* TriggerService;
  const before = yield* Effect.promise(() => sessionCount());
  const everyMs = 400;
  // The real schedule, forked and interrupted: it delivers through the same seam the push did, so
  // each tick is a real session on a real `factory/doc-schedule-<interval>` branch.
  const fiber = yield* Effect.forkChild(
    docsSchedule({
      everyMs,
      repo: REPO,
      deliver: trigger.deliver,
    }),
  );
  yield* Effect.sleep(`${everyMs * 3} millis`);
  yield* Fiber.interrupt(fiber);

  const afterTicks = yield* Effect.promise(() => sessionCount());
  const ticks = afterTicks - before;
  const sessions = yield* Effect.gen(function* () {
    const sql = yield* SqlClient;
    return yield* sql<{ branch: string | null }>`
      SELECT branch FROM sessions
      WHERE repo = ${REPO} AND branch LIKE 'factory/doc-schedule-%'
      ORDER BY branch
    `;
  });
  observed.schedule = {
    everyMs,
    ticks,
    branches: sessions.map((row) => row.branch),
  };
  assert(
    "the schedule fires once per interval, on a shortened clock",
    ticks >= 2,
    `${ticks} tick(s) in ${everyMs * 3}ms`,
  );
  assert(
    "and every tick's branch names its own interval",
    sessions.length === ticks &&
      new Set(sessions.map((row) => row.branch)).size === sessions.length &&
      sessions.every(
        (row) => row.branch?.startsWith("factory/doc-schedule-") === true,
      ),
    sessions.map((row) => row.branch).join(", "),
  );

  // Disabled: the same clock, told to never fire. Nothing may arrive at all.
  const beforeDisabled = yield* Effect.promise(() => sessionCount());
  const disabled = yield* Effect.forkChild(
    docsSchedule({
      everyMs: undefined,
      repo: REPO,
      deliver: trigger.deliver,
    }),
  );
  yield* Effect.sleep(`${everyMs * 2} millis`);
  yield* Fiber.interrupt(disabled);
  const afterDisabled = yield* Effect.promise(() => sessionCount());
  assert(
    "a disabled schedule fires not at all",
    afterDisabled === beforeDisabled,
    `${afterDisabled - beforeDisabled} session(s) from a disabled clock`,
  );
});

// ---------------------------------------------------------------------------------------------
// 3. What GitHub was asked to do
// ---------------------------------------------------------------------------------------------

type Ledger = {
  readonly requests: ReadonlyArray<{
    readonly method: string;
    readonly path: string;
    readonly body?: unknown;
  }>;
  readonly pulls: ReadonlyArray<{
    readonly number: number;
    readonly head: string;
    readonly base: string;
  }>;
};

const readLedger = async (): Promise<Ledger> => {
  try {
    return (await Bun.file(LEDGER).json()) as Ledger;
  } catch {
    return { requests: [], pulls: [] };
  }
};

const ledger = Effect.gen(function* () {
  const seen = yield* Effect.promise(readLedger);
  observed.ledger = seen;
  // Anything that is not a read and not this PR's own create: the shape a push to the default
  // branch, a contents write or a merge would arrive in.
  const writes = seen.requests.filter(
    (request) =>
      request.method !== "GET" &&
      !(request.method === "POST" && request.path === `/repos/${REPO}/pulls`),
  );
  const refWrites = seen.requests.filter(
    (request) =>
      request.path.includes("/git/refs") ||
      request.path.includes("/contents") ||
      request.path.includes("/merges"),
  );
  const create = seen.requests.find(
    (request) =>
      request.method === "POST" && request.path === `/repos/${REPO}/pulls`,
  );
  const body = create?.body as { head?: string; base?: string } | undefined;
  const branch = observed.branches[0] ?? "";

  assert(
    "GitHub received exactly one PR create and no other write",
    seen.requests.filter((request) => request.method === "POST").length === 1 &&
      writes.length === 0 &&
      refWrites.length === 0,
    `requests=${seen.requests.length} otherWrites=${writes.length} refWrites=${refWrites.length}`,
  );
  assert(
    "the ledger holds no write to the default branch",
    seen.requests.every(
      (request) =>
        !request.path.includes("/git/refs") &&
        !(request.body as { ref?: string } | undefined)?.ref?.includes(
          "refs/heads/main",
        ),
    ) && seen.pulls.every((pull) => pull.head !== "main"),
    `pulls=${JSON.stringify(seen.pulls)}`,
  );
  assert(
    "and the one PR it created is docs-branch -> main",
    seen.pulls.length === 1 &&
      seen.pulls[0]?.head === branch &&
      seen.pulls[0]?.base === "main" &&
      body?.head === branch &&
      body?.base === "main",
    `head=${String(body?.head)} base=${String(body?.base)}`,
  );
});

try {
  const phases: ReadonlyArray<
    Effect.Effect<
      void,
      SqlError | SessionError | CredentialError | PrError,
      SessionService | TriggerService | SqlClient
    >
  > = [push, schedule, ledger];
  for (const phase of phases) {
    try {
      await runtime.runPromise(phase);
    } catch (error) {
      assert(`the phase completed`, false, `threw: ${String(error)}`);
    }
  }
} finally {
  await runtime.dispose();
}

await mkdir(EVIDENCE_DIR, { recursive: true });
await writeFile(
  path.join(EVIDENCE_DIR, "docs-trigger.json"),
  `${JSON.stringify(observed, null, 2)}\n`,
);

const failed = Object.entries(observed.checks).filter(
  ([, check]) => !check.passed,
);
if (failed.length > 0) {
  console.error(`\n${failed.length} required check(s) failed`);
  process.exitCode = 1;
}
