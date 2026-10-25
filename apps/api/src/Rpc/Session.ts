import { SessionService, TaskServiceLive } from "@repo/core";
import { RpcApi, SessionRpc } from "@repo/domain/Rpc";
import { Effect, Layer } from "effect";
import { RpcSerialization, RpcServer } from "effect/rpc";
import { ApprovalsRpcHandlers } from "./Approvals";
import { TaskRpcHandlers } from "./Task";

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
      forkSession: (input) => sessions.fork(input),
      replaySession: (input) => sessions.replay(input),
      resetSession: (input) => sessions.reset(input),
      compactSession: (input) => sessions.compact(input),
      // A mission is a session's (LOB-230): the call answers its id, and the phase it reached is read
      // off `getSession`'s snapshot rather than off a second call.
      startMission: (input) => sessions.startMission(input),
      listSessions: (input) => sessions.list(input),
      listPages: (input) => sessions.listPages(input),
      curateSession: (input) => sessions.curate(input),
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
  Layer.provide(
    Layer.mergeAll(SessionRpcHandlers, ApprovalsRpcHandlers, TaskRpcHandlers),
  ),
  Layer.provide(RpcSerialization.layerNdjson),
  Layer.provide(TaskServiceLive),
);
