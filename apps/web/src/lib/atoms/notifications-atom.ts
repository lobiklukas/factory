import { Effect } from "effect";
import { Atom } from "effect/reactivity";
import type {
  AddNotificationSinkInput,
  NotificationSinkRefInput,
  SetNotificationKindInput,
  SetNotificationSinkEnabledInput,
} from "@repo/domain/Notify";
import { runtime } from "../atom";
import { DASHBOARD_ACTOR as DASHBOARD } from "../approvals-view";
import { RpcClient } from "../rpc-client";

/** The reactivity key a write that changes the settings invalidates. */
export const NOTIFICATIONS_KEY = "notification-settings";

/**
 * The notification settings (F21): the kinds' effective toggles, the caller's own sinks and what the
 * control plane can send. Read once per opening and again after each write on this page — it changes
 * only by a write, and a toggle is live on the notifier's next poll, so nothing here polls.
 */
export const notificationSettingsAtom = runtime
  .atom(
    Effect.gen(function* () {
      const rpc = yield* RpcClient;
      return yield* rpc.client.getNotificationSettings({ actor: DASHBOARD });
    }),
  )
  .pipe(Atom.withReactivity([NOTIFICATIONS_KEY]));

/** Switch a kind for the whole deployment, as the page's checkbox does. */
export const setNotificationKindAtom = runtime.fn(
  (input: Omit<SetNotificationKindInput, "actor">) =>
    Effect.gen(function* () {
      const rpc = yield* RpcClient;
      return yield* rpc.client.setNotificationKind({
        ...input,
        actor: DASHBOARD,
      });
    }),
  { reactivityKeys: [NOTIFICATIONS_KEY] },
);

export const addNotificationSinkAtom = runtime.fn(
  (input: Omit<AddNotificationSinkInput, "actor">) =>
    Effect.gen(function* () {
      const rpc = yield* RpcClient;
      return yield* rpc.client.addNotificationSink({
        ...input,
        actor: DASHBOARD,
      });
    }),
  { reactivityKeys: [NOTIFICATIONS_KEY] },
);

export const setNotificationSinkEnabledAtom = runtime.fn(
  (input: Omit<SetNotificationSinkEnabledInput, "actor">) =>
    Effect.gen(function* () {
      const rpc = yield* RpcClient;
      return yield* rpc.client.setNotificationSinkEnabled({
        ...input,
        actor: DASHBOARD,
      });
    }),
  { reactivityKeys: [NOTIFICATIONS_KEY] },
);

export const removeNotificationSinkAtom = runtime.fn(
  (input: Omit<NotificationSinkRefInput, "actor">) =>
    Effect.gen(function* () {
      const rpc = yield* RpcClient;
      return yield* rpc.client.removeNotificationSink({
        ...input,
        actor: DASHBOARD,
      });
    }),
  { reactivityKeys: [NOTIFICATIONS_KEY] },
);
