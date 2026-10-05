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

The restraint is Vercel's; the identity is the factory floor's. Hairlines instead of shadows, a
single accent, radius locked to 0, Geist Sans for UI with Geist Mono only where an id or a tool
output needs it, dense on purpose (`text-xs` metadata at 10px). This is a control plane an engineer
reads while something runs, not a page.

What is ours: `--ring` is the page's **only** accent, and it is named for what it does rather than
for what it looks like. It is the focus ring and the live/running signal, the way a machine's
indicator lamp is both. Hi-vis amber, because a shop floor's signal is amber and every comparable
product is blue or purple. `--destructive` is the only red, it means blocked or refused, and it
never appears without a word beside it. Everything else is neutral. The mark is a stamped `F` on a
32-unit grid, drawn as a path (`components/factory-mark.tsx`) rather than as a glyph so it does not
depend on a font loading; `public/favicon.svg` carries an identical path with its own
`prefers-color-scheme` block, because a favicon cannot use `currentColor`.

Contrast, measured with WCAG relative luminance over the oklch tokens (2026-10-05):

| Pair                                 | Ratio |
| ------------------------------------ | ----- |
| dark foreground on background        | 18.15 |
| dark muted-foreground on background  | 6.87  |
| dark muted-foreground on card        | 6.47  |
| dark ring (amber) on background      | 10.32 |
| dark destructive on background       | 6.29  |
| light foreground on background       | 19.79 |
| light muted-foreground on background | 5.87  |
| light ring (amber) on background     | 5.07  |
| light destructive on background      | 5.40  |

Every pair passes AA for body text. The amber is a signal, never a fill behind white text: near-black
on amber is 10.97:1, white on amber is 1.80:1.

The tokens live in `src/index.css`. Dark is the default class on `<html>`, not a media query, so the
first paint is never the wrong theme. Motion is limited to what carries information (a row entering
the transcript, the tool disclosure opening, the running dot pulsing) and the global
`prefers-reduced-motion` block in `index.css` collapses all of it.

## Gotchas

- **The frame is `h-dvh`, not `min-h-dvh`.** Every pane scrolls inside itself. A minimum height lets
  the page grow to its tallest child instead, which pushes the composer off the viewport; the bug is
  invisible until a transcript is longer than the screen.
- **Every nested column-flex wrapper needs `min-h-0`.** `flex-1` with the default `min-height: auto`
  cannot shrink below its content, so a wrapper without it silently grows to the transcript's full
  height. `EmptyPane` and `SessionPane` both carry it.
- **The message scroller's root is `size-full`.** `h-full` only resolves against a parent with a
  definite height, so it is wrapped in a `flex min-h-0 flex-1` box rather than sized directly. Its
  viewport is the scroll container; the composer sits outside it.
- Vite is configured `strictPort` on 3000, and port 3000 is frequently occupied on this machine, so
  the dev server fails outright instead of moving. Always launch through `up.sh`.
- `src/routeTree.gen.ts` is generated but committed: `tsc` reads it, so a fresh clone type-checks
  without a build first. `**/*.gen.ts` is excluded from `format:check` and `.tanstack/` is ignored.
- The session list is browser-local (`sessionStorage`, via `KeyValueStore`), not a server read. The
  control plane has no list endpoint yet. Do not describe it as the account's sessions.
