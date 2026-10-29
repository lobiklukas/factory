/**
 * What the notifier's Postgres cases seed (F21, F22): cards with a question, an approval, a gate and
 * a failure, owned by an actor the case names, and recording fake sinks. Each file that imports it
 * gets its own registry of what it made and puts `cleanup` in its `afterAll`, so nothing a case
 * seeded outlives the file on a shared development database.
 */
import { randomBytes } from "node:crypto";
import {
  ConfigProvider,
  Effect,
  Layer,
  ManagedRuntime,
  Redacted,
} from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import {
  DatabaseConfig,
  DatabaseLive,
  PostgresLive,
} from "@repo/storage-postgres";
import { mintBoardId, mintSessionId } from "./ids";
import type { Notification, NotificationSink } from "./Notifier";
import { TaskService, TaskServiceLive } from "./TaskService";

export const BASE = "http://dash.test";

const made = {
  sinks: [] as string[],
  boards: [] as string[],
  sessions: [] as string[],
};

/**
 * A recording sink. `kind` is the id's prefix: a case that is about a person's own sink uses
 * `"email"` or `"push"`, which is how the ledger tells a personal destination from a shared one.
 */
export const fakeSink = (
  kind: "fake" | "email" | "push" = "fake",
): {
  readonly sink: NotificationSink;
  readonly sent: Notification[];
} => {
  const sent: Notification[] = [];
  const sink: NotificationSink = {
    id: `${kind}:${randomBytes(6).toString("hex")}`,
    label: "the test's fake",
    send: (notification) =>
      Effect.sync(() => {
        sent.push(notification);
      }),
  };
  made.sinks.push(sink.id);
  return { sink, sent };
};

/** Delete everything this file seeded, and the ledger rows its fake sinks wrote. */
export const cleanup = Effect.gen(function* () {
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
});

export const actor = (name: string) =>
  `person:${name}-${randomBytes(4).toString("hex")}`;

/**
 * One card per kind of event, all created by `cardActor`; each run is started by `runActor` (or
 * nobody). The question has no run in its subject, so only the card's creator can own it.
 */
export const seed = (cardActor: string, runActor?: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const tasks = yield* TaskService;
    const boardId = yield* mintBoardId;
    made.boards.push(boardId);
    const repo = `routing/test-${randomBytes(4).toString("hex")}`;
    yield* sql`
      INSERT INTO board_instances (id, repo, definition_id, definition_version)
      VALUES (${boardId}, ${repo}, 'default', 1)
    `;
    const card = (title: string, column: string) =>
      Effect.gen(function* () {
        const created = yield* tasks.create({
          boardId,
          title,
          actor: cardActor,
        });
        yield* sql`
          UPDATE tasks SET "column" = ${column}, revision = revision + 1 WHERE id = ${created.id}
        `;
        return created.id;
      });
    const run = (taskId: string, column: string) =>
      Effect.gen(function* () {
        const sessionId = yield* mintSessionId;
        made.sessions.push(sessionId);
        yield* sql`
          INSERT INTO sessions (id, title, repo, actor)
          VALUES (${sessionId}, ${`run of ${taskId}`}, ${repo}, ${runActor ?? null})
        `;
        yield* sql`
          INSERT INTO task_runs (id, task_id, session_id, "column")
          VALUES (${`run_${sessionId}`}, ${taskId}, ${sessionId}, ${column})
        `;
        return sessionId;
      });

    const asked = yield* card("routing: asks", "specifying");
    const askedRun = yield* run(asked, "specifying");
    const parked = yield* tasks.ask({
      taskId: asked,
      question: "Which locale is the default?",
      actor: askedRun,
      askId: `${askedRun}:routing-test`,
    });
    const approval = yield* card("routing: wants approval", "building");
    const approvalRun = yield* run(approval, "building");
    yield* sql`
      INSERT INTO session_approvals (session_id, request_id, action, detail, requested_at)
      VALUES (${approvalRun}, 'req-1', 'bash', 'git push', now())
    `;
    const gated = yield* card("routing: at the gate", "review");
    const gatedRun = yield* run(gated, "review");
    const failed = yield* card("routing: over budget", "building");
    const failedRun = yield* run(failed, "building");
    yield* sql`
      INSERT INTO run_failures (session_id, entry_id, reason, detail)
      VALUES (${failedRun}, '9', 'budget', 'budget reached')
    `;
    return {
      question: `question:${asked}:${parked.blocked?.since ?? ""}`,
      approval: `approval:${approvalRun}:req-1`,
      gate: `gate:${gated}:review:${gatedRun}`,
      failed: `failed:${failedRun}:9`,
    };
  });

export type Seeded = Effect.Success<ReturnType<typeof seed>>;

const ids = (seeded: Seeded) =>
  new Set([seeded.question, seeded.approval, seeded.gate, seeded.failed]);

/** The events of `seeded` a sink was sent, by kind. */
export const kindsSent = (seeded: Seeded, sent: ReadonlyArray<Notification>) =>
  sent
    .filter((n) => ids(seeded).has(n.eventId))
    .map((n) => n.kind)
    .sort();

/**
 * A database of a file's own, created on the server `DATABASE_URL` names and migrated: for cases
 * that write deployment-wide state (a kind toggle) or sweep every row (retention), which must not
 * touch a developer's `factory` database. `drop` disposes the runtime and drops the database.
 */
/* oxlint-disable-next-line effecttsgo/async-function -- vitest's top-level await and `afterAll` take promises. */
export const scratchDatabase = async (label: string) => {
  const name = `factory_core_${label}_${randomBytes(4).toString("hex")}`;
  const admin = ManagedRuntime.make(PostgresLive);
  const configured = new URL(
    Redacted.value((await admin.runPromise(DatabaseConfig)).url),
  );
  await admin.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      yield* sql`CREATE DATABASE ${sql(name)}`;
    }),
  );
  configured.pathname = `/${name}`;
  const runtime = ManagedRuntime.make(
    TaskServiceLive.pipe(
      Layer.provideMerge(DatabaseLive),
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnv({
            env: { DATABASE_URL: configured.toString() },
          }),
        ),
      ),
    ),
  );
  return {
    runtime,
    /* oxlint-disable-next-line effecttsgo/async-function -- vitest's `afterAll` takes a promise. */
    drop: async () => {
      await runtime.dispose();
      await admin.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          yield* sql`DROP DATABASE IF EXISTS ${sql(name)} WITH (FORCE)`;
        }),
      );
      await admin.dispose();
    },
  };
};
