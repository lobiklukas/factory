# Dashboard shell renders

**Status:** passing

The shell is the product's frame: a 48px icon rail, then the route. `/` redirects to `/sessions`,
which adds the session list beside the pane.

## Sub-features

- The rail renders with `aria-label="Sections"` and one entry per section (Sessions, Sandboxes,
  Approvals), each with a tooltip carrying the label the icon replaces
- `/` lands on `/sessions` (the redirect is the assertion, not the absence of an error)
- The session sidebar shows `No sessions in this browser yet` before anything is opened, and names
  task 8 as the reason
- The theme toggle sits at the rail's foot and dark is the default
- `/sandboxes` and `/approvals` render their milestone copy rather than an empty table

## How to get to it (user POV)

Open the dashboard root. No auth, no query parameters, no seed data.

## Driving it with drive.mjs

```sh
./up.sh
node drive.mjs
```

`drive.mjs` waits for `nav[aria-label='Sections']`, then asserts the path after `goto` is
`/sessions` and that the sidebar's empty state says what is missing. The shell renders even when
everything inside it is broken, so this check is about frame only — see `session-stream.md` for the
one that matters.

## Design language

The look is Vercel's, not Factory's, and the difference is deliberate: hairlines instead of shadows,
a single accent (`--ring`, one blue), radius locked to 0, Geist Sans for UI with Geist Mono only
where an id or a tool output needs it. Dense on purpose (`text-xs` metadata at 10px) — this is a
control plane an engineer reads while something runs, not a page.

The tokens live in `src/index.css`. Dark is the default class on `<html>`, not a media query, so
the first paint is never the wrong theme.

## Gotchas

- Vite is configured `strictPort` on 3000, and port 3000 is frequently occupied on this machine, so
  the dev server fails outright instead of moving. Always launch through `up.sh`.
- `src/routeTree.gen.ts` is generated but committed: `tsc` reads it, so a fresh clone type-checks
  without a build first. `**/*.gen.ts` is excluded from `format:check` and `.tanstack/` is ignored.
- The session list is browser-local (`sessionStorage`, via `KeyValueStore`), not a server read. The
  control plane has no list endpoint yet. Do not describe it as the account's sessions.
