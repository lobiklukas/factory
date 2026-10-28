# Getting started

From `git clone` to a card in review with a pull request, then the same thing against your real
GitHub and Linear. One document, one existing command per step.

The first half runs entirely on your machine: a scripted model, a local git repository and a fake
GitHub on loopback (a **rehearsal**). It is what proves this guide is true: every command in a
`sh walk` block below is run, in order, by `.pi/skills/verify-board/guide.sh`, and
`apps/cli/src/guide.test.ts` fails when the guide names a `factory` subcommand or flag the CLI does
not define. The second half swaps in a real model, a real repository and real webhooks.

| Step | What you do                          | Command                                        |
| ---- | ------------------------------------ | ---------------------------------------------- |
| 1    | Install and start                    | `bun install`, `docker compose`, `bun run dev` |
| 2    | Check the machine                    | `factory doctor`                               |
| 3    | Register a repository                | `factory repo add`                             |
| 4    | Create a board                       | `factory board create`                         |
| 5    | Add a card                           | `factory board add`                            |
| 6    | Start runs: specify, plan            | `factory board start`, `factory watch`         |
| 7    | Approve the plan, build, open the PR | `factory board move`                           |
| 8    | Review and merge                     | `factory board move`, GitHub                   |

The dashboard (`http://localhost:3000`) shows the same board and has a checklist for steps 3 to 6 on
its empty pages; each step there links back here. Everything below works from the terminal.

## 1. Install and start

You need Bun (`bun@1.4.2`, Node `>=24`), Docker and git.

```sh
bun install
docker compose up -d --wait postgres
```

`docker compose` starts Postgres from `compose.yaml` on host port **5442** (user, password and
database all `factory`). Port 5432 is not used because developer machines routinely have it taken.

Start the control plane and the dashboard:

```sh
bun run dev
```

`bun run dev` runs the API on port **9000**, the Vite dashboard on port **3000** and the CLI in watch
mode, in one Turborepo terminal UI. To run the API alone, headless, as scripts and agents do:

```sh
bun run --cwd apps/api dev
```

