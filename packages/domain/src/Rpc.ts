import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import { ControlPlaneAuth } from "@repo/domain/Auth";
import { SessionContext } from "@repo/domain/RepoContext";
import {
  AddNotificationSinkInput,
  GetNotificationSettingsInput,
  NotificationErrorSchema,
  NotificationSettings,
  NotificationSinkRefInput,
  NotificationSinkSummary,
  SetNotificationKindInput,
  SetNotificationSinkEnabledInput,
} from "@repo/domain/Notify";
import {
  DeleteSecretInput,
  ListSecretsInput,
  SecretErrorSchema,
  SecretSummary,
  SetSecretInput,
} from "@repo/domain/Secret";
import {
  DecideApprovalInput,
  DecideApprovalOutput,
  ListApprovalsOutput,
  ListPendingApprovalsInput,
  ListPendingApprovalsOutput,
  RequestApprovalInput,
  ApprovalRequest,
} from "@repo/domain/Approval";
import {
  AlreadyBlocked,
  AttentionItem,
  BlockTaskInput,
  BoardCard,
  BoardConfig,
  BoardInstance,
  BoardExists,
  BoardNotFound,
  BoardRepoMismatch,
  BoardView,
  CardMigrationRefused,
  CommentTaskInput,
  CreateBoardInput,
  CreatedBoard,
  CreateTaskInput,
  DefineBoardInput,
  DefinedBoard,
  DefinitionConfig,
  DefinitionNotFound,
  DefinitionSource,
  DefinitionSummary,
  DefinitionVocabulary,
  EmptyComment,
  GetBoardConfigInput,
  GetBoardInput,
  GetDefinitionInput,
  GetDefinitionVocabularyInput,
  GetTaskInput,
  GetTaskExitInput,
  GetTaskSpecInput,
  GetTaskPlanInput,
  GetTaskHandoffInput,
  HumanGateRequired,
  InvalidDefinition,
  InvalidTaskInput,
  ListAttentionInput,
  ListBoardsInput,
  ListDefinitionsInput,
  ListTaskCommentsInput,
  ListTaskRunsInput,
  ListTasksInput,
  MoveTaskInput,
  NotBlocked,
  RequirementUnmet,
  StaleBoardVersion,
  StaleRevision,
  Task,
  TaskComment,
  TaskNotFound,
  TaskRun,
  TaskExit,
  TaskSpec,
  TaskPlan,
  TaskHandoff,
  TaskStorageError,
  UndeclaredTransition,
  UnblockTaskInput,
  UpdateTaskInput,
  UpgradeBoardInput,
  UpgradedBoard,
} from "@repo/domain/Task";
import {
  CurateSessionInput,
  CurateSessionResult,
  ListPagesInput,
  ListPagesOutput,
} from "@repo/domain/Page";
import {
  BacktestCostInput,
  CostBacktest,
  CostPrediction,
  PredictCostInput,
} from "@repo/domain/Cost";
import { StartMissionInput, StartMissionResult } from "@repo/domain/Mission";
import { OutcomeReport, OutcomesInput } from "@repo/domain/Outcomes";
import {
  CheckDeploymentInput,
  DeploymentChecks,
  GetServerInfoInput,
  ModelPing,
  PingModelInput,
  ServerInfo,
} from "@repo/domain/Server";
import {
  GetSkillInput,
  ListSkillsInput,
  ListSkillVersionsInput,
  PutSkillInput,
  SkillErrorSchema,
  SkillRecord,
  SkillSummary,
  SkillVersionSummary,
} from "@repo/domain/Skill";
import {
  AddTriggerRouteInput,
  ListTriggerDeliveriesInput,
  ListTriggerDeliveriesOutput,
  ListTriggerRoutesInput,
  ListTriggerRoutesOutput,
  RemoveTriggerRouteInput,
  TriggerDeliveryError,
  TriggerRoute,
  TriggerRouteError,
  TriggerRouteNotFound,
} from "@repo/domain/Trigger";
import {
  ApproveProposalsError,
  ApproveProposalsInput,
  ApproveProposalsResult,
  ProposalsRefused,
  ProposeDecompositionInput,
  ProposeDecompositionResult,
} from "@repo/domain/Decomposition";
import {
  ApprovePlanRevisionInput,
  ApprovePlanRevisionResult,
  DeclinePlanRevisionInput,
  PlanRevision,
} from "@repo/domain/PlanFreshness";
import {
  CredentialError,
  OpenPullRequestPayload,
  PrError,
  PullRequestStep,
} from "@repo/domain/PullRequest";
import {
  CompactSessionInput,
  CompactSessionResult,
  CreateSessionInput,
  ForkSessionInput,
  GetRepoInput,
  InterruptSessionResult,
  SetSessionBudgetInput,
  SetSessionBudgetResult,
  ListReposInput,
  ListReposOutput,
  ListSessionsInput,
  ListSessionsOutput,
  ListSpendInput,
  ReadSessionHistoryInput,
  RegisterRepoInput,
  ReleaseWorkspaceResult,
  ReplaySessionInput,
  RepoCloneFailed,
  RepoNotFound,
  RepoSummary,
  ResetSessionInput,
  SendMessageInput,
  SendMessageResult,
  SessionError,
  SessionEvent,
  SessionHistoryPage,
  SessionIdInput,
  SessionSnapshot,
  SessionSummary,
  SpendReport,
  SyncRepoInput,
  WithdrawMessageInput,
  WithdrawMessageResult,
} from "@repo/domain/Session";

