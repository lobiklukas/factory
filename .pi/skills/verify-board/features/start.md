# `factory board start`

**Status: passing.**

## What it is

The run that advances a card. A run is exactly one Pi Durable session (docs/board.md B1), so starting
one is `createSession` with the card named: the session carries the `factory.task` document, the run
row is written against the card, and the column the run started in is the one whose `requires[]` it
must satisfy on exit. The card is **not** moved — a card moves when a person moves it, with the run's
evidence in hand.

## How a user reaches it

```sh
factory board start --task tsk_0123456789abcdefghjkmnpqrs
# session ses_0123456789abcdefghjkmnpqrs
# task    tsk_0123456789abcdefghjkmnpqrs in specifying
```

`--column` overrides the column the run is recorded in, for a run started out of its lane.

A run is put to work when it opens (C6). With no `--prompt`, the first message is the card's default
prompt — its title, its body when it has one, and the column's instruction (which column the run works
in, and the `requires[]` the card must satisfy to leave it) — built by `runPrompt` in `@repo/domain/Task`,
the function the board page's **Start run** pre-fills its field with, so the same card started from either
door has the same first message. The command prints one more line:

```sh
factory board start --task tsk_0123456789abcdefghjkmnpqrs
# session ses_0123456789abcdefghjkmnpqrs
# task    tsk_0123456789abcdefghjkmnpqrs in specifying
# sent    Pin the Postgres major (the card's default prompt)
```

`--prompt` replaces the default with the words given (LOB-73), and `sent` echoes them:

```sh
factory board start --task tsk_0123456789abcdefghjkmnpqrs --prompt "specify this card"
# sent    specify this card
```

`--idle` opens the run and sends nothing: it waits for a message from the dashboard or `factory send`.
It cannot be combined with `--prompt`. The column's instruction is read from the definition version the
card pinned; a definition that cannot be read costs the default prompt its instruction line, never the run.

## How the skill drives it

The driver asserts exit 0, a `ses_…` id on stdout, and a `task … in specifying` line naming the
column the previous move put the card in — the proof that the session is bound to the card and not
opened as a scratch session. `--prompt` is driven by the drive's specify phase
([specify.md](specify.md)) and by `./ask.sh` ([ask.md](ask.md)): every run in both is started with
it, and the drives check the `sent …` line and that the run then works.

`--budget <usd>` (C23) caps the run's spend: it goes on the `createSession` that opens the run, so the
session's `budget.cap` records it, and `budget  $2.5000` is printed after the `task` line. A cap of zero
or less is refused before anything is opened. Without it the server's default cap applies, if it has one.
The card pane's Start run has the same Budget field (blank is no cap of the run's own). A stopped run's
cap is raised with `factory budget <session> --cap <usd>` or the pane's **Raise cap**; `./budget.sh` drives
both doors, the stop and the raise against a priced faux (`FAUX_COST=0.01 ./up.sh`).

`./start-prompt.sh` (C6) is the no-`--prompt` proof: two cards with one title and body, one started with
`factory board start` and one from the board page (**Start run**, which opens a field holding the card's
default prompt, then **Send**). It reads each run's first `user` (`pi.user`) entry back from `getSession`
and requires both to hold the card's title, body and the column's instruction, to be byte-identical, and
both runs to be `busy`; the page must have sent `createSession` as `dashboard` then one `sendMessage`
carrying exactly the field's text. A third card proves an edited field is sent as typed and that Cancel
opens no run, and a fourth that `--idle` opens a run with no user entry. `triage.sh` starts its gate
card's run with `--idle`, because a bare start would leave that run busy.

## What it does not prove

Nothing about what the run _does_: `MODEL_BACKEND=faux` scripts the model, and the transcript, tools
and gates of a real run are `.pi/skills/verify-cli`'s and `verify-api`'s to prove. Nor does it prove
the card's column advances on completion — no MVP column auto-advances (nothing starts itself).
