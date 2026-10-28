# Board settings

**Status: passing.** `/boards/<id>/settings` says what a board will do: the definition version it
pins, and every column of it in order with its kind, its role and the model that role resolves to,
its skills, its exit requirements each marked **checked** or **not yet checked**, its moves out and
the human gate a move crosses. Each lane header on `/boards/<id>` has a disclosure with the same
facts for its column (LOB-245, the board-configuration umbrella).

## Sub-features

- The board header's **Settings** link (`[data-board-settings]`) opens the page; the page links back
  to the board (`[data-settings-board-link]`).
- One read: `getBoardConfig` (`boardConfigAtom`), the instance with its pinned version described
  exactly as `getDefinition` describes that version — `describeDefinition` on the server, so the
  requirement states, exits, gates and models are the ones a move and a run meet. Read once per
  opening, not polled: a version is never edited in place (docs/board.md B2).
- The header names the definition (`[data-settings-definition]`, `[data-settings-version]`), the
  column a new card starts in and the version's run caps.
- `listDefinitions` (`definitionsAtom`, the New board form's read) says whether a newer version
  exists: `[data-newer-versions="3,4,5"]` and "Newer versions of default exist: v3, v4 and v5. This
  board stays pinned to v2; a board created now pins v5.", or `[data-newest-version]` on the newest.
  A failed list says it could not tell (`[data-newer-versions-unknown]`) instead of claiming either.
- Each column is `li[data-settings-column]` holding `ColumnSettings` (`[data-column-settings]`):
  `[data-column-kind]`, `[data-column-role]` (`—` for none), `[data-column-model]` with
  `data-column-model-source` (`role` or `deployment`, worded "role model" / "deployment default"),
  `[data-column-skill]` per skill, `li[data-requirement]` with `[data-requirement-key]`,
  `[data-requirement-description]` and `[data-requirement-state]`, `li[data-exit]` with
  `[data-exit-to]` and `[data-exit-gate]`, and `[data-column-wip]` when the column has a WIP limit.
- A lane's disclosure (`[data-lane-settings-toggle=<column>]`, panel `[data-lane-settings=<column>]`)
  is closed by default and mounts its read only when opened, so a board nobody inspects never reads
  its config. It renders the same `ColumnSettings` and links to the page.
- Read-only. There is no edit control on the page; authoring a version is a later change. The drive
  proves it: the page (`[data-board-settings-page]`) holds no form, input or button, and every RPC
  the browser sends while on it is `getBoardConfig`, `listDefinitions` or one of the shell's own
  reads. Skill names are plain text until a skills page exists to link them to.
- `/boards/not-a-board/settings` is refused by the route's decode; a well-formed id the server does
  not hold reads `No such board`.

## How to get to it (user POV)

Open **Boards**, open a board, click **Settings** in its header. Or press the chevron at the right of
any lane header to see that column alone.

## Driving it

```sh
DATABASE_URL=… BOARD_SETTINGS_API_PORT=9471 BOARD_SETTINGS_WEB_PORT=3471 ./board-settings.sh
```

The script starts its own API (`ROLE_MODELS=specifier=faux/faux-spec`, so one column resolves to a
role model and the rest to the deployment's) and dashboard, makes two boards over the RPC — one on
the default definition's newest version, one pinned to v2 — runs `board-settings.mjs`, and stops
both. The oracle is `getDefinition` for each board's version, asked from the drive process. It
requires:

1. the board's **Settings** link to open `/boards/<id>/settings`, naming `default v<newest>`, with
   the columns in declaration order and the initial column;
2. every column read back from the page — kind, role, model and source, skills, requirements with
   their state, exits with their gates, WIP limit — to equal `getDefinition`'s column in the page's
   words, and the comparison to cover non-empty skills and requirements;
3. `planning → building` to carry the human gate `plan approval`, `specifying`'s role to be
   `specifier` on `faux/faux-spec` (source `role`), and some column to run the deployment's model;
4. `plan_doc` (unchecked) to read `not yet checked`, and a checked requirement to read `checked`;
5. the newest board to say it is the newest and claim no newer version;
6. the v2 board to name exactly the newer versions `listDefinitions` holds, including v3, and its
   columns to equal `getDefinition` for v2 — which differs from the newest;
7. every lane's disclosure to be closed on load, each to show its column's facts equal to
   `getDefinition` once pressed, a second press to close it, and its link to open the page;
8. no console error, a malformed id refused, and a missing board reading `No such board`.

Evidence goes to `.verify/evidence/latest/board-settings/`: `board-settings-newest.png`,
`board-settings-pinned.png`, `board-settings-lanes.png` (every disclosure open),
`board-settings-missing.png`, `observed.json` (both oracles, what the page showed, every check).

`drive.mjs`'s lane checks ([board.md](board.md)) count every button in the lanes as a move control
except a settings disclosure's, and its write check still fails on any write the board pages send.

## Last run

2026-10-28 from the `agent/D3` worktree, API `:9540` / web `:3540`: **23/23** passed.
