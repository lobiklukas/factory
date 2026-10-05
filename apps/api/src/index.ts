import { BunHttpServer, BunRuntime, BunServices } from "@effect/platform-bun";
import { SessionService, SessionServiceLive } from "@repo/core";
import { Api } from "@repo/domain/Api";
import {
  createModelAccess,
  FAUX_COMMAND,
  type ModelBackend,
} from "@repo/harness";
import { MigrationsLive, PostgresLive } from "@repo/storage-postgres";
import { Cause, Config, Effect, Exit, Layer, Option } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { HealthGroupLive } from "./Api/Health";
import { ProbesLive } from "./Api/Probes";
import { SessionRpcLive } from "./Rpc/Session";
import { DevToolsLive } from "./observability/DevTools";
import { MotelLive } from "./observability/Motel";

/**
 * Cap on an HTTP request body, in bytes (LOB-21). The largest legitimate request here is an RPC
 * `sendMessage`: the service refuses a message over `MAX_MESSAGE_CHARS` (100,000 characters), which
 * is at most ~400 KB of UTF-8 plus JSON framing, so 1 MiB carries every legal request with
 * headroom. Bun's own default is 128 MiB — 128× larger, and enough for one unauthenticated upload
 * to exhaust the process.
 */
const DEFAULT_MAX_REQUEST_BODY_BYTES = 1_048_576;

/** How long to wait before retrying a failed migration sweep (LOB-21). */
const MIGRATION_RETRY_MS = 3_000;

export const ServerConfig = Config.all({
  port: Config.Number("PORT").pipe(Config.withDefault(9000)),
  hostname: Config.String("HOST").pipe(Config.withDefault("0.0.0.0")),
  idleTimeout: Config.Number("IDLE_TIMEOUT").pipe(Config.withDefault(120)),
  allowedOrigins: Config.String("ALLOWED_ORIGINS").pipe(
    Config.withDefault("http://localhost:3000"),
  ),
  /** Bounds one request; Bun's own default is 128 MiB (LOB-21). */
  maxRequestBodySize: Config.Number("MAX_REQUEST_BODY_BYTES").pipe(
    Config.withDefault(DEFAULT_MAX_REQUEST_BODY_BYTES),
  ),
});

/**
 * Which model a session runs against.
 *
 * `MODEL_BACKEND` wins when set. Otherwise a key decides: a real provider when one is configured,
 * pi-ai's deterministic faux provider when none is, so a checkout with no key still boots and a
 * session still runs end to end — it just reports that it is not talking to a model.
 */
const ModelConfig = Config.all({
  backend: Config.option(
    Config.Literals(["anthropic", "faux"], "MODEL_BACKEND"),
  ),
  /** What the faux script runs. A verification run scripts a command that sleeps. */
  fauxCommand: Config.String("FAUX_COMMAND").pipe(
    Config.withDefault(FAUX_COMMAND),
  ),
  apiKey: Config.option(Config.Redacted("ANTHROPIC_API_KEY")),
  sessionRoot: Config.String("SESSION_ROOT").pipe(
    Config.withDefault(".factory/sessions"),
  ),
  idleTimeoutMs: Config.Int("SESSION_IDLE_TIMEOUT_MS").pipe(
    Config.withDefault(15 * 60_000),
  ),
});

/** The first line of a cause, short enough for one log line. */
const firstLine = (cause: Cause.Cause<unknown>): string =>
  Cause.pretty(cause).split("\n")[0]?.trim() ?? "unknown failure";

/**
 * Release every session owner this process holds when it is asked to stop (LOB-21).
 *
 * `BunRuntime.runMain` interrupts the main fiber on SIGINT/SIGTERM, which tears down this layer's
 * scope; the finalizer then runs `SessionService.close`. Releasing the owners — rather than letting
 * the process exit with them open — is what makes an interrupted run *resumable* rather than merely
 * durable: `closeHarness` settles the run and the storage is disposed, so the log is a clean
 * transcript a later read folds and a later message continues. The log lines are the evidence.
 */
const SessionShutdown = Layer.effectDiscard(
  Effect.gen(function* () {
    const sessions = yield* SessionService;
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        yield* Effect.logInfo(
          "shutdown: releasing every session owner held by this process",
        );
        yield* sessions.close;
        yield* Effect.logInfo("shutdown: session owners released");
      }),
    );
  }),
);

