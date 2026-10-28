/**
 * The Linear adapter (LOB-164): the extractor's reading of a real-shaped Linear webhook, the
 * idempotency key it derives from the issue, and — against the real delivery store — the
 * acceptance itself: a labeled issue created in Linear opens exactly one session, on the rule's
 * repo, with the issue's own words as its first message, however Linear redelivers it.
 *
 * The payloads are shaped from Linear's webhook docs (`action`, `type`, `data`, `updatedFrom`,
 * `webhookTimestamp`, `webhookId`; the `Linear-Delivery` header). The sessions are a counting fake:
 * the seam's question is *whether* work starts, and `.pi/skills/verify-api/linear.ts` runs the same
 * deliveries over HTTP with the real `SessionService`.
 *
 * Needs Postgres: `docker compose up -d --wait postgres`. Every issue id carries a per-run stamp, so
 * the file is safe against a database other suites also use.
 */
import { randomBytes } from "node:crypto";
import { BunServices } from "@effect/platform-bun";
import type { RepoSlug, SessionId } from "@repo/domain/Session";
import type { TriggerRule } from "@repo/domain/Trigger";
import { DatabaseLive } from "@repo/storage-postgres";
import { Effect, Layer, ManagedRuntime } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { describe, expect, it } from "vitest";
import {
  linearDelivery,
  linearDeliveryFor,
  linearEvent,
  linearRequestId,
} from "./Linear";
import {
  NoCards,
  NoWriteBack,
  TriggerService,
  TriggerServiceLive,
  TriggerSessions,
} from "./TriggerService";

const runId = randomBytes(6).toString("hex");
const repo = `acme/linear-${runId}` as RepoSlug;
const otherRepo = `acme/linear-other-${runId}` as RepoSlug;
/** Not registered by `withSeam`: the case that needs it registers it mid-test. */
const laterRepo = `acme/linear-later-${runId}` as RepoSlug;

const rules: ReadonlyArray<TriggerRule> = [
  {
    label: "factory",
    repo,
    baseRef: "main",
    prompt: "Linear issue {{key}}: {{title}}\n\n{{body}}",
  },
  { label: "factory-other", repo: otherRepo, prompt: "{{title}}" },
  { label: "factory-later", repo: laterRepo, prompt: "{{title}}" },
];

const FACTORY = { id: "lbl-factory", name: "factory", color: "#5e6ad2" };
const OTHER = { id: "lbl-other", name: "factory-other", color: "#26b5ce" };
const BUG = { id: "lbl-bug", name: "Bug", color: "#eb5757" };
const LATER = { id: "lbl-later", name: "factory-later", color: "#f2c94c" };

/** A Linear `Issue` webhook body, as Linear's docs describe the data-change payload. */
const issuePayload = (over: {
  readonly id?: string;
  readonly action?: string;
  readonly type?: string;
  readonly labels?: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
  }>;
  readonly updatedFrom?: Record<string, unknown>;
  readonly webhookTimestamp?: number;
  readonly title?: string;
  readonly description?: string;
}): Record<string, unknown> => {
  const labels = over.labels ?? [FACTORY];
  return {
    action: over.action ?? "create",
    type: over.type ?? "Issue",
    actor: { id: "user-1", type: "user", name: "Ada" },
    createdAt: "2026-10-27T10:00:00.000Z",
    data: {
      id: over.id ?? `${runId}-issue`,
      identifier: "ENG-42",
      title: over.title ?? "The widget wobbles",
      description: over.description ?? "It wobbles when it spins.",
      labelIds: labels.map((label) => label.id),
      labels,
      teamId: "team-1",
      // The issue's own creation, earlier than the delivery's top-level `createdAt` (the action's).
      createdAt: "2026-10-01T08:00:00.000Z",
      creatorId: "user-creator",
    },
    url: "https://linear.app/acme/issue/ENG-42/the-widget-wobbles",
    ...(over.updatedFrom === undefined
      ? {}
      : { updatedFrom: over.updatedFrom }),
    organizationId: "org-1",
    webhookTimestamp: over.webhookTimestamp ?? 1_761_559_200_000,
    // The *subscription's* id: identical on every delivery, so it must never be a dedupe key.
    webhookId: "000042e3-d123-4980-b49f-8e140eef9329",
  };
};

