# Upgrade a board to a newer definition version

**Status: passing.** D5, 2026-10-28, `agent/D5`: `./upgrade.sh` exit 0, **20/20**, twice against one
`./up.sh` instance (API on `:9540`, web on `:3540`, the GitHub fake on `:9543`), with `upgrade.mjs`'s
**2/2** (`MODE=notice`) and **7/7** (`MODE=upgrade`) folded in; `./define.sh` and `./board-create.sh`
green beside it, and verify-web's `board-settings.sh` green with the Upgrade action on the page.

## What it is

A board is pinned to one definition version (B2), and a repository has one board, so recreating the
board is no way to pick up a newer pipeline. An upgrade moves the pin:

`upgradeBoard({ boardId, toVersion, expectedVersion, migrateCards?, actor })`

- **The pin.** `expectedVersion` is the version the caller read the board at; another upgrade that
  moved it first makes this one `StaleBoardVersion` (as a card's `expectedRevision` makes a move
  `StaleRevision`). `toVersion` is newer than the pin — or the pin itself, with `migrateCards`, to
  re-pin cards an earlier upgrade left behind — a version the definition holds (`DefinitionNotFound`
  otherwise) and one that can start a card. After it, a new card pins `toVersion`, and every card
  already on the board keeps the version it pinned, with its moves and exit requirements.
- **The explicit migration.** `migrateCards` is a column mapping (`{ <column a card is in>: <column of
toVersion> }`). Every card not already on `toVersion` is re-pinned in the column its own maps to,
  with a `repinned` event (`fromVersion`, `toVersion`, `from`, `to`, the whole mapping, the actor) at
  the revision it was read at, and a new revision. A blocked card keeps its block, its blocked column
  mapped the same way.
- **All or nothing.** A card with an unfinished run (`unfinished_run`: `task_runs.finished_at` unset
  and its workspace not released), in a column the mapping does not name (`unmapped_column`), or
  mapped to a column of another kind (`kind_changed`: a migration re-pins a card, it does not move it
  past a gate) refuses the whole batch as `CardMigrationRefused`, naming every such card — and
  nothing is written, not even the pin. A mapping onto a column `toVersion` does not declare is
  `InvalidTaskInput` naming `migrateCards.<column>`.

`TaskService.upgradeBoard` is one transaction: the instance row locked (`FOR NO KEY UPDATE`), so two
upgrades are serialised and a card being made waits (`insertCard` reads its board `FOR SHARE`) or
commits before the cards are read; for a migration, the repository's `task_runs` advisory lock that
every run start on a card takes, so no run starts between the check and the re-pin.

## How a user reaches it

```sh
factory board upgrade --board brd_… --to 3 --expect-version 2                 # the pin only
factory board upgrade --board brd_… --to 3 --expect-version 2 --same-columns  # and every card, by name
factory board upgrade --board brd_… --to 4 --expect-version 3 --same-columns --map doing=review
```

`--same-columns` maps each column of the target version to itself, and each `--map from=to` sets one
entry over it. The answer prints `upgraded <board> <definition> v<from> → v<to>`, one `repinned` line
per card (its version and column before and after, its new revision) and how many cards still pin an
older version. `board show` prints a card's `pinned    v<n>`, and `board ls` says when the board's cards
pin more than one version.

In the dashboard, a board's settings page offers **Upgrade this board** when a newer version exists:
a version picker, **Also migrate the board's cards** (unchecked by default), and — when checked — the
mapping, one row per column of the pin, each preset to the target's column of the same name or
"not mapped". The board page says when its cards pin more than one version, naming each and the
board's own.

## How the skill drives it

`upgrade.sh`, against `./up.sh`'s instance, with plain subprocesses and `upgrade.ts` reading the
oracle (the pin, each card's version, column, revision and event count, its newest event) straight
from the tables. Its board is its own (`verify-board/upgrade-<hex>`), created on `default` v2:

- a card made on v2 prints `pinned    v2`; `--expect-version 1` is `stale_board_version` and writes
  nothing;
- `--to 3 --expect-version 2` moves the pin to v3 and only the pin — the old card's row and history
  are byte for byte what they were — and says one card still pins an older version;
- a card made after it prints `pinned    v3`; `board ls` and the board page (`upgrade.mjs
MODE=notice`) say the cards pin v2 and v3;
- with both cards seated in `review` (a fixture write: reaching review honestly takes a building run
  with a diff and a PR, which `requires.sh` proves), the new card's exit lists `verified` and the old
  card's does not, and `review → done` is refused naming `verified` for the new card and
  `review_verdict` for the old one — **the `verified` gate applies to the new card**;
- a mapping that leaves `review` out is `card_migration_refused` naming both cards, and writes
  nothing;
- `--same-columns` to v4 re-pins both, each with a `repinned` event (v2 → v4, every column mapped to
  itself, actor `cli`) at its revision; the old card's move is now refused naming `verified`;
- the settings page's Upgrade (`upgrade.mjs MODE=upgrade`) to the newest version with the migration
  checked sends one `upgradeBoard` at v4 with the preset mapping as `dashboard`, says what it did, re-reads
  the pin, and the board page no longer says its cards pin more than one version; both cards'
  newest events are `repinned` by `dashboard`.

Evidence: `upgrade.json` (every check), `upgrade-*.txt` (each command and its output),
`upgrade-web-notice.json`, `upgrade-web-upgrade.json`, `upgrade-notice.png`, `upgrade-form.png`,
`upgrade-done.png`.

Below the terminal: `packages/core/src/TaskService.define.test.ts` (its `upgradeBoard` cases, beside the define cases so no other file writes `board_definitions` under them), against Postgres, proves the pin
moving while an old card keeps v1's moves and a new card gets v2's, the stale-version refusal, the
version refusals, a migration through a renaming mapping (event, revision, the block's column, the
replayed history), a refused batch writing nothing for an unfinished run and an unmapped column (a
finished run does not hold a card), the kind and undeclared-target refusals, re-pinning stragglers at
the pin, the `verified` gate on default v2 → v3, and cards made during a migration all landing on the
new version (which fails without `insertCard`'s `FOR SHARE`). `apps/api/src/Rpc/Task.test.ts` calls
`upgradeBoard` over NDJSON; `apps/cli/src/commands/boardUpgrade.test.ts` the flag mapping and the
printed lines; `apps/web/src/lib/board-upgrade-view.test.ts` the page's mapping and words.

## What it does not prove

The drive's refused batch is an unmapped column; the unfinished-run refusal is proven against
Postgres only (a run in flight on the drive's card would need a scripted turn held open). The
dashboard's Upgrade offers versions newer than the pin only, so re-pinning cards an earlier upgrade
left behind (`toVersion` equal to the pin) is the CLI's. A run's `task_runs.column` is not rewritten
by a mapping that renames a column, so an earlier run's column keeps its old name.
