import type {
  CompactSessionInput,
  CreateSessionInput,
  ReadSessionHistoryInput,
  SessionEvent,
  SessionBudget,
  SessionId,
  SessionLive,
  QueuedMessage,
  SessionSummary,
  SessionTask,
  SessionUsage,
  TranscriptEntry,
  WithdrawMessageInput,
} from "@repo/domain/Session";
import { Cause, Duration, Effect, Exit, Option, Stream } from "effect";
import { Atom } from "effect/reactivity";
import { runtime } from "../atom";
import { hasTranscriptRow } from "../transcript-view";
import { RpcClient } from "../rpc-client";
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
  /**
   * Where `entries` starts when the transcript holds more before it (LOB-243): a historical
   * snapshot of a long session carries its newest entries only. Absent means `entries` is all of it.
   */
  readonly earlier?: string;
  readonly live: SessionLive;
  readonly usage: SessionUsage;
  readonly queued: readonly QueuedMessage[];
  readonly tasks: readonly SessionTask[];
  /**
   * The server's warning that the session's repo has no local checkout (LOB-263): its runs get no
   * worktree and can produce no diff. Set by a snapshot; absent for a scratch session and for a repo
   * that is checked out.
   */
  readonly workspaceWarning?: string;
  /**
   * The session's cap as the snapshot reported it (C23), absent for a session with none. It is what
   * the "Raise cap" field's suggestion and spend floor are made from; the stream does not update it,
   * so it is the cap and spend at attach, and a stop's own cap is what the transcript's line says.
   */
  readonly budget?: SessionBudget;
  /**
   * The budget stop the snapshot already shows as moved past (C23): the stop is the newest row of a
   * capped session whose budget reports no stop, so the cap was raised before this attach (here
   * earlier, elsewhere, or by the CLI). The stop and the document are committed together, so a
   * snapshot that holds the entry and no `stopped` is a raise, never a lag. "Raise cap" is not
   * offered on it.
   */
  readonly settledStop?: string;
};

/** The id of the snapshot's newest row when it is a budget stop whose cap was already raised. */
const settledStopOf = (event: {
  readonly entries: readonly TranscriptEntry[];
  readonly budget?: SessionBudget | undefined;
}): string | undefined => {
  if (event.budget === undefined || event.budget.stopped !== undefined) {
    return undefined;
  }
  const newest = event.entries.findLast(hasTranscriptRow);
  return newest !== undefined && newest.kind === "budget"
    ? newest.id
    : undefined;
};

