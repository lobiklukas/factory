// One documentation run, three markdown files, exactly one PR (LOB-228, part 4 of LOB-195).
//
//   MODE=docs     bun docs-run.ts
//   MODE=over-cap bun docs-run.ts
//
// What this drives, and why it is not a unit test: a *run* whose column holds the `docs` skill
// writes documentation through the session's own tool path, is refused when it reaches for a source
// file, and then opens one pull request whose body lists what it changed. Every part of that is
// production code — the board rows the service reads the column from (`runColumnFor`), `openSession`
// selecting `docsPolicy` because the column names the skill, the real `SessionService` on the run's
// `DATABASE_URL` and a real git worktree, and `openPullRequest` measuring the branch and writing the
// body. Only GitHub is a loopback fake (`./github-fake.ts`), and the model is pi-ai's in-process
// faux provider, so nothing here reaches a network or needs a key.
//
// The board is data (B2/B4), so the drive inserts its own definition version with a column that
// names `docs` and leaves the shipped `default` pipeline alone: a database this has run against
// keeps its boards exactly as they were.
//
// Env: MODE, DATABASE_URL (via DatabaseLive), SESSION_ROOT, DOCS_RUN_REPO_DIR, DOCS_RUN_REPO,
// EVIDENCE_DIR.
import { BunServices } from "@effect/platform-bun";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Effect, Layer, ManagedRuntime, Option, Redacted } from "effect";
import { FetchHttpClient } from "effect/http";
import { SqlClient } from "effect/sql/SqlClient";
import { RepoSlug as RepoSlugSchema } from "@repo/domain/Session";
import type { SessionId } from "@repo/domain/Session";
import { createFauxModelAccess, type FauxModelAccess } from "@repo/harness";
import { DatabaseLive } from "@repo/storage-postgres";
import {
  CredentialProvider,
  SessionService,
  SessionServiceLive,
  staticTokenProvider,
} from "@repo/core";
import { makeChecker, waitUntil } from "./harness.ts";
import type { CheckRecord } from "./harness.ts";

const MODE = process.env["MODE"] ?? "docs";
const SESSION_ROOT =
  process.env["SESSION_ROOT"] ?? ".verify/run/docs-run/sessions";
const REPO_DIR =
  process.env["DOCS_RUN_REPO_DIR"] ?? ".verify/run/docs-run/repo";
const REPO = RepoSlugSchema.make(
  process.env["DOCS_RUN_REPO"] ?? "lobiklukas/factory",
);
const EVIDENCE_DIR =
  process.env["EVIDENCE_DIR"] ?? ".verify/evidence/latest/api";

/** The three files the run writes. Root-relative, so the check can look for each of them. */
const DOCS_FILES = ["docs/session.md", "docs/board.md", "docs/policy.md"];

/**
 * The one source file the run reaches for afterwards, refused by the docs rule.
 *
 * At the worktree root on purpose: `*.md` is allowed there and a `.ts` is not, so the refusal is
 * about the extension rather than about a missing directory — and the `mkdir -p src` in the command
 * below means an *allowed* write here would really land, which is what makes the mutation bite.
 */
const CODE_PATH = "code.ts";

/**
 * What the faux session runs in its bash turn: three markdown files, and a `src/` directory so the
 * refused write that follows would have somewhere to land.
 */
const DOCS_COMMAND = [
  "mkdir -p docs src",
  ...DOCS_FILES.map(
    (file, index) => `printf '# doc ${index + 1}\\n' > ${file}`,
  ),
  "echo wrote three docs",
].join(" && ");

/** The column, definition and instance ids this drive owns. Its own rows, never the shipped board. */
const DEFINITION_ID = "docs-run";
const INSTANCE_ID = "docs-run-board";
const COLUMN = "documenting";

const observed: {
  mode: string;
  sessionId: SessionId | null;
  worktree: string | null;
  written: readonly string[];
  refused: string | null;
  codeOnDisk: boolean | null;
  answer: unknown;
  overCap: unknown;
  prUrl: string | null;
  checks: Record<string, CheckRecord>;
} = {
  mode: MODE,
  sessionId: null,
  worktree: null,
  written: [],
  refused: null,
  codeOnDisk: null,
  answer: null,
  overCap: null,
  prUrl: null,
  checks: {},
};
const assert = makeChecker(observed);

