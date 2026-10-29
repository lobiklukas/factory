/**
 * The notifier (S-notifications): what each event becomes as a message, what each sink sends, and —
 * over the real attention view and a real ledger — that every event reaches a sink exactly once,
 * across passes and across a restart, and that a kind turned off is never sent.
 *
 * The sinks under the ledger cases are a recording fake, and each case names its sink with a fresh
 * id, so the ledger rows it writes are its own even on the shared development database: every other
 * board's attention rows reach the fake too (the notifier reads every board), and the assertions
 * read only this case's events. The HTTP sinks are proven against an in-process `HttpClient` fake.
 *
 * Postgres only, not mocked: `docker compose up -d --wait postgres`.
 */
import { randomBytes } from "node:crypto";
import { Effect, Exit, Layer, ManagedRuntime, Redacted, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { SqlClient } from "effect/sql/SqlClient";
import { afterAll, describe, expect, it } from "vitest";
import { AttentionItem } from "@repo/domain/Task";
import { DatabaseLive } from "@repo/storage-postgres";
import { mintBoardId, mintSessionId } from "./ids";
import {
  cardLink,
  makeNotifier,
  NOTIFICATION_KINDS,
  type Notification,
  type NotificationKind,
  type NotificationSink,
  NotifyError,
  notificationOfAttention,
  notificationOfFailure,
  ntfyBody,
  ntfySink,
  parseNotifyKinds,
  sessionLink,
  slackWebhookBody,
  slackWebhookSink,
} from "./Notifier";
import { TaskService, TaskServiceLive } from "./TaskService";

const BASE = "http://dash.test";

const TASK_ID = `tsk_${"a".repeat(26)}`;
const BOARD_ID = `brd_${"b".repeat(26)}`;

/** A card as the attention view returns one; only the column varies between cases. */
const task = (column = "review") => ({
  id: TASK_ID,
  boardId: BOARD_ID,
  title: "Fix the login page",
  column,
  priority: "normal",
  revision: 3,
  definitionVersion: 1,
  createdAt: "2026-10-28T00:00:00.000Z",
  updatedAt: "2026-10-28T00:00:00.000Z",
});

/** An attention row, decoded by the domain's own schema so a case cannot build an impossible one. */
const attention = (row: unknown): AttentionItem =>
  Schema.decodeUnknownSync(AttentionItem)(row);

const SESSION = `ses_${"c".repeat(26)}`;

describe("parseNotifyKinds", () => {
  it("reads blank as every kind", async () => {
    const kinds = await Effect.runPromise(parseNotifyKinds("  "));
    expect([...kinds]).toEqual([...NOTIFICATION_KINDS]);
  });

  it("reads a subset, trimmed", async () => {
    const kinds = await Effect.runPromise(
      parseNotifyKinds(" question , failed"),
    );
    expect([...kinds].sort()).toEqual(["failed", "question"]);
  });

  it("refuses an unknown name, naming the ones that exist", async () => {
    const exit = await Effect.runPromiseExit(
      parseNotifyKinds("question,reviews"),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(String(exit)).toContain('"reviews"');
    expect(String(exit)).toContain("question, approval, gate, failed");
  });
});

describe("the message an event becomes", () => {
  it("a question links to the card's thread, keyed by the block", () => {
    const item = attention({
      task: task("specifying"),
      repo: "acme/widget",
      reason: {
        _tag: "question",
        question: "Which locale?",
        since: "2026-10-28T10:00:00.000Z",
      },
    });
    expect(notificationOfAttention(item, `${BASE}/`)).toEqual({
      eventId: `question:${TASK_ID}:2026-10-28T10:00:00.000Z`,
      kind: "question",
      title: 'Question on "Fix the login page"',
      body: "Which locale?\nacme/widget",
      link: `${BASE}/boards/${BOARD_ID}?card=${TASK_ID}#thread`,
    });
  });

  it("a spend cap's crossing is an event per cap, window, period and threshold, linked to the spend page", () => {
    const spend = (threshold: number) =>
      attention({
        reason: {
          _tag: "spend",
          scope: "repo",
          subject: "acme/web",
          window: "day",
          threshold,
          limit: 20,
          spent: threshold === 100 ? 20.4 : 16.5,
          since: "2026-10-28T10:00:00.000Z",
          resetsAt: "2026-10-29T00:00:00.000Z",
        },
      });
    const warned = notificationOfAttention(spend(80), `${BASE}/`);
    const reached = notificationOfAttention(spend(100), BASE);
    expect(warned).toEqual({
      eventId: "spend:repo:acme/web:day:2026-10-29T00:00:00.000Z:20:80",
      kind: "spend",
      title: "Spend at 80% of the daily cap for repository acme/web",
      body: "$16.50 of its $20.00 daily cap; new runs are refused once it is reached, until 2026-10-29T00:00:00.000Z.",
      link: `${BASE}/spend`,
    });
    expect(reached?.title).toBe("Spend cap reached for repository acme/web");
    expect(reached?.body).toContain(
      "new runs are refused until 2026-10-29T00:00:00.000Z",
    );
    // The two thresholds are two events, so each is told once.
    expect(reached?.eventId).not.toBe(warned?.eventId);
    // The next day's crossing of the same threshold is a new event, not the one already sent.
    const tomorrow = attention({
      reason: {
        _tag: "spend",
        scope: "repo",
        subject: "acme/web",
        window: "day",
        threshold: 80,
        limit: 20,
        spent: 16.5,
        since: "2026-10-29T10:00:00.000Z",
        resetsAt: "2026-10-30T00:00:00.000Z",
      },
    });
    expect(notificationOfAttention(tomorrow, BASE)?.eventId).not.toBe(
      warned?.eventId,
    );
    // A cap raised mid-window crosses its own 80% in the same window: not the event already sent.
    const raised = attention({
      reason: {
        _tag: "spend",
        scope: "repo",
        subject: "acme/web",
        window: "day",
        threshold: 80,
        limit: 50,
        spent: 41,
        since: "2026-10-28T12:00:00.000Z",
        resetsAt: "2026-10-29T00:00:00.000Z",
      },
    });
    expect(notificationOfAttention(raised, BASE)?.eventId).not.toBe(
      warned?.eventId,
    );
  });

  it("an approval on a card links to the run that asked", () => {
    const item = attention({
      task: task("building"),
      repo: "acme/widget",
      reason: {
        _tag: "approval",
        sessionId: SESSION,
        requestId: "req-1",
        action: "bash",
        detail: "git push --force",
        requestedAt: "2026-10-28T10:00:00.000Z",
      },
    });
    const message = notificationOfAttention(item, BASE);
    expect(message?.eventId).toBe(`approval:${SESSION}:req-1`);
    expect(message?.kind).toBe("approval");
    expect(message?.body).toBe("bash: git push --force\nacme/widget");
    expect(message?.link).toBe(
      `${BASE}/boards/${BOARD_ID}?card=${TASK_ID}&run=${SESSION}`,
    );
  });

  it("an approval no card owns links to its session, named by its title or id", () => {
    const item = attention({
      sessionTitle: "",
      reason: {
        _tag: "approval",
        sessionId: SESSION,
        requestId: "req-2",
        action: "bash",
        detail: "rm -rf build",
        requestedAt: "2026-10-28T10:00:00.000Z",
      },
    });
    const message = notificationOfAttention(item, BASE);
    expect(message?.title).toBe(`Approval needed on session "${SESSION}"`);
    expect(message?.link).toBe(`${BASE}/sessions/${SESSION}`);
  });

  it("a gate is keyed by card, column and run, and says what the person moves it to", () => {
    const item = attention({
      task: task(),
      repo: "acme/widget",
      reason: { _tag: "gate", gate: "human", to: "done", sessionId: SESSION },
    });
    const message = notificationOfAttention(item, BASE);
    expect(message?.eventId).toBe(`gate:${TASK_ID}:review:${SESSION}`);
    expect(message?.title).toBe('"Fix the login page" waits at human');
    expect(message?.body).toContain("moving it to done needs a person");
  });

  it("a failure links to the card's run, or to its session, and says a budget stop is one", () => {
    const onCard = notificationOfFailure(
      {
        sessionId: SESSION,
        entryId: "42",
        reason: "budget",
        detail: "budget reached",
        sessionTitle: "run",
        repo: "acme/widget",
        card: {
          taskId: TASK_ID,
          boardId: BOARD_ID,
          title: "Fix the login page",
        },
      },
      BASE,
    );
    expect(onCard).toEqual({
      eventId: `failed:${SESSION}:42`,
      kind: "failed",
      title: 'Run stopped by its budget on "Fix the login page"',
      body: "budget reached\nacme/widget",
      link: cardLink(BASE, {
        boardId: BOARD_ID,
        taskId: TASK_ID,
        run: SESSION,
      }),
    });
    const scratch = notificationOfFailure(
      {
        sessionId: SESSION,
        entryId: "7",
        reason: "model_error",
        detail: "x".repeat(900),
        sessionTitle: "scratch",
        repo: undefined,
        card: undefined,
      },
      BASE,
    );
    expect(scratch.title).toBe('Run failed on session "scratch"');
    expect(scratch.link).toBe(sessionLink(BASE, SESSION));
    // A notification points at the run; it does not carry the transcript.
    expect(scratch.body.length).toBe(500);
  });
});

const message: Notification = {
  eventId: "question:tsk_x:1",
  kind: "question",
  title: "Question on <b> & co",
  body: "Use > or <?",
  link: "http://dash.test/boards/brd_x?card=tsk_x#thread",
};

describe("the sinks' bodies", () => {
  it("Slack's text escapes its control characters and links the card", () => {
    expect(slackWebhookBody(message)).toEqual({
      text: "*Question on &lt;b&gt; &amp; co*\nUse &gt; or &lt;?\n<http://dash.test/boards/brd_x?card=tsk_x#thread|Open in factory>",
    });
  });

  it("ntfy's JSON names the topic, the title, the click target and the kind", () => {
    expect(ntfyBody(message, "factory-alerts")).toEqual({
      topic: "factory-alerts",
      title: "Question on <b> & co",
      message: "Use > or <?",
      click: "http://dash.test/boards/brd_x?card=tsk_x#thread",
      tags: ["factory", "question"],
    });
  });
});

/** An in-process HTTP fake that records every request and answers `status`. */
const fakeHttp = (status = 200) => {
  const requests: Array<{
    readonly url: string;
    readonly authorization: string | undefined;
    readonly body: unknown;
  }> = [];
  const Json = Schema.fromJsonString(Schema.Unknown);
  const layer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request, url) =>
      Effect.gen(function* () {
        const body =
          request.body._tag === "Uint8Array"
            ? yield* Schema.decodeEffect(Json)(
                new TextDecoder().decode(request.body.body),
              ).pipe(Effect.orDie)
            : undefined;
        requests.push({
          url: url.toString(),
          authorization: request.headers["authorization"],
          body,
        });
        return HttpClientResponse.fromWeb(
          request,
          new Response(status === 200 ? "ok" : "no_service", { status }),
        );
      }),
    ),
  );
  return { requests, layer };
};