describe("linearEvent", () => {
  it("normalizes a created issue: its id, its words and its label names", () => {
    expect(
      linearEvent(issuePayload({ labels: [FACTORY, BUG] }), rules),
    ).toEqual({
      source: "linear",
      key: `${runId}-issue`,
      action: "create",
      title: "The widget wobbles",
      body: "It wobbles when it spins.",
      labels: ["factory", "Bug"],
      // The webhook's `url` is its subject's: the issue's own link, which a card links (LOB-254).
      url: "https://linear.app/acme/issue/ENG-42/the-widget-wobbles",
      // Who did it is the webhook's `actor`, and when the issue was made is the issue's own
      // `createdAt`, not the delivery's (S-trigger-trust-gating).
      author: { id: "user-1", name: "Ada" },
      createdAt: "2026-10-01T08:00:00.000Z",
    });
  });

  it("names the actor's e-mail as the login an allowlist may name, and falls back to the creator only on a create", () => {
    const payload = issuePayload({});
    expect(
      linearEvent(
        {
          ...payload,
          actor: { id: "user-2", name: "Bo", email: "bo@acme.dev" },
        },
        rules,
      )?.author,
    ).toEqual({ id: "user-2", login: "bo@acme.dev", name: "Bo" });
    // A relay's body with no actor: on a create, the creator is the one who did it.
    const { actor: _actor, ...anonymous } = payload;
    expect(linearEvent(anonymous, rules)?.author).toEqual({
      id: "user-creator",
    });
    // On an update the creator is not the person who labelled it, so nobody is named.
    const update = issuePayload({
      action: "update",
      labels: [BUG, FACTORY],
      updatedFrom: { labelIds: [BUG.id] },
    });
    const { actor: _updater, ...anonymousUpdate } = update;
    expect(linearEvent(anonymousUpdate, rules)).not.toHaveProperty("author");
  });

  it("prefers the issue's own `data.url`, and carries no link that is not a web link (LOB-254)", () => {
    const payload = issuePayload({});
    const own = "https://linear.app/acme/issue/ENG-42/own";
    expect(
      linearEvent(
        { ...payload, data: { ...(payload["data"] as object), url: own } },
        rules,
      )?.url,
    ).toBe(own);
    expect(
      linearEvent({ ...payload, url: "javascript:alert(1)" }, rules),
    ).not.toHaveProperty("url");
  });

  it("treats an update that adds a label as work: the issue was triaged into the factory", () => {
    const event = linearEvent(
      issuePayload({
        action: "update",
        labels: [BUG, FACTORY],
        updatedFrom: { labelIds: [BUG.id], updatedAt: "2026-10-27T09:00:00Z" },
      }),
      rules,
    );
    expect(event?.action).toBe("create");
  });

  it("keeps Linear's own action for an update that only removed a label", () => {
    const event = linearEvent(
      issuePayload({
        action: "update",
        labels: [FACTORY],
        updatedFrom: { labelIds: [FACTORY.id, BUG.id] },
      }),
      rules,
    );
    expect(event?.action).toBe("update");
  });

  it("keeps Linear's own action for an update that did not touch labels", () => {
    const event = linearEvent(
      issuePayload({ action: "update", updatedFrom: { title: "Old title" } }),
      rules,
    );
    expect(event?.action).toBe("update");
    expect(linearEvent(issuePayload({ action: "remove" }), rules)?.action).toBe(
      "remove",
    );
  });

  it("starts nothing when the added label is one no rule names, though a mapped one is carried", () => {
    // An issue that carried `factory` before the webhook or the rule existed: adding `Bug` to it is
    // not someone triaging it into the factory.
    const event = linearEvent(
      issuePayload({
        action: "update",
        labels: [FACTORY, BUG],
        updatedFrom: { labelIds: [FACTORY.id] },
      }),
      rules,
    );
    expect(event?.action).toBe("update");
  });

  it("answers another entity as an event the filter refuses by name, not as an issue", () => {
    // Linear's Comment payload carries the issue it was left on as `data.issue`; that is context,
    // not the subject, so the key and the title are the comment's.
    const comment = {
      action: "create",
      type: "Comment",
      data: {
        id: "comment-1",
        body: "LGTM",
        issueId: `${runId}-issue`,
        issue: { id: `${runId}-issue`, title: "The widget wobbles" },
      },
      webhookTimestamp: 1_761_559_200_000,
    };
    const event = linearEvent(comment, rules);
    expect(event?.action).toBe("Comment:create");
    expect(event?.key).toBe("Comment:comment-1");
    expect(event?.title).toBe("");
    expect(event?.body).toBe("LGTM");
    expect(linearDelivery(comment, rules, { delivery: "d-1" })?.requestId).toBe(
      "linear:Comment:comment-1:Comment:create:d-1",
    );
  });

  it("answers an entity whose data names no id as an event too, keyed by its delivery", () => {
    // `IssueSLA` carries its fields in `issueData`; a 400 here is Linear's retry-then-disable path.
    const sla = {
      action: "set",
      type: "IssueSLA",
      issueData: { id: `${runId}-issue`, title: "The widget wobbles" },
      webhookTimestamp: 1_761_559_200_000,
    };
    const event = linearEvent(sla, rules);
    expect(event).toMatchObject({
      key: "IssueSLA:no-id",
      action: "IssueSLA:set",
    });
    const first = linearDelivery(sla, rules, { delivery: "d-1" });
    const second = linearDelivery(sla, rules, { delivery: "d-2" });
    expect(first?.requestId).toBe("linear:IssueSLA:no-id:IssueSLA:set:d-1");
    expect(first?.requestId).not.toBe(second?.requestId);
  });

  it("reads a relay's `data.issue` wrapping the same way", () => {
    const event = linearEvent(
      {
        action: "create",
        data: {
          issue: {
            id: "wrapped-1",
            title: "Wrapped",
            description: "relayed",
            labels: ["factory"],
          },
        },
      },
      rules,
    );
    expect(event).toMatchObject({
      key: "wrapped-1",
      action: "create",
      title: "Wrapped",
      labels: ["factory"],
    });
  });

  it("answers undefined for a body that names no entity", () => {
    expect(linearEvent(null, rules)).toBeUndefined();
    expect(linearEvent([], rules)).toBeUndefined();
    expect(
      linearEvent({ action: "create", data: { title: "no id" } }, rules),
    ).toBeUndefined();
    expect(
      linearEvent(
        { action: "create", type: "Issue", data: { title: "no id" } },
        rules,
      ),
    ).toBeUndefined();
  });
});