Both read the repository-root `.env` themselves (see [Which `.env` is read](#which-env-is-read)).
With no `.env` there is no model credential, and the API falls back to a scripted **faux** model: the
rehearsal below needs nothing more. Ports, the database and the model are all environment variables,
listed in [the configuration table](#configuration-table).

### The CLI

Every step below uses the `factory` CLI. From the repository root, either build it once and put
`apps/cli/dist` on your `PATH`, or use a shell function that runs the source:

```sh walk
cd "$(git rev-parse --show-toplevel)"
factory() { bun "$PWD/apps/cli/src/index.ts" "$@"; }
```

The CLI talks to `http://localhost:9000` unless `FACTORY_API_URL` (or `API_URL`) says otherwise.

### The rehearsal instance

To follow the guide without a model key, a GitHub repository or a webhook, start the rehearsal
instance instead of (or beside) `bun run dev`. It is the instance every `verify-board` drive uses: an
API with a scripted model per role (the specifier asks one question, the planner writes a plan, the
builder commits a change and verifies it), a fake GitHub on loopback that records every pull request
it is asked to open, and a dashboard. Pick ports that are free:

```sh
API_PORT=9400 WEB_PORT=3400 GITHUB_PORT=9403 .pi/skills/verify-board/up.sh
export FACTORY_API_URL=http://localhost:9400
```

`up.sh` prints the three URLs. Stop it with `.pi/skills/verify-board/down.sh`. It seeds one board of
its own over a fixture repository; the guide makes its own and ignores that one. The scripted model
answers the same way whatever the card says (its spec is about a Postgres major, its change is one
file), which is what makes the rehearsal repeatable and why its answers do not follow your card.

## 2. Check the machine

```sh walk-soft
factory doctor --allow-faux
```

`factory doctor` prints one `ok|warn|fail <check>: <detail> -- fix: <what to do>` line per
prerequisite: the API and its database, the model backend and which credential it uses, which
webhook routes are armed, the env files the API loaded, and (once step 3 is done) each registered
repository's checkout, base ref and GitHub credential. It never prints a credential, and exits 1 on a
`fail`. A faux backend is a `warn`, and an exit 1 unless you pass `--allow-faux`; `--live` sends one
minimal request to the model, the only check that spends.

### Which `.env` is read

One file: the repository-root `.env` (copy `.env.example`, which documents every variable).

- `bun run dev` loads it for the API and the CLI (`bun --env-file=../../.env`) and for the dashboard
  (Vite's `envDir`). Turborepo does not load `.env` files itself.
- A variable exported in your shell wins over the file.
- `--env-file` turns off Bun's own autoload, so a package-local `apps/api/.env` is **not** read: put
  everything in the root file.
- Running the CLI as `bun apps/cli/src/index.ts` from the repository root loads the root `.env` too.
- Turborepo's strict mode strips an environment variable the task does not declare, so a name that is
  not in `apps/api/turbo.json` does nothing under `bun run dev`. Every variable in this guide is
  declared.

To confirm a change took effect, restart the API and run `factory doctor`: its `env-files` line names
the files the API loaded (paths only, never values), its `model` line names the backend and the
variable that authenticated, and each `webhook <route>` line says `armed` or names the variable that
would arm it. The API's boot log says the same, and `factory status` prints the models, credentials
and routes the control plane runs.

## 3. Register a repository

The factory works in a git checkout it can cut worktrees from. For a real repository you register
your clone:

```sh
factory repo add owner/name --path . --base-ref main
```

The rehearsal makes a small repository of its own, with a local bare repository as its `origin`, so
nothing a run does can reach a real remote. It carries one verify skill, which is how a run proves
what it changed (`.pi/skills/verify-*/`):

```sh walk
WORK="$(mktemp -d)"
git init -q --bare -b main "$WORK/origin.git"
git init -q -b main "$WORK/demo"
git -C "$WORK/demo" remote add origin "$WORK/origin.git"
git -C "$WORK/demo" config user.email you@example.com
git -C "$WORK/demo" config user.name You
mkdir -p "$WORK/demo/.pi/skills/verify-web"
printf '# demo\n' > "$WORK/demo/README.md"
printf 'echo "verify-web: 2/2 checks passed (surface=$FACTORY_VERIFY_SURFACE)"\n' \
  > "$WORK/demo/.pi/skills/verify-web/drive.sh"
git -C "$WORK/demo" add -A
git -C "$WORK/demo" commit -q -m "demo repository"
git -C "$WORK/demo" push -q origin main
factory repo add acme/demo --path "$WORK/demo" --base-ref main
```

`factory repo add` prints the registration: the checkout, the base ref runs start from, a readiness
score (does the repository carry an `AGENTS.md`, a `package.json`, a verify skill) and whether it has
a `.factory/config`. A repository with a GitHub `origin` also gets a push URL, so the control plane
can publish a run's branch; with none (the rehearsal) it pushes nothing and asks GitHub, here the
fake, for the pull request. Check the repository on its own:

```sh walk
factory repo show acme/demo
factory doctor acme/demo --allow-faux
```

## 4. Create a board

A board binds one repository to a **definition**: the columns a card moves through, which role runs
in each, what each must produce before the card leaves it, and the two human gates (plan approval and
merge). The default definition is `intake`, `specifying`, `planning`, `building`, `review`, `done`.
Read it before trusting it (`docs/board.md` B4):

```sh walk
factory board definition show default
```

```sh walk
BOARD="$(factory board create --repo acme/demo | awk '$1 == "board" { print $2 }')"
echo "$BOARD"
factory board ls --board "$BOARD"
```

## 5. Add a card

```sh walk
TASK="$(factory board add --board "$BOARD" --title "Pin the Postgres major" \
  --body "docker-compose.yml names one Postgres major; the README says which." \
  | awk '$1 == "task" { print $2 }')"
echo "$TASK"
rev() { factory board show --task "$TASK" | awk '$1 == "revision" { print $2 }'; }
factory board show --task "$TASK"
```

A card rests in `intake`: nothing runs until a person moves it on. Every move names the revision it
expects (`rev` above reads the current one), so a stale move is refused rather than overwriting a
newer one. `factory board show` prints the card, what it still needs to leave its column, and its
thread.

## 6. Start runs: specify, then plan

Move the card into `specifying` and start a run there. `factory watch` follows the run's transcript
and returns when the run settles:

```sh walk
factory board move --task "$TASK" --to specifying --expect-revision "$(rev)"
SESSION="$(factory board start --task "$TASK" | awk '$1 == "session" { print $2 }')"
factory watch "$SESSION"
```

The specifier is read-only: it writes a spec (goal, acceptance, gaps, open questions), and may stop
to ask you something. A card with a question is **blocked** `needs_input`; `factory board attention`
lists what waits on a person:

```sh walk
factory board attention
factory board show --task "$TASK"
```

Answer it on the card. The answer lifts the block, and the next run is told what was asked and
answered:

```sh walk
factory board comment --task "$TASK" --expect-revision "$(rev)" --body "Postgres 17"
SESSION="$(factory board start --task "$TASK" | awk '$1 == "session" { print $2 }')"
factory watch "$SESSION"
```

With the spec recorded, move to `planning` and start the planner, which reads the repository and
writes a plan (summary, steps, surfaces, risks):

```sh walk
factory board move --task "$TASK" --to planning --expect-revision "$(rev)"
SESSION="$(factory board start --task "$TASK" | awk '$1 == "session" { print $2 }')"
factory watch "$SESSION"
factory board show --task "$TASK"
```

## 7. Approve the plan, build, open the PR

`planning` to `building` is the first human gate: only a person may make the move, and the card must
hold a plan. The actor names who approved (a session id would be a run, and is refused). In the
dashboard this is the card pane's approval; here it is a move:

```sh walk
factory board move --task "$TASK" --to building --expect-revision "$(rev)" --actor person:you
SESSION="$(factory board start --task "$TASK" | awk '$1 == "session" { print $2 }')"
factory watch "$SESSION"
```

The builder commits a change on the card's own branch and runs the repository's verify skill. When
the run settles, the control plane opens the pull request itself: it measures the branch against its
base, checks the diff against the cap and scans it for secrets, pushes, and asks GitHub. The link
lands on the run:

```sh walk
for _ in $(seq 1 60); do
  factory board runs --task "$TASK" | grep -q '/pull/' && break
  sleep 1
done
factory board runs --task "$TASK"
```

A run whose pull request did not open says why in its transcript and on the card; `factory pr`
with the session id opens it by hand (the same step) once the cause is fixed.

## 8. Review and merge

With a PR, a diff and a completed run, the card may leave `building` for `review`:

```sh walk
factory board move --task "$TASK" --to review --expect-revision "$(rev)" --actor person:you
factory board show --task "$TASK"
```

That is where the rehearsal ends: the card is in `review` with a pull request recorded against the
fake GitHub. `factory board show` lists what `review` still needs, each with its reason:

- `verified`: the verify skill passed for every surface the change touched (met by the build run).
- `review_verdict`: a reviewer run passed the PR's **current head**. Reviewer runs are opened by
  GitHub's `pull_request` webhook, so a deployment GitHub cannot reach has none (see the runbook).
- `human_merge`: the PR was merged. Merge it in GitHub; its signed `pull_request` delivery moves the
  card to `done`. Without a delivery, opening the card (`factory board show`, the card pane) reads the
  PR's state and settles the card the same way.

Stop the rehearsal with `.pi/skills/verify-board/down.sh`.

## Configuration table

What to set to turn each capability on, where it goes, and what to give the third party. Every
variable is in `.env.example`, with its defaults; secrets go in the root `.env` (gitignored), never in
a file in git and never in the repository the agent works on.

| Capability                    | Environment variables                                                                        | Give the third party                                                                                                                         |
| ----------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Ports and database            | `PORT`, `VITE_PORT`, `VITE_SERVER_URL`, `FACTORY_API_URL`, `DATABASE_URL`, `ALLOWED_ORIGINS` | nothing                                                                                                                                      |
| A real model                  | `ANTHROPIC_API_KEY` (or `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_OAUTH_TOKEN`); `MODEL_BACKEND`    | nothing. Unset, the scripted faux model runs                                                                                                 |
| Control-plane auth            | `FACTORY_API_TOKEN`, `VITE_FACTORY_API_TOKEN`, `FACTORY_API_ACTOR`, `HOST`                   | nothing. A `HOST` beyond loopback with no token refuses the boot                                                                             |
| GitHub: push and open PRs     | `GITHUB_TOKEN`, or `GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY` + `GITHUB_APP_INSTALLATION_ID` | a token with contents and pull-request write on the repository                                                                               |
| GitHub: merge, review, issues | `GITHUB_WEBHOOK_SECRET`                                                                      | a webhook at `https://<host>/webhooks/github`, content type JSON, events `pull_request`, `push`, `issues`, `issue_comment`, the secret above |
| Linear: issues become cards   | `LINEAR_WEBHOOK_SECRET`, `TRIGGER_RULES`                                                     | a webhook at `https://<host>/webhooks/linear`, resource type Issues, its signing secret as the variable                                      |
| Linear: write-back            | `LINEAR_API_KEY`, `LINEAR_STATE_STARTED`, `LINEAR_STATE_IN_REVIEW`, `LINEAR_STATE_DONE`      | a personal API key; the state names your team uses                                                                                           |
| A generic webhook             | `TRIGGER_SECRET`, `TRIGGER_RULES`                                                            | `POST https://<host>/webhooks/generic`, body signed HMAC-SHA256 with the secret                                                              |
| Sentry                        | `SENTRY_CLIENT_SECRET`, `SENTRY_API_TOKEN`                                                   | an integration webhook at `https://<host>/webhooks/sentry`                                                                                   |
| Jira                          | `JIRA_WEBHOOK_SECRET`, `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`                       | an admin webhook at `https://<host>/webhooks/jira`                                                                                           |
| Slack                         | `SLACK_SIGNING_SECRET`, `SLACK_CHANNELS`, `SLACK_BOT_TOKEN`                                  | an Events API subscription at `https://<host>/webhooks/slack`                                                                                |
| Notifications                 | `NOTIFY_SLACK_WEBHOOK_URL`, `NOTIFY_NTFY_TOPIC`, `NOTIFY_LINK_BASE`                          | a Slack incoming webhook URL, or an ntfy topic                                                                                               |
| Limits                        | `SESSION_MAX_CONCURRENT`, `SESSION_BUDGET`, `PR_CAP_MAX_FILES`, `PR_CAP_MAX_LINES`           | nothing                                                                                                                                      |
| Telemetry                     | `MOTEL_URL`, `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`                                           | nothing                                                                                                                                      |

Rules of thumb:

- **A webhook route with no secret refuses every delivery** with `503`, so nothing can start work
  unsigned. `factory doctor` lists which routes are armed.
- **Secrets the agent's commands need** (a registry token for `bun install`, say) are not environment
  variables of the API: store them per repository with `factory secret set`, which never prints them.
- **Trigger rules** (`TRIGGER_RULES`, or stored routes) map a label or a team to a repository, a base
  ref and a prompt. A rule with `"mode": "card"` files a card on the repository's board instead of
  opening a session, which is how a Linear issue joins the board of step 4.
- The URL you give a third party must reach `apps/api` (port 9000). Nothing on your machine does
  until you tunnel it (next section).

## Runbook: a tunnel and a real Linear webhook

Linear and GitHub deliver webhooks from the internet, so a local control plane needs a public HTTPS
URL in front of it. Nothing in the repository provisions one; use any tunnel (`cloudflared tunnel
--url http://localhost:9000`, `ngrok http 9000`). Keep the tunnel open while you work: a closed one
makes the third party retry, and eventually disable the webhook.

1. **Run the control plane with the secrets.** In the root `.env` set `LINEAR_WEBHOOK_SECRET` (choose a
   long random value, for example `openssl rand -hex 24`), `GITHUB_WEBHOOK_SECRET`, a GitHub
   credential and a model key. Add a rule so a label on an issue becomes a card on the board of
   step 4:

   ```sh
   TRIGGER_RULES=[{"label":"factory","repo":"owner/name","baseRef":"main","mode":"card","prompt":"Work on {{title}}: {{body}}"}]
   ```

   Restart the API, then run `factory doctor`: `webhook linear` and `webhook github` must say `armed`,
   and `trigger-rules` must count one rule.

2. **Open the tunnel** and note its URL, for example `https://example.trycloudflare.com`.

3. **Register the Linear webhook.** In Linear: Settings, API, Webhooks, New webhook. URL
   `https://example.trycloudflare.com/webhooks/linear`, resource type **Issues**, and the signing
   secret the same value as `LINEAR_WEBHOOK_SECRET`. Linear signs each body with it
   (`Linear-Signature`); a wrong signature is a `401` that writes nothing.

4. **Register the GitHub webhook** the same way: repository Settings, Webhooks, payload URL
   `https://example.trycloudflare.com/webhooks/github`, content type `application/json`, the secret
   from `GITHUB_WEBHOOK_SECRET`, and the events `pull_request`, `push`, `issues` and
   `issue_comment`. This is what opens reviewer runs and completes a card when its PR merges.

5. **Make the repository's board** if it has none (`factory board create --repo owner/name`): a card
   rule on a repository with no board is recorded as a skipped delivery naming that command.

6. **Label an issue `factory` in Linear.** A card appears in `intake` on the board.
   `factory triggers ls` lists every delivery the seam recorded, with how it ended and why; a skipped
   delivery's reason names what to fix (a repository nobody registered, a label no rule claims), and
   the dashboard's Triggers page shows the same. A delivery refused before the seam (a bad
   signature, a body over `TRIGGER_MAX_BODY_BYTES`) is only in the API's log.

7. **Follow the card** from step 6 on: it is the same board, so its runs, its PR and the plan approval
   are the steps above. With `LINEAR_API_KEY` set the issue moves to your started state when a run
   opens, gets the PR and moves to in review when it opens, and moves to done when it merges.

8. **Proof a live smoke happened** is a hand run: put the delivery's id from `factory triggers ls` and
   the card id in your notes. No live smoke is recorded in the repository; the fakes in
   `docs/testing-third-parties.md` are what the test suite runs against.

## When something does not work

- `factory doctor` first: each line names its fix.
- A card refused a move: the refusal names the requirement (`factory board show` lists them all under
  `leaves <column> when`).
- A run that did nothing: its transcript says why (`factory watch <session>`), and a PR that did not
  open says so there and on the card.
- Nothing arrives from a third party: `factory triggers ls`, then the tunnel, then the secret.
- Evidence of what ran: set `MOTEL_URL` and read it with `bun run motel` (`.pi/skills/motel-debug`).
- The Docker caveat on this machine: Docker Desktop and Colima can both run, each with its own
  Postgres, and only one publishes 5442. Ask the port (`lsof -nP -iTCP:5442 -sTCP:LISTEN`), not a
  Docker context.

Where to go next: `docs/board.md` for how work moves and what each gate checks, `docs/design.md` for
why, and `.pi/skills/verify-board/` for every board behaviour proven from this same terminal.
