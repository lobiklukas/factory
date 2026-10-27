import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { Command } from "effect/cli";
import { boardCommand } from "./commands/board";
import { lsCommand } from "./commands/ls";
import { runCommand } from "./commands/run";
import { sendCommand } from "./commands/send";
import { watchCommand } from "./commands/watch";
import { withdrawCommand } from "./commands/withdraw";
import { DevToolsLive } from "./observability/DevTools";
import { MotelLive } from "./observability/Motel";

const root = Command.make("factory").pipe(
  Command.withDescription(
    "Delegate a task to the factory and follow the session",
  ),
  Command.withSubcommands([
    runCommand,
    watchCommand,
    lsCommand,
    sendCommand,
    withdrawCommand,
    boardCommand,
  ]),
);

// NOTE: Modules append additional runtime layers through Layer.mergeAll.
const RuntimeLayers = Layer.mergeAll(
  BunServices.layer,
  DevToolsLive,
  MotelLive,
);

root.pipe(
  Command.run({ version: "0.0.0" }),
  Effect.provide(RuntimeLayers),
  BunRuntime.runMain,
);
