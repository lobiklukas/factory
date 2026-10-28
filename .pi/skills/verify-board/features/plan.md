# The planning run's plan — on the drive's card

**Status: passing** (D10, 2026-10-28, `agent/D10`).

## What it is

B4's `planning` column exits on "a plan doc **and** a human move": the human move is B5's plan
approval gate, and the plan is what the person approves. A run whose column declares the `planner`
role is a **read-only stage** — its row in the role policy table (`packages/harness/src/rolePolicy.ts`)
says `readOnly` and `writesPlan` — so it is offered no `write`, `edit` or `verify`, its `bash` may only
read, and it is offered the **`plan` tool** (`packages/harness/src/planning.ts`). The tool validates a
typed plan — `summary`, `steps` (at least one), `surfaces` (at least one) and `risks` (required, `[]`
when there are none) — commits it as the run's `factory.plan` and records it on the card as a
`planned` event, idempotently per tool call. `plan_doc` is now a checked exit key: `planning →
building` is refused naming it until the card holds a plan. `getTaskPlan`, `factory board show` and
the card pane's **Plan** section read the newest plan. `0044_seed_plan_skill.ts` binds the seeded
`plan` skill to `planning` on `default`'s newest version + 1 (v6 over the seeded v5).

## How a user reaches it

```sh
factory board move --task tsk_… --to building --expect-revision 9 --actor person:…  # refused: plan_doc
factory board start --task tsk_… --prompt "plan this card"                         # the planner plans
factory board show --task tsk_…        # plan <ses_…> from planning (revision 9), steps, surfaces, risks
                                       # leaves planning when: plan_doc: met
```

and in the dashboard, the card pane's Plan section beside the Spec.

## How the skill drives it

`./up.sh` gives the `planner` role its own faux model (`ROLE_MODELS=…,planner=faux/planner`) whose
`FAUX_MODEL_SCRIPTS` row reads the checkout (`ls`, a read the stage lets through) and then calls
`plan`: first without `risks`, then the whole plan, recorded in `.verify/run/faux-plan`. Fixed, like
`FAUX_COMMAND`.

`./drive.sh`, after the card is moved into `planning` and before the run's gate refusal:

1. A person's `board move --to building` is refused, `requirement_unmet` naming `"plan_doc"` and "the
   card has no plan", non-zero.
2. `board start --prompt 'plan this card'` opens the planner run, `task … in planning`.
3. `plan.ts`: the run settles on its own answer; its log's offered tools hold `plan` and `read` and
   none of `write`, `edit`, `verify`; its first `plan` result is "plan refused: `risks` is missing —
   declare the risks, `[]` when there are none" and its second was accepted; the run's log
   (`readSessionLog`'s `plan`) and `getTaskPlan` both hold the accepted plan, by this run, from
   `planning`; the card is still in `planning` (a person approves the plan).
4. `board show` prints `plan      <ses_…> from planning (revision N)`, `steps: 2`, the risk, the card a
   revision on, and the exit checklist's `plan_doc: met`.
5. `plan-pane.mjs`: the card pane's Plan section shows the server's plan verbatim, its steps numbered.

Every later phase runs at the plan's revision: the run's gate refusal, the dashboard's read, and the
person's plan approval in the both-ways page. `board runs` lists the planner run between the build
run and the specifying runs.

`./requires.sh` proves the refusal on its own card: with no plan, `planning → building` is refused
naming `plan_doc` and writes nothing (`plan      -` in `board show`); once a plan is declared in-process
(`.pi/skills/lib/seed-plan.ts`, the tool's own `TaskService.declarePlan`) the same move goes through.

## Observable end state

`plan-declared.json`, `plan-pane.json` and `plan-pane.png`, `show-planned.txt`, `move-unplanned.txt`
in `.verify/evidence/latest/board/`; `requires-planning-none.txt` and `requires-plan.json` from
`requires.sh`. Last run: `./drive.sh` exit 0 (**169** PASS) and `./requires.sh` exit 0 (**75** PASS),
API on `:9550`/`:9551`, web on `:3550`.
