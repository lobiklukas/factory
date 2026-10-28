/**
 * Following a session another process owns (docs/design.md D8's third branch, D12, LOB-18).
 *
 * The owner streams from its harness; nobody else may open one (Pi Durable allows one owner per log).
 * A follower reads the same log through a reader-mode `Storage` instead — every read catches up on
 * what the owner committed since the last — and turns what changed into the same `SessionEvent`s a
 * live stream sends: a snapshot, then entries, the queue, the run, the spend and the tasks.
 *
 * It is told *when* to read by `ticks`, and never what changed: a tick is a hint (a commit cursor
 * from the bus, or a poll), and the follower diffs the log's state against what it last sent. So a
 * hint that never came costs a delay rather than an event, a burst of hints costs one read, and two
 * followers of one log send the same events whatever hints each of them heard.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord";
import type {
  Cursor,
  EntryId,
  EntryRecord,
  Storage,
  TaskGraph,
  TaskGraphNode,
  TaskRecord,
} from "@earendil-works/pi-durable";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { Effect, Stream } from "effect";
import type {
  SessionError,
  SessionEvent,
  SessionSnapshot,
  SessionTask,
} from "@repo/domain/Session";
import {
  evidenceAt,
  INBOX_DOC,
  LIVE_DOC,
  PR_OPENED_ENTRY_KIND,
  projectEntry,
  projectInbox,
  projectLive,
  projectTasks,
  sameTasks,
} from "./projection";
import {
  attempt,
  type FollowedState,
  readFoldedSnapshot,
  readLogDocument,
  readLogUsage,
  type SessionRef,
  snapshotEvent,
} from "./session";

/** Records per storage round trip while a follower reads what changed. */
const FOLLOW_PAGE = 500;

/** The task states a live graph holds; a terminal task has left it. */
const LIVE_TASK_STATUSES = [
  "pending",
  "running",
  "waiting",
  "completing",
] as const;

/** One durable task as `Harness.taskGraph()` would hold it, from its record (`TaskGraphNode`). */
const nodeOf = (
  record: TaskRecord<JsonValue, JsonValue, JsonValue>,
  conversations: TaskGraphNode["conversations"],
): TaskGraphNode | undefined => {
  const state = record.state;
  const phaseOf = (checkpoint: JsonValue): string => {
    const phase =
      typeof checkpoint === "object" &&
      checkpoint !== null &&
      !Array.isArray(checkpoint)
        ? checkpoint["phase"]
        : undefined;
    return typeof phase === "string" ? phase : "";
  };
  const graphState: TaskGraphNode["state"] | undefined =
    state.status === "pending" || state.status === "running"
      ? { status: state.status, phase: phaseOf(state.checkpoint) }
      : state.status === "waiting"
        ? {
            status: "waiting",
            phase: phaseOf(state.checkpoint),
            on: [...state.on],
            policy: state.policy,
          }
        : state.status === "completing"
          ? { status: "completing", outcome: state.outcome.status }
          : undefined;
  if (graphState === undefined) return undefined;
  return {
    id: record.id,
    kind: record.kind,
    conversationId: record.conversationId,
    ...(record.owner === undefined ? {} : { owner: record.owner }),
    background: record.background,
    abortRequested: record.abortRequested,
    state: graphState,
    conversations,
  };
};

/**
 * A log's live tasks, as `projectTasks` reads a harness's graph (LOB-183): every task not yet
 * terminal, with the conversations it owns. The graph Pi Durable keeps in memory is a fold of these
 * same records, so the two projections agree on what is running.
 */
export const readLogTasks = (
  storage: Storage,
): Effect.Effect<readonly SessionTask[], SessionError> =>
  Effect.gen(function* () {
    const tasks: Record<string, TaskGraphNode> = {};
    for (const status of LIVE_TASK_STATUSES) {
      let cursor: Cursor | undefined;
      for (;;) {
        const page = yield* attempt("scan tasks", () =>
          storage.scanTasks(
            { status },
            FOLLOW_PAGE,
            cursor,
            BACKGROUND_CONTEXT,
          ),
        );
        for (const record of page.items) {
          const owned = yield* attempt("scan task conversations", () =>
            storage.scanConversations(
              { ownerTaskId: record.id },
              FOLLOW_PAGE,
              undefined,
              BACKGROUND_CONTEXT,
            ),
          );
          const node = nodeOf(
            record,
            owned.items
              .map((conversation) => conversation.id)
              .sort((a, b) => a - b),
          );
          if (node !== undefined) tasks[String(record.id)] = node;
        }
        cursor = page.next;
        if (cursor === undefined) break;
      }
    }
    const graph: TaskGraph = { tasks };
    return projectTasks(graph);
  });

/** What the log says is happening now: the parts of a snapshot a follower diffs. */
export const readFollowedState = (
  storage: Storage,
): Effect.Effect<FollowedState, SessionError> =>
  Effect.gen(function* () {
    const live = yield* readLogDocument(storage, LIVE_DOC);
    const inbox = yield* readLogDocument(storage, INBOX_DOC);
    const docs: Record<string, JsonValue> = {
      ...(live === undefined ? {} : { [LIVE_DOC]: live }),
      ...(inbox === undefined ? {} : { [INBOX_DOC]: inbox }),
    };
    return {
      live: projectLive(docs),
      queued: projectInbox(docs),
      usage: yield* readLogUsage(storage),
      tasks: yield* readLogTasks(storage),
    };
  });

