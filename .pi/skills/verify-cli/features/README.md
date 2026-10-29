# Feature map — CLI

One file per user-facing feature of `factory`. Each answers: what it is, how a user reaches it, how
the skill drives it, and what observable end state proves it works.

`factory mcp` (an MCP server on stdio for a local agent) and `factory handoff` (the checkout's work in
progress as a card whose run starts on it) were verified **2026-10-28** from the
`agent/S-local-agent-handoff-mcp` worktree with `./mcp.sh` (API on `:9530`) — **22/22** checks
([mcp.md](mcp.md)), Claude Code 2.1.312's own `claude mcp get` health check among them.

`factory skill ls` / `show` / `put` were verified **2026-10-28** from the `agent/D7` worktree with
`./skill.sh` (API on `:9520`) — **16/16** checks ([skill.md](skill.md)) — and `./drive.sh` (API on
`:9520`, approve on `:9522`, the seed's GitHub fake on `:9523`) at **31/31**, one check being
`./skill.sh`. Under that machine's load the drive's first run lost "watch labels a session this
process owns live" to the 5 s idle window (the sweep released the owner before `watch` attached);
it passed with `SESSION_IDLE_TIMEOUT_MS=15000` given to `./up.sh`.

`factory run --model` and `DEFAULT_MODEL` were verified **2026-10-28** from the `agent/LOB-274`
worktree with `./model.sh` (API on `:9500`, the refused boot on `:9501`) — **12/12** checks — and
`./drive.sh` (API on `:9502`, approve on `:9503`) at **23/23**, which adds the `model` line.

`factory replay` (a session's task run again on another model, with the comparison printed) was verified
**2026-10-28** from the `agent/LOB-200` worktree with `./replay.sh` (API on `:9570`) — **21/21** checks, twice on the same database. A
mutation run (the source and replay columns swapped) failed 3 of them: the session row, the model row and
the turns-delta arithmetic; the cost-delta arithmetic check was proven by hand against a wrong sign.

`factory repo add --url` / `repo sync` / `factory doctor` (a URL-only repo cloned into the factory's cache)
were verified **2026-10-28** from the `agent/LOB-265` worktree with `./clone.sh` (API on `:9660`, the
loopback git forge on `:9661`) — **21/21** checks.

`factory doctor` (the E8 preflight: every prerequisite, one line each) was verified **2026-10-28** from the
`agent/E8` worktree with `./preflight.sh` (API on `:9570`, degraded on `:9571`) — **23/23** checks.

`factory fork` / `reset` / `compact` / `spend` were verified **2026-10-28** from the `agent/C15`
worktree with `./session.sh` (API on `:9580`, re-run after merging main with D7's `factory skill`) —
**29/29** checks, which include `watch --ids` / `history --ids` printing the entry id `fork --at` takes
(matched against the RPC's). A mutation run (`--at` and `--note`
dropped before the RPC) failed 4 of them: the fork prefix, the refused entry, the reset marker and the
transcript order.

`factory run --open-pr` and `factory show` (F17, F19, F20) were verified **2026-10-29** from the
`agent/F17-F19-F20` worktree with `./open-pr.sh` (API on `:9552`, the GitHub fake on `:9553`) — **7/7**
checks — and `./repo-context.sh` (API on `:9554`) — **8/8** ([show.md](show.md), [run.md](run.md)).

`factory discard` was verified **2026-10-28** from the `agent/LOB-268` worktree with
`./discard.sh` (API on `:9541`) — **11/11** checks.

`factory repo add` / `ls` / `show` were verified **2026-10-28** from the `agent/LOB-253` worktree:
`./drive.sh` (API on `:9520`, approve on `:9522`, the seed's GitHub fake on `:9523`) **22/22**, one
check being `./repo.sh` at **17/17**. A mutation run (every path read as a git work tree) failed 4 of
the 17: the refusal, its path, the `repo_not_found` that proves nothing was written, and the refused
slug's absence from `repo ls`. After review, `./repo.sh` was re-run alone (API on `:9520`) at
**20/20**: the added checks are the `work-tree` line, a path inside a checkout naming the enclosing
work tree, and the tab-separated `repo ls` piped to a file.

`factory approvals` / `approve` / `deny` were verified **2026-10-27** from the `agent/LOB-53`
worktree: `./drive.sh` (API on `:9530`) **21/21**, its last check being `./approve.sh` (API on
`:9531`) at **18/18**.

`factory send --when-busy steer` / `--when-busy reject` were verified **2026-10-27** from the
`agent/LOB-167` worktree with `./steer.sh` (API on `:9541`, `FAUX_SLEEP_MS=8000`) — **13/13** checks.
A mutation run with the nap off (`STEER_SLEEP_MS=0`) failed 9 of them.

`factory interrupt` was verified **2026-10-28** from the `agent/C8` worktree with `./interrupt.sh`
(API on `:9542`, `FAUX_SLEEP_MS=15000`) — **10/10** checks.

`factory send` / `factory withdraw` were verified **2026-10-27** from the `agent/LOB-166` worktree
with `./withdraw.sh` (API on `:9561`) — **13/13** checks — and `./drive.sh` re-run there (API on
`:9560`) at 20/20.

`factory status`, the `model` line of `factory run` and the `model` column of `factory ls` were
verified **2026-10-28** from the `agent/LOB-272` worktree with `./drive.sh` (API on `:9550`, approve
on `:9552`) — all checks passed, including 7 new ones ([status.md](status.md)).

Status reflects the last verified run: **2026-10-27**, from the `agent/LOB-65` worktree, API on
`:9500` (not the usual `:9300`), the seed's GitHub fake on `:9503`, `MODEL_BACKEND=faux`,
`./drive.sh` in tmux — **20/20** required checks passed, including the PR column (LOB-65). A
mutation run (the row always printing `-`) failed "ls shows the recorded PR URL" with `pr=-`.

| Feature                                                                 | Status  | File                                                                                                                          |
| ----------------------------------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `factory run`                                                           | passing | [run.md](run.md)                                                                                                              |
| `factory run --model`, `DEFAULT_MODEL`                                  | passing | [model.md](model.md) (`model.sh`)                                                                                             |
| `factory run --open-pr`                                                 | passing | [run.md](run.md) (`open-pr.sh`)                                                                                               |
| `factory show`                                                          | passing | [show.md](show.md) (`repo-context.sh`)                                                                                        |
| `factory cost`, `factory run --cap-at-prediction`                       | passing | verify-api's [cost.md](../../verify-api/features/cost.md) (`cost.sh`)                                                         |
| `factory ls`                                                            | passing | [ls.md](ls.md)                                                                                                                |
| `factory status`, the model in `run` and `ls`                           | passing | [status.md](status.md)                                                                                                        |
| `factory watch`                                                         | passing | [watch.md](watch.md)                                                                                                          |
| Typed errors                                                            | passing | [errors.md](errors.md)                                                                                                        |
| `factory send` / `factory withdraw`                                     | passing | [withdraw.md](withdraw.md)                                                                                                    |
| `factory send --when-busy steer/reject`                                 | passing | [steer.md](steer.md)                                                                                                          |
| `factory budget`                                                        | passing | [budget.md](budget.md) (`verify-api/budget.sh`, `verify-board/budget.sh`)                                                     |
| `factory interrupt`                                                     | passing | [interrupt.md](interrupt.md) (`interrupt.sh`)                                                                                 |
| `factory approve` / `deny`                                              | passing | [approve.md](approve.md)                                                                                                      |
| `factory discard`                                                       | passing | [discard.md](discard.md)                                                                                                      |
| `factory replay`                                                        | passing | [replay.md](replay.md)                                                                                                        |
| `factory fork` / `reset` / `compact` / `spend`                          | passing | [session.md](session.md)                                                                                                      |
| `factory repo add --url`, `repo sync`, `doctor`                         | passing | [clone.md](clone.md)                                                                                                          |
| `factory doctor` (preflight)                                            | passing | [doctor.md](doctor.md) (`preflight.sh`)                                                                                       |
| `factory pr`                                                            | passing | [verify-board build.md](../../verify-board/features/build.md)                                                                 |
| Feature                                                                 | Status  | File                                                                                                                          |
| -----------------------------------------------                         | ------- | ---------------------------------------------------------------                                                               |
| `factory run`                                                           | passing | [run.md](run.md)                                                                                                              |
| `factory run --model`, `DEFAULT_MODEL`                                  | passing | [model.md](model.md) (`model.sh`)                                                                                             |
| `factory cost`, `factory run --cap-at-prediction`                       | passing | verify-api's [cost.md](../../verify-api/features/cost.md) (`cost.sh`)                                                         |
| `factory ls`                                                            | passing | [ls.md](ls.md)                                                                                                                |
| `factory watch`                                                         | passing | [watch.md](watch.md)                                                                                                          |
| Typed errors                                                            | passing | [errors.md](errors.md)                                                                                                        |
| `factory send` / `factory withdraw`                                     | passing | [withdraw.md](withdraw.md)                                                                                                    |
| `factory send --when-busy steer/reject`                                 | passing | [steer.md](steer.md)                                                                                                          |
| `factory approve` / `deny`                                              | passing | [approve.md](approve.md)                                                                                                      |
| `factory repo add` / `ls` / `show`                                      | passing | [repo.md](repo.md)                                                                                                            |
| `factory skill ls` / `show` / `put`                                     | passing | [skill.md](skill.md) (`skill.sh`)                                                                                             |
| `factory triggers ls` / `deliveries`                                    | passing | [triggers.md](triggers.md) (`triggers.sh`)                                                                                    |
| `factory pr`                                                            | passing | [verify-board build.md](../../verify-board/features/build.md)                                                                 |
| `factory board block\|unblock\|attention\|runs`                         | passing | [verify-board triage.md](../../verify-board/features/triage.md)                                                               |
| `factory board add`                                                     | passing | [verify-board add.md](../../verify-board/features/add.md)                                                                     |
| `factory board vocabulary\|define\|definition show --json` (F5, F7, F8) | passing | [verify-board define.md](../../verify-board/features/define.md), [definitions.md](../../verify-board/features/definitions.md) |
| `factory outcomes`                                                      | passing | [verify-api outcomes.md](../../verify-api/features/outcomes.md)                                                               |

## Deliberately absent

- **`--repo` in the drive.** `factory run --repo <owner/name>` is implemented (it binds the session
  and registers the repo), but the binding itself is proven over the RPC surface by
  `.pi/skills/verify-api` (A1); driving it here would prove the same server behavior through one
  more parser. The flag is exercised in the examples and by `--help`.
- **Interactive steering.** There is no REPL: `run` sends one task and follows it, `watch` attaches
  to one session, and `send` hands a running session one more message (LOB-166) — a steer, a
  follow-up, or a reject (LOB-167, `steer.sh`); `interrupt` stops it (C8, `interrupt.sh`).
- **Completions and wizard mode.** `effect/cli` provides them; they are the framework's behavior,
  not this app's.
