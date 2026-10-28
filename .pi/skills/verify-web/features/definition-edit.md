# Definition editor

**Status: passing.** `/boards/<id>/settings/edit` edits a board's pinned definition version as a
**new** version (D6, under the board-configuration umbrella LOB-245). An admin adds, removes,
reorders and renames columns, sets each column's kind and role, binds skills from `listSkills`,
declares exit requirements from the known keys, and edits moves out and their human gates. A diff
against the pinned version is shown before saving, and **Save** calls `defineBoard`. The pinned
version is never edited (docs/board.md B2): the server writes the definition's newest version + 1,
the page says "v<n> created", and the board stays pinned to its version until it is upgraded.

## Sub-features

- The settings page's **Edit as new version** link (`[data-settings-edit]`) opens the editor. The
  editor is its own route (`boards.$boardId_.settings_.edit.tsx`), so the settings page stays
  read-only ([board-settings.md](board-settings.md)).
- Three reads, once per opening: `getBoard` (`editedBoardAtom`) for the pinned version as stored,
  so every field each column carries is in the draft; `listSkills` (`skillsAtom`); and
  `getDefinitionVocabulary` (`definitionVocabularyAtom`), the requirement keys the factory knows
  (each with a starting description, `checked`, and `humanGate`) and the roles `defineBoard`
  accepts: the role table, the harness's roles, and every role a held definition declares.
- The draft (`lib/definition-edit-view.ts`) holds the version's own column objects. A field the
  editor has no control for (a WIP limit, the caps, a field a later change adds to the schema) is
  sent back as it came. A legacy version (default v1–3) opens with its moves and initial column
  spelled out, as its cards meet them, and the diff does not count that as a change.
- A rename carries the moves into the column and the initial column with it. Removing a column drops
  the moves into it. Both match moves by the target column's draft key, not its name, so a name typed
  on the way that another column holds (`doing` → `todo_x` passes `todo`) never re-points a move. **Add a column** (`[data-add-column]`) puts `new_column` (working, no moves)
  before the first terminal column.
- Pickers, never free text: `[data-skill-picker]` is a `<select>` of the library's names the column
  does not bind, and `[data-requires-picker]` a `<select>` of the vocabulary's keys the column does
  not require. A requirement's description (`[data-requirement-description-input]`) is prose and is
  typed. So is a gate's name (`[data-move-gate]`); left blank, the move has no gate. A move's target
  (`[data-move-to]`) is a select of the other columns.
- `[data-definition-diff]` lists `+`/`-`/`~` lines (`[data-diff-line]`) against the pinned version.
  Columns are matched by where they came from, so a rename is one line; moves by the column they
  point at, so a removed column's name taken by a rename still reads as the move into it removed. `[data-definition-diff-empty]`
  and a disabled **Save** (`[data-definition-save]`) show when there is nothing to change.
- A refusal is the server's. `InvalidDefinition` puts each fault next to the field it names
  (`[data-field-fault=<path>]`, in `[data-fault-slot]`). The fault's column index is read against the
  columns as they were sent, so a reorder after the refusal keeps each fault on its column. A fault
  no field holds is listed in the banner (`[data-define-refusal]`). A save that answers clears it.
- When the definition holds versions newer than the pin (`listDefinitions`), the header says so
  (`[data-editor-newer-versions=<list>]`): the draft starts from the pin and the save writes newest +
  1, so it supersedes those versions without their changes.
- The version is written as the dashboard's (`actor: "dashboard"`, F7): `definition-edit.mjs` reads the saved
  v2's `author` back as `dashboard`.
- Saved: `[data-definition-saved="created"][data-saved-version=<n>]` reads "v<n> created. This board
  stays pinned to v<pinned> until it is upgraded; a board created now pins v<n>." Saving content the
  newest version already holds writes nothing (`unchanged`). The definition list re-reads
  (`DEFINITIONS_KEY`), so the settings page names the new version.

## How to get to it (user POV)

Open **Boards**, open a board, click **Settings**, then **Edit as new version**.

## Driving it

```sh
DATABASE_URL=… DEFINITION_EDIT_API_PORT=9475 DEFINITION_EDIT_WEB_PORT=3475 ./definition-edit.sh
```

The script starts its own API (`ROLE_MODELS=builder=faux/faux-1`) and dashboard and runs
`definition-edit.mjs`. The drive authors its own definition `edit<hex>` v1 over `defineBoard`, with a
WIP limit and caps the editor has no control for. It makes a board pinned to that version, and asks
the RPC, never the page, for the oracle. It requires:

1. **Edit as new version** to open the editor on v1's columns, with no change listed and Save off;
2. every column's skill and requires picker to be a `<select>` whose options are `listSkills`' names
   and `getDefinitionVocabulary`'s keys less the column's own, and no text field for either;
3. **Add a column**, renamed `qa`, to sit before `done`. Saving it with no moves out puts the
   server's `InvalidDefinition` fault next to qa's moves (`columns[2].transitions`), and
   `listDefinitions` still holds v1 only;
4. qa given a move to `done`, a skill and `verified` from the pickers, and doing's gated move pointed
   at qa: the diff names the new column and both moves;
5. Save to read "v2 created" and that the board stays pinned to v1. `listDefinitions` must hold
   `[1, 2]`, and v2's columns must be the draft's, with doing's WIP limit 2, its role and skill, and
   the caps `{ board: 3 }` kept. `getBoard` must still pin v1;
6. the editor, once v2 exists, to say a save from v1 writes v3 without v2's changes;
7. a second Save of the same draft to answer `unchanged` and write nothing;
8. doing renamed key by key to `todo_x`, passing `todo`, to leave todo's move on it: the diff holds
   the rename and no change to todo's moves;
9. the settings page to read v1 and say v2 exists, the editor of a missing board to read
   `No such board`, and no console error.

Evidence goes to `.verify/evidence/latest/definition-edit/`: `definition-edit-open.png`, `-refused.png`
(the inline fault), `-diff.png`, `-saved.png`, `-typed.png`, `-settings.png`, `observed.json` (the vocabulary, the
pickers' options, the diff, v2 as the RPC answers it, every check), `api.log`, `web.log`.

## Last run

2026-10-28 from the `agent/D6` worktree, API `:9512` / web `:3512`: **20/20** passed.
`board-settings.sh` re-passed there (API `:9513` / web `:3513`) once the board page's getting-started
reads (C9) joined its shell-read allowlist.