describe("the HTTP sinks", () => {
  it("Slack posts the body to the webhook, and its id names no secret", async () => {
    const http = fakeHttp();
    const url = "https://hooks.slack.test/services/T000/B000/secret-part";
    const sink = await Effect.runPromise(
      slackWebhookSink(Redacted.make(url)).pipe(Effect.provide(http.layer)),
    );
    await Effect.runPromise(sink.send(message));
    expect(http.requests).toEqual([
      { url, authorization: undefined, body: slackWebhookBody(message) },
    ]);
    expect(sink.id).toMatch(/^slack:[0-9a-f]{16}$/);
    expect(sink.id).not.toContain("secret-part");
    expect(sink.label).not.toContain("secret-part");
  });

  it("a non-2xx answer is a NotifyError naming the status, not the URL", async () => {
    const http = fakeHttp(404);
    const sink = await Effect.runPromise(
      slackWebhookSink(
        Redacted.make("https://hooks.slack.test/services/secret-part"),
      ).pipe(Effect.provide(http.layer)),
    );
    const exit = await Effect.runPromiseExit(sink.send(message));
    expect(Exit.isFailure(exit)).toBe(true);
    expect(String(exit)).toContain("HTTP 404");
    expect(String(exit)).not.toContain("secret-part");
  });

  it("ntfy publishes JSON to the server's root with the token as Bearer", async () => {
    const http = fakeHttp();
    const sink = await Effect.runPromise(
      ntfySink({
        url: "http://ntfy.test/",
        topic: Redacted.make("factory-alerts"),
        token: Redacted.make("tk_test"),
      }).pipe(Effect.provide(http.layer)),
    );
    await Effect.runPromise(sink.send(message));
    expect(http.requests).toEqual([
      {
        url: "http://ntfy.test/",
        authorization: "Bearer tk_test",
        body: ntfyBody(message, "factory-alerts"),
      },
    ]);
    expect(sink.id).not.toContain("factory-alerts");
    // Two topics on one server are two destinations, so two ledgers.
    const other = await Effect.runPromise(
      ntfySink({
        url: "http://ntfy.test",
        topic: Redacted.make("other-topic"),
      }).pipe(Effect.provide(http.layer)),
    );
    expect(other.id).not.toBe(sink.id);
  });
});

