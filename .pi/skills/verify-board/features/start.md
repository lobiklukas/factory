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

`--prompt` sends the run its first message as soon as it is opened (LOB-73), and prints one more
line; without it the run opens idle and waits for a message from the dashboard or `factory send`:

```sh
factory board start --task tsk_0123456789abcdefghjkmnpqrs --prompt "specify this card"
# session ses_0123456789abcdefghjkmnpqrs
# task    tsk_0123456789abcdefghjkmnpqrs in specifying
# sent    specify this card
```

## How the skill drives it

The driver asserts exit 0, a `ses_…` id on stdout, and a `task … in specifying` line naming the
column the previous move put the card in — the proof that the session is bound to the card and not
opened as a scratch session. `--prompt` is driven by `./ask.sh` (features/ask.md): both of its runs
are started with it, and the drive checks the `sent …` line and that the run then works.

## What it does not prove

Nothing about what the run _does_: `MODEL_BACKEND=faux` scripts the model, and the transcript, tools
and gates of a real run are `.pi/skills/verify-cli`'s and `verify-api`'s to prove. Nor does it prove
the card's column advances on completion — no MVP column auto-advances (nothing starts itself).
