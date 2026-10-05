import { BunHttpServer, BunRuntime } from "@effect/platform-bun";
import { Api } from "@repo/domain/Api";
import { Config, Effect, Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { HealthGroupLive } from "./Api/Health";
import { HelloGroupLive } from "./Api/Hello";
import { ChatRpcLive } from "./Rpc/Chat";
import { ChatSessionsLive } from "./runtime/ChatSessions";
import { ChatManagedRpcLive } from "./Rpc/ChatManaged";
import { DevToolsLive } from "./observability/DevTools";
import { TodoApiLive } from "./Api/Todo";
import { DatabaseLive, TodoRepositoryLive } from "@repo/db";
import { EventRpcLive } from "./Rpc/Event";
import { PresenceRpcLive } from "./Rpc/Presence";

export const ServerConfig = Config.all({
  port: Config.Number("PORT").pipe(Config.withDefault(9000)),
  hostname: Config.String("HOST").pipe(Config.withDefault("0.0.0.0")),
  idleTimeout: Config.Number("IDLE_TIMEOUT").pipe(Config.withDefault(120)),
  allowedOrigins: Config.String("ALLOWED_ORIGINS").pipe(
    Config.withDefault("http://localhost:3000"),
  ),
});

// HTTP API Router
const ApiRouter = HttpApiBuilder.layer(Api).pipe(
  Layer.provide([HealthGroupLive, HelloGroupLive]),
);

// NOTE: Modules append additional routers through Layer.mergeAll.
const RouterDependencies = Layer.mergeAll(
  Layer.empty,
  ChatSessionsLive,
  TodoRepositoryLive.pipe(
    Layer.provide(DatabaseLive),
    Layer.satisfiesServicesType<never>(),
  ),
);
const AllRouters = Layer.mergeAll(
  ApiRouter,
  ChatRpcLive,
  ChatManagedRpcLive,
  TodoApiLive,
  EventRpcLive,
  PresenceRpcLive,
);

// NOTE: Modules append additional server layers through Layer.mergeAll.
const ServerLayers = Layer.mergeAll(
  BunHttpServer.layerConfig(ServerConfig),
  DevToolsLive,
);

const HttpLive = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const allowedOrigins = config.allowedOrigins.split(",").map((o) => o.trim());

  yield* Effect.logInfo(`CORS allowed origins: ${allowedOrigins.join(", ")}`);
  yield* Effect.logInfo("Starting server with:");
  yield* Effect.logInfo("  - HTTP API at /");

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
