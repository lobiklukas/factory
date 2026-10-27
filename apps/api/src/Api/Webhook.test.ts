/* oxlint-disable effecttsgo/process-env */
/**
 * The trigger routes' own refusals, served in-process (LOB-216).
 *
 * `POST /webhooks/linear` and `POST /webhooks/generic` answer `503 not-configured` when their secret
 * is unset, before anything is verified or written down (`Webhook.ts`'s `handle`). The
 * `verify-api` drive cannot reach that branch — it boots one API with both secrets set — so these
 * cases serve the app's own `WebhookRoutes` through `HttpRouter.toWebHandler` with each secret
 * unset in turn.
 *
 * The seam is a recording fake: the question is whether a route lets a delivery through, and a
 * refusal that reached `TriggerService.deliver` would be one the ledger shows. Each refused body is
 * signed with the *empty* key, which is what an unset secret degrades to (`config.secret ?? ""`):
 * without the `503` branch that signature verifies, the delivery reaches the seam, and the route
 * answers `200`. So removing the branch turns these red, rather than leaving a `401` to pass for it.
 * The control case signs with a configured secret and proves the same harness does reach the seam.
 *
 * The routes read their secrets per request, so each case sets the environment it needs and the
 * `afterEach` puts the process's own values back.
 */
import { createHmac } from "node:crypto";
import { TriggerService } from "@repo/core";
import type { RepoSlug } from "@repo/domain/Session";
import type {
  TriggerDelivery,
  TriggerOutcome,
  TriggerRule,
} from "@repo/domain/Trigger";
import { Effect, Layer } from "effect";
import { HttpRouter } from "effect/http";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  WebhookRateLimiterLive,
  WebhookRoutes,
  webhookRoutesFor,
} from "./Webhook";

const SECRETS = ["TRIGGER_SECRET", "LINEAR_WEBHOOK_SECRET"] as const;
const saved = new Map(SECRETS.map((name) => [name, process.env[name]]));

/** Every delivery a route handed the seam, in order. */
const delivered: Array<TriggerDelivery> = [];

/** What the fake seam answers; a case that needs another outcome sets it. */
const SKIPPED: TriggerOutcome = {
  status: "skipped",
  replayed: false,
  reason: "fake",
};
let answer: TriggerOutcome = SKIPPED;

/** The routes served over the recording fake seam. */
const serve = (routes: typeof WebhookRoutes) =>
  HttpRouter.toWebHandler(
    routes.pipe(
      HttpRouter.provideRequest(
        Layer.mergeAll(
          Layer.succeed(
            TriggerService,
            TriggerService.of({
              deliver: (delivery) =>
                Effect.sync(() => {
                  delivered.push(delivery);
                  return answer;
                }),
            }),
          ),
          WebhookRateLimiterLive,
        ),
      ),
    ),
    { disableLogger: true },
  );

const { handler, dispose } = serve(WebhookRoutes);

/**
 * A deployment whose rule admits an action that is not one of the two lifecycle actions: a
 * `startsWorkFor` entry is any string, so the generic adapter has to refuse what the rules admit,
 * not only a fixed list (LOB-235 review).
 */
const widenedRules: ReadonlyArray<TriggerRule> = [
  {
    label: "release",
    repo: "acme/lob-235" as RepoSlug,
    prompt: "{{title}}",
    startsWorkFor: ["release", "create"],
  },
];
const widened = serve(webhookRoutesFor(widenedRules));

const sign = (body: string, secret: string): string =>
  createHmac("sha256", secret).update(body).digest("hex");

