# Live tasks

**Status: passing.** Between the header and the transcript, a strip lists what the run is doing right
now: Pi Durable's live task graph, one row per task, with its status, phase, owner, what it waits on,
and how long this browser has watched it.

## Sub-features

- The strip is always present, in every session, under the header: `Tasks` and the count, then the
  rows.
- A row carries the status word (`PENDING`, `RUNNING`, `WAITING`, `COMPLETING`), the task's kind and
  id, its phase, its owner when it has one, and `waiting on …` when it is a join.
- A task owned by another live task is indented under it, two levels deep at most; a task whose
  owner already settled (or that has none) stays at the top level.
- The age on the right grows once a second while the task is on screen.
- A task that settles leaves the list, because the server projects the whole graph on every change
  and a settled task is absent from it — the panel is not a history.
- An empty list is one line: `No tasks. This session has no live tasks; work in flight appears here.`

The data comes from LOB-183: `tasks` on `SessionSnapshot` and a `tasks` event on the stream, folded
into `SessionView.tasks` in `apps/web/src/lib/atoms/session-atom.ts`. Nothing new crosses the wire
for this panel.

## How to get to it (user POV)

Open any session. While a run is in flight the strip lists the model turn (`pi.generation`) and each
tool call it started (`pi.tool`), the tool indented under the turn that owns it. Send a message and
watch the rows appear, age, and leave.

## Driving it with drive.mjs

`up.sh` scripts `FAUX_COMMAND="sleep 12; echo faux-ok"` so the `bash` tool's own task stays live long
enough to read. The drive then requires:

1. a `pi.tool` row showing `running`, and its age — read twice three seconds apart — strictly
   increasing;
2. that the same session, once the run settles, has zero task rows and says `No tasks`;
3. that the run settled **without a reload**: a `window` marker set before the run is still there
   afterwards, so "updates without a reload" is a fact rather than an inference;
4. that Tab from the header's last control (Fork, since LOB-75 removed Forget) reaches the task list (`aria-label="Live task rows"`,
   which is also a named focusable region);
5. that at 1280×800 neither the document nor the panel overflows sideways, and no row's cells run
   into each other (a row whose middle column cannot shrink overlaps rather than scrolling, so
   `scrollWidth` alone would miss it).

## Why the age is client-side

`SessionTask` carries no timestamp — Pi Durable's graph node has none to project — so a true "running
for 42s" is not available to the panel. The age shown is the time since **this browser** first saw
the task id, restamped whenever an id leaves the list; the row's title says exactly that. Adding a
`startedAt` to the domain would be a change to LOB-183's contract and is not part of this panel.

The strip renders the _current_ clock rather than a value kept in state, so a task that appears
after an idle minute reads `0s` at birth instead of inheriting the last tick. Only the interval that
forces the re-render is state.

## What the drive does not cover

- The empty state is proven on a session whose run has settled, not on a session that never ran: the
  dashboard's only way to create a session also sends its first message. It is the same render branch
  (`tasks` empty), and the strip has no other input.
- At 390 px the shell itself is the defect (fixed `w-64` sidebar plus rail, LOB-210), and the pane
  is crushed to ~86 px for every screen in the app. A row clips at its own edge there rather than
  drawing over its neighbours, but the drive asserts 1280×800 because that is the width the
  criterion names.
- The task list is a tab stop unconditionally, including when one row fits and nothing scrolls: it is
  the panel's keyboard entry point (criterion: reachable by keyboard), and a region that is only
  sometimes focusable would not be.

## Gotchas

- The strip is one line tall when empty and `max-h-[40vh]` with its own scroll when full, so a session
  with dozens of tool calls cannot push the transcript off the screen.
- The ticking interval only runs while something is on screen: an idle session does not re-render once
  a second.
- A task's rows are keyed by id and the projection sorts by id, so a graph revision never reshuffles
  the list; scrolling inside the panel survives an update.
- The `pi.tool` task's phase is `execute` while the command runs. A tool whose command finishes in
  milliseconds is on screen for roughly that long — which is why the drive scripts a sleeping
  command instead of catching it by luck.
- `pi.generation` stays live (and `WAITING`, `waiting on <tool id>`) while its tool call runs: the
  strip shows two rows for one turn, which is what the graph says.