describe("linearRequestId", () => {
  const keyOf = (
    payload: Record<string, unknown>,
    delivery?: string,
  ): string | undefined =>
    linearDelivery(payload, rules, { delivery })?.requestId;

  it("names the issue once a rule claims it, not the delivery or the subscription", () => {
    expect(keyOf(issuePayload({}), "delivery-1")).toBe(
      `linear:${runId}-issue:mapped`,
    );
    // An issue-wide key outlives any one delivery, so the seam is told it names the work.
    expect(linearDelivery(issuePayload({}), rules)?.keyedByWork).toBe(true);
    expect(
      linearDelivery(issuePayload({ labels: [BUG] }), rules)?.keyedByWork,
    ).toBeUndefined();
  });

  it("gives a retry with a fresh header and a fresh timestamp the same id", () => {
    expect(
      keyOf(
        issuePayload({ webhookTimestamp: 1_761_562_800_000 }),
        "delivery-2",
      ),
    ).toBe(keyOf(issuePayload({}), "delivery-1"));
  });

  it("collapses the create and a later label-adding update into one unit of work", () => {
    const update = issuePayload({
      action: "update",
      labels: [FACTORY, OTHER],
      updatedFrom: { labelIds: [FACTORY.id] },
    });
    expect(keyOf(update, "delivery-3")).toBe(keyOf(issuePayload({}), "d-1"));
  });

  it("keys an unclaimed issue by its sorted label set, so labelling it later is new work", () => {
    const unlabelled = keyOf(issuePayload({ labels: [] }), "d-1");
    expect(unlabelled).toBe(`linear:${runId}-issue:unmapped:no-labels`);
    expect(keyOf(issuePayload({ labels: [BUG, { id: "x", name: "a" }] }))).toBe(
      `linear:${runId}-issue:unmapped:Bug,a`,
    );
    expect(keyOf(issuePayload({ labels: [{ id: "x", name: "a" }, BUG] }))).toBe(
      `linear:${runId}-issue:unmapped:Bug,a`,
    );
    const labelled = keyOf(
      issuePayload({
        action: "update",
        updatedFrom: { labelIds: [] },
      }),
      "d-2",
    );
    expect(labelled).not.toBe(unlabelled);
  });

  it("keys a delivery that starts nothing by the delivery, so it cannot claim the issue", () => {
    const edit = issuePayload({
      action: "update",
      updatedFrom: { title: "Old" },
    });
    expect(keyOf(edit, "delivery-9")).toBe(
      `linear:${runId}-issue:update:delivery-9`,
    );
    // No header (a relay): the payload's own send time names it.
    expect(keyOf(edit)).toBe(`linear:${runId}-issue:update:1761559200000`);
    expect(keyOf(edit, "delivery-9")).not.toBe(keyOf(issuePayload({})));
  });

  it("asks the seam's own question about whether an action starts work", () => {
    // A rule that admits `update` (an operator's choice) makes an edit work, and work is keyed by
    // the issue — otherwise every edit would open its own session.
    const widened: ReadonlyArray<TriggerRule> = [
      {
        label: "factory",
        repo,
        prompt: "{{title}}",
        startsWorkFor: ["update"],
      },
    ];
    const edit = issuePayload({
      action: "update",
      updatedFrom: { title: "x" },
    });
    const event = linearEvent(edit, widened);
    expect(event).toBeDefined();
    if (event === undefined) return;
    expect(linearRequestId(event, widened, edit, { delivery: "d-1" })).toBe(
      `linear:${runId}-issue:mapped`,
    );
  });
});

