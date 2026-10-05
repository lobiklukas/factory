# Feature map — CLI

One file per user-facing feature of `factory`. Each answers: what it is, how a user reaches it, how
the skill drives it, and what observable end state proves it works.

Status reflects the last verified run: 2026-10-05, API on `:9300`, `MODEL_BACKEND=faux`,
`./drive.sh` in tmux — 14/14 required checks passed.

| Feature         | Status  | File                   |
| --------------- | ------- | ---------------------- |
| `factory run`   | passing | [run.md](run.md)       |
| `factory ls`    | passing | [ls.md](ls.md)         |
| `factory watch` | passing | [watch.md](watch.md)   |
| Typed errors    | passing | [errors.md](errors.md) |

## Deliberately absent

- **`--repo` in the drive.** `factory run --repo <owner/name>` is implemented (it binds the session
  and registers the repo), but the binding itself is proven over the RPC surface by
  `.pi/skills/verify-api` (A1); driving it here would prove the same server behavior through one
  more parser. The flag is exercised in the examples and by `--help`.
- **Interactive steering.** There is no REPL: `run` sends one task and follows it, `watch` attaches
  to one session. Queueing and `whenBusy` belong to the RPC surface and are covered there.
- **Completions and wizard mode.** `effect/cli` provides them; they are the framework's behavior,
  not this app's.