/**
 * Apply migrations out of the boot path (LOB-21).
 *
 * `PgMigrator.layer` runs its migrations during layer *acquisition* and dies when Postgres is
 * unreachable, so building it as a dependency of the HTTP server would turn a database outage into
 * a crash loop instead of a pod that is up but *not ready*. Here it is a scoped build inside a
 * forked fiber: the server binds first, `/readyz` names what is missing, and a database that comes
 * back later turns readiness green without a restart. A successful build means the migrations are
 * applied — `PgMigrator.layer` is `Layer.effectDiscard(run(...))`, not a daemon.
 */
const applyMigrations = Effect.gen(function* () {
  for (;;) {
    const exit = yield* Effect.scoped(Layer.build(MigrationsLive)).pipe(
      Effect.exit,
    );
    if (Exit.isSuccess(exit)) {
      yield* Effect.logInfo("migrations: applied");
      return;
    }
    yield* Effect.logError(
      `migrations failed; retrying in ${MIGRATION_RETRY_MS}ms: ${firstLine(exit.cause)}`,
    );
    yield* Effect.sleep(MIGRATION_RETRY_MS);
  }
});

const MigrationsDaemon = Layer.effectDiscard(
  Effect.forkScoped(applyMigrations),
);

// HTTP API Router
const ApiRouter = HttpApiBuilder.layer(Api).pipe(
  Layer.provide(HealthGroupLive),
);

// NOTE: Modules append additional routers here through Layer.mergeAll.
const AllRouters = Layer.mergeAll(ApiRouter, SessionRpcLive, ProbesLive);

// NOTE: Modules append additional server layers here through Layer.mergeAll.
const ServerLayers = Layer.mergeAll(
  BunHttpServer.layerConfig(ServerConfig),
  DevToolsLive,
  MotelLive,
);

const HttpLive = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const model = yield* ModelConfig;
  const allowedOrigins = config.allowedOrigins.split(",").map((o) => o.trim());

  const backend: ModelBackend = Option.getOrElse(model.backend, () =>
    Option.isSome(model.apiKey) ? "anthropic" : "faux",
  );
  yield* Effect.logInfo(
    `model backend: ${backend}${Option.isSome(model.backend) ? " (MODEL_BACKEND)" : ""}`,
  );
  if (backend === "faux") {
    yield* Effect.logWarning(
      "no ANTHROPIC_API_KEY: sessions run against the faux provider and produce scripted answers",
    );
  }

  // Sessions own one log, one working directory, and (locally) the harness that drives them.
  const SessionDeps = SessionServiceLive({
    model: createModelAccess(backend, { fauxCommand: model.fauxCommand }),
    sessionRoot: model.sessionRoot,
    idleTimeoutMs: model.idleTimeoutMs,
  });

  // The database pool is lazy (`PgClient` opens a connection on first query), so this graph builds
  // — and the server binds — even when Postgres is unreachable. Migrations run in the background so
  // a failing migrator cannot kill the process; `/readyz` reports the truth and requests that need
  // the log fail with a typed `SessionError`.
  //
  // `provideMerge` (not `provide`): `/readyz` needs `SqlClient` itself, so the database services
  // have to stay in the layer's output rather than being kept private to the session layer. The
  // shutdown finalizer registers after the pool, so it runs before the pool closes.
  const RouterDependencies = Layer.mergeAll(
    SessionShutdown.pipe(Layer.provideMerge(SessionDeps)),
    MigrationsDaemon,
  ).pipe(Layer.provideMerge(Layer.mergeAll(PostgresLive, BunServices.layer)));

  yield* Effect.logInfo(`CORS allowed origins: ${allowedOrigins.join(", ")}`);
  yield* Effect.logInfo("Starting server with:");
  yield* Effect.logInfo("  - HTTP API at /");
  yield* Effect.logInfo("  - RPC at /rpc");
  yield* Effect.logInfo("  - probes at /livez and /readyz");
  yield* Effect.logInfo(
    `  - session working directories under ${model.sessionRoot}`,
  );
  yield* Effect.logInfo(
    `  - request body cap ${config.maxRequestBodySize} bytes`,
  );

  const CorsRouters = AllRouters.pipe(
    Layer.provide(
      HttpRouter.cors({
        allowedOrigins,
        allowedMethods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
        allowedHeaders: ["Content-Type", "Authorization", "B3", "traceparent"],
        credentials: true,
      }),
    ),
  );

  return HttpRouter.serve(CorsRouters).pipe(
    HttpServer.withLogAddress,
    Layer.provide(RouterDependencies),
    Layer.provideMerge(ServerLayers),
  );
}).pipe(Layer.unwrap, Layer.launch);

BunRuntime.runMain(HttpLive);