const post = async (
  path: "/webhooks/generic" | "/webhooks/linear",
  payload: unknown,
  secret: string,
  serveWith: typeof handler = handler,
): Promise<{
  readonly status: number;
  readonly body: unknown;
  readonly retryAfter: string | null;
}> => {
  const body = JSON.stringify(payload);
  const response = await serveWith(
    new Request(`http://factory.test${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [path === "/webhooks/linear"
          ? "linear-signature"
          : "x-trigger-signature"]: sign(body, secret),
      },
      body,
    }),
  );
  return {
    status: response.status,
    body: await response.json(),
    retryAfter: response.headers.get("retry-after"),
  };
};

const generic = { requestId: "lob-216-generic", label: "factory" };
const linear = {
  type: "Issue",
  action: "create",
  data: { id: "lob-216-issue", title: "Fix it", labels: [] },
};

/** Set each named secret, and unset the rest — `undefined` is the unset a deployment ships. */
const configure = (
  secrets: Partial<Record<(typeof SECRETS)[number], string>>,
): void => {
  for (const name of SECRETS) {
    const value = secrets[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
};

beforeEach(() => {
  delivered.length = 0;
  answer = SKIPPED;
  // The signature header the generic body is signed into is the default one.
  delete process.env["TRIGGER_SECRET_HEADER"];
});

afterEach(() => {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

afterAll(async () => {
  await dispose();
  await widened.dispose();
});

describe("a trigger route with no secret", () => {
  it("refuses a generic delivery with 503, naming TRIGGER_SECRET, and hands the seam nothing", async () => {
    configure({ LINEAR_WEBHOOK_SECRET: "linear-secret" });
    const answer = await post("/webhooks/generic", generic, "");

    expect(answer.status).toBe(503);
    expect(answer.body).toMatchObject({ ok: false, code: "not-configured" });
    expect(JSON.stringify(answer.body)).toContain("TRIGGER_SECRET");
    expect(delivered).toHaveLength(0);
  });

  it("refuses a Linear delivery with 503, naming LINEAR_WEBHOOK_SECRET, and hands the seam nothing", async () => {
    configure({ TRIGGER_SECRET: "generic-secret" });
    const answer = await post("/webhooks/linear", linear, "");

    expect(answer.status).toBe(503);
    expect(answer.body).toMatchObject({ ok: false, code: "not-configured" });
    expect(JSON.stringify(answer.body)).toContain("LINEAR_WEBHOOK_SECRET");
    expect(delivered).toHaveLength(0);
  });

  it("treats a secret set to the empty string as unset", async () => {
    configure({ TRIGGER_SECRET: "", LINEAR_WEBHOOK_SECRET: "" });

    expect((await post("/webhooks/generic", generic, "")).status).toBe(503);
    expect((await post("/webhooks/linear", linear, "")).status).toBe(503);
    expect(delivered).toHaveLength(0);
  });

  it("is the only route refused: with its secret set, the same harness reaches the seam", async () => {
    // The control: without it, a harness that never reached the handler would pass the cases above.
    configure({
      TRIGGER_SECRET: "generic-secret",
      LINEAR_WEBHOOK_SECRET: "linear-secret",
    });

    const viaGeneric = await post(
      "/webhooks/generic",
      generic,
      "generic-secret",
    );
    const viaLinear = await post("/webhooks/linear", linear, "linear-secret");

    expect(viaGeneric.status).toBe(200);
    expect(viaLinear.status).toBe(200);
    expect(delivered.map((delivery) => delivery.event.source)).toEqual([
      "generic",
      "linear",
    ]);
  });
});

describe("a replay of a delivery still in flight", () => {
  // LOB-216: the seam answers `received` to a replay whose claim has no outcome yet — the first
  // process may be working, or may have been killed. A `200` would end Linear's retries (it stops on
  // any `200`), so the killed delivery's first retry, inside the reclaim window, would be its last.
  // The route has to answer something the sender retries; removing the branch turns these red with
  // `expected 200 to be 503`.
  beforeEach(() => {
    configure({
      TRIGGER_SECRET: "generic-secret",
      LINEAR_WEBHOOK_SECRET: "linear-secret",
    });
  });

  it("is 503 in-progress with Retry-After on both routes, not a 200 the sender stops on", async () => {
    answer = { status: "received", replayed: true };

    for (const viaRoute of [
      await post("/webhooks/generic", generic, "generic-secret"),
      await post("/webhooks/linear", linear, "linear-secret"),
    ]) {
      expect(viaRoute.status).toBe(503);
      expect(viaRoute.retryAfter).toBe("60");
      expect(viaRoute.body).toMatchObject({
        ok: false,
        code: "in-progress",
        status: "received",
        replayed: true,
      });
    }
    expect(delivered).toHaveLength(2);
  });

  it("leaves a replay with a recorded outcome a 200, so a finished delivery stops its retries", async () => {
    // The control: only the in-flight answer is retryable. A replay of processed (or skipped) work
    // is the sender's final answer, and a 503 there would make it retry forever.
    answer = {
      status: "processed",
      replayed: true,
    };
    const processed = await post(
      "/webhooks/generic",
      generic,
      "generic-secret",
    );
    expect(processed.status).toBe(200);
    expect(processed.retryAfter).toBeNull();
    expect(processed.body).toMatchObject({
      ok: true,
      status: "processed",
      replayed: true,
    });

    answer = { status: "skipped", replayed: true, reason: "fake" };
    expect(
      (await post("/webhooks/linear", linear, "linear-secret")).status,
    ).toBe(200);
  });
});

describe("a generic delivery that names a lifecycle action", () => {
  // LOB-235: the generic caller types its own `action`, so it cannot be the one that says a push or
  // a schedule tick happened. Before the refusal, `{action: "push", label: "docs"}` reached the seam,
  // whose docs rule admits `push` (`startsWorkFor`), and the recorded outcome named a push no push
  // produced. The route now answers `400 lifecycle-action` and hands the seam nothing; removing the
  // refusal turns these red with `expected 200 to be 400`, because the fake seam answers `200`.
  beforeEach(() => {
    configure({ TRIGGER_SECRET: "generic-secret" });
  });

  for (const action of ["push", "schedule"]) {
    it(`refuses "${action}" with 400, naming why, and records nothing`, async () => {
      const refused = await post(
        "/webhooks/generic",
        { requestId: `lob-235-${action}`, action, label: "docs" },
        "generic-secret",
      );

      expect(refused.status).toBe(400);
      expect(refused.body).toMatchObject({
        ok: false,
        code: "lifecycle-action",
      });
      const error = (refused.body as { readonly error?: unknown }).error;
      expect(typeof error).toBe("string");
      // It names the action it refused and why, and claims nothing about a delivery that happened.
      expect(error).toContain(`lifecycle action "${action}"`);
      expect(error).toContain("generic webhook cannot name");
      expect(refused.body).not.toHaveProperty("status");
      expect(refused.body).not.toHaveProperty("reason");
      expect(delivered).toHaveLength(0);
    });
  }

  it("still hands a create on the docs label to the seam, as a create", async () => {
    answer = { status: "processed", replayed: false };
    const created = await post(
      "/webhooks/generic",
      { requestId: "lob-235-create", action: "create", label: "docs" },
      "generic-secret",
    );

    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ ok: true, status: "processed" });
    expect(delivered.map((delivery) => delivery.event)).toMatchObject([
      { source: "generic", action: "create", labels: ["docs"] },
    ]);
  });

  it("refuses any action a rule admits, not only push and schedule", async () => {
    // A rule's `startsWorkFor` is any string. With `release` admitted, a fixed denylist would hand
    // `{action: "release"}` to the seam, which would record the rule mapping it — the same claim
    // about a delivery the caller only typed. Removing `callerCannotName`'s rule half turns this
    // red with `expected 200 to be 400`.
    const refused = await post(
      "/webhooks/generic",
      { requestId: "lob-235-release", action: "release", label: "release" },
      "generic-secret",
      widened.handler,
    );
    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject({ ok: false, code: "lifecycle-action" });
    expect((refused.body as { readonly error?: unknown }).error).toContain(
      'lifecycle action "release"',
    );

    // `push` is refused there too, though no rule lists it, and `create` — which the rule also
    // lists — is still the caller's own action and reaches the seam.
    const push = await post(
      "/webhooks/generic",
      { requestId: "lob-235-release-push", action: "push", label: "release" },
      "generic-secret",
      widened.handler,
    );
    expect(push.status).toBe(400);
    const created = await post(
      "/webhooks/generic",
      { requestId: "lob-235-release-create", label: "release" },
      "generic-secret",
      widened.handler,
    );
    expect(created.status).toBe(200);
    expect(delivered.map((delivery) => delivery.event.action)).toEqual([
      "create",
    ]);
  });

  it("refuses only the lifecycle actions: any other action still reaches the seam's filter", async () => {
    // The control: `update` is the seam's to refuse (`skipped`, with its reason — `webhook.sh`'s
    // check 4), so a route that refused every non-create would fail here.
    await post(
      "/webhooks/generic",
      { requestId: "lob-235-update", action: "update", label: "docs" },
      "generic-secret",
    );
    await post(
      "/webhooks/generic",
      { requestId: "lob-235-default", label: "docs" },
      "generic-secret",
    );

    expect(delivered.map((delivery) => delivery.event.action)).toEqual([
      "update",
      "create",
    ]);
  });
});
