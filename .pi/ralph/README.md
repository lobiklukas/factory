# Ralph loop

An autonomous backlog loop for this repo: a **fresh `pi -p` session per iteration**, **one Linear issue per
iteration**, **one PR per issue**, merged by GitHub when CI is green. State lives outside the model: Linear is the
queue, git holds the work, `.ralph/` holds logs and notes.

The worker runs on `opencode-go/deepseek-v4.1-flash` (`RALPH_MODEL`), thinking `medium` (`RALPH_THINKING`); the
`ralph-*` subagents run on `anthropic/claude-haiku-5-5` (their `model:` front matter).

## How an issue flows

1. The worker (`work.prompt.md`) takes the first pickable item: a ralph PR with a red `gate` or a conflict, then a
   red main, then an interrupted issue, then the highest-priority **Todo** issue in Factory MVP whose blockers are
   Done. Issues labelled `needs-human`, `needs-spec`, `too-big` or `split-parent` are skipped.
2. It implements with tests, launches **one** `combined` review async and runs the gate while it works, and opens a PR
   (not a draft). A session still without a green gate after 45 minutes skips the issue as `too-big`.
3. After the session the driver **arms GitHub auto-merge** (`gh pr merge --auto --squash`) on every open ralph
   PR, and runs `gh pr update-branch` on one that is behind main.
4. GitHub squash-merges once the required `gate` check passes. Linear's GitHub integration moves the issue to Done.
5. A red or conflicting PR stays open and armed; the next iteration fixes it first. After 3 fix attempts the
   worker labels it `needs-human-merge` and disables auto-merge.

PRs touching `.github/`, `.pi/ralph/`, `.pi/agents/ralph-*` or lint/format/vitest config are never armed: the
driver labels them `needs-human-merge`. The worker does not edit the loop's own files at all.

Subagents (`.pi/agents/ralph-*`), each only when needed:

| Role               | When                                                            |
| ------------------ | --------------------------------------------------------------- |
| `ralph-reviewer`   | every PR, once, angle `combined`                                |
| `ralph-designer`   | an `apps/web` change: `spec` before, `critique` after           |
| `ralph-verifier`   | a new surface (RPC group, CLI command, route, service boundary) |
| `ralph-researcher` | a third party with no entry in `docs/testing-third-parties.md`  |
| `ralph-merger`     | a merge conflict on a PR being fixed                            |
| `ralph-scout`      | `split`: the footprint of a `too-big` issue                     |

## Pre-existing problems (`ticket.md`)

A problem the diff did not cause is filed, not fixed inline. A red main goes to **Todo** (priority 2) and is
worked next. Any other defect goes to **Backlog**; a human moves it to Todo if it is worth an iteration. Polish
goes to `.ralph/polish.md`. At most 3 tickets per iteration. This keeps the loop on the roadmap instead of on
its own findings.

## Use

Prerequisites: `.pi/ralph/` on `origin/main`; repository settings below.

```sh
bun run ralph:setup              # worktree ../factory-ralph, bun install, DB factory_ralph
bun run ralph:run --max 3        # try three iterations first
bun run ralph:start --max 20     # detached; ralph:stop (graceful) or ralph:kill
bun run ralph:status             # lock, open ralph PRs and their auto-merge state, last runs
bun run ralph:split              # cut issues labelled too-big into children
bun run ralph:audit              # maintenance pass over the verify-* skills
RALPH_PUSH=0 bun run ralph:run   # commit locally, no push, no PR
```

Exit codes: `0` done, `1` driver error (die), `2` worker reported `BLOCKED` (infrastructure: Linear, Docker, auth), `3` too many iterations without a valid control line or too many failed iterations, `64` usage error (no/unknown subcommand, `RALPH_WORKER` not a positive integer, or the driver read from stdin). Logs: `.ralph/logs/` and `.ralph/runs.jsonl` in the worktree.

## What the loop touches

The loop works in its own git worktree (`RALPH_WORKTREE`, default `../factory-ralph`), on its own ports
(`RALPH_API_PORT`/`RALPH_WEB_PORT`, 9400/3400) and in its own database _name_ (`RALPH_DB`, default `factory_ralph`)
on the Postgres server your checkout already runs: `DATABASE_URL` is `localhost:5442/$RALPH_DB`, and 5442 is
normally your `factory-postgres-1`. It does use your checkout's compose project and that server. `ensure_db` pins
`PG_ROOT` to your checkout and sources its `.pi/skills/lib/postgres.sh`, so when nothing answers 5442 it runs
`docker compose up -d --wait postgres` in your checkout's compose project. It then creates `RALPH_DB` with
`docker exec` into whichever container publishes 5442, or with `docker compose exec` in your checkout's project
when no container does. Every session it starts gets `COMPOSE_PROJECT_NAME=factory`, the project a checkout in a
`factory` directory owns, so an agent's `docker compose` targets it too. `setup` fetches `origin` and adds the
worktree through your checkout's git directory, and copies your `.env` into a worktree that has none. It never
writes the `factory` database: its one statement there is `ensure_db`'s read of `pg_database`, asking whether
`RALPH_DB` exists, and sessions get `DATABASE_URL` for `RALPH_DB`. It never writes `main`: the driver commits and
pushes only `ralph/*` branches, the worker's rules forbid pushing `main`, and its work reaches `main` only through
a PR's GitHub auto-merge.

## Repository settings (once)

Auto-merge needs a required check, and GitHub Free allows branch protection only on a public repository.

```sh
gh repo edit --enable-auto-merge --delete-branch-on-merge
gh api -X PUT repos/<owner>/factory/branches/main/protection --input - <<'JSON'
{ "required_status_checks": { "strict": true, "contexts": ["gate"] },
  "enforce_admins": false, "required_pull_request_reviews": null, "restrictions": null }
JSON
```

`strict` makes a PR wait until it is up to date with main; the driver updates PRs that fall behind.

## Model fallback and limits

On a provider error (429, overload, quota, outage) the driver retries the iteration on each model in
`RALPH_FALLBACK_MODELS` (default `anthropic/claude-haiku-5-5`, a different provider from the worker; empty disables).
When every model refuses, it waits `RALPH_PROVIDER_BACKOFF` (2 min) without counting a failure, up to
`RALPH_PROVIDER_BACKOFFS` (180) times.
An iteration is killed after `RALPH_TIMEOUT` (1 h) or after `RALPH_STALL` (20 min) with no session write.

## Parallel workers

```sh
bun run ralph parallel start 2 --max 40   # workers 1 and 2, started 60 s apart (RALPH_STAGGER)
bun run ralph parallel status
bun run ralph parallel stop
```

Worker N gets its own worktree (`<repo>-ralph-N`), database name (`factory_ralph_N`, on the same server) and ports
(`9400`/`3400` plus 10 per worker), and shares worker 1's `progress.md`, `polish.md` and `research/`. Before taking
an issue a worker runs `.pi/ralph/claim.sh claim LOB-n` (an atomic `mkdir` under `$RALPH_SHARED/claims`, stale after
`RALPH_CLAIM_TTL`, 3 h). The driver releases a worker's claims for issues with no open PR. Only worker 1 arms
auto-merge (`RALPH_MERGE`).

## Known traps

- The worker reads its prompts from the worktree at `origin/main`: merge a prompt change before expecting it.
- `ralph-researcher`, `ralph-verifier` and `ralph-merger` need `async: true` (foreground children do not load
  web extensions).
- Run `--max 3` and read the PRs before leaving it overnight: they merge without a human.
