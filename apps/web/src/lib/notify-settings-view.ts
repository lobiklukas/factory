/**
 * The notification settings page (F21), as pure functions: what each kind is called, which sink
 * rows read how, what the email form sends, how a browser's push subscription becomes a sink, and
 * what a refusal says. The browser-only half (the service worker, the permission prompt) is
 * `./web-push-client`.
 */
import type {
  NotificationKind,
  NotificationSettings,
  NotificationSinkSummary,
} from "@repo/domain/Notify";

/** What the page calls a kind, and when it fires: the events the notifier reads. */
export const KIND_COPY: Readonly<
  Record<NotificationKind, { readonly label: string; readonly detail: string }>
> = {
  question: {
    label: "Questions",
    detail: "A card is parked waiting for an answer",
  },
  approval: {
    label: "Approvals",
    detail: "A run asked to do something that needs your yes",
  },
  gate: {
    label: "Gates",
    detail: "A card's run is done and moving it on needs a person",
  },
  failed: {
    label: "Failures",
    detail: "A run stopped on its budget or a model request that kept failing",
  },
  spend: {
    label: "Spend caps",
    detail: "A repo or actor spend cap crossed 80% or was reached",
  },
};

/** The kinds in the order the notifier lists them, each with its current toggle. */
export const kindRows = (settings: NotificationSettings) =>
  settings.kinds.map((setting) => ({
    ...setting,
    ...KIND_COPY[setting.kind],
  }));

/** How one kind reads under its toggle: whether the toggle overrides `NOTIFY_TYPES`. */
export const kindSource = (setting: { readonly stored: boolean }): string =>
  setting.stored ? "set here" : "from NOTIFY_TYPES";

/** A sink row's lead: its type, then where it goes. */
export const sinkTitle = (sink: NotificationSinkSummary): string =>
  sink.type === "email" ? `Email · ${sink.label}` : `Web Push · ${sink.label}`;

/**
 * The address the email form would send, or what is wrong with it before anything is sent. The
 * server is the authority on what an address is; this catches the typo a person can fix at once.
 */
export const emailDestination = (
  text: string,
):
  | {
      readonly ok: true;
      readonly destination: {
        readonly type: "email";
        readonly address: string;
      };
    }
  | { readonly ok: false; readonly problem: string } => {
  const address = text.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
    return {
      ok: false,
      problem: "An email address looks like name@example.com.",
    };
  }
  return { ok: true, destination: { type: "email", address } };
};

/** What `PushSubscription.toJSON()` returns, all optional as the DOM types it. */
export type SubscriptionJson = {
  readonly endpoint?: string | undefined;
  readonly keys?: Readonly<Record<string, string>> | undefined;
};

/** The web-push sink a browser's subscription is, or why it is not one. */
export const pushDestination = (
  json: SubscriptionJson,
):
  | {
      readonly ok: true;
      readonly destination: {
        readonly type: "web_push";
        readonly endpoint: string;
        readonly p256dh: string;
        readonly auth: string;
      };
    }
  | { readonly ok: false; readonly problem: string } => {
  const endpoint = json.endpoint;
  const p256dh = json.keys?.["p256dh"];
  const auth = json.keys?.["auth"];
  if (endpoint === undefined || p256dh === undefined || auth === undefined) {
    return {
      ok: false,
      problem:
        "The browser's push subscription is missing its endpoint or keys.",
    };
  }
  return {
    ok: true,
    destination: { type: "web_push", endpoint, p256dh, auth },
  };
};

/** The VAPID public key as the bytes `pushManager.subscribe` takes as `applicationServerKey`. */
export const applicationServerKey = (
  publicKey: string,
): Uint8Array<ArrayBuffer> => {
  const unpadded = publicKey.replace(/=+$/, "");
  const padded = unpadded
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(unpadded.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let at = 0; at < binary.length; at += 1) {
    bytes[at] = binary.charCodeAt(at);
  }
  return bytes;
};

/** What a failed write shows: the server's words for a typed refusal, else the cause's text. */
export const notifyRefusal = (
  error: { readonly _tag: string; readonly message: string } | undefined,
  fallback: string,
): string =>
  error === undefined || error.message.length === 0 ? fallback : error.message;

/** What this browser can do about Web Push, as the page says it. */
export type PushSupport =
  | "supported"
  | "no_service_worker"
  | "no_push"
  | "insecure_context";

/** Web Push needs a service worker, a push manager and a secure context (https or localhost). */
export const pushSupport = (env: {
  readonly serviceWorker: boolean;
  readonly pushManager: boolean;
  readonly secureContext: boolean;
}): PushSupport =>
  !env.secureContext
    ? "insecure_context"
    : !env.serviceWorker
      ? "no_service_worker"
      : !env.pushManager
        ? "no_push"
        : "supported";

export const PUSH_SUPPORT_COPY: Readonly<Record<PushSupport, string>> = {
  supported: "",
  insecure_context:
    "Web Push needs this page on https (or localhost). Open the dashboard that way to turn it on.",
  no_service_worker:
    "This browser has no service worker, which Web Push needs.",
  no_push: "This browser does not support Web Push.",
};
