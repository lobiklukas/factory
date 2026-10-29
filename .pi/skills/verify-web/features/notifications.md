# Notification settings (the notifications page)

**Status: passing.** `/notifications` is where a person says which kinds of event the factory tells
people about and where it tells them (F21). The rail's **Notifications** section (the ringing bell)
opens it. It is the dashboard's face for `getNotificationSettings`, `setNotificationKind`,
`addNotificationSink`, `setNotificationSinkEnabled` and `removeNotificationSink`; the notifier that
reads what it stores is `packages/core/src/Notifier.ts`, and the Slack and ntfy drive that proves the
notifier itself is [verify-api's notify.md](../../verify-api/features/notify.md).

## What is shown

- **Kinds** (`[data-notify-kinds]`): a checkbox per kind (`[data-notify-kind=question|approval|gate|failed]`),
  each saying whether it is set here or still follows `NOTIFY_TYPES`. A toggle is the deployment's, not
  the person's, and is live on the notifier's next poll with no restart; it answers at once and settles
  on what the server says (`useOptimisticToggles`).
- **Where you are told** (`[data-notify-sinks]`, `as <actor>`): the caller's own sinks, each a row
  (`[data-notify-sink=<id>]`, `data-notify-sink-type=email|web_push`) with an on/off checkbox
  (`[data-notify-sink-enabled]`) and a remove button (`[data-notify-sink-remove]`). A push row names the
  push service's host and nothing else: the endpoint and keys are never answered back.
- **Add email** (`#notify-email`, `[data-notify-email-add]`): a typo is stopped in the form; the server
  refuses what is not an address, and the page shows its words. Absent when the control plane has no
  SMTP server (`[data-notify-email-off]`).
- **Notify this browser** (`[data-notify-push-add]`): registers `/sw.js`, asks for permission and
  subscribes with the deployment's VAPID public key; absent, with the reason, when the deployment has no key
  pair (`[data-notify-push-off]`) or the browser cannot (`[data-notify-push-unsupported]`).
- **The shared channel** (`[data-notify-shared]`): the Slack and ntfy sinks the environment configures,
  where an event goes when its owner has no sink of their own.

## How an event is routed

An event's owner is the actor that created its card, then the actor that started the run it is about.
The first owner with an enabled sink of their own is told there **only**; an event with no such owner goes
to the shared sinks. The ledger (`notification_deliveries`) keeps one row per event and sink, so each is
sent once.

## How to drive it

`./notify-settings.sh` (see SKILL.md): a scratch database, the fakes, an API with SMTP and a VAPID key pair,
the dashboard and `notify-settings.mjs`. Its checks are named in the script's header; the evidence is
`notifications-empty.png`, `notifications-sinks.png`, `notifications-approval-off.png`,
`notifications-paused.png`, `observed.json`, `process.json`, `retention.json` and `ledger.json`.

## Retention (F22)

The script's second half restarts the API over rows it seeded in SQL — a delivered ledger row and a run
failure forty days old, an undelivered row forty days old, and a delivered row and a failure two days
old — and requires the first poll to delete the two old delivered/failure rows, keep the other three,
and send nothing for the removed event.

## What it cannot prove

That a real SMTP provider accepts the message, that a browser vendor's push service accepts the request,
that a real browser shows the notification and that `sw.js`'s click handler opens the card (the drive stubs
`PushManager.subscribe`, which would otherwise call the vendor). See `docs/testing-third-parties.md`.
