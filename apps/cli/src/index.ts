import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { Command } from "effect/cli";
import {
  approvalsCommand,
  approveCommand,
  denyCommand,
} from "./commands/approve";
import { boardCommand } from "./commands/board";
import { discardCommand } from "./commands/discard";
import { doctorCommand } from "./commands/doctor";
import { historyCommand } from "./commands/history";
import { lsCommand } from "./commands/ls";
import { prCommand } from "./commands/pr";
import { repoCommand } from "./commands/repo";
import { runCommand } from "./commands/run";
import { sendCommand } from "./commands/send";
import { statusCommand } from "./commands/status";
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
    historyCommand,
    lsCommand,
    sendCommand,
    withdrawCommand,
    discardCommand,
    prCommand,
    boardCommand,
    repoCommand,
    doctorCommand,
    statusCommand,
    approvalsCommand,
    approveCommand,
    denyCommand,
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
