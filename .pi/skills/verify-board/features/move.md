# `factory board move`

**Status: passing.**

## What it is

A declared transition, at the revision the caller last read (docs/board.md B3, B5). `--expect-revision`
is required and has no default: the revision is the only protection against two people clobbering each
other, and a default would silently pick one of them. `--actor` defaults to `cli` — a person; a run's
actor is its session id, and a run cannot cross either human gate.

## How a user reaches it

```sh
factory board move --task tsk_… --to specifying --expect-revision 1
# moved tsk_… to specifying (revision 2)

factory board move --task tsk_… --to planning --expect-revision 1
# error: stale_revision: task tsk_… is at revision 2, not 1: someone moved it first   (exit 1)

factory board move --task tsk_… --to done --expect-revision 2
# error: undeclared_transition: column "specifying" declares no transition to "done"   (exit 1)

factory board move --task tsk_… --to building --expect-revision 3 --actor ses_…
# error: human_gate_required: the move planning → building crosses the plan approval gate, which only a person can make   (exit 1)
```

## How the skill drives it

The three refusals — the three ways a move is supposed to fail (LOB-84) — each asserted by the
service's `message` matched verbatim on the pane, and by a non-zero exit:

1. A declared move `intake → specifying` (exit 0, the new column and revision on stdout).
2. **Stale revision**: `specifying → planning` at the revision the card had _before_ that move —
   `task … is at revision 2, not 1: someone moved it first`.
3. **Undeclared transition**: `specifying → done` — `column "specifying" declares no transition to
"done"`, both columns named.
4. `board start` opens a run on the card (features/start.md), which asks; a person answers it, a
   second run is told the answer (specify.md), and a person then moves the card on to `planning` at
   the revision `board show` printed after the answer (exit 0, the revision read off the `moved …`
   line).
5. **A run crossing a human gate**: `planning → building` with `--actor` set to the session id
   `board start` printed — `human_gate_required: the move planning → building crosses the plan
approval gate, which only a person can make`, matched with its code.
6. `board show` afterwards: the card is in `planning` at the revision step 4 returned, so none of
   the refusals wrote anything. The dashboard phase reads the same card back (dashboard.md).

## What it does not prove

A person crossing a gate, or the merge gate (`review → done`), in this phase: the move phase leaves
the card in `planning`, so the dashboard phase reads a card whose next move is the gate the run was
refused. The drive's later phases take the same card on — a person's `planning → building` (in the
browser, [equivalence.md](equivalence.md)), then a
run refused `review → done` and a person's merge going through — in [build.md](build.md).

That the run exists: the service treats any well-formed `ses_…` id as a run actor (TaskService's
`isRunActor`) and does not look the session up. The drive uses the id `board start` printed so it
does not invent one, not because the refusal depends on it.

Nor does it prove `requires[]` refusals: the drive's card is on the default pipeline's newest
version (v3, `./up.sh` seeds it with `SEED_DEFINITION_VERSION=newest`), whose `review` requires
`verified`, but none of this phase's moves leaves a column that declares a checked requirement. The
refusal is `./requires.sh`'s, in [requires.md](requires.md); the drive's build phase
([build.md](build.md)) satisfies `verified` and crosses it.
