# The getting-started guide, walked

**Status: passing.**

## What it is

`docs/getting-started.md` (G1) takes a new operator from `git clone` to a card in `review` with a pull
request, one existing `factory` command per step: install and start, `factory doctor`, `repo add`,
`board create`, `board add`, `board start` with `watch` (specify, the question and its answer, plan),
the plan approval as a `board move --actor person:…`, the build run, the PR opened when it settles,
and the move into `review`. It then has the configuration table (capability, variables, the URL to give
the third party), the note on which `.env` is read and how `factory doctor` confirms it, and the
runbook for a tunnel with a real Linear and GitHub webhook.

The first half is a **rehearsal**: the instance `./up.sh` starts (scripted faux models per role, a GitHub
fake on loopback) and a throwaway repository whose `origin` is a local bare repository. The commands
are the real ones; only the model, the repository and the forge are stand-ins.

## How the skill proves it

- **`guide.sh`** cuts the document's fences marked `sh walk` (a hard step) and `sh walk-soft` (its exit
  status is evidence, `factory doctor` exiting 1 on a `fail` line) out of the guide and runs them in one
  shell, so the guide cannot say one thing while a drive proves another. It registers the guide's
  `acme/demo` under a slug of its own (`GUIDE_REPO`) because a repository has one board. Then it reads
  back: the card is in `review` with the spec (`gaps: none`) and plan the scripted runs wrote; `board runs`
  lists the build run's `/pull/` link; the fake's ledger holds exactly one `POST /repos/<slug>/pulls`,
  titled as the card; the soft `doctor` printed `ok api` and the repository's own lines.
- **`apps/cli/src/guide.test.ts`** is the static half and runs in the gate: every `factory …` line in the
  guide's code blocks and inline spans resolves against the CLI's own `--help` (one parser run per
  subcommand path), and a subcommand or flag the CLI does not define fails it. It also checks that every
  variable the configuration table names is documented in `.env.example`.
- **`.pi/skills/verify-web/first-run.mjs`** asserts the dashboard's side: each empty pane (`/boards`,
  `/repos`, `/attention`, `/approvals`, `/sandboxes`, `/spend`, `/sessions`) and each checklist step
  carries a `[data-guide-link]` whose text names its step and whose href is the guide at that heading
  (`apps/web/src/lib/guide-links.test.ts` checks the anchors against the guide's headings).

## Run it

```sh
DATABASE_URL=… API_PORT=9400 WEB_PORT=3400 GITHUB_PORT=9403 ./up.sh
DATABASE_URL=… API_PORT=9400 ./guide.sh
```

Evidence in `.verify/evidence/latest/board/`: `guide-walk.txt` (every command's output), `guide-show.txt`,
`guide-runs.txt`, `guide-ledger.json`, `guide.json`.

## Gotchas

- **Faux answers are scripted, not the card's.** The specifier's spec is about a Postgres major and the
  builder's change is one file whatever the card says; the guide says so.
- **A real run may not ask.** The scripted specifier asks once, so the walk answers it; a real
  specifier might not, and the guide says the question is only there if it was asked.
- **A rehearsal pushes nothing.** The demo repository's `origin` is a local path, so the control plane has
  no forge URL to send a token to and asks the fake for the PR without pushing the branch.
