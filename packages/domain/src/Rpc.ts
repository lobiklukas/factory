import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";

export const TickEvent = Schema.Union([
  Schema.TaggedStruct("starting", {}),
  Schema.TaggedStruct("tick", {}),
  Schema.TaggedStruct("end", {}),
]);

/**
 * Streaming RPC over HTTP, kept as the transport scaffold for session events.
 *
 * The shape is deliberate: a client opens a stream, the server pushes events as
 * they happen, and the stream ends. That is exactly what a Pi Durable
 * conversation needs for `watch()` — commit operations small enough to send over
 * a socket — so this group is replaced by the session event stream rather than
 * being rebuilt from scratch. See docs/design.md D8/D9.
 */
export class EventRpc extends RpcGroup.make(
  Rpc.make("tick", {
    payload: {
      ticks: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    },
    success: TickEvent,
    stream: true,
  }),
) {}

// NOTE: Session lifecycle, sandbox lifecycle, and approvals merge in here.
export const RpcApi = EventRpc;
