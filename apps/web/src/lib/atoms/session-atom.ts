import type {
  CompactSessionInput,
  SessionEvent,
  SessionId,
  SessionLive,
  QueuedMessage,
  SessionSummary,
  SessionTask,
  SessionUsage,
  TranscriptEntry,
  WithdrawMessageInput,
} from "@repo/domain/Session";
import { Effect, Stream } from "effect";
import { runtime } from "../atom";
import { RpcClient } from "../rpc-client";
import { DASHBOARD_ACTOR } from "../approvals-view";
import { SESSIONS_KEY } from "./session-list";

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
  readonly queued: readonly QueuedMessage[];
  readonly tasks: readonly SessionTask[];
};

const emptyView = (summary: SessionSummary): SessionView => ({
  summary,
  entries: [],
  live: { busy: false, tools: [] },
  usage: { models: [], tools: [] },
  queued: [],
  tasks: [],
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
        queued: event.queued,
        tasks: event.tasks,
      };
    case "entry":
      return { ...state, entries: [...state.entries, event.entry] };
    case "live":
      return { ...state, live: event.live };
    case "usage":
      return { ...state, usage: event.usage };
    case "queued":
      return { ...state, queued: event.queued };
    case "tasks":
      return { ...state, tasks: event.tasks };
    case "status":
      return { ...state, summary: { ...state.summary, status: event.status } };
    case "prOpened":
      return { ...state, summary: { ...state.summary, prUrl: event.prUrl } };
  }
};

/**
 * Attaches to one session and follows its stream.
 *
 * The read is explicit and the watch follows it, rather than relying on the
 * watch's own snapshot as the seed: an attach then races nothing, because
 * whatever the stream omits the read already carried. The sidebar is the
 * server's list (`sessionListAtom`), so nothing here writes to it.
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

/**
 * Creates a session and drives it with the first message, in one round trip. `SESSIONS_KEY` makes
 * the sidebar re-read the server's list once the session exists.
 */
export const startSessionAtom = runtime.fn(
  (input: { readonly content: string; readonly title?: string | undefined }) =>
    Effect.gen(function* () {
      const rpc = yield* RpcClient;
      // `title` is optional on the wire (CreateSessionInput), and the control plane
      // names a session from its first message, so omitting the key is the honest
      // default rather than sending an empty string. The spend is the dashboard's (LOB-162).
      const session = yield* rpc.client.createSession({
        actor: DASHBOARD_ACTOR,
        ...(input.title === undefined ? {} : { title: input.title }),
      });
      yield* rpc.client.sendMessage({
        sessionId: session.id,
        content: input.content,
      });
      return session;
    }),
  { reactivityKeys: [SESSIONS_KEY] },
);

/**
 * Forks a session at its last entry (LOB-180's RPC, LOB-182's action).
 *
 * The fork is a session of its own with the parent's transcript copied in one commit, so the caller
 * navigates to the returned id rather than mutating the pane it was reading: the parent's log never
 * gains the fork's turns. `SESSIONS_KEY` puts the child in the sidebar's list once it exists.
 */
export const forkSessionAtom = runtime.fn(
  (sessionId: SessionId) =>
    Effect.gen(function* () {
      const rpc = yield* RpcClient;
      return yield* rpc.client.forkSession({ sessionId });
    }),
  { reactivityKeys: [SESSIONS_KEY] },
);

/**
 * Asks the server to compact a session now (LOB-185's RPC, LOB-222's action).
 *
 * A compaction is a task in the log, not a request that answers with a summary: the call admits it
 * and answers its `taskId`, and the summary arrives later as a `compaction` entry over the same
 * stream the pane is already following. So the caller branches on the task settling in
 * `view.tasks` rather than awaiting a result here — a short transcript has no cut and no entry
 * ever appears, which is why the pane cannot treat "the call returned" as "it compacted".
 *
 * `input` is typed from the RPC group, so a payload the server would refuse fails at compile time
 * in the pane instead of becoming a toast in the browser.
 */
export const compactSessionAtom = runtime.fn((input: CompactSessionInput) =>
  Effect.gen(function* () {
    const rpc = yield* RpcClient;
    return yield* rpc.client.compactSession(input);
  }),
);

/**
 * Withdraws a queued message before a run places it (LOB-166's RPC).
 *
 * The answer's `outcome` is what happened: only `withdrawn` took the message out of the queue; a
 * run that placed it first, or a message already over, is an answer the pane reports, not a
 * failure. The queue the pane renders shrinks over the stream either way.
 */
export const withdrawMessageAtom = runtime.fn((input: WithdrawMessageInput) =>
  Effect.gen(function* () {
    const rpc = yield* RpcClient;
    return yield* rpc.client.withdrawMessage(input);
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
