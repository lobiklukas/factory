# Slack adapter (LOB-191)

**What it is.** The fourth adapter on the trigger seam: `packages/core/src/Slack.ts` turns a Slack
Events API delivery into a `TriggerEvent` (`slackEvent`), checks Slack's own timestamped signature
(`verifySlackSignature`), decides which messages are a delegation at all (`SlackFilter`), derives the
delivery id (`slackRequestId` / `slackDelivery`) and fills the seam's write-back port with a threaded
`chat.postMessage` reply (`SlackWriteBack`). Everything after normalization — the dedupe claim, the
`create`-only filter, the label → `{repo, baseRef, prompt}` mapping, the session, the claim release —
is part 1's (`TriggerService.ts`) and is not reimplemented here.

**How a user reaches it.** A message in a watched channel is the delegation. A Slack message carries
no labels, so the **channel is the label** a mapping rule matches: an operator writes
`{label: "C0ENG", repo: "acme/widget", prompt: "Work on {{title}}:\n{{body}}"}` and every message in
`C0ENG` that passes the filter starts a session in that repo, titled by the message's first line and
carrying the whole message as its first prompt. The filter is `{channels, text?}`: a channel
allow-list, plus an optional phrase the message must contain (case-insensitive substring). A message
the filter rejects is **recorded as skipped with the reason** (`filtered:channel`, `filtered:text`,
`filtered:bot`, `filtered:subtype:…`) rather than dropped, because "nothing arrived" and "this
arrived and here is why it started nothing" are different answers to an operator.

**Slack signs differently, so the check is this adapter's own.** Linear and the generic webhook sign
the raw body with an HMAC in a header. Slack signs `v0:<timestamp>:<body>` with the app's signing
secret and sends `x-slack-signature: v0=<hex>` beside `x-slack-request-timestamp`. That timestamp is
also Slack's replay guard: a delivery more than `SLACK_REPLAY_WINDOW_SECONDS` (300) from now is
refused. `verifySlackSignature` answers a **typed** verdict — `missing-signature`,
`missing-timestamp`, `bad-timestamp`, `outside-window`, `bad-signature` — so a route can tell "unsigned"
from "wrong secret" from "captured and replayed later", which is the fix each one needs. The window is
checked *before* the HMAC on purpose: a replayed delivery is one whose signature is right.

**How the skill drives it.** `./slack.sh` boots `./slack-fake.ts` on the run's `API_PORT` and runs
`bun slack.ts`, which builds the **real** seam, the real `SessionService` and the real write-back client
over the run's Postgres — only the Slack Web API is a loopback fake, and the signature every delivery
carries is computed the way Slack computes it and then checked by the adapter's own verifier.
Eighteen checks:

1. a signed message in a watched channel starts a session and names it;
2. the session is in the rule's repo — the channel mapped it — and
3. its title is the message's first line and its first message the rendered rule;
4. the write-back replied exactly once, in the message's thread;
5. the reply names the session and links to it;
6. Slack's own two calls: the thread is read (`conversations.replies`) before one `chat.postMessage`,
   as the bot token;
7. the same message again — a new `event_id`, a fresh signature — is a replay: one session, one reply;
8. a delivery timestamped outside the five-minute window is refused as `outside-window`, and
9. it starts nothing;
10. a delivery exactly at the edge of the window is still accepted;
11. a body changed after signing is `bad-signature`, and no signature at all `missing-signature`;
12. a message in a channel the filter does not watch is skipped, naming the filter;
13. a message without the filter's phrase is skipped, naming the filter;
14. a bot's own message in a watched channel starts nothing (the loop guard);
15. a message already in a thread is answered in that thread;
16. a delivery whose reply landed but whose acknowledgement was lost fails;
17. the retry reads the thread and posts no second reply; and
18. it is processed, reusing the session the failed attempt opened.

**What proves it works.** `.verify/evidence/lob-191/` (`slack.log`, `slack-observed.json`,
`slack-ledger.json`) — 18/18 on Postgres 5442 with faux. `packages/core/src/Slack.test.ts` (30 cases)
proves what the drive does not: the payload reading (a threaded message, a bot message, an edit, a
non-message event, the `url_verification` handshake), the filter's reasons, the derived delivery id
(one message is one delivery however often Slack retries it), the signature verdicts one at a time,
the all-or-none config gate, and the two requests' shape including Slack's trap of answering
`200 {ok: false}` for a logical refusal.

**Non-vacuity.** Removing the filter's channel check (`if (!filter.channels.includes(channel)) …`) makes
the unwatched message start a session and check 12 fail; removing the write-back's read-before-reply
makes the lost-acknowledgement retry post a second reply and check 17 fail (`repliesInThread=2`).

**Nothing is wired into `apps/api` yet.** As with Jira and GitHub, there is no `POST /webhooks/slack`
route: `Webhook.ts` (the Linear and generic adapters) is unmodified, and `slackConfigFromEnv` is what a
deployment — or the coming route — uses to decide whether the adapter exists at all. `slack.sh` stands
in for the route: it signs, verifies, normalizes and delivers, which is exactly the order the route
would use. A route would also have to answer Slack's `url_verification` challenge before any delivery
arrives; `slackEvent` returns `undefined` for it rather than pretending it is a message.

**The limits the fake cannot close.** That Slack accepts these `chat.postMessage` parameters, that the
Events API really re-sends a failed delivery with the same `event.ts` (the key this relies on), and
that `conversations.replies` pages as read (Slack's default 100-message page, so a longer thread's
earlier reply could be missed and answered twice). Recorded in `docs/testing-third-parties.md`.

**A write-back failure fails the delivery.** A refused reply is a `write-back` `TriggerError`, so the
seam gives the claim back and the sender's retry runs the work instead of reading `replayed: true`
about a session whose link nobody was told. Safe because the session's request id is
`trigger:<delivery id>`, so the retry reuses the session a failed attempt opened.
