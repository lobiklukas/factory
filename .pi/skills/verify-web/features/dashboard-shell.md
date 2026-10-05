# Dashboard shell renders

**Status:** passing

## Sub-features

- The heading reads `factory`
- The subtitle names what the surface is for (`Agent sessions, sandboxes, and approvals…`)
- The theme toggle is present
- The component grid renders its registered cards

## How to get to it (user POV)

Open the dashboard root. No auth, no query parameters, no seed data.

## Driving it with drive.mjs

```sh
./up.sh
node drive.mjs
```

`drive.mjs` waits for `h1` and asserts its trimmed text equals `factory`, recording the failure
detail if it does not. The screenshot in the evidence directory is the visual proof that the
layout and cards rendered, not just a string match.

## Gotchas

- Vite is configured `strictPort` on 3000, and port 3000 is frequently occupied on this
  machine, so the dev server fails outright instead of moving. Always launch through `up.sh`,
  which sets `VITE_PORT`.
- The shell renders even when every card is broken. A passing shell check says nothing about
  the cards — see `rpc-stream.md`.
