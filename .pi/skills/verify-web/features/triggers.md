# Triggers (the deliveries page)

**Status: passing.** `/triggers` shows what the trigger seam did with each webhook it received, newest
first (T4): the page an operator opens when a labelled issue started nothing. The rail's **Triggers**
section (the webhook icon) opens it. It is the dashboard's face for `listTriggerDeliveries`;
`factory triggers ls` is the CLI's ([verify-cli's triggers.md](../../verify-cli/features/triggers.md)).

## What is shown

- **The list** is `listTriggerDeliveries` and nothing else, polled every 5 s (`TRIGGERS_POLL`): the
  newest 50 for the chosen filter. A row is `[data-delivery=<delivery id>]` with
  `data-delivery-status` (`processed`, `skipped`, `received` shown as _in flight_) and
  `data-delivery-source`. It carries the outcome, the source, the time (UTC, to the second), the
  **reason verbatim** (`[data-delivery-reason]`: the seam's sentence, never reworded) and the delivery
  id. A processed delivery links the session it opened (`[data-delivery-session=<id>]`, to
  `/sessions/<id>`) or shows the card it filed or found (`[data-delivery-card=<id>]`).
- **Filters.** Outcome chips (`[data-triggers-status=all|processed|skipped|received]`) and a source
  select (`[data-triggers-source]`) send the server's own `status` / `source`. A filter that matches
  nothing says what emptied it (`[data-triggers-empty]`); with no filter it says that a webhook refused
  before the seam (wrong signature, oversized body, a route with no secret) is logged by the API and
  never recorded.
- **Show older** (`[data-triggers-older]`) reads the next page by the server's cursor and appends it,
  each delivery once (a poll that moved a page boundary does not duplicate a row); the pages are
  dropped when a filter changes, and the button goes when the last page is in.
- A failed poll keeps the last answer on screen with `[data-triggers-stale]`.

## Driving it with triggers.sh

`./triggers.sh` owns its own API and dashboard (`TRIGGERS_API_PORT`, default 9461, and
`TRIGGERS_WEB_PORT`, default 3461), the API booted with `TRIGGER_SECRET` and two rules (a registered
repo, and one nobody registered). It posts signed generic webhooks from the drive; nothing leaves
loopback. `triggers.mjs` requires, in a real browser:

1. **Seed.** One delivery starts a session; one label no rule claims and one rule naming an
   unregistered repo are skipped; 55 more unmapped ones make a second page; a wrong signature is `401`.
2. **Navigation.** The rail's **Triggers** opens `/triggers` and is marked `aria-current`.
3. **List.** The shown ids are the RPC's first page, in its order; the forged delivery is nowhere.
4. **Show older.** Appends the RPC's next page in order with no repeats; after the last page the
   button is gone and the three seeded deliveries are listed.
5. **Verbatim reasons.** `no rule matches labels [t4-nothing]` and `repo <ghost> is not registered`,
   character for character; the processed row shows its routing reason and names its session, equal
   to the RPC's.
6. **Filters.** _Skipped_ shows only skips (equal to the RPC's skipped page) and drops the older pages;
   _Processed_ shows the processed ones; the session link opens that session; the source select
   narrows to `generic`; a combination the server answers with nothing says what emptied the list.
7. **Poll.** A delivery that arrives with the page open appears at the top without a reload.
8. No console error.

Evidence: `.verify/evidence/latest/triggers/` — `triggers-list.png`, `triggers-reasons.png`,
`triggers-empty.png`, `observed.json`, `api.log`, `web.log`. The list rules (`mergeDeliveries`,
`inputOfKey`, `emptyMessage`) are unit tested in `apps/web/src/lib/triggers-view.test.ts`. The
dashboard's first start can take over a minute on a loaded machine, so `triggers.sh` waits up to 120 s.
