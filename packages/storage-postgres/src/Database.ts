import { BunServices as PlatformServices } from "@effect/platform-bun";
import { PgClient } from "@effect/sql-pg";
import { Config, Layer, Redacted, String } from "effect";

export const DatabaseConfig = Config.all({
  url: Config.Redacted("DATABASE_URL").pipe(
    // The default is spelled out again in `packages/core/src/SessionService.test.ts`, which has to
    // read `DATABASE_URL` before any config is built. Keep the two literals in step.
    Config.withDefault(
      Redacted.make("postgres://factory:factory@localhost:5442/factory"),
    ),
  ),
  maxConnections: Config.Int("DATABASE_MAX_CONNECTIONS").pipe(
    Config.withDefault(10),
  ),
});

export const PostgresLive = PgClient.layerConfig({
  url: DatabaseConfig.pipe(Config.map((config) => config.url)),
  maxConnections: DatabaseConfig.pipe(
    Config.map((config) => config.maxConnections),
  ),
  transformQueryNames: Config.succeed(String.camelToSnake),
  transformResultNames: Config.succeed(String.snakeToCamel),
}).pipe(
  Layer.provide(PlatformServices.layer),
  Layer.satisfiesServicesType<never>(),
);
