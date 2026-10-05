# Transcript

**Status: passing.** The transcript is one column of rows at `max-w-[68ch]`, inside a scroller that
follows the stream. `drive.mjs` expands a `toolResult` disclosure and screenshots the result.

## Sub-features

- Row kinds render distinctly: `user` (a muted bubble, right-aligned), `assistant` (prose at full
  width), `system` / `reset` / `compaction` (a marker between two hairlines), `toolResult` (a
  disclosure, collapsed by default)
- The scroller opens on the newest row (`defaultScrollPosition="end"`) and follows the stream as
  entries arrive, so a live run does not push the newest line below the fold
- A scroll-to-end button appears only once the reader has scrolled away, and hides again at the end
- A new row fades in as it enters; the global `prefers-reduced-motion` block in `index.css`
  collapses it
- The composer is pinned below the scroller and states its own contract: `Enter` sends,
  `Shift`+`Enter` newlines

## How to get to it (user POV)

Open a session. The transcript is the pane's whole middle; the composer is its last row.

## Driving it with drive.mjs

`drive.mjs` opens the newest session from the sidebar, clicks the first `bash` disclosure, and
screenshots `transcript.png`. The disclosure is found by role and name, so it is the accessible name
that proves it, not a class.

The scroller's behaviour is checked by hand rather than by the driver, because the faux run finishes
too fast to observe a scroll following it: send a message and watch `scrollTop` track
`scrollHeight - clientHeight`.

## Why the rows are shaped this way

A coding run emits dozens of tool calls, so a card per call would bury the answer the user came for.
Every reference agrees the disclosure is right (Cofounder's tab strip, Devin's "Worked for 11s"
chevron, Mintlify's timeline). Assistant prose runs full width and only the user's own message gets a
surface, because that is the one line being attributed.

The tool call itself is not labelled above its result: a `toolResult` entry follows every call and
already carries the name inside the disclosure, so a label above it says the same fact twice. An
in-flight call shows in the header instead.

## Gotchas

- The rows are `Message` + `MessageContent` + `Bubble` from the chat set, so both alignments share one
  contract. `BubbleContent` sets `text-xs`; the user row overrides it to `text-sm` through `cn`
  (tailwind-merge), which is why the class order matters there.
- The scroller's root is `size-full`, so it needs a parent with a definite height. It is wrapped in a
  `flex min-h-0 flex-1` box; sizing it directly makes it grow to its content and pushes the composer
  out of the viewport.
- `MessageScroller.Provider` is required above `MessageScroller.Root`. The primitive's hooks throw
  `useMessageScroller must be used within a MessageScroller` without it.
- Rows are keyed by `entry.id` and `MessageScrollerItem` carries `messageId`, so the primitive can
  track visibility and scroll to a specific row. `scrollAnchor` is set on the last row only.
