# Ralph loop

An autonomous backlog loop for this repo: a **fresh `pi -p` session per iteration** (or `opencode run`, see below), **one Linear
issue per iteration**, state kept outside the model (Linear, `.ralph/`, git). Every agent runs on
`opencode-go/longcat-2.5-preview-free` (override with `RALPH_MODEL`). Nothing merges; the output is a
reviewed **draft PR** per issue and the issue moved to _In Review_.

Pattern sources: Huntley's bash loop; fresh context per iteration (Galarza's Linear loop, edxeth's
`pi-ralph-loop`); promise tags as the control line; Linear as source of truth.

## Roles

| Role               | Where                           | Job                                                                                                                                                               |
| ------------------ | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| planner            | `plan.prompt.md` (main session) | Labels every open Factory MVP issue `ralph`, scouts them, wires `blockedBy`, classifies (`ready` / `needs-spec` / `needs-human` / split), writes `.ralph/plan.md` |
| worker             | `work.prompt.md` (main session) | Picks one `ready` issue (stacking on an in-review blocker), implements, verifies, reviews, opens a draft PR                                                       |
| `ralph-scout`      | `.pi/agents/`                   | Read-only recon: evidence, footprint, dependencies, third parties, size                                                                                           |
| `ralph-designer`   | `.pi/agents/`                   | UI spec before an `apps/web` change; critique of the rendered result after                                                                                        |
| `ralph-verifier`   | `.pi/agents/`                   | Fresh-context writer of tests, fakes, e2e drive checks and `.pi/skills/verify-*`                                                                                  |
| `ralph-researcher` | `.pi/agents/`                   | Finds maintained OSS to fake a third party; feeds `docs/testing-third-parties.md`                                                                                 |
| `ralph-merger`     | `.pi/agents/`                   | Resolves `git merge origin/main` conflicts by intent; knows the migration, lockfile, generated-file and registry traps                                            |
| `ralph-reviewer`   | `.pi/agents/`                   | One `combined` review for a small diff, else parallel `spec` / `standards` / `tests`                                                                              |
| audit              | `audit.prompt.md`               | Re-runs every verify skill, fixes drift, files what it cannot fix                                                                                                 |

## Rules that matter

- **Pre-existing problems are never buried.** Anything found that the diff did not cause becomes a
  Linear issue (`ticket.md`): labelled `ralph` + `Bug`, with evidence and acceptance criteria, queued
  (front of the queue if it turns the gate red). The next iteration fixes it. A pre-existing blocker
  makes the worker file it and move on - it does not stop the loop.
- **Verification is part of the issue.** Tests from the acceptance criteria, fakes for every third
  party (never a real call), e2e drive checks, and a new or updated `verify-*` skill whose status
  was earned by a run.
- The loop works in its own **git worktree** with its own **database** and **ports**; it never
  touches your checkout, `main`, or the `factory` database.

## Use

Prerequisite: `.pi/ralph/` and `.pi/agents/ralph-*` are on `origin/main` (the worktree starts there).

```sh
bun run ralph:setup              # worktree ../factory-ralph, bun install, DB factory_ralph
bun run ralph:plan               # label + order the backlog -> .ralph/plan.md
bun run ralph:run --max 3        # try three iterations first
bun run ralph:status             # queue, lock, last runs
bun run ralph:stop               # finish the current iteration, then stop
bun run ralph:audit              # maintenance pass over the verification layer
RALPH_PUSH=0 bun run ralph:run   # commit locally, no push, no PR
```

`bun run ralph <subcommand>` and `.pi/ralph/loop.sh <subcommand>` are the same thing.

Exit codes: `0` done, `2` worker reported `BLOCKED` (infrastructure: Linear, Docker, auth),
`3` too many iterations without a valid control line. Logs: `.ralph/logs/` in the worktree.
Env: `RALPH_MODEL RALPH_THINKING RALPH_MAX_ITER RALPH_TIMEOUT RALPH_PUSH RALPH_WORKTREE RALPH_DB
RALPH_API_PORT RALPH_WEB_PORT`.