/** What the counting fake opened: one entry per `create`, with the message `send` gave it. */
type Opened = {
  readonly id: SessionId;
  readonly title: string;
  readonly repo: RepoSlug;
  readonly baseRef: string | undefined;
  prompt: string | undefined;
};

const withSeam = async <A>(
  body: (seam: {
    readonly post: (
      payload: Record<string, unknown>,
      delivery: string,
    ) => Promise<{
      readonly status: string;
      readonly replayed: boolean;
      readonly reason?: string | undefined;
      readonly sessionId?: SessionId | undefined;
      readonly requestId: string;
    }>;
    readonly opened: Array<Opened>;
    readonly skipReason: (requestId: string) => Promise<string | null>;
    readonly register: (slug: RepoSlug) => Promise<void>;
  }) => Promise<A>,
): Promise<A> => {
  const opened: Array<Opened> = [];
  const sessions = TriggerSessions.of({
    create: (input) =>
      Effect.sync(() => {
        const id =
          `ses_${String(opened.length + 1).padStart(26, "0")}` as SessionId;
        opened.push({
          id,
          title: input.title,
          repo: input.repo,
          baseRef: input.baseRef,
          prompt: undefined,
        });
        return { id };
      }),
    send: (input) =>
      Effect.sync(() => {
        const entry = opened.find((session) => session.id === input.sessionId);
        if (entry !== undefined) entry.prompt = input.content;
      }),
  });
  // `provideMerge`, because the cases read the delivery store the seam writes: the skip reason is
  // a recorded row, and the assertion on it is only as good as the row it reads.
  const runtime = ManagedRuntime.make(
    TriggerServiceLive({ rules }).pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(TriggerSessions, sessions),
          NoWriteBack,
          NoCards,
        ),
      ),
      Layer.provideMerge(Layer.mergeAll(DatabaseLive, BunServices.layer)),
    ),
  );
  const derive = linearDeliveryFor(rules);
  try {
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        for (const slug of [repo, otherRepo]) {
          yield* sql`INSERT INTO repos (slug) VALUES (${slug})
                     ON CONFLICT (slug) DO NOTHING`;
        }
      }),
    );
    return await body({
      opened,
      post: async (payload, delivery) => {
        const derived = derive(payload, { delivery });
        if (derived === undefined) throw new Error("payload did not normalize");
        const outcome = await runtime.runPromise(
          Effect.gen(function* () {
            const trigger = yield* TriggerService;
            return yield* trigger.deliver(derived);
          }),
        );
        return { ...outcome, requestId: derived.requestId };
      },
      skipReason: (requestId) =>
        runtime.runPromise(
          Effect.gen(function* () {
            const sql = yield* SqlClient;
            const rows = yield* sql<{ skipReason: string | null }>`
              SELECT skip_reason FROM webhook_deliveries WHERE request_id = ${requestId}
            `;
            return rows[0]?.skipReason ?? null;
          }),
        ),
      register: (slug) =>
        runtime.runPromise(
          Effect.gen(function* () {
            const sql = yield* SqlClient;
            yield* sql`INSERT INTO repos (slug) VALUES (${slug})
                       ON CONFLICT (slug) DO NOTHING`;
          }),
        ),
    });
  } finally {
    await runtime.dispose();
  }
};

