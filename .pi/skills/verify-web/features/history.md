# Earlier history of a long session

**Status: passing** (2026-10-28, `chrome`, headless, `./history.sh` on API `:9532` / web `:3532` from
the `agent/LOB-243` worktree): **6/6** after the API drive's 10/10, evidence
`.verify/evidence/lob-243/history/`.

## What it is

A historical read of a long session carries its newest entries only (LOB-243, design R6). The
transcript pane shows them, and a **Show earlier entries** control above them while the transcript
holds more. Each press reads the page before the oldest entry shown (`readSessionHistory`) and puts
it on top; once the first entry is on screen the control is gone. The pages belong to the snapshot
they were read under (`lib/history-view.ts`): another session, or a re-attach whose window starts
elsewhere, drops them. A live pane carries the whole transcript, so it never shows the control.

## How a user reaches it

Open a session nobody is running whose transcript is longer than 200 entries.

## What proves it

`./history.sh` owns its own API (4 s idle timeout, so the fold is reachable) and dashboard. It runs
`../verify-api/history.ts` to grow a session past the window and release it, then `history.mjs`:

- the pane reads `historical fold`, shows a `data-show-earlier` control naming the window's first
  entry, and the last turn's message but not the first's
- each press sends one `readSessionHistory`, the first `before` the window's first entry
- after the presses the control is gone and every turn's message is on screen exactly once, in order,
  the first one first; the page logged no console error

Screenshots: `history-window.png`, `history-first-entry.png`.
