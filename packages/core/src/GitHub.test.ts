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
import { Effect, Layer, Option, Redacted } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import type { RepoSlug, SessionId } from "@repo/domain/Session";
import type { TriggerRule } from "@repo/domain/Trigger";
import { CredentialProvider, staticTokenProvider } from "./credentials";
import {
  githubComment,
  githubDelivery,
  githubEvent,
  githubDeliveryFor,
  githubRequestId,
  GitHubWriteBack,
} from "./GitHub";
import { TriggerWriteBack } from "./TriggerService";

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
