# Notifications: a person is told when a run needs them

**Status: passing.** When a run parks a card on a question, asks for an approval, reaches a human
gate, or fails (a budget stop or a model request Pi Durable gave up on), the API sends one message
to each configured sink — a Slack incoming webhook, an ntfy topic, or both — with a link to the card
(S-notifications). Each delivery is recorded keyed by the event, so a restart sends nothing twice.

## What it is

- `packages/core/src/Notifier.ts`: `makeNotifier` reads what needs a person from the attention view
  (`TaskService.attention`, every board: approvals, questions, gates) and the failed runs of the last
  day (`run_failures`), turns each into a message (`notificationOfAttention`,
  `notificationOfFailure`), records one `notification_deliveries` row per event per sink, and sends
  the undelivered rows — claimed one at a time just before the send, each send cut off at ten
  seconds, every sink on its own fiber; a retry of an event no longer open (the approval decided)
  is dropped, a kind turned off is not sent from the backlog, and a 429 spends no attempt. A sink is `slackWebhookSink` (a `POST {text}` to the webhook URL) or
  `ntfySink` (ntfy's JSON publish to the server's root). Their ids fingerprint the destination, so the
  URL and the topic never reach the ledger or the log.
- Event ids: `question:<card>:<blocked since>`, `approval:<session>:<request>`,
  `gate:<card>:<column>:<run>`, `failed:<session>:<entry>`.
- Links: a question opens the card's thread (`/boards/<board>?card=<card>#thread`); an approval, a
  gate and a failure the card with the run (`&run=<session>`); an approval or a failure no card owns
  the session (`/sessions/<session>`).
- `run_failures` (migration 0039) is written by the session's activity projection
  (`SessionService.recordActivity`): a `budget` entry, or a run that turns idle on an assistant entry
  whose model request failed (`isError` on the transcript entry, with the provider's message in
  `error`, set by `packages/harness`'s `projectEntry` when Pi Durable's message has
  `stopReason: "error"`). An interrupt, a budget stop, a reset or a compaction after that entry means
  the run did not end on it, so no `model_error` is recorded for it.
- `apps/api/src/Notifications.ts` reads the configuration and forks the daemon; with no sink it logs
  `notifications: off (…)` and forks nothing.

## How a user reaches it

Set `NOTIFY_SLACK_WEBHOOK_URL` and/or `NOTIFY_NTFY_TOPIC` (`NOTIFY_NTFY_URL` for a server other than
`https://ntfy.sh`, `NOTIFY_NTFY_TOKEN` for a protected topic), optionally `NOTIFY_TYPES` (a subset of
`question,approval,gate,failed`), `NOTIFY_LINK_BASE` (the dashboard's origin; the first
`ALLOWED_ORIGINS` entry by default) and `NOTIFY_POLL_MS` (5000). The ntfy phone app is the mobile
path.

## What proves it

`DATABASE_URL=… ./notify.sh` (API on `NOTIFY_PORT`, default `:9446`; the fake on `NOTIFY_FAKE_PORT`,
`:9447`) — its own database minted on `DATABASE_URL`'s server, so the fake's ledger holds this drive's
messages and nothing else. Three boots of one API over that database:

1. both sinks: a card's run parks it on a question (the `ask` service call), another's run asks an
   approval (`requestApproval`), a third's run is stopped by its one-cent cap, and a fourth's run is
   created on `faux/faulted` — a faux model whose `FAUX_MODEL_SCRIPTS` row says
   `"fail": "model_error"` (F6) — so its model request fails and the run ends `model_error`. Each is
   exactly one Slack message and one ntfy message, linked to its card, saying what it is about (the
   model failure's body is `FAUX_FAIL_MESSAGE`); four in all on each sink; ntfy carries the token,
   Slack no credential;
2. restarted with the same configuration: a new question arrives once on each sink (the notifier is
   polling), and the first four are still one message each;
3. restarted with `NOTIFY_TYPES=question,failed` and a fresh topic: the two questions and the two
   failures reach it once each; the approval, still pending, does not.

The script also checks the boot lines, that the API's log names no webhook path, topic or token
across the three boots, and that the API called no route the fake does not serve.

In the gate: `packages/core/src/Notifier.test.ts` (the messages and links per kind, both sinks'
bodies and requests against an in-process `HttpClient`, and over the real attention view and ledger:
once per event across passes and a restarted notifier, two sinks each once, a kind turned off neither
sent nor recorded, a failed send recorded and retried once, `maxAttempts`, the failure lookback, a
retry of a decided approval dropped, a kind turned off not sent from the backlog, a 429 spending no
attempt, a hanging sink cut off without delaying the other);
`packages/core/src/SessionService.failures.test.ts` (a budget stop and a non-retryable model error
each one `run_failures` row, and so does a request `FAUX_FAIL` fails; an answered run none, and a run interrupted inside a retry's backoff
none); `apps/cli/src/transcript.test.ts` (a failed request is never the CLI's answer); `apps/api/src/Notifications.test.ts` (the
configuration and the boot line, no secret in it).

## What it does not reach

Email and Web Push are not built. A Slack bot-token post (`chat.postMessage` into a channel, as the
Slack adapter's `SlackWriteBack` replies in a thread) is not a sink: an incoming webhook needs no
token and no channel id. A process that dies between a sink accepting a message and the ledger's
stamp sends it again after the retry interval (a minute). There is no per-person routing: every
message goes to every sink.
