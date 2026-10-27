# Create a board

**Status: passing.**

## What it is

A board instance binds one repository to a version of a named definition (docs/board.md B2), and
every card and run on the board reads its columns through it. `TaskService.createBoard` (LOB-208) is
the one writer of `board_instances`: it pins the version named, or by default the definition's
newest, in one `INSERT … SELECT` over the definition's own rows. An unknown definition, or a version
of it that does not exist, is the typed refusal `DefinitionNotFound`, and nothing is written.

## How a user reaches it

```sh
factory board create --repo lobiklukas/factory              # the default pipeline, newest version
factory board create --repo lobiklukas/factory --version 1  # pinned to version 1
factory board create --repo lobiklukas/factory --definition other
```

or `createBoard` on the RPC surface, `{ repo, definitionId, definitionVersion? }` → the instance.

## How the skill drives it

`board-create.sh`, against `./up.sh`'s API, with plain subprocesses (stdout, stderr and the exit code
are what it asserts). `board-create.ts` reads the two facts a terminal cannot: the newest `default`
version straight from `board_definitions` (the oracle, not the service's answer), and the prompt
sections in a run's own log. It asserts:

- `board create --repo …` exits 0, prints a `brd_…` id, the repo, and `default v<newest>`;
- `--version 1` makes a second board over the same repo, pinned to `v1`;
- `board ls` on the made board prints the repo and version in its header and every lane in order;
- a card made on it with `createTask` moves to `specifying`, and the run `board start` opens there is
  told the `specify` skill — the run-column join in `SessionService` found the board `createBoard`
  wrote;
- `--definition nosuch…` is `error: definition_not_found: no board definition nosuch…`, non-zero;
- `--version 99` is `error: definition_not_found: board definition default has no version 99`;
- `--repo "Not A Repo"` is `invalid_input` from the CLI, and nothing is sent.

Evidence: `create-board.json` (every check), `create-board-*.txt` (each command and its output),
`create-board-prompt.json` (the run's prompt sections).

`./up.sh`'s own seed (`seed.ts`) and `requires.ts` make their boards through the same
`createBoard`, so every drive in this skill runs on a board no SQL wrote.

## What it does not prove

The dashboard has no create-board form; `/boards` lists what `createBoard` made on its next load
(`.pi/skills/verify-web`'s `features/board.md`). Definitions are still written only by migrations.
