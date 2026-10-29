import { createFileRoute } from "@tanstack/react-router";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { Cause, Effect, Exit, Option } from "effect";
import {
  BellRingIcon,
  CircleAlertIcon,
  MailIcon,
  SmartphoneIcon,
  Trash2Icon,
} from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";
import type { NotificationSettings } from "@repo/domain/Notify";
import {
  addNotificationSinkAtom,
  notificationSettingsAtom,
  removeNotificationSinkAtom,
  setNotificationKindAtom,
  setNotificationSinkEnabledAtom,
} from "@/lib/atoms/notifications-atom";
import {
  emailDestination,
  kindRows,
  kindSource,
  notifyRefusal,
  PUSH_SUPPORT_COPY,
  pushDestination,
  sinkTitle,
} from "@/lib/notify-settings-view";
import {
  browserPushSupport,
  subscribeThisBrowser,
} from "@/lib/web-push-client";
import { useOptimisticToggles } from "@/hooks/use-optimistic-toggles";
import { EmptyPane } from "@/components/empty-pane";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";

export const Route = createFileRoute("/notifications")({
  component: NotificationsRoute,
});

/**
 * Notification settings (F21): which kinds of event the factory tells people about, and where it
 * tells you. The kinds are the deployment's — a toggle here overrides `NOTIFY_TYPES` and is live on
 * the notifier's next poll, no restart — and the sinks are yours: an email address and this browser's
 * Web Push subscription. An event for a card you created reaches your sinks only; one with no owner
 * who has a sink goes to the shared channel the environment configures (Slack, ntfy).
 */
function NotificationsRoute() {
  const result = useAtomValue(notificationSettingsAtom);

  if (AsyncResult.isInitial(result)) {
    return (
      <div role="status" className="flex flex-1 flex-col gap-3 p-6">
        <span className="sr-only">Loading notification settings</span>
        {[0, 1, 2].map((row) => (
          <Skeleton key={row} className="h-12 w-full max-w-2xl" aria-hidden />
        ))}
      </div>
    );
  }
  // As on the spend page: a failed re-read keeps the last answer on screen; only a first read that
  // fails replaces the page.
  const settings = Option.getOrUndefined(AsyncResult.value(result));
  if (settings === undefined) {
    return (
      <EmptyPane
        icon={<BellRingIcon strokeWidth={1.75} />}
        title="Notification settings did not load"
        detail={AsyncResult.isFailure(result) ? Cause.pretty(result.cause) : ""}
        visible
      />
    );
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-border px-4 py-3">
        <h1 className="text-sm font-medium">Notifications</h1>
        <span className="text-[11px] text-muted-foreground">
          what the factory tells people about, and where it tells you
        </span>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-8 overflow-y-auto p-6">
        <Kinds settings={settings} />
        <Sinks settings={settings} />
        <Shared settings={settings} />
      </div>
    </div>
  );
}

/** The four kinds, each a checkbox that writes on change. */
function Kinds({ settings }: { readonly settings: NotificationSettings }) {
  const set = useAtomSet(setNotificationKindAtom, { mode: "promiseExit" });
  const [problem, setProblem] = useState<string | null>(null);
  const actual = useMemo(
    () => Object.fromEntries(settings.kinds.map((k) => [k.kind, k.enabled])),
    [settings],
  );
  const toggles = useOptimisticToggles(actual);
  return (
    <section
      aria-label="Kinds of notification"
      data-notify-kinds
      className="flex max-w-2xl flex-col gap-2"
    >
      <h2 className="text-xs font-medium">What to tell people about</h2>
      <ul className="flex flex-col gap-1">
        {kindRows(settings).map((row) => (
          <li key={row.kind} className="flex items-start gap-2 text-[12px]">
            <input
              id={`notify-kind-${row.kind}`}
              type="checkbox"
              className="mt-0.5 size-3.5"
              checked={toggles.checked(row.kind, row.enabled)}
              data-notify-kind={row.kind}
              onChange={(event) => {
                setProblem(null);
                const enabled = event.currentTarget.checked;
                toggles.choose(row.kind, enabled);
                void set({ kind: row.kind, enabled }).then((exit) => {
                  if (Exit.isFailure(exit)) {
                    toggles.revert(row.kind);
                    setProblem(
                      notifyRefusal(
                        Option.getOrUndefined(
                          Cause.findErrorOption(exit.cause),
                        ),
                        Cause.pretty(exit.cause),
                      ),
                    );
                  }
                });
              }}
            />
            <Label
              htmlFor={`notify-kind-${row.kind}`}
              className="flex flex-col items-start gap-0"
            >
              <span className="font-medium">{row.label}</span>
              <span className="text-[11px] font-normal text-muted-foreground">
                {row.detail} · {kindSource(row)}
              </span>
            </Label>
          </li>
        ))}
      </ul>
      {problem === null ? null : (
        <p
          role="alert"
          data-notify-problem
          className="flex items-center gap-1.5 text-[11px] text-destructive"
        >
          <CircleAlertIcon className="size-3" strokeWidth={1.75} />
          {problem}
        </p>
      )}
    </section>
  );
}

