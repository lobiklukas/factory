/**
 * A card follows its PR (C20): a signed `pull_request` close settles the card whose PR it is — a
 * merge moves it to `done` exactly once across redeliveries, an unmerged close blocks it naming the
 * PR — and the PR-state read when the card is opened does the same for a box with no webhook.
 *
 * Real Postgres, a real session service over a git fixture (the card's run has a worktree and a
 * branch, which the merge releases), and the real task service. GitHub is two fakes, per
 * docs/testing-third-parties.md's GitHub row: the deliveries are payloads this file signs with its
 * own secret, and the forge read is an `HttpClient.make` that answers what each case sets — or a
 * `PullRequestStates` that does, for the cases about what the card does with an answer. Nothing
 * leaves the process.
 *
 * Postgres only, not mocked: `docker compose up -d --wait postgres`.
 */
import { BunServices } from "@effect/platform-bun";
import { createHmac, randomBytes } from "node:crypto";
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RepoSlug, type SessionId } from "@repo/domain/Session";
import { DEFAULT_DEFINITION_ID, DefinitionId } from "@repo/domain/Task";
import { createFauxModelAccess, readRecordedMerge } from "@repo/harness";
import { DatabaseLive, PostgresStorage } from "@repo/storage-postgres";
import {
  Effect,
  Fiber,
  Layer,
  ManagedRuntime,
  Option,
  Redacted,
} from "effect";
import { TestClock } from "effect/testing";
import { HttpClient, HttpClientResponse } from "effect/http";
import { SqlClient } from "effect/sql/SqlClient";
import { afterAll, describe, expect, it } from "vitest";
import {
  type PullRequestState,
  PullRequestStates,
  PullRequestStatesLive,
  pullRequestOfPage,
  readPullRequestState,
  refreshCardPullRequest,
  STATE_READ_TIMEOUT,
  settleCardsOfDelivery,
} from "./cardPullRequest";
import { CredentialProvider, staticTokenProvider } from "./credentials";
import { SessionService, SessionServiceLive } from "./SessionService";
import { TaskService, TaskServiceLive } from "./TaskService";

const run = randomBytes(4).toString("hex");
const SECRET = "c20-webhook-secret";

const sessionRoot = mkdtempSync(join(tmpdir(), "factory-c20-"));
const checkout = mkdtempSync(join(tmpdir(), "factory-c20-repo-"));
execSync(
  "git init -q -b main && git -c user.email=t@t.com -c user.name=t commit -q --allow-empty -m base",
  { cwd: checkout, stdio: "ignore" },
);

/** What the fake `PullRequestStates` answers per PR page, and every page it was asked for. */
const states = new Map<string, PullRequestState | undefined>();
const asked: Array<string> = [];

const runtime = ManagedRuntime.make(
  Layer.mergeAll(
    TaskServiceLive,
    Layer.succeed(
      PullRequestStates,
      PullRequestStates.of({
        read: (url) =>
          Effect.sync(() => {
            asked.push(url);
            return states.get(url);
          }),
      }),
    ),
  ).pipe(
    Layer.provideMerge(
      SessionServiceLive({
        model: createFauxModelAccess().access,
        sessionRoot,
      }),
    ),
    Layer.provideMerge(Layer.mergeAll(DatabaseLive, BunServices.layer)),
  ),
);

afterAll(() => runtime.dispose());

let counter = 0;

/**
 * A card in `review` on a board over a fresh repository whose checkout is the fixture, with one run
 * per PR in `prs` (oldest first), each recorded as having opened that PR (`sessions.pr_url`, which
 * the PR step writes). Answers the card and its runs.
 */
const cardWithPrs = (prs: ReadonlyArray<string>) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const tasks = yield* TaskService;
      const sessions = yield* SessionService;
      const sql = yield* SqlClient;
      counter += 1;
      const repo = RepoSlug.make(`factory-test/c20-${run}-${counter}`);
      yield* sessions.registerRepo({ repo, localPath: checkout });
      const board = yield* tasks.createBoard({
        repo,
        definitionId: DefinitionId.make(DEFAULT_DEFINITION_ID),
        definitionVersion: 1,
      });
      const card = yield* tasks.create({
        boardId: board.id,
        title: "c20",
        actor: "person:lukas",
      });
      // Seated in review by the row, as `TaskService.test.ts`'s `seatInReview` does: the walk there
      // is not what these cases are about.
      yield* sql`
        UPDATE tasks SET "column" = 'review', revision = 2 WHERE id = ${card.id}
      `;
      const runs: Array<SessionId> = [];
      for (const url of prs) {
        const created = yield* sessions.create({
          repo,
          baseRef: "main",
          taskId: card.id,
          taskColumn: "building",
        });
        yield* sql`UPDATE sessions SET pr_url = ${url} WHERE id = ${created.id}`;
        runs.push(created.id);
      }
      return { taskId: card.id, runs };
    }),
  );