/**
 * The session RPC surface (docs/design.md D8/D9): create, read, drive, interrupt, watch, list.
 *
 * `watchSession` is the streaming one, and it is the only place the live/historical distinction
 * shows: attaching to a session this process owns streams events as they commit, while attaching
 * to one nobody owns folds the log once, sends a single `snapshot` whose `mode` is `historical`,
 * and ends the stream. The stream's own error channel carries `SessionError`, so a session that
 * vanishes mid-stream fails the stream rather than the connection.
 *
 * `listSessions` reads the derived activity index, never a log: its cost is one query whatever the
 * number of sessions (R6, docs/features.md §3 A2).
 */
export class SessionRpc extends RpcGroup.make(
  Rpc.make("createSession", {
    payload: CreateSessionInput,
    success: SessionSummary,
    error: SessionError,
  }),
  Rpc.make("getSession", {
    payload: SessionIdInput,
    success: SessionSnapshot,
    error: SessionError,
  }),
  // A historical snapshot carries the newest entries of a long transcript; this pages back through
  // the rest on request (LOB-243).
  Rpc.make("readSessionHistory", {
    payload: ReadSessionHistoryInput,
    success: SessionHistoryPage,
    error: SessionError,
  }),
  // What the session's run was told about its repository (F19): the instruction file, its size and
  // whether it was cut, and the skills indexed. Read from the log, owned or not.
  Rpc.make("getSessionContext", {
    payload: SessionIdInput,
    success: SessionContext,
    error: SessionError,
  }),
  Rpc.make("sendMessage", {
    payload: SendMessageInput,
    success: SendMessageResult,
    error: SessionError,
  }),
  // Withdrawing takes a queued message back out of the inbox before a run places it (LOB-166). A
  // message the log already placed or settled is an outcome in the answer, not an error.
  Rpc.make("withdrawMessage", {
    payload: WithdrawMessageInput,
    success: WithdrawMessageResult,
    error: SessionError,
  }),
  // An interrupt of an idle session is an outcome in the answer (`not_running`), not an error (C8).
  Rpc.make("interruptSession", {
    payload: SessionIdInput,
    success: InterruptSessionResult,
    error: SessionError,
  }),
  // Setting a cap commits it on the session's log and clears the stop the old cap made, so a session
  // the cap stopped runs again on its next message (C23). It is a cap raise in the usual case, and
  // sets one on a session that had none.
  Rpc.make("setSessionBudget", {
    payload: SetSessionBudgetInput,
    success: SetSessionBudgetResult,
    error: SessionError,
  }),
  Rpc.make("forkSession", {
    payload: ForkSessionInput,
    success: SessionSummary,
    error: SessionError,
  }),
  // A replay runs the same task again in a new session, on another model (LOB-198). The source's
  // log is only read, so the answer is the new session, not a copy of the old one's transcript.
  Rpc.make("replaySession", {
    payload: ReplaySessionInput,
    success: SessionSummary,
    error: SessionError,
  }),
  // A reset is not an interrupt: it starts a new model context (with the handoff note as its first
  // message) and leaves the transcript's past in place, marked by the `reset` entry (LOB-181).
  Rpc.make("resetSession", {
    payload: ResetSessionInput,
    success: SessionSummary,
    error: SessionError,
  }),
  // Compaction is a task in the log, not a request: the call admits it and answers its id, and
  // the summary arrives as a `compaction` entry when it settles (B4).
  Rpc.make("compactSession", {
    payload: CompactSessionInput,
    success: CompactSessionResult,
    error: SessionError,
  }),
  Rpc.make("listSessions", {
    payload: ListSessionsInput,
    success: ListSessionsOutput,
    error: SessionError,
  }),
  // Spend keyed by repo and actor (LOB-162): one grouped read of the same index `listSessions`
  // reads, so the spend pane's numbers are the list's numbers added up, never a fold of a log (R6).
  Rpc.make("listSpend", {
    payload: ListSpendInput,
    success: SpendReport,
    error: SessionError,
  }),
  // The outcome metrics over a window (LOB-44): lead time, cycle time, defect pressure, recovery,
  // adoption and cost, every value with its window, its denominator and its source. Read from the
  // index tables and the card history, never a fold of a log, and never from GitHub or Linear.
  Rpc.make("getOutcomes", {
    payload: OutcomesInput,
    success: OutcomeReport,
    error: SessionError,
  }),
  // Cost prediction before a run (LOB-38): a range from the completed sessions most like the prompt,
  // and the walk-forward backtest that says how wrong it has been — both from the same index.
  Rpc.make("predictCost", {
    payload: PredictCostInput,
    success: CostPrediction,
    error: SessionError,
  }),
  Rpc.make("backtestCost", {
    payload: BacktestCostInput,
    success: CostBacktest,
    error: SessionError,
  }),
  // The cited knowledge pages a session's log holds (LOB-204), read from the derived rows a rebuild
  // refills from that log.
  Rpc.make("listPages", {
    payload: ListPagesInput,
    success: ListPagesOutput,
    error: SessionError,
  }),
  // One bounded curator pass over a finished session (LOB-206): the answer is what it wrote, and an
  // empty list is a pass that found nothing new rather than a pass that did not run.
  Rpc.make("curateSession", {
    payload: CurateSessionInput,
    success: CurateSessionResult,
    error: SessionError,
  }),
  // One decomposition of the session's spec into proposed child issues (LOB-201): the answer is the
  // set it committed, which `getSession` reads back as `proposedIssues`. It creates nothing in any
  // tracker and starts no session; a set the validator refuses crosses the wire as
  // `ProposalsRefused`, naming every fault, and nothing is stored.
  Rpc.make("proposeDecomposition", {
    payload: ProposeDecompositionInput,
    success: ProposeDecompositionResult,
    error: Schema.Union([SessionError, ProposalsRefused]),
  }),
  // Approving a subset of those proposals (LOB-202): each approved one becomes a child of the issue
  // the session was delegated from, and its id is recorded in the document. A process with no
  // tracker, or a session with no delegating issue, is refused as `ApproveProposalsError` with
  // nothing sent; a tracker failure is the same error naming what was already created.
  Rpc.make("approveProposals", {
    payload: ApproveProposalsInput,
    success: ApproveProposalsResult,
    error: Schema.Union([SessionError, ApproveProposalsError]),
  }),
  // A plan-freshness revision (LOB-45) — proposals to add, re-scope or close that a merged PR's pass
  // filed on the spec's session — is a person's to decline or approve. Declining sends nothing and
  // makes no call; approving goes through the same tracker port as `approveProposals`, and a
  // declined revision is refused (`ApproveProposalsError`, `declined`).
  Rpc.make("declinePlanRevision", {
    payload: DeclinePlanRevisionInput,
    success: PlanRevision,
    error: Schema.Union([SessionError, ApproveProposalsError]),
  }),
  Rpc.make("approvePlanRevision", {
    payload: ApprovePlanRevisionInput,
    success: ApprovePlanRevisionResult,
    error: Schema.Union([SessionError, ApproveProposalsError]),
  }),
  // A registration that names a URL and no checkout clones the repo into the factory's cache (LOB-265):
  // a clone that fails is `RepoCloneFailed`, naming the repo and the reason, with the row still
  // registered so `syncRepo` can try again.
  Rpc.make("registerRepo", {
    payload: RegisterRepoInput,
    success: RepoSummary,
    error: Schema.Union([SessionError, RepoCloneFailed]),
  }),
  Rpc.make("syncRepo", {
    payload: SyncRepoInput,
    success: RepoSummary,
    error: Schema.Union([SessionError, RepoNotFound, RepoCloneFailed]),
  }),
  // The registry read every repo picker needs (LOB-253): each row carries what its checkout says
  // about itself, read when it is answered. An unknown slug is `RepoNotFound`, not a session's
  // `not_found`.
  Rpc.make("listRepos", {
    payload: ListReposInput,
    success: ListReposOutput,
    error: SessionError,
  }),
  Rpc.make("getRepo", {
    payload: GetRepoInput,
    success: RepoSummary,
    error: Schema.Union([SessionError, RepoNotFound]),
  }),
  // A mission is a session's, not a client's: starting one answers its id, and the phase it
  // reached is read off `getSession`'s snapshot rather than off a second call (LOB-230). The
  // surface decision — this group, not a `MissionRpc` of its own — is recorded in
  // `@repo/domain/Mission`.
  Rpc.make("startMission", {
    payload: StartMissionInput,
    success: StartMissionResult,
    error: SessionError,
  }),
  // The session's PR (LOB-213): opened once, and a repeat answers the recorded one tagged
  // `already-open` without asking the forge again. An over-cap or unchanged branch is an outcome in
  // the answer, not an error; the forge's and the credential's failures cross the wire typed.
  Rpc.make("openPullRequest", {
    payload: OpenPullRequestPayload,
    success: PullRequestStep,
    error: Schema.Union([SessionError, PrError, CredentialError]),
  }),
  // An operator's discard (LOB-268): one of the terminal events that tear the session's worktree
  // and branch down. A repeat answers `first: false` and the first release's reason.
  Rpc.make("discardSession", {
    payload: SessionIdInput,
    success: ReleaseWorkspaceResult,
    error: SessionError,
  }),
  Rpc.make("watchSession", {
    payload: SessionIdInput,
    success: SessionEvent,
    error: SessionError,
    stream: true,
  }),
).middleware(ControlPlaneAuth) {}

