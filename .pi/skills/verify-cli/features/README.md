# Feature map — CLI

One file per user-facing feature of `factory`. Each answers: what it is, how a user reaches it, how
the skill drives it, and what observable end state proves it works.

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

| Feature                                           | Status  | File                                                                  |
| ------------------------------------------------- | ------- | --------------------------------------------------------------------- |
| `factory run`                                     | passing | [run.md](run.md)                                                      |
| `factory run --model`, `DEFAULT_MODEL`            | passing | [model.md](model.md) (`model.sh`)                                     |
| `factory cost`, `factory run --cap-at-prediction` | passing | verify-api's [cost.md](../../verify-api/features/cost.md) (`cost.sh`) |
| `factory ls`                                      | passing | [ls.md](ls.md)                                                        |
| `factory status`, the model in `run` and `ls`     | passing | [status.md](status.md)                                                |
| `factory watch`                                   | passing | [watch.md](watch.md)                                                  |
| Typed errors                                      | passing | [errors.md](errors.md)                                                |
| `factory send` / `factory withdraw`               | passing | [withdraw.md](withdraw.md)                                            |
| `factory send --when-busy steer/reject`           | passing | [steer.md](steer.md)                                                  |
| `factory approve` / `deny`                        | passing | [approve.md](approve.md)                                              |
| `factory discard`                                 | passing | [discard.md](discard.md)                                              |
| `factory replay`                                  | passing | [replay.md](replay.md)                                                |
| `factory repo add --url`, `repo sync`, `doctor`   | passing | [clone.md](clone.md)                                                  |
| `factory pr`                                      | passing | [verify-board build.md](../../verify-board/features/build.md)         |
| Feature                                           | Status  | File                                                                  |
| -----------------------------------------------   | ------- | ---------------------------------------------------------------       |
| `factory run`                                     | passing | [run.md](run.md)                                                      |
| `factory run --model`, `DEFAULT_MODEL`            | passing | [model.md](model.md) (`model.sh`)                                     |
| `factory cost`, `factory run --cap-at-prediction` | passing | verify-api's [cost.md](../../verify-api/features/cost.md) (`cost.sh`) |
| `factory ls`                                      | passing | [ls.md](ls.md)                                                        |
| `factory watch`                                   | passing | [watch.md](watch.md)                                                  |
| Typed errors                                      | passing | [errors.md](errors.md)                                                |
| `factory send` / `factory withdraw`               | passing | [withdraw.md](withdraw.md)                                            |
| `factory send --when-busy steer/reject`           | passing | [steer.md](steer.md)                                                  |
| `factory approve` / `deny`                        | passing | [approve.md](approve.md)                                              |
| `factory repo add` / `ls` / `show`                | passing | [repo.md](repo.md)                                                    |
| `factory pr`                                      | passing | [verify-board build.md](../../verify-board/features/build.md)         |
| `factory board block\|unblock\|attention\|runs`   | passing | [verify-board triage.md](../../verify-board/features/triage.md)       |
| `factory board add`                               | passing | [verify-board add.md](../../verify-board/features/add.md)             |

## Deliberately absent

- **`--repo` in the drive.** `factory run --repo <owner/name>` is implemented (it binds the session
  and registers the repo), but the binding itself is proven over the RPC surface by
  `.pi/skills/verify-api` (A1); driving it here would prove the same server behavior through one
  more parser. The flag is exercised in the examples and by `--help`.
- **Interactive steering.** There is no REPL: `run` sends one task and follows it, `watch` attaches
  to one session, and `send` hands a running session one more message (LOB-166) — a steer, a
  follow-up, or a reject (LOB-167, `steer.sh`).
- **Completions and wizard mode.** `effect/cli` provides them; they are the framework's behavior,
  not this app's.