const prPage = (number: number) =>
  `https://github.com/factory-test/c20-${run}/pull/${number}`;

const sign = (raw: string) =>
  `sha256=${createHmac("sha256", SECRET).update(raw).digest("hex")}`;

/** One `pull_request` closed delivery of `url`, merged or not, signed unless `signature` says. */
const deliver = (
  url: string,
  merged: boolean,
  signature: (raw: string) => string = sign,
) => {
  const raw = JSON.stringify({
    action: "closed",
    pull_request: {
      number: Number(url.split("/").at(-1)),
      html_url: url,
      merged,
      ...(merged ? { merged_at: "2026-10-28T12:00:00Z" } : {}),
    },
  });
  return runtime.runPromise(
    settleCardsOfDelivery({ secret: SECRET, raw, signature: signature(raw) }),
  );
};

const card = (taskId: string) =>
  runtime.runPromise(Effect.flatMap(TaskService, (s) => s.get(taskId)));

/** The card's events, oldest first, as kind and actor. */
const events = (taskId: string) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      return yield* sql<{ kind: string; actor: string }>`
        SELECT kind, actor FROM task_events WHERE task_id = ${taskId} ORDER BY id
      `;
    }),
  );

/** The session's index row as far as the merge goes: when it merged, and whether it was released. */
const sessionRow = (sessionId: string) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const rows = yield* sql<{
        prMergedAt: Date | null;
        workspaceReleasedAt: Date | null;
      }>`
        SELECT pr_merged_at, workspace_released_at FROM sessions WHERE id = ${sessionId}
      `;
      return rows[0];
    }),
  );

/** The merge the session's log records (`factory.merge`), read as `human_merge` reads it. */
const loggedMerge = (sessionId: string) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const logs = yield* Effect.promise(() =>
        PostgresStorage.readers(sql, [sessionId], { checkpoints: true }),
      );
      const storage = logs.get(sessionId);
      return storage === undefined
        ? undefined
        : yield* Effect.orDie(readRecordedMerge(storage));
    }),
  );

describe("a signed pull_request close settles the card (C20)", () => {
  /**
   * Mutation: drop the terminal check under the lock — the redelivery appends a second `moved`.
   * Mutation: skip `releaseFinishedCard` — the run's workspace outlives its finished card.
   */
  it("moves the card to done on a merge, exactly once across redeliveries, and releases its run", async () => {
    const url = prPage(1);
    const { taskId, runs } = await cardWithPrs([url]);
    expect(await deliver(url, true)).toEqual({ done: 1, blocked: 0 });
    expect(await card(taskId)).toMatchObject({ column: "done", revision: 3 });
    expect(
      (await sessionRow(runs[0] ?? ""))?.workspaceReleasedAt,
    ).not.toBeNull();
    expect(await deliver(url, true)).toEqual({ done: 0, blocked: 0 });
    expect(await card(taskId)).toMatchObject({ column: "done", revision: 3 });
    expect(
      (await events(taskId)).filter((event) => event.kind === "moved"),
    ).toEqual([{ kind: "moved", actor: `merge:${url}` }]);
  }, 60_000);

  /** Mutation: treat an unmerged close as a merge — the card would reach done. */
  it("blocks the card pr_closed on an unmerged close, naming the PR, once", async () => {
    const url = prPage(2);
    const { taskId } = await cardWithPrs([url]);
    expect(await deliver(url, false)).toEqual({ done: 0, blocked: 1 });
    const blocked = await card(taskId);
    expect(blocked).toMatchObject({
      column: "review",
      blocked: { reason: "pr_closed", column: "review" },
    });
    expect(blocked.blocked?.note).toContain(`pull request #2 (${url})`);
    expect(await deliver(url, false)).toEqual({ done: 0, blocked: 0 });
    expect((await card(taskId)).revision).toBe(blocked.revision);
  }, 60_000);

  /** Mutation: drop the signature check — an unsigned caller could finish any card. */
  it("settles nothing for a delivery whose signature is wrong", async () => {
    const url = prPage(3);
    const { taskId } = await cardWithPrs([url]);
    expect(await deliver(url, true, () => "sha256=00")).toEqual({
      done: 0,
      blocked: 0,
    });
    expect(await card(taskId)).toMatchObject({ column: "review", revision: 2 });
  }, 60_000);

  /**
   * Mutation: match every card any of whose runs recorded the PR — a PR the card's later run replaced
   * would finish (or block) the card when it merges (or closes).
   */
  it("leaves a card whose newest PR is another: a replaced PR's close says nothing about it", async () => {
    const replaced = prPage(4);
    const current = prPage(5);
    const { taskId } = await cardWithPrs([replaced, current]);
    expect(await deliver(replaced, false)).toEqual({ done: 0, blocked: 0 });
    expect(await deliver(replaced, true)).toEqual({ done: 0, blocked: 0 });
    expect(await card(taskId)).toMatchObject({ column: "review", revision: 2 });
    expect(await deliver(current, true)).toEqual({ done: 1, blocked: 0 });
  }, 60_000);
});

