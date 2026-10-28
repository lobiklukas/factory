import {
  CredentialProvider,
  SessionService,
  SkillServiceLive,
  TaskServiceLive,
  TriggerDeliveriesLive,
  TriggerRoutesLive,
} from "@repo/core";
import { RpcApi, SessionRpc } from "@repo/domain/Rpc";
import { Effect, Layer } from "effect";
import { HttpClient } from "effect/http";
import { RpcSerialization, RpcServer } from "effect/rpc";
import { ApprovalsRpcHandlers } from "./Approvals";
import { attributed } from "./Auth";
import { DoctorRpcHandlers } from "./Doctor";
import { ServerRpcHandlers } from "./Server";
import { SkillsRpcHandlers } from "./Skills";
import { TaskRpcHandlers } from "./Task";
import { TriggerRoutesRpcHandlers } from "./TriggerRoutes";

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
      // The actor is the credential's, not the body's (LOB-20): `sessions.actor`, `factory.actor`
      // and so `listSpend` name who the control plane authenticated.
      createSession: (input) =>
        attributed(input).pipe(Effect.flatMap(sessions.create)),
      getSession: (input) => sessions.get(input.sessionId),
      readSessionHistory: (input) => sessions.history(input),
      sendMessage: (input) => sessions.send(input),
      withdrawMessage: (input) => sessions.withdraw(input),
      interruptSession: (input) => sessions.interrupt(input.sessionId),
      setSessionBudget: (input) => sessions.setBudget(input),
      // A fork or a replay over the wire is the caller's new session, so its spend is the caller's;
      // with auth off it keeps its source's actor, as an in-process one does (LOB-162).
      forkSession: (input) =>
        attributed(input).pipe(Effect.flatMap(sessions.fork)),
      replaySession: (input) =>
        attributed(input).pipe(Effect.flatMap(sessions.replay)),
      resetSession: (input) => sessions.reset(input),
      compactSession: (input) => sessions.compact(input),
      // A mission is a session's (LOB-230): the call answers its id, and the phase it reached is read
      // off `getSession`'s snapshot rather than off a second call.
      startMission: (input) => sessions.startMission(input),
      listSessions: (input) => sessions.list(input),
      listSpend: () => sessions.spend,
      getOutcomes: (input) => sessions.outcomes(input),
      predictCost: (input) => sessions.predictCost(input),
      backtestCost: (input) => sessions.backtestCost(input),
      listPages: (input) => sessions.listPages(input),
      curateSession: (input) => sessions.curate(input),
      // Proposals only (LOB-201): nothing is created in a tracker and no session is started.
      proposeDecomposition: (input) => sessions.proposeDecomposition(input),
      // Creates the approved proposals in the tracker (LOB-202), behind the session layer's port.
      approveProposals: (input) => sessions.approveProposals(input),
      // A plan-freshness revision (LOB-45): declined with no call, or approved through the same port.
      declinePlanRevision: (input) => sessions.declinePlanRevision(input),
      approvePlanRevision: (input) => sessions.approvePlanRevision(input),
      registerRepo: (input) => sessions.registerRepo(input),
      listRepos: () => sessions.listRepos,
      getRepo: (input) => sessions.getRepo(input),
      syncRepo: (input) => sessions.syncRepo(input),
      // Only the session and the title: the branches are the session's own, read server-side.
      openPullRequest: (input) =>
        sessions
          .openPullRequest({ sessionId: input.sessionId, title: input.title })
          .pipe(
            Effect.provideService(CredentialProvider, credentials),
            Effect.provideService(HttpClient.HttpClient, forge),
          ),
      discardSession: (input) =>
        sessions.releaseWorkspace({
          sessionId: input.sessionId,
          reason: "discarded",
        }),
      watchSession: (input) => sessions.events(input.sessionId),
    });
  }),
);

/**
 * The `/rpc` endpoint over every group. It requires `ControlPlaneAuth` (LOB-20): the process provides
 * the one its token table configures (`controlPlaneAuthLayer` in `./Auth`), and a suite provides its
 * own, so no wiring serves the surface without deciding who may call it.
 */
export const SessionRpcLive = RpcServer.layerHttp({
  group: RpcApi,
  path: "/rpc",
  protocol: "http",
}).pipe(
  Layer.provide(
    Layer.mergeAll(
      SessionRpcHandlers,
      ApprovalsRpcHandlers,
      TaskRpcHandlers,
      TriggerRoutesRpcHandlers,
      ServerRpcHandlers,
      DoctorRpcHandlers,
      SkillsRpcHandlers,
    ),
  ),
  Layer.provide(RpcSerialization.layerNdjson),
  Layer.provide(TaskServiceLive),
  Layer.provide(TriggerRoutesLive),
  Layer.provide(TriggerDeliveriesLive),
  Layer.provide(SkillServiceLive),
);
