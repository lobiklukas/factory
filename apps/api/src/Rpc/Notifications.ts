import { NotifySettingsService } from "@repo/core";
import { NotificationsRpc } from "@repo/domain/Rpc";
import { Effect } from "effect";
import { attributed } from "./Auth";

/** Whose settings a call is about when neither a credential nor a body names anyone. */
export const UNATTRIBUTED_ACTOR = "unattributed";

/**
 * Notification settings over RPC (F21): thin calls into `NotifySettingsService`. A sink is its
 * actor's: the actor is the credential's (LOB-20), taken from the body only on a control plane with
 * auth off, so a person can list, pause and remove only their own. The kind toggles are the
 * deployment's, switched by any authenticated caller, and the actor is only who last switched one.
 */
export const NotificationsRpcHandlers = NotificationsRpc.toLayer(
  Effect.gen(function* () {
    const settings = yield* NotifySettingsService;
    const who = (input: { readonly actor?: string | undefined }) =>
      attributed(input).pipe(
        Effect.map(
          (attributedInput) => attributedInput.actor ?? UNATTRIBUTED_ACTOR,
        ),
      );
    return NotificationsRpc.of({
      getNotificationSettings: (input) =>
        who(input).pipe(Effect.flatMap(settings.get)),
      setNotificationKind: (input) =>
        who(input).pipe(
          Effect.flatMap((actor) => settings.setKind({ ...input, actor })),
        ),
      addNotificationSink: (input) =>
        who(input).pipe(
          Effect.flatMap((actor) => settings.addSink(actor, input.destination)),
        ),
      setNotificationSinkEnabled: (input) =>
        who(input).pipe(
          Effect.flatMap((actor) =>
            settings.setSinkEnabled(actor, input.id, input.enabled),
          ),
        ),
      removeNotificationSink: (input) =>
        who(input).pipe(
          Effect.flatMap((actor) => settings.removeSink(actor, input.id)),
        ),
    });
  }),
);