/** The fake sinks' ids, the seeded boards and the seeded sessions, deleted after the file runs. */
const made = {
  sinks: [] as string[],
  boards: [] as string[],
  sessions: [] as string[],
};

/**
 * A sink that records what it was sent; while `failing` is set it fails, while `rateLimited` is set
 * it answers as a 429 would, and while `hanging` is set it never answers.
 */
const recordingSink = () => {
  const sent: Notification[] = [];
  const state = { failing: false, rateLimited: false, hanging: false };
  const sink: NotificationSink = {
    id: `fake:${randomBytes(6).toString("hex")}`,
    label: "the test's fake",
    send: (notification) =>
      state.hanging
        ? Effect.never
        : state.rateLimited
          ? Effect.fail(
              new NotifyError({
                sink: "fake",
                message: "the fake answered HTTP 429",
                rateLimited: true,
              }),
            )
          : state.failing
            ? Effect.fail(
                new NotifyError({ sink: "fake", message: "the fake is down" }),
              )
            : Effect.sync(() => {
                sent.push(notification);
              }),
  };
  made.sinks.push(sink.id);
  return { sink, sent, state };
};

const runtime = ManagedRuntime.make(
  TaskServiceLive.pipe(Layer.provideMerge(DatabaseLive)),
);

afterAll(async () => {
  // Nothing this file seeded outlives it: a dashboard or a real sink pointed at the same database
  // would otherwise be shown — or sent — every test question, approval, gate and failure.
  await runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      if (made.sinks.length > 0) {
        yield* sql`DELETE FROM notification_deliveries WHERE sink IN ${sql.in(made.sinks)}`;
      }
      if (made.boards.length > 0) {
        yield* sql`DELETE FROM board_instances WHERE id IN ${sql.in(made.boards)}`;
      }
      if (made.sessions.length > 0) {
        yield* sql`DELETE FROM task_runs WHERE session_id IN ${sql.in(made.sessions)}`;
        yield* sql`DELETE FROM sessions WHERE id IN ${sql.in(made.sessions)}`;
      }
    }),
  );
  await runtime.dispose();
});

