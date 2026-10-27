import type {
  QueuedMessage,
  SessionEvent,
  SessionId,
  SessionMode,
  TranscriptEntry,
} from "@repo/domain/Session";
import type { SessionError } from "@repo/domain/Session";
import { Console, Effect, Ref, Stream } from "effect";
import type { RpcClientError } from "effect/rpc/RpcClientError";
import type { SessionRpcClient } from "./rpc";

/** One transcript entry as a terminal line: the kind, the tool on a result, then the text. */
export const formatEntry = (entry: TranscriptEntry): string => {
  switch (entry.kind) {
    case "toolResult":
      return `[tool:${entry.toolName ?? "?"}] ${entry.text}`;
    default:
      return `[${entry.kind}] ${entry.text}`;
  }
};

/**
 * One queued message as a terminal line: the queue it waits in and its submission id, then its text.
 *
 * The id is in the bracket because it is what `factory withdraw` takes (LOB-166): a queued line that
 * did not name its message would leave nothing to withdraw it by.
 */
export const formatQueued = (queued: QueuedMessage): string => {
  const text =
    typeof queued.content === "string"
      ? queued.content
      : queued.content == null
        ? ""
        : /* oxlint-disable-next-line effecttsgo/prefer-schema-over-json */ JSON.stringify(
            queued.content,
          );
  return `[queued:${queued.mode}:${queued.id}] ${text}`.trimEnd();
};

/** What a watcher prints when the queue it was showing drains. */
export const QUEUE_EMPTY = "[queued] (empty)";

/**
 * Whether the run is over. `live.busy` is the same signal as `status`, and either arriving means
 * the session settled — a live stream would otherwise never end, because a subscriber stays
 * attached after the work is done (release is the idle sweep's job, not the stream's).
 */
const isSettled = (event: SessionEvent): boolean => {
  switch (event._tag) {
    case "snapshot":
      return !event.live.busy;
    case "live":
      return !event.live.busy;
    case "status":
      return event.status === "idle";
    default:
      return false;
  }
};

export type FollowResult = {
  /** `live` when this process owns the session, `historical` when the log was folded (D8). */
  readonly mode: SessionMode | undefined;
  /** The last non-empty assistant text, which is the run's answer. */
  readonly answer: string | undefined;
};

const printEntry = (
  state: Ref.Ref<FollowResult>,
  entry: TranscriptEntry,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    // Pi Durable commits a head marker and an in-flight assistant entry with no text yet; a
    // terminal line for each of those would be noise around the transcript (the dashboard renders
    // them as dividers instead).
    if (entry.text.trim() !== "") {
      yield* Console.log(formatEntry(entry));
    }
    if (entry.kind === "assistant" && entry.text.trim() !== "") {
      yield* Ref.update(state, (current) => ({
        ...current,
        answer: entry.text,
      }));
    }
  });

/**
 * Attach to a session, print its entries as they arrive, and stop when it settles or the stream
 * ends.
 *
 * Nothing is printed twice: the stream's first `snapshot` carries the committed transcript, so
 * attaching after a run has already finished still shows the whole answer, and attaching mid-run
 * shows it once the events land. `printMode` is the `watch` label — the live-versus-historical
 * distinction a caller cannot infer from the entries alone (docs/design.md D8).
 */
export const followSession = (
  client: SessionRpcClient,
  sessionId: SessionId,
  options: { readonly printMode: boolean },
): Effect.Effect<FollowResult, SessionError | RpcClientError> =>
  Effect.gen(function* () {
    const state = yield* Ref.make<FollowResult>({
      mode: undefined,
      answer: undefined,
    });
    // How many messages the last queue reading held, so a drain is told apart from a quiet queue.
    const queuedCount = yield* Ref.make(0);

    yield* client.watchSession({ sessionId }).pipe(
      Stream.takeUntil(isSettled),
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          switch (event._tag) {
            case "snapshot": {
              yield* Ref.update(state, (current) => ({
                ...current,
                mode: event.session.mode,
              }));
              if (options.printMode) {
                yield* Console.log(`mode: ${event.session.mode}`);
              }
              for (const entry of event.entries) {
                yield* printEntry(state, entry);
              }
              yield* Ref.set(queuedCount, event.queued.length);
              for (const q of event.queued) {
                yield* Console.log(formatQueued(q));
              }
              break;
            }
            case "entry": {
              yield* printEntry(state, event.entry);
              break;
            }
            case "queued": {
              // A queue that held messages and now holds none drained — a run took them, or they were
              // withdrawn — which is worth a line of its own; an empty queue staying empty is not.
              const before = yield* Ref.getAndSet(
                queuedCount,
                event.queued.length,
              );
              if (before > 0 && event.queued.length === 0) {
                yield* Console.log(QUEUE_EMPTY);
              }
              for (const q of event.queued) {
                yield* Console.log(formatQueued(q));
              }
              break;
            }
            default:
              break;
          }
        }),
      ),
    );

    return yield* Ref.get(state);
  });
