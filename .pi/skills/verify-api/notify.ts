// The notifier (S-notifications), driven with the real Effect RPC client against an API whose sinks
// are the loopback fake (`notify-fake.ts`): a parked question, a pending approval and a run its
// budget stopped each reach a person exactly once, with a link to the card; a restarted API sends
// none of them again; and a kind turned off in `NOTIFY_TYPES` is not sent.
//
//   bun notify.ts      (via ./notify.sh, which owns the API, the fake and the database)
//
//   PHASE=seed     a board and three cards: one whose run asks a question (the run's own `ask`
//                  service call, in-process, as `verify-web/seed-attention.ts` makes it), one whose
//                  run asks an approval (`requestApproval`), and one whose run its one-cent cap
//                  stops (`createSession` with `budget`, then `sendMessage`); each reaches both sinks
//                  once, linked to its card
//   PHASE=restart  the same API configuration, restarted: a new question on a new card arrives, so
//                  the notifier is polling, and the first three are still one message each
//   PHASE=toggled  restarted with `NOTIFY_TYPES=question,failed` and a fresh ntfy topic (a new
//                  destination, so a new ledger): the questions and the failure reach it, the pending
//                  approval does not
//
// Env: API_URL, EVIDENCE_DIR, DATABASE_URL (the drive's scratch database, for the ask), PHASE,
// NOTIFY_FAKE_LEDGER, NOTIFY_STATE (the file the phases hand ids through), LINK_BASE, TOPIC,
// NTFY_TOKEN.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { TaskService, TaskServiceLive } from "@repo/core";
import { RpcApi } from "@repo/domain/Rpc";
import { RepoSlug, type SessionId } from "@repo/domain/Session";
import { DefinitionId } from "@repo/domain/Task";
import { DatabaseLive } from "@repo/storage-postgres";
import { Effect, Layer } from "effect";
import { RpcClient } from "effect/rpc";
import { makeChecker, protocolFor, waitUntil } from "./harness.ts";
import type { CheckRecord } from "./harness.ts";

const API_URL = process.env["API_URL"] ?? "http://127.0.0.1:9446";
const EVIDENCE_DIR =
  process.env["EVIDENCE_DIR"] ?? ".verify/evidence/latest/api";
const PHASE = process.env["PHASE"] ?? "";
const LEDGER = process.env["NOTIFY_FAKE_LEDGER"] ?? "";
const STATE = process.env["NOTIFY_STATE"] ?? "";
const LINK_BASE = process.env["LINK_BASE"] ?? "";
const TOPIC = process.env["TOPIC"] ?? "";
const NTFY_TOKEN = process.env["NTFY_TOKEN"] ?? "";
const PERSON = "person:verify-api";

await mkdir(EVIDENCE_DIR, { recursive: true });

type Received = {
  readonly sink: "slack" | "ntfy";
  readonly authorization: string | undefined;
  readonly body: Record<string, unknown> | null;
};
type Ledger = { readonly messages: ReadonlyArray<Received> };

const ledger = async (): Promise<Ledger> =>
  JSON.parse(await readFile(LEDGER, "utf8")) as Ledger;

/** Where a message points: ntfy's `click`, or the `<url|label>` in Slack's text. */
const linkOf = (message: Received): string | undefined => {
  if (message.sink === "ntfy") {
    const click = message.body?.["click"];
    return typeof click === "string" ? click : undefined;
  }
  const text = message.body?.["text"];
  return typeof text === "string"
    ? /<([^|>]+)\|Open in factory>/.exec(text)?.[1]
    : undefined;
};

const topicOf = (message: Received): string | undefined => {
  const topic = message.body?.["topic"];
  return typeof topic === "string" ? topic : undefined;
};

/** The messages one sink (and, for ntfy, one topic) received. */
const on = (
  state: Ledger,
  sink: "slack" | "ntfy",
  topic?: string,
): ReadonlyArray<Received> =>
  state.messages.filter(
    (message) =>
      message.sink === sink &&
      (topic === undefined || topicOf(message) === topic),
  );

const count = (messages: ReadonlyArray<Received>, link: string): number =>
  messages.filter((message) => linkOf(message) === link).length;

type Event = {
  readonly kind: "question" | "approval" | "failed";
  readonly taskId: string;
  readonly runId: SessionId;
  readonly link: string;
  /** Words the message must carry: the question, the action, the stop. */
  readonly says: string;
};

type State = { readonly events: ReadonlyArray<Event> };

const cardLink = (
  boardId: string,
  taskId: string,
  extra: { readonly run?: string; readonly thread?: boolean } = {},
): string =>
  `${LINK_BASE}/boards/${boardId}?card=${taskId}${extra.run === undefined ? "" : `&run=${extra.run}`}${extra.thread === true ? "#thread" : ""}`;

