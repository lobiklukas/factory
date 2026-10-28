/**
 * The GitHub adapter (LOB-190): the extractor's reading of a real-shaped `issues` payload, the
 * delivery id it derives from the intent, and the two comment calls the write-back makes.
 *
 * The seam's own behaviour — dedupe, the action filter, the label mapping, the claim release — is
 * `TriggerService.test.ts`'s and `Trigger.test.ts`'s, and it is not re-proved here: an adapter that
 * normalized a payload wrong is what this file is for. The end-to-end half (create, replay, one
 * comment on the issue, the label-set key across the `opened` + `labeled` pair) is
 * `.pi/skills/verify-api/github-issues.ts` against the real session layer and a loopback GitHub.
 */
import { createHmac } from "node:crypto";
import { Effect, Layer, Option, Redacted } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import type { RepoSlug, SessionId } from "@repo/domain/Session";
import {
  TriggerError,
  type TriggerDelivery,
  type TriggerOutcome,
  type TriggerRule,
} from "@repo/domain/Trigger";
import { CredentialProvider, staticTokenProvider } from "./credentials";
import {
  githubComment,
  githubDelivery,
  githubEvent,
  githubDeliveryFor,
  githubIssueIntake,
  normalizeGitHubMention,
  githubRequestId,
  GitHubWriteBack,
  handleGitHubIssueWebhook,
} from "./GitHub";
import { TriggerService, TriggerWriteBack } from "./TriggerService";

const repo = "acme/widget" as RepoSlug;

/** GitHub's `issues` webhook payload, shaped as the docs describe it. */
const payload = (over: {
  readonly action?: string;
  readonly number?: number;
  readonly labels?: ReadonlyArray<unknown>;
  readonly fullName?: string;
  readonly pullRequest?: boolean;
}): Record<string, unknown> => ({
  action: over.action ?? "opened",
  issue: {
    number: over.number ?? 7,
    title: "The widget wobbles",
    body: "It wobbles when it spins.",
    labels: over.labels ?? [
      { id: 1, name: "factory" },
      { id: 2, name: "bug" },
    ],
    ...(over.pullRequest === true
      ? {
          pull_request: {
            url: "https://api.github.com/repos/acme/widget/pulls/7",
          },
        }
      : {}),
  },
  repository: {
    id: 1,
    name: "widget",
    full_name: over.fullName ?? "acme/widget",
    owner: { login: "acme" },
  },
});

/** The write-back's two calls; `existing` is what the comment list answers. */
const makeFakeHttp = (
  status: number,
  existing: ReadonlyArray<unknown> = [],
) => {
  const requests: Array<{
    readonly method: string;
    readonly path: string;
    readonly authorization: string | undefined;
    readonly accept: string | undefined;
    readonly apiVersion: string | undefined;
    readonly body: unknown;
  }> = [];
  const Json = Schema.fromJsonString(Schema.Unknown);
  const client = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request, url) =>
      Effect.gen(function* () {
        const reqBody =
          request.body._tag === "Uint8Array"
            ? yield* Schema.decodeEffect(Json)(
                new TextDecoder().decode(request.body.body),
              )
            : undefined;
        requests.push({
          method: request.method,
          path: url.pathname,
          authorization: request.headers["authorization"],
          accept: request.headers["accept"],
          apiVersion: request.headers["x-github-api-version"],
          body: reqBody,
        });
        const answer =
          request.method === "GET"
            ? { status: 200, body: existing }
            : { status, body: { id: 30_001 } };
        const text = yield* Schema.encodeEffect(Json)(answer.body).pipe(
          Effect.orDie,
        );
        const response = new Response(text, {
          status: answer.status,
          headers: { "content-type": "application/json" },
        });
        return HttpClientResponse.fromWeb(request, response);
      }).pipe(Effect.orDie),
    ),
  );
  const credentials = Layer.succeed(
    CredentialProvider,
    CredentialProvider.of(
      staticTokenProvider(Option.some(Redacted.make("ghs-test-token"))),
    ),
  );
  return { requests, layer: Layer.merge(client, credentials) };
};

const sessionId = "01J8Z000000000000000000000" as SessionId;

const writeBack = (
  status: number,
  options: {
    readonly existing?: ReadonlyArray<unknown>;
    readonly sessionUrlBase?: string;
  } = {},
) => {
  const fake = makeFakeHttp(status, options.existing ?? []);
  const layer = GitHubWriteBack({
    apiUrl: "http://127.0.0.1:9413",
    ...(options.sessionUrlBase === undefined
      ? {}
      : { sessionUrlBase: options.sessionUrlBase }),
  }).pipe(Layer.provide(fake.layer));
  return { fake, layer };
};

