import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
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
  BoardConfig,
  BoardInstance,
  BoardExists,
  BoardNotFound,
  BoardRepoMismatch,
  BoardView,
  CommentTaskInput,
  CreateBoardInput,
  CreateTaskInput,
  DefinitionConfig,
  DefinitionNotFound,
  DefinitionSummary,
  EmptyComment,
  GetBoardConfigInput,
  GetBoardInput,
  GetDefinitionInput,
  GetTaskInput,
  GetTaskSpecInput,
  HumanGateRequired,
  ListAttentionInput,
  ListBoardsInput,
  ListDefinitionsInput,
  ListTaskCommentsInput,
  ListTaskRunsInput,
  ListTasksInput,
  MoveTaskInput,
  NotBlocked,
  RequirementUnmet,
  StaleRevision,
  Task,
  TaskComment,
  TaskNotFound,
  TaskRun,
  TaskSpec,
  TaskStorageError,
  UndeclaredTransition,
  UnblockTaskInput,
} from "@repo/domain/Task";
import {
  CurateSessionInput,
  CurateSessionResult,
  ListPagesInput,
  ListPagesOutput,
} from "@repo/domain/Page";
import { StartMissionInput, StartMissionResult } from "@repo/domain/Mission";
import {
  ProposalsRefused,
  ProposeDecompositionInput,
  ProposeDecompositionResult,
} from "@repo/domain/Decomposition";
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
  ListReposInput,
  ListReposOutput,
  ListSessionsInput,
  ListSessionsOutput,
  ListSpendInput,
  RegisterRepoInput,
  ReleaseWorkspaceResult,
  ReplaySessionInput,
  RepoNotFound,
  RepoSummary,
  ResetSessionInput,
  SendMessageInput,
  SendMessageResult,
  SessionError,
  SessionEvent,
  SessionIdInput,
  SessionSnapshot,
  SessionSummary,
  SpendReport,
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
  Rpc.make("interruptSession", {
    payload: SessionIdInput,
    success: SessionSummary,
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
  Rpc.make("registerRepo", {
    payload: RegisterRepoInput,
    success: RepoSummary,
    error: SessionError,
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
) {}

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
) {}

const TaskErrorSchema = Schema.Union([
  TaskNotFound,
  BoardNotFound,
  DefinitionNotFound,
  BoardExists,
  BoardRepoMismatch,
  StaleRevision,
  UndeclaredTransition,
  HumanGateRequired,
  RequirementUnmet,
  AlreadyBlocked,
  NotBlocked,
  EmptyComment,
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
    success: BoardInstance,
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
) {}

// NOTE: The sandbox and sandbox-status groups merge in here next.
export const RpcApi = SessionRpc.merge(ApprovalsRpc).merge(TasksRpc);