/**
 * The approval surface (docs/design.md D11, LOB-146): request, decide, and the pending list — one
 * session's, or every session's (LOB-53). The lists read the service's pending set; a session's
 * approvals are committed to its log either way.
 */
export class ApprovalsRpc extends RpcGroup.make(
  Rpc.make("requestApproval", {
    payload: RequestApprovalInput,
    success: ApprovalRequest,
    error: SessionError,
  }),
  Rpc.make("decideApproval", {
    payload: DecideApprovalInput,
    success: DecideApprovalOutput,
    error: SessionError,
  }),
  Rpc.make("listApprovals", {
    payload: SessionIdInput,
    success: ListApprovalsOutput,
    error: SessionError,
  }),
  // Every session's pending requests (LOB-53): the operator's inbox, read from the same index.
  Rpc.make("listPendingApprovals", {
    payload: ListPendingApprovalsInput,
    success: ListPendingApprovalsOutput,
    error: SessionError,
  }),
).middleware(ControlPlaneAuth) {}

const TaskErrorSchema = Schema.Union([
  TaskNotFound,
  BoardNotFound,
  DefinitionNotFound,
  BoardExists,
  BoardRepoMismatch,
  StaleRevision,
  StaleBoardVersion,
  CardMigrationRefused,
  UndeclaredTransition,
  HumanGateRequired,
  RequirementUnmet,
  AlreadyBlocked,
  NotBlocked,
  EmptyComment,
  InvalidTaskInput,
  InvalidDefinition,
  TaskStorageError,
]);