// ---------------------------------------------------------------------------------------------
// The faux model: a run that edits documentation and then reaches for a source file.
// ---------------------------------------------------------------------------------------------

/**
 * An assistant message in the shape pi-ai's faux provider answers with.
 *
 * Built here rather than imported because `@earendil-works/pi-ai` is not resolvable from `.pi` (it
 * is `@repo/harness`'s dependency, not the root's) — and the shape is pi-ai's own faux default,
 * which `models.ts` relies on for every drive that runs without a key. Its types are read off
 * `FauxModelAccess` for the same reason, so a change to pi-ai's message shape fails type-check here.
 */
type FauxStep = Parameters<FauxModelAccess["faux"]["setResponses"]>[0][number];
type FauxFactory = Extract<FauxStep, (...args: never) => unknown>;
type FauxAssistant = Awaited<ReturnType<FauxFactory>>;
type FauxContent = FauxAssistant["content"][number];

const assistant = (
  content: FauxContent[],
  stopReason: "stop" | "toolUse" = "stop",
): FauxAssistant => ({
  role: "assistant",
  content,
  api: "faux",
  provider: "faux",
  model: "faux-1",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason,
  timestamp: Date.now(),
});

const toolCall = (
  name: string,
  args: Extract<FauxContent, { type: "toolCall" }>["arguments"],
  id: string,
): FauxContent => ({
  type: "toolCall",
  id,
  name,
  arguments: args,
});

const text = (value: string): FauxContent => ({ type: "text", text: value });

type FauxMessage = {
  readonly role: string;
  readonly toolName?: string;
  readonly content: string | ReadonlyArray<{ type: string; text?: string }>;
};

const toolResults = (
  messages: readonly FauxMessage[],
): readonly FauxMessage[] =>
  messages.filter((message) => message.role === "toolResult");

const resultText = (message: FauxMessage | undefined): string =>
  message === undefined
    ? ""
    : typeof message.content === "string"
      ? message.content
      : message.content
          .flatMap((part) => (part.type === "text" ? [part.text ?? ""] : []))
          .join("");

const faux = createFauxModelAccess();

/**
 * The run's whole script, derived from its own transcript the way `fauxAnswer` is (so it survives a
 * reopen without a queue): bash writes the three docs, then the `write` tool reaches for the source
 * file, then the model answers with what it was told.
 *
 * The `write` call is the point: `docsPolicy` reads only the `write`/`edit` path argument, so a
 * `printf > code.ts` in bash would be exactly the shell-write gap the feature docs name rather than
 * a refusal — the run has to call the tool the rule polices.
 */
const step = (context: { readonly messages?: readonly FauxMessage[] }) => {
  faux.faux.appendResponses([step]);
  const ran = toolResults(context.messages ?? []);
  if (!ran.some((message) => message.toolName === "bash")) {
    return assistant(
      [toolCall("bash", { command: DOCS_COMMAND }, "call-docs")],
      "toolUse",
    );
  }
  const wrote = ran.find((message) => message.toolName === "write");
  if (wrote === undefined) {
    return assistant(
      [
        toolCall(
          "write",
          { path: CODE_PATH, content: "export const docsRun = 1;\n" },
          "call-code",
        ),
      ],
      "toolUse",
    );
  }
  // What the model read: the refusal, verbatim. Its presence in the transcript is what a reader of
  // the log would see, and it is also what this driver asserts.
  return assistant([text(resultText(wrote))]);
};

faux.faux.setResponses([step]);

const runtime = ManagedRuntime.make(
  SessionServiceLive({
    model: faux.access,
    sessionRoot: SESSION_ROOT,
  }).pipe(Layer.provideMerge(Layer.mergeAll(DatabaseLive, BunServices.layer))),
);

const github = Layer.merge(
  Layer.succeed(
    CredentialProvider,
    staticTokenProvider(Option.some(Redacted.make("docs-run-fake-token"))),
  ),
  FetchHttpClient.layer,
);

