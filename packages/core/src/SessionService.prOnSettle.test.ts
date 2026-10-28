/**
 * A run that settles opens its PR with no operator call (C18): a session a trigger opened, and a
 * card's run in a column that requires a PR, run the PR step when their run goes idle — and a run the
 * step opened nothing for says why in its transcript and on its card.
 *
 * Real Postgres, real git worktrees, the real trigger seam over the real session service. The model
 * is faux, and its one `bash` call commits as many files as its repository's committed `c18-files`
 * marker says (none when there is no marker), then sleeps as long as its `c18-sleep` marker says, so
 * each repository below is one outcome: a change that fits the cap, one over it, none, and one a
 * run is still busy after committing (to be interrupted). GitHub is a fake `HttpClient` that records
 * what it was asked; nothing leaves the process.
 *
 * Every case waits on the step's own decision (`onPullRequestSettled`), never on a clock: a case
 * that asserts nothing was opened asserts it once the step has decided.
 *
 * Postgres only, not mocked: `docker compose up -d --wait postgres`.
 */
import { BunServices } from "@effect/platform-bun";
import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RepoSlug,
  type SessionId,
  type SessionSnapshot,
} from "@repo/domain/Session";
import {
  BoardInstanceId,
  DEFAULT_DEFINITION_ID,
  DefinitionId,
} from "@repo/domain/Task";
import { createFauxModelAccess, readRecordedPullRequest } from "@repo/harness";
import { DatabaseLive, PostgresStorage } from "@repo/storage-postgres";
import {
  Context,
  Effect,
  Layer,
  ManagedRuntime,
  Option,
  Redacted,
} from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { SqlClient } from "effect/sql/SqlClient";
import { afterAll, describe, expect, it } from "vitest";
import { CredentialProvider, staticTokenProvider } from "./credentials";
import type { SettleDecision } from "./prOnSettle";
import { SessionService, SessionServiceLive } from "./SessionService";
import { TaskService, TaskServiceLive } from "./TaskService";
import {
  NoCards,
  NoWriteBack,
  TriggerService,
  TriggerServiceLive,
  TriggerSessionsFromSessionService,
} from "./TriggerService";

const runId = randomBytes(4).toString("hex");

/** What the fake forge was asked, and the PR number it answers next. */
const forge: Array<{ readonly url: string; readonly body: string }> = [];
let nextNumber = 100;

