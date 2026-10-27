# The session's PR link

**Status: passing.** A session whose log records a PR shows the link in its pane header, beside the
session id; a session with no PR shows nothing there (LOB-65, over LOB-62's `prUrl`).

## Sub-features

- The anchor (`data-pr-link`) reads `PR #<number>` with a pull-request icon, and its `href` is
  `SessionSummary.prUrl` verbatim — the URL the PR step recorded in the log and the index row. It
  opens in a new tab (`target="_blank"`, `rel="noreferrer"`): the pane is a live stream, and
  navigating away from it would drop the attach.
- The link arrives three ways, all through the summary the pane already folds: `getSession` on
  attach, the stream's `snapshot`, and a `prOpened` event for a PR opened while the pane is attached
  (`foldSessionEvent`, covered in `apps/web/src/lib/pr-link.test.ts`).
- Only an `http:` or `https:` URL becomes an anchor (`apps/web/src/lib/pr-link.ts`). Anything else —
  a `javascript:` value included — renders no link, because the URL is the forge's answer passed
  through the control plane, not something the dashboard minted.

## How to get to it (user POV)

Open a session a PR was opened for. The header reads `<title>  ses_…  PR #N`; clicking `PR #N`
opens the PR in a new tab.

## Driving it with drive.mjs

1. After the session-stream checks, on the session the drive started (which opened no PR): no
   `[data-pr-link]` exists in the pane.
2. Near the end, the drive seeds a session with `.pi/skills/lib/seed-pr.ts`: the real
   `SessionService` and PR step, on the API's `DATABASE_URL` and `SESSION_ROOT`
   (`.verify/run/sessions`), against the loopback GitHub fake from `verify-api`. The seed exits before
   the page attaches, so it no longer owns the log. It is a seed rather than a button because the
   API the drive starts has no fake GitHub wired in for its `openPullRequest` member (LOB-213).
3. It reads the session back **from the page** with `getSession` and requires the API's `prUrl` to be
   the one the seed recorded.
4. It opens `/sessions/<seeded id>`, waits for `header [data-pr-link]`, and requires the anchor's
   `href` attribute to equal that recorded `prUrl` and its `target` to be `_blank`.

The seed binds a fresh repo slug per run, so every seeded link is distinct: an anchor showing an
earlier run's link would not compare equal.

## Evidence

- `pr-link.png` — the seeded session's pane, with the link in the header.
- `pr-seed.txt` — what the seed printed.
- `observed.json` → `prLink` (`sessionId`, `seededPrUrl`, `recordedPrUrl`, `href`, `target`,
  `text`) and the five checks: `a session with no PR shows no PR link`,
  `a session with a recorded PR was seeded`, `the API reads the PR link the session recorded`,
  `the pane header links the recorded PR`, `and the link opens beside the live pane, not over it`.

Last verified 2026-10-27 from the `agent/LOB-65` worktree (API `:9500`, web `:3500`, the fake on
`:9503`): 49/49 required checks passed. A mutation run (the anchor's `href` suffixed with `#x`)
failed `the pane header links the recorded PR`.

## What it does not prove

- That the link opens the real PR: the URL is the fake's, and nothing here fetches it.
- A `prOpened` event landing in a pane that is already attached. The seed opens the PR in another
  process before the page attaches, so the drive proves the attach path; the event path is the
  reducer case in `pr-link.test.ts`.
