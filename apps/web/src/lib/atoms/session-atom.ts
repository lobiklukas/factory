import type { SessionEvent, TranscriptEntry } from "@repo/domain/Session";
import { Effect, Stream } from "effect";
import { runtime } from "../atom";
import { RpcClient } from "../rpc-client";

/** What the card shows: the transcript so far, plus which read path produced it (D8). */
export type SessionView = {
  readonly mode: "live" | "historical";
  readonly status: "idle" | "busy";
  readonly lines: readonly string[];
};

const renderEntry = (entry: TranscriptEntry): string => {
  const calls = entry.toolCalls.map((call) => call.name).join(", ");
  const suffix = calls.length > 0 ? ` → ${calls}` : "";
  const body = entry.text.length > 0 ? entry.text : "(no text)";
  return `${entry.kind}: ${body}${suffix}`;
};

const empty: SessionView = { mode: "historical", status: "idle", lines: [] };

/**
 * Create a session, send it a message, and follow its stream.
 *
 * The whole point of the card: the dashboard is a client of the same RPC surface the CLI uses, so
 * what it proves about the transport it proves for every client.
 */
export const sessionAtom = runtime.fn((input: { readonly content: string }) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const rpc = yield* RpcClient;
      const session = yield* rpc.client.createSession({});
      yield* rpc.client.sendMessage({
        sessionId: session.id,
        content: input.content,
      });
      return rpc.client.watchSession({ sessionId: session.id });
    }),
  ).pipe(
    Stream.mapAccum(
      (): SessionView => empty,
      (
        state,
        event: SessionEvent,
      ): readonly [SessionView, readonly SessionView[]] => {
        switch (event._tag) {
          case "snapshot": {
            const next: SessionView = {
              mode: event.session.mode,
              status: event.session.status,
              lines: event.entries.map(renderEntry),
            };
            return [next, [next]];
          }
          case "entry": {
            const next: SessionView = {
              ...state,
              lines: [...state.lines, renderEntry(event.entry)],
            };
            return [next, [next]];
          }
          case "status": {
            const next: SessionView = { ...state, status: event.status };
            return [next, [next]];
          }
          case "live":
          case "usage": {
            return [state, []];
          }
        }
      },
    ),
  ),
);