const fakeForge = HttpClient.make((request, url) =>
  Effect.sync(() => {
    const body =
      request.body._tag === "Uint8Array"
        ? new TextDecoder().decode(request.body.body)
        : "";
    forge.push({ url: url.pathname, body });
    nextNumber += 1;
    const [, , owner, repo] = url.pathname.split("/");
    return HttpClientResponse.fromWeb(
      request,
      new Response(
        JSON.stringify({
          number: nextNumber,
          html_url: `https://github.com/${owner}/${repo}/pull/${nextNumber}`,
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      ),
    );
  }),
);

const pullRequestOnSettle = Context.make(HttpClient.HttpClient, fakeForge).pipe(
  Context.add(
    CredentialProvider,
    staticTokenProvider(Option.some(Redacted.make("c18-fake-token"))),
  ),
);

/** Every settle's decision, in the order the step reached them. */
const decisions: Array<{
  readonly sessionId: SessionId;
  readonly decision: SettleDecision;
}> = [];

/**
 * A checkout whose `main` carries a `c18-files` marker of `files` (none for 0), so a run's faux
 * `bash` call in a worktree of it commits that many files, and a `c18-sleep` marker of `sleep`
 * seconds the call then sleeps for (none for 0).
 */
const fixtureRepo = (files: number, sleep = 0): string => {
  const root = mkdtempSync(join(tmpdir(), "factory-c18-repo-"));
  const git = (command: string) =>
    execSync(command, { cwd: root, stdio: "ignore" });
  git("git init -b main");
  git("git config user.email c18@localhost");
  git("git config user.name c18");
  if (files > 0) {
    writeFileSync(join(root, "c18-files"), `${files}\n`);
    git("git add c18-files");
  }
  if (sleep > 0) {
    writeFileSync(join(root, "c18-sleep"), `${sleep}\n`);
    git("git add c18-sleep");
  }
  git("git commit --allow-empty -m init");
  return root;
};

/** The run's one command: commit `c18-files` files, or nothing, then print as the faux model does. */
const COMMAND = [
  "n=$(cat c18-files 2>/dev/null || echo 0)",
  "i=0",
  'while [ "$i" -lt "$n" ]; do i=$((i+1)); echo x > "change-$i.txt"; done',
  'if [ "$n" -gt 0 ]; then git add -A && git commit -qm c18; fi',
  'sleep "$(cat c18-sleep 2>/dev/null || echo 0)"',
  "echo faux-ok",
].join("; ");

const repos = {
  /** One file: inside the cap. */
  fits: { slug: RepoSlug.make(`c18-${runId}/fits`), root: fixtureRepo(1) },
  /** Three files: over a cap of two. */
  over: { slug: RepoSlug.make(`c18-${runId}/over`), root: fixtureRepo(3) },
  /** Nothing committed. */
  even: { slug: RepoSlug.make(`c18-${runId}/even`), root: fixtureRepo(0) },
  /** One file, then a minute's sleep: a run still busy after it committed. */
  slow: { slug: RepoSlug.make(`c18-${runId}/slow`), root: fixtureRepo(1, 60) },
} as const;

const sessionRoot = mkdtempSync(join(tmpdir(), "factory-c18-sessions-"));

const sessions = SessionServiceLive({
  model: createFauxModelAccess({ fauxCommand: COMMAND }).access,
  sessionRoot,
  prCap: { maxFiles: 2, maxLines: 1_000 },
  pullRequestOnSettle,
  onPullRequestSettled: (sessionId, decision) =>
    Effect.sync(() => {
      decisions.push({ sessionId, decision });
    }),
});

const runtime = ManagedRuntime.make(
  Layer.mergeAll(
    TriggerServiceLive({
      rules: [
        {
          label: `c18-${runId}`,
          repo: repos.fits.slug,
          baseRef: "main",
          prompt: "Work on {{title}}",
        },
        {
          label: `c18-${runId}-slow`,
          repo: repos.slow.slug,
          baseRef: "main",
          prompt: "Work on {{title}}",
        },
      ],
    }).pipe(
      Layer.provide(
        Layer.mergeAll(TriggerSessionsFromSessionService, NoWriteBack, NoCards),
      ),
    ),
    TaskServiceLive,
  ).pipe(
    Layer.provideMerge(sessions),
    Layer.provideMerge(Layer.mergeAll(DatabaseLive, BunServices.layer)),
  ),
);

afterAll(async () => {
  await runtime.dispose();
});

const waitUntil = <A, E, R>(
  read: Effect.Effect<A, E, R>,
  done: (value: A) => boolean,
  label: string,
): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 600; attempt += 1) {
      const value = yield* read;
      if (done(value)) return value;
      yield* Effect.sleep(50);
    }
    return yield* Effect.die(new Error(`timed out waiting for ${label}`));
  });

const register = Effect.gen(function* () {
  const service = yield* SessionService;
  for (const { slug, root } of Object.values(repos)) {
    yield* service.registerRepo({
      repo: slug,
      url: `https://github.com/${slug}.git`,
      localPath: root,
    });
  }
});

/** The `factory.pr` the session's log records, read as a board's `pr_link` reads it. */
const recordedPr = (sessionId: SessionId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const storage = yield* Effect.promise(() =>
      PostgresStorage.reader(sql, sessionId),
    );
    return yield* readRecordedPullRequest(storage).pipe(
      Effect.ensuring(Effect.promise(() => storage.dispose())),
    );
  });