const write = (layer: Layer.Layer<TriggerWriteBack>, key = "acme/widget#7") =>
  Effect.runPromiseExit(
    Effect.gen(function* () {
      const port = yield* TriggerWriteBack;
      yield* port.write({
        event: {
          source: "github",
          key,
          action: "create",
          title: "",
          body: "",
          labels: [],
          repo,
        },
        sessionId,
      });
    }).pipe(Effect.provide(layer)),
  );

describe("githubEvent", () => {
  it("normalizes an opened issue into the seam's event, with the payload's own repo", () => {
    expect(githubEvent(payload({}))).toEqual({
      source: "github",
      key: "acme/widget#7",
      action: "create",
      title: "The widget wobbles",
      body: "It wobbles when it spins.",
      labels: ["factory", "bug"],
      repo,
    });
  });

  it("reads the repo from the payload rather than from anything global", () => {
    const elsewhere = githubEvent(payload({ fullName: "Other/Repository" }));
    expect(elsewhere?.repo).toBe("other/repository");
    expect(elsewhere?.key).toBe("other/repository#7");
  });

  it("treats adding the label to an existing issue as work too", () => {
    expect(githubEvent(payload({ action: "labeled" }))?.action).toBe("create");
  });

  it("keeps GitHub's own name for an event that starts nothing, so the seam refuses it by name", () => {
    expect(githubEvent(payload({ action: "unlabeled" }))?.action).toBe(
      "unlabeled",
    );
    expect(githubEvent(payload({ action: "closed" }))?.action).toBe("closed");
  });

  it("accepts a bare string label as well as GitHub's label objects", () => {
    expect(
      githubEvent(payload({ labels: ["factory", { name: "bug" }, { id: 3 }] }))
        ?.labels,
    ).toEqual(["factory", "bug"]);
  });

  it("answers undefined for a pull request, which GitHub also sends as an issue", () => {
    expect(githubEvent(payload({ pullRequest: true }))).toBeUndefined();
  });

  it("answers undefined when the payload names no repository or no issue number", () => {
    const noRepo = payload({});
    delete noRepo["repository"];
    expect(githubEvent(noRepo)).toBeUndefined();
    expect(
      githubEvent({ ...payload({}), repository: { full_name: "not-a-slug" } }),
    ).toBeUndefined();
    const noNumber = payload({});
    delete (noNumber["issue"] as Record<string, unknown>)["number"];
    expect(githubEvent(noNumber)).toBeUndefined();
    expect(githubEvent("not a payload")).toBeUndefined();
  });
});

describe("githubRequestId", () => {
  const rules = [
    { label: "factory", repo, prompt: "{{title}}" },
  ] as ReadonlyArray<TriggerRule>;
  const twoRules = [
    ...rules,
    { label: "deploy", repo, prompt: "deploy" },
  ] as ReadonlyArray<TriggerRule>;

  const event = (over: { action?: string; labels?: ReadonlyArray<string> }) => {
    const normalized = githubEvent(
      payload({
        ...(over.action === undefined ? {} : { action: over.action }),
        labels: (over.labels ?? ["factory"]).map((name) => ({ name })),
      }),
    );
    if (normalized === undefined) throw new Error("did not normalize");
    return normalized;
  };

  it("names the issue, because one issue is one unit of work", () => {
    expect(githubRequestId(event({}), rules)).toBe(
      "github:acme/widget#7:mapped",
    );
  });

  it("collapses GitHub's opened and labeled pair for one issue into one delivery", () => {
    const opened = githubRequestId(event({ action: "opened" }), rules);
    const labeled = githubRequestId(event({ action: "labeled" }), rules);
    expect(labeled).toBe(opened);
  });

  it("gives a redelivery the same id", () => {
    const first = githubDelivery(payload({}), rules);
    const replay = githubDelivery(payload({}), rules);
    expect(replay?.requestId).toBe(first?.requestId);
  });

  it("treats a second label the same rule claims as the same issue, not a second session", () => {
    expect(githubRequestId(event({ labels: ["factory", "bug"] }), rules)).toBe(
      githubRequestId(event({ labels: ["factory"] }), rules),
    );
  });

  it("does not let two rules, in either order, start two sessions on one issue", () => {
    // The round-2 case: `deploy` arrives first and starts work, then the issue is labelled
    // `factory` too. `resolveMapping` now picks whichever rule the operator listed first, but the
    // key is the issue, so which one it picks cannot make a second session.
    const deployOnly = githubRequestId(event({ labels: ["deploy"] }), twoRules);
    expect(deployOnly).toBe("github:acme/widget#7:mapped");
    expect(
      githubRequestId(event({ labels: ["deploy", "factory"] }), twoRules),
    ).toBe(deployOnly);
    expect(
      githubRequestId(event({ labels: ["factory", "deploy"] }), twoRules),
    ).toBe(deployOnly);
  });

  it("gives an unlabelled issue its own id, so labelling it later is new work", () => {
    const unlabelled = githubRequestId(event({ labels: [] }), rules);
    expect(unlabelled).toBe("github:acme/widget#7:unmapped:no-labels");
    expect(unlabelled).not.toBe(githubRequestId(event({}), rules));
    expect(githubRequestId(event({ labels: ["neither"] }), rules)).toBe(
      "github:acme/widget#7:unmapped:neither",
    );
  });

  it("is unaffected by the order GitHub lists labels in", () => {
    expect(githubRequestId(event({ labels: ["neither", "nope"] }), rules)).toBe(
      githubRequestId(event({ labels: ["nope", "neither"] }), rules),
    );
    expect(githubRequestId(event({ labels: ["bug", "factory"] }), rules)).toBe(
      githubRequestId(event({ labels: ["factory", "bug"] }), rules),
    );
  });

  it("does not normalize a pull request into a delivery at all", () => {
    expect(
      githubDelivery(payload({ pullRequest: true }), rules),
    ).toBeUndefined();
    expect(githubDeliveryFor(rules)(payload({}))?.requestId).toBe(
      "github:acme/widget#7:mapped",
    );
  });
});

