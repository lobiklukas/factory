/**
 * A card's runs share one branch and one PR (C19, `./cardBranch`): a later run on the card continues
 * the branch its first building run cut, its PR step answers the card's PR `already-open` and pushes
 * its commits onto it, a run in `review` is cut with the building run's diff in its worktree, and the
 * board's `pr_link` passes after a follow-up run that opened no PR of its own. The later run's agent
 * may push the card's branch it is bound to, and no other (F15), and a later run after the card's PR
 * was closed unmerged opens a new PR rather than adopting the closed one (F12).
 *
 * Real Postgres, real git worktrees, the real session and task services. The model is faux, and its
 * one `bash` call commits one more numbered file than the branch already holds (`change-<n>.txt`),
 * so each run's commit is told apart from the last. GitHub is a fake `HttpClient` that records what
 * it was asked, and the forge's git endpoint a local bare repository the fake remote pushes into;
 * nothing leaves the process (docs/testing-third-parties.md).
 *
 * Postgres only, not mocked: `docker compose up -d --wait postgres`.
 */
import { BunServices } from "@effect/platform-bun";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RepoSlug, type SessionId } from "@repo/domain/Session";
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
import type { RepoRemote } from "./RepoRemote";
import { SessionService, SessionServiceLive } from "./SessionService";
import { TaskService, TaskServiceLive } from "./TaskService";

const runId = randomBytes(4).toString("hex");

const git = (cwd: string, ...args: ReadonlyArray<string>): string =>
  execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "c19",
      GIT_AUTHOR_EMAIL: "c19@localhost",
      GIT_COMMITTER_NAME: "c19",
      GIT_COMMITTER_EMAIL: "c19@localhost",
    },
  }).trim();

/** What the fake GitHub API was asked to create, and the PR number it answers next. */
const created: Array<{ readonly head: string; readonly base: string }> = [];
let nextNumber = 400;

