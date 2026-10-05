# Docs

This tree is the project's written memory. `design.md` holds the settled decisions (D1-D17) and
their rationale; the rest plans around them (`roadmap.md`, `board.md`), records what actually
happened (`handoff.md`, `next-agent.md`), or supplies the research behind a change (`features.md`).
One authority per question: when two files disagree, the settled decisions in `design.md` win, and
`handoff.md` is the current state.

| Document                               | The question it answers                                                                                                                               | Read it before                                                  |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| [`design.md`](design.md)               | What did we decide, and why? D1-D17 with rationale, the component and seam inventory, the build order M0-M7, and the open risks R1-R6.                | Changing an architectural decision.                             |
| [`board.md`](board.md)                 | How does work move? The settled board decisions B1-B12, the default pipeline columns and roles, the human gates, and the MVP/wave-2 cut.              | Touching anything that models work.                             |
| [`roadmap.md`](roadmap.md)             | In what order do we build, and what does "done" mean? Priority tiers P0-P3, the milestone map, and the Linear project that tracks it.                 | Starting work that is not already an issue.                     |
| [`features.md`](features.md)           | What should we build next, and why? A ranked backlog from a code audit, the installed Pi Durable API surface, and a survey of 13 comparable products. | Proposing a feature; it changes no decision in `design.md`.     |
| [`handoff.md`](handoff.md)             | What is done, what is proven, what is not proven, and what is next? The state of the work.                                                            | Assuming anything works.                                        |
| [`next-agent.md`](next-agent.md)       | Where does an agent start right now? A self-contained brief for one stretch of work: the issues, the gates, and the traps. Stale by design.           | Starting an agent session; rewrite it when the stretch changes. |
| [`parallel-work.md`](parallel-work.md) | How do I run several streams of work at once? Subagent isolation, worktrees, the shared-Postgres and port hazards, and where local work stops.        | Spawning subagents or opening a second checkout.                |
| [`README.md`](README.md)               | Which document answers which question? The index of this tree.                                                                                        | Nothing; start with `design.md`.                                |
