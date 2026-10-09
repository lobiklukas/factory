# Ralph verification audit

You are the maintenance pass for the repo's verification layer, with a fresh context. Verification
skills rot: a drive that passed last month may fail, a feature doc may claim `passing` for something
that changed, a surface may have no skill at all. You find and fix that. You write no production
code. Read `AGENTS.md` first, then every `.pi/skills/verify-*/SKILL.md` and its `features/README.md`.

Launch `ralph-verifier` and `ralph-researcher` with `async: true`. Linear is reached through `codemode` (`tools.mcp__linear__*`, results in
`res.content[0].text` as JSON). Subagents are authorized: `ralph-verifier` (writer), `ralph-reviewer`.

## Steps

1. **Branch:** `git fetch origin && git switch -c ralph/verify-audit-<YYYYMMDD> origin/main`.
2. **Inventory surfaces:** read `packages/domain` (Rpc/Api), `apps/*`, and `docs/handoff.md`. Make a
   table: surface -> verify skill (or none) -> features documented -> features that exist in code.
3. **Run every skill** on the Run-context ports and database, one at a time (they share `.verify/`):
   run its `doctor.sh`, `up.sh`, the drive(s), `down.sh`. Record pass/fail counts and the evidence path.
4. **Fix drift** you can fix without production code: a stale drive, a changed selector, a feature
   doc that no longer matches, a status that was not earned, a missing `down.sh`. Fix by launching
   `ralph-verifier` with the failing output. Add a skill for a surface with none, and a feature doc
   for a feature with none.
5. **Test health:** run `bun run test` with the Run-context database. List skipped/todo tests, tests
   that reach the network, and third-party systems with no entry in `docs/testing-third-parties.md`.
   Add the missing entries (launching `ralph-researcher` per system, `async: true`) or file them.
6. **Every failure that needs production code, and every problem you find but do not fix, is a
   ticket.** Read `.pi/ralph/ticket.md` and file per it (labels `ralph`, `Bug`), with the exact failing
   check, output and evidence path. The audit's whole value is that nothing it finds stays unfiled. The
   3-ticket cap does not apply here; group by root cause.
7. **Gate** (`format:check`, `build`, `lint`, `test`, `type-check`), then one `ralph-reviewer` (`tests`
   angle) over the diff. Fix P0/P1.
8. **Deliver:** when `RALPH_PUSH=1`, push and open a PR (not a draft) titled `chore(verify): audit <date>`
   with the table from step 2, the before/after counts, issues filed (ids). The driver arms auto-merge, so
   open it only once the gate is green and the reviewer is clean. Never merge it yourself. Append a short
   entry to `.ralph/progress.md`. Finally `git switch --detach origin/main`.

Hard rules: never weaken or delete a check to make it pass; status `passing` only for what ran
green now; `down.sh` after every `up.sh`; never touch the default `factory` database; do not read `.env`.

## Control line

Last non-empty line: `<promise>COMPLETE</promise>` (audit delivered) or `<promise>BLOCKED</promise>`
(infrastructure prevented the audit).