export class TasksRpc extends RpcGroup.make(
  // The board itself: the instance and the definition version it binds, which is the read a client
  // needs before it can print lanes in definition order (LOB-61). Cards are a separate call, so a
  // client that only wants the columns does not fold every card to learn them.
  Rpc.make("getBoard", {
    payload: GetBoardInput,
    success: BoardView,
    error: TaskErrorSchema,
  }),
  // Which boards exist, newest first (LOB-75): how the dashboard's `/boards` route offers a board
  // to open. An instance list, not views — the columns are `getBoard`'s answer for the one picked.
  Rpc.make("listBoards", {
    payload: ListBoardsInput,
    success: Schema.Array(BoardInstance),
    error: TaskErrorSchema,
  }),
  // A new board over a named definition, pinned to its newest version unless the caller names one
  // (LOB-208): the instance every card and run on the board reads its columns through (B2).
  Rpc.make("createBoard", {
    payload: CreateBoardInput,
    success: CreatedBoard,
    error: TaskErrorSchema,
  }),
  // Which definitions exist and the versions each holds (LOB-270): what `createBoard` can name.
  Rpc.make("listDefinitions", {
    payload: ListDefinitionsInput,
    success: Schema.Array(DefinitionSummary),
    error: TaskErrorSchema,
  }),
  // One definition version described (LOB-270): each column's exits and human gates, its
  // requirements marked checked or not, and its role's model as this deployment resolves it.
  // An unknown id or version is `DefinitionNotFound`.
  Rpc.make("getDefinition", {
    payload: GetDefinitionInput,
    success: DefinitionConfig,
    error: TaskErrorSchema,
  }),
  // One definition version as the file `defineBoard` takes (F8): the version's own columns with the
  // moves and the initial column a legacy version leaves implicit spelled out, and none of what the
  // server assigns (version, author). `factory board definition show --json` prints it. An unknown id
  // or version is `DefinitionNotFound`.
  Rpc.make("getDefinitionSource", {
    payload: GetDefinitionInput,
    success: DefinitionSource,
    error: TaskErrorSchema,
  }),
  // A new version of a definition, authored (D4): newest + 1, never an edit of a row (B2). Content
  // identical to the newest version writes nothing and answers it; `dryRun` validates only. A
  // version that cannot be used as written — or names a skill the library lacks, or a role the
  // deployment's role table lacks — is `InvalidDefinition`, naming the field, and nothing is written.
  Rpc.make("defineBoard", {
    payload: DefineBoardInput,
    success: DefinedBoard,
    error: TaskErrorSchema,
  }),
  // Move a board to a newer version of its definition (D5), at the version the caller read it at:
  // new cards pin the new version and existing cards keep theirs, unless `migrateCards` maps their
  // columns — then every card is re-pinned with a `repinned` event, or, when one cannot be (an
  // unfinished run, an unmapped column), none is and the pin does not move (`CardMigrationRefused`).
  Rpc.make("upgradeBoard", {
    payload: UpgradeBoardInput,
    success: UpgradedBoard,
    error: TaskErrorSchema,
  }),
  // What an authored version may name besides skills (D6): every requirement key the factory knows
  // and the roles `defineBoard` accepts, so an editor offers only what the server would take.
  Rpc.make("getDefinitionVocabulary", {
    payload: GetDefinitionVocabularyInput,
    success: DefinitionVocabulary,
    error: TaskErrorSchema,
  }),
  // A board's full configuration (LOB-270): `getBoard`'s instance with its pinned version described
  // as `getDefinition` describes it, in one read.
  Rpc.make("getBoardConfig", {
    payload: GetBoardConfigInput,
    success: BoardConfig,
    error: TaskErrorSchema,
  }),
  Rpc.make("createTask", {
    payload: CreateTaskInput,
    success: Task,
    error: TaskErrorSchema,
  }),
  Rpc.make("getTask", {
    payload: GetTaskInput,
    success: Task,
    error: TaskErrorSchema,
  }),
  Rpc.make("listTasks", {
    payload: ListTasksInput,
    success: Schema.Array(Task),
    error: TaskErrorSchema,
  }),
  // A board's cards with what their runs say (C10): the newest run's status, the PR link and the
  // summed spend, in `listTasks`' order, in one read — so a lane never asks per card.
  Rpc.make("listBoardCards", {
    payload: ListTasksInput,
    success: Schema.Array(BoardCard),
    error: TaskErrorSchema,
  }),
  Rpc.make("moveTask", {
    payload: MoveTaskInput,
    success: Task,
    error: TaskErrorSchema,
  }),
  Rpc.make("blockTask", {
    payload: BlockTaskInput,
    success: Task,
    error: TaskErrorSchema,
  }),
  Rpc.make("unblockTask", {
    payload: UnblockTaskInput,
    success: Task,
    error: TaskErrorSchema,
  }),
  // A card's title and priority, revision-checked (C11): one revision, one event per changed field.
  Rpc.make("updateTask", {
    payload: UpdateTaskInput,
    success: Task,
    error: TaskErrorSchema,
  }),
  // The thread on a card (B7, LOB-73): a comment, and — from a person, on a card blocked
  // `needs_input` — the answer that lifts the block. The question half is the run's own `ask` tool,
  // which writes in-process; there is no RPC for a client to ask on a run's behalf.
  Rpc.make("commentTask", {
    payload: CommentTaskInput,
    success: Task,
    error: TaskErrorSchema,
  }),
  Rpc.make("listTaskComments", {
    payload: ListTaskCommentsInput,
    success: Schema.Array(TaskComment),
    error: TaskErrorSchema,
  }),
  // The card's spec (LOB-238): what its newest specifying run declared with the `spec` tool, or
  // `null` when none has. Written in-process by the run, like the ask, so this group only reads it.
  Rpc.make("getTaskSpec", {
    payload: GetTaskSpecInput,
    success: Schema.NullOr(TaskSpec),
    error: TaskErrorSchema,
  }),
  // The card's plan (D10): what its newest planning run declared with the `plan` tool, or `null`
  // when none has. Written in-process by the run, like the spec, so this group only reads it.
  Rpc.make("getTaskPlan", {
    payload: GetTaskPlanInput,
    success: Schema.NullOr(TaskPlan),
    error: TaskErrorSchema,
  }),
  // The work a local agent handed off with the card (S-local-agent-handoff-mcp): the patch its create
  // carried, or `null` for a card made without one. Written only by `createTask`, so this only reads.
  Rpc.make("getTaskHandoff", {
    payload: GetTaskHandoffInput,
    success: Schema.NullOr(TaskHandoff),
    error: TaskErrorSchema,
  }),
  // What the card needs to leave its column (D9): each exit requirement met, unmet with the reason
  // the move's refusal would give, or not checked. Judged by `moveTask`'s own verdicts.
  Rpc.make("getTaskExit", {
    payload: GetTaskExitInput,
    success: TaskExit,
    error: TaskErrorSchema,
  }),
  // A card's runs, newest first (LOB-76): how the card pane keeps a run started from it in reach.
  // Starting one is `createSession` with the card named, so this group only reads them.
  Rpc.make("listTaskRuns", {
    payload: ListTaskRunsInput,
    success: Schema.Array(TaskRun),
    error: TaskErrorSchema,
  }),
  // What needs a person (LOB-77): cards with a pending approval, an unanswered question, or a done
  // run at a human gate, on one board or every board; the every-board read also lists the pending
  // approvals of sessions no card owns (LOB-271). One read over the indexes, so the attention
  // view never walks cards, runs and approvals from the browser.
  Rpc.make("listAttention", {
    payload: ListAttentionInput,
    success: Schema.Array(AttentionItem),
    error: TaskErrorSchema,
  }),
).middleware(ControlPlaneAuth) {}