const fakeGitHub = HttpClient.make((request, url) =>
  Effect.sync(() => {
    const body =
      request.body._tag === "Uint8Array"
        ? (JSON.parse(new TextDecoder().decode(request.body.body)) as {
            head: string;
            base: string;
          })
        : { head: "", base: "" };
    created.push({ head: body.head, base: body.base });
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

const forgeContext = Context.make(HttpClient.HttpClient, fakeGitHub).pipe(
  Context.add(
    CredentialProvider,
    staticTokenProvider(Option.some(Redacted.make("c19-fake-token"))),
  ),
);

/** The checkout the card's runs are cut from, and the bare repository standing in for the forge. */
const checkout = mkdtempSync(join(tmpdir(), "factory-c19-repo-"));
const forgeRepo = mkdtempSync(join(tmpdir(), "factory-c19-forge-"));
git(checkout, "init", "-q", "-b", "main");
writeFileSync(join(checkout, "README.md"), "c19\n");
git(checkout, "add", "README.md");
git(checkout, "commit", "-q", "-m", "init");
git(forgeRepo, "init", "-q", "--bare");
git(checkout, "push", "-q", forgeRepo, "main");

/** Every push the remote took: the branch and the commit, read back from the bare repository. */
const pushes: Array<{ readonly branch: string; readonly commit: string }> = [];

/**
 * The deployment's remote over the local bare repository: the base is "fetched" by pointing the
 * tracking ref at the forge's `main`, and a push is a real `git push` into it.
 */
const repoRemote: RepoRemote = {
  fetchBase: (input) =>
    Effect.sync(() => {
      const sha = git(forgeRepo, "rev-parse", `refs/heads/${input.branch}`);
      const ref = `refs/remotes/factory/${input.branch}`;
      git(input.checkout, "fetch", "-q", forgeRepo, `${input.branch}:${ref}`);
      return { ref, sha };
    }),
  push: (input) =>
    Effect.sync(() => {
      const commit =
        input.commit ?? git(input.worktree, "rev-parse", input.branch);
      git(
        input.worktree,
        "push",
        "-q",
        forgeRepo,
        `${commit}:refs/heads/${input.branch}`,
      );
      pushes.push({ branch: input.branch, commit });
      return {
        ref: `refs/heads/${input.branch}`,
        sha: commit,
        outcome: "updated" as const,
      };
    }),
  defaultBranch: () => Effect.succeed("main"),
};

/** While this file exists, a run's command waits before it commits: a run held busy on purpose. */
const hold = join(mkdtempSync(join(tmpdir(), "factory-c19-hold-")), "hold");

/** The run's one command: commit one more numbered file than the branch holds. */
const COMMAND = [
  `while [ -f ${hold} ]; do sleep 0.1; done`,
  "n=$(ls change-*.txt 2>/dev/null | wc -l | tr -d ' ')",
  "n=$((n+1))",
  'echo "change $n" > "change-$n.txt"',
  'git add -A && git -c user.email=c19@localhost -c user.name=c19 commit -qm "c19 change $n"',
  "echo faux-ok",
].join("; ");

const sessionRoot = mkdtempSync(join(tmpdir(), "factory-c19-sessions-"));

const decisions: Array<{
  readonly sessionId: SessionId;
  readonly decision: SettleDecision;
}> = [];

const DatabaseLayer = Layer.mergeAll(DatabaseLive, BunServices.layer);

const runtime = ManagedRuntime.make(
  TaskServiceLive.pipe(
    Layer.provideMerge(
      SessionServiceLive({
        model: createFauxModelAccess({ fauxCommand: COMMAND }).access,
        sessionRoot,
        repoRemote,
        pullRequestOnSettle: forgeContext,
        onPullRequestSettled: (sessionId, decision) =>
          Effect.sync(() => {
            decisions.push({ sessionId, decision });
          }),
      }),
    ),
    Layer.provideMerge(DatabaseLayer),
  ),
);

/**
 * Another process's session root over the same directory: a symlink to it. Presence tells the two
 * apart by the root's spelling (`homeOf`), so each is a process of its own there, while git — which
 * resolves symlinks — sees one session root, and a card's later run in either takes the branch over
 * from a worktree the other cut (C19's hand-over stays within one session root).
 */
const aliasOf = (root: string): string => {
  const alias = join(mkdtempSync(join(tmpdir(), "factory-c19-alias-")), "root");
  symlinkSync(root, alias);
  return alias;
};

/** Runtimes a case built for itself (F15's bound agent), disposed with the file's. */
const extraRuntimes: Array<{ readonly dispose: () => Promise<void> }> = [];

afterAll(async () => {
  for (const extra of extraRuntimes) await extra.dispose();
  await runtime.dispose();
});

const waitUntil = <A, E, R>(
  read: Effect.Effect<A, E, R>,
  done: (value: A) => boolean,
  label: string,
): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 1_200; attempt += 1) {
      const value = yield* read;
      if (done(value)) return value;
      yield* Effect.sleep(50);
    }
    return yield* Effect.die(new Error(`timed out waiting for ${label}`));
  });

/** The settle decisions the PR step reached for a session, once there are `count`. */
const decided = (sessionId: SessionId, count = 1) =>
  waitUntil(
    Effect.sync(() =>
      decisions
        .filter((entry) => entry.sessionId === sessionId)
        .map((entry) => entry.decision),
    ),
    (made) => made.length >= count,
    `session ${sessionId}'s settle decision`,
  );

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

const repo = RepoSlug.make(`c19-${runId}/card`);

/** Where a session's worktree is: the session root, by repo, by id. */
const worktreeOf = (sessionId: string, slug: string = repo) =>
  join(sessionRoot, ...slug.split("/"), sessionId);

/** A second repository over the same checkout: one board per repository. */
const gadgetRepo = RepoSlug.make(`c19-${runId}/gadget`);

/** A run of the card in `column`, sent `content` when given, and settled once it answered. */
const runOnCard = (taskId: string, column: string, content?: string) =>
  Effect.gen(function* () {
    const service = yield* SessionService;
    const run = yield* service.create({ taskId, taskColumn: column });
    if (content === undefined) return run.id;
    yield* service.send({ sessionId: run.id, content });
    yield* waitUntil(
      service.get(run.id),
      (snapshot) =>
        !snapshot.live.busy &&
        snapshot.entries.some((entry) => entry.kind === "assistant"),
      `run ${run.id} to settle`,
    );
    return run.id;
  });