describe("a Linear issue through the seam", () => {
  it("opens exactly one session for a labeled issue, on the rule's repo, with the issue as its prompt", async () => {
    await withSeam(async ({ post, opened }) => {
      const id = `${runId}-created`;
      const first = await post(
        issuePayload({ id, labels: [BUG, FACTORY] }),
        "delivery-a",
      );
      expect(first.status).toBe("processed");
      expect(first.replayed).toBe(false);
      expect(first.reason).toBe(`rule "factory" mapped it to ${repo}`);
      expect(opened).toHaveLength(1);
      expect(opened[0]).toEqual({
        id: first.sessionId,
        title: "The widget wobbles",
        repo,
        baseRef: "main",
        prompt: `Linear issue ${id}: The widget wobbles\n\nIt wobbles when it spins.`,
      });

      // Linear retries a delivery it thinks failed — with its own header and a later timestamp.
      const retry = await post(
        issuePayload({
          id,
          labels: [BUG, FACTORY],
          webhookTimestamp: 1_761_562_800_000,
        }),
        "delivery-b",
      );
      expect(retry.replayed).toBe(true);
      expect(retry.status).toBe("processed");

      // A second mapped label added later is the same issue, not a second session.
      const relabel = await post(
        issuePayload({
          id,
          action: "update",
          labels: [BUG, FACTORY, OTHER],
          updatedFrom: { labelIds: [BUG.id, FACTORY.id] },
        }),
        "delivery-c",
      );
      expect(relabel.replayed).toBe(true);

      // An edit starts nothing, and says why.
      const edit = await post(
        issuePayload({ id, action: "update", updatedFrom: { title: "Old" } }),
        "delivery-d",
      );
      expect(edit.status).toBe("skipped");
      expect(edit.reason).toContain('action "update" is not "create"');

      expect(opened).toHaveLength(1);
    });
  }, 60_000);

  it("records an unmappable issue as skipped with the labels it carried, and opens nothing", async () => {
    await withSeam(async ({ post, opened, skipReason }) => {
      const id = `${runId}-unmapped`;
      const outcome = await post(issuePayload({ id, labels: [BUG] }), "d-1");
      expect(outcome.status).toBe("skipped");
      expect(outcome.reason).toBe("no rule matches labels [Bug]");
      expect(await skipReason(outcome.requestId)).toBe(
        "no rule matches labels [Bug]",
      );
      const bare = await post(
        issuePayload({ id: `${id}-bare`, labels: [] }),
        "d-2",
      );
      expect(bare.reason).toBe(
        "the event carries no labels, so no rule maps it",
      );
      expect(opened).toHaveLength(0);
    });
  }, 60_000);

  it("starts the session when an issue filed unlabelled is labelled later — even after an edit", async () => {
    await withSeam(async ({ post, opened }) => {
      const id = `${runId}-triaged`;
      const filed = await post(issuePayload({ id, labels: [] }), "d-1");
      expect(filed.status).toBe("skipped");
      // An edit arriving first must not claim the issue's key.
      const edit = await post(
        issuePayload({
          id,
          labels: [],
          action: "update",
          updatedFrom: { title: "x" },
        }),
        "d-2",
      );
      expect(edit.status).toBe("skipped");

      const labelled = await post(
        issuePayload({
          id,
          action: "update",
          labels: [OTHER],
          updatedFrom: { labelIds: [] },
        }),
        "d-3",
      );
      expect(labelled.status).toBe("processed");
      expect(labelled.replayed).toBe(false);
      expect(opened).toHaveLength(1);
      expect(opened[0]?.repo).toBe(otherRepo);
      expect(opened[0]?.prompt).toBe("The widget wobbles");
    });
  }, 60_000);

  it("starts the issue once its rule's repo is registered, though the key names the issue", async () => {
    await withSeam(async ({ post, opened, register }) => {
      const id = `${runId}-later`;
      const refused = await post(issuePayload({ id, labels: [LATER] }), "d-1");
      expect(refused.status).toBe("skipped");
      expect(refused.reason).toBe(`repo ${laterRepo} is not registered`);
      // Before registration the skip is simply the answer again, and still nothing opens.
      const again = await post(issuePayload({ id, labels: [LATER] }), "d-2");
      expect(again.status).toBe("skipped");
      expect(opened).toHaveLength(0);

      await register(laterRepo);

      // The operator removes and re-adds the label; Linear sends it twice at once for good measure.
      const relabel = issuePayload({
        id,
        action: "update",
        labels: [LATER],
        updatedFrom: { labelIds: [] },
      });
      const outcomes = await Promise.all([
        post(relabel, "d-3"),
        post(relabel, "d-4"),
      ]);
      expect(outcomes.map((outcome) => outcome.requestId)).toEqual([
        refused.requestId,
        refused.requestId,
      ]);
      const winners = outcomes.filter((outcome) => !outcome.replayed);
      expect(winners).toHaveLength(1);
      expect(winners[0]?.status).toBe("processed");
      expect(opened).toHaveLength(1);
      expect(opened[0]?.repo).toBe(laterRepo);

      // Once processed, the issue-wide key is a replay again.
      const retry = await post(issuePayload({ id, labels: [LATER] }), "d-5");
      expect(retry).toMatchObject({ status: "processed", replayed: true });
      expect(opened).toHaveLength(1);
    });
  }, 60_000);

  it("answers a comment delivery with a skip that names it, rather than a refusal Linear retries", async () => {
    await withSeam(async ({ post, opened }) => {
      const outcome = await post(
        {
          action: "create",
          type: "Comment",
          data: {
            id: `${runId}-comment`,
            body: "LGTM",
            issueId: `${runId}-created`,
            issue: { id: `${runId}-created`, title: "The widget wobbles" },
          },
          webhookTimestamp: 1_761_559_200_000,
        },
        "d-1",
      );
      expect(outcome.status).toBe("skipped");
      expect(outcome.reason).toContain('action "Comment:create"');
      expect(opened).toHaveLength(0);
    });
  }, 60_000);
});
