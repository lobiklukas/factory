import { EventRpc, RpcApi, type TickEvent } from "@repo/domain/Rpc";
import { Effect, Layer, Queue } from "effect";
import { RpcSerialization, RpcServer } from "effect/rpc";

/**
 * Scaffold handler for the streaming RPC transport.
 *
 * Replaced by the session event stream (docs/design.md D8): the queue becomes the
 * SessionBus subscription and the emissions become transcript commits.
 */
const EventRpcHandlers = EventRpc.toLayer(
  Effect.gen(function* () {
    yield* Effect.logInfo("Starting Event RPC Live Implementation");
    return EventRpc.of({
      tick: Effect.fn(function* (payload) {
        yield* Effect.logDebug("Creating new tick stream");
        const queue = yield* Queue.unbounded<typeof TickEvent.Type>();
        yield* Effect.forkScoped(
          Effect.gen(function* () {
            yield* Queue.offer(queue, { _tag: "starting" });
            yield* Effect.sleep("3 seconds");
            for (let i = 0; i < payload.ticks; i++) {
              yield* Effect.sleep("1 second");
              yield* Queue.offer(queue, { _tag: "tick" });
            }
            yield* Queue.offer(queue, { _tag: "end" });
            yield* Effect.logDebug("End event sent");
          }).pipe(Effect.ensuring(Queue.shutdown(queue))),
        );
        return queue;
      }),
    });
  }),
);

// NOTE: Additional RPC handlers merge in here.
const RpcHandlers = EventRpcHandlers;

export const EventRpcLive = RpcServer.layerHttp({
  group: RpcApi,
  path: "/rpc",
  protocol: "http",
}).pipe(
  Layer.provide(RpcHandlers),
  Layer.provide(RpcSerialization.layerNdjson),
);