describe("the card's PR read when the card is opened (C20)", () => {
  const refresh = (taskId: string, settle: boolean) =>
    runtime.runPromise(refreshCardPullRequest(taskId, { settle }));

  /**
   * Mutation: settle without recording — `human_merge` would find no merge on the log. Mutation:
   * ignore `settle` — a move's read would finish the card under the person's own move.
   */
  it("records a merge GitHub reports on the PR's runs, and moves the card only when it settles", async () => {
    const url = prPage(10);
    const { taskId, runs } = await cardWithPrs([url]);
    states.set(url, {
      _tag: "merged",
      mergedAt: "2026-10-28T13:00:00Z",
      commit: "c0ffee",
    });
    expect(await refresh(taskId, false)).toEqual({
      pr: url,
      state: "merged",
      changed: false,
    });
    expect(await card(taskId)).toMatchObject({ column: "review", revision: 2 });
    expect((await sessionRow(runs[0] ?? ""))?.prMergedAt).not.toBeNull();
    expect(await loggedMerge(runs[0] ?? "")).toMatchObject({
      url,
      number: 10,
      commit: "c0ffee",
    });
    // The merge is on record now, so the next read settles from it without asking GitHub again.
    const before = asked.length;
    expect(await refresh(taskId, true)).toEqual({
      pr: url,
      state: "merged",
      changed: true,
    });
    expect(asked.length).toBe(before);
    expect(await card(taskId)).toMatchObject({ column: "done", revision: 3 });
  }, 60_000);

  it("blocks the card on a close GitHub reports, and leaves it on an open PR or no answer", async () => {
    const open = prPage(11);
    const silent = prPage(12);
    const closed = prPage(13);
    states.set(open, { _tag: "open" });
    states.set(silent, undefined);
    states.set(closed, { _tag: "closed" });
    const openCard = await cardWithPrs([open]);
    expect(await refresh(openCard.taskId, true)).toEqual({
      pr: open,
      state: "open",
      changed: false,
    });
    const silentCard = await cardWithPrs([silent]);
    expect(await refresh(silentCard.taskId, true)).toEqual({
      pr: silent,
      changed: false,
    });
    for (const { taskId } of [openCard, silentCard])
      expect(await card(taskId)).toMatchObject({
        column: "review",
        revision: 2,
      });
    const closedCard = await cardWithPrs([closed]);
    expect(await refresh(closedCard.taskId, true)).toMatchObject({
      state: "closed",
      changed: true,
    });
    expect((await card(closedCard.taskId)).blocked?.reason).toBe("pr_closed");
  }, 60_000);

  /**
   * Mutation: block on every read of a closed PR — the pane's poll would block the card again after
   * every unblock, so a person could never carry on without reopening the PR.
   */
  it("leaves a card a person unblocked after its PR closed unblocked on the next read", async () => {
    const closed = prPage(15);
    states.set(closed, { _tag: "closed" });
    const { taskId } = await cardWithPrs([closed]);
    expect((await refresh(taskId, true)).changed).toBe(true);
    const blocked = await card(taskId);
    await runtime.runPromise(
      Effect.flatMap(TaskService, (s) =>
        s.unblock({
          taskId,
          expectedRevision: blocked.revision,
          actor: "person:lukas",
        }),
      ),
    );
    expect(await refresh(taskId, true)).toEqual({
      pr: closed,
      state: "closed",
      changed: false,
    });
    expect(await card(taskId)).toMatchObject({
      revision: blocked.revision + 1,
    });
    expect((await card(taskId)).blocked).toBeUndefined();
    expect((await events(taskId)).map((event) => event.kind)).toEqual([
      "created",
      "blocked",
      "unblocked",
    ]);
  }, 60_000);

  /** Mutation: read a finished card's PR — every open of a done card would ask GitHub. */
  it("reads nothing for a card with no PR or a finished card", async () => {
    const none = await cardWithPrs([]);
    const before = asked.length;
    expect(await refresh(none.taskId, true)).toEqual({ changed: false });
    const url = prPage(14);
    const finished = await cardWithPrs([url]);
    await deliver(url, true);
    expect(await refresh(finished.taskId, true)).toEqual({ changed: false });
    expect(asked.length).toBe(before);
  }, 60_000);
});