/**
 * The stored trigger routes (LOB-266): which label or team starts work on which registered repo,
 * read by the trigger seam per delivery, so a change takes effect on the next delivery with no env
 * edit and no restart. `TRIGGER_RULES` stays the fallback when no stored route claims an event, and
 * is not listed here (the boot log names it). Its own group, not `SessionRpc`'s: a route is a trigger
 * fact, not a session's.
 */
export class TriggerRoutesRpc extends RpcGroup.make(
  Rpc.make("addTriggerRoute", {
    payload: AddTriggerRouteInput,
    success: TriggerRoute,
    error: TriggerRouteError,
  }),
  Rpc.make("listTriggerRoutes", {
    payload: ListTriggerRoutesInput,
    success: ListTriggerRoutesOutput,
    error: TriggerRouteError,
  }),
  Rpc.make("removeTriggerRoute", {
    payload: RemoveTriggerRouteInput,
    success: TriggerRoute,
    error: Schema.Union([TriggerRouteError, TriggerRouteNotFound]),
  }),
  // The deliveries the seam recorded (T4), newest first, each with its outcome and the reason
  // verbatim, so "why did my labelled issue start nothing" is a read, not a log search.
  Rpc.make("listTriggerDeliveries", {
    payload: ListTriggerDeliveriesInput,
    success: ListTriggerDeliveriesOutput,
    error: TriggerDeliveryError,
  }),
).middleware(ControlPlaneAuth) {}

