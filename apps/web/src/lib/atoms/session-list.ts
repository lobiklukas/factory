import { Effect } from "effect";
import { Atom } from "effect/reactivity";
import { runtime } from "../atom";
import { RpcClient } from "../rpc-client";

/** The reactivity key every write that changes the session list invalidates. */
export const SESSIONS_KEY = "sessions";

/** How many sessions the sidebar asks for: one page, newest activity first. */
export const SESSION_LIST_LIMIT = 50;

/**
 * The sidebar's session list: the control plane's own `listSessions` (LOB-6), not anything this
 * browser remembers (LOB-75 deleted the browser-local registry that stood in for it).
 *
 * The list is the activity index, so it costs one query however many sessions exist (R6). It is
 * re-read when a write that adds a session lands (`startSessionAtom` and `forkSessionAtom` carry
 * `SESSIONS_KEY`), and the pane refreshes it when the status it is streaming changes, so the row
 * of the session on screen does not lag the header beside it.
 */
export const sessionListAtom = runtime
  .atom(
    Effect.gen(function* () {
      const rpc = yield* RpcClient;
      return yield* rpc.client.listSessions({ limit: SESSION_LIST_LIMIT });
    }),
  )
  .pipe(Atom.withReactivity([SESSIONS_KEY]));
