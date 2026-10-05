import type {
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
              break;
            }
            case "entry": {
              yield* printEntry(state, event.entry);
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
