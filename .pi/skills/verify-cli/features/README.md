# Feature map — CLI

One file per user-facing feature of `factory`. Each answers: what it is, how a user reaches it, how
the skill drives it, and what observable end state proves it works.

`factory approvals` / `approve` / `deny` were verified **2026-10-27** from the `agent/LOB-53`
worktree: `./drive.sh` (API on `:9530`) **21/21**, its last check being `./approve.sh` (API on
`:9531`) at **18/18**.

`factory send --when-busy steer` / `--when-busy reject` were verified **2026-10-27** from the
`agent/LOB-167` worktree with `./steer.sh` (API on `:9541`, `FAUX_SLEEP_MS=8000`) — **13/13** checks.
A mutation run with the nap off (`STEER_SLEEP_MS=0`) failed 9 of them.

`factory send` / `factory withdraw` were verified **2026-10-27** from the `agent/LOB-166` worktree
with `./withdraw.sh` (API on `:9561`) — **13/13** checks — and `./drive.sh` re-run there (API on
`:9560`) at 20/20.

Status reflects the last verified run: **2026-10-27**, from the `agent/LOB-65` worktree, API on
`:9500` (not the usual `:9300`), the seed's GitHub fake on `:9503`, `MODEL_BACKEND=faux`,
`./drive.sh` in tmux — **20/20** required checks passed, including the PR column (LOB-65). A
mutation run (the row always printing `-`) failed "ls shows the recorded PR URL" with `pr=-`.

| Feature                                 | Status  | File                                                          |
| --------------------------------------- | ------- | ------------------------------------------------------------- |
| `factory run`                           | passing | [run.md](run.md)                                              |
| `factory ls`                            | passing | [ls.md](ls.md)                                                |
| `factory watch`                         | passing | [watch.md](watch.md)                                          |
| Typed errors                            | passing | [errors.md](errors.md)                                        |
| `factory send` / `factory withdraw`     | passing | [withdraw.md](withdraw.md)                                    |
| `factory send --when-busy steer/reject` | passing | [steer.md](steer.md)                                          |
| `factory approve` / `deny`              | passing | [approve.md](approve.md)                                      |
| `factory pr`                            | passing | [verify-board build.md](../../verify-board/features/build.md) |

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