const settled = (sessionId: SessionId) =>
  Effect.gen(function* () {
    const service = yield* SessionService;
    return yield* waitUntil(
      service.get(sessionId),
      (snapshot) =>
        !snapshot.live.busy &&
        snapshot.entries.some((entry) => entry.kind === "assistant"),
      `session ${sessionId}'s run to settle`,
    );
  });

/** The session's settle decisions, once the step has reached `count` of them. */
const decided = (sessionId: SessionId, count = 1) =>
  waitUntil(
    Effect.sync(() =>
      decisions
        .filter((entry) => entry.sessionId === sessionId)
        .map((entry) => entry.decision),
    ),
    (made) => made.length >= count,
    `session ${sessionId}'s settle decision ${count}`,
  );

/** A delivery from the generic webhook for `label`, and the session it opened. */
const deliver = (key: string, label: string, title: string) =>
  Effect.gen(function* () {
    const trigger = yield* TriggerService;
    const delivered = yield* trigger.deliver({
      requestId: `${key}-delivery`,
      event: {
        source: "generic",
        key,
        action: "create",
        title,
        body: "It wobbles.",
        labels: [label],
      },
    });
    const sessionId = delivered.sessionId;
    if (sessionId === undefined) {
      return yield* Effect.die(new Error("the delivery opened no session"));
    }
    return { delivered, sessionId };
  });

const said = (snapshot: SessionSnapshot, text: string) =>
  snapshot.entries.filter((entry) => entry.text.includes(text));

/**
 * A card in `building` on a new board over `repo`, and a run started on it with a first message.
 * `parked` blocks the card before the message, as a run's question would leave it (B7).
 */
const buildRun = (repo: RepoSlug, parked = false) =>
  Effect.gen(function* () {
    const tasks = yield* TaskService;
    const service = yield* SessionService;
    const sql = yield* SqlClient;
    const board = yield* tasks.createBoard({
      repo,
      definitionId: DefinitionId.make(DEFAULT_DEFINITION_ID),
    });
    const card = yield* tasks.create({
      boardId: BoardInstanceId.make(board.id),
      title: `build on ${repo}`,
      actor: "person:c18",
    });
    // Straight into `building`: the moves that get a card there are the board's own suite's.
    yield* sql`UPDATE tasks SET "column" = 'building' WHERE id = ${card.id}`;
    const created = yield* service.create({
      taskId: card.id,
      taskColumn: "building",
    });
    if (parked) {
      yield* sql`
        UPDATE tasks SET blocked_reason = 'needs_input', blocked_column = 'building',
          blocked_since = now()
        WHERE id = ${card.id}
      `;
    }
    yield* service.send({ sessionId: created.id, content: "build it" });
    return { taskId: card.id, sessionId: created.id };
  });