/** A followed session's snapshot: `mode: "live"`, read from its log (`readFoldedSnapshot`). */
export const readFollowedSnapshot = (
  storage: Storage,
  ref: SessionRef,
): Effect.Effect<
  { readonly snapshot: SessionSnapshot; readonly state: FollowedState },
  SessionError
> =>
  Effect.gen(function* () {
    const state = yield* readFollowedState(storage);
    const snapshot = yield* readFoldedSnapshot(storage, ref, state);
    return { snapshot, state };
  });

/** The root's entries after `after`, oldest first: what a follower has not sent yet. */
const readEntriesAfter = (
  storage: Storage,
  after: number,
): Effect.Effect<readonly EntryRecord[], SessionError> =>
  Effect.gen(function* () {
    const records: EntryRecord[] = [];
    let cursor: Cursor | undefined;
    for (;;) {
      const page = yield* attempt("scan new entries", () =>
        storage.scanEntries(
          {
            conversationId: ROOT_CONVERSATION_ID,
            minEntryId: (after + 1) as EntryId,
          },
          FOLLOW_PAGE,
          cursor,
          BACKGROUND_CONTEXT,
        ),
      );
      records.push(...page.items);
      cursor = page.next;
      if (cursor === undefined) break;
    }
    // Storage scans newest first; a transcript is sent oldest first.
    return records.reverse();
  });

const prUrlOf = (entry: EntryRecord): string | undefined => {
  const data = entry.data;
  if (typeof data !== "object" || data === null || Array.isArray(data))
    return undefined;
  const url = data["url"];
  return typeof url === "string" ? url : undefined;
};

const sameJson = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

/**
 * A session another process owns, as a stream: its snapshot, then one batch of events per tick for
 * whatever the log holds that this stream has not sent, and one last read when `ticks` ends — the
 * caller ends it when the owner does, so the stream's end is the live session's end, as a
 * historical stream's end is its fold's.
 *
 * Events come in the order a live stream sends them (`diffView`): entries (with `prOpened` beside
 * the entry that announces it), then the queue before the run's liveness — a follower stops at the
 * first event that says the run settled, so the queue it drained must already be out (LOB-166) —
 * then spend, then tasks. Entries are sent once each, by id.
 */
export const followSessionEvents = (
  storage: Storage,
  ref: SessionRef,
  ticks: Stream.Stream<unknown>,
): Stream.Stream<SessionEvent, SessionError> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const first = yield* readFollowedSnapshot(storage, ref);
      let state = first.state;
      // The newest entry the snapshot carried: entry ids rise through a log, so "after it" is what
      // has not been sent. The window is the newest entries, so its last is the newest of all.
      let last = Number(first.snapshot.entries.at(-1)?.id ?? 0);

      const step = Effect.gen(function* () {
        const events: SessionEvent[] = [];
        // The state first, then the entries: a reader-mode storage catches up on every read, so the
        // entries are read at least as far into the log as the state was, and every entry committed
        // with or before the state this step sends (an idle among them) goes out ahead of it. An
        // entry newer than the state is harmless: the next step sends the newer state after it.
        const next = yield* readFollowedState(storage);
        for (const record of yield* readEntriesAfter(storage, last)) {
          last = Math.max(last, Number(record.id));
          events.push({ _tag: "entry", entry: projectEntry(record) });
          if (record.kind === PR_OPENED_ENTRY_KIND) {
            const prUrl = prUrlOf(record);
            const evidence = evidenceAt(record.data);
            if (prUrl !== undefined)
              events.push({
                _tag: "prOpened",
                prUrl,
                ...(evidence === undefined ? {} : { evidence }),
              });
          }
        }
        if (!sameJson(state.queued, next.queued))
          events.push({ _tag: "queued", queued: next.queued });
        if (!sameJson(state.live, next.live)) {
          events.push({ _tag: "live", live: next.live });
          if (state.live.busy !== next.live.busy)
            events.push({
              _tag: "status",
              status: next.live.busy ? "busy" : "idle",
            });
        }
        if (!sameJson(state.usage, next.usage))
          events.push({ _tag: "usage", usage: next.usage });
        if (!sameTasks(state.tasks, next.tasks))
          events.push({ _tag: "tasks", tasks: next.tasks });
        state = next;
        return events;
      });

      const changes = ticks.pipe(
        // A burst of hints is one read: while a read runs, at most one tick waits behind it.
        Stream.buffer({ capacity: 1, strategy: "sliding" }),
        Stream.concat(Stream.make(undefined)),
        Stream.mapEffect(() => step),
        Stream.flatMap((events) => Stream.fromIterable(events)),
      );
      return Stream.concat(Stream.make(snapshotEvent(first.snapshot)), changes);
    }),
  );
