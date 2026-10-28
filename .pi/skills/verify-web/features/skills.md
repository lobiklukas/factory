# Skill pages

**Status: passing.** The skills a column injects can be read and edited in the browser (D8, under the
board-configuration umbrella LOB-245). `/skills` lists every skill at its newest version with the
columns of the default definition's newest version that bind it; `/skills/<name>` shows a version's
body, who put it and when, those columns, and the skill's history; its **Edit** form publishes the next
version with `putSkill` (D7). A publish is always version `newest + 1` and never rewrites one
(docs/board.md B2), so it reaches the next run in a column that binds the skill and no run already
open, which the page says beside the result.

## Sub-features

- The rail's **Skills** (`nav[aria-label='Sections'] a[href='/skills']`) opens `/skills`. Each row is
  `li[data-skill-row=<name>]` with `data-skill-version` (the newest) and `[data-skill-columns]` (the
  comma-joined columns, empty for none), from one `listSkills` read (`skillsAtom`).
- A board's **Settings** page and each lane's disclosure render `ColumnSettings`, whose skill names are
  links: `[data-column-skill-link=<name>]` opens `/skills/<name>`.
- `/skills/<name>` is `[data-skill-page=<name>]` with `data-skill-shown-version` and
  `data-skill-newest`. `getSkill` (`skillAtom`) answers the version shown: the newest, or the one
  `?version=N` names. The body is `pre[data-skill-body]`, exactly as stored (no markdown rendering);
  `[data-skill-description]`, `[data-skill-author]` (`seeded` for a migration's row),
  `[data-skill-created-at]` and `[data-skill-attachments]` sit beside it.
- **Used by** (`[data-skill-used-by]`, comma-joined columns) is `listSkills`' columns for the skill: the
  default definition's newest version's, as `factory skill ls` prints them. A failed list says it could
  not tell (`[data-skill-used-by-unknown]`).
- **History** (`[data-skill-history]`) is `listSkillVersions` (new in D8): every version, newest first,
  with who put it and when, and no bodies. Each entry (`li[data-skill-history-version=N]`) links to
  `?version=N`; the one shown carries `aria-current="page"`.
- An older version carries a notice (`[data-skill-older]`): "You are reading v1. The newest is v3: …",
  with **Show v3** (`[data-skill-show-newest]`) back to the newest.
- **Edit** (`[data-skill-edit]`) reads the newest fresh (`readNewestSkillAtom`, a `getSkill`) and opens
  `form[data-skill-form]` on that version's description and body, whichever version is shown;
  `data-skill-form-base` is the version it opened on. Edit is disabled while the page's own newest
  is being re-read. **Publish v<n+1>** (`[data-skill-publish]`) sends `putSkill` with the
  form's text, the newest's attachments and the dashboard's actor. Unchanged text is stopped in the
  form (`[data-skill-problem=unchanged]`) and sends nothing. A refusal — a blank body is the server's
  `InvalidSkill` — is `[data-skill-refusal=<tag>]` (`role="alert"`) in the server's words, and the form
  keeps what was typed. A publish that lands says `[data-skill-created=N]` "vN created", closes the
  form, shows the newest, and every skill read re-runs (`SKILLS_KEY`), so the history lists vN
  without a reload.
- Publish reads the newest again before it sends. If a version landed since the form opened (a
  `factory skill put`, another browser), nothing is sent: `[data-skill-refusal=NewestMoved]` names both
  versions, the typed text stays, the form now starts from the landed version, and a second Publish
  writes over it on purpose. The page's reads re-run so the page shows the landed version too.
- A draft in the form survives pressing a history entry or **Show vN**: while the next version is read,
  the page keeps the version it showed (`[data-skill-loading]`, `aria-busy`) rather than a skeleton.
- `/skills/<unknown>` reads **No such skill**; `?version=99` past the newest reads **No such version**.
- Not polled: a skill changes only by a put, so a put from a terminal is a reload away for the body
  and history shown; Edit and Publish read the newest themselves.

## How to get to it (user POV)

Press **Skills** in the rail and pick a skill, or open a board's **Settings** and press a skill under
a column. Press **Edit**, change the body, press **Publish**.

## Driving it

```sh
DATABASE_URL=… SKILLS_API_PORT=9591 SKILLS_WEB_PORT=3591 ./skills.sh
```

The drive edits the shipped `specify` skill, so the script starts its own API and dashboard on a
throwaway database (`factory_verify_web_skills_<random>`, dropped on exit), runs `skills.mjs`, and stops
both. The oracle is the RPC (`listSkills`, `getSkill`, `listSkillVersions`, `putSkill`) asked from the
drive process, and `factory skill show`. It requires:

1. the settings page's `specifying` column to link `specify` to `/skills/specify`, and the link to
   open it;
2. the rail's **Skills** to open `/skills`, listing exactly `listSkills`' names, versions and columns;
3. `/skills/specify` to show `getSkill`'s newest body, version and description, the columns
   `listSkills` names (`specifying`), and `listSkillVersions`' history with the shown version marked;
4. the form to open on the newest body, and Publish with nothing changed to send no `putSkill`;
5. a blank body to be refused inline as `InvalidSkill` with the message the same call answers from the
   drive process, nothing written (`listSkillVersions` unchanged) and the typed text kept;
6. an edited body to say "v<n+1> created", show the new body as the newest and list v<n+1> first in
   the history with no page load, after exactly one `putSkill`;
7. `getSkill` to answer the edit at v<n+1> by `dashboard` with the attachments kept, v<n> unchanged,
   and `factory skill show specify` to print `version      <n+1> (newest)` and the new line;
8. a history entry to open its version's body with the notice naming the newest, and the notice's link
   to open the newest again, with a draft typed in the form beforehand still in it after both;
9. a version put from the drive process after the page loaded to be the one Edit opens on (and the page
   to catch up to it), a second put while the form is open to stop Publish with
   `NewestMoved` — no `putSkill`, both versions named, the text kept — and Publish again to write the
   typed text as the next version with the landed one intact;
10. an unknown skill to read **No such skill**, an unknown version **No such version**, and no console
    error over the whole drive.

Evidence goes to `.verify/evidence/latest/skills/`: `skills-list.png`, `skills-page.png`,
`skills-refused.png`, `skills-form.png`, `skills-created.png`, `skills-older.png`,
`skills-moved.png`, `skills-missing.png`, `observed.json` (the oracle answers, what the page showed, every RPC tag the
browser sent, every check).

## Known gaps

- **Used by is the default definition's columns only**, as `listSkills` and `factory skill ls` answer
  it. A board pinned to another definition binds whatever its own version names; its Settings page
  links those skills here, but this page does not list them.
- **No new skill from the browser.** `putSkill` makes version 1 of a new name, and the CLI's
  `factory skill put` can; the pages only edit a skill that exists.
- **Publish's check is not atomic.** `putSkill` has no expected-version field: it writes `newest + 1`
  whatever the form read. Publish re-reads the newest first, so a put from elsewhere is caught unless
  it lands in the moment between that read and the send. Closing the gap needs an optional
  `expectedNewest` on `putSkill`, refused when stale (follow-up on LOB-245).
- **The body is shown as text, not rendered markdown**: what a run is told is the text itself.

## Last run

2026-10-28 from the `agent/D8` worktree, API `:9541` / web `:3541`: **21/21** passed.
