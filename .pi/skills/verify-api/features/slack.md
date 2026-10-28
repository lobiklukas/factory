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
checked _before_ the HMAC on purpose: a replayed delivery is one whose signature is right.

**How a user reaches it.** `POST /webhooks/slack` (LOB-259): the Events API's Request URL. Setting
`SLACK_SIGNING_SECRET` arms it, and its `url_verification` handshake is answered at once (signed, so a
stranger gets no challenge back), before any bot token or channel exists. `SLACK_CHANNELS` is the
allow-list (and `SLACK_TEXT` the optional phrase), read per request; `SLACK_BOT_TOKEN` (with the other
two, `slackConfigFromEnv`) turns on the replies. With no secret every delivery is `503`. A delivery is
a `message` or an `app_mention` in a watched channel: an `@factory` mention is the same ask as a
message there, goes through the same filter, and Slack's `message` twin of it is the same delivery
(one message address). A signed payload with no event (`app_rate_limited`) is answered `200` and
ignored, because Slack retries and eventually disables a URL that answers anything else.

**How the skill drives it.** `./slack.sh` boots `./slack-fake.ts` and `./github-fake.ts`, boots the
**real API** pointed at them (`adapter-lib.sh`), and runs `bun slack.ts`, which posts deliveries it
signs the way Slack does (`slackSignature`) at the API over HTTP and reads sessions back through the
RPC client. Only Slack and GitHub are loopback fakes; the route, the signature check, the seam, the
session layer and Postgres are real. Nineteen checks, then the API is booted again with the signing
secret unset:

1. Slack's `url_verification` handshake is answered with its challenge, and refused when unsigned;
2. a signed message in a watched channel is processed and names a session in the rule's repo — the
   channel mapped it;
3. its title is the message's first line and its first message the rendered rule;
4. the write-back replied exactly once, in the message's thread, naming and linking the session;
5. Slack's own two calls: the thread is read (`conversations.replies`) before one `chat.postMessage`,
   as the bot token;
6. the same message again — a new `event_id`, a fresh signature — is a replay: one session, one reply;
7. a delivery timestamped outside the five-minute window is `401 outside-window` and records nothing;
8. one inside the window is accepted;
9. a body changed after signing is `bad-signature`, and no signature at all `missing-signature`, and
   neither records a delivery;
10. a message in a channel the filter does not watch is skipped, naming the filter;
11. a bot's own message in a watched channel starts nothing (the loop guard);
12. a message already in a thread is answered in that thread;
13. an `@mention` opens one session, and its `message` twin is a replay;
14. a signed payload that carries no event is answered `200` and ignored;
15. a delivery whose reply landed but whose acknowledgement was lost is `500 write-back`;
16. its retry is processed, reads the thread, posts no second reply and reuses the session;
17. opening the session's PR over RPC (the fake GitHub answers) posts its link in the thread that
    started the session, once, and a repeat of the step (`already-open`) posts nothing more;
18. that PR is the fake GitHub's one PR for the session's repo;
19. (`unconfigured`) with the signing secret unset a delivery and the handshake are `503`, naming
    `SLACK_SIGNING_SECRET`, and record and open nothing.

**What proves it works.** `.verify/evidence/lob-259/` (`slack-configured.log`, `slack-unconfigured.log`,
`slack-*-observed.json`, `slack-ledger.json`, `slack-github-ledger.json`, the API logs) — 19/19 and 2/2
on Postgres 5442 with faux. `packages/core/src/Slack.test.ts` proves what the drive does not: the
payload reading (a threaded message, a bot message, an edit, a mention, a non-message event, the
handshake), the filter's reasons and its env form, the derived delivery id (one message is one
delivery however often Slack retries it), the signature verdicts one at a time, the all-or-none
config gate, the two requests' shape including Slack's trap of answering `200 {ok: false}` for a
logical refusal, and `SlackSessionWriteBack` against the real `sessions` table (the PR link in the
thread, once; nothing for a session no Slack message opened; a Slack that refuses does not fail the
step). `apps/api/src/Api/AdapterWebhooks.test.ts` serves the route in-process: the `503`s, the
handshake, `outside-window`, the filter read from the environment per request.

**Non-vacuity.** Two hand mutations, recorded beside the evidence of the in-process drive that
preceded the HTTP one (`.verify/evidence/lob-191/mutation-*.log`; the HTTP drive has the same checks
under other numbers):

- remove the filter's channel check (`if (!filter.channels.includes(channel)) …`) → the unwatched
  message is **processed** and starts a session, `16/18`: check 12 fails on `status=processed`, and
  check 14 fails because the session count moved. The drive's rule set deliberately contains a rule for
  the refused channel, so the filter — not "no rule matches" — is the only thing standing between that
  message and a session;
- remove the write-back's read-before-reply (`const already = false`) → the lost-acknowledgement retry
  posts a second reply, `17/18`, `repliesInThread=2`.

**What the signature check rests on.** `Slack.test.ts` asserts Slack's **documented** vector — the
`/webhook-collect` example body from Slack's "Verifying requests from Slack" page, its timestamp, the
page's signing secret and the `v0=` hex the page reports — so a wrong construction (no `v0:` in the HMAC
input, another separator, base64) fails there rather than agreeing with itself. That is the only place
the scheme is pinned to Slack's word; the drive's deliveries are signed with `slackSignature` and
verified by the adapter, which proves the plumbing, not the spelling.

**The PR link.** `SlackSessionWriteBack` is the session layer's write-back for Slack, beside Linear's
(`SessionWriteBacksAll`): when the PR step opens a pull request for a session a Slack message started
— found by the session's own request id, `trigger:slack:<channel>:<root>:<message>` — the PR's link is
posted in that message's thread, once per link. A step that opens none, or a session no Slack message
started, posts nothing. When a delivery opens a _card_ instead of a bare session (LOB-254, not landed
when this was written), the link belongs on the card's review step, and this is the seam to move it
to.

**The limits the fake cannot close.** That Slack accepts these `chat.postMessage` parameters, that the
Events API really re-sends a failed delivery with the same `event.ts` (the key this relies on, and
whether its `event_id` is re-stamped — the key does not depend on the answer), and that
`conversations.replies` pages as read (Slack's default 100-message page, so a longer thread's earlier
reply could be missed and answered twice). Recorded in `docs/testing-third-parties.md`.

**Three things an operator should know.** (1) The stale-delivery refusal is the route's: the drive posts
a correctly signed body 305 seconds old and gets `401 outside-window` with no delivery row. (2) A **human** reply inside a thread the bot answered also passes the filter and starts its own
session; that is by design (a person asking a follow-up in the thread is a new message), and the loop
guard only covers the bot's own posts, which arrive with `bot_id`. (3) A message is deduped by its
`ts`, so deleting and re-posting a message is a new delegation, while re-sending the same one is not.

**A write-back failure fails the delivery.** A refused reply is a `write-back` `TriggerError`, so the
seam gives the claim back and the sender's retry runs the work instead of reading `replayed: true`
about a session whose link nobody was told. Safe because the session's request id is
`trigger:<delivery id>`, so the retry reuses the session a failed attempt opened.
