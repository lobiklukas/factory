---
name: verify-workflow
description: Prove the whole factory loop on one card (LOB-40, milestone L) — a Linear issue labelled for the factory becomes a card through the real webhook and label-to-repo mapping, a person moves it through specify, plan approval and build, the builder's gated `git commit` waits on an approval that survives an API restart, the run pushes `factory/<session-id>` with the CredentialProvider token and opens exactly one PR with its verification evidence, Linear gets the PR link and its state changes with no duplicate comment, the reviewer passes, the merge completes the card, and the session list and spend pane show status, repo, duration and cost. Builds on verify-board's instance. Faux by default (loopback Linear, GitHub and git forge, no credentials); `--live` is the owner's run against real Linear, GitHub and Anthropic. Use when asked to prove the workflow end to end, before trusting the factory with its own backlog (LOB-41), or after changing anything a card crosses on its way from a tracker to a merged PR.
---

# Verify the whole workflow

Every surface has its own drive, and each can be green while the loop is broken: the contracts
right per surface and wrong end to end. This drive walks one card through all of them, in order,
on one instance, and records a check per step.

It is not a second launcher. The control plane, the dashboard, the seeded board, the GitHub fake
and the probes are `.pi/skills/verify-board/`'s (`up.sh`, `down.sh`, `seed.ts`, `build.ts`,
`review.ts`, `merge.ts`); this skill adds what that instance lacked — a Linear trigger and write-back,
a forge a real `git push` reaches, an approval gate, a cost and a scratch database — through the
seams verify-board's `up.sh` names in its header, and the drive that strings them together.

## What it proves

| Step                                   | Check in `drive.ts` (phase)                                                                                                                                                                                       | Issue                |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| 1. a Linear delegation, one card       | an unlabelled `create` starts nothing; the `update` adding the label files one card in intake bound to the rule's repo and `main`, no session; a redelivery, and the label removed and added again, file none (1) | LOB-14, LOB-164, 254 |
| 2. specify → plan approval → build     | a person's moves; the run asks (an elicitation in Linear too) and a person answers; spec and plan declared; the run's own `planning → building` refused at the gate (2, 3)                                        | LOB-42, LOB-85, D10  |
| 3. its own worktree                    | the build run's checkout is a linked worktree of the registered repo on `factory/<session-id>`, not this tree; the change lands there and nowhere else (4, 5)                                                     | LOB-11               |
| 4. a gated call, approval, restart     | `git commit` refused by policy, one approval pending; SIGKILL, restart; still pending, one request in the log; `factory approve` resumes it, decision and actor recorded (4)                                      | LOB-8, LOB-9, LOB-52 |
| 5. push, one PR, retry-safe            | the forge holds `factory/<session-id>` at the worktree's tip, pushed with the token only; one create request, one PR; `factory pr` again is `already-open` (5)                                                    | LOB-10, LOB-54, C17  |
| 6. the evidence block                  | `build.ts MODE=pr`: the body's Changed files and Verification (`verify-web`: exit 0), the builder's model (5)                                                                                                     | LOB-16               |
| 7. Linear write-back                   | In Review with the PR attached and one comment carrying its link and marker; still one after the retry; Done after the merge, still one comment (5, 6)                                                            | LOB-15               |
| 8. list and spend                      | every run of the card in `listSessions`: idle, the repo, a duration, a cost; `listSpend` for the repo adds up to them; `factory ls` and `factory spend` print them (7)                                            | LOB-6, LOB-17        |
| review and merge                       | the run moves the card to review; GitHub's signed `opened` starts a reviewer that passes the head (`review.ts`); the merge, delivered twice, moves the card to done once                                          | LOB-241, C20         |
| `--live` refuses without its variables | `packages/storage-postgres/src/verify-workflow-live.test.ts`: each of `up.sh`, `doctor.sh`, `drive.sh --live` names every missing variable, exit 2, never a value                                                 | LOB-40               |
| nothing left behind                    | `cycle.sh`: after each `down.sh`, no recorded process alive, no port held, the scratch database dropped                                                                                                           | LOB-40               |

Every check is required; `drive.sh` exits non-zero when one fails, and `cycle.sh` when a drive fails
or a `down.sh` leaves anything.

## Launch

```sh
./up.sh            # faux: verify-board's API (:9610) and web (:3610), GitHub fake (+1), Linear fake (+2),
                   # git forge (+3), a scratch database <base>_wf_<stamp>, one board over the fixture
./doctor.sh        # read-only: verify-board's doctor (Postgres first, loudly), the scratch database, the fakes
./drive.sh         # the whole loop; evidence in .verify/evidence/latest/workflow/
./down.sh          # stops only what up.sh started and drops the scratch database it made
./cycle.sh         # up → drive → down, twice, then proves each down.sh left nothing behind
```

