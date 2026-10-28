# Author a new definition version

**Status: passing.** D4, 2026-10-28, `agent/D4`: `./define.sh` exit 0, **29/29**, twice against one
`./up.sh` instance (API on `:9510`, web on `:3510`, the GitHub fake on `:9513`), with
`./definitions.sh` green beside it. F5-F7-F8 added the round trip and author checks (see below).

## What it is

An admin changes the pipeline without writing a migration: adds, renames or removes columns, changes
roles, skills and requirements, and changes moves and gates. Each change is a **new version** of a
definition, never an update of a row (docs/board.md B2) — a board pinned to an older version keeps
reading exactly what it pinned, and a board created afterwards pins the new one.

`defineBoard({ id, name, columns, initialColumn, caps?, dryRun? })` writes the version that follows
the id's newest (version 1 for an id the factory does not hold). Content identical to the newest
version writes nothing and answers that version (`unchanged`); `dryRun` validates and answers the
version it would write (`validated`). Everything else a version is held to is refused as
`InvalidDefinition` — `field` names the first fault's path into the file, `problems` lists every
fault — and nothing is written:

- a duplicate column name, a blank column or definition name;
- no initial column, one the definition does not declare, or a terminal one;
- a move to an undeclared column, to itself, or to one target twice; a gate with no name;
- a terminal column with exits; a column that is not terminal and has none; no terminal column;
- a terminal column not named `done` or `canceled`, or a non-terminal one so named: the workspace
  release on arrival and the caps' count of runs in flight still decide "finished" by those names,
  not by `kind`, so a terminal `shipped` would keep its cards' worktrees and count its runs against
  caps forever, and a working `done` would tear a live card's worktrees down;
- an unknown requires key (`KNOWN_REQUIREMENTS`: the checked keys and the declared-only ones), or
  one declared twice in a column; `human_move` or `human_merge` on a column none of whose moves
  names a `gate` — the transition's `gate` is what makes a move a person's, and nothing reads the key;
- a skill the skill library (D7's `SkillService`) does not hold — what a run would otherwise fail to
  start on as `MissingSkill`;
- a role, when the deployment's role table (`ROLE_MODELS`) has any rows, that the table does not
  name, the harness gives no meaning to (`specifier`, `reviewer`: `HARNESS_ROLES`), and no
  definition the factory holds already declares. `ROLE_MODELS` is a partial override table — a role
  it does not name runs on the deployment's model — so the default pipeline's `planner` and `builder`
  are accepted under a table that names only `reviewer`; what is refused is a typo (`buidler`).

The rules are `packages/core`'s `authoredDefinitionFaults` (`boardDefine.ts`), pure; the write is
`TaskService.defineBoard`, one transaction under an advisory lock on the id, so concurrent defines
of one id take consecutive versions. The API handler hands the rules the skill table, read afresh per
call, and the session layer's role table; `TaskService.defineBoard` adds the roles the definitions it
holds declare. The handler describes the answer as `getDefinition` does.

## Round trip and author (F5, F7, F8)

`definition show <id> --version N --json` prints the version as the file `define` takes
(`getDefinitionSource`); `./define.sh` defines it back `--dry-run` and gets `unchanged`, edits the
name and gets v3 differing in that line only, and reads a legacy version (`default` v1) with its
moves and initial column spelled out. With auth off `board define` attributes its version to `cli` (and the editor writes `dashboard`), as a
card move does, shown as `by cli` in `board definitions`; a credential's actor overrides it, proven by
verify-api's `identity.sh` (`author:` checks) and shown on the settings page by verify-web's `board-settings.sh`.
`./definitions.sh` compares `factory board vocabulary` with the RPC line for line (`vocabulary.ts`).

## How a user reaches it

```sh
factory board define --file pipeline.json --dry-run   # validate against everything; write nothing
factory board define --file pipeline.json             # write the next version
factory board define --file - < pipeline.json         # the same, from stdin
```

The file is `defineBoard`'s payload as JSON, less `dryRun` (the flag's): `id`, `name`,
`initialColumn`, optional `caps`, and `columns` as `BoardColumn` declares them (`transitions`,
`wipLimit` and all). A file that is not JSON, is not a definition, or carries a key the schema does
not name (a misspelt `wipLimit`) is the CLI's `invalid_input` and nothing is sent. The answer prints
`defined`, `unchanged` or `valid` with the version, then the version described as `definition show`
prints it. A refusal prints `error: invalid_definition: definition <id>: <field>: <why>` and then
every fault, `  <field>: <why>`, one per line, and exits non-zero.

