import type { SessionId, SessionSummary } from "@repo/domain/Session";
import { SessionSummary as SessionSummarySchema } from "@repo/domain/Session";
import { Schema } from "effect";
import { Atom } from "effect/reactivity";
import { runtime } from "../atom";

/**
 * What the sidebar knows about sessions.
 *
 * The control plane has no list endpoint yet (docs/handoff.md task 8: "nothing
 * answers 'which sessions exist' today"), so this is deliberately client-side:
 * the sessions this browser has opened, newest first. It is the one thing a
 * dashboard can honestly show before that endpoint lands, and swapping it for a
 * server read is a change to the atom below, not to the components reading it.
 */
export const sessionRegistry = Atom.kvs({
  runtime,
  key: "factory.sessions",
  schema: Schema.Array(SessionSummarySchema),
  defaultValue: () => [],
});

/**
 * Records a session, or refreshes the one already recorded under that id.
 *
 * The dedupe is load-bearing: the stream re-reports the same summary on every
 * `status` event, so an append would grow the sidebar on each tick. The cap is
 * for the same reason — an unbounded list is a memory leak wearing a sidebar.
 */
export const recordSession = Atom.writable(
  (get) => get(sessionRegistry),
  (ctx, summary: SessionSummary) => {
    const current = ctx.get(sessionRegistry);
    ctx.set(
      sessionRegistry,
      [summary, ...current.filter((entry) => entry.id !== summary.id)].slice(
        0,
        50,
      ),
    );
  },
);

/** Drops a session from the sidebar. The session itself is untouched. */
export const forgetSession = Atom.writable(
  (get) => get(sessionRegistry),
  (ctx, id: SessionId) => {
    ctx.set(
      sessionRegistry,
      ctx.get(sessionRegistry).filter((entry) => entry.id !== id),
    );
  },
);