describe("a settled run's PR (C18)", () => {
  it("a trigger-started session that commits ends with a recorded factory.pr, and no operator call", async () => {
    const outcome = await runtime.runPromise(
      Effect.gen(function* () {
        yield* register;
        const service = yield* SessionService;
        const before = forge.length;
        const { delivered, sessionId } = yield* deliver(
          `c18-${runId}`,
          `c18-${runId}`,
          "Fix the widget",
        );
        yield* settled(sessionId);
        const snapshot = yield* waitUntil(
          service.get(sessionId),
          (read) => read.session.prUrl !== undefined,
          "the settled run's PR",
        );
        const sql = yield* SqlClient;
        const actor = yield* sql<{ actor: string | null }>`
          SELECT actor FROM sessions WHERE id = ${sessionId}
        `;
        return {
          delivered,
          actor: actor[0]?.actor,
          decision: yield* decided(sessionId),
          snapshot,
          recorded: yield* recordedPr(sessionId),
          asked: forge.slice(before),
        };
      }),
    );

    expect(outcome.delivered.status).toBe("processed");
    // What made it declare its PR: a trigger opened it (LOB-162's actor), and nobody asked.
    expect(outcome.actor).toBe("trigger:generic");
    expect(outcome.decision).toEqual(["opened"]);
    // One create, on the session's own branch onto the base it was cut from.
    expect(outcome.asked).toHaveLength(1);
    expect(outcome.asked[0]?.url).toBe(`/repos/${repos.fits.slug}/pulls`);
    const sent = JSON.parse(outcome.asked[0]?.body ?? "{}") as Record<
      string,
      unknown
    >;
    expect(sent["head"]).toBe(`factory/${outcome.snapshot.session.id}`);
    expect(sent["base"]).toBe("main");
    expect(sent["title"]).toBe("Fix the widget");
    expect(String(sent["body"])).toContain("- change-1.txt");
    // The record a board's `pr_link` reads, and the index the list reads, name the same PR.
    expect(outcome.recorded?.url).toBe(outcome.snapshot.session.prUrl);
    expect(outcome.recorded?.head).toBe(
      `factory/${outcome.snapshot.session.id}`,
    );
  }, 120_000);

  it("a person's session that commits opens no PR on its own: `factory pr` and the dashboard still do", async () => {
    const outcome = await runtime.runPromise(
      Effect.gen(function* () {
        yield* register;
        const service = yield* SessionService;
        const before = forge.length;
        const created = yield* service.create({
          title: "a person's change",
          repo: repos.fits.slug,
          baseRef: "main",
        });
        yield* service.send({ sessionId: created.id, content: "change it" });
        yield* settled(created.id);
        const decision = yield* decided(created.id);
        const after = yield* service.get(created.id);
        const asked = forge.length - before;
        // The operator's call is still the way, and it opens the one PR.
        const opened = yield* service
          .openPullRequest({
            sessionId: created.id,
            title: "a person's change",
          })
          .pipe(Effect.provideContext(pullRequestOnSettle));
        return { after, asked, opened, decision };
      }),
    );

    expect(outcome.decision).toEqual(["undeclared"]);
    expect(outcome.asked).toBe(0);
    expect(outcome.after.session.prUrl).toBeUndefined();
    expect(outcome.opened.outcome).toBe("opened");
  }, 120_000);

  it("a card's building run over the cap opens nothing, and says so in its transcript and on its card", async () => {
    const outcome = await runtime.runPromise(
      Effect.gen(function* () {
        yield* register;
        const service = yield* SessionService;
        const tasks = yield* TaskService;
        const before = forge.length;
        const { taskId, sessionId } = yield* buildRun(repos.over.slug);
        yield* settled(sessionId);
        const snapshot = yield* waitUntil(
          service.get(sessionId),
          (read) => said(read, "over the cap").length > 0,
          "the over-cap line in the transcript",
        );
        const thread = yield* waitUntil(
          tasks.comments(taskId),
          (comments) => comments.length > 0,
          "the over-cap note on the card",
        );
        // A second message, a second settle still over the cap by the same count: the step runs
        // again and finds the same reason, and the card's thread keeps the one note.
        yield* service.send({ sessionId, content: "and again" });
        const made = yield* decided(sessionId, 2);
        return {
          snapshot,
          thread,
          made,
          again: yield* service.get(sessionId),
          threadAfter: yield* tasks.comments(taskId),
          sessionId,
          asked: forge.length - before,
          recorded: yield* recordedPr(sessionId),
        };
      }),
    );

    const line =
      "the run settled and the PR step opened no PR: the branch's diff is over the cap (3 files, at most 2)";
    expect(said(outcome.snapshot, "over the cap")).toEqual([
      expect.objectContaining({ kind: "other", text: line }),
    ]);
    expect(outcome.thread).toEqual([
      expect.objectContaining({
        actor: outcome.sessionId,
        kind: "note",
        body: line,
      }),
    ]);
    expect(outcome.made).toEqual(["over-cap", "over-cap"]);
    expect(said(outcome.again, "over the cap")).toHaveLength(2);
    expect(outcome.threadAfter).toEqual(outcome.thread);
    expect(outcome.asked).toBe(0);
    expect(outcome.recorded).toBeUndefined();
    expect(outcome.snapshot.session.prUrl).toBeUndefined();
  }, 120_000);

  it("a card's building run with no change opens nothing, and says so in its transcript and on its card", async () => {
    const outcome = await runtime.runPromise(
      Effect.gen(function* () {
        yield* register;
        const service = yield* SessionService;
        const tasks = yield* TaskService;
        const before = forge.length;
        const { taskId, sessionId } = yield* buildRun(repos.even.slug);
        yield* settled(sessionId);
        const thread = yield* waitUntil(
          tasks.comments(taskId),
          (comments) => comments.length > 0,
          "the no-change note on the card",
        );
        // A second message, a second settle with the branch still at the commit the first found
        // even: the step is not run again, so no second transcript line and no second note.
        yield* service.send({ sessionId, content: "and again" });
        const made = yield* decided(sessionId, 2);
        return {
          made,
          snapshot: yield* service.get(sessionId),
          thread: yield* tasks.comments(taskId),
          first: thread,
          sessionId,
          asked: forge.length - before,
        };
      }),
    );

    expect(outcome.made).toEqual(["no-change", "unchanged"]);
    expect(said(outcome.snapshot, "nothing to publish")).toHaveLength(1);
    const note =
      "the run settled and the PR step opened no PR: the branch has no change against its base";
    expect(outcome.first).toEqual([
      expect.objectContaining({
        actor: outcome.sessionId,
        kind: "note",
        body: note,
      }),
    ]);
    expect(outcome.thread).toHaveLength(1);
    expect(outcome.asked).toBe(0);
  }, 120_000);

  it("a card's building run that ended parked on a person opens nothing, though it committed", async () => {
    const outcome = await runtime.runPromise(
      Effect.gen(function* () {
        yield* register;
        const service = yield* SessionService;
        const tasks = yield* TaskService;
        const before = forge.length;
        const repo = RepoSlug.make(`c18-${runId}/parked`);
        yield* service.registerRepo({
          repo,
          url: `https://github.com/${repo}.git`,
          localPath: fixtureRepo(1),
        });
        const { taskId, sessionId } = yield* buildRun(repo, true);
        yield* settled(sessionId);
        return {
          decision: yield* decided(sessionId),
          snapshot: yield* service.get(sessionId),
          thread: yield* tasks.comments(taskId),
          asked: forge.length - before,
        };
      }),
    );

    // Told apart from a session that never declared a PR: its PR is held, not left to a person.
    expect(outcome.decision).toEqual(["parked"]);
    expect(outcome.asked).toBe(0);
    expect(outcome.snapshot.session.prUrl).toBeUndefined();
    expect(said(outcome.snapshot, "opened no PR")).toEqual([]);
    expect(outcome.thread).toEqual([]);
  }, 120_000);

  it("a card's building run with a change opens its PR, and a later run in a column that requires none pushes onto it rather than opening another (C19)", async () => {
    const outcome = await runtime.runPromise(
      Effect.gen(function* () {
        yield* register;
        const service = yield* SessionService;
        const tasks = yield* TaskService;
        const sql = yield* SqlClient;
        const before = forge.length;
        const repo = RepoSlug.make(`c18-${runId}/card`);
        yield* service.registerRepo({
          repo,
          url: `https://github.com/${repo}.git`,
          localPath: fixtureRepo(1),
        });
        const { taskId, sessionId } = yield* buildRun(repo);
        yield* settled(sessionId);
        const built = yield* waitUntil(
          service.get(sessionId),
          (read) => read.session.prUrl !== undefined,
          "the building run's PR",
        );
        // The same card, a run in `review` (which requires a verdict, not a PR). Since C19 it
        // continues the card's branch, so its settle adopts the card's PR — pushed, no second PR —
        // rather than opening nothing (a column that requires none and continues no card PR still
        // opens nothing: `prOnSettle.test.ts`).
        yield* sql`UPDATE tasks SET "column" = 'review' WHERE id = ${taskId}`;
        const reviewed = yield* service.create({
          taskId,
          taskColumn: "review",
        });
        yield* service.send({ sessionId: reviewed.id, content: "review it" });
        yield* settled(reviewed.id);
        return {
          reviewDecision: yield* decided(reviewed.id),
          built,
          review: yield* service.get(reviewed.id),
          asked: forge.slice(before),
          thread: yield* tasks.comments(taskId),
        };
      }),
    );

    expect(outcome.asked).toHaveLength(1);
    expect(outcome.built.session.prUrl).toMatch(
      new RegExp(`/c18-${runId}/card/pull/\\d+$`),
    );
    expect(outcome.reviewDecision).toEqual(["opened"]);
    expect(outcome.review.session.prUrl).toBe(outcome.built.session.prUrl);
    // An opened PR is its own announcement; nothing is noted on the card.
    expect(outcome.thread).toEqual([]);
  }, 120_000);

  it("a replay of a trigger's session keeps its actor and opens no second PR", async () => {
    const outcome = await runtime.runPromise(
      Effect.gen(function* () {
        yield* register;
        const service = yield* SessionService;
        const sql = yield* SqlClient;
        const { sessionId } = yield* deliver(
          `c18-${runId}-replayed`,
          `c18-${runId}`,
          "Fix the gadget",
        );
        yield* settled(sessionId);
        yield* decided(sessionId);
        const before = forge.length;
        // Auth off, as the local default: the replay takes its source's actor (LOB-162).
        const replayed = yield* service.replay({ sessionId });
        yield* settled(replayed.id);
        const decision = yield* decided(replayed.id);
        const actor = yield* sql<{ actor: string | null }>`
          SELECT actor FROM sessions WHERE id = ${replayed.id}
        `;
        return {
          decision,
          actor: actor[0]?.actor,
          asked: forge.length - before,
          replay: yield* service.get(replayed.id),
        };
      }),
    );

    expect(outcome.actor).toBe("trigger:generic");
    expect(outcome.decision).toEqual(["undeclared"]);
    expect(outcome.asked).toBe(0);
    expect(outcome.replay.session.prUrl).toBeUndefined();
  }, 120_000);

  it("a trigger's run an operator interrupted after it committed opens no PR, and says why", async () => {
    const outcome = await runtime.runPromise(
      Effect.gen(function* () {
        yield* register;
        const service = yield* SessionService;
        const before = forge.length;
        const { sessionId } = yield* deliver(
          `c18-${runId}-interrupted`,
          `c18-${runId}-slow`,
          "Fix the sprocket",
        );
        // The run is asleep in its `bash` call once its commit is on the session's branch.
        const worktree = join(
          sessionRoot,
          ...repos.slow.slug.split("/"),
          sessionId,
        );
        yield* waitUntil(
          Effect.sync(() => {
            try {
              return execSync("git log -1 --format=%s", {
                cwd: worktree,
                encoding: "utf8",
              }).trim();
            } catch {
              return "";
            }
          }),
          (subject) => subject === "c18",
          "the slow run's commit",
        );
        const stopped = yield* service.interrupt(sessionId);
        const decision = yield* decided(sessionId);
        return {
          stopped,
          decision,
          asked: forge.length - before,
          snapshot: yield* service.get(sessionId),
          recorded: yield* recordedPr(sessionId),
        };
      }),
    );

    expect(outcome.stopped.outcome).toBe("interrupted");
    expect(outcome.decision).toEqual(["stopped"]);
    expect(outcome.asked).toBe(0);
    expect(outcome.recorded).toBeUndefined();
    expect(outcome.snapshot.session.prUrl).toBeUndefined();
    expect(said(outcome.snapshot, "without finishing")).toEqual([
      expect.objectContaining({
        kind: "other",
        text: "the run settled without finishing, so no PR was opened over its branch: it was interrupted; a run that finishes opens it, or `factory pr` does",
      }),
    ]);
  }, 120_000);
});