/**
 * The board rows the run needs, inserted once and idempotent so a database this has already been
 * driven against keeps one definition, one instance and one task per session.
 *
 * The definition declares exactly one column, and it names the factory's `docs` skill (seeded by
 * `0015_seed_docs_skill.ts`): that name is the whole selection mechanism — no caller sets a flag.
 */
const boardRows = (sessionScoped: {
  readonly taskId: string;
  readonly columns: string;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql`
      INSERT INTO board_definitions (id, version, name, columns)
      VALUES (${DEFINITION_ID}, 1, 'Docs run (drive-local)', ${sessionScoped.columns}::jsonb)
      ON CONFLICT (id, version) DO NOTHING
    `;
    yield* sql`
      INSERT INTO board_instances (id, repo, definition_id, definition_version)
      VALUES (${INSTANCE_ID}, ${REPO}, ${DEFINITION_ID}, 1)
      ON CONFLICT (id) DO NOTHING
    `;
    yield* sql`
      INSERT INTO tasks (id, board_id, title, "column", repo, definition_version, revision)
      VALUES (${sessionScoped.taskId}, ${INSTANCE_ID}, 'a docs run', ${COLUMN}, ${REPO}, 1, 1)
      ON CONFLICT (id) DO NOTHING
    `;
  });

const COLUMNS = JSON.stringify([
  {
    name: COLUMN,
    kind: "working",
    role: "documenter",
    skills: ["docs"],
    requires: [],
  },
]);

/** A session in the docs column, bound to the drive's own repo checkout. */
const openDocsSession = (title: string) =>
  Effect.gen(function* () {
    const sessions = yield* SessionService;
    yield* sessions.registerRepo({
      repo: REPO,
      url: "https://github.com/lobiklukas/factory.git",
      localPath: REPO_DIR,
    });
    const taskId = `docs-task-${Date.now()}-${Math.trunc(Math.random() * 1e6)}`;
    yield* boardRows({ taskId, columns: COLUMNS });
    // The run row is what `acquireOwner` reads the column from, and `create` writes it before the
    // harness opens — which is why the skill reaches the prompt of the very first turn.
    const created = yield* sessions.create({
      repo: REPO,
      baseRef: "main",
      title,
      taskId,
      taskColumn: COLUMN,
    });
    const snapshot = yield* sessions.get(created.id);
    return { sessionId: created.id, worktree: snapshot.workspace.path };
  });

/**
 * Send the run's prompt and wait for both of its tool calls to be decided, then for the run to
 * settle.
 *
 * Two tool results is the whole condition, deliberately: a wait for the *refusal* would turn the
 * mutation (drop the docs rule and the write is allowed) into a timeout, which names the harness
 * rather than the missing refusal. Waiting for "both calls were decided" lets the assertions below
 * report what actually happened — no refusal, and the file on disk — which is what a reader of a
 * failing run needs.
 */
const runToIdle = (sessionId: SessionId) =>
  Effect.gen(function* () {
    const sessions = yield* SessionService;
    yield* sessions.send({ sessionId, content: "update the documentation" });
    return yield* waitUntil(
      Effect.map(sessions.get(sessionId), (snapshot) => {
        const decided =
          snapshot.entries.filter((entry) => entry.kind === "toolResult")
            .length >= 2;
        return decided && snapshot.session.status !== "busy" ? snapshot : false;
      }),
      "the run's two tool calls to be decided",
    );
  });

const commitDocs = (worktree: string) => {
  execSync("git add -A", { cwd: worktree, stdio: "ignore" });
  execSync("git commit -m 'docs: three markdown files'", {
    cwd: worktree,
    stdio: "ignore",
  });
};

// ---------------------------------------------------------------------------------------------
// The phases
// ---------------------------------------------------------------------------------------------

