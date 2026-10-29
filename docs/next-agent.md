# Next agent brief

A self-contained starting brief for the next stretch of work. Paste it into a fresh session, or point
the agent at this file.

**Written:** 2026-10-29, against `main` after the LOB-40 PR (the faux half of milestone L).
**Scope:** close milestone **L** with the owner's live run of LOB-40, then milestone **S** (LOB-41,
self-hosting), then the deferred tidy-up below.

**It goes stale fast.** It is a brief for one stretch, not a document of record. When the stretch
changes, rewrite it from `docs/roadmap.md`, whose priorities and Linear project are the source of
truth. What is not specific to this stretch is in `AGENTS.md` and `docs/handoff.md`.

---

## Where the repo stands

Everything the MVP roadmap asked of the code is merged: the board (B), triggers (T), the PR lifecycle
(C17–C21), notifications, spend caps, automations, MCP tools, model fallback, the kind sandbox (LOB-13
and its children) and DEFLAKE. The whole loop is proven end to end **in faux** by
`.pi/skills/verify-workflow/` (`cycle.sh`: 42 checks, twice in a row from nothing): a Linear delegation
through the real webhook and label rule, specify, plan approval by a person, a gated `git commit`
whose approval survives an API restart, a real `git push` with the CredentialProvider token, one PR
with its evidence (retry-safe), Linear write-back with no duplicate comment, review, merge, and the
session list and spend pane. `docs/handoff.md` ("Milestone L") has the details.

What is not proven is the same loop against the **real** Linear, GitHub and Anthropic.

## The stretch, in order

### 1. LOB-40 (d): the owner's live run — a person's step, not an agent's

LOB-40 is In Progress and stays open until this is posted on it. It needs the owner's credentials, a
scratch GitHub repo, a Linear label and webhook, and a tunnel; no agent runs it and no agent reads
those credentials. Everything is in `.pi/skills/verify-workflow/SKILL.md`, "Live run": what to create
first, the one command (`cycle.sh --live`), and the report it writes
(`.verify/evidence/latest/workflow/report.md`: wall-clock time, cost, PR, issue) to post on LOB-40.

An agent's part: if the owner's run fails, the failure is a finding. Reproduce it in faux if it can
be, fix the product with a test, extend the faux drive so it would have caught it, and leave the live
re-run to the owner. Do not "fix" the live drive by loosening a check: a model that never runs `git
commit` never meets the gate, and that check failing is information.

### 2. LOB-41: self-hosting — three issues done by the factory

Blocked by LOB-40. A person runs it, from the board; Claude Code worktrees, wave workflows and the
ralph loop do **not** do the work. Read its description: three consecutive issues, each a card through
specify → plan approval → build → review → a human merge, at least one with a steer, a policy refusal
or a re-run, and the proof is a comment built from the board and the session logs. Anything the
attempt turns out to need is its own issue that blocks LOB-41.

### 3. The deferred list (agent work, any order)

- **Harvest the follow-ups.** Waves 17–18 left "Follow-up (…)" comments on the umbrellas LOB-245
  (board config), LOB-246 (first run), LOB-247 (repositories), LOB-248 (drive work from the UI),
  LOB-249 (PR lifecycle), LOB-250 (triggers), LOB-251 (core market features) and LOB-13 (sandbox).
  Read every comment, turn each live follow-up into a work item (a draft while Linear is full, see
  below), and say on the umbrella which were taken, which were dropped, and why. LOB-40's own comments
  name its follow-ups (a CI job for `cycle.sh` among them).
- **LOB-252: the docs refresh.** `docs/board.md`, `docs/handoff.md`, this file and the README back in
  line with the code. `docs/handoff.md`'s "Where things stand" table dates from 2026-10-05; its claims
  are the ones most likely to be wrong.
- **Close the umbrellas** once their follow-ups are harvested and every child is delivered.
- **File the delivered drafts.** The Linear workspace is at the free plan's 250-issue limit (since
  2026-10-28): `save_issue` cannot create. Freeing room is the owner's call (upgrade, or archive old
  Done/Canceled issues; the MCP cannot archive). Once there is room, file each delivered draft as Done
  with its PR link and each undelivered one as Todo, under its umbrella. Until then: build drafts
  directly, put `Part of LOB-<umbrella>` only in the PR body (never in a title or branch: Linear's
  GitHub integration would close the umbrella on merge), and record decisions as comments on the
  umbrella.

## Read first, in this order

1. `AGENTS.md` — the rules, the five gates, and what is not negotiable.
2. `docs/handoff.md` — the state, "Milestone L", and the gotchas that have already cost hours.
3. `.pi/skills/verify-workflow/SKILL.md` — the loop as it is proven today, and the live run.
4. `docs/design.md` and `docs/board.md` before any architecture or board change.
5. `docs/parallel-work.md` before fanning out: worktrees, per-worktree databases over TCP on 5442,
   port blocks.

## Constraints that will bite

- **Postgres on 5442 is part of the gate**, reached over TCP. On this machine it is Docker Desktop's
  container; `lsof -nP -iTCP:5442 -sTCP:LISTEN` names it. Create per-worktree databases over TCP,
  never with `docker exec`.
- **Gate every change** with `bun run format:check`, `build`, `lint`, `test`, `type-check`; the Effect
  diagnostics run with `denyWarnings`. A new test file in `packages/storage-postgres` goes on a
  `case-budgets.test.ts` list.
- **The verify skills share `.verify/run`.** verify-board and verify-workflow use the same instance
  files; run one board instance at a time, each on its own ports and database.
- **Local first, fakes for third parties.** No cloud resource, no real token and no real model
  provider in an agent's run; `docs/testing-third-parties.md` names the fake for each.
- **Pi Durable is consumed as an interface, never modified.**

## Definition of done for this stretch

- LOB-40 Done: the owner's live run posted on it, with its time and cost.
- LOB-41 Done by its own criterion.
- Every umbrella's follow-ups harvested, LOB-252 merged, the umbrellas closed, and the drafts filed
  once Linear has room.
