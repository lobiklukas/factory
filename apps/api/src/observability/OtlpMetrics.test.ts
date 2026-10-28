/**
 * The OTLP metrics exporter against a local collector (LOB-69): a session created through the real
 * session service is a `factory.session.creates` point in what an OTLP/HTTP receiver is sent.
 *
 * The collector is an in-process OTLP/HTTP receiver — `node:http` on loopback, answering `200 {}` to
 * `POST /v1/metrics` and keeping every body — which `docs/testing-third-parties.md`'s OTLP row names,
 * with what it cannot prove. motel is not involved: it has no metrics route.
 *
 * The exporter is the app's own `OtlpMetricsLive`, configured the way a deployment configures it
 * (the OpenTelemetry variables, through a `ConfigProvider`), and the session service is the real one
 * on Postgres, in a database this file creates on the server `DATABASE_URL` names and drops in
 * `afterAll`, as `../Rpc/Session.test.ts` does.
 */
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { BunServices } from "@effect/platform-bun";
import { SessionService, SessionServiceLive } from "@repo/core";
import { createFauxModelAccess } from "@repo/harness";
import {
  DatabaseConfig,
  DatabaseLive,
  PostgresLive,
} from "@repo/storage-postgres";
import {
  ConfigProvider,
  Effect,
  Exit,
  Layer,
  ManagedRuntime,
  Redacted,
} from "effect";
import { FetchHttpClient } from "effect/http";
import { SqlClient } from "effect/sql/SqlClient";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { OtlpMetricsLive } from "./OtlpMetrics";

const sessionRoot = mkdtempSync(join(tmpdir(), "factory-api-metrics-"));
const run = randomBytes(4).toString("hex");

const admin = ManagedRuntime.make(PostgresLive);
const scratchName = `factory_api_metrics_${run}`;
{
  const configured = new URL(
    Redacted.value((await admin.runPromise(DatabaseConfig)).url),
  );
  await admin.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      yield* sql`CREATE DATABASE ${sql(scratchName)}`;
    }),
  );
  configured.pathname = `/${scratchName}`;
  // oxlint-disable-next-line effecttsgo/process-env -- a test harness sets up its own process.
  process.env["DATABASE_URL"] = configured.toString();
}

/** One request the receiver was sent, its body parsed as the JSON it claims to be. */
type Received = {
  readonly method: string;
  readonly path: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: unknown;
};
const received: Received[] = [];

