/**
 * A Linear-sourced card's questions go back to Linear, and an issue with open blockers does not start
 * (T5, part of LOB-14).
 *
 * Linear is the same in-process fake behind the Effect `HttpClient` seam the write-back cases use
 * (`./linearFake`), extended with the issue's blockers and the two agent operations. It is written
 * from Linear's documented schema, so it proves what this code sends and how it reads the answers,
 * not that Linear accepts them (`docs/testing-third-parties.md`). The cases that need the board — a
 * card parked `needs_input`, a delivery's claim, the ledger of questions posted — run against the real
 * `TaskService` and `webhook_deliveries` on Postgres.
 *
 * Needs Postgres for the last blocks: `docker compose up -d --wait postgres`. Every row carries a
 * per-run id, so it is safe against a database other suites also use.
 */
import { randomBytes } from "node:crypto";
import { BunServices } from "@effect/platform-bun";
import { Effect, Exit, Layer, ManagedRuntime, Redacted } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { describe, expect, it } from "vitest";
import type { RepoSlug, SessionId } from "@repo/domain/Session";
import {
  DEFAULT_DEFINITION_ID,
  DefinitionId,
  type Task,
} from "@repo/domain/Task";
import { TriggerError, type TriggerRule } from "@repo/domain/Trigger";
import { DatabaseLive } from "@repo/storage-postgres";
import { AskWriteBack } from "./AskWriteBack";
import { linearDeliveryFor } from "./Linear";
import {
  LinearAskWriteBack,
  LinearTriggerBlockers,
  LinearTriggerReplies,
} from "./LinearElicitation";
import {
  DEFAULT_LINEAR_STATES,
  LinearIssueSync,
  LinearIssueSyncLive,
  type LinearConfig,
} from "./LinearSync";
import { CANCELED, DONE, TODO, makeLinear } from "./linearFake";
import { mintSessionId } from "./ids";
import { type TaskError, TaskService, TaskServiceLive } from "./TaskService";
import {
  NoWriteBack,
  TriggerCardsFromTaskService,
  TriggerService,
  TriggerServiceLive,
  TriggerSessions,
} from "./TriggerService";

const runId = randomBytes(6).toString("hex");

const config: LinearConfig = {
  apiUrl: "http://linear.test/graphql",
  apiKey: Redacted.make("lin_api_test"),
  states: DEFAULT_LINEAR_STATES,
};

const withSync = <A, E>(
  fake: ReturnType<typeof makeLinear>,
  body: (sync: typeof LinearIssueSync.Service) => Effect.Effect<A, E>,
) =>
  Effect.runPromiseExit(
    Effect.gen(function* () {
      return yield* body(yield* LinearIssueSync);
    }).pipe(
      Effect.provide(
        LinearIssueSyncLive(config).pipe(Layer.provide(fake.layer)),
      ),
    ),
  );

/** What Linear sends when a person writes in an agent session's thread. */
const prompted = (input: {
  readonly issueId: string;
  readonly activityId: string;
  readonly body: string;
  readonly agentSessionId?: string;
}) => ({
  type: "AgentSessionEvent",
  action: "prompted",
  webhookTimestamp: 1_761_559_200_000,
  agentSession: {
    id: input.agentSessionId ?? "agent-session-1",
    issue: { id: input.issueId, identifier: "ENG-42" },
  },
  agentActivity: {
    id: input.activityId,
    content: { type: "prompt", body: input.body },
  },
});