## How the skill drives it

`define.sh`, against `./up.sh`'s API (`ROLE_MODELS=builder=faux/builder,reviewer=faux/reviewer`),
with plain subprocesses. Its definition is its own (`drv<hex>`), never `default`. `define.ts` reads
the oracle straight from `board_definitions`: every row with an md5 of the whole row, and the
versions one id holds. It asserts:

- `--dry-run` exits 0, says `would be written as v1; nothing written`, describes the version, and the
  table is unchanged, row for row;
- the define writes `<id>@1` and nothing else, every existing row unchanged, and prints it described
  (initial column, caps, WIP limit, `faux/builder (role)`, the `sign-off` gate); the same file again
  is `unchanged v1` and writes nothing;
- a renamed file on stdin is `<id>@2`, the only new row, with `<id>@1` byte for byte what it was;
- `board definitions` lists v1 and v2; `board create --definition <id>` pins v2; `board config`
  describes it; `board add` starts a card in its initial column, `todo`;
- the spec's eight refusals — duplicate column, no initial column, undeclared move, terminal column
  with exits, no terminal column, unknown requires key, unknown skill, a role no table, harness or
  definition knows (`buidler`) —
  and an unknown skill under `--dry-run`: each `invalid_definition` naming its field, non-zero, and
  the table unchanged;
- a file that is not JSON, one with `wiplimit`, and a missing file are `invalid_input`, and the table
  is unchanged.

Evidence: `define.json` (every check), `define-*.txt` (each command and its output),
`define-v1.json` (the file defined).

Below the terminal: `packages/core/src/boardDefine.test.ts` takes every rule on its own against an
otherwise valid definition; `TaskService.define.test.ts`, against Postgres, proves newest + 1 with no
existing row changed, identical content and dry runs writing nothing, each refusal writing nothing
for a new id and for an existing one, `listDefinitions` and `createBoard` reading the new version,
and four concurrent defines taking v1–v4; `apps/api/src/Rpc/Task.test.ts` calls `defineBoard` over
NDJSON against the real skill table (a skill refused until `putSkill` puts it) and a role table;
`apps/cli/src/commands/boardConfig.test.ts` the file decoding and the printed lines.

A board created before the define keeps its pin; moving it to the new version, and its cards with it,
is `factory board upgrade` ([upgrade.md](upgrade.md), D5).

## What it does not prove

There is no dashboard editor (D6 builds on this RPC); a definition is authored from a file. Nothing
records who defined a version — `board_definitions` has no author column. `definition show` prints a
description, not a file `define` takes back, so editing an existing version starts from the
author's own file. A definition cannot be deleted, by design (B2).

Terminal columns must keep the names `done` and `canceled` until `WorkspaceRelease` and `boardCaps`
read the card's pinned version's `kind` (Follow-up (D4)). Authoring the id `default` is allowed, and
races the seed migrations: each seeds `default` at a fixed version with `ON CONFLICT (id, version) DO
NOTHING` (0026 v4, 0038 v5), so an operator's `default` v6 makes a later seed of v6 a silent no-op. A
future seed of an existing id must insert at the newest version + 1, not a fixed number
(docs/board.md, D4; Follow-up (D4)); 0044 (D10, the `plan` skill) is the first that does. The drive never authors `default`.