describe("a card's runs share one branch and one PR (C19)", () => {
  /**
   * Mutations this catches: bind no card branch (`resolveBinding`) — the second run is cut on
   * `factory/<its id>` at `main` and has no change-1; hand the step no `adopt` — the fake GitHub is
   * asked for a second PR; adopt without pushing — the forge's branch stays at the first run's
   * commit; read `pr_link` from the latest run alone — the move to review is refused; delete a
   * released run's branch though another run holds it — the review run's cut has no change at all.
   */
  it("a second building run continues the first's branch, its PR step answers already-open, and the review run holds the diff", async () => {
    const outcome = await runtime.runPromise(
      Effect.gen(function* () {
        const service = yield* SessionService;
        const tasks = yield* TaskService;
        const sql = yield* SqlClient;
        yield* service.registerRepo({
          repo,
          url: `https://github.com/${repo}.git`,
          localPath: checkout,
        });
        const board = yield* tasks.createBoard({
          repo,
          definitionId: DefinitionId.make(DEFAULT_DEFINITION_ID),
        });
        const card = yield* tasks.create({
          boardId: BoardInstanceId.make(board.id),
          title: "build the widget",
          actor: "person:c19",
        });
        // Straight into `building`: the moves that get a card there are the board's own suite's.
        yield* sql`UPDATE tasks SET "column" = 'building' WHERE id = ${card.id}`;

        // The first building run: cuts the card's branch, commits change-1, opens the card's PR.
        const first = yield* runOnCard(card.id, "building", "build it");
        const firstDecision = yield* decided(first);
        const firstPr = yield* recordedPr(first);
        const firstCommit = git(checkout, "rev-parse", `factory/${first}`);

        // The second building run on the same card: on the first run's branch, at its commit.
        const second = yield* service.create({
          taskId: card.id,
          taskColumn: "building",
        });
        const secondCut = {
          branch: git(
            worktreeOf(second.id),
            "rev-parse",
            "--abbrev-ref",
            "HEAD",
          ),
          head: git(worktreeOf(second.id), "rev-parse", "HEAD"),
          hasFirstChange: existsSync(
            join(worktreeOf(second.id), "change-1.txt"),
          ),
          firstDetached: git(
            worktreeOf(first),
            "rev-parse",
            "--abbrev-ref",
            "HEAD",
          ),
        };
        // The first run's worktree let go of the branch: steering it would commit off it.
        const steerFirst = yield* service
          .send({ sessionId: first, content: "one more thing" })
          .pipe(Effect.flip);
        yield* service.send({ sessionId: second.id, content: "fix it up" });
        yield* waitUntil(
          service.get(second.id),
          (snapshot) =>
            !snapshot.live.busy &&
            snapshot.entries.some((entry) => entry.kind === "assistant"),
          "the second run to settle",
        );
        const secondDecision = yield* decided(second.id);
        const secondPr = yield* recordedPr(second.id);
        const secondCommit = git(checkout, "rev-parse", `factory/${first}`);
        const forgeAfterSecond = git(
          forgeRepo,
          "rev-parse",
          `refs/heads/factory/${first}`,
        );
        const lastPushAfterSecond = pushes.at(-1);
        const asked = yield* service
          .openPullRequest({ sessionId: second.id, title: "build the widget" })
          .pipe(Effect.provideContext(forgeContext));

        // The card moves on with its PR (its latest run's own record, `already-open`).
        const before = yield* tasks.get(card.id);
        const moved = yield* tasks.move({
          taskId: card.id,
          expectedRevision: before.revision,
          to: "review",
          actor: "person:c19",
        });
        // A follow-up run that opens no PR of its own (opened, never sent). It has completed no turn,
        // so `run_completed` would hold the card in `building`: the card is put back for it, the
        // follow-up being about the workspace, not the exit.
        yield* sql`UPDATE tasks SET "column" = 'building' WHERE id = ${card.id}`;
        const followUp = yield* runOnCard(card.id, "building");
        // Discarding the follow-up keeps the branch the other runs are still on, and frees the
        // card's run slot for the review run.
        yield* service.releaseWorkspace({
          sessionId: followUp,
          reason: "discarded",
        });
        yield* sql`UPDATE tasks SET "column" = 'review' WHERE id = ${card.id}`;
        const branchAfterDiscard = git(
          checkout,
          "rev-parse",
          `refs/heads/factory/${first}`,
        );

        // A run in `review`: its worktree holds the building runs' diff against the base.
        const reviewRun = yield* runOnCard(card.id, "review");
        const reviewDiff = git(
          worktreeOf(reviewRun),
          "diff",
          "--name-only",
          "main...HEAD",
        );
        // A fix run in `review` commits on the card's branch, and its settle pushes it onto the
        // card's PR although `review` requires no PR of its own.
        yield* service.send({ sessionId: reviewRun, content: "address it" });
        yield* waitUntil(
          service.get(reviewRun),
          (snapshot) =>
            !snapshot.live.busy &&
            snapshot.entries.some((entry) => entry.kind === "assistant"),
          "the review run to settle",
        );
        const reviewDecision = yield* decided(reviewRun);
        const reviewCommit = git(checkout, "rev-parse", `factory/${first}`);
        const runs = yield* sql<{ id: string; branch: string | null }>`
          SELECT s.id, s.branch FROM task_runs tr JOIN sessions s ON s.id = tr.session_id
          WHERE tr.task_id = ${card.id} ORDER BY tr.started_at, tr.id
        `;
        return {
          first,
          second: second.id,
          followUp,
          reviewRun,
          firstDecision,
          firstPr,
          firstCommit,
          secondCut,
          secondDecision,
          secondPr,
          secondCommit,
          forgeAfterSecond,
          lastPushAfterSecond,
          asked,
          moved,
          branchAfterDiscard,
          reviewDiff,
          reviewDecision,
          reviewCommit,
          reviewPr: yield* recordedPr(reviewRun),
          steerFirst,
          runs,
          forgeHead: git(forgeRepo, "rev-parse", `refs/heads/factory/${first}`),
        };
      }),
    );

    const branch = `factory/${outcome.first}`;
    // The first run opened the card's one PR, from its own branch.
    expect(outcome.firstDecision).toEqual(["opened"]);
    expect(outcome.steerFirst).toMatchObject({ code: "invalid_input" });
    expect(outcome.steerFirst.message).toContain(
      `the card's later run ${outcome.second} took it over`,
    );
    expect(outcome.firstPr?.head).toBe(branch);
    expect(created).toEqual([{ head: branch, base: "main" }]);

    // The second run was cut on the card's branch, with the first run's commit and change in it;
    // the first run's worktree let go of the branch.
    expect(outcome.secondCut).toEqual({
      branch,
      head: outcome.firstCommit,
      hasFirstChange: true,
      firstDetached: "HEAD",
    });
    // It settled with its own commit on the card's branch, and adopted the card's PR: nothing new
    // was asked of GitHub, and its commit was pushed onto the PR's branch.
    expect(outcome.secondCommit).not.toBe(outcome.firstCommit);
    expect(outcome.secondDecision).toEqual(["opened"]);
    expect(created).toHaveLength(1);
    // The card's PR, recorded at the commit each run published it at.
    expect(outcome.firstPr?.commit).toBe(outcome.firstCommit);
    expect(outcome.secondPr).toEqual({
      ...outcome.firstPr,
      commit: outcome.secondCommit,
    });
    expect(outcome.forgeAfterSecond).toBe(outcome.secondCommit);
    expect(outcome.lastPushAfterSecond).toEqual({
      branch,
      commit: outcome.secondCommit,
    });
    expect(outcome.asked).toEqual({
      number: outcome.firstPr?.number,
      url: outcome.firstPr?.url,
      outcome: "already-open",
    });

    // `pr_link` (and `non_empty_diff`) read the card's branch and PR.
    expect(outcome.moved.column).toBe("review");
    // The discarded follow-up's teardown left the branch its card's other runs are on.
    expect(outcome.branchAfterDiscard).toBe(outcome.secondCommit);

    // The review run's worktree holds both building runs' change.
    expect(outcome.reviewDiff.split("\n").sort()).toEqual([
      "change-1.txt",
      "change-2.txt",
    ]);
    // The review run's fix reached the card's PR: adopted, pushed, no second PR.
    expect(outcome.reviewCommit).not.toBe(outcome.secondCommit);
    expect(outcome.reviewDecision).toEqual(["opened"]);
    expect(outcome.reviewPr).toEqual({
      ...outcome.firstPr,
      commit: outcome.reviewCommit,
    });
    expect(outcome.forgeHead).toBe(outcome.reviewCommit);
    expect(created).toHaveLength(1);
    // Every run after the first is bound to the first's branch by name.
    expect(outcome.runs).toEqual([
      { id: outcome.first, branch: null },
      { id: outcome.second, branch },
      { id: outcome.followUp, branch },
      { id: outcome.reviewRun, branch },
    ]);
  }, 240_000);

  /**
   * The busy hand-over (C19): a start that would take the branch from under a busy run is refused,
   * and (D9) so is the move while that run has not completed its turn. On a card pinned to default version 4, which declares no caps, so the busy run
   * is the only thing that stops a second start.
   *
   * Mutations this catches: drop `refuseBusyHolder` — the third start takes the branch over from
   * under the busy run; read no turn for `run_completed` — the busy run's card moves on.
   */
  it("refuses a move while a later run on the branch is busy, and a start while it is", async () => {
    const outcome = await runtime.runPromise(
      Effect.gen(function* () {
        const service = yield* SessionService;
        const tasks = yield* TaskService;
        const sql = yield* SqlClient;
        yield* service.registerRepo({
          repo: gadgetRepo,
          url: `https://github.com/${gadgetRepo}.git`,
          localPath: checkout,
        });
        const board = yield* tasks.createBoard({
          repo: gadgetRepo,
          definitionId: DefinitionId.make(DEFAULT_DEFINITION_ID),
        });
        const card = yield* tasks.create({
          boardId: BoardInstanceId.make(board.id),
          title: "ship the gadget",
          actor: "person:c19",
        });
        yield* sql`
          UPDATE tasks SET "column" = 'building', definition_version = 4 WHERE id = ${card.id}
        `;

        const first = yield* runOnCard(card.id, "building", "build it");
        const firstDecision = yield* decided(first);
        const branch = `factory/${first}`;

        // The second run is held busy before it commits anything.
        writeFileSync(hold, "");
        const second = yield* service.create({
          taskId: card.id,
          taskColumn: "building",
        });
        yield* service.send({ sessionId: second.id, content: "fix it up" });
        yield* waitUntil(
          service.get(second.id),
          (snapshot) => snapshot.live.busy,
          "the second run to turn busy",
        );
        const thirdStart = yield* service
          .create({ taskId: card.id, taskColumn: "building" })
          .pipe(Effect.flip);

        // The move is refused while that run is busy: it has not completed its turn (`run_completed`).
        const busy = yield* tasks.get(card.id);
        const refusedBusy = yield* tasks
          .move({
            taskId: card.id,
            expectedRevision: busy.revision,
            to: "review",
            actor: "person:c19",
          })
          .pipe(Effect.flip);

        // The run finishes, and its settle pushes the branch onto the card's PR.
        rmSync(hold);
        const secondDecision = yield* decided(second.id);
        yield* waitUntil(
          service.get(second.id),
          (snapshot) =>
            !snapshot.live.busy &&
            snapshot.entries.some((entry) => entry.kind === "assistant"),
          "the second run to settle",
        );

        // Its settle recorded the card's PR at the branch's tip, so the move goes through. (A run
        // that committed past its PR and never published is `prLinkVerdict`'s unit case: a run that
        // has completed its turn has had its PR step run, and a busy one is held by `run_completed`.)
        const tip = git(checkout, "rev-parse", branch);
        const again = yield* tasks.get(card.id);
        const moved = yield* tasks.move({
          taskId: card.id,
          expectedRevision: again.revision,
          to: "review",
          actor: "person:c19",
        });
        return {
          first,
          second: second.id,
          branch,
          firstDecision,
          thirdStart,
          refusedBusy,
          secondDecision,
          tip,
          forgeHead: git(forgeRepo, "rev-parse", `refs/heads/${branch}`),
          secondPr: yield* recordedPr(second.id),
          moved,
          runs: yield* sql<{ id: string }>`
            SELECT session_id AS id FROM task_runs WHERE task_id = ${card.id}
          `,
        };
      }),
    );

    expect(outcome.firstDecision).toEqual(["opened"]);
    expect(outcome.thirdStart).toMatchObject({ code: "busy" });
    expect(outcome.thirdStart.message).toContain(
      `run ${outcome.second} of task`,
    );
    // The refused start wrote no run.
    expect(outcome.runs).toHaveLength(2);
    expect(outcome.refusedBusy).toMatchObject({
      _tag: "RequirementUnmet",
      requirement: "run_completed",
    });
    expect(outcome.secondDecision).toEqual(["opened"]);
    expect(outcome.forgeHead).toBe(outcome.tip);
    expect(outcome.secondPr?.commit).toBe(outcome.tip);
    expect(outcome.secondPr?.head).toBe(outcome.branch);
    expect(outcome.moved.column).toBe("review");
  }, 240_000);
  /**
   * F15: a card's later run is bound to its first change run's `factory/<that id>` (C19), and its
   * agent's own `git push` of that branch runs, while a push of any other `refs/heads/factory/*` —
   * its own id's included — is refused. The agent runs in a process of its own (`aliasOf`) whose
   * command names the first run's branch (the faux command is fixed per process), and with no settle
   * PR step, so the forge's branch can only have moved by the agent's push.
   *
   * Mutations this catches: hand `forWorktree` the session's own id and no branch — the agent's push
   * is refused and the forge stays at the first run's commit, and the mission check below is let
   * through; drop the branch from `refuseUnpolicedChecks` — the same for the check.
   */
  it("lets a later run's agent push the card's branch it is bound to, and refuses another factory branch", async () => {
    const boundRepo = RepoSlug.make(`c19-${runId}/bound`);
    const { first, card } = await runtime.runPromise(
      Effect.gen(function* () {
        const service = yield* SessionService;
        const tasks = yield* TaskService;
        const sql = yield* SqlClient;
        yield* service.registerRepo({
          repo: boundRepo,
          url: `https://github.com/${boundRepo}.git`,
          localPath: checkout,
        });
        const board = yield* tasks.createBoard({
          repo: boundRepo,
          definitionId: DefinitionId.make(DEFAULT_DEFINITION_ID),
        });
        const card = yield* tasks.create({
          boardId: BoardInstanceId.make(board.id),
          title: "push the card's branch",
          actor: "person:c19",
        });
        yield* sql`UPDATE tasks SET "column" = 'building' WHERE id = ${card.id}`;
        const first = yield* runOnCard(card.id, "building", "build it");
        yield* decided(first);
        return { first, card: card.id };
      }),
    );
    const branch = `factory/${first}`;
    const firstCommit = git(forgeRepo, "rev-parse", `refs/heads/${branch}`);

    const boundRoot = aliasOf(sessionRoot);
    const boundProcess = ManagedRuntime.make(
      SessionServiceLive({
        model: createFauxModelAccess({
          fauxCommand: [
            'echo bound > bound-change.txt',
            'git add -A && git -c user.email=f15@localhost -c user.name=f15 commit -qm "f15 bound change"',
            `git push -q ${forgeRepo} HEAD:refs/heads/${branch}`,
            "echo faux-ok",
          ].join(" && "),
        }).access,
        sessionRoot: boundRoot,
        repoRemote,
      }).pipe(Layer.provideMerge(DatabaseLayer)),
    );
    extraRuntimes.push(boundProcess);
    const outcome = await boundProcess.runPromise(
      Effect.gen(function* () {
        const service = yield* SessionService;
        const later = yield* service.create({
          taskId: card,
          taskColumn: "building",
        });
        yield* service.send({ sessionId: later.id, content: "push it" });
        const settled = yield* waitUntil(
          service.get(later.id),
          (snapshot) =>
            !snapshot.live.busy &&
            snapshot.entries.some((entry) => entry.kind === "assistant"),
          "the bound run to settle",
        );
        const worktree = join(boundRoot, ...boundRepo.split("/"), later.id);
        // A check is held to the session's own policy (LOB-230): a push of its own id's branch is
        // another session's branch here, refused naming the one it is bound to.
        const refusedCheck = yield* service
          .startMission({
            sessionId: later.id,
            feature: "push elsewhere",
            workers: [
              {
                id: "elsewhere",
                prompt: "push",
                check: `git push -q ${forgeRepo} HEAD:refs/heads/factory/${later.id}`,
              },
            ],
          })
          .pipe(Effect.flip);
        return {
          later: later.id,
          bound: git(worktree, "rev-parse", "--abbrev-ref", "HEAD"),
          tip: git(worktree, "rev-parse", "HEAD"),
          toolResults: settled.entries
            .filter((entry) => entry.kind === "toolResult")
            .map((entry) => ({ text: entry.text, isError: entry.isError })),
          refusedCheck,
        };
      }),
    );

    expect(outcome.bound).toBe(branch);
    // The agent's push ran: the forge's card branch is at the later run's own commit.
    expect(outcome.toolResults).toHaveLength(1);
    expect(outcome.toolResults[0]?.text).not.toContain("is refused");
    expect(outcome.toolResults[0]?.text).toContain("faux-ok");
    expect(outcome.tip).not.toBe(firstCommit);
    expect(git(forgeRepo, "rev-parse", `refs/heads/${branch}`)).toBe(
      outcome.tip,
    );
    // Any other factory branch — the later run's own id's — is refused, naming the card's.
    expect(outcome.refusedCheck).toMatchObject({ code: "invalid_input" });
    expect(outcome.refusedCheck.message).toContain(
      `pushing refs/heads/factory/${outcome.later} is refused: this session owns refs/heads/${branch}`,
    );
  }, 240_000);

  /**
   * F12: the card's PR closed without merging is recorded on its session (`pr_closed_at`), and the
   * card's next building run, continuing the same branch, opens a fresh PR from it instead of pushing
   * onto the closed one. (With the PR open, the first case above: it adopts it.)
   *
   * Mutation this catches: drop `pr_closed_at IS NULL` from `cardPullRequestFor` — the later run
   * adopts the closed PR, GitHub is asked for nothing, and its record names the closed PR.
   */
  it("opens a new PR on a later run once the card's PR was closed unmerged", async () => {
    const closedRepo = RepoSlug.make(`c19-${runId}/closed`);
    const asked = created.length;
    const outcome = await runtime.runPromise(
      Effect.gen(function* () {
        const service = yield* SessionService;
        const tasks = yield* TaskService;
        const sql = yield* SqlClient;
        yield* service.registerRepo({
          repo: closedRepo,
          url: `https://github.com/${closedRepo}.git`,
          localPath: checkout,
        });
        const board = yield* tasks.createBoard({
          repo: closedRepo,
          definitionId: DefinitionId.make(DEFAULT_DEFINITION_ID),
        });
        const card = yield* tasks.create({
          boardId: BoardInstanceId.make(board.id),
          title: "reopen the work",
          actor: "person:c19",
        });
        yield* sql`UPDATE tasks SET "column" = 'building' WHERE id = ${card.id}`;
        const first = yield* runOnCard(card.id, "building", "build it");
        yield* decided(first);
        const firstPr = yield* recordedPr(first);
        // The PR is closed on GitHub without a merge, as the webhook reports it.
        yield* service.recordMerge({
          sessionId: first,
          event: {
            _tag: "closed",
            url: firstPr?.url ?? "",
            number: firstPr?.number ?? 0,
            closedAt: "2026-10-28T12:00:00Z",
          },
        });
        const closedRows = yield* sql<{ closed: boolean }>`
          SELECT pr_closed_at IS NOT NULL AS closed FROM sessions WHERE id = ${first}
        `;
        const second = yield* runOnCard(card.id, "building", "try again");
        const secondDecision = yield* decided(second);
        return {
          first,
          firstPr,
          closed: closedRows[0]?.closed,
          second,
          secondDecision,
          secondPr: yield* recordedPr(second),
          secondRow: (yield* sql<{ prUrl: string | null }>`
            SELECT pr_url FROM sessions WHERE id = ${second}
          `)[0]?.prUrl,
        };
      }),
    );
    const branch = `factory/${outcome.first}`;
    expect(outcome.closed).toBe(true);
    // Two PRs asked of GitHub, both from the card's one branch: the first run's, and the new one.
    expect(created.slice(asked)).toEqual([
      { head: branch, base: "main" },
      { head: branch, base: "main" },
    ]);
    expect(outcome.secondDecision).toEqual(["opened"]);
    expect(outcome.secondPr?.head).toBe(branch);
    expect(outcome.secondPr?.url).not.toBe(outcome.firstPr?.url);
    expect(outcome.secondRow).toBe(outcome.secondPr?.url);
  }, 240_000);
});
