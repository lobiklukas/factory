# `factory triggers ls`

**What it is.** What the trigger seam did with each delivery it received (T4): `factory triggers ls`
(also spelled `factory triggers deliveries`) reads `listTriggerDeliveries`, newest first, one
tab-separated row per delivery:

`received-at  source  status  delivery  session  card  reason`

`status` is `processed`, `skipped`, or `received` (a claim with no outcome yet: in flight, or left by
a process that died). `reason` is the seam's own sentence, unchanged — why a skip started nothing
(`no rule matches labels [x]`, `repo acme/x is not registered`, …) or which rule routed a processed
one — and a processed delivery names the `session` it opened or the `card` it filed or found. A cell
with no value prints `none`, so a row never shifts. `--status`, `--source` filter (a word that is not
one of the server's is `invalid_input` before any request), `--limit` sizes the page, and when more
exist `cursor: …` is printed on **stderr** (so `cut` never takes it for a row) for `--cursor`.

A delivery refused before the seam (a wrong signature `401`, a body over the cap `413`, a route with no
secret `503`) is logged by the API and never recorded, so it is not listed — by design.

**How a user reaches it.** `factory triggers ls --status skipped`: "my labelled issue started nothing".

**How the skill drives it.** `./triggers.sh`, self-contained (its own API on `:9395`, `TRIGGERS_PORT`,
booted with `TRIGGER_SECRET` and two rules, one to a registered repo and one to a repo nobody
registered). It posts signed generic webhooks with `curl` and reads them back in a tmux terminal and
piped (the tab is the separator). Checks, all required:

1. The deliveries took: one processed with a session id, two skipped, a wrong signature `401`.
2. `triggers ls` exits 0 with the header.
3. The processed delivery is a `generic` row naming its session, no card.
4. Its reason is `rule "t4-ok" (env:TRIGGER_RULES[0]) mapped it to <repo>`, verbatim.
5. The unmapped label's skip: `no rule matches labels [t4-nothing]`, no session.
6. The unregistered repo's skip: `repo <ghost> is not registered`.
7. The forged delivery is not in the list.
8. Newest first: the ghost skip, the unmapped one, the processed one.
9. `--status skipped` lists the skips and not the processed delivery; every row it prints is skipped.
10. `--status processed --source generic` keeps the processed delivery and drops the skips;
    `--source linear` drops this run's generic rows; `triggers deliveries` is the same command.
11. `--limit 1` prints one row and a stderr cursor; `--cursor` continues with the next row.
12. A bad `--status`, a bad `--source` (refused with `--api` pointing at a dead port: no request) and a
    cursor the server did not mint (`trigger_delivery_error`) fail non-zero.

Evidence: `.verify/evidence/latest/cli/triggers-*.txt` and `triggers.json`. The rendering is unit
tested in `apps/cli/src/commands/triggers.test.ts`.
