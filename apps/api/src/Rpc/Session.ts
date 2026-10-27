import {
  CredentialProvider,
  SessionService,
  TaskServiceLive,
} from "@repo/core";
import { RpcApi, SessionRpc } from "@repo/domain/Rpc";
import { Effect, Layer } from "effect";
import { HttpClient } from "effect/http";
import { RpcSerialization, RpcServer } from "effect/rpc";
import { ApprovalsRpcHandlers } from "./Approvals";
import { TaskRpcHandlers } from "./Task";

/**
 * The session RPC surface (docs/design.md D9).
 *
 * Every handler is a thin call into `SessionService`; the policy — who owns a log, when a read is
 * live and when it is a fold, what wakes a session — lives there rather than here, so the CLI and
 * the dashboard cannot drift from each other.
 *
 * The PR step is the one handler with requirements of its own (LOB-213): the forge client and the
 * credential are the step's, not the session service's (`SessionService.openPullRequest` says why),
 * so this layer takes them from its context and hands them to that one call. The process wires the
 * real ones (`CredentialProviderLive`, `FetchHttpClient`); a test or a drive wires a fake forge.
 */
const SessionRpcHandlers = SessionRpc.toLayer(
  Effect.gen(function* () {
    const sessions = yield* SessionService;
    const credentials = yield* CredentialProvider;
    const forge = yield* HttpClient.HttpClient;
    return SessionRpc.of({
      createSession: (input) => sessions.create(input),
      getSession: (input) => sessions.get(input.sessionId),
      sendMessage: (input) => sessions.send(input),
      withdrawMessage: (input) => sessions.withdraw(input),
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
      openPullRequest: (input) =>
        sessions
          .openPullRequest(input)
          .pipe(
            Effect.provideService(CredentialProvider, credentials),
            Effect.provideService(HttpClient.HttpClient, forge),
          ),
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