const ACTOR = "person:notifier-test";

/**
 * One board with four events on it: a card parked on a question, a card whose run asks an
 * approval, a card whose run is done at a human gate, and a card's run that failed on its budget.
 */
const seed = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const tasks = yield* TaskService;
  const boardId = yield* mintBoardId;
  made.boards.push(boardId);
  const repo = `notifier/test-${randomBytes(4).toString("hex")}`;
  yield* sql`
    INSERT INTO board_instances (id, repo, definition_id, definition_version)
    VALUES (${boardId}, ${repo}, 'default', 1)
  `;
  const card = (title: string, column: string) =>
    Effect.gen(function* () {
      const made = yield* tasks.create({ boardId, title, actor: ACTOR });
      yield* sql`
        UPDATE tasks SET "column" = ${column}, revision = revision + 1 WHERE id = ${made.id}
      `;
      return made.id;
    });
  const run = (taskId: string, column: string) =>
    Effect.gen(function* () {
      const sessionId = yield* mintSessionId;
      made.sessions.push(sessionId);
      yield* sql`INSERT INTO sessions (id, title, repo) VALUES (${sessionId}, ${`run of ${taskId}`}, ${repo})`;
      yield* sql`
        INSERT INTO task_runs (id, task_id, session_id, "column")
        VALUES (${`run_${sessionId}`}, ${taskId}, ${sessionId}, ${column})
      `;
      return sessionId;
    });

  const asked = yield* card("notifier: asks", "specifying");
  const askedRun = yield* run(asked, "specifying");
  const parked = yield* tasks.ask({
    taskId: asked,
    question: "Which locale is the default?",
    actor: askedRun,
    askId: `${askedRun}:notifier-test`,
  });

  const approval = yield* card("notifier: wants approval", "building");
  const approvalRun = yield* run(approval, "building");
  yield* sql`
    INSERT INTO session_approvals (session_id, request_id, action, detail, requested_at)
    VALUES (${approvalRun}, 'req-1', 'bash', 'git push', now())
  `;

  const gated = yield* card("notifier: at the gate", "review");
  const gatedRun = yield* run(gated, "review");

  const failed = yield* card("notifier: over budget", "building");
  const failedRun = yield* run(failed, "building");
  yield* sql`
    INSERT INTO run_failures (session_id, entry_id, reason, detail)
    VALUES (${failedRun}, '9', 'budget', 'budget reached')
  `;

  return {
    boardId,
    approvalRun,
    question: `question:${asked}:${parked.blocked?.since ?? ""}`,
    approval: `approval:${approvalRun}:req-1`,
    gate: `gate:${gated}:review:${gatedRun}`,
    failed: `failed:${failedRun}:9`,
    links: {
      question: cardLink(BASE, { boardId, taskId: asked, thread: true }),
      failed: cardLink(BASE, { boardId, taskId: failed, run: failedRun }),
    },
  };
});

