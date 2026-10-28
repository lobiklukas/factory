// The documented metric set reaching a local collector (LOB-69), driven with the real Effect RPC
// client against an API whose OTLP metrics exporter points at ./otlp-receiver.ts.
//
//   bun metrics.ts      (via ./metrics.sh, which boots the receiver and the API this drives)
//
//   drive     a session created and run to idle over RPC, then an oversized message refused
//   wire      the receiver was posted OTLP JSON at /v1/metrics, under `service.name` factory-api
//   set       a single export carries every metric in docs/metrics.md with its documented unit:
//             factory.session.creates{origin=create} >= 1, factory.session.active >= 1,
//             factory.run.duration with a recorded run, factory.refusals{reason=message_too_long} >= 1
//
// The oracle is the receiver's record, never motel: motel ingests logs and traces only.
//
// Env: API_URL, OTLP_RECEIVER_URL, EVIDENCE_DIR.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { SessionRpc } from "@repo/domain/Rpc";
import { Effect, Exit, Option } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { RpcClient } from "effect/rpc";
import { makeChecker, protocolFor, waitUntil } from "./harness.ts";
import type { CheckRecord } from "./harness.ts";

const API_URL = process.env["API_URL"] ?? "http://localhost:9540";
const RECEIVER_URL =
  process.env["OTLP_RECEIVER_URL"] ?? "http://127.0.0.1:9541";
const EVIDENCE_DIR =
  process.env["EVIDENCE_DIR"] ?? ".verify/evidence/latest/api";
/** `MAX_MESSAGE_CHARS` in packages/core/src/SessionService.ts, plus one. */
const OVERSIZED = "x".repeat(100_001);

await mkdir(EVIDENCE_DIR, { recursive: true });

type KeyValue = {
  readonly key: string;
  readonly value: { readonly stringValue?: string };
};
type DataPoint = {
  readonly attributes: readonly KeyValue[];
  readonly asDouble?: number;
  readonly asInt?: number;
  readonly count?: number;
  readonly sum?: number;
};
type OtlpMetric = {
  readonly name: string;
  readonly unit: string;
  readonly sum?: { readonly dataPoints: readonly DataPoint[] };
  readonly gauge?: { readonly dataPoints: readonly DataPoint[] };
  readonly histogram?: { readonly dataPoints: readonly DataPoint[] };
};
type MetricsBody = {
  readonly resourceMetrics?: readonly {
    readonly resource: { readonly attributes: readonly KeyValue[] };
    readonly scopeMetrics: readonly {
      readonly metrics: readonly OtlpMetric[];
    }[];
  }[];
};
type Received = {
  readonly method: string;
  readonly path: string;
  readonly contentType: string | null;
  readonly body: MetricsBody;
};

const observed: {
  apiUrl: string;
  receiverUrl: string;
  session: Record<string, unknown>;
  exports: number;
  matched: Record<string, unknown>;
  checks: Record<string, CheckRecord>;
} = {
  apiUrl: API_URL,
  receiverUrl: RECEIVER_URL,
  session: {},
  exports: 0,
  matched: {},
  checks: {},
};
const assert = makeChecker(observed);

const attribute = (attributes: readonly KeyValue[], key: string) =>
  attributes.find((entry) => entry.key === key)?.value.stringValue;

const metricsOf = (body: MetricsBody): readonly OtlpMetric[] =>
  (body.resourceMetrics ?? []).flatMap((resource) =>
    resource.scopeMetrics.flatMap((scope) => scope.metrics),
  );

const pointsOf = (metric: OtlpMetric | undefined): readonly DataPoint[] =>
  metric === undefined
    ? []
    : ((metric.sum ?? metric.gauge ?? metric.histogram)?.dataPoints ?? []);

const numberOf = (point: DataPoint | undefined): number =>
  point?.asDouble ?? point?.asInt ?? 0;

/** What one export says about the documented set: each metric's unit and the value a check needs. */
const readSet = (body: MetricsBody) => {
  const metrics = metricsOf(body);
  const named = (name: string) =>
    metrics.find((metric) => metric.name === name);
  const creates = named("factory.session.creates");
  const active = named("factory.session.active");
  const duration = named("factory.run.duration");
  const refusals = named("factory.refusals");
  return {
    serviceName: attribute(
      body.resourceMetrics?.[0]?.resource.attributes ?? [],
      "service.name",
    ),
    creates: {
      unit: creates?.unit,
      create: numberOf(
        pointsOf(creates).find(
          (point) => attribute(point.attributes, "origin") === "create",
        ),
      ),
    },
    active: { unit: active?.unit, value: numberOf(pointsOf(active)[0]) },
    duration: {
      unit: duration?.unit,
      count: pointsOf(duration)[0]?.count ?? 0,
      sum: pointsOf(duration)[0]?.sum ?? 0,
    },
    refusals: {
      unit: refusals?.unit,
      messageTooLong: numberOf(
        pointsOf(refusals).find(
          (point) =>
            attribute(point.attributes, "reason") === "message_too_long",
        ),
      ),
    },
  };
};
type SetReading = ReturnType<typeof readSet>;

