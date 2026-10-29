import { AutomationService } from "@repo/core";
import { AutomationsRpc } from "@repo/domain/Rpc";
import { Effect } from "effect";
import { attributed } from "./Auth";

/**
 * Scheduled automations over RPC (S-general-automations): thin calls into `AutomationService`, which
 * holds the schedule, the tick's dedupe and the skip. `addAutomation` is the credential's actor's
 * (LOB-20); a tick's card and run are the automation's own (`automation:<id>`), whoever asked.
 */
export const AutomationsRpcHandlers = AutomationsRpc.toLayer(
  Effect.gen(function* () {
    const automations = yield* AutomationService;
    return AutomationsRpc.of({
      addAutomation: (input) =>
        attributed(input).pipe(Effect.flatMap(automations.add)),
      listAutomations: (input) => automations.list(input.repo),
      getAutomation: (input) => automations.get(input.id),
      pauseAutomation: (input) => automations.pause(input.id),
      resumeAutomation: (input) => automations.resume(input.id),
      runAutomation: (input) =>
        automations.run(input.id).pipe(Effect.map((fired) => fired.tick)),
      removeAutomation: (input) => automations.remove(input.id),
      listAutomationTicks: (input) => automations.ticks(input.id, input.limit),
    });
  }),
);
