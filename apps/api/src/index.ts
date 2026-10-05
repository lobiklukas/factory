import { BunHttpServer, BunRuntime, BunServices } from "@effect/platform-bun";
import { SessionServiceLive } from "@repo/core";
import { Api } from "@repo/domain/Api";
import {
  createModelAccess,
  FAUX_COMMAND,
  type ModelBackend,
} from "@repo/harness";
import { DatabaseLive } from "@repo/storage-postgres";
import { Config, Effect, Layer, Option } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { HealthGroupLive } from "./Api/Health";
import { SessionRpcLive } from "./Rpc/Session";
import { DevToolsLive } from "./observability/DevTools";
import { MotelLive } from "./observability/Motel";

export const ServerConfig = Config.all({
  port: Config.Number("PORT").pipe(Config.withDefault(9000)),
  hostname: Config.String("HOST").pipe(Config.withDefault("0.0.0.0")),
  idleTimeout: Config.Number("IDLE_TIMEOUT").pipe(Config.withDefault(120)),
  allowedOrigins: Config.String("ALLOWED_ORIGINS").pipe(
    Config.withDefault("http://localhost:3000"),
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

// HTTP API Router
const ApiRouter = HttpApiBuilder.layer(Api).pipe(
  Layer.provide(HealthGroupLive),
);

// NOTE: Modules append additional routers here through Layer.mergeAll.
const AllRouters = Layer.mergeAll(ApiRouter, SessionRpcLive);

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
  const RouterDependencies = SessionServiceLive({
    model: createModelAccess(backend, { fauxCommand: model.fauxCommand }),
    sessionRoot: model.sessionRoot,
    idleTimeoutMs: model.idleTimeoutMs,
  }).pipe(Layer.provide(Layer.mergeAll(DatabaseLive, BunServices.layer)));

  yield* Effect.logInfo(`CORS allowed origins: ${allowedOrigins.join(", ")}`);
  yield* Effect.logInfo("Starting server with:");
  yield* Effect.logInfo("  - HTTP API at /");
  yield* Effect.logInfo("  - RPC at /rpc");
  yield* Effect.logInfo(
    `  - session working directories under ${model.sessionRoot}`,
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