Ports: `API_PORT`, `WEB_PORT`, `GITHUB_PORT` (`API_PORT+1`), `LINEAR_PORT` (`+2`), `GIT_PORT` (`+3`).
`DATABASE_URL` names the base database; the scratch one is made beside it on the same server, over
TCP (`scratch-db.ts`), and is the only one `down.sh` ever drops — by the name `up.sh` recorded, and
only a `<base>_wf_<digits>` name. verify-board's files stay in `.verify/run`, so run one board
instance at a time (as verify-board says): `up.sh` refuses, before it makes anything, when one is
running, and `down.sh` stops verify-board's instance only when `up.sh` launched it (the `board-owned`
marker). The workflow's own files are in `.verify/run/workflow`; `instance.json` is written and read
as JSON, so the label and the gate may hold commas or quotes.

What `up.sh` adds on verify-board's instance, all through variables its `up.sh` hands the API:

- **`TRIGGER_RULES`**: the label `factory` → the board's repository, base ref `main`, `card` mode
  (LOB-254): a delegated issue is a card and opens no session until a person starts it.
- **Linear**: `linear-api-fake.ts` on `LINEAR_PORT` (`LINEAR_API_URL`, a key it never checks) and a
  fresh `LINEAR_WEBHOOK_SECRET` the drive signs its deliveries with, as Linear signs them.
- **The forge**: `git-forge-fake.ts` — bare repositories over git's smart HTTP behind a gate that
  answers 401 to anything but the instance's token — holding a bare clone of verify-board's fixture.
  The repository is registered with that URL (`SEED_REPO_SLUG`, `SEED_REPO_URL`), so the worktree is
  cut from the forge's `main` and the PR step's push is a real `git push`. The GitHub fake reads the
  same root (`BOARD_GITHUB_GIT_ROOT`), so it refuses a PR whose head was not pushed.
- **The gate**: `APPROVAL_REQUIRED="git commit"` — the faux builder's commit (verify-board's
  `BUILD_CHANGE`) waits for a person — and `FAUX_EVERY_TURN=true`, so the resumed builder retries it.
- **A cost**: `FAUX_COST=0.01`, a cent per faux answer.

