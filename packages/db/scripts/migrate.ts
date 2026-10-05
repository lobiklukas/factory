import { BunRuntime } from "@effect/platform-bun";
import { Console, Effect } from "effect";
import { MigratedLive } from "../src";

const program = Console.log("Database migrations completed").pipe(
  Effect.provide(MigratedLive),
);

BunRuntime.runMain(program);
