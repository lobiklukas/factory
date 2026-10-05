# Components

Registry components, copied in and owned here. Everything in this directory is Tailwind on Base UI
(`@base-ui/react`) in the `base-lyra` style, reading the tokens in `src/index.css`. Nothing here is
a default: radius is 0 everywhere, and the accent is the amber `--ring`.

## Wired today

| Component                     | Where                                                |
| ----------------------------- | ---------------------------------------------------- |
| `alert`                       | the pane's read failure                              |
| `badge`                       | the session status chip                              |
| `bubble` `message`            | transcript rows and their alignment contract         |
| `button` `textarea` `tooltip` | the composer, the rail, the header                   |
| `collapsible`                 | the tool-call disclosure                             |
| `empty`                       | every empty state, including the named gaps          |
| `kbd`                         | the composer's key contract                          |
| `marker`                      | the `system` / `reset` / `compaction` divider        |
| `message-scroller`            | the transcript viewport and its scroll-to-end button |
| `skeleton` `spinner`          | attaching                                            |
| `sonner`                      | a refused create, and every future refusal           |

## Installed for the board, not wired yet

`docs/board.md` makes the cockpit the board (LOB-22): lanes from the definition, a card pane, and an
attention view. These are the kit for that surface, installed deliberately. If one is still unused
when the board lands, delete it.

| Component                            | The surface it is for                                                                                          |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `tabs`                               | card pane: Runs / Transcript / Evidence / Thread                                                               |
| `command` + `dialog` + `input-group` | ⌘K: jump to a card or run, start a run, move a card                                                            |
| `progress`                           | a column's WIP cap (B9) and a card's spend                                                                     |
| `table`                              | the evidence a gate checks (B8)                                                                                |
| `breadcrumb`                         | board → lane → card                                                                                            |
| `item`                               | card rows in a lane                                                                                            |
| `avatar`                             | the actor every move carries (B5). LOB-20 is what makes an actor real; until then a move's actor is a string   |
| `field` + `label`                    | the card create form                                                                                           |
| `combobox`                           | the repo picker, on the card create path                                                                       |
| `resizable`                          | lane / card-pane / transcript split                                                                            |
| `separator`                          | a transitive dependency of `field` and `item`                                                                  |
| `input`                              | a transitive dependency of `input-group`                                                                       |
| `attachment`                         | an evidence artifact: a screenshot, a diff, a log, with the idle / processing / error states it already models |

## Rules

- One accent, one red. `--ring` is the accent and it means focus or live. `--destructive` is the only
  red, it means blocked or refused, and it never appears without a word beside it.
- Radius is 0. If a component ships rounded, square it.
- Icons are `lucide-react` at `strokeWidth={1.75}`. One family.
- `cn` is a tailwind-merge drop-in, so the last class wins a conflict. That is how a call site
  overrides a component's own size or colour.
- **One primitive system: Base UI.** 17 files here import `@base-ui/react` and none import Radix. The
  one exception is `command`, which wraps `cmdk`, and `cmdk` depends on Radix Dialog transitively, so
  a Radix dialog renders inside a Base UI tree when the palette opens. It is unavoidable with `cmdk`
  and confined to that one component; if the palette grows, hand-build it on Base UI instead.