## Failure paths

- Conflict, red CI or red merge gate on a ralph PR: the driver labels it `ralph-fix` with the evidence; the next iteration fixes it first (conflicts via `ralph-merger`). After 3 automatic attempts (`RALPH_FIX_MAX`) it becomes `needs-human-merge` and is listed by `ralph:status`.
- PRs touching `.github/`, `.pi/ralph/`, `.pi/agents/ralph-*` or lint/format/vitest config are never auto-merged.
- `bun run ralph:split` breaks `too-big` issues into S/M children in a separate worktree, beside a live loop.

## Model fallback

`RALPH_MODEL` (default `opencode-go/longcat-2.5-preview-free`) is tried first. On a provider error (429, overload, quota, outage) the driver retries the same iteration on each model in `RALPH_FALLBACK_MODELS` (default `opencode-go/space-bunny-free`; empty disables). A timeout, or a run that merely forgot the control line, is not retried. `pi-subagents` never falls back by itself, so the worker is told to relaunch a failed subagent once per fallback model with a per-run `model` override. `runs.jsonl` records the model that finished each run and the attempts.

## Running on opencode

`RALPH_AGENT=opencode` runs every session (`plan`, `work`, `split`, `audit`) through `opencode run` instead of
`pi -p`; the driver, the worktree, the prompts and the merge gate are the same. Use it when the models you can
reach are only available through OpenCode (its free Zen tier answers only to the OpenCode client).

```sh
(cd ../factory-ralph && opencode mcp auth linear)   # once: browser OAuth for the Linear MCP server
RALPH_AGENT=opencode bun run ralph:run --max 3
```

- **Models.** `RALPH_MODEL` defaults to `opencode/space-bunny-free`, `RALPH_FALLBACK_MODELS` to
  `opencode/nemotron-3-ultra-free,opencode/mimo-v2.6-flash-free`. `opencode models` lists the ids.
- **Config.** Each attempt writes `.opencode/opencode.jsonc` into the worktree (git-excluded) with
  `opencode-config.py`: the `ralph-*` subagents are generated from `.pi/agents/ralph-*.md`, pinned to the model of
  the attempt (so the fallback also moves the subagents); the Linear MCP server is registered with direct
  `linear_*` tools; every MCP server in your global opencode config is disabled for the run.
- **Prompts.** They are written for pi's tools. The Run context appended to each prompt maps them: `linear_*`
  for `codemode`, the `subagent` tool for pi's, no `async`/`bg_wait`/`timeoutMs`.
- **Control line.** The last line of the final `text` event of the `--format json` log. The log is JSON lines,
  not a readable transcript.
- **Stall watchdog.** pi's sessions are files; opencode's are a database. `oc_activity` reads the newest message
  time of any session (subagent children included) started from the worktree, so a parent waiting on a long
  subagent is not mistaken for a hung one.
- **Resume.** A free model sometimes returns nothing mid-turn: opencode exits 0 on a log that ends on a `step_start`.
  The driver resumes that session (`-s <id>`, up to `RALPH_OC_RESUMES`, default 3) instead of redoing the iteration.
  A run that ends on text without a control line is not resumed.
- **Fallback.** A top-level `error` event (a refused or failed model call) counts as a provider failure and moves to
  the next model, as pi's 429/overload patterns do.

## Known traps

- `ralph-researcher` and `ralph-verifier` need `async: true` (foreground children do not load web
  extensions). The prompts say so. If `web_search` has no provider under `auto`, use `anysearch` or
  `keenable`.
- The worker reads its prompts from the worktree at `origin/main`: edit them on a branch and merge
  before expecting a change.
- Huntley's warning applies: run `--max 3` and read the PRs before leaving it overnight.