const settledStopField = (
  event: Parameters<typeof settledStopOf>[0],
): { readonly settledStop?: string } => {
  const settledStop = settledStopOf(event);
  return settledStop === undefined ? {} : { settledStop };
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
        ...(event.earlier === undefined ? {} : { earlier: event.earlier }),
        live: event.live,
        usage: event.usage,
        queued: event.queued,
        tasks: event.tasks,
        ...(event.workspace.warning === undefined
          ? {}
          : { workspaceWarning: event.workspace.warning }),
        ...(event.budget === undefined ? {} : { budget: event.budget }),
        ...settledStopField(event),
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
 * Creates a session and drives it with the first message, in one round trip: what the New session
 * form submits (E6). `create` is `createSession`'s payload exactly as the form built it
 * (`newSessionInput`), and `content` the operator's prompt, sent verbatim. `SESSIONS_KEY` makes the
 * sidebar re-read the server's list once the session exists.
 *
 * A refused create fails, with the server's typed refusal, and nothing exists. A create that lands
 * and a first message that is refused is not that: the session exists, so the answer is the session
 * and the refusal (`sendFailure`), and the form opens the session and says its prompt was not sent
 * rather than claiming no session was made.
 */
export const startSessionAtom = runtime.fn(
  (input: StartSessionInput) =>
    Effect.gen(function* () {
      const rpc = yield* RpcClient;
      return yield* startSession(rpc.client, input);
    }),
  { reactivityKeys: [SESSIONS_KEY] },
);

/** What the New session form submits: `createSession`'s payload, then the first message. */
export type StartSessionInput = {
  readonly create: CreateSessionInput;
  readonly content: string;
};

/** The two calls a start makes: the dashboard's RPC client, or a fake in a test. */
export type StartSessionCalls<E extends { readonly message: string }> = {
  readonly createSession: (
    input: CreateSessionInput,
  ) => Effect.Effect<SessionSummary, E>;
  readonly sendMessage: (input: {
    readonly sessionId: SessionId;
    readonly content: string;
  }) => Effect.Effect<unknown, E>;
};

/** `startSessionAtom`'s work, over the calls it is given. */
export const startSession = <E extends { readonly message: string }>(
  calls: StartSessionCalls<E>,
  input: StartSessionInput,
): Effect.Effect<
  { readonly session: SessionSummary; readonly sendFailure?: string },
  E
> =>
  Effect.gen(function* () {
    const session = yield* calls.createSession(input.create);
    const sent = yield* calls
      .sendMessage({ sessionId: session.id, content: input.content })
      .pipe(Effect.exit);
    return Exit.isSuccess(sent)
      ? { session }
      : {
          session,
          sendFailure: Option.match(Cause.findErrorOption(sent.cause), {
            onNone: () => Cause.pretty(sent.cause),
            onSome: (error) => error.message,
          }),
        };
  });

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
 * Replays a session onto the model this server runs by default (E9, LOB-198's RPC): the same task
 * again in a new session, which the pane navigates to. The way forward for a session pinned to a
 * model this server no longer serves, whose composer is disabled. The source's log is only read.
 * `SESSIONS_KEY` puts the replay in the sidebar's list once it exists.
 */
export const replaySessionAtom = runtime.fn(
  (sessionId: SessionId) =>
    Effect.gen(function* () {
      const rpc = yield* RpcClient;
      return yield* rpc.client.replaySession({ sessionId });
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

/**
 * Stops the session's run (C8). The answer is what the interrupt came to: a stopped run reaches the
 * pane over the stream it already follows (the status goes idle, the transcript gains its
 * `interrupted` row), and `not_running` is an answer the pane reports, not a failure.
 * `SESSIONS_KEY` re-reads the sidebar's list, whose row shows the status too.
 */
export const interruptSessionAtom = runtime.fn(
  (sessionId: SessionId) =>
    Effect.gen(function* () {
      const rpc = yield* RpcClient;
      return yield* rpc.client.interruptSession({ sessionId });
    }),
  { reactivityKeys: [SESSIONS_KEY] },
);

/**
 * Sets the session's spend cap (C23): the "Raise cap" action on a budget stop. The answer carries
 * the budget as the log now holds it, with the stop cleared, and the server's sentence for it; the
 * session runs again on its next message. `SESSIONS_KEY` re-reads the sidebar's list.
 */
export const setSessionBudgetAtom = runtime.fn(
  (input: { readonly sessionId: SessionId; readonly budget: number }) =>
    Effect.gen(function* () {
      const rpc = yield* RpcClient;
      return yield* rpc.client.setSessionBudget(input);
    }),
  { reactivityKeys: [SESSIONS_KEY] },
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

/**
 * Reads the page of a session's transcript before an entry (LOB-243's RPC): what "Show earlier
 * entries" asks for when a historical snapshot carried only the newest of a long session. The page
 * goes above what the pane shows; the stream is not involved, because earlier entries never change.
 */
export const readSessionHistoryAtom = runtime.fn(
  (input: ReadSessionHistoryInput) =>
    Effect.gen(function* () {
      const rpc = yield* RpcClient;
      return yield* rpc.client.readSessionHistory(input);
    }),
);

/**
 * The session's `lastActivityAt` as it was right after the last press of "Open pull request" settled
 * (C7b), or `undefined` before a press and while one is in flight. A refusal is the verdict on the
 * branch at that moment; this is the server's own mark of that moment, which the pane compares with
 * `sessionActivityAtom` to tell that the session has moved on. Kept alive with the refusal it dates.
 */
export const openPullRequestMarkAtom = Atom.family((_sessionId: SessionId) =>
  Atom.make<string | undefined>(undefined).pipe(Atom.keepAlive),
);

/** How often a remembered refusal looks at the server to see whether the session moved on. */
export const PR_REFUSAL_WATCH_POLL = Duration.seconds(2);

/**
 * The session's `lastActivityAt` now, from its one activity-index row (`listSessions` with
 * `sessionId`: one indexed row, no fold of the log, and so no activity of its own). Subscribed only
 * while a refusal is on screen (`PrRefusalWatch`), so a page full of idle runs polls nothing. `null`
 * for a session the index has no row for.
 */
export const sessionActivityAtom = Atom.family((sessionId: SessionId) =>
  runtime
    .atom(
      Effect.gen(function* () {
        const rpc = yield* RpcClient;
        const page = yield* rpc.client.listSessions({ sessionId, limit: 1 });
        return page.sessions[0]?.lastActivityAt ?? null;
      }),
    )
    .pipe(
      Atom.withReactivity([SESSIONS_KEY]),
      Atom.withRefresh(PR_REFUSAL_WATCH_POLL),
    ),
);

/**
 * Opens a session's pull request (LOB-213's RPC, C7's control): one atom per session, so the session
 * pane's header and the card pane's run row read and write the same answer.
 *
 * A family of `fn` atoms rather than a call each pane makes, because the answer is the state both
 * panes render: the link after a press, the reason after a refusal, "opening" while the call is in
 * flight — so a press in one is visible in the other without either re-reading anything. Kept alive
 * so a refusal outlives the pane that showed it; the session list is re-read on success, which is
 * where the row's `prUrl` comes from.
 *
 * The title is the caller's and the branches are the server's: the call names the session and what
 * to call the PR, as `factory pr` does.
 */
export const openPullRequestAtom = Atom.family((sessionId: SessionId) =>
  runtime
    .fn(
      (title: string, get) =>
        Effect.gen(function* () {
          const rpc = yield* RpcClient;
          get.set(openPullRequestMarkAtom(sessionId), undefined);
          // Whatever the call came to, the mark is read after it settled, so the call's own writes
          // (the step touches the session's activity) are in it and are not mistaken for a run
          // that happened since. A mark that cannot be read leaves the refusal standing.
          const mark = rpc.client.listSessions({ sessionId, limit: 1 }).pipe(
            Effect.tap((page) =>
              Effect.sync(() =>
                get.set(
                  openPullRequestMarkAtom(sessionId),
                  page.sessions[0]?.lastActivityAt,
                ),
              ),
            ),
            // One more read on a failed one: a dropped read is the only way a refusal would never
            // learn the session moved on.
            Effect.retry({ times: 1 }),
            Effect.ignore,
          );
          return yield* rpc.client
            .openPullRequest({ sessionId, title })
            .pipe(Effect.ensuring(mark));
        }),
      { reactivityKeys: [SESSIONS_KEY] },
    )
    .pipe(Atom.keepAlive),
);
