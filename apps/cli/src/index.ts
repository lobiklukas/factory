import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { Command } from "effect/cli";
import {
  approvalsCommand,
  approveCommand,
  denyCommand,
} from "./commands/approve";
import { boardCommand } from "./commands/board";
import { budgetCommand } from "./commands/budget";
import { costCommand } from "./commands/cost";
import { discardCommand } from "./commands/discard";
import { doctorCommand } from "./commands/doctor";
import { historyCommand } from "./commands/history";
import { interruptCommand } from "./commands/interrupt";
import { lsCommand } from "./commands/ls";
import { outcomesCommand } from "./commands/outcomes";
import { prCommand } from "./commands/pr";
import { repoCommand } from "./commands/repo";
import { replayCommand } from "./commands/replay";
import { runCommand } from "./commands/run";
import { sendCommand } from "./commands/send";
import {
  compactCommand,
  forkCommand,
  resetCommand,
} from "./commands/sessionControl";
import { spendCommand } from "./commands/spend";
import { secretCommand } from "./commands/secret";
import { skillCommand } from "./commands/skill";
import { statusCommand } from "./commands/status";
import { triggersCommand } from "./commands/triggers";
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
    interruptCommand,
    budgetCommand,
    discardCommand,
    forkCommand,
    resetCommand,
    compactCommand,
    spendCommand,
    prCommand,
    boardCommand,
    repoCommand,
    skillCommand,
    secretCommand,
    triggersCommand,
    replayCommand,
    costCommand,
    doctorCommand,
    statusCommand,
    outcomesCommand,
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