/**
 * What the control plane is running (LOB-269): the model backend and what chose it, the default and
 * role models, and the rest of the non-secret configuration the boot resolved. Its own group, not
 * `SessionRpc`'s: the answer is the process's, and reading it touches no session and no database,
 * so it answers while Postgres is down. It cannot fail — every value was resolved before the server
 * bound — and it never carries a credential's value (`@repo/domain/Server`).
 */
export class ServerRpc extends RpcGroup.make(
  Rpc.make("getServerInfo", {
    payload: GetServerInfoInput,
    success: ServerInfo,
  }),
).middleware(ControlPlaneAuth) {}

/**
 * What `factory doctor` asks beyond `getServerInfo` (E8): the checks only the control plane can run
 * (each registered repo's forge credential and base ref, the trigger rules and env files the boot
 * read), and, only when `--live` asks, one minimal request to the default model, which is the one
 * thing here that spends. Neither carries a credential's value. `checkDeployment` answers while
 * Postgres is down, with the registry's read failure as `reposError`.
 */
export class DoctorRpc extends RpcGroup.make(
  Rpc.make("checkDeployment", {
    payload: CheckDeploymentInput,
    success: DeploymentChecks,
  }),
  Rpc.make("pingModel", {
    payload: PingModelInput,
    success: ModelPing,
  }),
).middleware(ControlPlaneAuth) {}