describe("GitHubWriteBack", () => {
  it("reads the issue's comments, then posts one, as the App token names it", async () => {
    const { fake, layer } = writeBack(201);
    expect((await write(layer))._tag).toBe("Success");
    expect(fake.requests.map((request) => request.method)).toEqual([
      "GET",
      "POST",
    ]);
    expect(fake.requests[0]?.path).toBe("/repos/acme/widget/issues/7/comments");
    const post = fake.requests[1];
    expect(post?.path).toBe("/repos/acme/widget/issues/7/comments");
    expect(post?.authorization).toBe("Bearer ghs-test-token");
    expect(post?.accept).toBe("application/vnd.github+json");
    expect(post?.apiVersion).toBe("2022-11-28");
    expect(post?.body).toEqual({
      body: githubComment({ apiUrl: "http://127.0.0.1:9413" }, sessionId),
    });
  });

  it("posts nothing when the issue already carries this session's comment", async () => {
    // The retry shape: the previous attempt's comment landed and its acknowledgement did not, so
    // the seam gave the claim back and the delivery runs again.
    const { fake, layer } = writeBack(201, {
      existing: [{ id: 29_999, body: `Factory started session ${sessionId}.` }],
    });
    expect((await write(layer))._tag).toBe("Success");
    expect(fake.requests.map((request) => request.method)).toEqual(["GET"]);
  });

  it("still posts when the issue's other comments name other sessions", async () => {
    const { fake, layer } = writeBack(201, {
      existing: [{ id: 29_999, body: "Factory started session 01J8ZOTHER." }],
    });
    expect((await write(layer))._tag).toBe("Success");
    expect(fake.requests.map((request) => request.method)).toEqual([
      "GET",
      "POST",
    ]);
  });

  it("names the session in the comment, and links to it when the deployment knows where", () => {
    const withoutLink = githubComment({}, sessionId);
    expect(withoutLink).toContain(sessionId);
    expect(withoutLink).not.toContain("http://localhost:3000");
    expect(
      githubComment(
        { sessionUrlBase: "http://localhost:3000/sessions/" },
        sessionId,
      ),
    ).toContain(`http://localhost:3000/sessions/${sessionId}`);
  });

  it("fails the delivery as a write-back when GitHub refuses the comment", async () => {
    const { layer } = writeBack(403);
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const port = yield* TriggerWriteBack;
        return yield* Effect.flip(
          port.write({
            event: {
              source: "github",
              key: "acme/widget#7",
              action: "create",
              title: "",
              body: "",
              labels: [],
              repo,
            },
            sessionId,
          }),
        );
      }).pipe(Effect.provide(layer)),
    );
    expect(error.code).toBe("write-back");
    expect(error.message).toContain("403");
  });

  it("fails as a write-back when the event names no repository to comment on", async () => {
    const { layer } = writeBack(201);
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const port = yield* TriggerWriteBack;
        return yield* Effect.flip(
          port.write({
            event: {
              source: "github",
              key: "acme/widget#7",
              action: "create",
              title: "",
              body: "",
              labels: [],
            },
            sessionId,
          }),
        );
      }).pipe(Effect.provide(layer)),
    );
    expect(error.code).toBe("write-back");
    expect(error.message).toContain("named no repository");
  });
});