describe("a reply in a Linear agent session, as the adapter reads it", () => {
  const rules: ReadonlyArray<TriggerRule> = [];
  const deliver = linearDeliveryFor(rules);

  it("is a reply event on the issue, keyed by the activity that carries it, not by the delivery", () => {
    const payload = prompted({
      issueId: "iss-1",
      activityId: "act-1",
      body: "Postgres 16.",
    });
    const first = deliver(payload, { delivery: "delivery-a" });
    const retry = deliver(
      { ...payload, webhookTimestamp: 1_761_559_999_999 },
      { delivery: "delivery-b" },
    );
    expect(first?.event).toMatchObject({
      source: "linear",
      key: "iss-1",
      reply: {
        agentSessionId: "agent-session-1",
        activityId: "act-1",
        body: "Postgres 16.",
      },
    });
    expect(first?.requestId).toBe("linear:act-1:reply");
    // A retry with a fresh header and a fresh send time is the same answer.
    expect(retry?.requestId).toBe(first?.requestId);
    // A different reply on the same issue is a different delivery.
    expect(
      deliver(prompted({ issueId: "iss-1", activityId: "act-2", body: "x" }))
        ?.requestId,
    ).toBe("linear:act-2:reply");
    // It starts nothing by itself: no rule is consulted for it.
    expect(first?.keyedByWork).toBeUndefined();
  });

  it("reads the text from the event, as the activity's own body when a relay sends it flat", () => {
    const flat = {
      ...prompted({ issueId: "iss-1", activityId: "act-1", body: "unused" }),
      agentActivity: { id: "act-1", body: "Use 5442." },
    };
    expect(deliver(flat)?.event.reply?.body).toBe("Use 5442.");
  });

  it("is not a reply when it names no issue, no activity or no text, nor when the session was only created", () => {
    const base = prompted({
      issueId: "iss-1",
      activityId: "act-1",
      body: "yes",
    });
    const refused = [
      { ...base, agentSession: { id: "s", issue: {} } },
      { ...base, agentActivity: { content: { body: "yes" } } },
      { ...base, agentActivity: { id: "act-1", content: { body: "  " } } },
      { ...base, action: "created" },
    ];
    for (const payload of refused) {
      const delivery = deliver(payload);
      expect(delivery?.event.reply).toBeUndefined();
      // Answered and recorded as a skip, never a `400` that makes Linear retry.
      expect(delivery?.event.action).toBe(
        `AgentSessionEvent:${payload.action}`,
      );
    }
  });
});

describe("the issue's open blockers, read from Linear", () => {
  it("names the blockers still open, by identifier: not a finished or canceled one, nor a related issue", async () => {
    const fake = makeLinear({
      blockers: [
        { identifier: "ENG-41" },
        { identifier: "ENG-43", state: TODO },
        { identifier: "ENG-44", state: DONE },
        { identifier: "ENG-45", state: CANCELED },
        { identifier: "ENG-46", type: "related" },
      ],
    });
    const exit = await withSync(fake, (sync) =>
      sync.openBlockers({ issueId: fake.issue.id }),
    );
    expect(Exit.isSuccess(exit) && exit.value).toEqual(["ENG-41", "ENG-43"]);
    // A read, as the key that was configured, and nothing written.
    expect(fake.seen.map((seen) => seen.operation)).toEqual(["issueBlockers"]);
    expect(fake.seen[0]?.authorization).toBe("lin_api_test");
    expect(fake.writes()).toEqual([]);
  });

  it("answers no blockers for an issue with none, and an issue Linear does not show is a refusal", async () => {
    const none = makeLinear();
    const exit = await withSync(none, (sync) =>
      sync.openBlockers({ issueId: none.issue.id }),
    );
    expect(Exit.isSuccess(exit) && exit.value).toEqual([]);

    const missing = await withSync(none, (sync) =>
      sync.openBlockers({ issueId: "iss-nobody" }),
    );
    expect(Exit.isFailure(missing)).toBe(true);
  });
});

describe("an elicitation, as the sync posts it", () => {
  it("opens the agent session on the issue and posts one activity of type elicitation into it", async () => {
    const fake = makeLinear();
    const exit = await withSync(fake, (sync) =>
      Effect.gen(function* () {
        const session = yield* sync.openAgentSession({
          issueId: fake.issue.id,
        });
        yield* sync.elicit({
          issueId: fake.issue.id,
          agentSessionId: session,
          question: "Which Postgres major does this target?",
        });
        return session;
      }),
    );
    expect(Exit.isSuccess(exit) && exit.value).toBe("agent-session-1");
    expect(fake.agentSessions).toEqual([
      { id: "agent-session-1", issueId: fake.issue.id },
    ]);
    expect(fake.activities).toEqual([
      {
        agentSessionId: "agent-session-1",
        content: {
          type: "elicitation",
          body: "Which Postgres major does this target?",
        },
      },
    ]);
  });

  it("refuses a session Linear answered success: false to, and an activity it refused", async () => {
    const session = await withSync(
      makeLinear({ unsuccessful: "agentSessionCreateOnIssue" }),
      (sync) => sync.openAgentSession({ issueId: "iss-uuid-1" }),
    );
    expect(Exit.isFailure(session)).toBe(true);
    const activity = await withSync(
      makeLinear({ unsuccessful: "agentActivityCreate" }),
      (sync) =>
        sync.elicit({
          issueId: "iss-uuid-1",
          agentSessionId: "agent-session-1",
          question: "q?",
        }),
    );
    expect(Exit.isFailure(activity)).toBe(true);
  });
});

