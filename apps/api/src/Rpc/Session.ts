import { SessionService } from "@repo/core";
import { RpcApi, SessionRpc } from "@repo/domain/Rpc";
import { Effect, Layer } from "effect";
import { RpcSerialization, RpcServer } from "effect/rpc";

/**
 * The session RPC surface (docs/design.md D9).
 *
 * Every handler is a thin call into `SessionService`; the policy — who owns a log, when a read is
 * live and when it is a fold, what wakes a session — lives there rather than here, so the CLI and
 * the dashboard cannot drift from each other.
 */
const SessionRpcHandlers = SessionRpc.toLayer(
  Effect.gen(function* () {
    const sessions = yield* SessionService;
    return SessionRpc.of({
      createSession: (input) => sessions.create(input),
      getSession: (input) => sessions.get(input.sessionId),
      sendMessage: (input) => sessions.send(input),
      interruptSession: (input) => sessions.interrupt(input.sessionId),
      listSessions: (input) => sessions.list(input),
      registerRepo: (input) => sessions.registerRepo(input),
      watchSession: (input) => sessions.events(input.sessionId),
    });
  }),
);

export const SessionRpcLive = RpcServer.layerHttp({
  group: RpcApi,
  path: "/rpc",
  protocol: "http",
}).pipe(
  Layer.provide(SessionRpcHandlers),
  Layer.provide(RpcSerialization.layerNdjson),
);