const receiver = createServer((request, response) => {
  const chunks: Buffer[] = [];
  request.on("data", (chunk: Buffer) => chunks.push(chunk));
  request.on("end", () => {
    const text = Buffer.concat(chunks).toString("utf8");
    received.push({
      method: request.method ?? "",
      path: request.url ?? "",
      headers: request.headers,
      body: text.length === 0 ? null : JSON.parse(text),
    });
    // OTLP/HTTP's success: 200 with an (empty) `ExportMetricsServiceResponse`.
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
});
// oxlint-disable-next-line effecttsgo/new-promise -- a node:http server's `listen` takes a callback.
await new Promise<void>((resolve) =>
  receiver.listen(0, "127.0.0.1", () => resolve()),
);
const endpoint = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/v1/metrics`;

afterAll(async () => {
  // oxlint-disable-next-line effecttsgo/new-promise -- a node:http server's `close` takes a callback.
  await new Promise<void>((resolve) => receiver.close(() => resolve()));
  await admin.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      yield* sql`DROP DATABASE IF EXISTS ${sql(scratchName)} WITH (FORCE)`;
    }),
  );
  await admin.dispose();
  rmSync(sessionRoot, { recursive: true, force: true });
});

beforeEach(() => {
  received.length = 0;
});

/** The exporter as a deployment configures it: from the environment, here a fixed one. */
const exporterWith = (env: Record<string, string>) =>
  OtlpMetricsLive.pipe(
    Layer.provide(
      Layer.succeed(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromEnv({ env }),
      ),
    ),
  );

const sessions = SessionServiceLive({
  model: createFauxModelAccess().access,
  sessionRoot,
}).pipe(Layer.provideMerge(Layer.mergeAll(DatabaseLive, BunServices.layer)));

// The OTLP JSON shapes this file reads: only the fields the assertions need.
type KeyValue = {
  readonly key: string;
  readonly value: { readonly stringValue?: string };
};
type DataPoint = {
  readonly attributes: readonly KeyValue[];
  readonly asDouble?: number;
  readonly asInt?: number;
};
type OtlpMetric = {
  readonly name: string;
  readonly unit: string;
  readonly sum?: {
    readonly isMonotonic: boolean;
    readonly dataPoints: readonly DataPoint[];
  };
  readonly gauge?: { readonly dataPoints: readonly DataPoint[] };
};
type MetricsBody = {
  readonly resourceMetrics: readonly {
    readonly resource: { readonly attributes: readonly KeyValue[] };
    readonly scopeMetrics: readonly {
      readonly metrics: readonly OtlpMetric[];
    }[];
  }[];
};

const attribute = (attributes: readonly KeyValue[], key: string) =>
  attributes.find((entry) => entry.key === key)?.value.stringValue;

/** Every metric named `name` in a body, across its resources and scopes. */
const metricsNamed = (body: MetricsBody, name: string): OtlpMetric[] =>
  body.resourceMetrics.flatMap((resource) =>
    resource.scopeMetrics.flatMap((scope) =>
      scope.metrics.filter((metric) => metric.name === name),
    ),
  );

/** The `factory.session.creates` point for `origin=create` in a body, if there is one. */
const createsPoint = (body: MetricsBody) =>
  metricsNamed(body, "factory.session.creates")
    .flatMap((metric) => metric.sum?.dataPoints ?? [])
    .find((point) => attribute(point.attributes, "origin") === "create");

const pointValue = (point: DataPoint | undefined) =>
  point?.asDouble ?? point?.asInt;

/** Poll `check` for at most `withinMs`. */
const waitFor = (check: () => boolean, label: string, withinMs: number) =>
  Effect.runPromise(
    Effect.gen(function* () {
      for (let waited = 0; waited < withinMs; waited += 50) {
        if (check()) return;
        yield* Effect.sleep(50);
      }
      return yield* Effect.die(new Error(`timed out waiting for ${label}`));
    }),
  );

describe("OtlpMetricsLive against an in-process OTLP/HTTP receiver", () => {
  /**
   * Mutation: drop `OtlpMetricsLive` from the layer, or return `Layer.empty` with the endpoint set —
   * the receiver is sent nothing.
   * Mutation: drop `countSessionCreate("create")` from `SessionService.create` — the body has no
   * `factory.session.creates` point.
   * Mutation: post to the endpoint's origin rather than the URL as given — the path is not
   * `/v1/metrics`.
   * Mutation: drop the `unit` attribute from the definition — the metric's unit is `1`.
   */
  it("exports factory.session.creates for a created session, with its unit and the service name", async () => {
    const runtime = ManagedRuntime.make(
      Layer.mergeAll(
        sessions,
        exporterWith({
          OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: endpoint,
          // An hour: the only export in this case is the one the shutdown makes.
          OTEL_METRIC_EXPORT_INTERVAL: "3600000",
          OTEL_SERVICE_NAME: "factory-api-metrics-test",
        }),
      ),
    );
    let created: string | undefined;
    try {
      created = await runtime.runPromise(
        Effect.flatMap(SessionService, (service) =>
          service.create({ title: "counted by a collector" }),
        ).pipe(Effect.map((summary) => summary.id)),
      );
      // Nothing yet: the interval has not elapsed, so a body now would be from somewhere else.
      expect(received).toEqual([]);
    } finally {
      await runtime.dispose();
    }
    expect(created).toBeDefined();

    expect(received.length).toBeGreaterThan(0);
    for (const request of received) {
      expect(request.method).toBe("POST");
      expect(request.path).toBe("/v1/metrics");
      expect(request.headers["content-type"]).toContain("application/json");
    }
    const body = received.at(-1)?.body as MetricsBody;
    const resource = body.resourceMetrics[0]?.resource;
    expect(attribute(resource?.attributes ?? [], "service.name")).toBe(
      "factory-api-metrics-test",
    );

    const [creates] = metricsNamed(body, "factory.session.creates");
    expect(creates?.unit).toBe("{session}");
    expect(creates?.sum?.isMonotonic).toBe(true);
    expect(pointValue(createsPoint(body))).toBe(1);
  }, 60_000);

  /**
   * Mutation: ignore `OTEL_METRIC_EXPORT_INTERVAL` (effect's 10-second default, or the 60-second
   * one) — no export arrives while the runtime is still open.
   */
  it("exports on the configured interval while the process runs, not only at shutdown", async () => {
    const runtime = ManagedRuntime.make(
      Layer.mergeAll(
        sessions,
        exporterWith({
          OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: endpoint,
          OTEL_METRIC_EXPORT_INTERVAL: "200",
        }),
      ),
    );
    try {
      await runtime.runPromise(
        Effect.flatMap(SessionService, (service) =>
          service.create({ title: "counted on a tick" }),
        ),
      );
      await waitFor(
        () =>
          received.some(
            (request) =>
              createsPoint(request.body as MetricsBody) !== undefined,
          ),
        "an interval export carrying the create",
        // Well inside effect's own 10-second default, so an ignored setting cannot pass here.
        3_000,
      );
      const body = received.at(-1)?.body as MetricsBody;
      // Cumulative over this file's registry: at least this case's create.
      expect(pointValue(createsPoint(body))).toBeGreaterThanOrEqual(1);
      // The default service name, shared with the motel exporter.
      expect(
        attribute(
          body.resourceMetrics[0]?.resource.attributes ?? [],
          "service.name",
        ),
      ).toBe("factory-api");
    } finally {
      await runtime.dispose();
    }
  }, 60_000);

  /**
   * Mutation: read the endpoint as a plain string, or with `Config.URL` alone — a malformed or
   * scheme-less one builds, and fails every export.
   */
  it("refuses a malformed or scheme-less endpoint or a non-positive interval at build, rather than exporting nowhere", async () => {
    const build = (env: Record<string, string>) =>
      Effect.runPromiseExit(Effect.scoped(Layer.build(exporterWith(env))));
    const malformed = await build({
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "not a url",
    });
    // WHATWG parses both, with `localhost:` and `collector:` as the protocol.
    const schemeless = await build({
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "localhost:4318/v1/metrics",
    });
    const hostPort = await build({
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "collector:4318",
    });
    const zero = await build({
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: endpoint,
      OTEL_METRIC_EXPORT_INTERVAL: "0",
    });
    expect(Exit.isFailure(malformed)).toBe(true);
    expect(Exit.isFailure(schemeless)).toBe(true);
    expect(Exit.isFailure(hostPort)).toBe(true);
    expect(Exit.isFailure(zero)).toBe(true);
  });

  /**
   * Every fetch the layer makes goes through a recording `Fetch` that answers `200 {}` itself, so a
   * request is seen wherever it was addressed — including a default endpoint the test never named.
   * The set case is the control: the same recorder sees the shutdown export.
   *
   * Mutation: default the endpoint (say to `http://localhost:4318/v1/metrics`) instead of returning
   * `Layer.empty` when it is unset — the unset build fetches at shutdown.
   */
  it("builds no exporter when the endpoint is unset: nothing is fetched, anywhere", async () => {
    const fetchesOf = async (env: Record<string, string>) => {
      const fetched: string[] = [];
      const recorder = ((input: Parameters<typeof globalThis.fetch>[0]) => {
        fetched.push(input instanceof Request ? input.url : String(input));
        return Promise.resolve(
          new Response("{}", {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      }) as typeof globalThis.fetch;
      const exit = await Effect.runPromiseExit(
        Effect.scoped(
          Layer.build(
            exporterWith(env).pipe(
              Layer.provide(Layer.succeed(FetchHttpClient.Fetch, recorder)),
            ),
          ),
        ),
      );
      return { exit, fetched };
    };

    const set = await fetchesOf({
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT:
        "http://collector.invalid:4318/v1/metrics",
      OTEL_METRIC_EXPORT_INTERVAL: "3600000",
    });
    expect(Exit.isSuccess(set.exit)).toBe(true);
    expect(set.fetched).toContain("http://collector.invalid:4318/v1/metrics");

    // Unset is off, not an error: the layer builds, and closing it fetches nothing.
    const unset = await fetchesOf({});
    expect(Exit.isSuccess(unset.exit)).toBe(true);
    expect(unset.fetched).toEqual([]);
    expect(received).toEqual([]);
  });
});