`restart-api.sh [KILL|TERM]` restarts the API in place (verify-board's `up.sh --restart-api`) under the
environment `instance-env.sh` rebuilds from what `up.sh` recorded; the drive calls it mid-build.

## Drive

`drive.ts` runs seven phases, each a block of checks (`observed.json`); see its header for each step.
A person's steps are the commands a person types — `factory board move|start|comment`, `factory
approvals`, `factory approve`, `factory pr`, `factory ls`, `factory spend` — each kept as
`<step>.txt`; the facts no command prints are read over RPC (`getTask`, `listApprovals`,
`listSessions`, `listSpend`), from the instance's database (the approval's row and its commits in the
log) and from the three ledgers. The faux run takes about 40 s.

## Evidence

`.verify/evidence/latest/workflow/` (gitignored; `EVIDENCE_DIR` overrides `.verify/evidence/latest`):

- `observed.json` — every check with its detail
- `summary.json` — the card, the Linear issue, every session id, the build run's branch and transcript
  head, the PR URL, the Linear comment id (on the fake, which keeps no ids, the comment's marker
  `factory:<session>:pr`, which is how the sync finds it again), the approval before and after the
  restart (request, index row, commits in the log, API pid), the session rows and the spend rows
- `report.md` — the run in a few lines: wall-clock time, total cost, PR, issue; the text to post on
  LOB-40 after the live run
- `linear-*.json` (each delivery and its answer), `<step>.txt` (each CLI call), `restart-api.txt`,
  `build-{settled,pr}.json`, `pr-body.md`, `review-workflow.json`, `merge-workflow.json` (verify-board's
  probes), `linear-ledger.json`, `git-ledger.json`, `github-ledger.json`, `api.log`
- `../workflow-run-<n>/` and `../workflow-cycle.json` — `cycle.sh`'s runs and what each `down.sh` left

## Live run (the owner's)

The faux drive proves the code end to end; the live run proves it against the real services, once,
with a real model. It is the owner's: it needs their credentials, and no agent runs it.

**What to create first.** The control plane learns about Linear and GitHub only through their
webhooks (there is no polling path in the code), so both need a public URL that reaches the API:

1. **A tunnel** to the API's port, e.g. `cloudflared tunnel --url http://localhost:9610`; its https
   URL is `WORKFLOW_PUBLIC_URL`.
2. **A scratch GitHub repository** (`WORKFLOW_GITHUB_REPO=owner/name`) with a `main` branch (initialize
   it with a README). A fine-grained token on it with Contents and Pull requests read/write is
   `GITHUB_TOKEN`. Add a webhook: payload URL `$WORKFLOW_PUBLIC_URL/webhooks/github`, content type
   `application/json`, a secret (`GITHUB_WEBHOOK_SECRET`), events _Pull requests_ and _Pull request
   reviews_.
3. **Linear**: a label `factory` in the team (or name another in `WORKFLOW_LINEAR_LABEL`); a personal
   API key (`LINEAR_API_KEY`); a webhook (Settings → API → Webhooks) at
   `$WORKFLOW_PUBLIC_URL/webhooks/linear` for _Issues_, whose signing secret is `LINEAR_WEBHOOK_SECRET`.
   The team's states must be named Todo, In Progress, In Review and Done, or export
   `LINEAR_STATE_STARTED`, `LINEAR_STATE_IN_REVIEW` and `LINEAR_STATE_DONE` (the drive waits for
   the same names the API moves the issue to).
4. **Anthropic**: `ANTHROPIC_API_KEY` (or `ANTHROPIC_OAUTH_TOKEN` / `ANTHROPIC_AUTH_TOKEN`).

`live-env.sh` lists them; `./doctor.sh --live` names every one that is missing, and `up.sh`,
`drive.sh` and `cycle.sh --live` refuse without them. Nothing reads or prints their values.

**The one command**, with those exported, the tunnel up and Postgres on 5442:

```sh
DATABASE_URL=postgres://factory:factory@localhost:5442/factory .pi/skills/verify-workflow/cycle.sh --live
```

It starts the instance (the anthropic backend, real Linear and GitHub, `APPROVAL_REQUIRED="git
commit"` unless `WORKFLOW_APPROVAL_REQUIRED` names another gate — a comma-separated list of command
prefixes, as `APPROVAL_REQUIRED` is), then the drive asks for two things in the terminal: label an
issue in Linear (and then remove and re-add the label: the drive waits until the removal's delivery is
recorded in the scratch database, then for three minutes in which no second card may appear), and,
once the reviewer has passed, merge the PR in GitHub. After `factory approve` it waits up to 20
minutes for the resumed builder's PR step to answer before it reads the PR. It drives every other step itself, then stops
the instance and drops its scratch database.

**Afterwards**, post `.verify/evidence/latest/workflow/report.md` on LOB-40 as a comment: it carries
the wall-clock time from `up.sh` to the end of the drive, the total cost from `listSpend`, the PR and
the issue. That is item (d) of LOB-40.

What the live drive does not assert, because a real model chooses: the exact question, spec and plan,
or that the model asks at all (it answers a question if one is asked). A model that never runs `git
commit` never meets the gate, and the gate's check fails — that is a real finding, not a flake. Linear's
agent-session elicitation needs an OAuth app actor; with a personal key it may be refused, which the
write-back logs and the drive does not check live.

## Not in CI

The faux drive needs no credentials and takes about a minute with its launch, but it is not in the
required `gate`: it starts a Vite dev server, a git `http-backend` and three loopback fakes that have
never run on a hosted runner, and a required check that has not been seen green there would block
every merge the first time it is not. `cycle.sh` is the command a CI job would run; see LOB-40's
comments for the follow-up.

## Gotchas

- **The approval is a request, not a deny.** The gate refuses the call and asks; the run settles
  _parked_ (its PR is held, `SessionService.settlePullRequest`), and `factory approve` resumes it with a
  message, on which the faux builder (`FAUX_EVERY_TURN`) makes the same call, now approved, once.
- **The restart is the API's alone.** `restart-api.sh` kills the recorded pid and starts the same
  launch; the dashboard, the fakes, the fixtures and the database stay. The approval's survival is
  read from the index row and the log, not from the process.
- **A card, not a session.** The rule is in `card` mode, so the delegation opens nothing and writes
  nothing to Linear; the issue moves when the run opens its PR (In Review) and when the PR merges
  (Done). The faux drive therefore sees Todo → In Review → Done, never In Progress.
- **One card per instance.** The checks count the board's cards and the repo's sessions, so a second
  drive against the same instance fails its first checks by design: `./down.sh && ./up.sh`, or
  `cycle.sh`.
- **verify-board's `drive.sh` is not run here.** It makes its own card with `board add` and proves the
  CLI in a tmux pane and the dashboard in a browser; this drive's card comes from Linear, so it reuses
  verify-board's instance and probes and leaves the terminal and browser proofs to that drive.

## Cleanup

```sh
./down.sh        # the fakes by pid, verify-board's down.sh, then the scratch database by name
```

Never kill by process name, never drop a database by pattern. Evidence is kept.
