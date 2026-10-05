import { BunHttpServer, BunRuntime } from "@effect/platform-bun";
import { Config, Effect, Layer } from "effect";
import { McpProtocol, McpServer } from "effect/ai";
import { HttpRouter, HttpServer } from "effect/http";
import { HelloPromptLive } from "./prompts/HelloPrompt";
import { PrimerResourceLive } from "./resources/PrimerResource";

export const McpServerConfig = Config.all({
  port: Config.Number("MCP_PORT").pipe(Config.withDefault(9009)),
  hostname: Config.String("MCP_HOST").pipe(Config.withDefault("0.0.0.0")),
  allowedOrigins: Config.String("MCP_ALLOWED_ORIGINS").pipe(
    Config.withDefault("http://localhost:3000"),
  ),
});

// NOTE: Modules append tools, prompts, and resources to this layer.
const McpCapabilities = Layer.mergeAll(
  Layer.empty,
  HelloPromptLive,
  PrimerResourceLive,
).pipe(Layer.satisfiesServicesType<never>());

const McpHttpLive = Effect.gen(function* () {
  const config = yield* McpServerConfig;
  const allowedOrigins = config.allowedOrigins
    .split(",")
    .map((origin) => origin.trim());

  yield* Effect.logInfo("Starting MCP server at /mcp");

  return McpServer.layerHttp({
    name: "Stack Effect MCP Server",
    version: "0.1.0",
    path: "/mcp",
    protocols: [McpProtocol.v2025_06_18],
    allowedOrigins,
  }).pipe(
    Layer.provideMerge(McpCapabilities),
    HttpRouter.serve,
    HttpServer.withLogAddress,
    Layer.provide(BunHttpServer.layerConfig(McpServerConfig)),
  );
}).pipe(Layer.unwrap, Layer.launch, Effect.satisfiesServicesType<never>());

BunRuntime.runMain(McpHttpLive);