/**
 * The factory's skills (D7): the prompt text a column binds (docs/board.md B6), read and edited
 * without a migration. A put is a new version, never an update, and a run keeps the version its log
 * pinned when it opened (B2), so an edit reaches the next run and no run in flight. Its own group:
 * a skill is the factory's, not a session's or a board's, and a column names it only by name.
 */
export class SkillsRpc extends RpcGroup.make(
  // Every skill at its newest version, with the default definition's columns that bind it.
  Rpc.make("listSkills", {
    payload: ListSkillsInput,
    success: Schema.Array(SkillSummary),
    error: SkillErrorSchema,
  }),
  // One version: the one named, or the newest. An unknown name or version is `SkillNotFound`.
  Rpc.make("getSkill", {
    payload: GetSkillInput,
    success: SkillRecord,
    error: SkillErrorSchema,
  }),
  // Every version of one skill, newest first, without the bodies (D8): the dashboard's history. An
  // unknown name is `SkillNotFound`.
  Rpc.make("listSkillVersions", {
    payload: ListSkillVersionsInput,
    success: Schema.Array(SkillVersionSummary),
    error: SkillErrorSchema,
  }),
  // Version newest + 1 (1 for a new name), attributed to the caller's credential. A blank body is
  // `InvalidSkill`, and nothing is written.
  Rpc.make("putSkill", {
    payload: PutSkillInput,
    success: SkillRecord,
    error: SkillErrorSchema,
  }),
).middleware(ControlPlaneAuth) {}

