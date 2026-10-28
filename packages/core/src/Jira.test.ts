/**
 * The Jira adapter (LOB-189): the extractor's reading of a real-shaped payload, the delivery id it
 * derives, and the one comment call the write-back makes.
 *
 * The seam's own behaviour — dedupe, the action filter, the label mapping, the claim release — is
 * `TriggerService.test.ts`'s, and it is not re-proved here: an adapter that normalized a payload
 * wrong is what this file is for. The end-to-end half (create, replay, one comment on the issue)
 * is `.pi/skills/verify-api/jira.ts` against the real session layer and a loopback Jira.
 */
import { Effect, Layer, Redacted, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { SessionId } from "@repo/domain/Session";
import {
  JIRA_SIGNATURE_HEADER,
  verifyJiraSignature,
  jiraComment,
  jiraConfigFromEnv,
  jiraDelivery,
  jiraEvent,
  JiraWriteBack,
} from "./Jira";
import { TriggerWriteBack } from "./TriggerService";

/** Jira Cloud's `jira:issue_created` payload, shaped as the docs describe it. */
const created = (
  over: Record<string, unknown> = {},
): Record<string, unknown> => ({
  timestamp: 1_729_000_000_000,
  webhookEvent: "jira:issue_created",
  issue_event_type_name: "issue_created",
  issue: {
    id: "10001",
    key: "FAC-1",
    fields: {
      summary: "The widget wobbles",
      description: "It wobbles when it spins.",
      labels: ["factory", "bug"],
    },
  },
  ...over,
});

const withFields = (fields: Record<string, unknown>): Record<string, unknown> =>
  created({
    issue: { id: "10001", key: "FAC-1", fields },
  });

/**
 * The comment API, both directions: `GET` answers the comments the issue already has, `POST` creates
 * one. `status` is what the POST answers, so a case can drive the refusal; the GET always answers
 * `existing` as the issue's page.
 */
const makeFakeHttp = (
  status: number,
  existing: ReadonlyArray<unknown> = [],
) => {
  const requests: Array<{
    readonly method: string;
    readonly path: string;
    readonly authorization: string | undefined;
    readonly accept: string | undefined;
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
          body: reqBody,
        });
        const answer =
          request.method === "GET"
            ? { status: 200, body: { comments: existing } }
            : { status, body: { id: "20001" } };
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
  return { requests, client };
};

const config = () => ({
  baseUrl: "http://127.0.0.1:9412",
  email: "factory@example.com",
  apiToken: Redacted.make("jira-token"),
});

const writeBack = (
  status: number,
  options: {
    readonly existing?: ReadonlyArray<unknown>;
    readonly sessionUrlBase?: string;
  } = {},
) => {
  const fake = makeFakeHttp(status, options.existing ?? []);
  const layer = JiraWriteBack({
    ...config(),
    ...(options.sessionUrlBase === undefined
      ? {}
      : { sessionUrlBase: options.sessionUrlBase }),
  }).pipe(Layer.provide(fake.client));
  return { fake, layer };
};

describe("jiraEvent", () => {
  it("normalizes a create delivery into the seam's event", () => {
    expect(jiraEvent(created())).toEqual({
      source: "jira",
      key: "FAC-1",
      action: "create",
      title: "The widget wobbles",
      body: "It wobbles when it spins.",
      labels: ["factory", "bug"],
    });
  });

  it("keeps Jira's own name for an event that is not a create, so the seam refuses it by name", () => {
    const event = jiraEvent(created({ webhookEvent: "jira:issue_updated" }));
    expect(event?.action).toBe("jira:issue_updated");
    expect(event?.key).toBe("FAC-1");
  });

  it("flattens an Atlassian Document Format description into text", () => {
    const event = jiraEvent(
      withFields({
        summary: "ADF",
        description: {
          type: "doc",
          version: 1,
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "First line" }],
            },
            {
              type: "paragraph",
              content: [
                { type: "text", text: "Second " },
                { type: "text", text: "line" },
              ],
            },
          ],
        },
        labels: ["factory"],
      }),
    );
    expect(event?.body).toBe("First line\nSecond line");
  });

  it("survives a payload with no fields at all", () => {
    const event = jiraEvent({
      webhookEvent: "jira:issue_created",
      issue: { key: "FAC-2" },
    });
    expect(event).toEqual({
      source: "jira",
      key: "FAC-2",
      action: "create",
      title: "",
      body: "",
      labels: [],
    });
  });

  it("answers undefined when the payload carries no issue to address", () => {
    expect(jiraEvent({ webhookEvent: "jira:issue_created" })).toBeUndefined();
    expect(jiraEvent({ issue: { fields: {} } })).toBeUndefined();
    expect(jiraEvent("not a payload")).toBeUndefined();
  });
});

describe("jiraDelivery", () => {
  it("derives the delivery id from the event, the issue and Jira's timestamp", () => {
    const delivery = jiraDelivery(created());
    expect(delivery?.requestId).toBe("jira:create:FAC-1:1729000000000");
    expect(delivery?.event.key).toBe("FAC-1");
  });

  it("gives the same body the same id, so a replay is one delivery", () => {
    const first = jiraDelivery(created());
    const replay = jiraDelivery(created());
    expect(first?.requestId).toBe(replay?.requestId);
  });

  it("gives a re-stamped body a different id — the gap a delivery header would close", () => {
    const first = jiraDelivery(created());
    const restamped = jiraDelivery(created({ timestamp: 1_729_000_000_001 }));
    expect(restamped?.requestId).not.toBe(first?.requestId);
  });

  it("records an unstamped payload under a stable name rather than failing", () => {
    const payload = created();
    delete payload["timestamp"];
    expect(jiraDelivery(payload)?.requestId).toBe(
      "jira:create:FAC-1:no-timestamp",
    );
  });
});

