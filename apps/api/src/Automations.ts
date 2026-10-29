/**
 * The automations' clock (S-general-automations): how often the process looks for a tick its
 * automations owe, and the daemon that looks.
 *
 *   AUTOMATIONS_POLL_MS   how often, default 15000; `0` turns the clock off (`factory automation
 *                         run` still starts one, and the schedules are kept)
 *
 * A tick is recorded once whoever reaches it (`automation_ticks`), so two processes over one
 * database — or one before and after a restart — fire each instant once; the interval only bounds
 * how late a tick can be, and a 1-minute cron at the default fires within fifteen seconds of its
 * minute. A value that is not a non-negative integer refuses the boot.
 */
import {
  AutomationServiceLive,
  runAutomations,
  SkillServiceLive,
  TaskServiceLive,
} from "@repo/core";
import { Config, Effect, Layer, Schema } from "effect";

const DEFAULT_POLL_MS = 15_000;

export const AutomationsPollConfig = Config.schema(
  Schema.Finite.pipe(
    Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  ),
  "AUTOMATIONS_POLL_MS",
).pipe(Config.withDefault(DEFAULT_POLL_MS));

/** The boot's one line about the clock. */
export const describeAutomationsPoll = (pollMs: number): string =>
  pollMs === 0
    ? "automations: clock off (AUTOMATIONS_POLL_MS=0); factory automation run still starts one"
    : `automations: every ${pollMs}ms, each automation's due tick is fired once (AUTOMATIONS_POLL_MS)`;

/**
 * The daemon: read the interval, log it, and — unless it is `0` — run `runAutomations` for as long as
 * the process lives. It reads the session layer, so the boot builds it beside the docs schedule, on
 * `SessionShutdown`: shutdown interrupts the clock before the session owners are released — a tick
 * still reading its base is dropped (the next pass records its claim `failed`), and one that has
 * filed its card is waited for until it records its outcome. The first pass waits one interval,
 * which is the boot's migrations' head start.
 */
export const AutomationsDaemon = Layer.effectDiscard(
  Effect.gen(function* () {
    const pollMs = yield* AutomationsPollConfig;
    yield* Effect.logInfo(describeAutomationsPoll(pollMs));
    if (pollMs === 0) return;
    yield* Effect.forkScoped(
      Effect.sleep(pollMs).pipe(
        Effect.andThen(runAutomations({ everyMs: pollMs })),
      ),
    );
  }),
).pipe(
  Layer.provide(AutomationServiceLive),
  Layer.provide(Layer.mergeAll(TaskServiceLive, SkillServiceLive)),
);