const observed: {
  phase: string;
  apiUrl: string;
  state: State | null;
  ledger: Ledger | null;
  checks: Record<string, CheckRecord>;
} = { phase: PHASE, apiUrl: API_URL, state: null, ledger: null, checks: {} };
const assert = makeChecker(observed);

const program = Effect.gen(function* () {
  const client = yield* RpcClient.make(RpcApi);
  let boards = 0;
  const tasks = yield* TaskService;

  /**
   * A card on a board of its own, and an idle run on it, as `factory board start --idle` opens one.
   * One board per card because a board caps the runs in flight on it (LOB-71), and a parked run and
   * a run waiting on its approval are both still in flight.
   */
  const cardWithRun = (title: string, budget?: number) =>
    Effect.gen(function* () {
      const board = yield* client.createBoard({
        repo: RepoSlug.make(`verify-api/notify-${Date.now()}-${boards++}`),
        definitionId: DefinitionId.make("default"),
      });
      const boardId = board.id;
      const card = yield* client.createTask({
        boardId,
        title,
        actor: PERSON,
      });
      const run = yield* client.createSession({
        title,
        taskId: card.id,
        taskColumn: card.column,
        ...(budget === undefined ? {} : { budget }),
      });
      return { boardId, card, run: run.id };
    });

  /** A question the card's run parks it on: the run's own `ask` call, as the tool makes it. */
  const asked = (title: string, question: string) =>
    Effect.gen(function* () {
      const { boardId, card, run } = yield* cardWithRun(title);
      yield* tasks.ask({
        taskId: card.id,
        question,
        actor: run,
        askId: `${run}:verify-api-notify`,
      });
      const event: Event = {
        kind: "question",
        taskId: card.id,
        runId: run,
        link: cardLink(boardId, card.id, { thread: true }),
        says: question,
      };
      return event;
    });

  /** Wait until every event's link is on the sink(s), then return the ledger. */
  const delivered = (
    events: ReadonlyArray<Event>,
    sinks: ReadonlyArray<{
      readonly sink: "slack" | "ntfy";
      readonly topic?: string;
    }>,
    label: string,
  ) =>
    waitUntil(
      Effect.promise(async () => {
        const state = await ledger();
        return events.every((event) =>
          sinks.every(
            ({ sink, topic }) => count(on(state, sink, topic), event.link) > 0,
          ),
        )
          ? state
          : undefined;
      }),
      label,
    );

  /** A few poll intervals with nothing new to deliver: what a second message would need to land. */
  const settle = Effect.sleep(2_500);

  if (PHASE === "seed") {
    const question = yield* asked(
      "notify: a run asks",
      "Which locale is the default?",
    );
    const approvalRun = yield* cardWithRun("notify: a run wants approval");
    yield* client.requestApproval({
      sessionId: approvalRun.run,
      requestId: "verify-api-notify-1",
      action: "bash",
      detail: "git push origin factory/notify",
    });
    const failedRun = yield* cardWithRun("notify: over budget", 0.01);
    yield* client.sendMessage({ sessionId: failedRun.run, content: "spend" });
    yield* waitUntil(
      Effect.map(client.getSession({ sessionId: failedRun.run }), (snapshot) =>
        snapshot.entries.some((entry) => entry.kind === "budget"),
      ),
      "the capped run to stop at its budget",
    );
    const events: ReadonlyArray<Event> = [
      question,
      {
        kind: "approval",
        taskId: approvalRun.card.id,
        runId: approvalRun.run,
        link: cardLink(approvalRun.boardId, approvalRun.card.id, {
          run: approvalRun.run,
        }),
        says: "bash: git push origin factory/notify",
      },
      {
        kind: "failed",
        taskId: failedRun.card.id,
        runId: failedRun.run,
        link: cardLink(failedRun.boardId, failedRun.card.id, {
          run: failedRun.run,
        }),
        says: "budget reached",
      },
    ];
    const state: State = { events };
    observed.state = state;
    yield* Effect.promise(() =>
      writeFile(STATE, `${JSON.stringify(state, null, 2)}\n`),
    );

    yield* delivered(
      events,
      [{ sink: "slack" }, { sink: "ntfy", topic: TOPIC }],
      "the three events on both sinks",
    );
    yield* settle;
    const after = yield* Effect.promise(ledger);
    observed.ledger = after;
    const slack = on(after, "slack");
    const ntfy = on(after, "ntfy", TOPIC);
    for (const event of events) {
      assert(
        `the ${event.kind} is exactly one Slack message and one ntfy message, linked to its card`,
        count(slack, event.link) === 1 && count(ntfy, event.link) === 1,
        `slack=${count(slack, event.link)} ntfy=${count(ntfy, event.link)} link=${event.link}`,
      );
      const slackText = slack.find((m) => linkOf(m) === event.link)?.body?.[
        "text"
      ];
      const ntfyBody = ntfy.find((m) => linkOf(m) === event.link)?.body;
      assert(
        `the ${event.kind}'s message says what it is about`,
        typeof slackText === "string" &&
          slackText.includes(event.says) &&
          typeof ntfyBody?.["message"] === "string" &&
          ntfyBody["message"].includes(event.says) &&
          JSON.stringify(ntfyBody["tags"]) ===
            JSON.stringify(["factory", event.kind]),
        `slack=${JSON.stringify(slackText)} ntfy=${JSON.stringify(ntfyBody)}`,
      );
    }
    assert(
      "nothing else reached either sink: three events, three messages each",
      slack.length === 3 && ntfy.length === 3,
      `slack=${slack.length} ntfy=${ntfy.length}`,
    );
    assert(
      "ntfy was published with the topic's token, Slack with no credential header",
      ntfy.every((m) => m.authorization === `Bearer ${NTFY_TOKEN}`) &&
        slack.every((m) => m.authorization === undefined),
      `ntfy=${JSON.stringify(ntfy.map((m) => m.authorization))}`,
    );
    return;
  }

  const state = JSON.parse(
    yield* Effect.promise(() => readFile(STATE, "utf8")),
  ) as State;
  observed.state = state;
  const byKind = (kind: Event["kind"]) =>
    state.events.filter((event) => event.kind === kind);

  if (PHASE === "restart") {
    const later = yield* asked(
      "notify: a run asks after the restart",
      "Is the migration reversible?",
    );
    const events = [...state.events, later];
    yield* Effect.promise(() =>
      writeFile(STATE, `${JSON.stringify({ ...state, events }, null, 2)}\n`),
    );
    yield* delivered(
      [later],
      [{ sink: "slack" }, { sink: "ntfy", topic: TOPIC }],
      "the question asked after the restart",
    );
    yield* settle;
    const after = yield* Effect.promise(ledger);
    observed.ledger = after;
    const slack = on(after, "slack");
    const ntfy = on(after, "ntfy", TOPIC);
    assert(
      "the restarted API is notifying: a question asked after it reached both sinks once",
      count(slack, later.link) === 1 && count(ntfy, later.link) === 1,
      `slack=${count(slack, later.link)} ntfy=${count(ntfy, later.link)}`,
    );
    for (const event of state.events) {
      assert(
        `the restart sent the ${event.kind} again to neither sink`,
        count(slack, event.link) === 1 && count(ntfy, event.link) === 1,
        `slack=${count(slack, event.link)} ntfy=${count(ntfy, event.link)}`,
      );
    }
    assert(
      "four events, four messages per sink, across two processes",
      slack.length === 4 && ntfy.length === 4,
      `slack=${slack.length} ntfy=${ntfy.length}`,
    );
    return;
  }

  if (PHASE === "toggled") {
    const wanted = [...byKind("question"), ...byKind("failed")];
    yield* delivered(
      wanted,
      [{ sink: "ntfy", topic: TOPIC }],
      "the questions and the failure on the new topic",
    );
    yield* settle;
    const after = yield* Effect.promise(ledger);
    observed.ledger = after;
    const fresh = on(after, "ntfy", TOPIC);
    for (const event of wanted) {
      assert(
        `with NOTIFY_TYPES=question,failed the ${event.kind} on ${event.taskId} reached the new topic once`,
        count(fresh, event.link) === 1,
        `count=${count(fresh, event.link)}`,
      );
    }
    const [approval] = byKind("approval");
    const pending = yield* client.listPendingApprovals({});
    assert(
      "the approval is still pending, and NOTIFY_TYPES kept it off the new topic",
      approval !== undefined &&
        pending.approvals.some((a) => a.sessionId === approval.runId) &&
        count(fresh, approval.link) === 0 &&
        fresh.every(
          (m) => !JSON.stringify(m.body?.["tags"] ?? []).includes("approval"),
        ),
      `count=${approval === undefined ? "?" : count(fresh, approval.link)} topic=${fresh.length}`,
    );
    assert(
      "the new topic got exactly the wanted kinds",
      fresh.length === wanted.length,
      `topic=${fresh.length} wanted=${wanted.length}`,
    );
    return;
  }

  return yield* Effect.die(
    new Error(`PHASE must be seed, restart or toggled, not ${PHASE}`),
  );
});

try {
  await Effect.runPromise(
    program.pipe(
      Effect.provide(
        Layer.mergeAll(
          protocolFor(API_URL),
          TaskServiceLive.pipe(Layer.provide(DatabaseLive)),
        ),
      ),
      Effect.scoped,
    ),
  );
} catch (error) {
  assert("the drive completed", false, `threw: ${String(error)}`);
}

await writeFile(
  path.join(EVIDENCE_DIR, `notify-${PHASE}.json`),
  `${JSON.stringify(observed, null, 2)}\n`,
);

const failed = Object.entries(observed.checks).filter(
  ([, check]) => !check.passed,
);
if (failed.length > 0) {
  console.error(`\n${failed.length} required check(s) failed`);
  process.exitCode = 1;
}