const docs = Effect.gen(function* () {
  const opened = yield* openDocsSession("a docs run");
  observed.sessionId = opened.sessionId;
  observed.worktree = opened.worktree;

  const settled = yield* runToIdle(opened.sessionId);
  observed.written = DOCS_FILES.filter((file) =>
    existsSync(path.join(opened.worktree, file)),
  );
  const refusal = settled.entries.find(
    (entry) => entry.kind === "toolResult" && entry.text.includes("docs rule"),
  );
  observed.refused = refusal?.text ?? null;
  // The half a transcript read cannot prove: a blocked call that still wrote the file would pass a
  // check that only read the log.
  observed.codeOnDisk = existsSync(path.join(opened.worktree, CODE_PATH));

  assert(
    "the run wrote the three markdown files through its own tool path",
    observed.written.length === DOCS_FILES.length,
    observed.written.join(", "),
  );
  assert(
    "the source write is refused, and the reason names the docs rule",
    observed.refused !== null &&
      observed.refused.includes("docs rule") &&
      observed.refused.includes("documentation only"),
    String(observed.refused).slice(0, 160),
  );
  assert(
    "and the refused file is not on disk",
    observed.codeOnDisk === false,
    `${CODE_PATH} exists=${String(observed.codeOnDisk)}`,
  );

  // The session's branch, committed the way the control plane's git plumbing would: the PR step
  // measures the branch's diff, so an uncommitted change would be measured as nothing.
  commitDocs(opened.worktree);

  const sessions = yield* SessionService;
  const answer = yield* sessions
    .openPullRequest({
      sessionId: opened.sessionId,
      title: "docs: three markdown files",
      head: `factory/${opened.sessionId}`,
      base: "main",
    })
    .pipe(Effect.provide(github));
  observed.answer = answer;
  const after = yield* sessions.get(opened.sessionId);
  observed.prUrl = after.session.prUrl ?? null;

  assert(
    "the step opened one PR for the docs run",
    answer.outcome === "opened" && answer.number > 0,
    JSON.stringify(answer),
  );
  assert(
    "and the session's log holds exactly one prOpened entry",
    after.entries.filter((entry) => entry.kind === "other" && entry.text === "")
      .length === 1,
    `prUrl=${String(after.session.prUrl)}`,
  );
  assert(
    "and the index carries the same link",
    after.session.prUrl === (answer.outcome === "opened" ? answer.url : null),
    String(observed.prUrl),
  );
});

const overCap = Effect.gen(function* () {
  const opened = yield* openDocsSession("a docs run over the cap");
  observed.sessionId = opened.sessionId;
  observed.worktree = opened.worktree;

  // 51 files of one line each: over the default file cap, far under the line cap. Written, not run
  // through a model — the control is about the cap, and a run that spent a turn here would prove
  // nothing the docs phase does not already prove.
  for (let file = 0; file < 51; file += 1) {
    yield* Effect.promise(() =>
      writeFile(path.join(opened.worktree, `change-${file}.txt`), "x\n"),
    );
  }
  commitDocs(opened.worktree);

  const sessions = yield* SessionService;
  const answer = yield* sessions
    .openPullRequest({
      sessionId: opened.sessionId,
      title: "docs: over the cap",
      head: `factory/${opened.sessionId}`,
      base: "main",
    })
    .pipe(Effect.provide(github));
  observed.overCap = answer;
  const after = yield* sessions.get(opened.sessionId);

  assert(
    "a run over the cap opens nothing and answers the typed over-cap outcome",
    answer.outcome === "over-cap" &&
      answer.limit === "files" &&
      answer.measured === 51,
    JSON.stringify(answer),
  );
  assert(
    "and it records no PR and writes no prOpened entry",
    after.session.prUrl === undefined &&
      after.entries.filter(
        (entry) => entry.kind === "other" && entry.text === "",
      ).length === 0,
    `prUrl=${String(after.session.prUrl)}`,
  );
});

const phase = MODE === "docs" ? docs : overCap;

try {
  await runtime.runPromise(phase);
} catch (error) {
  assert(`${MODE} phase completed`, false, `threw: ${String(error)}`);
} finally {
  await runtime.dispose();
}

await mkdir(EVIDENCE_DIR, { recursive: true });
await writeFile(
  path.join(EVIDENCE_DIR, `docs-run-${MODE}.json`),
  `${JSON.stringify(observed, null, 2)}\n`,
);

const failed = Object.entries(observed.checks).filter(
  ([, check]) => !check.passed,
);
if (failed.length > 0) {
  console.error(`\n${failed.length} required check(s) failed (${MODE})`);
  process.exitCode = 1;
}
