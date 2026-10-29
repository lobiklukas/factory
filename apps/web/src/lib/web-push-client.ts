/**
 * The browser half of Web Push (F21): register the service worker (`/sw.js`), ask for permission,
 * and subscribe with the control plane's VAPID public key. What comes back is the subscription's JSON
 * — endpoint and keys — which the settings page stores as a sink. Each step is a DOM API that exists
 * only in a browser, wrapped as an Effect so a refusal at any of them is one failure with the words
 * the page shows.
 */
import { Effect } from "effect";
import {
  applicationServerKey,
  pushSupport,
  type PushSupport,
  type SubscriptionJson,
} from "./notify-settings-view";

/** Whether this browser can subscribe, from what it exposes. */
export const browserPushSupport = (): PushSupport =>
  pushSupport({
    serviceWorker: "serviceWorker" in navigator,
    pushManager: "PushManager" in window,
    secureContext: window.isSecureContext,
  });

const DENIED =
  "The browser did not allow notifications for this site; allow them in its site settings and try again.";

const browserStep = <A>(what: string, step: () => Promise<A>) =>
  Effect.tryPromise({
    try: step,
    catch: (cause) =>
      `The browser could not ${what}: ${cause instanceof Error ? cause.message : String(cause)}`,
  });

/** Subscribe this browser: the subscription's JSON, or the reason (a sentence) it could not. */
export const subscribeThisBrowser = (
  publicKey: string,
): Effect.Effect<SubscriptionJson, string> =>
  Effect.gen(function* () {
    const registration = yield* browserStep("register its service worker", () =>
      navigator.serviceWorker.register("/sw.js"),
    );
    yield* browserStep(
      "start its service worker",
      () => navigator.serviceWorker.ready,
    );
    const permission = yield* browserStep("ask for permission", () =>
      Notification.requestPermission(),
    );
    if (permission !== "granted") return yield* Effect.fail(DENIED);
    const subscription = yield* browserStep("subscribe", () =>
      registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: applicationServerKey(publicKey),
      }),
    );
    return subscription.toJSON();
  });
