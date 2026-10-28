/**
 * How several trackers' write-backs become one (LOB-259): `TriggerWriteBackBySource` hands a
 * delivery's event to the client of the system it came from and to no other, and
 * `SessionWriteBacksAll` makes the PR step's report reach every configured tracker instead of the
 * last one provided. Both are layers over fakes: the question is who is called, not what they post.
 */
import { Effect, Exit, Layer } from "effect";
import { describe, expect, it } from "vitest";
import type { SessionId } from "@repo/domain/Session";
import type { TriggerEvent, TriggerSource } from "@repo/domain/Trigger";
import {
  SessionWriteBack,
  SessionWriteBacksAll,
  type PullRequestStepExit,
} from "./SessionWriteBack";
import {
  NoWriteBack,
  TriggerWriteBack,
  TriggerWriteBackBySource,
} from "./TriggerService";

const sessionId = "01J8Z000000000000000000000" as SessionId;

const event = (source: TriggerSource): TriggerEvent => ({
  source,
  key: `${source}-key`,
  action: "create",
  title: "",
  body: "",
  labels: [],
});

/** A write-back that records the keys it was asked to write for. */
const recording = (calls: Array<string>, name: string) =>
  Layer.succeed(
    TriggerWriteBack,
    TriggerWriteBack.of({
      write: (input) =>
        Effect.sync(() => {
          calls.push(`${name}:${input.event.key}`);
        }),
    }),
  );

const writeFor = (
  layer: Layer.Layer<TriggerWriteBack>,
  source: TriggerSource,
) =>
  Effect.runPromiseExit(
    Effect.gen(function* () {
      const port = yield* TriggerWriteBack;
      yield* port.write({ event: event(source), sessionId });
    }).pipe(Effect.provide(layer)),
  );

describe("TriggerWriteBackBySource", () => {
  it("calls the client of the event's own source and no other", async () => {
    const calls: Array<string> = [];
    const layer = TriggerWriteBackBySource({
      jira: recording(calls, "jira"),
      github: recording(calls, "github"),
      slack: recording(calls, "slack"),
    });
    for (const source of ["github", "jira", "slack", "github"] as const) {
      expect(Exit.isSuccess(await writeFor(layer, source))).toBe(true);
    }
    expect(calls).toEqual([
      "github:github-key",
      "jira:jira-key",
      "slack:slack-key",
      "github:github-key",
    ]);
  });

  it("writes nothing for a source with no client, and does not fail the delivery", async () => {
    const calls: Array<string> = [];
    const layer = TriggerWriteBackBySource({ jira: recording(calls, "jira") });
    for (const source of ["generic", "sentry", "linear", "github"] as const) {
      expect(Exit.isSuccess(await writeFor(layer, source))).toBe(true);
    }
    expect(calls).toEqual([]);
  });

  it("carries a client's failure to the delivery, so the seam gives the claim back", async () => {
    const failing = Layer.succeed(
      TriggerWriteBack,
      TriggerWriteBack.of({
        write: () =>
          Effect.die("a client that breaks its contract is a defect"),
      }),
    );
    const layer = TriggerWriteBackBySource({
      github: failing,
      jira: NoWriteBack,
    });
    expect((await writeFor(layer, "github"))._tag).toBe("Failure");
    expect(Exit.isSuccess(await writeFor(layer, "jira"))).toBe(true);
  });
});

describe("SessionWriteBacksAll", () => {
  const opened: PullRequestStepExit = Exit.succeed({
    outcome: "opened" as const,
    number: 7,
    url: "https://github.com/acme/widget/pull/7",
  });

  /** A tracker whose write-back records that it was reported to. */
  const tracker = (reports: Array<string>, name: string) =>
    Layer.effect(
      SessionWriteBack,
      Effect.succeed({
        pullRequest: () =>
          Effect.sync(() => {
            reports.push(name);
          }),
      }),
    );

  const report = (layer: Layer.Layer<never>) =>
    Effect.runPromiseExit(
      Effect.gen(function* () {
        const port = yield* SessionWriteBack;
        yield* port.pullRequest({
          sessionId,
          result: opened,
          evidence: Effect.succeed([]),
        });
      }).pipe(Effect.provide(layer)),
    );

  it("reports the PR step to every tracker, not only the last one provided", async () => {
    const reports: Array<string> = [];
    const layer = SessionWriteBacksAll([
      tracker(reports, "linear"),
      Layer.empty,
      tracker(reports, "slack"),
    ]);
    expect(Exit.isSuccess(await report(layer))).toBe(true);
    expect([...reports].sort()).toEqual(["linear", "slack"]);
  });

  it("with no tracker configured reports to nobody, as the default does", async () => {
    expect(Exit.isSuccess(await report(SessionWriteBacksAll([])))).toBe(true);
    expect(
      Exit.isSuccess(await report(SessionWriteBacksAll([Layer.empty]))),
    ).toBe(true);
  });
});
