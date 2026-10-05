import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { Command } from "effect/cli";
import { DevToolsLive } from "./observability/DevTools";

const root = Command.make("factory");

// NOTE: Modules inject additional subcommands through Command.withSubcommands.

// NOTE: Modules append additional runtime layers through Layer.mergeAll.
const RuntimeLayers = Layer.mergeAll(BunServices.layer, DevToolsLive);

root.pipe(
  Command.run({ version: "0.0.0" }),
  Effect.provide(RuntimeLayers),
  BunRuntime.runMain,
);
