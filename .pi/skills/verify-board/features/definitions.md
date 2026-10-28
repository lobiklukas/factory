# Read definitions and a board's configuration

**Status: passing.**

## What it is

A board binds a repository to a version of a definition (docs/board.md B2), and what a card on it
meets is not all in the definition's row. LOB-270 makes the whole of it readable before anyone trusts
the board: which definitions and versions exist, and for one version — or the one a board pins —
every column with:

- its kind and its role (or `—`);
- its role's **resolved model**: the deployment's `ROLE_MODELS` row for the role (`role`), or the
  deployment's own model for a role with no row and a column with no role (`deployment`). Read from the
  session layer's own table (`SessionService.roleModel`), the one `openSession` resolves a run's model
  from;
- its skills;
- its exit requirements, each **checked** (the board refuses a move over it: `verified`,
  `non_empty_diff`, `pr_link`, `review_verdict`, `spec_doc`, `run_completed`, and since C20
  `human_merge` on a move into `done` — `CHECKED_REQUIREMENTS`) or **unchecked** (declared, enforced
  by nothing yet: `plan_doc`, and `human_move`, whose gate the move's actor check enforces instead);
- its exits, from the column's own `transitions` (LOB-267) — or, for default versions 1–3, which
  declare none, the default pipeline's table — exactly what `TaskService.move` refuses by, with the
  **human gates** marked (`plan approval` on `planning → building`, `merge` on `review → done`).

Under the header, `initial` names the column a new card starts in: the definition's `initialColumn`,
or its first column for a version that names none (`intake` in default v1–v3).

The description is `packages/core`'s `describeDefinition`, a pure join of the row with those three
tables, so the read cannot drift from what a move or a run does.

## How a user reaches it

```sh
factory board definitions                                 # every id and version, oldest first
factory board definition show default --version 3         # one version, column by column
factory board definition show default                     # the newest — the one `board create` pins
factory board list                                        # the newest 100 boards: id, repo, pinned version
factory board config --board brd_…                        # a board's repo and pinned version, described
```

or, on the RPC surface (`TasksRpc`): `listDefinitions` → `[{ id, versions: [{ version, name,
createdAt }] }]`, `getDefinition({ definitionId, version? })` → `DefinitionConfig`, and
`getBoardConfig({ boardId })` → `{ instance, definition: DefinitionConfig }`. An unknown id or version
is the typed `DefinitionNotFound` (`definition_not_found` on the CLI), in `createBoard`'s words; an
unknown board is `BoardNotFound`.

## How the skill drives it

`definitions.sh`, against `./up.sh`'s API (`ROLE_MODELS=builder=faux/builder,reviewer=faux/reviewer`, faux backend), with
plain subprocesses — stdout, stderr and the exit code are what it asserts — and one run in a private
tmux server. `board-create.ts` reads the two facts a terminal cannot: the newest `default` version
and how many boards the database holds. It asserts:

- `board definitions` lists `default` v1 through the database's newest (≥ 3), oldest first, each with
  its name and timestamp;
- `board definition show default --version 3` prints every column in definition order, with `—` for
  no role, `faux/builder (role)` for `building`, `faux/reviewer (role)` for `review`,
  `faux/faux-1 (deployment)` elsewhere, the checked and
  unchecked requirements, and both human gates on their exits — and its whole output equals
  `definitions-v3.expected`, written by hand, not generated;
- with no `--version` it shows the newest;
- an unknown id and an unknown version are `error: definition_not_found: …` verbatim, non-zero; a
  malformed id is `invalid_input`, sent nowhere;
- `board list` prints the seeded board and a v1 board made for the check, each with its repo and
  pinned version, and one line per board the database holds up to `listBoards`' cap of 100 — at
  the cap its last line says `(showing the newest 100 boards; older boards may exist)`, and
  under it no such line appears;
- `board config` names the board, repo and pinned version, and its columns are exactly what
  `definition show` prints for that version; a v1 board's config describes v1 (`review` has no
  `verified` yet); an unknown board is `board_not_found`, a malformed one `invalid_input`;
- in a tmux pane (`bash --norc`, `PS1='$ '`), `definition show default --version 3` exits 0 and the
  pane reads `definitions-v3.expected` line for line.

Evidence: `definitions.json` (every check), `definitions-*.txt` (each command and its output),
`definitions-show-v3.diff`, `definitions-config.diff`, `definitions-pane.txt` and
`definitions-pane.diff`.

Below the terminal: `apps/api/src/Rpc/Task.test.ts` calls the three RPCs over NDJSON against the app's
own router in a scratch database, with a role table, and compares default v3's whole description;
`packages/core/src/boardConfig.test.ts` and `TaskService.test.ts` (`reading definitions`) cover the
join and the reads; `apps/cli/src/commands/boardConfig.test.ts` the printed layout.

## What it does not prove

The dashboard's settings view reads this same `getBoardConfig` answer; verify-web's
`board-settings.sh` proves it (`.pi/skills/verify-web/features/board-settings.md`).
Nothing here writes a definition: a new version is `factory board define`'s ([define.md](define.md),
D4), and the role table is deployment configuration, read-only. Transitions and gates are definition data since LOB-267; a
definition with its own column set is driven through the card pane by verify-web's `drive.mjs`
(`features/card-pane.md`, "a definition's own moves").