const complete = (set: SetReading) =>
  set.creates.create >= 1 &&
  set.active.value >= 1 &&
  set.duration.count >= 1 &&
  set.refusals.messageTooLong >= 1;

const receivedSoFar = HttpClient.get(`${RECEIVER_URL}/received`).pipe(
  Effect.flatMap((response) => response.json),
  Effect.map((body) => body as readonly Received[]),
  Effect.orDie,
  Effect.provide(FetchHttpClient.layer),
);

await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const client = yield* RpcClient.make(SessionRpc);
      const created = yield* client.createSession({ title: "metrics probe" });
      yield* client.sendMessage({
        sessionId: created.id,
        content: "a run to time",
      });
      yield* waitUntil(
        client
          .getSession({ sessionId: created.id })
          .pipe(
            Effect.map(
              (snapshot) =>
                !snapshot.live.busy &&
                snapshot.entries.at(-1)?.kind === "assistant",
            ),
          ),
        "the run to settle",
      );
      const refused = yield* Effect.exit(
        client.sendMessage({ sessionId: created.id, content: OVERSIZED }),
      );
      const failure = Option.getOrUndefined(Exit.findErrorOption(refused));
      const refusedCode = Exit.isSuccess(refused)
        ? "ok"
        : failure?._tag === "SessionError"
          ? failure.code
          : String(failure?._tag);
      observed.session = { id: created.id, refusedCode };
      assert(
        "drive: the oversized message is refused",
        refusedCode === "invalid_input",
        refusedCode,
      );

      // The receiver's record is the oracle: wait for one export that carries the whole set.
      const waited = yield* Effect.exit(
        waitUntil(
          receivedSoFar.pipe(
            Effect.map((all) => {
              observed.exports = all.length;
              const found = [...all]
                .reverse()
                .find((record) => complete(readSet(record.body)));
              return found === undefined ? false : found;
            }),
          ),
          "an export carrying the documented set",
        ),
      );
      if (
        !assert(
          "set: an export carrying the whole set arrived",
          Exit.isSuccess(waited),
          `${observed.exports} exports received`,
        ) ||
        Exit.isFailure(waited)
      ) {
        return;
      }
      const match = waited.value;
      const set = readSet(match.body);
      observed.matched = { request: { ...match, body: undefined }, set };

      assert(
        "wire: POST /v1/metrics",
        match.method === "POST" && match.path === "/v1/metrics",
        `${match.method} ${match.path}`,
      );
      assert(
        "wire: OTLP JSON",
        (match.contentType ?? "").includes("application/json"),
        String(match.contentType),
      );
      assert(
        "wire: service.name factory-api",
        set.serviceName === "factory-api",
        String(set.serviceName),
      );
      assert(
        "set: factory.session.creates{origin=create} in {session}",
        set.creates.create >= 1 && set.creates.unit === "{session}",
        `${set.creates.create} ${set.creates.unit}`,
      );
      assert(
        "set: factory.session.active in {session}",
        set.active.value >= 1 && set.active.unit === "{session}",
        `${set.active.value} ${set.active.unit}`,
      );
      assert(
        "set: factory.run.duration recorded a run, in s",
        set.duration.count >= 1 &&
          set.duration.sum > 0 &&
          set.duration.sum < 60 &&
          set.duration.unit === "s",
        `count ${set.duration.count}, sum ${set.duration.sum} ${set.duration.unit}`,
      );
      assert(
        "set: factory.refusals{reason=message_too_long} in {refusal}",
        set.refusals.messageTooLong >= 1 && set.refusals.unit === "{refusal}",
        `${set.refusals.messageTooLong} ${set.refusals.unit}`,
      );
    }),
  ).pipe(Effect.provide(protocolFor(API_URL))),
);

await writeFile(
  path.join(EVIDENCE_DIR, "metrics.json"),
  `${JSON.stringify(observed, null, 2)}\n`,
);
const failed = Object.values(observed.checks).filter((check) => !check.passed);
console.log(
  `${Object.keys(observed.checks).length - failed.length}/${Object.keys(observed.checks).length} checks passed`,
);
process.exit(failed.length === 0 ? 0 : 1);