describe("jiraConfigFromEnv", () => {
  it("needs all three of base, email and token", () => {
    const complete = {
      baseUrl: "https://acme.atlassian.net/",
      email: "factory@example.com",
      apiToken: "token",
      sessionUrlBase: undefined,
    };
    const configured = jiraConfigFromEnv(complete);
    expect(configured?.baseUrl).toBe("https://acme.atlassian.net");
    expect(Redacted.value(configured?.apiToken ?? Redacted.make(""))).toBe(
      "token",
    );
    for (const missing of ["baseUrl", "email", "apiToken"] as const) {
      expect(
        jiraConfigFromEnv({ ...complete, [missing]: undefined }),
      ).toBeUndefined();
      expect(
        jiraConfigFromEnv({ ...complete, [missing]: "  " }),
      ).toBeUndefined();
    }
  });
});

describe("JiraWriteBack", () => {
  const sessionId = "01J8Z000000000000000000000" as SessionId;

  const write = (layer: Layer.Layer<TriggerWriteBack>) =>
    Effect.runPromiseExit(
      Effect.gen(function* () {
        const port = yield* TriggerWriteBack;
        yield* port.write({
          event: {
            source: "jira",
            key: "FAC-1",
            action: "create",
            title: "",
            body: "",
            labels: [],
          },
          sessionId,
        });
      }).pipe(Effect.provide(layer)),
    );

  it("reads the issue's comments, then posts one, authenticated as the configured account", async () => {
    const { fake, layer } = writeBack(201);
    expect((await write(layer))._tag).toBe("Success");
    expect(fake.requests.map((request) => request.method)).toEqual([
      "GET",
      "POST",
    ]);
    expect(fake.requests[0]?.path).toBe("/rest/api/3/issue/FAC-1/comment");
    const post = fake.requests[1];
    expect(post?.path).toBe("/rest/api/3/issue/FAC-1/comment");
    expect(post?.authorization).toBe(
      `Basic ${Buffer.from("factory@example.com:jira-token").toString("base64")}`,
    );
    expect(post?.accept).toBe("application/json");
    expect(post?.body).toEqual({ body: jiraComment(config(), sessionId) });
  });

  it("posts nothing when the issue already carries this session's comment", async () => {
    // The retry shape: a previous attempt's comment landed and its acknowledgement did not, so the
    // seam gave the claim back and the delivery runs again.
    const { fake, layer } = writeBack(201, {
      existing: [
        {
          id: "19999",
          body: {
            type: "doc",
            version: 1,
            content: [
              {
                type: "paragraph",
                content: [
                  {
                    type: "text",
                    text: `Factory started session ${sessionId}.`,
                  },
                ],
              },
            ],
          },
        },
      ],
    });
    expect((await write(layer))._tag).toBe("Success");
    expect(fake.requests.map((request) => request.method)).toEqual(["GET"]);
  });

  it("still posts when the issue's other comments name other sessions", async () => {
    const { fake, layer } = writeBack(201, {
      existing: [{ id: "19999", body: "Factory started session 01J8ZOTHER." }],
    });
    expect((await write(layer))._tag).toBe("Success");
    expect(fake.requests.map((request) => request.method)).toEqual([
      "GET",
      "POST",
    ]);
  });

  it("names the session in the comment, and links to it when the deployment knows where", () => {
    const withoutLink = JSON.stringify(jiraComment(config(), sessionId));
    expect(withoutLink).toContain(sessionId);
    expect(withoutLink).not.toContain("http://localhost:3000");
    const withLink = JSON.stringify(
      jiraComment(
        { ...config(), sessionUrlBase: "http://localhost:3000/sessions/" },
        sessionId,
      ),
    );
    expect(withLink).toContain(`http://localhost:3000/sessions/${sessionId}`);
  });

  it("fails the delivery as a write-back when Jira refuses the comment", async () => {
    const { layer } = writeBack(403);
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const port = yield* TriggerWriteBack;
        return yield* Effect.flip(
          port.write({
            event: {
              source: "jira",
              key: "FAC-1",
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
    expect(error.message).toContain("403");
  });
});

describe("verifyJiraSignature", () => {
  const secret = "lob-259-jira-secret";
  const raw = JSON.stringify(created());
  const digest = (body: string, key = secret) =>
    createHmac("sha256", key).update(body).digest("hex");
  const verify = (signature: string | undefined, body = raw) =>
    verifyJiraSignature({ raw: body, signature, secret });

  it("reads Jira's X-Hub-Signature, whose value is sha256= and the body's hex HMAC", () => {
    expect(JIRA_SIGNATURE_HEADER).toBe("x-hub-signature");
    expect(verify(`sha256=${digest(raw)}`)).toEqual({ ok: true });
  });

  it("says unsigned for no header, and wrong for a digest of another body, key or shape", () => {
    expect(verify(undefined)).toEqual({
      ok: false,
      refusal: "missing-signature",
    });
    expect(verify("")).toEqual({ ok: false, refusal: "missing-signature" });
    const wrong = { ok: false, refusal: "bad-signature" };
    expect(verify(`sha256=${digest(`${raw} `)}`)).toEqual(wrong);
    expect(verify(`sha256=${digest(raw, "another")}`)).toEqual(wrong);
    // The digest alone is GitHub-without-prefix, not WebSub's: refused, not accepted by accident.
    expect(verify(digest(raw))).toEqual(wrong);
    expect(verify(`sha1=${digest(raw)}`)).toEqual(wrong);
    expect(verify("sha256=not-hex")).toEqual(wrong);
    expect(verify("sha256=")).toEqual(wrong);
  });
});