type Seeded = Effect.Success<typeof seed>;

const notifierOver = (
  sinks: ReadonlyArray<NotificationSink>,
  kinds: ReadonlyArray<NotificationKind> = NOTIFICATION_KINDS,
  over: {
    readonly retryAfterMs?: number;
    readonly maxAttempts?: number;
    readonly sendTimeoutMs?: number;
  } = {},
) => makeNotifier({ sinks, kinds: new Set(kinds), linkBase: BASE, ...over });

const mine = (seeded: Seeded, sent: ReadonlyArray<Notification>) => {
  const ids = new Set([
    seeded.question,
    seeded.approval,
    seeded.gate,
    seeded.failed,
  ]);
  return sent.filter((notification) => ids.has(notification.eventId));
};

const ledger = (sink: string, eventId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    return yield* sql<{
      readonly attempts: number;
      readonly delivered: boolean;
      readonly lastError: string | null;
    }>`
      SELECT attempts, delivered_at IS NOT NULL AS delivered, last_error
      FROM notification_deliveries WHERE sink = ${sink} AND event_id = ${eventId}
    `;
  });

describe("the notifier over the attention view and its ledger", () => {
  it("sends each event once, a second pass none, and a restarted notifier none", async () => {
    const fake = recordingSink();
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const seeded = yield* seed;
        const first = yield* notifierOver([fake.sink]);
        yield* first.pass;
        const afterFirst = mine(seeded, fake.sent).length;
        yield* first.pass;
        const afterSecond = mine(seeded, fake.sent).length;
        // A restart: a new notifier over the same database and the same destination.
        const restarted = yield* notifierOver([fake.sink]);
        yield* restarted.pass;
        const afterRestart = mine(seeded, fake.sent).length;
        const rows = yield* Effect.forEach(
          [seeded.question, seeded.approval, seeded.gate, seeded.failed],
          (eventId) => ledger(fake.sink.id, eventId),
        );
        return { seeded, afterFirst, afterSecond, afterRestart, rows };
      }),
    );
    const sent = mine(result.seeded, fake.sent);
    expect(result.afterFirst).toBe(4);
    expect(result.afterSecond).toBe(4);
    expect(sent.map((n) => n.kind).sort()).toEqual([
      "approval",
      "failed",
      "gate",
      "question",
    ]);
    expect(new Set(sent.map((n) => n.eventId)).size).toBe(4);
    const question = sent.find((n) => n.kind === "question");
    expect(question?.eventId).toBe(result.seeded.question);
    expect(question?.link).toBe(result.seeded.links.question);
    expect(question?.body).toContain("Which locale is the default?");
    expect(sent.find((n) => n.kind === "failed")?.link).toBe(
      result.seeded.links.failed,
    );
    // The restarted pass sent none of this case's events again: each has one ledger row, sent once.
    // (Read per event, not from the pass's report — other files' events reach the fake too.)
    expect(result.afterRestart).toBe(4);
    expect(result.rows).toEqual(
      Array.from({ length: 4 }, () => [
        { attempts: 1, delivered: true, lastError: null },
      ]),
    );
  }, 60_000);

  it("a kind turned off is neither sent nor recorded", async () => {
    const fake = recordingSink();
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const seeded = yield* seed;
        const notifier = yield* notifierOver(
          [fake.sink],
          ["question", "failed"],
        );
        yield* notifier.pass;
        return {
          seeded,
          approvalRows: yield* ledger(fake.sink.id, seeded.approval),
          gateRows: yield* ledger(fake.sink.id, seeded.gate),
        };
      }),
    );
    expect(
      mine(result.seeded, fake.sent)
        .map((n) => n.kind)
        .sort(),
    ).toEqual(["failed", "question"]);
    expect(result.approvalRows).toEqual([]);
    expect(result.gateRows).toEqual([]);
  }, 60_000);

  it("two sinks each get the event once, on their own ledger rows", async () => {
    const a = recordingSink();
    const b = recordingSink();
    const seeded = await runtime.runPromise(
      Effect.gen(function* () {
        const seeded = yield* seed;
        const notifier = yield* notifierOver([a.sink, b.sink]);
        yield* notifier.pass;
        yield* notifier.pass;
        return seeded;
      }),
    );
    expect(mine(seeded, a.sent)).toHaveLength(4);
    expect(mine(seeded, b.sent)).toHaveLength(4);
  }, 60_000);

  it("a failed send is recorded, retried after its claim ages, and then sent once", async () => {
    const fake = recordingSink();
    fake.state.failing = true;
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const seeded = yield* seed;
        const notifier = yield* notifierOver([fake.sink], ["question"], {
          retryAfterMs: 0,
        });
        yield* notifier.pass;
        const failedRow = yield* ledger(fake.sink.id, seeded.question);
        fake.state.failing = false;
        yield* notifier.pass;
        yield* notifier.pass;
        const deliveredRow = yield* ledger(fake.sink.id, seeded.question);
        return { seeded, failedRow, deliveredRow };
      }),
    );
    expect(result.failedRow).toEqual([
      { attempts: 1, delivered: false, lastError: "the fake is down" },
    ]);
    expect(result.deliveredRow).toEqual([
      { attempts: 2, delivered: true, lastError: null },
    ]);
    expect(mine(result.seeded, fake.sent)).toHaveLength(1);
  }, 60_000);

  it("a send that keeps failing stops after maxAttempts", async () => {
    const fake = recordingSink();
    fake.state.failing = true;
    const rows = await runtime.runPromise(
      Effect.gen(function* () {
        const seeded = yield* seed;
        const notifier = yield* notifierOver([fake.sink], ["failed"], {
          retryAfterMs: 0,
          maxAttempts: 2,
        });
        for (let pass = 0; pass < 4; pass += 1) yield* notifier.pass;
        return yield* ledger(fake.sink.id, seeded.failed);
      }),
    );
    expect(rows).toEqual([
      { attempts: 2, delivered: false, lastError: "the fake is down" },
    ]);
  }, 60_000);

  it("a failure older than the lookback is not news", async () => {
    const fake = recordingSink();
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        const seeded = yield* seed;
        const [sessionId, entryId] = seeded.failed
          .replace(/^failed:/, "")
          .split(":");
        yield* sql`
          UPDATE run_failures SET failed_at = now() - interval '2 days'
          WHERE session_id = ${sessionId ?? ""} AND entry_id = ${entryId ?? ""}
        `;
        const notifier = yield* notifierOver([fake.sink], ["failed"]);
        yield* notifier.pass;
        return seeded;
      }),
    );
    expect(mine(result, fake.sent)).toEqual([]);
  }, 60_000);
  it("a retry of an event resolved while the sink was down is dropped, not sent", async () => {
    const fake = recordingSink();
    fake.state.failing = true;
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        const seeded = yield* seed;
        const notifier = yield* notifierOver([fake.sink], ["approval"], {
          retryAfterMs: 0,
        });
        yield* notifier.pass;
        // The person decided the approval elsewhere before the sink came back.
        yield* sql`
          UPDATE session_approvals SET decision = 'approved', decided_at = now(), actor = 'person:notifier-test'
          WHERE session_id = ${seeded.approvalRun} AND request_id = 'req-1'
        `;
        fake.state.failing = false;
        yield* notifier.pass;
        yield* notifier.pass;
        return { seeded, row: yield* ledger(fake.sink.id, seeded.approval) };
      }),
    );
    expect(mine(result.seeded, fake.sent)).toEqual([]);
    expect(result.row).toEqual([
      {
        attempts: 5,
        delivered: false,
        lastError:
          "superseded: the event was no longer open when it was retried",
      },
    ]);
  }, 60_000);

  it("a kind turned off after it was recorded is not sent from the backlog", async () => {
    const fake = recordingSink();
    fake.state.failing = true;
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const seeded = yield* seed;
        const before = yield* notifierOver([fake.sink], ["question", "gate"], {
          retryAfterMs: 0,
        });
        yield* before.pass;
        // A restart with `gate` turned off, over the same ledger.
        fake.state.failing = false;
        const after = yield* notifierOver([fake.sink], ["question"], {
          retryAfterMs: 0,
        });
        yield* after.pass;
        return { seeded, gate: yield* ledger(fake.sink.id, seeded.gate) };
      }),
    );
    expect(mine(result.seeded, fake.sent).map((n) => n.kind)).toEqual([
      "question",
    ]);
    expect(result.gate).toEqual([
      { attempts: 1, delivered: false, lastError: "the fake is down" },
    ]);
  }, 60_000);

  it("a rate-limited send spends no attempt, and the sink is sent nothing more that pass", async () => {
    const fake = recordingSink();
    fake.state.rateLimited = true;
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const seeded = yield* seed;
        const notifier = yield* notifierOver(
          [fake.sink],
          ["question", "failed"],
          {
            retryAfterMs: 0,
          },
        );
        const report = yield* notifier.pass;
        const rows = yield* Effect.forEach(
          [seeded.question, seeded.failed],
          (eventId) => ledger(fake.sink.id, eventId),
        );
        return { report, rows };
      }),
    );
    // One send was tried and refused; the rest waits for the next pass, attempts untouched.
    expect(result.report.failed).toBe(1);
    expect(result.rows.flat().map((row) => row.attempts)).toEqual([0, 0]);
  }, 60_000);

  it("a sink that never answers is cut off and delays no other sink", async () => {
    const hung = recordingSink();
    hung.state.hanging = true;
    const ok = recordingSink();
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const seeded = yield* seed;
        const notifier = yield* notifierOver(
          [hung.sink, ok.sink],
          ["question"],
          {
            sendTimeoutMs: 100,
          },
        );
        yield* notifier.pass;
        return {
          seeded,
          hung: yield* ledger(hung.sink.id, seeded.question),
        };
      }),
    );
    expect(mine(result.seeded, ok.sent).map((n) => n.kind)).toEqual([
      "question",
    ]);
    expect(result.hung).toEqual([
      {
        attempts: 1,
        delivered: false,
        lastError: `${result.seeded.question}: the sink did not answer within 100ms`,
      },
    ]);
  }, 60_000);
});
