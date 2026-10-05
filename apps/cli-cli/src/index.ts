import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { Command } from "effect/cli";
import { ask } from "./commands/ask";
import { chat } from "./commands/chat";
import { hello } from "./commands/hello";
import { DevToolsLive } from "./observability/DevTools";

const root = Command.make("cli-cli");

// NOTE: Modules inject additional subcommands through Command.withSubcommands.
const AllCommands = Command.withSubcommands([ask, chat, hello]);

// NOTE: Modules append additional runtime layers through Layer.mergeAll.
const RuntimeLayers = Layer.mergeAll(BunServices.layer, DevToolsLive);

root.pipe(
  AllCommands,
  Command.run({ version: "0.0.0" }),
  Effect.provide(RuntimeLayers),
  BunRuntime.runMain,
);