/** GitHub's `issue_comment` webhook payload: the issue, its labels, and the comment. */
const commentPayload = (
  over: {
    readonly action?: string;
    readonly text?: string;
    readonly login?: string;
    readonly userType?: string;
    readonly senderType?: string;
    readonly association?: string | null;
    readonly labels?: ReadonlyArray<string>;
    readonly pullRequest?: boolean;
  } = {},
): Record<string, unknown> => ({
  action: over.action ?? "created",
  issue: {
    number: 7,
    title: "The widget wobbles",
    body: "It wobbles when it spins.",
    labels: (over.labels ?? []).map((name) => ({ name })),
    ...(over.pullRequest === true ? { pull_request: { url: "x" } } : {}),
  },
  comment: {
    body: over.text ?? "@factory please look at this",
    user: { login: over.login ?? "alice", type: over.userType ?? "User" },
    ...(over.association === null
      ? {}
      : { author_association: over.association ?? "MEMBER" }),
  },
  sender: { login: over.login ?? "alice", type: over.senderType ?? "User" },
  repository: { full_name: "acme/widget" },
});

describe("githubDelivery's key is the work", () => {
  const rules = [
    { label: "factory", repo, prompt: "{{title}}" },
  ] as ReadonlyArray<TriggerRule>;

  it("marks a mapped delivery keyedByWork, so a skip for an unregistered repo is reclaimable", () => {
    expect(githubDelivery(payload({}), rules)?.keyedByWork).toBe(true);
  });

  it("does not mark one no rule claims: its skip is the answer, not a claim on the issue", () => {
    expect(
      githubDelivery(payload({ labels: [{ name: "bug" }] }), rules),
    ).not.toHaveProperty("keyedByWork");
  });
});