/**
 * The seam and the board over Postgres, with Linear's fake behind the sync. The card port is the
 * production one, so a card filed from an issue carries `linear:<issue id>` exactly as in a real
 * delivery, and `ask` and `comment` are the board's own.
 */
describe("a Linear-delegated card's questions and blockers, on the board", () => {
  const slugFor = (name: string) => `acme/elicit-${name}-${runId}` as RepoSlug;
  const rulesFor = (slug: RepoSlug): ReadonlyArray<TriggerRule> => [
    { label: "intake", repo: slug, baseRef: "main", prompt: "", mode: "card" },
  ];

  /** Linear's `Issue` `create` webhook body for the fake's issue. */
  const issueCreated = (fake: ReturnType<typeof makeLinear>) => ({
    action: "create",
    type: "Issue",
    webhookTimestamp: 1_761_559_200_000,
    data: {
      id: fake.issue.id,
      identifier: fake.issue.identifier,
      title: "Make the widget stop wobbling",
      description: "The widget **wobbles**.",
      url: `https://linear.app/acme/issue/${fake.issue.identifier}`,
      labels: [{ id: "label-intake", name: "intake" }],
      labelIds: ["label-intake"],
    },
  });

  const harness = async <A>(
    name: string,
    fake: ReturnType<typeof makeLinear>,
    body: (h: {
      readonly slug: RepoSlug;
      readonly rules: ReadonlyArray<TriggerRule>;
      readonly run: <B, E>(
        effect: Effect.Effect<B, E, TaskService | SqlClient | TriggerService>,
      ) => Promise<B>;
      readonly deliver: ReturnType<typeof linearDeliveryFor>;
    }) => Promise<A>,
  ): Promise<A> => {
    const slug = slugFor(name);
    const rules = rulesFor(slug);
    const sync = LinearIssueSyncLive(config).pipe(Layer.provide(fake.layer));
    const seam = TriggerServiceLive({ rules }).pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(
            TriggerSessions,
            TriggerSessions.of({
              create: () => Effect.die("a card rule opens no session"),
              send: () => Effect.void,
            }),
          ),
          NoWriteBack,
          TriggerCardsFromTaskService.pipe(Layer.provide(TaskServiceLive)),
          LinearTriggerBlockers.pipe(Layer.provide(sync)),
          LinearTriggerReplies.pipe(Layer.provide(TaskServiceLive)),
        ),
      ),
    );
    const runtime = ManagedRuntime.make(
      Layer.mergeAll(
        seam,
        TaskServiceLive,
        LinearAskWriteBack.pipe(Layer.provide(sync)),
      ).pipe(
        Layer.provideMerge(Layer.mergeAll(DatabaseLive, BunServices.layer)),
      ),
    );
    try {
      const run = <B, E>(
        effect: Effect.Effect<B, E, TaskService | SqlClient | TriggerService>,
      ) => runtime.runPromise(effect);
      await run(
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          yield* sql`INSERT INTO repos (slug) VALUES (${slug}) ON CONFLICT (slug) DO NOTHING`;
          const tasks = yield* TaskService;
          yield* tasks.createBoard({
            repo: slug,
            definitionId: DefinitionId.make(DEFAULT_DEFINITION_ID),
          });
        }),
      );
      return await body({
        slug,
        rules,
        run,
        deliver: linearDeliveryFor(rules),
      });
    } finally {
      await runtime.dispose();
    }
  };

  const cardsOn = (slug: RepoSlug) =>
    Effect.gen(function* () {
      const tasks = yield* TaskService;
      const board = (yield* tasks.listBoards).find(
        (candidate) => candidate.repo === slug,
      );
      return board === undefined
        ? []
        : yield* tasks.list({ boardId: board.id });
    });

  describe("an issue with an open blocker", () => {
    it("is skipped with `blocked by <id>` and files no card, then files it when the blocker is done and the delivery comes again", async () => {
      const fake = makeLinear({
        identifier: `ENG-${runId}-a`,
        blockers: [{ identifier: "ENG-41" }, { identifier: "ENG-43" }],
      });
      await harness("blocked", fake, async ({ slug, run, deliver }) => {
        const delivery = deliver(issueCreated(fake));
        const trigger = await run(TriggerService);

        const blocked = await run(trigger.deliver(delivery!));
        expect(blocked).toMatchObject({
          status: "skipped",
          replayed: false,
          reason: "blocked by ENG-41, ENG-43",
        });
        expect(await run(cardsOn(slug))).toHaveLength(0);

        // One blocker is done; the other still holds the issue up, and the reason names only it.
        fake.blockers[0]!.state = DONE;
        const stillBlocked = await run(trigger.deliver(delivery!));
        expect(stillBlocked.reason).toBe("blocked by ENG-43");
        expect(stillBlocked.replayed).toBe(false);
        expect(await run(cardsOn(slug))).toHaveLength(0);

        // The last one is canceled — Linear's own board stops treating it as blocking — and the
        // same delivery, arriving again, is claimed afresh and creates the card.
        fake.blockers[1]!.state = CANCELED;
        const started = await run(trigger.deliver(delivery!));
        expect(started.status).toBe("processed");
        expect(started.replayed).toBe(false);
        const cards = await run(cardsOn(slug));
        expect(cards).toHaveLength(1);
        expect(cards[0]?.externalRef).toBe(`linear:${fake.issue.id}`);

        // And that outcome is final: a redelivery is a replay, and asks Linear nothing more.
        const reads = fake.seen.filter(
          (seen) => seen.operation === "issueBlockers",
        ).length;
        const replayed = await run(trigger.deliver(delivery!));
        expect(replayed.replayed).toBe(true);
        expect(
          fake.seen.filter((seen) => seen.operation === "issueBlockers"),
        ).toHaveLength(reads);
      });
    }, 60_000);

    it("is not asked of a delivery that would be skipped anyway, nor of an issue another source sent", async () => {
      const fake = makeLinear({
        identifier: `ENG-${runId}-b`,
        blockers: [{ identifier: "ENG-41" }],
      });
      await harness("not-asked", fake, async ({ run, deliver }) => {
        const trigger = await run(TriggerService);
        // An edit starts no work: the action filter refuses it before any read of Linear.
        const edited = deliver({ ...issueCreated(fake), action: "update" });
        const outcome = await run(trigger.deliver(edited!));
        expect(outcome.reason).toBe('action "update" is not "create"');
        // A generic delivery has no Linear issue to read.
        const generic = await run(
          trigger.deliver({
            requestId: `${runId}-generic`,
            event: {
              source: "generic",
              key: "T-1",
              action: "create",
              title: "x",
              body: "",
              labels: ["intake"],
            },
          }),
        );
        expect(generic.status).toBe("processed");
        expect(fake.seen).toEqual([]);
      });
    }, 60_000);

    it("fails the delivery when Linear cannot be read, so the sender retries it, and starts it once the read works", async () => {
      const fake = makeLinear({
        identifier: `ENG-${runId}-c`,
        blockers: [],
        refuseNth: { operation: "issueBlockers", nth: 1 },
      });
      await harness("unreadable", fake, async ({ slug, run, deliver }) => {
        const delivery = deliver(issueCreated(fake));
        const trigger = await run(TriggerService);
        const failure = await run(Effect.flip(trigger.deliver(delivery!)));
        expect(failure).toBeInstanceOf(TriggerError);
        expect(failure.code).toBe("tracker-read");
        expect(failure.message).toContain("blockers");
        // Nothing started, and the claim was given back: the retry is not a replay.
        expect(await run(cardsOn(slug))).toHaveLength(0);
        const retried = await run(trigger.deliver(delivery!));
        expect(retried).toMatchObject({ status: "processed", replayed: false });
        expect(await run(cardsOn(slug))).toHaveLength(1);
      });
    }, 60_000);
  });

  describe("a question a run asks on a card filed from a Linear issue", () => {
    /** File the card through the seam, as a real delivery does, and answer it. */
    const filed = (
      fake: ReturnType<typeof makeLinear>,
    ): Effect.Effect<
      Task,
      TaskError | TriggerError,
      TaskService | SqlClient | TriggerService
    > =>
      Effect.gen(function* () {
        const trigger = yield* TriggerService;
        const rules = (yield* trigger.rules).slice();
        const outcome = yield* trigger.deliver(
          linearDeliveryFor(rules)(issueCreated(fake))!,
        );
        const tasks = yield* TaskService;
        return yield* tasks.get(outcome.taskId!);
      });

    const asker = Effect.runSync(mintSessionId);
    const askOn = (
      card: Task,
      question: string,
      callId: string,
    ): Effect.Effect<void, TaskError, TaskService> =>
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        yield* tasks.ask({
          taskId: card.id,
          question,
          actor: asker,
          askId: `${asker}:${card.id}:${callId}`,
        });
      });

    const carry = (card: Task, question: string, callId: string) =>
      Effect.gen(function* () {
        yield* askOn(card, question, callId);
        const writeBack = yield* AskWriteBack;
        yield* writeBack.asked({
          sessionId: asker as SessionId,
          taskId: card.id,
          askId: `${asker}:${card.id}:${callId}`,
          question,
        });
      });

    it("posts one elicitation per ask in the issue's one agent session, and none for a replayed ask", async () => {
      const fake = makeLinear({ identifier: `ENG-${runId}-d` });
      await harness("asked", fake, async ({ run }) => {
        const card = await run(filed(fake));
        expect(card.externalRef).toBe(`linear:${fake.issue.id}`);

        await run(carry(card, "Which Postgres major?", "call-1"));
        expect(fake.agentSessions).toHaveLength(1);
        expect(fake.activities).toEqual([
          {
            agentSessionId: fake.agentSessions[0]?.id,
            content: { type: "elicitation", body: "Which Postgres major?" },
          },
        ]);

        // The ask replayed after a crash — the same session and tool call — posts nothing.
        await run(carry(card, "Which Postgres major?", "call-1"));
        expect(fake.activities).toHaveLength(1);
        expect(fake.agentSessions).toHaveLength(1);

        // A second, distinct question on the same wait is a second activity, in the same thread.
        await run(carry(card, "And which port?", "call-2"));
        expect(
          fake.activities.map((activity) => activity.content["body"]),
        ).toEqual(["Which Postgres major?", "And which port?"]);
        expect(
          new Set(fake.activities.map((activity) => activity.agentSessionId)),
        ).toEqual(new Set([fake.agentSessions[0]?.id]));
        expect(fake.agentSessions).toHaveLength(1);

        // Nothing but the two agent writes went to Linear: the question rides the activity, not a comment.
        expect(fake.writes().map((seen) => seen.operation)).toEqual([
          "agentSessionCreateOnIssue",
          "agentActivityCreate",
          "agentActivityCreate",
        ]);
      });
    }, 60_000);

    it("posts nothing for a card no Linear issue filed", async () => {
      const fake = makeLinear({ identifier: `ENG-${runId}-e` });
      await harness("plain", fake, async ({ run, slug }) => {
        await run(
          Effect.gen(function* () {
            const tasks = yield* TaskService;
            const board = (yield* tasks.listBoards).find(
              (candidate) => candidate.repo === slug,
            )!;
            const card = yield* tasks.create({
              boardId: board.id,
              title: "a hand-made card",
              actor: "person:lukas",
            });
            yield* carry(card, "Which Postgres major?", "call-1");
          }),
        );
        expect(fake.seen).toEqual([]);
      });
    }, 60_000);

    it("never fails the ask: a post Linear refused is logged, the question is still on the card, and the replay posts it", async () => {
      const fake = makeLinear({
        identifier: `ENG-${runId}-f`,
        refuseNth: { operation: "agentActivityCreate", nth: 1 },
      });
      await harness("refused", fake, async ({ run }) => {
        const card = await run(filed(fake));
        await run(carry(card, "Which Postgres major?", "call-1"));
        // The activity was refused: the card is parked on the question all the same.
        expect(fake.activities).toHaveLength(0);
        const parked = await run(
          Effect.flatMap(TaskService, (tasks) => tasks.get(card.id)),
        );
        expect(parked.blocked?.reason).toBe("needs_input");

        // The ask replayed: the card keeps its one question, and the activity is posted now.
        await run(carry(card, "Which Postgres major?", "call-1"));
        expect(fake.activities).toHaveLength(1);
        const thread = await run(
          Effect.flatMap(TaskService, (tasks) => tasks.comments(card.id)),
        );
        expect(
          thread.filter((comment) => comment.kind === "question"),
        ).toHaveLength(1);
        // The session the first attempt opened is the one the retry used.
        expect(fake.agentSessions).toHaveLength(1);
      });
    }, 60_000);

    it("records a reply as the card's answer and lifts needs_input, reading nothing back from Linear, and a redelivered reply answers once", async () => {
      const fake = makeLinear({ identifier: `ENG-${runId}-g` });
      await harness("reply", fake, async ({ run, deliver }) => {
        const card = await run(filed(fake));
        await run(carry(card, "Which Postgres major?", "call-1"));
        const sessionOfAsk = fake.agentSessions[0]!.id;
        const linearBefore = fake.seen.length;

        // Two lines, an em dash and trailing spaces: the text is the event's, verbatim.
        const answer = "Postgres 16.\n  Keep port 5442 — it is shared.  ";
        const reply = deliver(
          prompted({
            issueId: fake.issue.id,
            activityId: `act-${runId}-1`,
            body: answer,
            agentSessionId: sessionOfAsk,
          }),
        )!;
        const trigger = await run(TriggerService);
        const outcome = await run(trigger.deliver(reply));
        expect(outcome.status).toBe("processed");
        expect(outcome.taskId).toBe(card.id);
        expect(outcome.reason).toContain(`as the answer on card ${card.id}`);

        const { after, thread } = await run(
          Effect.gen(function* () {
            const tasks = yield* TaskService;
            return {
              after: yield* tasks.get(card.id),
              thread: yield* tasks.comments(card.id),
            };
          }),
        );
        expect(after.blocked).toBeUndefined();
        expect(thread.map((comment) => comment.kind)).toEqual([
          "question",
          "answer",
        ]);
        expect(thread[1]?.body).toBe(answer);
        expect(thread[1]?.actor).toBe("trigger:linear");
        // The comment is never re-read from Linear: the reply cost no request at all.
        expect(fake.seen).toHaveLength(linearBefore);

        // Linear redelivers it: a replay of the recorded outcome, no second answer.
        const again = await run(trigger.deliver(reply));
        expect(again).toMatchObject({ replayed: true, status: "processed" });
        // A second reply to the same wait, once it is answered, records nothing and says why.
        const late = await run(
          trigger.deliver(
            deliver(
              prompted({
                issueId: fake.issue.id,
                activityId: `act-${runId}-2`,
                body: "Actually 15.",
                agentSessionId: sessionOfAsk,
              }),
            )!,
          ),
        );
        expect(late.status).toBe("skipped");
        expect(late.reason).toContain("is waiting on an answer");
        const thread2 = await run(
          Effect.flatMap(TaskService, (tasks) => tasks.comments(card.id)),
        );
        expect(thread2).toHaveLength(2);
      });
    }, 60_000);

    it("skips a reply on an issue no card of ours is waiting on", async () => {
      const fake = makeLinear({ identifier: `ENG-${runId}-h` });
      await harness("stray", fake, async ({ run, deliver }) => {
        const trigger = await run(TriggerService);
        const outcome = await run(
          trigger.deliver(
            deliver(
              prompted({
                issueId: `iss-${runId}-nobody`,
                activityId: `act-${runId}-stray`,
                body: "hello?",
              }),
            )!,
          ),
        );
        expect(outcome).toMatchObject({ status: "skipped", replayed: false });
        expect(outcome.reason).toContain("is waiting on an answer");
      });
    }, 60_000);
  });
});
