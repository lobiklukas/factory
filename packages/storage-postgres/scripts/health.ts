import { BunRuntime } from "@effect/platform-bun";
import { Console, Effect } from "effect";
import { checkDatabaseHealth, DatabaseLive } from "../src";

const program = Effect.gen(function* () {
  const healthy = yield* checkDatabaseHealth;
  yield* Console.log(healthy ? "Database is healthy" : "Database is unhealthy");
}).pipe(Effect.provide(DatabaseLive));

BunRuntime.runMain(program);