describe("readPullRequestState (C20)", () => {
  /** Every request the fake forge was sent, and the body it answers next. */
  const requests: Array<{ readonly path: string; readonly auth: string }> = [];
  let next: { readonly status: number; readonly body: unknown } = {
    status: 200,
    body: {},
  };
  const forge = Layer.merge(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request, url) =>
        Effect.sync(() => {
          requests.push({
            path: url.pathname,
            auth: request.headers["authorization"] ?? "",
          });
          return HttpClientResponse.fromWeb(
            request,
            new Response(JSON.stringify(next.body), {
              status: next.status,
              headers: { "content-type": "application/json" },
            }),
          );
        }),
      ),
    ),
    Layer.succeed(
      CredentialProvider,
      staticTokenProvider(Option.some(Redacted.make("c20-fake-token"))),
    ),
  );
  const read = (url: string) =>
    Effect.runPromise(
      readPullRequestState(url).pipe(
        Effect.provide(forge),
        Effect.match({
          onFailure: (error) => ({ error: error.message }),
          onSuccess: (state) => state,
        }),
      ),
    );

  it("parses a PR page, or its API resource, into its repository and number, and nothing else", () => {
    expect(pullRequestOfPage("https://github.com/o/r/pull/7")).toEqual({
      repo: "o/r",
      number: 7,
    });
    expect(pullRequestOfPage("https://ghe.example/o/r.js/pull/12/")).toEqual({
      repo: "o/r.js",
      number: 12,
    });
    // An older session's `pr_url` is the API resource, which names the same PR.
    expect(pullRequestOfPage("https://api.github.com/repos/o/r/pulls/7")).toEqual(
      { repo: "o/r", number: 7 },
    );
    expect(
      pullRequestOfPage("https://ghe.example/api/v3/repos/o/r/pulls/3"),
    ).toEqual({ repo: "o/r", number: 3 });
    for (const url of [
      "https://github.com/o/r/issues/7",
      "https://api.github.com/repos/o/r/issues/7",
      "not a url",
    ])
      expect(pullRequestOfPage(url)).toBeUndefined();
  });

  /** Mutation: read `state` alone — a merged PR (GitHub says `closed`) would read as closed unmerged. */
  it("asks the PR's own resource with the repo's token, and tells merged from closed from open", async () => {
    next = {
      status: 200,
      body: {
        state: "closed",
        merged: true,
        merged_at: "2026-10-28T12:00:00Z",
        merge_commit_sha: "abc123",
      },
    };
    expect(await read("https://github.com/o/r/pull/7")).toEqual({
      _tag: "merged",
      mergedAt: "2026-10-28T12:00:00Z",
      commit: "abc123",
    });
    expect(requests.at(-1)).toEqual({
      path: "/repos/o/r/pulls/7",
      auth: "Bearer c20-fake-token",
    });
    next = { status: 200, body: { state: "closed", merged: false } };
    expect(await read("https://github.com/o/r/pull/7")).toEqual({
      _tag: "closed",
    });
    next = {
      status: 200,
      body: { state: "open", merged: false, merged_at: null },
    };
    expect(await read("https://github.com/o/r/pull/7")).toEqual({
      _tag: "open",
    });
    // GitHub's status is named, so a bad token (401) reads apart from a deleted PR (404).
    next = { status: 404, body: { message: "Not Found" } };
    expect(await read("https://github.com/o/r/pull/7")).toEqual({
      error: "GitHub answered 404",
    });
    next = { status: 200, body: { merged: true } };
    expect(await read("https://github.com/o/r/pull/7")).toEqual({
      error: "GitHub's answer for the PR could not be read",
    });
    const sent = requests.length;
    expect(await read("https://github.com/o/r/issues/7")).toEqual({
      error: "the PR's link is not a GitHub pull request page",
    });
    expect(requests.length).toBe(sent);
  });

  /**
   * Mutation: never keep a failure — a box with no token, or a forge that errors, would be asked (and
   * warn) on every poll of every open pane. Mutation: keep it past a fresh read — a move right after
   * the forge came back would still be judged on nothing.
   */
  it("keeps one answer per PR for a while, a failure too, and a fresh read asks past either", async () => {
    const reads = (url: string) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const reader = yield* PullRequestStates;
          return [yield* reader.read(url), yield* reader.read(url)];
        }).pipe(
          Effect.provide(PullRequestStatesLive.pipe(Layer.provide(forge))),
        ),
      );
    next = { status: 200, body: { state: "open" } };
    const sent = requests.length;
    expect(await reads("https://github.com/o/r/pull/8")).toEqual([
      { _tag: "open" },
      { _tag: "open" },
    ]);
    expect(requests.length).toBe(sent + 1);
    next = { status: 500, body: {} };
    const afterFailure = await Effect.runPromise(
      Effect.gen(function* () {
        const reader = yield* PullRequestStates;
        const first = yield* reader.read("https://github.com/o/r/pull/9");
        const kept = yield* reader.read("https://github.com/o/r/pull/9");
        next = { status: 200, body: { state: "open" } };
        const fresh = yield* reader.read("https://github.com/o/r/pull/9", {
          fresh: true,
        });
        return [first, kept, fresh];
      }).pipe(Effect.provide(PullRequestStatesLive.pipe(Layer.provide(forge)))),
    );
    expect(afterFailure).toEqual([undefined, undefined, { _tag: "open" }]);
    expect(requests.length).toBe(sent + 3);
  });

  /**
   * Mutation: drop the timeout — a forge that never answers would hold a person's move into done,
   * and the card pane's checklist, until the fetch gave up.
   */
  it("gives up on a forge that does not answer within STATE_READ_TIMEOUT", async () => {
    const hanging = Layer.merge(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.never),
      ),
      Layer.succeed(
        CredentialProvider,
        staticTokenProvider(Option.some(Redacted.make("c20-fake-token"))),
      ),
    );
    const answer = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          readPullRequestState("https://github.com/o/r/pull/7").pipe(
            Effect.provide(hanging),
            Effect.match({
              onFailure: (error) => error.message,
              onSuccess: () => "answered",
            }),
          ),
        );
        yield* TestClock.adjust(STATE_READ_TIMEOUT);
        return yield* Fiber.join(fiber);
      }).pipe(Effect.provide(TestClock.layer())),
    );
    expect(answer).toBe("GitHub did not answer within 5s");
  });

  /** Mutation: ignore `fresh` — a move right after the merge would be judged on the kept "open". */
  it("asks GitHub again when the read is fresh, past the answer it kept", async () => {
    next = { status: 200, body: { state: "open" } };
    const sent = requests.length;
    const answers = await Effect.runPromise(
      Effect.gen(function* () {
        const reader = yield* PullRequestStates;
        const kept = yield* reader.read("https://github.com/o/r/pull/10");
        next = { status: 200, body: { state: "closed", merged: true } };
        const stale = yield* reader.read("https://github.com/o/r/pull/10");
        const fresh = yield* reader.read("https://github.com/o/r/pull/10", {
          fresh: true,
        });
        return [kept?._tag, stale?._tag, fresh?._tag];
      }).pipe(Effect.provide(PullRequestStatesLive.pipe(Layer.provide(forge)))),
    );
    expect(answers).toEqual(["open", "open", "merged"]);
    expect(requests.length).toBe(sent + 2);
  });
});