/** The caller's own sinks, and the forms that add one. */
function Sinks({ settings }: { readonly settings: NotificationSettings }) {
  const add = useAtomSet(addNotificationSinkAtom, { mode: "promiseExit" });
  const toggle = useAtomSet(setNotificationSinkEnabledAtom, {
    mode: "promiseExit",
  });
  const remove = useAtomSet(removeNotificationSinkAtom, {
    mode: "promiseExit",
  });
  const [address, setAddress] = useState("");
  const [pending, setPending] = useState<"email" | "push" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const support = browserPushSupport();
  const actual = useMemo(
    () => Object.fromEntries(settings.sinks.map((s) => [s.id, s.enabled])),
    [settings],
  );
  const toggles = useOptimisticToggles(actual);

  const refuse = (
    exit: Exit.Exit<
      unknown,
      { readonly _tag: string; readonly message: string }
    >,
  ) => {
    if (Exit.isSuccess(exit)) return false;
    setProblem(
      notifyRefusal(
        Option.getOrUndefined(Cause.findErrorOption(exit.cause)),
        Cause.pretty(exit.cause),
      ),
    );
    return true;
  };

  const submitEmail = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaved(null);
    const parsed = emailDestination(address);
    if (!parsed.ok) {
      setProblem(parsed.problem);
      return;
    }
    setProblem(null);
    setPending("email");
    void add({ destination: parsed.destination })
      .then((exit) => {
        if (!refuse(exit) && Exit.isSuccess(exit)) {
          setAddress("");
          setSaved(exit.value.label);
        }
      })
      .finally(() => setPending(null));
  };

  const enablePush = () => {
    const publicKey = settings.channels.webPush.publicKey;
    if (publicKey === undefined) return;
    setSaved(null);
    setProblem(null);
    setPending("push");
    void Effect.runPromiseExit(subscribeThisBrowser(publicKey))
      .then((subscribed) => {
        if (Exit.isFailure(subscribed)) {
          setProblem(
            Option.getOrElse(Cause.findErrorOption(subscribed.cause), () =>
              Cause.pretty(subscribed.cause),
            ),
          );
          return undefined;
        }
        const parsed = pushDestination(subscribed.value);
        if (!parsed.ok) {
          setProblem(parsed.problem);
          return undefined;
        }
        return add({ destination: parsed.destination }).then((exit) => {
          if (!refuse(exit) && Exit.isSuccess(exit)) setSaved(exit.value.label);
        });
      })
      .finally(() => setPending(null));
  };

  return (
    <section
      aria-label="Your notification sinks"
      data-notify-sinks
      className="flex max-w-2xl flex-col gap-3"
    >
      <h2 className="text-xs font-medium">
        Where you are told
        <span className="ml-2 font-normal text-muted-foreground">
          as {settings.actor}
        </span>
      </h2>
      {settings.sinks.length === 0 ? (
        <p
          data-notify-sinks-empty
          className="text-[11px] text-muted-foreground"
        >
          You have no sink of your own, so the shared channel is told for you.
        </p>
      ) : (
        <ul aria-label="Your sinks" className="flex flex-col gap-1">
          {settings.sinks.map((sink) => (
            <li
              key={sink.id}
              data-notify-sink={sink.id}
              data-notify-sink-type={sink.type}
              className="flex items-center gap-2 text-[12px]"
            >
              {sink.type === "email" ? (
                <MailIcon className="size-3.5" strokeWidth={1.75} />
              ) : (
                <SmartphoneIcon className="size-3.5" strokeWidth={1.75} />
              )}
              <span className="font-mono">{sinkTitle(sink)}</span>
              <label className="ml-auto flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <input
                  type="checkbox"
                  checked={toggles.checked(sink.id, sink.enabled)}
                  data-notify-sink-enabled={sink.id}
                  onChange={(event) => {
                    setProblem(null);
                    const enabled = event.currentTarget.checked;
                    toggles.choose(sink.id, enabled);
                    void toggle({ id: sink.id, enabled }).then((exit) => {
                      if (refuse(exit)) toggles.revert(sink.id);
                    });
                  }}
                />
                on
              </label>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={`Remove ${sinkTitle(sink)}`}
                data-notify-sink-remove={sink.id}
                onClick={() => {
                  setProblem(null);
                  void remove({ id: sink.id }).then(refuse);
                }}
              >
                <Trash2Icon className="size-3.5" strokeWidth={1.75} />
              </Button>
            </li>
          ))}
        </ul>
      )}

      {settings.channels.email ? (
        <form
          data-notify-email-form
          onSubmit={submitEmail}
          noValidate
          className="flex flex-wrap items-end gap-2"
        >
          <div className="flex flex-col gap-1">
            <Label htmlFor="notify-email" className="text-[11px]">
              Email address
            </Label>
            <Input
              id="notify-email"
              name="address"
              type="email"
              value={address}
              onInput={(event) => {
                setAddress(event.currentTarget.value);
                setProblem(null);
                setSaved(null);
              }}
              placeholder="you@example.com"
              autoComplete="email"
              spellCheck={false}
              className="h-7 w-64 text-xs"
            />
          </div>
          <Button
            type="submit"
            size="sm"
            disabled={pending !== null}
            aria-busy={pending === "email"}
            data-notify-email-add
          >
            {pending === "email" ? <Spinner className="size-3.5" /> : null}
            Add email
          </Button>
        </form>
      ) : (
        <p data-notify-email-off className="text-[11px] text-muted-foreground">
          Email is off: this control plane has no SMTP server (NOTIFY_SMTP_URL).
        </p>
      )}

      {settings.channels.webPush.configured ? (
        support === "supported" ? (
          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={pending !== null}
              aria-busy={pending === "push"}
              data-notify-push-add
              onClick={enablePush}
            >
              {pending === "push" ? <Spinner className="size-3.5" /> : null}
              Notify this browser
            </Button>
            <span className="text-[11px] text-muted-foreground">
              Web Push to this browser, through its vendor's push service.
            </span>
          </div>
        ) : (
          <p
            data-notify-push-unsupported
            className="text-[11px] text-muted-foreground"
          >
            {PUSH_SUPPORT_COPY[support]}
          </p>
        )
      ) : (
        <p data-notify-push-off className="text-[11px] text-muted-foreground">
          Web Push is off: this control plane has no VAPID key pair
          (NOTIFY_VAPID_PUBLIC_KEY, NOTIFY_VAPID_PRIVATE_KEY).
        </p>
      )}

      {problem === null ? null : (
        <p
          role="alert"
          data-notify-problem
          className="flex items-center gap-1.5 text-[11px] text-destructive"
        >
          <CircleAlertIcon className="size-3" strokeWidth={1.75} />
          {problem}
        </p>
      )}
      {saved === null ? null : (
        <p role="status" data-notify-saved={saved} className="text-[11px]">
          Added <span className="font-mono">{saved}</span>.
        </p>
      )}
    </section>
  );
}

/** The environment's channel, named, so a person knows where an unowned event goes. */
function Shared({ settings }: { readonly settings: NotificationSettings }) {
  const shared = settings.channels.shared;
  return (
    <section
      aria-label="The shared channel"
      data-notify-shared
      className="flex max-w-2xl flex-col gap-1"
    >
      <h2 className="text-xs font-medium">The shared channel</h2>
      <p className="text-[11px] text-muted-foreground">
        {shared.length === 0
          ? "None is configured. An event for a card with no owner who has a sink of their own is not sent anywhere."
          : `An event for a card with no owner who has a sink of their own goes to ${shared.join(" and ")}.`}
      </p>
    </section>
  );
}