describe("githubIssueIntake", () => {
  const rules = [
    { label: "factory", repo, prompt: "{{title}}: {{body}}" },
  ] as ReadonlyArray<TriggerRule>;
  const issues = (body: unknown) =>
    githubIssueIntake({ event: "issues", payload: body, rules });
  const comment = (body: unknown, mention?: string) =>
    githubIssueIntake({
      event: "issue_comment",
      payload: body,
      rules,
      mention,
    });

  it("delivers an issue opened or labeled, as a delivery for the issue", () => {
    for (const action of ["opened", "labeled"]) {
      const intake = issues(payload({ action }));
      expect(intake._tag).toBe("delivery");
      if (intake._tag !== "delivery") return;
      expect(intake.delivery.requestId).toBe("github:acme/widget#7:mapped");
      expect(intake.delivery.event.action).toBe("create");
    }
  });

  it("ignores an issue event that starts no work, so an edit cannot claim the issue's key", () => {
    for (const action of ["edited", "closed", "unlabeled", "assigned"]) {
      const intake = issues(payload({ action }));
      expect(intake._tag).toBe("ignored");
    }
  });

  it("refuses a payload it cannot address: a pull request, or no issue at all", () => {
    expect(issues(payload({ pullRequest: true }))._tag).toBe("refused");
    expect(issues({ action: "opened" })._tag).toBe("refused");
  });

  it("reads a comment mentioning @factory as the factory label on the comment's issue", () => {
    const intake = comment(commentPayload({}));
    expect(intake._tag).toBe("delivery");
    if (intake._tag !== "delivery") return;
    expect(intake.delivery.requestId).toBe("github:acme/widget#7:mapped");
    expect(intake.delivery.keyedByWork).toBe(true);
    expect(intake.delivery.event).toEqual({
      source: "github",
      key: "acme/widget#7",
      action: "create",
      title: "The widget wobbles",
      body: "It wobbles when it spins.\n\nComment from alice:\n@factory please look at this",
      labels: ["factory"],
      repo,
    });
  });

  it("makes the label and the mention one delivery: the same key either way", () => {
    const labeled = issues(payload({ action: "labeled" }));
    const mentioned = comment(commentPayload({ labels: ["factory"] }));
    if (labeled._tag !== "delivery" || mentioned._tag !== "delivery") {
      throw new Error("both should deliver");
    }
    expect(mentioned.delivery.requestId).toBe(labeled.delivery.requestId);
    // The issue's own labels are kept, and the handle is not added twice.
    expect(mentioned.delivery.event.labels).toEqual(["factory"]);
  });

  it("finds the mention as a handle and not as part of a longer word or an address", () => {
    const text = (text: string) => comment(commentPayload({ text }))._tag;
    expect(text("hey @Factory, go")).toBe("delivery");
    expect(text("@factory.")).toBe("delivery");
    expect(text("line one\n@factory")).toBe("delivery");
    expect(text("ask someone@factory.example")).toBe("ignored");
    expect(text("@factory-bot please")).toBe("ignored");
    expect(text("@factorybot please")).toBe("ignored");
    expect(text("no mention at all")).toBe("ignored");
  });

  it("takes the handle from the deployment, and the label is the handle without its @", () => {
    const custom = comment(commentPayload({ text: "@robot do it" }), "@robot");
    expect(custom._tag).toBe("delivery");
    if (custom._tag === "delivery") {
      expect(custom.delivery.event.labels).toEqual(["robot"]);
    }
    expect(
      comment(commentPayload({ text: "@factory do it" }), "@robot")._tag,
    ).toBe("ignored");
  });

  it("ignores what cannot ask: a pull request's comment, an edit, a bot", () => {
    expect(comment(commentPayload({ pullRequest: true }))._tag).toBe("ignored");
    expect(comment(commentPayload({ action: "edited" }))._tag).toBe("ignored");
    expect(comment(commentPayload({ action: "deleted" }))._tag).toBe("ignored");
    expect(comment(commentPayload({ userType: "Bot" }))._tag).toBe("ignored");
    expect(comment(commentPayload({ senderType: "Bot" }))._tag).toBe("ignored");
  });

  it("ignores a comment from anyone but an owner, member or collaborator", () => {
    for (const association of ["OWNER", "MEMBER", "COLLABORATOR"]) {
      expect(comment(commentPayload({ association }))._tag).toBe("delivery");
    }
    for (const association of [
      "CONTRIBUTOR",
      "FIRST_TIME_CONTRIBUTOR",
      "FIRST_TIMER",
      "MANNEQUIN",
      "NONE",
    ]) {
      expect(comment(commentPayload({ association }))._tag).toBe("ignored");
    }
    expect(comment(commentPayload({ association: null }))._tag).toBe("ignored");
  });

  it("reads a handle configured without its @ as the handle with one, never the bare word", () => {
    const bare = (text: string) =>
      comment(commentPayload({ text }), "factory")._tag;
    expect(bare("the factory build is red")).toBe("ignored");
    expect(bare("@factory please look")).toBe("delivery");
    expect(
      comment(commentPayload({ text: "@robot do it" }), "robot")._tag,
    ).toBe("delivery");
    expect(normalizeGitHubMention(" factory ")).toBe("@factory");
    expect(normalizeGitHubMention("@@factory")).toBe("@factory");
    expect(normalizeGitHubMention("@")).toBe("@factory");
  });

  it("refuses a mention on a payload that names no repository", () => {
    const body = commentPayload({});
    expect(comment({ ...body, repository: {} })._tag).toBe("refused");
  });
});

