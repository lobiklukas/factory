# `factory skill`

**What it is.** The factory's skills from a terminal (D7): the prompt text a board column binds
(docs/board.md B6). `factory skill ls` lists every skill at its newest version with the columns of the
default definition's newest version that bind it, `factory skill show <name> [--version N]` reads one
version (header and body), and `factory skill put --file SKILL.md [--name …]` puts a new version. A put
is always version `newest + 1` (1 for a new name) and never rewrites a row, and a run keeps the
version its log pinned when it opened (B2), so a put reaches the next run and no run in flight — which
is what `put` prints on its `note` line.

`put` reads the file's frontmatter `name` and `description` (plain, quoted, or a `|`/`>` block) and
treats everything after the frontmatter as the body, as the loader never injects frontmatter. A file
with no description keeps the superseded version's, and attachments are always the superseded
version's (a `SKILL.md` declares none).

**How a user reaches it.** `factory skill ls`, then `factory skill show specify`, then
`factory skill put --file SKILL.md`. Each RPC is in `SkillsRpc` (`listSkills`, `getSkill`, `putSkill`).

**How the skill drives it.** `./skill.sh`, run by `./drive.sh` against the `./up.sh` instance, in a
tmux server of its own. Each command's pane is kept as `skill-*.txt`; the checks are in `skill.json`.
It puts only a skill named for its run (`verify-cli-skill-<run>`), so the shipped skills are never
edited by a drive.

1. `skill ls` — exit 0, the header `name version columns updated-at description`, `specify` at a
   number with `specifying`, `implement` with `building`, `review` with `review`, `decompose` with
   `none`.
2. `skill show specify` — `version      N (newest)` for the `ls` version, and the `# Specify` body.
3. `skill put --file v1.md` (frontmatter with a two-line `|` description) — `put <skill>@1`,
   `previous none (a new skill)`, the description folded onto one line.
4. `skill put --file v2.md` (no description) — `put <skill>@2`, `previous <skill>@1`, the note that
   open runs keep `@1`, and the description kept from version 1.
5. `skill show <skill> --version 1` — `version      1 (newest is 2)` and version one's body, not two's;
   `skill show <skill>` — `version      2 (newest)` and version two's body. Version 1 was not
   overwritten.
6. Refusals: an unknown name and `--version 9` are `skill_not_found` (the latter naming the version),
   a blank body is `invalid_skill`, and a file with no name against `http://127.0.0.1:9` is
   `invalid_input` — nothing listens there, so it was refused before any request.
7. `skill ls` again lists the skill once at version 2 with `none`; piped, the header and the
   `specify` row's columns are tab-separated.

**What proves it.** All checks in `skill.json` pass. That a run keeps the version it opened with is
not visible from a terminal; it is proven by `packages/harness`'s session suite ("a run keeps the
skill version it opened with") and `packages/core`'s SessionService suite ("keeps a run on the
specify version it opened with through a put and a reopen"), against Postgres.

**Verified.** 2026-10-28 from the `agent/D7` worktree, API on `:9520` — 16/16 checks.