/**
 * A repository's secrets (S-agent-secrets): write-only. `setSecret` takes a value and answers its
 * summary; nothing in this group — or any other — answers a value back. Its own group: a secret is a
 * repository's, injected by the control plane into the commands its config declares it for.
 */
export class SecretsRpc extends RpcGroup.make(
  // Encrypted and stored, replacing any value the name held. A value under `SECRET_MIN_LENGTH` is
  // `InvalidSecret`, a repo the registry does not hold `RepoNotFound`, and a control plane with no
  // `FACTORY_SECRETS_KEY` `SecretsUnconfigured`; nothing is written for any of them.
  Rpc.make("setSecret", {
    payload: SetSecretInput,
    success: SecretSummary,
    error: SecretErrorSchema,
  }),
  // Every secret's summary, or one repo's, ordered by repo and name. Never a value.
  Rpc.make("listSecrets", {
    payload: ListSecretsInput,
    success: Schema.Array(SecretSummary),
    error: SecretErrorSchema,
  }),
  // Removed for good: no later command gets it. A name the repo does not hold is `SecretNotFound`.
  Rpc.make("deleteSecret", {
    payload: DeleteSecretInput,
    success: SecretSummary,
    error: SecretErrorSchema,
  }),
).middleware(ControlPlaneAuth) {}

/**
 * Notification settings (F21): the per-kind toggles and a person's own sinks. Its own group: it is
 * the dashboard's settings page, and what it stores the notifier reads on every pass, so a change
 * needs no restart.
 */
export class NotificationsRpc extends RpcGroup.make(
  // The effective toggles, the caller's sinks and what this control plane can send.
  Rpc.make("getNotificationSettings", {
    payload: GetNotificationSettingsInput,
    success: NotificationSettings,
    error: NotificationErrorSchema,
  }),
  // A kind switched on or off for the whole deployment; answers the settings as they now stand.
  Rpc.make("setNotificationKind", {
    payload: SetNotificationKindInput,
    success: NotificationSettings,
    error: NotificationErrorSchema,
  }),
  // The caller's own sink. A malformed address or subscription is `InvalidNotificationSink`, a type
  // this control plane cannot send `NotificationChannelUnavailable`; nothing is written for either.
  Rpc.make("addNotificationSink", {
    payload: AddNotificationSinkInput,
    success: NotificationSinkSummary,
    error: NotificationErrorSchema,
  }),
  // Pause or resume one of the caller's sinks without losing it.
  Rpc.make("setNotificationSinkEnabled", {
    payload: SetNotificationSinkEnabledInput,
    success: NotificationSinkSummary,
    error: NotificationErrorSchema,
  }),
  // Removed for good. A sink that is not the caller's is `NotificationSinkNotFound`.
  Rpc.make("removeNotificationSink", {
    payload: NotificationSinkRefInput,
    success: NotificationSinkSummary,
    error: NotificationErrorSchema,
  }),
).middleware(ControlPlaneAuth) {}

// Every group carries `ControlPlaneAuth` (LOB-20), so every member — `watchSession`'s stream too —
// is refused as `Unauthenticated` without a credential the server knows, and a handler that records
// an actor reads it from the `Caller` the middleware provides, not from the body.
// NOTE: The sandbox and sandbox-status groups merge in here next; each carries the middleware too.
export const RpcApi = SessionRpc.merge(ApprovalsRpc)
  .merge(TasksRpc)
  .merge(TriggerRoutesRpc)
  .merge(ServerRpc)
  .merge(DoctorRpc)
  .merge(SkillsRpc)
  .merge(SecretsRpc)
  .merge(NotificationsRpc);