describe("handleGitHubIssueWebhook", () => {
  const SECRET = "lob-259-github-secret";
  const rules = [
    { label: "factory", repo, prompt: "{{title}}" },
  ] as ReadonlyArray<TriggerRule>;
  const sign = (raw: string) =>
    `sha256=${createHmac("sha256", SECRET).update(raw).digest("hex")}`;

  /** The seam, recording what the handler hands it. */
  const run = (
    over: {
      readonly body?: unknown;
      readonly raw?: string;
      readonly secret?: string | undefined;
      readonly signature?: (raw: string) => string | undefined;
      readonly event?: "issues" | "issue_comment";
      readonly outcome?: TriggerOutcome;
      readonly fail?: TriggerError;
    } = {},
  ) => {
    const delivered: Array<TriggerDelivery> = [];
    const raw = over.raw ?? JSON.stringify(over.body ?? payload({}));
    const seam = Layer.succeed(
      TriggerService,
      TriggerService.of({
        deliver: (delivery) =>
          Effect.suspend(() => {
            delivered.push(delivery);
            return over.fail === undefined
              ? Effect.succeed(
                  over.outcome ?? {
                    status: "processed",
                    replayed: false,
                    sessionId: sessionId,
                    reason: 'rule "factory" mapped it to acme/widget',
                  },
                )
              : Effect.fail(over.fail);
          }),
      }),
    );
    const answer = Effect.runPromise(
      handleGitHubIssueWebhook({
        secret: "secret" in over ? over.secret : SECRET,
        raw,
        signature: (over.signature ?? sign)(raw),
        event: over.event ?? "issues",
        rules,
      }).pipe(Effect.provide(seam)),
    );
    return { delivered, answer };
  };

  it("hands a signed factory label to the seam once, and answers what the seam did", async () => {
    const { delivered, answer } = run();
    const answered = await answer;
    expect(answered.status).toBe(200);
    expect(answered.body).toMatchObject({
      ok: true,
      status: "processed",
      replayed: false,
      sessionId,
    });
    expect(delivered.map((d) => d.requestId)).toEqual([
      "github:acme/widget#7:mapped",
    ]);
  });

  it("answers a redelivery with the seam's replay, and a replay still in flight with 503", async () => {
    const replay = await run({
      outcome: { status: "processed", replayed: true },
    }).answer;
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ replayed: true });
    const inFlight = await run({
      outcome: { status: "received", replayed: true },
    }).answer;
    expect(inFlight.status).toBe(503);
    expect(inFlight.body).toMatchObject({ code: "in-progress" });
  });

  it("is 503 naming GITHUB_WEBHOOK_SECRET when no secret is set, and hands the seam nothing", async () => {
    // Signed with the empty key, which is what an unset secret degrades to: without the 503 branch
    // this would verify.
    for (const secret of [undefined, ""]) {
      const { delivered, answer } = run({
        secret,
        signature: (raw) =>
          `sha256=${createHmac("sha256", "").update(raw).digest("hex")}`,
      });
      const answered = await answer;
      expect(answered.status).toBe(503);
      expect(JSON.stringify(answered.body)).toContain("GITHUB_WEBHOOK_SECRET");
      expect(delivered).toEqual([]);
    }
  });

  it("is 401 for a missing or wrong signature, and hands the seam nothing", async () => {
    for (const signature of [
      () => undefined,
      () => "sha256=00",
      (raw: string) => sign(`${raw} `),
    ]) {
      const { delivered, answer } = run({ signature });
      expect((await answer).status).toBe(401);
      expect(delivered).toEqual([]);
    }
  });

  it("is 400 for a body that is not a JSON object, and for an issue it cannot address", async () => {
    const notJson = run({ raw: "{" });
    expect((await notJson.answer).status).toBe(400);
    const list = run({ raw: "[]" });
    expect((await list.answer).status).toBe(400);
    const pull = run({ body: payload({ pullRequest: true }) });
    const refused = await pull.answer;
    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject({ code: "bad-payload" });
    expect([
      ...notJson.delivered,
      ...list.delivered,
      ...pull.delivered,
    ]).toEqual([]);
  });

  it("answers 202 and ignores an event that asks for nothing, handing the seam nothing", async () => {
    const edited = run({ body: payload({ action: "edited" }) });
    const answered = await edited.answer;
    expect(answered.status).toBe(202);
    expect(answered.body).toMatchObject({ ok: true });
    expect(edited.delivered).toEqual([]);
    const chatter = run({
      event: "issue_comment",
      body: commentPayload({ text: "just a comment" }),
    });
    expect((await chatter.answer).status).toBe(202);
    expect(chatter.delivered).toEqual([]);
  });

  it("hands a comment mentioning the factory to the seam as the issue's delivery", async () => {
    const { delivered, answer } = run({
      event: "issue_comment",
      body: commentPayload({}),
    });
    expect((await answer).status).toBe(200);
    expect(delivered.map((d) => d.requestId)).toEqual([
      "github:acme/widget#7:mapped",
    ]);
  });

  it("answers a skip with its reason, and a failed delivery with 500 and its code", async () => {
    const skipped = await run({
      outcome: {
        status: "skipped",
        replayed: false,
        reason: "repo acme/widget is not registered",
      },
    }).answer;
    expect(skipped.status).toBe(200);
    expect(skipped.body).toMatchObject({
      status: "skipped",
      reason: "repo acme/widget is not registered",
    });
    const failed = await run({
      fail: new TriggerError({ code: "write-back", message: "no credential" }),
    }).answer;
    expect(failed.status).toBe(500);
    expect(failed.body).toMatchObject({ ok: false, code: "write-back" });
  });
});
