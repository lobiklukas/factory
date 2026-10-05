import type {
  SessionEvent,
  SessionId,
  SessionLive,
  SessionSummary,
  SessionUsage,
  TranscriptEntry,
} from "@repo/domain/Session";
import { Effect, Stream } from "effect";
import { runtime } from "../atom";
import { RpcClient } from "../rpc-client";

/**
 * One session as the transcript pane needs it.
 *
 * `mode` and `status` travel with the entries on purpose (docs/design.md D8): a
 * transcript folded from the log must never render as live, and a run in flight
 * must say so in the header rather than the reader inferring it from the absence
 * of new lines.
 */
export type SessionView = {
  readonly summary: SessionSummary;
  readonly entries: readonly TranscriptEntry[];
  readonly live: SessionLive;
  readonly usage: SessionUsage;
};

const emptyView = (summary: SessionSummary): SessionView => ({
  summary,
  entries: [],
  live: { busy: false, tools: [] },
  usage: { models: [], tools: [] },
});

/**
 * Applies one stream event to the accumulated view.
 *
 * `snapshot` resets rather than appends, so re-attaching mid-run shows the
 * current head instead of the history twice. Everything else appends or
 * overwrites: entries are append-only by contract, and `live` replaces the whole
 * view, which is why a subscriber that falls behind still converges.
 */
export const foldSessionEvent = (
  state: SessionView,
  event: SessionEvent,
): SessionView => {
  switch (event._tag) {
    case "snapshot":
      return {
        summary: event.session,
        entries: event.entries,
        live: event.live,
        usage: event.usage,
      };
    case "entry":
      return { ...state, entries: [...state.entries, event.entry] };
    case "live":
      return { ...state, live: event.live };
    case "usage":
      return { ...state, usage: event.usage };
    case "status":
      return { ...state, summary: { ...state.summary, status: event.status } };
  }
};

/**
 * Attaches to one session and follows its stream.
 *
 * The read is explicit and the watch follows it, rather than relying on the
 * watch's own snapshot as the seed: an attach then races nothing, because
 * whatever the stream omits the read already carried. The sidebar registry is
 * written by the pane, not here — writing one atom from another needs an
 * `AtomRegistry` in context, and the pane is already where the summary lands.
 */
export const sessionAtom = runtime.fn((sessionId: SessionId) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const rpc = yield* RpcClient;
      const snapshot = yield* rpc.client.getSession({ sessionId });
      return rpc.client
        .watchSession({ sessionId })
        .pipe(Stream.scan(() => emptyView(snapshot.session), foldSessionEvent));
    }),
  ),
);

/** Creates a session and drives it with the first message, in one round trip. */
export const startSessionAtom = runtime.fn(
  (input: { readonly content: string; readonly title?: string | undefined }) =>
    Effect.gen(function* () {
      const rpc = yield* RpcClient;
      // `title` is optional on the wire (CreateSessionInput), and the control plane
      // names a session from its first message, so omitting the key is the honest
      // default rather than sending an empty string.
      const session = yield* rpc.client.createSession(
        input.title === undefined ? {} : { title: input.title },
      );
      yield* rpc.client.sendMessage({
        sessionId: session.id,
        content: input.content,
      });
      return session;
    }),
);

/** Sends a message into a session the pane is already attached to. */
export const sendMessageAtom = runtime.fn(
  (input: { readonly sessionId: SessionId; readonly content: string }) =>
    Effect.gen(function* () {
      const rpc = yield* RpcClient;
      return yield* rpc.client.sendMessage({
        sessionId: input.sessionId,
        content: input.content,
      });
    }),
);
