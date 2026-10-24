import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import {
  ApprovalDecision,
  DecideApprovalInput,
  ListApprovalsOutput,
  RequestApprovalInput,
  ApprovalRequest,
} from "@repo/domain/Approval";
import {
  AlreadyBlocked,
  BlockTaskInput,
  BoardNotFound,
  CreateTaskInput,
  GetTaskInput,
  HumanGateRequired,
  ListTasksInput,
  MoveTaskInput,
  NotBlocked,
  StaleRevision,
  Task,
  TaskNotFound,
  TaskStorageError,
  UndeclaredTransition,
  UnblockTaskInput,
} from "@repo/domain/Task";
import {
  CreateSessionInput,
  ForkSessionInput,
  ListSessionsInput,
  ListSessionsOutput,
  RegisterRepoInput,
  RepoSummary,
  SendMessageInput,
  SendMessageResult,
  SessionError,
  SessionEvent,
  SessionIdInput,
  SessionSnapshot,
  SessionSummary,
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
  Rpc.make("listSessions", {
    payload: ListSessionsInput,
    success: ListSessionsOutput,
    error: SessionError,
  }),
  Rpc.make("registerRepo", {
    payload: RegisterRepoInput,
    success: RepoSummary,
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
 * The approval surface (docs/design.md D11, LOB-146): request, decide, and the pending list. The
 * list reads the service's pending set; a session's approvals are committed to its log either way.
 */
export class ApprovalsRpc extends RpcGroup.make(
  Rpc.make("requestApproval", {
    payload: RequestApprovalInput,
    success: ApprovalRequest,
    error: SessionError,
  }),
  Rpc.make("decideApproval", {
    payload: DecideApprovalInput,
    success: ApprovalDecision,
    error: SessionError,
  }),
  Rpc.make("listApprovals", {
    payload: SessionIdInput,
    success: ListApprovalsOutput,
    error: SessionError,
  }),
) {}

const TaskErrorSchema = Schema.Union([
  TaskNotFound,
  BoardNotFound,
  StaleRevision,
  UndeclaredTransition,
  HumanGateRequired,
  AlreadyBlocked,
  NotBlocked,
  TaskStorageError,
]);

export class TasksRpc extends RpcGroup.make(
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
) {}

// NOTE: The sandbox and sandbox-status groups merge in here next.
export const RpcApi = SessionRpc.merge(ApprovalsRpc).merge(TasksRpc);
