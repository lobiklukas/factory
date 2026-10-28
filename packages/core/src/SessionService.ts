/* oxlint-disable effecttsgo(prefer-schema-over-json), effecttsgo(node-builtin-import) */
/**
 * Sessions: create, drive, read, and watch one Pi Durable log (docs/design.md D7, D8, D12).
 *
 * The log is truth; everything here is a write to it or a read of it. Three things sit outside it,
 * all deliberately droppable and all rebuildable from it by `rebuildIndexes` (`./rebuild.ts`):
 *
 * - The `sessions` row: an index of what exists, what it is called, which repo it works on, when
 *   it was created, and the PR it opened. The title is also committed into the log
 *   (`factory.title`), the repo binding as a document (`factory.session`), and the PR as
 *   `factory.pr`, so the index can be rebuilt.
 * - The `session_activity` row: status, spend, and last activity, written as this process observes
 *   the session's committed changes, so `listSessions` never folds a log (R6).
 * - The `repos` row: where a repo is cloned from and which ref sessions start at.
 *
 * The owner registry — *this process* holding the log open — is the one thing that is not durable
 * and cannot be rebuilt. Pi Durable allows one owner per log, so ownership is per process, and a
 * session nobody here owns is served by folding the log (D8's historical read). Locally this
 * process is also the sandbox (D3); when the harness moves into a sandbox, this registry is the
 * seam that changes and `SessionBus` is how streams keep working.
 */
import {
  Cause,
  Clock,
  Context,
  DateTime,
  Duration,
  Effect,
  Exit,
  FiberMap,
  FileSystem,
  HashMap,
  Layer,
  Option,
  Path,
  Ref,
  Schedule,
  Schema,
  Semaphore,
  Stream,
} from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import type { HttpClient } from "effect/http";
import type {
  ApprovalDecision,
  ApprovalRequest,
  DecideApprovalInput,
  DecideApprovalOutput,
  ListApprovalsOutput,
  ListPendingApprovalsInput,
  ListPendingApprovalsOutput,
  RequestApprovalInput,
} from "@repo/domain/Approval";
import type {
  CompactSessionInput,
  CompactSessionResult,
  CreateSessionInput,
  ForkSessionInput,
  GetRepoInput,
  ListReposOutput,
  ListSessionsInput,
  ListSessionsOutput,
  ReadSessionHistoryInput,
  RegisterRepoInput,
  ReleaseWorkspaceResult,
  ReplayComparison,
  ReplaySessionInput,
  RepoSummary,
  ResetSessionInput,
  SendMessageInput,
  SendMessageResult,
  SessionError,
  SessionEvent,
  SessionHistoryPage,
  SessionId,
  SessionListEntry,
  SessionMode,
  SessionSnapshot,
  SessionStatus,
  SessionSummary,
  SessionTask,
  SessionUsage,
  SessionWorkspace,
  SpendReport,
  SpendRow,
  SyncRepoInput,
  WithdrawMessageInput,
  WithdrawMessageResult,
  WorkspaceRelease,
  WorkspaceReleaseReason,
} from "@repo/domain/Session";
import {
  RepoCloneFailed,
  RepoNotFound,
  RepoSlug,
  SessionActor,
  SessionError as SessionErrorClass,
  SessionId as SessionIdSchema,
  WorkspaceRelease as WorkspaceReleaseSchema,
} from "@repo/domain/Session";
import type {
  MissionWorker,
  StartMissionInput,
  StartMissionResult,
} from "@repo/domain/Mission";
import type { OpenPullRequestPayload } from "@repo/domain/PullRequest";
import type {
  AskOptions,
  Conversation,
  Harness,
  ModelAccess,
  OpenSession,
  RoleModels,
  RunColumn,
  ReviewOptions,
  RunProfile,
  SessionRef,
  SpecOptions,
  ThreadReader,
} from "@repo/harness";
import {
  EMPTY_RUN_PROFILE,
  isMissionTask,
  loadRun,
  MISSION_TASKS,
  missionInFlight,
  NO_ROLE_MODELS,
  Policy,
  PolicyLive,
  resolveRole,
  // `startMission` is the harness's: it creates the task and commits the documents. The service
  // method below resolves the workspace and the owner first, so the two names mark which layer
  // owns which half.
  startMission as beginMission,
  type AutonomyConfig,
  type ApprovalAnswer,
  type ApprovalAsker,
  type SessionPolicy,
  type VerifyOptions,
} from "@repo/harness";
import {
  closeHarness,
  clampCurationPages,
  compactSession,
  curationProposals,
  DECOMPOSITION_SKILL,
  decompositionInputFault,
  decompositionProposals,
  forkSession,
  modelAccessFor,
  modelKey,
  interrupt as interruptConversation,
  isBusy,
  liveSessionEvents,
  openSession,
  readHistoricalSnapshot,
  readLiveSnapshot,
  readPinnedModelKey,
  readRecordedReview,
  readTranscriptPage,
  readVerifyRecords,
  readCurationUsage,
  compareReplay,
  mirrorComparison,
  readPromptSubmission,
  readReplayDocument,
  readReplayRun,
  readReplaySource,
  readSpec,
  replaySession,
  waitForPrompt,
  writeReplayComparison,
  requestCuration,
  requestDecomposition,
  resetSession,
  snapshotEvent,
  submissionStanding,
  submitMessage,
  usageCostTotal,
  withdrawMessage,
  writeApprovalDecided,
  writeApprovalRequested,
  writeApprovalUsed,
  writeActor,
  writeBudget,
  writeCurationUsage,
  readProposedIssues,
  recordCreatedIssue,
  writeProposedIssues,
  writeRepoBinding,
  writeReviewTarget,
  writeTaskBinding,
  writePage,
  writeTitle,
} from "@repo/harness";
import type { BindableSandboxRuntimeShape } from "@repo/sandbox";
import { PostgresStorage } from "@repo/storage-postgres";
import type { CredentialError, CredentialProvider } from "./credentials";
import { NO_REVIEWER_IDENTITY, type ReviewPoster } from "./GitHubReview";
import { BoardColumn, type ResolvedModel } from "@repo/domain/Task";
import { TaskService, TaskServiceLive } from "./TaskService";
import type {
  CurateSessionInput,
  CurateSessionResult,
  ListPagesInput,
  ListPagesOutput,
  Page,
  RecordPageInput,
} from "@repo/domain/Page";
import { PageStrings } from "@repo/domain/Page";
import {
  ApproveProposalsError,
  type ApproveProposalsInput,
  type ApproveProposalsResult,
  type ProposalsRefused,
  type ProposeDecompositionInput,
  type ProposeDecompositionResult,
} from "@repo/domain/Decomposition";
import { isSafeBranchName } from "./git";
import type { RepoMirror } from "./RepoMirror";
import { mintSessionId } from "./ids";
import type { DiffCap, PrError, PullRequestStep } from "./pr";
import { DEFAULT_DIFF_CAP } from "./pr";
import { openPullRequest } from "./prStep";
import {
  SESSION_WRITE_BACK_BUDGET,
  SessionWriteBack,
} from "./SessionWriteBack";
import { ProposalTracker, proposalIssueBody } from "./ProposalTracker";
import { SkillService, SkillServiceLive } from "./SkillService";
import { inspectCheckout, workTreeRoot } from "./repos";
import {
  removeWorkspace,
  resolveWorkspace,
  sessionDirectory,
  type WorkspaceInput,
} from "./workspace";

/** Longest title we derive from a first message, in characters. */
const TITLE_MAX = 80;

/** Longest message a session accepts, in characters. Beyond this the call is refused, not truncated. */
export const MAX_MESSAGE_CHARS = 100_000;

/** How often idle owners are swept, when sweeping is at all. */
const DEFAULT_SWEEP_INTERVAL_MS = 60_000;

/** Page size for `listSessions` when the caller does not choose one. */
const DEFAULT_PAGE_SIZE = 25;
/** Largest page `listSessions` will serve, however large a limit the caller asks for. Exported for
 * the list tests: the cap is part of the service's contract, so a case that straddles it has to
 * read the real value rather than a copy. */
export const MAX_PAGE_SIZE = 100;

/**
 * The follow-up a decision hands its session when the caller asks to `resume` it (LOB-53): what the
 * agent reads on the turn that wakes it. A gated call asked once and parked the run; this is how the
 * run learns the answer without a person typing it. Approved, it names the call to run again; denied,
 * it says not to — the gate refuses the call either way, so the sentence only saves a wasted turn.
 */
export const approvalResumeMessage = (
  request: Pick<ApprovalRequest, "action" | "requestId">,
  decision: Pick<ApprovalDecision, "decision" | "actor">,
): string =>
  decision.decision === "approved"
    ? `Approved: \`${request.action}\` (request ${request.requestId}) was approved by ${decision.actor}. Run it now; the approval covers one run of that call.`
    : `Denied: \`${request.action}\` (request ${request.requestId}) was denied by ${decision.actor}. Do not run it again. Carry on without it, or end your turn and say what is blocked.`;

/**
 * The request id a decision's follow-up is sent under: one decision resumes its session once, however
 * often the decision is repeated (`send` deduplicates on it).
 */
export const approvalResumeRequestId = (requestId: string): string =>
  `approval-resume:${requestId}`;

export type SessionServiceShape = {
  readonly create: (
    input?: CreateSessionInput,
  ) => Effect.Effect<SessionSummary, SessionError>;
  readonly get: (
    sessionId: SessionId,
  ) => Effect.Effect<SessionSnapshot, SessionError>;
  /**
   * The page of a session's transcript before an entry (LOB-243): what a client reads when a
   * historical snapshot's `earlier` says there is more. Read from the log, owned or not.
   */
  readonly history: (
    input: ReadSessionHistoryInput,
  ) => Effect.Effect<SessionHistoryPage, SessionError>;
  readonly send: (
    input: SendMessageInput,
  ) => Effect.Effect<SendMessageResult, SessionError>;
  readonly interrupt: (
    sessionId: SessionId,
  ) => Effect.Effect<SessionSummary, SessionError>;
  /**
   * Withdraw a queued message before a run places it (LOB-166). The answer says what happened: a
   * message a run already took, or one already over, is an outcome rather than a failure.
   */
  readonly withdraw: (
    input: WithdrawMessageInput,
  ) => Effect.Effect<WithdrawMessageResult, SessionError>;
  /**
   * Fork a session at one of its entries: a new session whose transcript is the parent's prefix
   * (LOB-180). The fork's log is its own, so neither transcript can reach the other.
   */
  readonly fork: (
    input: ForkSessionInput,
  ) => Effect.Effect<SessionSummary, SessionError>;
  /**
   * Replay a session against another model (LOB-198): the same task in a new session, on the model
   * the caller names, at the source's repo and base ref. The source log is only ever read.
   */
  readonly replay: (
    input: ReplaySessionInput,
  ) => Effect.Effect<SessionSummary, SessionError>;
  /**
   * Start a new model context, opened with the handoff note (LOB-181). The transcript keeps the
   * past; the reset entry marks where the old context ended.
   */
  readonly reset: (
    input: ResetSessionInput,
  ) => Effect.Effect<SessionSummary, SessionError>;
  /**
   * Compact the model context on demand (B4): admit the compaction task and answer its id. The
   * summary lands in the transcript as a `compaction` entry when the task settles.
   */
  readonly compact: (
    input: CompactSessionInput,
  ) => Effect.Effect<CompactSessionResult, SessionError>;
  /**
   * Start a mission: one feature taken through plan, implement and verify as one durable task
   * (LOB-230). The answer is the mission's id; the phase it reaches is read off `get`'s snapshot.
   */
  readonly startMission: (
    input: StartMissionInput,
  ) => Effect.Effect<StartMissionResult, SessionError>;
  /** What exists, newest activity first, from the activity index — never a fold (R6). */
  readonly list: (
    input: ListSessionsInput,
  ) => Effect.Effect<ListSessionsOutput, SessionError>;
  /**
   * Spend keyed by repo and actor (LOB-162): the list's `costTotal` summed per (repo, actor) pair,
   * from the same index, in one grouped read — never a fold (R6).
   */
  readonly spend: Effect.Effect<SpendReport, SessionError>;
  /**
   * Register or update a repo a session can bind to (docs/features.md §3 A1). A `localPath` that is
   * not absolute or not inside a git work tree is `invalid_input` naming it, and nothing is written
   * (LOB-253); so is a `url` with a credential in it, which the registry would otherwise store.
   *
   * A repo left with a `url` and no `localPath` is cloned into the factory's cache before the call
   * answers (LOB-265), when the deployment has one (`SessionServiceOptions.repoMirror`). A clone that
   * fails is `RepoCloneFailed`, naming the repo and the reason; the row stays registered, so
   * `syncRepo` can try again.
   */
  readonly registerRepo: (
    input: RegisterRepoInput,
  ) => Effect.Effect<RepoSummary, SessionError | RepoCloneFailed>;
  /**
   * Clone or fetch a registered repo into the factory's cache now, instead of at its next session
   * (LOB-265). `RepoNotFound` for a slug the registry has no row for, `RepoCloneFailed` for a clone
   * that fails; a repo with a local checkout, or with no URL, has nothing to sync and is answered as
   * it is.
   */
  readonly syncRepo: (
    input: SyncRepoInput,
  ) => Effect.Effect<
    RepoSummary,
    SessionError | RepoNotFound | RepoCloneFailed
  >;
  /** Every registered repo, by slug, each with what its checkout says about itself (LOB-253). */
  readonly listRepos: Effect.Effect<ListReposOutput, SessionError>;
  /** One registered repo, or `RepoNotFound` for a slug the registry has no row for (LOB-253). */
  readonly getRepo: (
    input: GetRepoInput,
  ) => Effect.Effect<RepoSummary, SessionError | RepoNotFound>;
  /** A session's events: live while this process owns it, a single historical snapshot otherwise. */
  readonly events: (
    sessionId: SessionId,
  ) => Stream.Stream<SessionEvent, SessionError>;
  /**
   * Ask a person before a gated action runs. Idempotent on `requestId`: a repeat returns the
   * request already on file, with no second pending row and no second log entry.
   */
  readonly requestApproval: (
    input: RequestApprovalInput,
  ) => Effect.Effect<ApprovalRequest, SessionError>;
  /**
   * Settle a pending request. Repeating the same decision and actor returns it unchanged. With
   * `resume`, the session is then handed the decision; a failed hand-off is `resumeFailed` on the
   * answer, not a failure, because the decision is already on file (LOB-53).
   */
  readonly decideApproval: (
    input: DecideApprovalInput,
  ) => Effect.Effect<DecideApprovalOutput, SessionError>;
  /** The requests of one session still waiting for a decision, oldest first. */
  readonly listApprovals: (
    sessionId: SessionId,
  ) => Effect.Effect<ListApprovalsOutput, SessionError>;
  /**
   * Every session's requests still waiting for a decision, newest first, one page, with how many
   * are pending in all (LOB-53).
   */
  readonly listPendingApprovals: (
    input: ListPendingApprovalsInput,
  ) => Effect.Effect<ListPendingApprovalsOutput, SessionError>;
  /**
   * Record (or replace) one cited knowledge page (LOB-204).
   *
   * A page is committed to the log — the `factory.page` document a reader asks for by name, and the
   * entry a fold and a rebuild can see — and its row is written in the same effect so `listPages`
   * needs no fold. There is no RPC member for this yet: part 2's curator is its caller.
   */
  readonly recordPage: (
    input: RecordPageInput,
  ) => Effect.Effect<Page, SessionError>;
  /** The pages one session's log holds, by name, read from the derived rows a rebuild refills. */
  readonly listPages: (
    input: ListPagesInput,
  ) => Effect.Effect<ListPagesOutput, SessionError>;
  /**
   * One bounded curator pass over a finished session (LOB-206, part 3 of LOB-47).
   *
   * One model call reads the session's transcript and the pages it already holds and proposes page
   * writes; at most `maxPages` of them are committed, and none of them when the session taught
   * nothing new. The call's spend lands in the curated session's own ledger, because there is no
   * curator session to carry it — the pass is a call, not a run.
   */
  readonly curate: (
    input: CurateSessionInput,
  ) => Effect.Effect<CurateSessionResult, SessionError>;
  /**
   * Decompose the session's spec into proposed child issues (LOB-201, part 1 of LOB-43).
   *
   * One model call — the `decompose` skill over the session's `factory.spec` — whose answer is
   * committed as the session's `factory.proposedIssues` document when the proposal validator accepts
   * it, and refused as `ProposalsRefused`, storing nothing, when it does not. It creates no tracker
   * issue and opens no session: the log is what it writes. The call's spend is charged to the
   * session's own ledger, as a curation's is.
   *
   * The answer is reconciled into the proposals the session already holds, by title (LOB-203): the
   * same spec twice is the same proposals with the same recorded tracker ids, and the result's
   * `diff` names what a changed spec added, updated and removed (removed ones are kept, marked).
   */
  readonly proposeDecomposition: (
    input: ProposeDecompositionInput,
  ) => Effect.Effect<
    ProposeDecompositionResult,
    SessionError | ProposalsRefused
  >;
  /**
   * Create the approved proposals as tracker issues (LOB-202, part 2 of LOB-43).
   *
   * `approved` are indices into the session's `factory.proposedIssues`. Each approved proposal not
   * yet created becomes one child of the issue the session was delegated from, and its id is written
   * back to the document as soon as the tracker answers — before the next request — so a failure
   * halfway leaves a document a retry can finish rather than repeat. Then each `blockedBy` edge
   * whose two ends both exist becomes a relation; an edge to a proposal nobody has approved yet
   * waits for it. Unapproved proposals get nothing. It writes no card and no `task_links` row.
   *
   * With no tracker configured, or for a session no tracker issue opened, it refuses as
   * `ApproveProposalsError` before any request is made and leaves the document unchanged.
   */
  readonly approveProposals: (
    input: ApproveProposalsInput,
  ) => Effect.Effect<
    ApproveProposalsResult,
    SessionError | ApproveProposalsError
  >;
  /**
   * Open the session's PR, or return the one its log already records (LOB-177).
   *
   * The answer carries which path produced it (LOB-212): `opened` for the GitHub call, `already-open`
   * for a retry that the log answered. Additive on the shape — the link is unchanged.
   *
   * A diff over the configured cap answers `over-cap` instead (LOB-227): no PR is opened, nothing is
   * committed, and the answer names which limit refused the branch and both numbers. The cap applies
   * to the branch the step would publish, so a retry of an already-recorded PR is never re-measured.
   *
   * The forge client and the credential are the *caller's* to provide rather than this layer's:
   * the control plane's own HTTP layer is not a dependency of every session operation, and a
   * deployment that never opens a PR should not have to wire one. So the requirements appear on
   * this method rather than on the service.
   */
  readonly openPullRequest: (
    input: OpenPullRequestArgs,
  ) => Effect.Effect<
    PullRequestStep,
    SessionError | PrError | CredentialError,
    CredentialProvider | HttpClient.HttpClient
  >;
  /**
   * Tear the session's worktree and branch down, on a terminal event (LOB-268): its card reached
   * `done` or `canceled`, its PR merged, or an operator discarded it. Nothing else removes them —
   * the idle sweep and `close` release the harness and the log handle and leave the work for the
   * next run.
   *
   * A run in flight is interrupted and the owner released first, so nothing is writing into the
   * directory while it goes. The release is recorded on the session before the filesystem is
   * touched, and from then on no owner acquisition cuts the worktree again and `send`, `reset` and
   * `startMission` are refused — both decided from the release read under the owners' gate, so a
   * caller that read the session just before the release is refused too. A read never cuts a
   * worktree. Idempotent: a repeat answers `first: false` with the first call's reason, and still
   * finishes a teardown a crash cut short.
   */
  readonly releaseWorkspace: (input: {
    readonly sessionId: SessionId;
    readonly reason: WorkspaceReleaseReason;
  }) => Effect.Effect<ReleaseWorkspaceResult, SessionError>;
  /**
   * The model a run whose column declares `role` talks to (B6, LOB-207; read by LOB-270's
   * `getDefinition`): the role's row in this layer's `roleModels`, or the deployment's model for a
   * role with no row and for no role. The same table `openSession` resolves a run's model from, so
   * what a reader is told is what a run gets. Deployment configuration: read here, never written.
   */
  readonly roleModel: (role: string | undefined) => ResolvedModel;
  /**
   * Reopen every session that had a mission in flight when the last process stopped, and schedule
   * its log again (LOB-231): the boot's half of "a mission resumes in the phase it died in".
   *
   * Pi Durable keeps an interrupted mission `pending` in its log and runs it again once that log's
   * harness is resumed, but nothing else reopens a log until a client sends the session something,
   * and a mission's progress waits on no client. The sessions are the ones whose row says a mission
   * is in flight (`sessions.mission_in_flight`, kept by the owner's activity projection) under this
   * process's session root — a process with another root is another instance and leaves them be; a
   * session whose workspace was released is left alone, as `startMission` would refuse it, and its
   * mark cleared. A reopened log with no live mission after all — the row outlived the mission by a
   * crash — is cleared and left to the idle sweep, with nothing in it scheduled. Answers the sessions
   * it resumed; one that fails to reopen is logged, keeps its mark for the next boot, and does not
   * stop the others.
   */
  readonly resumeMissions: Effect.Effect<readonly SessionId[], SessionError>;
  /**
   * Close every harness this process owns: the idle sweep's release, for every owner at once, on
   * shutdown. The worktrees and branches stay (LOB-268), so a restarted process resumes on them.
   */
  readonly close: Effect.Effect<void>;
};

/**
 * What `openPullRequest` takes: the wire payload (`OpenPullRequestPayload` — the session and the
 * title), plus the two branches an in-process caller may name. The RPC handler never passes them,
 * so a client always gets the session's own branch onto the base it was cut from (LOB-213); a test
 * or a drive that needs another head (two sessions measuring one branch) names it here. Either way
 * both are checked with `isSafeBranchName` before they reach git, so a name that would read as an
 * option is a `SessionError{invalid_input}`, not an argument.
 */
export type OpenPullRequestArgs = OpenPullRequestPayload & {
  /** The branch the PR publishes. Default: the session's own (`factory/<id>`, or its named one). */
  readonly head?: string;
  /** The ref it targets. Default: the base the session was cut from. */
  readonly base?: string;
};

export class SessionService extends Context.Service<
  SessionService,
  SessionServiceShape
>()("@repo/core/SessionService") {}

export type SessionServiceOptions = {
  /** The deployment's model: what every session talks to unless its run's role has its own. */
  readonly model: ModelAccess;
  /**
   * The deployment's role → model table (B6, LOB-207): a run whose column declares a role with a
   * row here talks to that row's model. Resolved against `model`'s catalog by whoever builds the
   * layer (`@repo/harness`'s `resolveRoleModels`), so a row naming a model the process cannot serve
   * fails the boot rather than a run. Absent: every run talks to `model`.
   */
  readonly roleModels?: RoleModels;
  /** Where a session's working directory is created, one directory per session. */
  readonly sessionRoot: string;
  /**
   * The factory's own clone of each repo registered with only a URL (LOB-265): fetched into when a
   * session's worktree is cut and when the repo is registered, and what the worktree is cut from.
   * Absent: such a repo opens its sessions in an empty directory with a warning, as before.
   */
  readonly repoMirror?: RepoMirror;
  /**
   * The runtime every session's commands run through (LOB-244), in a sandbox bound to its working
   * directory: the deployment's, selected by its configuration. Absent: each session's own
   * in-process runtime, which runs them on the host (`@repo/harness`'s `openSessionEnvironment`).
   */
  readonly sandbox?: BindableSandboxRuntimeShape;
  /**
   * Close an owner that has been idle this long, releasing its fold. `undefined` keeps every owner
   * open, which is what a test wants and what a long-lived server does not.
   */
  readonly idleTimeoutMs?: number;
  readonly sweepIntervalMs?: number;
  /**
   * What a session may do unattended (D11, `@repo/harness`'s `Policy`). Absent: D11's defaults, so
   * an unpoliced session is not reachable by omitting an argument.
   */
  readonly autonomy?: AutonomyConfig;
  /**
   * How large a session's diff may be before the PR step opens nothing (LOB-227). Absent:
   * `DEFAULT_DIFF_CAP`, so a deployment that never configures this still has a bound.
   */
  readonly prCap?: DiffCap;
  /**
   * How long the PR step waits for its write-back before it answers anyway (LOB-15). Absent:
   * `SESSION_WRITE_BACK_BUDGET`. A test shortens it.
   */
  readonly writeBackBudget?: Duration.Input;
  /**
   * The spend ceiling a session gets when its create names none (LOB-163), in US dollars — and a
   * fork or a replay of an uncapped session too (a capped one's keeps its source's cap). Absent: a
   * session is capped only when its create asks for one or its source had one.
   */
  readonly defaultBudget?: number;
  /**
   * How a reviewer run's comment reaches its pull request (LOB-36, `./GitHubReview`), under the
   * reviewer's own identity. Absent: a reviewer still reviews and its verdict is committed to its log,
   * but nothing is posted — the post fails naming the missing identity, never falling back to the
   * worker's.
   */
  readonly reviewPoster?: ReviewPoster;
};

/**
 * Whether a clone URL carries a credential: a password anywhere, or a username on http(s), where it
 * is the token's place (`https://<token>@host/...`). `ssh://git@host/...` is the ordinary form of an
 * ssh URL — its username is the login, not a secret — and is registered as given.
 */
const urlCarriesCredential = (url: string): boolean => {
  try {
    const parsed = new URL(url);
    if (parsed.password.length > 0) return true;
    return (
      parsed.username.length > 0 &&
      (parsed.protocol === "https:" || parsed.protocol === "http:")
    );
  } catch {
    return false;
  }
};

/** A full commit id: a review run's base is the PR's head, which no `refs/heads/<sha>` names. */
const isCommitId = (ref: string): boolean =>
  /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(ref);

/** A clone failure as the session error a create or send reports, naming the reason (LOB-265). */
const cloneFailure = (error: RepoCloneFailed): SessionError =>
  new SessionErrorClass({
    code: "repo_clone_failed",
    message: `${error.message} (${error.reason})`,
  });

type SessionRow = {
  readonly id: string;
  readonly title: string;
  readonly repo: string | null;
  readonly baseRef: string | null;
  /** The branch the worktree is cut on, when a caller named one (LOB-197). */
  readonly branch: string | null;
  /** The PR the session opened, whose log is the truth and this row the list's answer (LOB-177). */
  readonly prUrl: string | null;
  /** The session this one was forked from, from the index row (LOB-180). */
  readonly forkedFrom: string | null;
  /** Who the session's spend is attributed to, when anyone was (LOB-162). */
  readonly actor: string | null;
  readonly createdAt: string;
  /** When the worktree and branch were torn down, and on which terminal event (LOB-268). */
  readonly workspaceReleasedAt: string | null;
  readonly workspaceReleaseReason: string | null;
  /**
   * The model the session is pinned to, `provider/modelId` (LOB-269): written when its owner opens,
   * refolded by `rebuildIndexes`. `NULL` before the first open, or on a row older than the column.
   */
  readonly model: string | null;
};
type RepoRow = {
  readonly slug: string;
  readonly url: string;
  readonly defaultBaseRef: string;
  readonly localPath: string | null;
  readonly registeredAt: string;
};

type ListRow = {
  readonly id: string;
  readonly title: string;
  readonly repo: string | null;
  readonly baseRef: string | null;
  /** The session this row was forked from, from the index row (LOB-182). */
  readonly forkedFrom: string | null;
  /** The model the session is pinned to, from the index row (LOB-269). */
  readonly model: string | null;
  readonly prUrl: string | null;
  readonly status: string;
  readonly createdAt: string;
  readonly lastActivityAt: string;
  /**
   * The same instant as `lastActivityAt` at full microsecond precision. The keyset cursor is built
   * from this, not from `lastActivityAt`: the display value is truncated to milliseconds, and a
   * cursor cast back from it is then strictly *less* than the stored `timestamptz`, so every
   * remaining row in a same-millisecond group fails `(last_activity_at, id) < (cursor.at, cursor.id)`
   * and the page ends early.
   */
  readonly lastActivityExact: string;
  readonly costTotal: number;
};

/** One (repo, actor) group of the spend read (LOB-162). */
type SpendGroupRow = {
  readonly repo: string | null;
  readonly actor: string | null;
  readonly sessions: number;
  readonly costTotal: number;
};

/** A repo binding as `createSession` asked for it, resolved against the registry. */
type Binding = {
  readonly repo?: RepoSlug;
  readonly baseRef?: string;
  /** A caller-named branch (LOB-197); absent means `factory/<session-id>`. */
  readonly branch?: string;
  readonly localPath?: string;
};

/**
 * One approval as the index knows it: the request, and the decision that settled it. The log holds
 * the same two facts (`factory.approval.requested` / `factory.approval.decided`); the row is the
 * fold of those entries, so the pending list answers without folding a log (LOB-147).
 */
type ApprovalRecord = {
  readonly request: ApprovalRequest;
  readonly decision?: ApprovalDecision;
  /** Whether a gated call already ran on this approval (LOB-52): an approval covers one run. */
  readonly used: boolean;
};

type ApprovalRow = {
  readonly requestId: string;
  readonly action: string;
  readonly detail: string;
  readonly requestedAt: string;
  readonly decision: string | null;
  readonly actor: string | null;
  readonly decidedAt: string | null;
  readonly usedAt: string | null;
};

/** One `session_pages` row as the driver returns it; the two jsonb columns are selected as text. */
type PageRow = {
  readonly name: string;
  readonly kind: string;
  readonly content: string;
  readonly links: string;
  readonly sources: string;
};

type LiveOwner = {
  readonly harness: Harness;
  readonly root: Conversation;
  /** Ends the sandboxes the session's commands ran in (LOB-244), after the harness is closed. */
  readonly releaseEnvironment: Effect.Effect<void>;
  readonly storage: PostgresStorage;
  /** Resolved when the owner was opened, so a live read never touches the disk or the registry. */
  readonly workspace: SessionWorkspace;
  /**
   * The model the root conversation is pinned to, `provider/modelId` (LOB-269): what this open
   * resolved — the role's or the deployment's on the open that created the root, the pinned one on
   * every later open. The index row is written from it.
   */
  readonly model: string;
  readonly lastUsedAt: number;
};

const titleFrom = (content: string): string => {
  const line =
    content.split("\n").find((candidate) => candidate.trim().length > 0) ?? "";
  return line.trim().slice(0, TITLE_MAX);
};

/**
 * Whether a curation proposed a page the session already holds, field for field.
 *
 * A page is its name, kind, content and two citation lists; a proposal that matches all five would
 * be a rewrite of what is already there, so the pass skips it and writes nothing.
 */
const samePage = (existing: readonly Page[], proposal: Page): boolean =>
  existing.some(
    (page) =>
      page.name === proposal.name &&
      page.kind === proposal.kind &&
      page.content === proposal.content &&
      sameStrings(page.links, proposal.links) &&
      sameStrings(page.sources, proposal.sources),
  );

const sameStrings = (
  left: readonly string[],
  right: readonly string[],
): boolean => {
  // A citation list is a set: the same names in another order are the same page, not a rewrite, and
  // a repeat inside one list is one citation. Comparing index-wise would let a page that was
  // recorded in a different order be written again for having "changed".
  const a = new Set(left);
  const b = new Set(right);
  return a.size === b.size && [...a].every((value) => b.has(value));
};

/**
 * Total spend, which is what the list shows: both `pi.usage` buckets, models and tools (LOB-153).
 * The harness exports the sum because the rebuild fold writes the same number, and a session whose
 * spend is a tool's would otherwise show a live total the rebuilt index cannot reproduce.
 */
const costOf = (usage: SessionUsage): number => usageCostTotal(usage);

/** Whether a session's live tasks include a mission (LOB-231). */
const hasLiveMission = (tasks: readonly SessionTask[]): boolean =>
  tasks.some((task) => isMissionTask(task.kind));

const paper = <A, E>(
  what: string,
  effect: Effect.Effect<A, E>,
): Effect.Effect<A, SessionError> =>
  Effect.mapError(
    effect,
    (cause) =>
      new SessionErrorClass({
        code: "storage",
        message: `${what}: ${String(cause)}`,
      }),
  );

export const SessionServiceLive = (options: SessionServiceOptions) =>
  Layer.effect(
    SessionService,
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      /**
       * This process's session root as an absolute path (LOB-231): what a mission's row is marked
       * with, and the only rows `resumeMissions` reopens. A relative root names a different
       * directory from another working directory, so the comparison is between resolved paths.
       */
      const missionRoot = path.resolve(options.sessionRoot);
      const policy = yield* Policy;
      const skills = yield* SkillService;
      const tasks = yield* TaskService;
      // The services this layer was built with, for the one callback a harness calls back into from a
      // Promise (the `ask` tool, LOB-73): it runs with the same SQL client the rest of the service uses.
      const context = yield* Effect.context<never>();
      /** Where the PR step reports its exit; a no-op unless a deployment wires a tracker (LOB-15). */
      const writeBack = yield* SessionWriteBack;
      /** Where approved proposals become issues; refuses unless a deployment wires a tracker (LOB-202). */
      const tracker = yield* ProposalTracker;
      const writeBackBudget = Duration.fromInputUnsafe(
        options.writeBackBudget ?? SESSION_WRITE_BACK_BUDGET,
      );
      const live = yield* Ref.make(HashMap.empty<SessionId, LiveOwner>());
      /** Serializes owner acquisition so two callers cannot open the same log twice. */
      const gate = yield* Semaphore.make(1);
      /**
       * Serializes PR opens. Two overlapping calls for one session would each read an empty
       * `factory.pr` and each open a PR, so the read-then-create-then-commit sequence has to be
       * exclusive. One permit for every session rather than one per session: opening a PR is a
       * rare control-plane step, and a keyed semaphore buys nothing at that rate. Across processes
       * the log's single owner is what excludes, which is why no lock is stored anywhere.
       */
      const prGate = yield* Semaphore.make(1);
      /**
       * Serializes the approvals of one session, for the reason `prGate` serializes PR opens: two
       * overlapping calls would each read a proposal as not yet created and each create it. Keyed by
       * session, because a slow or unreachable tracker must hold up only the session that asked, and
       * an entry lives only while someone holds or awaits it. The tracker's own marker is what
       * excludes a second process.
       */
      const proposalLocks = new Map<
        SessionId,
        { readonly semaphore: Semaphore.Semaphore; users: number }
      >();
      const withProposalGate = <A, E>(
        sessionId: SessionId,
        effect: Effect.Effect<A, E>,
      ): Effect.Effect<A, E> =>
        Effect.acquireUseRelease(
          Effect.sync(() => {
            const entry = proposalLocks.get(sessionId) ?? {
              semaphore: Semaphore.makeUnsafe(1),
              users: 0,
            };
            entry.users += 1;
            proposalLocks.set(sessionId, entry);
            return entry;
          }),
          (entry) => entry.semaphore.withPermits(1)(effect),
          (entry) =>
            Effect.sync(() => {
              entry.users -= 1;
              if (entry.users === 0) proposalLocks.delete(sessionId);
            }),
        );
      /** One activity projection per owned session; releasing an owner interrupts its fiber. */
      const projectors = yield* FiberMap.make<SessionId, void, never>();
      /**
       * One comparison in progress per replay (LOB-199), keyed by the replay: `reconcileReplay`, armed
       * whenever this process opens an owner or serves a fold. In the layer's scope, like the
       * projections; what owes a comparison is read off the logs, so a wait this process loses (a
       * close, a restart) is armed again by the next owner or fold of that replay.
       */
      const comparisons = yield* FiberMap.make<SessionId, void, never>();

      const toSessionId = (
        raw: string,
      ): Effect.Effect<SessionId, SessionError> =>
        Effect.try({
          try: () => SessionIdSchema.make(raw),
          catch: () =>
            new SessionErrorClass({
              code: "storage",
              message: `the sessions table holds an invalid id: ${raw}`,
            }),
        });

      const toRepoSlug = (raw: string): Effect.Effect<RepoSlug, SessionError> =>
        Effect.try({
          try: () => RepoSlug.make(raw),
          catch: () =>
            new SessionErrorClass({
              code: "storage",
              message: `the repositories table holds an invalid slug: ${raw}`,
            }),
        });

      const summarize = (
        id: SessionId,
        row: SessionRow,
        mode: SessionMode,
        status: SessionStatus,
      ): Effect.Effect<SessionSummary, SessionError> =>
        Effect.gen(function* () {
          const repo =
            row.repo === null ? undefined : yield* toRepoSlug(row.repo);
          const forkedFrom =
            row.forkedFrom === null
              ? undefined
              : yield* toSessionId(row.forkedFrom);
          return {
            id,
            title: row.title,
            mode,
            status,
            createdAt: row.createdAt,
            ...(repo === undefined ? {} : { repo }),
            ...(repo === undefined || row.baseRef === null
              ? {}
              : { baseRef: row.baseRef }),
            ...(row.prUrl === null ? {} : { prUrl: row.prUrl }),
            ...(forkedFrom === undefined ? {} : { forkedFrom }),
            ...(row.model === null ? {} : { model: row.model }),
          };
        });

      const refOf = (
        id: SessionId,
        row: SessionRow,
        workspace: SessionWorkspace,
        /** The live owner's model, which wins over a row read before the owner wrote it. */
        model: string | null = row.model,
      ): SessionRef => {
        // The index row is the only reader of lineage a summary needs; a malformed value is a
        // broken index rather than a reason to fail a read, and `rebuildIndexes` refolds it.
        const forkedFrom = row.forkedFrom;
        return {
          id,
          title: row.title,
          createdAt: row.createdAt,
          workspace,
          ...(row.prUrl === null ? {} : { prUrl: row.prUrl }),
          ...(forkedFrom !== null && Schema.is(SessionIdSchema)(forkedFrom)
            ? { forkedFrom }
            : {}),
          ...(model === null ? {} : { model }),
        };
      };

      const openStorage = (
        logId: SessionId,
        mode: "owner" | "reader",
      ): Effect.Effect<PostgresStorage, SessionError> =>
        Effect.tryPromise({
          try: () =>
            mode === "owner"
              ? PostgresStorage.owner(sql, logId)
              : PostgresStorage.reader(sql, logId),
          catch: (cause) =>
            new SessionErrorClass({
              code: "storage",
              message: `open log ${logId} in ${mode} mode: ${String(cause)}`,
            }),
        });

      const withReader = <A>(
        logId: SessionId,
        use: (storage: PostgresStorage) => Effect.Effect<A, SessionError>,
      ): Effect.Effect<A, SessionError> =>
        Effect.acquireUseRelease(openStorage(logId, "reader"), use, (storage) =>
          Effect.promise(() => storage.dispose()),
        );

      const requireSession = (
        sessionId: SessionId,
      ): Effect.Effect<SessionRow, SessionError> =>
        Effect.gen(function* () {
          const rows = yield* paper("read session", readSessionById(sessionId));
          const row = rows[0];
          if (row === undefined) {
            return yield* new SessionErrorClass({
              code: "not_found",
              message: `no session ${sessionId}`,
            });
          }
          return row;
        });

      const touch = (sessionId: SessionId): Effect.Effect<void> =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          yield* Ref.update(live, (owners) =>
            Option.match(HashMap.get(owners, sessionId), {
              onNone: () => owners,
              onSome: (owner) =>
                HashMap.set(owners, sessionId, { ...owner, lastUsedAt: now }),
            }),
          );
        });

      /**
       * The column the run started in, as the card's pinned definition declares it (B6).
       *
       * One statement: the run row names the card, the card pins a definition version, and that
       * version's columns are the set the column has to be found in — a board that has moved on to a
       * newer version must not change what a run already started under is told. `undefined` is the
       * honest answer for a session with no card, and for a column the pinned version does not
       * declare (a stale run row is not a reason to refuse to open the session).
       */
      const runColumnFor = (
        sessionId: SessionId,
      ): Effect.Effect<RunColumn | undefined, SessionError> =>
        Effect.gen(function* () {
          const rows = yield* paper(
            "read run column",
            sql<{ column: string; columns: string }>`
              SELECT tr."column", bd.columns::text AS columns
              FROM task_runs tr
              JOIN tasks t ON t.id = tr.task_id
              JOIN board_instances bi ON bi.id = t.board_id
              JOIN board_definitions bd
                ON bd.id = bi.definition_id AND bd.version = t.definition_version
              WHERE tr.session_id = ${sessionId}
            `,
          );
          const row = rows[0];
          if (row === undefined) return undefined;
          const columns = yield* Schema.decodeEffect(
            Schema.fromJsonString(Schema.Array(BoardColumn)),
          )(row.columns).pipe(
            Effect.mapError(
              (cause) =>
                new SessionErrorClass({
                  code: "storage",
                  message: `the board definition holds an invalid column set: ${String(cause)}`,
                }),
            ),
          );
          const declared = columns.find((column) => column.name === row.column);
          return declared === undefined
            ? undefined
            : {
                name: declared.name,
                ...(declared.role === undefined ? {} : { role: declared.role }),
                skills: declared.skills,
              };
        });

      /**
       * The card this session is a run of (B1), or `undefined` for a session with no card. Read from
       * the run row `create` writes before the harness opens, like the run's column.
       */
      const runTaskFor = (
        sessionId: SessionId,
      ): Effect.Effect<string | undefined, SessionError> =>
        paper(
          "read run task",
          sql<{ taskId: string }>`
            SELECT task_id FROM task_runs WHERE session_id = ${sessionId}
          `,
        ).pipe(Effect.map((rows) => rows[0]?.taskId));

      /**
       * An effect of this service as the Promise a harness callback returns: run with the services
       * the layer was built with, and rejected with the service's own message on failure — which is
       * what the model reads as the tool's error, or what fails the request a section was read for.
       */
      const forHarness = <A, E extends { readonly message: string }>(
        effect: Effect.Effect<A, E>,
      ): Promise<A> =>
        Effect.runPromiseExitWith(context)(effect).then((exit) => {
          if (Exit.isSuccess(exit)) return exit.value;
          const failure = Cause.findErrorOption(exit.cause);
          throw new Error(
            Option.isSome(failure)
              ? failure.value.message
              : Cause.pretty(exit.cause),
          );
        });

      /**
       * How the run's prompt reads its card's thread (B7, LOB-73). The harness calls it before every
       * request rather than once per owner acquisition: a person who answers a parked run and then
       * messages that same session — its owner still live — reaches the run with the answer, not with
       * the thread as it stood when the owner opened.
       */
      const threadFor =
        (taskId: string): ThreadReader =>
        () =>
          forHarness(tasks.comments(taskId));

      /**
       * How a run asks (B7, LOB-73): a `question` comment and a `needs_input` block on its card, made
       * by the run itself — its actor is its session id, which is what makes it a run (B5). The ask id
       * is the session and the tool call, so a call replayed after a crash records nothing twice.
       *
       * A refusal reaches the model as the tool's error, in the service's own words, and the run is
       * not ended: a question that was never recorded must not park a run nobody will answer.
       */
      const askFor = (sessionId: SessionId, taskId: string): AskOptions => ({
        ask: ({ question, callId }) =>
          forHarness(
            tasks.ask({
              taskId,
              question,
              actor: sessionId,
              askId: `${sessionId}:${callId}`,
            }),
          ).then((card) => ({
            taskId: card.id,
            column: card.blocked?.column ?? card.column,
            revision: card.revision,
          })),
      });

      /**
       * How a specifying run posts its spec (LOB-238): a `specified` event on its card, by the run
       * itself, keyed by the session and the tool call so a replayed call posts nothing twice. The
       * harness offers the tool only to a role that writes the spec, so this is handed to every run
       * of a card and used by the specifier's alone. The spec records the run's own column — the one
       * its role came from — not the card's current one, which a person may have moved on since.
       */
      const specFor = (
        sessionId: SessionId,
        taskId: string,
        column: string | undefined,
      ): SpecOptions => ({
        post: ({ spec, callId }) =>
          forHarness(
            tasks.declareSpec({
              taskId,
              actor: sessionId,
              ...(column === undefined ? {} : { column }),
              goal: spec.goal,
              acceptance: spec.acceptance,
              gaps: spec.gaps,
              openQuestions: spec.openQuestions,
              specId: `${sessionId}:${callId}`,
            }),
          ).then((card) => ({ taskId: card.id, revision: card.revision })),
      });

      /**
       * How a reviewer run posts its review (LOB-36): the deployment's poster, under the reviewer's
       * own identity. Handed only to a review run — a session whose log records a review target —
       * whatever its role: the role is not what grants the tool, and the tool reads what it reviews
       * from the run's own log.
       */
      const reviewFor = (): ReviewOptions => ({
        post: (request) =>
          forHarness(
            // No poster is no reviewer identity: settled as withheld, not a failure the model retries.
            options.reviewPoster === undefined
              ? Effect.succeed({
                  _tag: "withheld",
                  reason: NO_REVIEWER_IDENTITY,
                } as const)
              : options.reviewPoster(request),
          ),
      });

      /**
       * One `session_pages` row as the domain's page, or a storage error naming the page whose JSON
       * text does not decode. Shared by the page reads so a row is decoded one way.
       */
      const pageFromRow = (row: PageRow): Effect.Effect<Page, SessionError> =>
        Effect.gen(function* () {
          const links = yield* Schema.decodeEffect(PageStrings)(row.links).pipe(
            Effect.mapError(
              (cause) =>
                new SessionErrorClass({
                  code: "storage",
                  message: `page ${row.name} has unreadable links: ${String(cause)}`,
                }),
            ),
          );
          const sources = yield* Schema.decodeEffect(PageStrings)(
            row.sources,
          ).pipe(
            Effect.mapError(
              (cause) =>
                new SessionErrorClass({
                  code: "storage",
                  message: `page ${row.name} has unreadable sources: ${String(cause)}`,
                }),
            ),
          );
          return {
            name: row.name,
            kind: row.kind,
            content: row.content,
            links,
            sources,
          };
        });

      /**
       * The pages one session holds, from the derived rows rather than a fold of its log (LOB-204).
       *
       * This is the read the prompt's `pages` section is assembled from (LOB-205): it runs on every
       * owner acquisition, so a page curated since the session last ran reaches its next run, the
       * same freshness the column's skill bodies have.
       */
      const pagesFor = (
        sessionId: SessionId,
      ): Effect.Effect<readonly Page[], SessionError> =>
        Effect.gen(function* () {
          const rows = yield* paper(
            "read pages",
            sql<PageRow>`
              SELECT name, kind, content, links::text AS links, sources::text AS sources
              FROM session_pages
              WHERE session_id = ${sessionId}
              ORDER BY name
            `,
          );
          const pages: Page[] = [];
          for (const row of rows) pages.push(yield* pageFromRow(row));
          return pages;
        });

      /**
       * What the run's column gives its prompt: the skill records the column names, resolved in the
       * column's order (`@repo/harness`'s `loadRun`). A column that names no skills costs no query.
       */
      const runProfileFor = (
        sessionId: SessionId,
      ): Effect.Effect<RunProfile, SessionError> =>
        Effect.gen(function* () {
          const column = yield* runColumnFor(sessionId);
          if (column === undefined || column.skills.length === 0) {
            // No skills to read, but the role still travels: it is what makes a column a read-only
            // stage (LOB-74), and a stage with no skill bound is still that stage.
            return column === undefined
              ? EMPTY_RUN_PROFILE
              : {
                  column: column.name,
                  ...(column.role === undefined ? {} : { role: column.role }),
                  skills: [],
                };
          }
          const library = yield* skills.list.pipe(
            Effect.mapError(
              (cause) =>
                new SessionErrorClass({
                  code: "storage",
                  message: `read skills: ${cause.message}`,
                }),
            ),
          );
          return yield* loadRun(
            column,
            library.map((skill) => ({ name: skill.name, body: skill.body })),
          ).pipe(
            Effect.mapError(
              (cause) =>
                new SessionErrorClass({
                  code: "invalid_input",
                  message: cause.message,
                }),
            ),
          );
        });

      /** A release the index recorded, checked: a reason this build does not know is a broken row. */
      const decodeRelease = (marked: {
        readonly reason: string | null;
        readonly at: string | null;
      }): Effect.Effect<WorkspaceRelease, SessionError> =>
        Schema.decodeUnknownEffect(WorkspaceReleaseSchema)(marked).pipe(
          Effect.mapError(
            (cause) =>
              new SessionErrorClass({
                code: "storage",
                message: `the sessions table holds an invalid workspace release: ${String(cause)}`,
              }),
          ),
        );

      const releaseOf = (
        row: SessionRow,
      ): Effect.Effect<WorkspaceRelease | undefined, SessionError> =>
        Effect.gen(function* () {
          if (row.workspaceReleasedAt === null) return undefined;
          return yield* decodeRelease({
            reason: row.workspaceReleaseReason,
            at: row.workspaceReleasedAt,
          });
        });

      /**
       * The session's workspace. A released one (LOB-268) says so, and resolves where it was.
       *
       * `cut` is whether a missing worktree is cut, and only the owner's acquisition asks for it,
       * with the release it has just re-read under the owners' gate: a read has no use for a
       * worktree, and a read that cut one from a row read before a release committed would leave a
       * fresh worktree and branch nothing sweeps. `released`, when given, replaces the row's.
       */
      const workspaceFor = (
        row: SessionRow,
        resolution: {
          readonly cut: boolean;
          readonly released?: WorkspaceRelease | undefined;
          /** The mirror's tip, fetched before the owners' gate was taken (`mirrorStartFor`). */
          readonly mirrorStart?: string | undefined;
        },
      ): Effect.Effect<SessionWorkspace, SessionError> =>
        Effect.gen(function* () {
          const repo =
            row.repo === null ? undefined : yield* toRepoSlug(row.repo);
          const registered =
            repo === undefined
              ? undefined
              : (yield* paper("read repo", readRepo(repo)))[0];
          const localPath = registered?.localPath ?? undefined;
          const release = resolution.cut
            ? resolution.released
            : (resolution.released ?? (yield* releaseOf(row)));
          const workspace = yield* resolveWorkspace(
            {
              sessionRoot: options.sessionRoot,
              sessionId: row.id,
              repo,
              baseRef: row.baseRef ?? undefined,
              ...(row.branch === null ? {} : { branch: row.branch }),
              localPath,
              ...mirrorSource(
                repo,
                registered,
                row.baseRef ?? "main",
                resolution.mirrorStart,
              ),
              cut: resolution.cut && release === undefined,
            },
            { fs, path },
          ).pipe(
            Effect.mapError((e) =>
              "_tag" in e && e._tag === "RepoCloneFailed"
                ? cloneFailure(e)
                : new SessionErrorClass({
                    code: "storage",
                    message: e.message,
                  }),
            ),
          );
          return release === undefined
            ? workspace
            : { ...workspace, released: release };
        });

      /**
       * Why a session whose workspace was torn down takes no new run (LOB-268): the branch is gone,
       * and a run there would start over on an empty one at the base. Reads, approvals, pages and
       * the curator still reach it; a new run is a new session.
       */
      const releasedError = (id: string, release: WorkspaceRelease) =>
        new SessionErrorClass({
          code: "invalid_input",
          message: `session ${id} is finished: its workspace was released (${release.reason}) at ${release.at}, so it takes no new run`,
        });

      /**
       * Refuse early, from a row already read — `startMission`, before it polices its checks. The
       * check that holds is `acquireOwner`'s `starts`, made under the gate.
       */
      const refuseReleased = (
        row: SessionRow,
      ): Effect.Effect<void, SessionError> =>
        Effect.gen(function* () {
          const release = yield* releaseOf(row);
          if (release === undefined) return;
          return yield* releasedError(row.id, release);
        });

      /**
       * Whether the repo is one the factory clones itself (LOB-265): it has a URL and no checkout of
       * its own, and the deployment has somewhere to clone it to.
       */
      const mirrorOf = (
        row: RepoRow | undefined,
      ): { readonly mirror: RepoMirror; readonly url: string } | undefined =>
        options.repoMirror === undefined ||
        row === undefined ||
        row.localPath !== null ||
        row.url === ""
          ? undefined
          : { mirror: options.repoMirror, url: row.url };

      /**
       * What `resolveWorkspace` is given to cut a URL-only repo's worktree from its mirror. `start`
       * is the tip a caller already fetched, outside the owners' gate, so the cut under it is local.
       * A base that is a commit id is no branch to fetch (a review run is based at the PR's head):
       * such a session is cut as it was before the mirror, in an empty directory with a warning.
       */
      const mirrorSource = (
        repo: RepoSlug | undefined,
        row: RepoRow | undefined,
        baseRef: string,
        start?: string,
      ): { readonly mirror?: WorkspaceInput["mirror"] } => {
        const found = mirrorOf(row);
        if (found === undefined || repo === undefined || isCommitId(baseRef))
          return {};
        return {
          mirror: {
            path: found.mirror.directory(repo),
            sync:
              start !== undefined
                ? Effect.succeed(start)
                : found.mirror
                    .sync({ repo, url: found.url, baseRef })
                    .pipe(Effect.map((tip) => tip.ref)),
          },
        };
      };

      /**
       * Fetch the mirror's tip for a session whose worktree is about to be cut, before the owners'
       * gate is taken (LOB-265). The gate is every session's, and a clone or fetch is the network, up
       * to its timeout: held under it, one repo's slow forge would stop every other session opening.
       * Nothing to fetch for a session that has an owner, a released one, a repo with a checkout, or a
       * directory that already holds its worktree; the cut under the gate then only runs local git.
       */
      const mirrorStartFor = (
        row: SessionRow,
      ): Effect.Effect<string | undefined, SessionError> =>
        Effect.gen(function* () {
          if (row.repo === null) return undefined;
          if ((yield* releaseOf(row)) !== undefined) return undefined;
          const repo = yield* toRepoSlug(row.repo);
          const registered = (yield* paper("read repo", readRepo(repo)))[0];
          const source = mirrorSource(repo, registered, row.baseRef ?? "main");
          if (source.mirror === undefined) return undefined;
          const occupied = yield* fs
            .readDirectory(
              sessionDirectory(path, options.sessionRoot, row.id, repo),
            )
            .pipe(
              Effect.map((entries) => entries.length > 0),
              Effect.orElseSucceed(() => false),
            );
          if (occupied) return undefined;
          return yield* source.mirror.sync.pipe(Effect.mapError(cloneFailure));
        });

      /** Whether the factory's mirror of the repo has been cloned: read from the disk, never stored. */
      const mirrorClonedAt = (
        row: RepoRow,
      ): Effect.Effect<string | undefined> =>
        Effect.gen(function* () {
          const found = mirrorOf(row);
          if (found === undefined) return undefined;
          const directory = found.mirror.directory(yield* toRepoSlug(row.slug));
          const cloned = yield* fs
            .exists(path.join(directory, "HEAD"))
            .pipe(Effect.orElseSucceed(() => false));
          return cloned ? directory : undefined;
        }).pipe(Effect.orElseSucceed(() => undefined));

      /**
       * The checkouts a session's worktree may have been cut from, for tearing it down: the registered
       * path, and the factory's mirror when it has been cloned (LOB-265). Both, because a repo
       * registered with a URL and later given a path still has sessions whose worktrees are the
       * mirror's, and `removeWorkspace` is a no-op in the checkout that does not hold the worktree.
       */
      const checkoutsFor = (
        repo: RepoSlug | undefined,
      ): Effect.Effect<ReadonlyArray<string>, SessionError> =>
        Effect.gen(function* () {
          if (repo === undefined) return [];
          const row = (yield* paper("read repo", readRepo(repo)))[0];
          if (row === undefined) return [];
          const directory = options.repoMirror?.directory(repo);
          const mirrored =
            directory !== undefined &&
            (yield* fs
              .exists(path.join(directory, "HEAD"))
              .pipe(Effect.orElseSucceed(() => false)));
          return [
            ...(row.localPath === null ? [] : [row.localPath]),
            ...(mirrored ? [directory] : []),
          ];
        });

      /**
       * Where a card's run works when the create named nothing (LOB-255, LOB-260): the card's
       * repository — for a card made before cards carried one, its board's (B2) — and the card's base
       * ref, when it has one. `undefined` for no card, and for a card id the tasks table does not
       * hold — the run row's foreign key refuses that one.
       */
      const cardBindingFor = (
        taskId: string | undefined,
      ): Effect.Effect<
        { readonly repo: RepoSlug; readonly baseRef?: string } | undefined,
        SessionError
      > =>
        Effect.gen(function* () {
          if (taskId === undefined) return undefined;
          const rows = yield* paper(
            "read the card's repo",
            sql<{ repo: string; baseRef: string | null }>`
              SELECT COALESCE(t.repo, bi.repo) AS repo, t.base_ref
              FROM tasks t JOIN board_instances bi ON bi.id = t.board_id
              WHERE t.id = ${taskId}
            `,
          );
          const row = rows[0];
          if (row === undefined) return undefined;
          return {
            repo: yield* toRepoSlug(row.repo),
            ...(row.baseRef === null ? {} : { baseRef: row.baseRef }),
          };
        });

      /**
       * The card's body (LOB-260), read when a run's owner opens so its prompt carries what the task
       * asks for. `''` — a card with none — is `undefined`, and so no `task_body` section.
       */
      const cardBodyFor = (
        taskId: string,
      ): Effect.Effect<string | undefined, SessionError> =>
        paper(
          "read the card's body",
          sql<{ body: string }>`SELECT body FROM tasks WHERE id = ${taskId}`,
        ).pipe(
          Effect.map((rows) => {
            const body = rows[0]?.body;
            return body === undefined || body === "" ? undefined : body;
          }),
        );

      /**
       * Resolve the repo binding a create asked for, registering the repo on first use. A card's run
       * that names no repo is bound to the card's (`cardBindingFor`), so it gets a branch and a
       * worktree whichever client started it; only a run of no card is a scratch session. A card's
       * run that names no base starts from the card's base ref (LOB-260) when the run is in the
       * card's repository, and from the repository's default otherwise.
       */
      const resolveBinding = (
        input: CreateSessionInput,
      ): Effect.Effect<Binding, SessionError> =>
        Effect.gen(function* () {
          const card = yield* cardBindingFor(input.taskId);
          const repo = input.repo ?? card?.repo;
          if (repo === undefined) return {};
          const cardBase = card?.repo === repo ? card.baseRef : undefined;
          const existing = (yield* paper("read repo", readRepo(repo)))[0];
          const registered =
            existing ??
            (yield* paper(
              "register repo",
              upsertRepo({
                slug: repo,
                url: "",
                defaultBaseRef: input.baseRef ?? "main",
                localPath: null,
              }),
            ))[0];
          return {
            repo,
            baseRef:
              input.baseRef ?? cardBase ?? registered?.defaultBaseRef ?? "main",
            // The branch is part of the binding, not of the create call: every later read of this
            // session's workspace has to answer the branch it is really on (LOB-197).
            ...(input.branch === undefined ? {} : { branch: input.branch }),
            ...(registered?.localPath == null
              ? {}
              : { localPath: registered.localPath }),
          };
        });

      /** A registry row as the wire answers it, with its checkout read now rather than stored. */
      const repoSummary = (
        row: RepoRow,
      ): Effect.Effect<RepoSummary, SessionError> =>
        Effect.gen(function* () {
          const localPath = row.localPath ?? undefined;
          const facts = yield* inspectCheckout(localPath, { fs, path });
          const mirrorPath = yield* mirrorClonedAt(row);
          return {
            repo: yield* toRepoSlug(row.slug),
            url: row.url,
            defaultBaseRef: row.defaultBaseRef,
            ...(localPath === undefined ? {} : { localPath }),
            registeredAt: row.registeredAt,
            ...facts,
            ...(mirrorPath === undefined ? {} : { mirrorPath }),
          };
        });

      /**
       * A checkout a registration names must be one a worktree can be cut from: an absolute path,
       * because the server resolves it and a relative one would mean wherever the API was started,
       * inside a git work tree (LOB-253). Checked before the row is read, so a refusal writes nothing.
       */
      const requireCheckout = (
        repo: RepoSlug,
        localPath: string,
      ): Effect.Effect<void, SessionError> =>
        Effect.gen(function* () {
          if (!path.isAbsolute(localPath)) {
            return yield* new SessionErrorClass({
              code: "invalid_input",
              message: `repo ${repo}: local path ${localPath} is not an absolute path`,
            });
          }
          if ((yield* workTreeRoot(localPath)) === undefined) {
            return yield* new SessionErrorClass({
              code: "invalid_input",
              message: `repo ${repo}: local path ${localPath} is not a git work tree`,
            });
          }
        });

      /**
       * Clone the repo into the factory's cache, or fetch its base ref when it is there (LOB-265).
       * Nothing to do for a repo that has a checkout, has no URL, or a deployment with no cache.
       */
      const syncMirrorOf = (
        row: RepoRow,
      ): Effect.Effect<void, SessionError | RepoCloneFailed> =>
        Effect.gen(function* () {
          const found = mirrorOf(row);
          if (found === undefined) return;
          yield* found.mirror.sync({
            repo: yield* toRepoSlug(row.slug),
            url: row.url,
            baseRef: row.defaultBaseRef,
          });
        });

      const registerRepo = (
        input: RegisterRepoInput,
      ): Effect.Effect<RepoSummary, SessionError | RepoCloneFailed> =>
        Effect.gen(function* () {
          if (input.localPath !== undefined) {
            yield* requireCheckout(input.repo, input.localPath);
          }
          // A URL with a credential in it is refused before it is stored: the registry would keep a
          // token and `repo show` would print it, and the clone is given its own per call. Any other
          // URL is registered as given; one a token may not be sent to (not GitHub, not https) is
          // refused when it is cloned, as `RepoCloneFailed`, so the row stays to be corrected.
          if (input.url !== undefined && urlCarriesCredential(input.url)) {
            return yield* new SessionErrorClass({
              code: "invalid_input",
              message: `repo ${input.repo}: the URL carries a credential; remove it, the token is supplied per call`,
            });
          }
          const existing = (yield* paper("read repo", readRepo(input.repo)))[0];
          const rows = yield* paper(
            "register repo",
            upsertRepo({
              slug: input.repo,
              url: input.url ?? existing?.url ?? "",
              defaultBaseRef:
                input.defaultBaseRef ?? existing?.defaultBaseRef ?? "main",
              localPath:
                input.localPath === undefined
                  ? (existing?.localPath ?? null)
                  : input.localPath,
            }),
          );
          const row = rows[0];
          if (row === undefined) {
            return yield* new SessionErrorClass({
              code: "storage",
              message: `repo ${input.repo} did not register`,
            });
          }
          yield* syncMirrorOf(row);
          return yield* repoSummary(row);
        });

      const syncRepo = (
        input: SyncRepoInput,
      ): Effect.Effect<
        RepoSummary,
        SessionError | RepoNotFound | RepoCloneFailed
      > =>
        Effect.gen(function* () {
          const row = (yield* paper("read repo", readRepo(input.repo)))[0];
          if (row === undefined) {
            return yield* new RepoNotFound({
              repo: input.repo,
              message: `repo ${input.repo} is not registered`,
            });
          }
          yield* syncMirrorOf(row);
          return yield* repoSummary(row);
        });

      const listRepos: Effect.Effect<ListReposOutput, SessionError> =
        Effect.gen(function* () {
          const rows = yield* paper("list repos", readRepos);
          // One asynchronous `git` per checkout, four at a time: the registry is small, the read is a
          // picker's, and a checkout on a slow mount holds one probe rather than the whole list.
          const repos = yield* Effect.forEach(rows, repoSummary, {
            concurrency: 4,
          });
          return { repos };
        });

      const getRepo = (
        input: GetRepoInput,
      ): Effect.Effect<RepoSummary, SessionError | RepoNotFound> =>
        Effect.gen(function* () {
          const row = (yield* paper("read repo", readRepo(input.repo)))[0];
          if (row === undefined) {
            return yield* new RepoNotFound({
              repo: input.repo,
              message: `repo ${input.repo} is not registered`,
            });
          }
          return yield* repoSummary(row);
        });

      /**
       * How an owner's harness is opened: a plain session, or a fork of another session's log.
       *
       * The storage handed in is already this process's single-writer handle for the session, so a
       * fork is the same acquisition with the entries copied in before the owner is published.
       */
      type OwnerOpening = (input: {
        readonly storage: PostgresStorage;
        readonly cwd: string;
        readonly policy: SessionPolicy;
        readonly run: RunProfile;
        /** The cited pages the session's prompt carries (LOB-205), read at every acquisition. */
        readonly pages: readonly Page[];
        /**
         * What the session's `verify` tool runs (LOB-78): the repo's declared command and the base
         * its changes are measured against, from the workspace resolved for this acquisition.
         */
        readonly verify: VerifyOptions;
        /** How the run asks on its card (LOB-73); absent for a session with no card. */
        readonly ask?: AskOptions;
        /** How the run reads its card's thread (LOB-73); absent for a session with no card. */
        readonly thread?: ThreadReader;
        /** The card's body (LOB-260); absent for a session with no card, or a card with none. */
        readonly body?: string;
        /** How a specifying run posts its spec (LOB-238); absent for a session with no card. */
        readonly spec?: SpecOptions;
        /** How a reviewer run posts its review (LOB-36); absent for a session with no card. */
        readonly review?: ReviewOptions;
      }) => Effect.Effect<OpenSession, SessionError>;

      /** What an owner acquisition is for (`acquireOwnerWith`). */
      type OwnerAcquisition = {
        readonly reviewing?: boolean;
        readonly starts?: boolean;
        /**
         * The model the session was created on (LOB-274), resolved against the deployment's catalog:
         * `create` passes it to the open that creates the root, which pins it ahead of the role's.
         */
        readonly model?: ModelAccess;
      };

      /** The part of an acquisition that is serialized: everything but the network (below). */
      const acquireUnderGate = (
        id: SessionId,
        row: SessionRow,
        open: OwnerOpening,
        acquisition: OwnerAcquisition,
        mirrorStart: string | undefined,
      ): Effect.Effect<LiveOwner, SessionError> =>
        gate.withPermits(1)(
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            const owners = yield* Ref.get(live);
            const existing = HashMap.get(owners, id);
            if (Option.isSome(existing)) {
              const touched = { ...existing.value, lastUsedAt: now };
              yield* Ref.update(live, HashMap.set(id, touched));
              return touched;
            }

            // Read again under the gate rather than trusted from `row`: a release that committed
            // after the caller read the row must not be undone by cutting the worktree back
            // (LOB-268). A released session still opens — its log takes approvals, pages and a
            // curator's charge — but in no directory, because there is none to work in.
            const current = yield* requireSession(id);
            const released = yield* releaseOf(current);
            if (released !== undefined && acquisition.starts === true) {
              return yield* releasedError(id, released);
            }
            const workspace = yield* workspaceFor(row, {
              cut: released === undefined,
              released,
              mirrorStart,
            });
            if (released === undefined) {
              yield* Effect.mapError(
                fs.makeDirectory(workspace.path, { recursive: true }),
                (cause) =>
                  new SessionErrorClass({
                    code: "harness",
                    message: `create ${workspace.path}: ${String(cause)}`,
                  }),
              );
            }
            const storage = yield* openStorage(id, "owner");
            // The run's prompt comes from its column (B6), read on every owner acquisition: a
            // resumed session re-reads the skill bodies as they are *now*, so an edit made between
            // two runs of one session reaches the next run too. Pinning a body to the run that
            // started under it is B6's "per-run version pinning", which is wave 2.
            const column = yield* runProfileFor(id);
            // A review run (LOB-36) is the read-only reviewing stage, offered the review tool.
            const reviews =
              acquisition.reviewing === true ||
              (yield* readRecordedReview(storage).pipe(
                Effect.tapError(() => Effect.promise(() => storage.dispose())),
              )) !== undefined;
            const run: RunProfile = reviews
              ? { ...column, reviewing: true }
              : column;
            // The knowledge the prompt carries is read the same way, and for the same reason: a page
            // curated since this session last ran reaches its next run, and a page deleted from
            // `session_pages` stops being told. A session with none passes none, so its prompt has no
            // `pages` section and its log records no page prompt (LOB-205).
            const pages = yield* pagesFor(id);
            // The card's thread and the means to add to it (B7, LOB-73), for a session that is a run
            // of a card. A fork or a replay has no run row of its own, so it gets neither.
            const card = yield* runTaskFor(id);
            const body =
              card === undefined ? undefined : yield* cardBodyFor(card);
            const opened = yield* open({
              storage,
              cwd: workspace.path,
              policy: policy.forWorktree(workspace.path, id),
              run,
              pages,
              verify: {
                command: workspace.commands.verify,
                baseRef: workspace.baseRef,
              },
              ...(card === undefined
                ? {}
                : {
                    ask: askFor(id, card),
                    thread: threadFor(card),
                    ...(body === undefined ? {} : { body }),
                    spec: specFor(id, card, run.column),
                  }),
              ...(reviews ? { review: reviewFor() } : {}),
            }).pipe(
              Effect.tapError(() => Effect.promise(() => storage.dispose())),
            );
            // The model the root is pinned to, onto the index row (LOB-269): on the open that created
            // the root this is the first write, and on a later one it repairs a row older than the
            // column. The log's `pi.agent` stays the truth `rebuildIndexes` refolds it from, so a
            // failed write is a stale display field rather than a failed open: it is warned about,
            // and the next open (or a rebuild) writes it again.
            const model = modelKey(opened.model);
            if (current.model !== model) {
              yield* paper(
                "write session model",
                sql`UPDATE sessions SET model = ${model} WHERE id = ${id}`,
              ).pipe(
                Effect.catch((error) =>
                  Effect.logWarning(
                    `session ${id}: the index row's model was not written: ${error.message}`,
                  ),
                ),
              );
            }
            yield* FiberMap.run(
              projectors,
              id,
              liveSessionEvents(opened, refOf(id, row, workspace, model)).pipe(
                Stream.runForEach((event) => recordActivity(id, event)),
                Effect.catchCause((cause) =>
                  Effect.logWarning(
                    `session ${id} activity projection stopped: ${String(cause)}`,
                  ),
                ),
              ),
            );
            const owner: LiveOwner = {
              harness: opened.harness,
              root: opened.root,
              releaseEnvironment: opened.releaseEnvironment,
              storage,
              workspace,
              model,
              lastUsedAt: now,
            };
            yield* Ref.update(live, HashMap.set(id, owner));
            // Published first, so a replay's comparison finds the owner whose run it waits for. An
            // owner opened on a replay is either its first open or the one that resumes its run, and
            // either way the comparison is owed from here (LOB-199); on any other log it is one
            // document read that finds nothing to do.
            yield* armComparison(id);
            return owner;
          }),
        );

      /**
       * Open this process's owner of one session, or return the one already open.
       *
       * Opening means: resolve the workspace, create its directory, take the single-writer log, and
       * start the activity projection that keeps the list index current from the log. `open` is how
       * a fork opens the log it has just created rather than an empty one.
       *
       * `reviewing` says the session is a review run before its log can (LOB-36): `create` opens the
       * owner before it commits the review target, and the run's read-only stage and tool filter are
       * pinned at that first open. Every later acquisition reads it from the log's `factory.review`.
       *
       * `starts` says the caller is about to start work (`send`, `reset`, `startMission`): on a
       * session whose workspace was released (LOB-268) it is refused, from the release read under
       * the gate, rather than handed a directory-less owner to prompt.
       *
       * A URL-only repo's mirror is fetched first, outside the gate (`mirrorStartFor`).
       */
      const acquireOwnerWith = (
        id: SessionId,
        row: SessionRow,
        open: OwnerOpening,
        acquisition: OwnerAcquisition = {},
      ): Effect.Effect<LiveOwner, SessionError> =>
        Effect.gen(function* () {
          // The network part of opening a URL-only repo's session, outside the gate (see
          // `mirrorStartFor`); an owner that is already open needs none of it.
          const mirrorStart = HashMap.has(yield* Ref.get(live), id)
            ? undefined
            : yield* mirrorStartFor(row);
          return yield* acquireUnderGate(
            id,
            row,
            open,
            acquisition,
            mirrorStart,
          );
        });

      const acquireOwner = (
        id: SessionId,
        row: SessionRow,
        acquisition: OwnerAcquisition = {},
      ): Effect.Effect<LiveOwner, SessionError> =>
        acquireOwnerWith(
          id,
          row,
          ({
            storage,
            cwd,
            policy: sessionPolicy,
            run,
            pages,
            verify,
            ask,
            thread,
            body,
            spec,
            review,
          }) =>
            openSession({
              storage,
              model: options.model,
              ...(options.sandbox === undefined
                ? {}
                : { sandbox: options.sandbox }),
              // The run's role picks its model from the deployment's table (LOB-207); a session
              // with no card has no role, so it talks to the deployment's model.
              ...(options.roleModels === undefined
                ? {}
                : { roles: options.roleModels }),
              // A session created on a model runs it, whatever its role's row says (LOB-274).
              ...(acquisition.model === undefined
                ? {}
                : { sessionModel: acquisition.model }),
              cwd,
              pages,
              verify,
              // A gated call (D15, LOB-52) records its ask through this session's approvals
              // service, so the request lands in the same log and index the pending list reads.
              approvalAsker: askerFor(id),
              ...(ask === undefined ? {} : { ask }),
              ...(thread === undefined ? {} : { thread }),
              ...(body === undefined ? {} : { body }),
              ...(spec === undefined ? {} : { spec }),
              ...(review === undefined ? {} : { review }),
              // A mission is a durable task, so the kind has to be installed in the registry this
              // session's harness runs: an uninstalled kind settles `orphaned` (LOB-230). Its
              // workers are tasks of their own kind, installed with it (LOB-193).
              tasks: [...MISSION_TASKS],
              // D11's boundary, resolved for this session's worktree: the one place the policy
              // needs a fact the service does not hold as data.
              policy: sessionPolicy,
              run,
            }),
          acquisition,
        );

      const describe = (
        id: SessionId,
        row: SessionRow,
      ): Effect.Effect<SessionSummary, SessionError> =>
        Effect.gen(function* () {
          const owners = yield* Ref.get(live);
          const owner = HashMap.get(owners, id);
          if (Option.isNone(owner))
            return yield* summarize(id, row, "historical", "idle");
          const busy = yield* isBusy(owner.value.harness, owner.value.root);
          yield* touch(id);
          // The owner's model, not the row's: `create` describes the row it inserted, which was
          // written before the owner opened and pinned the model (LOB-269).
          return yield* summarize(
            id,
            { ...row, model: owner.value.model },
            "live",
            busy ? "busy" : "idle",
          );
        });

      const setTitle = (
        sessionId: SessionId,
        title: string,
      ): Effect.Effect<void, SessionError> =>
        paper(
          "write session title",
          sql`UPDATE sessions SET title = ${title} WHERE id = ${sessionId}`,
        );

      /**
       * A retried review create (LOB-36) finds its session by request id; if the first attempt died
       * between the owner's open and the review target's commit, the log names no target, and every
       * later open would read the run as an ordinary one with write tools. The retry commits the
       * target it was given, so the prompt that follows reaches the read-only stage.
       */
      const ensureReviewTarget = (
        id: SessionId,
        row: SessionRow,
        review: NonNullable<CreateSessionInput["review"]>,
      ): Effect.Effect<void, SessionError> =>
        Effect.gen(function* () {
          if (row.repo === null) return;
          const owner = yield* acquireOwner(id, row, { reviewing: true });
          const recorded = yield* readRecordedReview(owner.storage);
          if (recorded !== undefined) return;
          yield* writeReviewTarget(owner.root, { repo: row.repo, ...review });
        });

      /**
       * The model a create or a replay names, `provider/modelId`, resolved against the catalog the
       * deployment serves (`modelAccessFor`): `undefined` when it names none, and `invalid_input`
       * naming it when the catalog has no such model — a session asked onto a model the process
       * cannot serve is a refusal, never quietly served by another one (LOB-198, LOB-274).
       */
      const sessionModelFor = (
        key: string | undefined,
      ): Effect.Effect<ModelAccess | undefined, SessionError> =>
        Effect.gen(function* () {
          if (key === undefined) return undefined;
          const access = modelAccessFor(options.model, key);
          if (access === undefined) {
            return yield* new SessionErrorClass({
              code: "invalid_input",
              message: `model ${key} is not one this process serves`,
            });
          }
          return access;
        });

      /**
       * A retried create (LOB-274) that names a model finds its session by request id; if the first
       * attempt died between the index row and the owner's open (a URL-only repo's mirror fetch
       * fails there, LOB-265), no root was pinned, and the next open — a send's — would pin the
       * role's model or the deployment's instead of the one asked for. The retry opens the owner on
       * the model it names, so that open is the one that pins it. A session that is live or whose
       * root is already pinned keeps the model it runs: a root's model is never changed afterwards.
       */
      const ensureSessionModel = (
        id: SessionId,
        row: SessionRow,
        model: ModelAccess,
        acquisition: { readonly reviewing: boolean },
      ): Effect.Effect<void, SessionError> =>
        Effect.gen(function* () {
          if (HashMap.has(yield* Ref.get(live), id)) return;
          const pinned = yield* withReader(id, readPinnedModelKey);
          if (pinned !== undefined) return;
          yield* acquireOwner(id, row, { ...acquisition, model });
        });

      const create = (
        input: CreateSessionInput = {},
      ): Effect.Effect<SessionSummary, SessionError> =>
        Effect.gen(function* () {
          const requested =
            input.requestId === undefined
              ? undefined
              : yield* paper(
                  "read session by request",
                  readSessionByRequest(input.requestId),
                );
          const already = requested?.[0];
          if (already !== undefined) {
            const sessionId = yield* toSessionId(already.id);
            const model = yield* sessionModelFor(input.model);
            if (model !== undefined)
              yield* ensureSessionModel(sessionId, already, model, {
                reviewing: input.review !== undefined && already.repo !== null,
              });
            if (input.review !== undefined)
              yield* ensureReviewTarget(sessionId, already, input.review);
            return yield* describe(sessionId, already);
          }

          if (input.review !== undefined && input.repo === undefined) {
            return yield* new SessionErrorClass({
              code: "invalid_input",
              message:
                "a session that reviews a pull request names the repo the pull request is in",
            });
          }
          // The session's own model (LOB-274), resolved against the catalog the deployment serves —
          // the lookup a replay does — before anything is written: a model this process cannot serve
          // is refused here, not registered as a repo, an index row and a log that never run.
          const model = yield* sessionModelFor(input.model);
          const binding = yield* resolveBinding(input);
          const id = yield* mintSessionId;
          const title = (input.title ?? "").trim().slice(0, TITLE_MAX);
          const inserted = yield* paper(
            "create session",
            insertSession(
              id,
              title,
              input.requestId,
              binding,
              null,
              input.actor ?? null,
            ),
          );
          const row = inserted[0] ?? {
            id,
            title,
            repo: binding.repo ?? null,
            baseRef: binding.baseRef ?? null,
            branch: binding.branch ?? null,
            prUrl: null,
            forkedFrom: null,
            actor: input.actor ?? null,
            createdAt: "",
            workspaceReleasedAt: null,
            workspaceReleaseReason: null,
            model: null,
          };
          // The index row is written before the log because it carries the request-id dedupe key.
          // A failure between the two leaves a row whose log has no binding; `rebuildIndexes`
          // re-derives the truth from the log rather than trusting the row.
          const column =
            input.taskId === undefined
              ? undefined
              : (input.taskColumn ?? "building");
          if (input.taskId !== undefined && column !== undefined) {
            // The run row is written before the harness opens, because it is where `acquireOwner`
            // reads the run's column from (B6) — the prompt this session is told is resolved from
            // it. `ON CONFLICT DO NOTHING` keeps a retried create from writing a second run.
            yield* paper(
              "write task run",
              sql`INSERT INTO task_runs (id, task_id, session_id, "column")
                  VALUES (${id}, ${input.taskId}, ${id}, ${column})
                  ON CONFLICT (session_id) DO NOTHING`,
            );
          }
          const owner = yield* acquireOwner(id, row, {
            reviewing: input.review !== undefined,
            ...(model === undefined ? {} : { model }),
          });
          if (input.review !== undefined && binding.repo !== undefined) {
            // What the reviewer reviews is a fact in its log before it is told anything (LOB-36), and
            // it is the first: a reopen reads the read-only stage from it alone, so no other write
            // may sit between the owner's open and it. A create that died before it is repaired by
            // its retry (`ensureReviewTarget`).
            yield* writeReviewTarget(owner.root, {
              repo: binding.repo,
              ...input.review,
            });
          }
          if (title.length > 0) {
            // The log keeps the title too, so rebuilding the index does not lose it.
            yield* writeTitle(owner.root, title);
          }
          if (binding.repo !== undefined && binding.baseRef !== undefined) {
            // The log keeps the binding too, so the index and the workspace are derivable from it.
            yield* writeRepoBinding(owner.root, {
              repo: binding.repo,
              baseRef: binding.baseRef,
              ...(binding.branch === undefined
                ? {}
                : { branch: binding.branch }),
            });
          }
          if (input.actor !== undefined) {
            // The log keeps the actor too (LOB-162), so a rebuilt index still knows whose spend
            // this session is.
            yield* writeActor(owner.root, input.actor);
          }
          if (input.taskId !== undefined && column !== undefined) {
            yield* writeTaskBinding(owner.root, {
              taskId: input.taskId,
              column,
            });
          }
          // The cap is the log's (LOB-163): the harness's hook reads it before every request, and a
          // fold reports it. Written before create answers, so no message can start a run under it
          // before it is there.
          const budget = input.budget ?? options.defaultBudget;
          if (budget !== undefined) {
            yield* writeBudget(owner.root, budget);
          }
          // The session exists and its directory is open: the list can show it without a fold.
          yield* touchActivity(id);
          return yield* describe(id, row);
        });

      const get = (
        sessionId: SessionId,
      ): Effect.Effect<SessionSnapshot, SessionError> =>
        Effect.gen(function* () {
          const row = yield* requireSession(sessionId);
          const owners = yield* Ref.get(live);
          const owner = HashMap.get(owners, sessionId);
          if (Option.isSome(owner)) {
            yield* touch(sessionId);
            return yield* readLiveSnapshot(
              owner.value,
              refOf(sessionId, row, owner.value.workspace, owner.value.model),
            );
          }
          const workspace = yield* workspaceFor(row, { cut: false });
          // A fold is also where a replay whose run settled with no comparison written (the process
          // stopped first) is noticed: nobody may open its owner again (LOB-199).
          yield* armComparison(sessionId);
          return yield* withReader(sessionId, (storage) =>
            readHistoricalSnapshot(storage, refOf(sessionId, row, workspace)),
          );
        });

      /**
       * Earlier transcript, read through a reader whether or not this process owns the session: the
       * reader opens from the log's checkpoint (LOB-186) and catches up on what the owner committed,
       * so the page is the log's, and a page costs one scan of its own length (LOB-243).
       */
      const history = (
        input: ReadSessionHistoryInput,
      ): Effect.Effect<SessionHistoryPage, SessionError> =>
        Effect.gen(function* () {
          yield* requireSession(input.sessionId);
          return yield* withReader(input.sessionId, (storage) =>
            readTranscriptPage(storage, {
              before: input.before,
              ...(input.limit === undefined ? {} : { limit: input.limit }),
            }),
          );
        });

      const send = (
        input: SendMessageInput,
      ): Effect.Effect<SendMessageResult, SessionError> =>
        Effect.gen(function* () {
          if (input.content.length > MAX_MESSAGE_CHARS) {
            return yield* new SessionErrorClass({
              code: "invalid_input",
              message: `message is ${input.content.length} characters; the limit is ${MAX_MESSAGE_CHARS}`,
            });
          }

          const row = yield* requireSession(input.sessionId);
          // A released session is refused by the acquisition, from the release it reads under the
          // owners' gate (LOB-268): a check here, on `row`, would miss one that commits in between.
          const owner = yield* acquireOwner(input.sessionId, row, {
            starts: true,
          });

          // The first message names the session when nothing else has.
          const title =
            row.title.length > 0 ? row.title : titleFrom(input.content);
          if (row.title.length === 0) {
            yield* writeTitle(owner.root, title);
            yield* setTitle(input.sessionId, title);
          }

          const submitted = yield* submitMessage(owner.root, {
            content: input.content,
            ...(input.requestId === undefined
              ? {}
              : { requestId: input.requestId }),
            ...(input.whenBusy === undefined
              ? {}
              : { whenBusy: input.whenBusy }),
          });
          yield* touchActivity(input.sessionId);
          const session = yield* describe(input.sessionId, { ...row, title });
          return {
            session,
            submissionId: submitted.submissionId,
            // A queued message joined the queue the caller asked for; Pi Durable's default is a
            // follow-up, and `reject` never queues (it fails the call instead). A placed one
            // started the run.
            placement: submitted.queued
              ? input.whenBusy === "steer"
                ? "steer"
                : "followUp"
              : "run",
          };
        });

      const interrupt = (
        sessionId: SessionId,
      ): Effect.Effect<SessionSummary, SessionError> =>
        Effect.gen(function* () {
          const row = yield* requireSession(sessionId);
          // Steering wakes the session first (D8): acquiring the owner is what waking means here.
          const owner = yield* acquireOwner(sessionId, row);
          yield* interruptConversation(owner.root);
          yield* touchActivity(sessionId);
          return yield* describe(sessionId, row);
        });

      const withdraw = (
        input: WithdrawMessageInput,
      ): Effect.Effect<WithdrawMessageResult, SessionError> =>
        Effect.gen(function* () {
          const row = yield* requireSession(input.sessionId);
          // Only an owner can commit the withdrawal, but one need not be live: `pi.inbox` is
          // durable, so a queue outlives an API restart or the idle sweep's release. When none is,
          // the committed log answers an unknown or finished id first, so a withdraw that changes
          // nothing does not open a workspace, take the log, and start a projector to say so.
          const owners = yield* Ref.get(live);
          if (Option.isNone(HashMap.get(owners, input.sessionId))) {
            const standing = yield* withReader(input.sessionId, (storage) =>
              submissionStanding(storage, input.submissionId),
            );
            if (standing === undefined) {
              return yield* new SessionErrorClass({
                code: "not_found",
                message: `submission ${input.submissionId} is not in this session`,
              });
            }
            if (standing === "settled") {
              return {
                session: yield* describe(input.sessionId, row),
                submissionId: input.submissionId,
                outcome: "settled" as const,
              };
            }
          }
          const owner = yield* acquireOwner(input.sessionId, row);
          const outcome = yield* withdrawMessage(
            owner,
            owner.storage,
            input.submissionId,
          );
          yield* touchActivity(input.sessionId);
          return {
            session: yield* describe(input.sessionId, row),
            submissionId: input.submissionId,
            outcome,
          };
        });

      /**
       * Open the session's PR, or hand back the one its log already records.
       *
       * The owner is what makes the step able to commit the document at all (Pi Durable allows one
       * owner per log), and the body's session block is filled from what the log says the session
       * did rather than from the caller: the model that spent the most, and the total. The owner's
       * workspace is what the step measures the branch in, and the configured cap is passed with it
       * (LOB-227).
       *
       * The step runs inside the PR gate and answers its exit with the owner's log; `openPr` reports
       * that exit once the gate is released (LOB-15).
       */
      const stepPr = (input: OpenPullRequestArgs) =>
        prGate.withPermits(1)(
          Effect.gen(function* () {
            const row = yield* requireSession(input.sessionId);
            const repo =
              row.repo === null ? undefined : yield* toRepoSlug(row.repo);
            if (repo === undefined) {
              return yield* new SessionErrorClass({
                code: "invalid_input",
                message: `session ${input.sessionId} is bound to no repo, so it has no PR to open`,
              });
            }
            const owner = yield* acquireOwner(input.sessionId, row);
            // The branches come from the session unless an in-process caller named them; the wire
            // never does (LOB-213). Checked here rather than trusted: both reach git's argv.
            const head =
              input.head ??
              owner.workspace.branch ??
              `factory/${input.sessionId}`;
            const base =
              input.base ?? owner.workspace.baseRef ?? row.baseRef ?? "main";
            for (const [name, ref] of [
              ["head", head],
              ["base", base],
            ] as const) {
              if (!isSafeBranchName(ref)) {
                return yield* new SessionErrorClass({
                  code: "invalid_input",
                  message: `session ${input.sessionId}: ${name} '${ref}' is not a branch name the PR step will pass to git`,
                });
              }
            }
            yield* touch(input.sessionId);
            const snapshot = yield* readLiveSnapshot(
              owner,
              refOf(input.sessionId, row, owner.workspace, owner.model),
            );
            const model = snapshot.usage.models.reduce<
              (typeof snapshot.usage.models)[number] | undefined
            >(
              (costliest, candidate) =>
                costliest === undefined ||
                candidate.usage.costTotal > costliest.usage.costTotal
                  ? candidate
                  : costliest,
              undefined,
            );
            const stepped = yield* openPullRequest({
              harness: owner.harness,
              conversation: owner.root,
              sessionId: input.sessionId,
              repo,
              title: input.title,
              head,
              base,
              // The branch is measured where it was cut: the session's own working directory.
              worktree: owner.workspace.path,
              cap: options.prCap ?? DEFAULT_DIFF_CAP,
              // The title is the session's own first line, which is the prompt a PR body carries.
              prompt: row.title,
              ...(model === undefined ? {} : { model: model.key }),
              spend: `$${costOf(snapshot.usage).toFixed(2)}`,
            }).pipe(
              // The step writes the index row through `SqlClient`, which this layer already holds:
              // it is not a requirement of the session service, so it does not leave through this
              // method's type.
              Effect.provideService(SqlClient, sql),
              Effect.exit,
            );
            if (Exit.isSuccess(stepped)) yield* touchActivity(input.sessionId);
            return { stepped, storage: owner.storage };
          }),
        );

      /**
       * The PR step, and its exit reported to the write-back. Every exit is reported — the PR, a
       * refusal, an error — so a tracker can mirror it (LOB-15). The report runs outside the gate:
       * the gate is every session's, and a tracker slow to answer must not hold up another session's
       * PR.
       *
       * The port promises not to fail or stall the step; this is where that promise is kept rather
       * than trusted. The report has a total budget (`writeBackBudget`) — an implementation's own
       * per-request timeouts and retries can add up to more than a caller should wait — and any
       * failure or defect it raises is logged, never the step's. Its writes are idempotent, so a
       * report cut short is completed by the next one.
       */
      const openPr = (
        input: OpenPullRequestArgs,
      ): Effect.Effect<
        PullRequestStep,
        SessionError | PrError | CredentialError,
        CredentialProvider | HttpClient.HttpClient
      > =>
        Effect.gen(function* () {
          const { stepped, storage } = yield* stepPr(input);
          yield* writeBack
            .pullRequest({
              sessionId: input.sessionId,
              result: stepped,
              evidence: readVerifyRecords(storage).pipe(
                // A log that cannot be read is said, not passed off as "no verification recorded".
                Effect.tapError((error) =>
                  Effect.logWarning(
                    `session ${input.sessionId}: could not read its verify records for the write-back: ${error.message}`,
                  ),
                ),
                Effect.orElseSucceed(() => []),
              ),
            })
            .pipe(
              Effect.timeoutOrElse({
                duration: writeBackBudget,
                orElse: () =>
                  Effect.logWarning(
                    `session ${input.sessionId}: the PR step's write-back did not finish within ${Duration.toMillis(writeBackBudget)}ms; the step answers without it`,
                  ),
              }),
              Effect.catchCause((cause) =>
                Effect.logError(
                  `session ${input.sessionId}: the PR step's write-back failed; the step answers without it: ${Cause.pretty(cause)}`,
                ),
              ),
            );
          return yield* stepped;
        });

      /**
       * Fork a session at one of its entries (LOB-180, D7).
       *
       * A session *is* a log, so the fork is a second log with the parent's entries copied into it
       * before anyone can read it: `forkSession` copies them in one commit and this method registers
       * the new log only after that commit succeeded. The fork's transcript is the parent's prefix
       * and nothing else — no title entry of its own, so a fork taken at the parent's last entry has
       * exactly the parent's entries.
       *
       * The parent is read in reader mode whether or not this process owns it: a fork must not take
       * ownership of the log it copies from, and a reader never does.
       */
      const fork = (
        input: ForkSessionInput,
      ): Effect.Effect<SessionSummary, SessionError> =>
        Effect.gen(function* () {
          const parent = yield* requireSession(input.sessionId);
          const id = yield* mintSessionId;
          // A fork works where its parent worked: the same transcript reopened against another repo
          // would be a history that never happened.
          const binding: Binding = {
            ...(parent.repo === null
              ? {}
              : { repo: yield* toRepoSlug(parent.repo) }),
            ...(parent.baseRef === null ? {} : { baseRef: parent.baseRef }),
          };
          // The index row is written first, as `create` writes it, so the fork exists for a retried
          // read the moment its log does; a failure between the two leaves a row whose log is empty,
          // and `rebuildIndexes` removes a row with no log rather than trusting it.
          const inserted = yield* paper(
            "create session",
            insertSession(
              id,
              parent.title,
              undefined,
              binding,
              input.sessionId,
              parent.actor,
            ),
          );
          const row = inserted[0] ?? {
            id,
            title: parent.title,
            repo: parent.repo,
            baseRef: parent.baseRef,
            branch: null,
            prUrl: null,
            forkedFrom: input.sessionId,
            actor: parent.actor,
            createdAt: "",
            workspaceReleasedAt: null,
            workspaceReleaseReason: null,
            model: null,
          };
          // The entries, the lineage and the repo binding land in one commit: a fork that exists
          // at all exists with everything `rebuildIndexes` folds, so there is no window in which a
          // read shows a fork whose parent the index cannot name. A fork refused after its row was
          // written (`at` names no entry of the parent, say) removes that row again: an index row
          // with no log is invisible to the list — which joins the activity index — and would wait
          // for a rebuild to be swept, so it is not left behind.
          yield* acquireOwnerWith(
            id,
            row,
            ({ storage, cwd, policy: sessionPolicy, run, pages, verify }) =>
              Effect.acquireUseRelease(
                openStorage(input.sessionId, "reader"),
                (parentStorage) =>
                  forkSession({
                    parent: parentStorage,
                    child: storage,
                    ...(input.at === undefined ? {} : { at: input.at }),
                    lineage: input.sessionId,
                    run,
                    pages,
                    verify,
                    approvalAsker: askerFor(id),
                    ...(binding.repo === undefined ||
                    binding.baseRef === undefined
                      ? {}
                      : {
                          binding: {
                            repo: binding.repo,
                            baseRef: binding.baseRef,
                          },
                        }),
                    // A fork continues its parent's work, so its spend is the parent's actor's
                    // (LOB-162), committed with the lineage.
                    ...(parent.actor === null ? {} : { actor: parent.actor }),
                    model: options.model,
                    cwd,
                    ...(options.sandbox === undefined
                      ? {}
                      : { sandbox: options.sandbox }),
                    policy: sessionPolicy,
                    // A fork keeps its parent's cap and carries its spend; an uncapped parent's
                    // fork gets the default a create would (LOB-163).
                    ...(options.defaultBudget === undefined
                      ? {}
                      : { defaultBudget: options.defaultBudget }),
                  }),
                (parentStorage) =>
                  Effect.promise(() => parentStorage.dispose()),
              ).pipe(
                Effect.tapError(() =>
                  paper(
                    "remove the refused fork's index row",
                    sql`DELETE FROM sessions WHERE id = ${id}`,
                  ).pipe(Effect.ignore),
                ),
              ),
          );
          yield* touchActivity(id);
          return yield* describe(id, row);
        });

      /**
       * Replay a session against another model (LOB-198).
       *
       * The one thing a replay changes is the model, so that is the one thing this method resolves
       * beyond the source: `model` names a `provider/modelId` in the catalog this process was built
       * with, and a name it does not hold is refused rather than quietly served by the default.
       *
       * The source is read through a reader and only read, and it is read *first*, so the two
       * refusals a replay can earn (no prompt to replay, no repo to replay into) leave nothing
       * behind: no index row, no log. That is why the row is not written before the source is read
       * as the fork's is — a fork cannot refuse, because any entry id it is given either names a
       * parent entry or is a mistake, both of which are decided by the copy.
       */
      const replay = (
        input: ReplaySessionInput,
      ): Effect.Effect<SessionSummary, SessionError> =>
        Effect.gen(function* () {
          const source = yield* requireSession(input.sessionId);
          const target = (yield* sessionModelFor(input.model)) ?? options.model;
          const origin = yield* withReader(input.sessionId, readReplaySource);
          const binding: Binding = {
            repo: yield* toRepoSlug(origin.binding.repo),
            ...(origin.binding.baseRef === ""
              ? {}
              : { baseRef: origin.binding.baseRef }),
          };
          const id = yield* mintSessionId;
          const inserted = yield* paper(
            "create session",
            insertSession(
              id,
              source.title,
              undefined,
              binding,
              null,
              source.actor,
            ),
          );
          const row = inserted[0] ?? {
            id,
            title: source.title,
            repo: binding.repo ?? null,
            baseRef: binding.baseRef ?? null,
            branch: null,
            prUrl: null,
            forkedFrom: null,
            actor: source.actor,
            createdAt: "",
            workspaceReleasedAt: null,
            workspaceReleaseReason: null,
            model: null,
          };
          // The replay's transcript is its own run, so nothing is copied in: the log opens empty,
          // the title and the binding are written with the lineage, and the source's prompt is what
          // starts it. A failure after the row is written removes the row again — an index row with
          // no log is invisible to the list and would wait for a rebuild to be swept (as a refused
          // fork's does).
          yield* acquireOwnerWith(
            id,
            row,
            ({ storage, cwd, policy: sessionPolicy, run, verify }) =>
              replaySession({
                source: origin,
                sourceId: input.sessionId,
                replayId: id,
                target: storage,
                model: target,
                title: source.title,
                // A replay is its source's task run again, so its spend is the source's actor's
                // (LOB-162), committed with the lineage.
                ...(source.actor === null ? {} : { actor: source.actor }),
                cwd,
                ...(options.sandbox === undefined
                  ? {}
                  : { sandbox: options.sandbox }),
                policy: sessionPolicy,
                run,
                verify,
                approvalAsker: askerFor(id),
                // A replay keeps its source's cap, at no spend; an uncapped source's replay gets
                // the default a create would (LOB-163).
                ...(options.defaultBudget === undefined
                  ? {}
                  : { defaultBudget: options.defaultBudget }),
              }),
          ).pipe(
            Effect.tapError(() =>
              paper(
                "remove the refused replay's index row",
                sql`DELETE FROM sessions WHERE id = ${id}`,
              ).pipe(Effect.ignore),
            ),
          );
          // The prompt is admitted, so the run is under way: opening the owner armed the comparison
          // (`reconcileReplay`), which waits for it in the background, and the caller gets the replay
          // now, as it always has.
          yield* touchActivity(id);
          return yield* describe(id, row);
        });

      /**
       * Bring one replay's comparison up to date with its logs (LOB-199): what is owed is read off
       * the two `factory.replay` documents, never held in this process, so the same step serves the
       * replay's first open, an owner reopened after a restart, and a fold of a replay whose
       * comparison a process that stopped never wrote.
       *
       * - Not a replay, or its own log already names its source: nothing is owed. The replay's side
       *   is written last, so it holding one means both do.
       * - The source holds the comparison and the replay does not (a write cut short): the replay
       *   gets the mirror of the source's, so the two still come from one reading.
       * - Neither does: once the replay's task has settled, both runs are read *after* the settle and
       *   compared once, and the source's side is committed, then the replay's. A task still running
       *   is waited for when this process owns the replay, and otherwise left: nothing runs a task
       *   without an owner, and the owner that resumes it arms this again.
       *
       * Each write goes through this process's owner of that session, opened if nobody here holds
       * it, as any write to a log is — the source's included, which reopens its workspace and counts
       * as activity on it, the same as any other write to a released session. What it writes is the
       * `factory.replay` document alone. A failure is a warning in the process's log, not a failed
       * replay; the next owner or fold of the replay tries again.
       */
      const reconcileReplay = (replay: SessionId): Effect.Effect<void> =>
        Effect.gen(function* () {
          const document = yield* withReader(replay, readReplayDocument);
          const link = document.link;
          if (link === undefined || !Schema.is(SessionIdSchema)(link.source))
            return;
          const source = link.source;
          if (
            document.comparisons.some(
              (comparison) => comparison.counterpart.session === source,
            )
          )
            return;
          const onSource = (yield* withReader(
            source,
            readReplayDocument,
          )).comparisons.find(
            (comparison) => comparison.counterpart.session === replay,
          );
          if (onSource !== undefined) {
            yield* commitComparison(replay, mirrorComparison(onSource));
            return;
          }
          const owner = HashMap.get(yield* Ref.get(live), replay);
          if (Option.isSome(owner)) {
            const prompt = yield* withReader(replay, (storage) =>
              readPromptSubmission(storage, undefined),
            );
            if (prompt !== undefined) {
              yield* waitForPrompt(owner.value.harness, prompt);
            }
          }
          const replayRun = yield* withReader(replay, (storage) =>
            readReplayRun(storage, replay, link.model),
          );
          if (replayRun.outcome === "open") return;
          const sourceRun = yield* withReader(source, (storage) =>
            readReplayRun(storage, source, link.from),
          );
          const at = DateTime.formatIso(yield* DateTime.now);
          const compared = compareReplay({
            source: sourceRun,
            replay: replayRun,
            at,
          });
          yield* commitComparison(source, compared.source);
          yield* commitComparison(replay, compared.replay);
        }).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.void
              : Effect.logWarning(
                  `replay ${replay} was not compared: ${Cause.pretty(cause)}`,
                ),
          ),
        );

      /**
       * Commit one side's comparison through this process's owner of that session. A short bounded
       * retry, because the write is keyed by its counterpart and so safe to repeat, and a transient
       * failure would otherwise wait for the next owner or fold of the replay to be repaired.
       */
      const commitComparison = (
        sessionId: SessionId,
        comparison: ReplayComparison,
      ): Effect.Effect<void, SessionError> =>
        Effect.gen(function* () {
          const owner = yield* acquireOwner(
            sessionId,
            yield* requireSession(sessionId),
          );
          yield* writeReplayComparison(owner.root, comparison);
        }).pipe(
          Effect.retry({
            schedule: Schedule.exponential("100 millis"),
            times: 2,
          }),
        );

      /** Start `reconcileReplay` for a session unless one is already running for it. */
      const armComparison = (sessionId: SessionId): Effect.Effect<void> =>
        Effect.asVoid(
          FiberMap.run(comparisons, sessionId, reconcileReplay(sessionId), {
            onlyIfMissing: true,
          }),
        );

      /**
       * A reset starts a new model context (LOB-181). It is committed to the log, not held in this
       * process, so a released session resets the same way a owned one does — and the entry it
       * appends is what the transcript shows as the boundary. An empty handoff is no handoff: a
       * context that opens with a blank message is worse than one that opens with nothing.
       */
      const reset = (
        input: ResetSessionInput,
      ): Effect.Effect<SessionSummary, SessionError> =>
        Effect.gen(function* () {
          const row = yield* requireSession(input.sessionId);
          const handoff = input.handoff?.trim();
          const owner = yield* acquireOwner(input.sessionId, row, {
            starts: true,
          });
          yield* resetSession(
            owner.root,
            handoff === undefined || handoff === "" ? undefined : handoff,
          );
          yield* touchActivity(input.sessionId);
          return yield* describe(input.sessionId, row);
        });

      /**
       * A manual compaction (B4). The task is what does the work — it summarizes the oldest part of
       * the model context and places the summary as the new head — so this call only admits it:
       * the session may be idle, in which case the summary lands at once, or running, in which case
       * it lands at the next boundary. Either way the transcript keeps everything.
       */
      const compact = (
        input: CompactSessionInput,
      ): Effect.Effect<CompactSessionResult, SessionError> =>
        Effect.gen(function* () {
          const row = yield* requireSession(input.sessionId);
          const instructions = input.instructions?.trim();
          const owner = yield* acquireOwner(input.sessionId, row);
          const taskId = yield* compactSession(
            owner.root,
            instructions === undefined || instructions === ""
              ? undefined
              : instructions,
          );
          yield* touchActivity(input.sessionId);
          const session = yield* describe(input.sessionId, row);
          return { session, taskId };
        });

      /**
       * Hold every worker's `check` to the decision an agent's `bash` call gets (D11, D15), before any
       * task exists.
       *
       * A check is a shell command the client supplies, and the worker runs it unattended in the
       * session's worktree through the execution environment — not through a tool call, so the
       * policy hooks never see it (LOB-193 review). Deciding it here, with the session's own policy
       * for its worktree, means a mission can run no command its session's agent could not: a write
       * outside the worktree, egress past the allowlist, a push to another branch are refused as
       * they would be for `bash`. A gated command is refused too rather than parked: nobody is
       * there to approve a check, and a check that waits on a person is not one a join can read.
       */
      const refuseUnpolicedChecks = (
        sessionId: SessionId,
        worktree: string,
        workers: readonly MissionWorker[],
      ): Effect.Effect<void, SessionError> =>
        Effect.gen(function* () {
          const sessionPolicy = policy.forWorktree(worktree, sessionId);
          for (const worker of workers) {
            if (worker.check === undefined) continue;
            if (worker.check.trim() === "")
              return yield* new SessionErrorClass({
                code: "invalid_input",
                message: `the mission worker "${worker.id}" declares an empty check`,
              });
            const decision = yield* sessionPolicy.decide({
              type: "toolCall",
              id: `factory.mission.check:${worker.id}`,
              name: "bash",
              arguments: { command: worker.check },
            });
            if (decision._tag === "block")
              return yield* new SessionErrorClass({
                code: "invalid_input",
                message: `the mission worker "${worker.id}"'s check is refused: ${decision.reason}`,
              });
            if (decision._tag === "ask")
              return yield* new SessionErrorClass({
                code: "invalid_input",
                message: `the mission worker "${worker.id}"'s check needs a person's approval (${decision.action}), and a check runs unattended`,
              });
          }
        });

      /**
       * Start a mission: one feature taken through plan, implement and verify as one durable task
       * (LOB-230, part 2 of LOB-192).
       *
       * The call admits the task and answers its id; the phase it reaches is read off the session's
       * snapshot, where the mission's committed document reports it. The workspace is resolved here
       * rather than sent by the client, so a mission can only run where its session runs — the same
       * rule verify follows when it runs the repo's own command.
       *
       * An empty feature is refused rather than started: a mission's feature is the one thing its
       * phases and its result are about, and a blank one would settle a result nobody can read.
       * Workers (LOB-193) are refused the same way, before a task exists: a worker with no id or no
       * prompt, or two that share an id, would fan out into work nobody can attribute.
       */
      const startMission = (
        input: StartMissionInput,
      ): Effect.Effect<StartMissionResult, SessionError> =>
        Effect.gen(function* () {
          const feature = input.feature.trim();
          if (feature === "") {
            return yield* new SessionErrorClass({
              code: "invalid_input",
              message: "a mission needs a non-empty feature",
            });
          }
          const workers = (input.workers ?? []).map((worker) => ({
            ...worker,
            id: worker.id.trim(),
          }));
          const ids = new Set<string>();
          for (const worker of workers) {
            if (worker.id === "" || worker.prompt.trim() === "") {
              return yield* new SessionErrorClass({
                code: "invalid_input",
                message: "a mission worker needs a non-empty id and prompt",
              });
            }
            if (ids.has(worker.id)) {
              return yield* new SessionErrorClass({
                code: "invalid_input",
                message: `two mission workers are named "${worker.id}"`,
              });
            }
            ids.add(worker.id);
          }
          const row = yield* requireSession(input.sessionId);
          yield* refuseReleased(row);
          // The checks are policed against the worktree's path, which needs no worktree: the one the
          // mission runs in is the owner's, cut under the gate.
          const planned = yield* workspaceFor(row, { cut: false });
          yield* refuseUnpolicedChecks(input.sessionId, planned.path, workers);
          const owner = yield* acquireOwner(input.sessionId, row, {
            starts: true,
          });
          // Resolved again now the owner's worktree exists, so the commands are the ones it holds.
          const workspace = yield* workspaceFor(row, { cut: false });
          // Marked before the mission exists rather than after, so a process stopped the moment the
          // start commits still finds it at its next boot. The projection settles the row from the
          // graph from then on: a mission that settles before this call returns is cleared by it,
          // and a start that fails leaves a mark the next boot clears.
          yield* setMissionInFlight(input.sessionId, true);
          const taskId = yield* beginMission(owner, {
            feature,
            workspace: {
              path: workspace.path,
              commands: workspace.commands,
              commandsSource: workspace.commandsSource,
            },
            ...(workers.length === 0 ? {} : { workers }),
            ...(input.join === undefined ? {} : { join: input.join }),
          });
          yield* touchActivity(input.sessionId);
          return { sessionId: input.sessionId, taskId };
        });

      /** Serializes approval writes so a repeated request id cannot commit twice. */
      const approvalGate = yield* Semaphore.make(1);

      const requireRequestId = (
        requestId: string,
      ): Effect.Effect<void, SessionError> =>
        requestId.trim().length === 0
          ? Effect.fail(
              new SessionErrorClass({
                code: "invalid_input",
                message: "an approval needs a non-empty requestId",
              }),
            )
          : Effect.void;

      /**
       * The row a session's approvals live in, read back as the contract names it. One request id
       * is one row, so a repeated request reads the row the first one wrote rather than appending
       * a second entry: the idempotency is the primary key, not an in-memory set that a restart
       * would empty (LOB-147).
       */
      const approvalRow = (sessionId: SessionId, requestId: string) =>
        sql<ApprovalRow>`
          SELECT
            request_id,
            action,
            detail,
            to_char(requested_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS requested_at,
            decision,
            actor,
            to_char(decided_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS decided_at,
            to_char(used_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS used_at
          FROM session_approvals
          WHERE session_id = ${sessionId} AND request_id = ${requestId}
        `;

      const toApprovalRecord = (
        sessionId: SessionId,
        row: ApprovalRow,
      ): ApprovalRecord => ({
        request: {
          sessionId,
          requestId: row.requestId,
          action: row.action,
          detail: row.detail,
          requestedAt: row.requestedAt,
        },
        used: row.usedAt !== null,
        ...(row.decision === null ||
        row.actor === null ||
        row.decidedAt === null
          ? {}
          : {
              decision: {
                sessionId,
                requestId: row.requestId,
                decision: row.decision === "approved" ? "approved" : "denied",
                actor: row.actor,
                decidedAt: row.decidedAt,
              },
            }),
      });

      const recordOf = (
        sessionId: SessionId,
        requestId: string,
      ): Effect.Effect<ApprovalRecord | undefined, SessionError> =>
        Effect.map(
          paper("read approval", approvalRow(sessionId, requestId)),
          (rows) => {
            const row = rows[0];
            return row === undefined
              ? undefined
              : toApprovalRecord(sessionId, row);
          },
        );

      /**
       * Record a request under `approvalGate`, which the caller holds. A request id already recorded
       * records nothing and answers the record it has, decision and all, so a caller that raced a
       * decision reads that decision rather than a stale "pending".
       */
      const recordRequestLocked = (
        input: RequestApprovalInput,
        row: SessionRow,
      ): Effect.Effect<
        { readonly record: ApprovalRecord; readonly fresh: boolean },
        SessionError
      > =>
        Effect.gen(function* () {
          const known = yield* recordOf(input.sessionId, input.requestId);
          if (known !== undefined) return { record: known, fresh: false };
          const owner = yield* acquireOwner(input.sessionId, row);
          const requestedAt = DateTime.formatIso(yield* DateTime.now);
          const request: ApprovalRequest = {
            sessionId: input.sessionId,
            requestId: input.requestId,
            action: input.action,
            detail: input.detail ?? "",
            requestedAt,
          };
          yield* paper(
            "record approval request",
            writeApprovalRequested(owner.root, {
              requestId: request.requestId,
              action: request.action,
              detail: request.detail,
              requestedAt,
            }),
          );
          // The row is the index of the entry just committed, not a second record: written
          // after it, so a crash between the two leaves the log (the truth) without a row a
          // rebuild cannot recover — never a row that claims a request no log holds. The cost
          // of that order is the other side of it: a retry after such a crash finds no row and
          // commits the request again, so the log can hold the same request id twice. That is
          // why the fold, not the writer, makes the id the identity (`projectApprovals`) — a
          // duplicate costs one log line, not a second pending approval.
          yield* paper(
            "index approval request",
            sql`
              INSERT INTO session_approvals (session_id, request_id, action, detail, requested_at)
              VALUES (${input.sessionId}, ${request.requestId}, ${request.action}, ${request.detail}, ${requestedAt}::timestamptz)
              ON CONFLICT (session_id, request_id) DO NOTHING
            `,
          );
          yield* touchActivity(input.sessionId);
          return { record: { request, used: false }, fresh: true };
        });

      const requestApproval = (
        input: RequestApprovalInput,
      ): Effect.Effect<ApprovalRequest, SessionError> =>
        Effect.gen(function* () {
          yield* requireRequestId(input.requestId);
          const row = yield* requireSession(input.sessionId);
          const recorded = yield* approvalGate.withPermits(1)(
            recordRequestLocked(input, row),
          );
          return recorded.record.request;
        });

      /**
       * Spend an approval (LOB-52): a gated call is about to run on it. The log entry first, then
       * the index, the order `recordRequestLocked` keeps and for the same reason — a crash between
       * the two leaves the use in the log, which a rebuild folds into the row.
       */
      const markUsedLocked = (
        sessionId: SessionId,
        requestId: string,
        row: SessionRow,
      ): Effect.Effect<void, SessionError> =>
        Effect.gen(function* () {
          const owner = yield* acquireOwner(sessionId, row);
          const usedAt = DateTime.formatIso(yield* DateTime.now);
          yield* paper(
            "record approval use",
            writeApprovalUsed(owner.root, { requestId, usedAt }),
          );
          yield* paper(
            "spend approval",
            sql`
              UPDATE session_approvals
              SET used_at = ${usedAt}::timestamptz
              WHERE session_id = ${sessionId} AND request_id = ${requestId}
                AND decision = 'approved' AND used_at IS NULL
            `,
          );
        });

      /**
       * The request id of the `use`-th run of one gated call: the call's own id for the first, and
       * `<id>-<use>` after it, so every run that needs a person is a request of its own in the log
       * and the pending list.
       */
      const useRequestId = (requestId: string, use: number): string =>
        use === 1 ? requestId : `${requestId}-${use}`;

      /**
       * The session's runtime services, captured once, so an ask that runs inside a Pi Durable hook
       * — a bare `Effect.runPromise` with none of its own — still exports its span and logs to the
       * tracer and logger the API was built with (motel).
       */
      const askServices = yield* Effect.context<never>();

      /**
       * A session's approval channel (D15, LOB-52): a gated tool call asks through the same approvals
       * service the RPC group uses, so the request is one row and one log entry whether a caller
       * asked over RPC or the agent hit a gate.
       *
       * An approval covers one run of the call. The asker walks the call's requests in order — its
       * own id, then `<id>-2`, `<id>-3`, … — and answers from the first that is not spent: one still
       * pending answers `pending` and records nothing; a denied one answers `denied` (a denial
       * stands for that exact call); an approved, unused one is spent here and answers `approved`;
       * and when every request is spent, the next one is recorded and answers a fresh `pending`. So
       * the agent retrying an approved call runs it once, and the run after that asks a person again.
       *
       * The whole walk holds `approvalGate`, the permit `decideApproval` takes, so a decision cannot
       * land between the read and the record, and two attempts cannot spend one approval.
       */
      const askerFor =
        (sessionId: SessionId): ApprovalAsker =>
        (ask) =>
          Effect.gen(function* () {
            const row = yield* requireSession(sessionId);
            return yield* approvalGate.withPermits(1)(
              Effect.gen(function* () {
                for (let use = 1; ; use += 1) {
                  const requestId = useRequestId(ask.requestId, use);
                  const { record, fresh } = yield* recordRequestLocked(
                    {
                      sessionId,
                      requestId,
                      action: ask.action,
                      detail: ask.detail,
                    },
                    row,
                  );
                  const decision = record.decision;
                  if (decision === undefined) {
                    return {
                      _tag: "pending",
                      requestId,
                      fresh,
                    } satisfies ApprovalAnswer;
                  }
                  if (decision.decision === "denied") {
                    return {
                      _tag: "denied",
                      requestId,
                      actor: decision.actor,
                    } satisfies ApprovalAnswer;
                  }
                  if (!record.used) {
                    yield* markUsedLocked(sessionId, requestId, row);
                    yield* Effect.logInfo(
                      `approval ${requestId} spent on a gated call`,
                    );
                    return {
                      _tag: "approved",
                      requestId,
                      actor: decision.actor,
                    } satisfies ApprovalAnswer;
                  }
                }
              }),
            );
          }).pipe(
            Effect.withSpan("SessionService.askApproval", {
              attributes: { sessionId, requestId: ask.requestId },
            }),
            // The hook has nowhere to put an error: an ask that could not be recorded never
            // happened, so the gated call stays blocked, nothing is memoized, and the next
            // attempt asks again. Logged, so the failure is in motel and not only in the
            // sentence the model reads.
            Effect.catch((error) =>
              Effect.as(
                Effect.logWarning(
                  `approval ask ${ask.requestId} could not be recorded: ${error.message}`,
                ),
                {
                  _tag: "unrecorded",
                  reason: error.message,
                } satisfies ApprovalAnswer,
              ),
            ),
            Effect.provideContext(askServices),
          );

      const decideApproval = (
        input: DecideApprovalInput,
      ): Effect.Effect<DecideApprovalOutput, SessionError> =>
        Effect.gen(function* () {
          yield* requireRequestId(input.requestId);
          if (input.actor.trim().length === 0) {
            return yield* new SessionErrorClass({
              code: "invalid_input",
              message: "a decision needs the actor who made it",
            });
          }
          const row = yield* requireSession(input.sessionId);
          const settled = yield* approvalGate.withPermits(1)(
            Effect.gen(function* () {
              const known = yield* recordOf(input.sessionId, input.requestId);
              if (known === undefined) {
                return yield* new SessionErrorClass({
                  code: "not_found",
                  message: `no approval ${input.requestId} in ${input.sessionId}`,
                });
              }
              if (known.decision !== undefined) {
                if (
                  known.decision.decision === input.decision &&
                  known.decision.actor === input.actor
                ) {
                  return { request: known.request, decision: known.decision };
                }
                return yield* new SessionErrorClass({
                  code: "invalid_input",
                  message: `approval ${input.requestId} was already ${known.decision.decision} by ${known.decision.actor}`,
                });
              }
              const owner = yield* acquireOwner(input.sessionId, row);
              const decidedAt = DateTime.formatIso(yield* DateTime.now);
              const decision: ApprovalDecision = {
                sessionId: input.sessionId,
                requestId: input.requestId,
                decision: input.decision,
                actor: input.actor,
                decidedAt,
              };
              yield* paper(
                "record approval decision",
                writeApprovalDecided(owner.root, {
                  requestId: input.requestId,
                  decision: input.decision,
                  actor: input.actor,
                  decidedAt,
                }),
              );
              yield* paper(
                "settle approval",
                sql`
                  UPDATE session_approvals
                  SET decision = ${input.decision},
                      actor = ${input.actor},
                      decided_at = ${decidedAt}::timestamptz
                  WHERE session_id = ${input.sessionId} AND request_id = ${input.requestId}
                `,
              );
              yield* touchActivity(input.sessionId);
              return { request: known.request, decision };
            }),
          );
          if (input.resume !== true) return settled.decision;
          // Outside the permit: the run this wakes may hit the same gate, and its ask takes it.
          // The decision is already committed, so a failed send is not a failed decision: the call
          // answers the decision with `resumeFailed`, and the caller says "recorded, not resumed".
          // Repeating the decision is idempotent and resends under the same request id.
          const sent = yield* send({
            sessionId: input.sessionId,
            content: approvalResumeMessage(settled.request, settled.decision),
            requestId: approvalResumeRequestId(input.requestId),
          }).pipe(
            Effect.map((result) => ({ ok: true as const, result })),
            Effect.catch((error: SessionError) =>
              Effect.succeed({ ok: false as const, error }),
            ),
          );
          if (!sent.ok) {
            yield* Effect.logWarning(
              `approval ${input.requestId} ${settled.decision.decision} is recorded, but the session was not resumed: ${sent.error.code}: ${sent.error.message}`,
            );
            return {
              ...settled.decision,
              resumeFailed: {
                code: sent.error.code,
                message: sent.error.message,
              },
            };
          }
          yield* Effect.logInfo(
            `approval ${input.requestId} ${settled.decision.decision}; session resumed with submission ${sent.result.submissionId} (${sent.result.placement})`,
          );
          return { ...settled.decision, resumedWith: sent.result.submissionId };
        });

      /**
       * The requests still waiting for a decision, oldest first. One statement over the index and
       * no fold: the list a dashboard shows is what the row is for, and it survives a restart
       * because the row was written when the request was committed (LOB-147). `requested_at`,
       * then `request_id`, is the order the log fold produces too, so a snapshot and this answer
       * agree once the row is written.
       */
      const listApprovals = (
        sessionId: SessionId,
      ): Effect.Effect<ListApprovalsOutput, SessionError> =>
        Effect.gen(function* () {
          yield* requireSession(sessionId);
          const rows = yield* paper(
            "list approvals",
            sql<ApprovalRow>`
              SELECT
                request_id,
                action,
                detail,
                to_char(requested_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS requested_at,
                decision,
                actor,
                to_char(decided_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS decided_at,
                to_char(used_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS used_at
              FROM session_approvals
              WHERE session_id = ${sessionId} AND decision IS NULL
              ORDER BY requested_at, request_id
            `,
          );
          return {
            approvals: rows.map(
              (row) => toApprovalRecord(sessionId, row).request,
            ),
          };
        });

      /**
       * Every session's pending requests (LOB-53): the same index `listApprovals` reads, without the
       * session filter, so the operator's inbox is one statement however many sessions are waiting.
       *
       * Newest first, then by session and request id, which is a total order a page can stop at. A
       * pending row never expires — an abandoned session's ask waits forever — so oldest first would
       * let enough stale asks push a run that parked just now off the page. `total` is the window
       * count over every pending row (computed before the `LIMIT`), so a reader can tell a cut page
       * from the whole list.
       */
      const listPendingApprovals = (
        input: ListPendingApprovalsInput,
      ): Effect.Effect<ListPendingApprovalsOutput, SessionError> =>
        Effect.gen(function* () {
          const limit = Math.min(
            Math.max(input.limit ?? MAX_PAGE_SIZE, 1),
            MAX_PAGE_SIZE,
          );
          const rows = yield* paper(
            "list pending approvals",
            sql<
              ApprovalRow & {
                readonly sessionId: string;
                readonly total: number | string;
              }
            >`
              SELECT
                COUNT(*) OVER () AS total,
                session_id,
                request_id,
                action,
                detail,
                to_char(requested_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS requested_at,
                decision,
                actor,
                to_char(decided_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS decided_at,
                to_char(used_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS used_at
              FROM session_approvals
              WHERE decision IS NULL
              ORDER BY requested_at DESC, session_id DESC, request_id DESC
              LIMIT ${limit}
            `,
          );
          const approvals: ApprovalRequest[] = [];
          for (const row of rows) {
            const sessionId = yield* toSessionId(row.sessionId);
            approvals.push(toApprovalRecord(sessionId, row).request);
          }
          // `COUNT(*)` is a bigint, which the driver may hand back as a string.
          return { approvals, total: Number(rows[0]?.total ?? 0) };
        });

      const recordActivity = (
        sessionId: SessionId,
        event: SessionEvent,
      ): Effect.Effect<void> => {
        switch (event._tag) {
          case "status":
            return setActivityStatus(sessionId, event.status);
          case "usage":
            return setActivityCost(sessionId, costOf(event.usage));
          case "entry":
            // A budget stop (LOB-163) is also a log line, so an operator reading the process's logs
            // — or motel — sees which session the cap stopped, not only a client watching it.
            return event.entry.kind === "budget"
              ? Effect.logWarning(
                  `session ${sessionId} stopped by its budget: ${event.entry.text}`,
                ).pipe(Effect.andThen(touchActivity(sessionId)))
              : touchActivity(sessionId);
          case "snapshot":
            return setActivityStatus(sessionId, event.session.status).pipe(
              Effect.andThen(
                setMissionInFlight(sessionId, hasLiveMission(event.tasks)),
              ),
              Effect.andThen(touchActivity(sessionId)),
            );
          case "tasks":
            return setMissionInFlight(
              sessionId,
              hasLiveMission(event.tasks),
            ).pipe(Effect.andThen(touchActivity(sessionId)));
          default:
            return touchActivity(sessionId);
        }
      };

      /**
       * Mirror whether the session's task graph holds a live mission into its row (LOB-231), so the
       * next boot knows which logs to reopen (`resumeMissions`). Written only when it changes: the
       * graph changes on every generation and tool call, and the row only when a mission starts or
       * settles. Best-effort like the other activity writes — a row that lags costs a boot one
       * reopen that finds nothing (or, at worst, a mission that waits for its next caller), never a
       * failed run. A mission in flight is marked with this process's root (`missionRoot`), the one
       * boot that resumes it; one this process carries on after another marked it is marked again.
       */
      const setMissionInFlight = (
        sessionId: SessionId,
        inFlight: boolean,
      ): Effect.Effect<void> =>
        paper(
          "write mission in flight",
          inFlight
            ? sql`
                UPDATE sessions
                SET mission_in_flight = true, mission_session_root = ${missionRoot}
                WHERE id = ${sessionId}
                  AND (NOT mission_in_flight OR mission_session_root IS DISTINCT FROM ${missionRoot})
              `
            : sql`
                UPDATE sessions
                SET mission_in_flight = false, mission_session_root = NULL
                WHERE id = ${sessionId} AND mission_in_flight
              `,
        ).pipe(Effect.ignore);

      const touchActivity = (sessionId: SessionId): Effect.Effect<void> =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          yield* paper(
            "touch session activity",
            sql`
              INSERT INTO session_activity (session_id, last_activity_at)
              VALUES (${sessionId}, to_timestamp(${now / 1000}))
              ON CONFLICT (session_id) DO UPDATE
              SET last_activity_at = EXCLUDED.last_activity_at
            `,
          );
        }).pipe(Effect.ignore);

      const setActivityStatus = (
        sessionId: SessionId,
        status: SessionStatus,
      ): Effect.Effect<void> =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          yield* paper(
            "write session status",
            sql`
              INSERT INTO session_activity (session_id, status, last_activity_at)
              VALUES (${sessionId}, ${status}, to_timestamp(${now / 1000}))
              ON CONFLICT (session_id) DO UPDATE
              SET status = EXCLUDED.status, last_activity_at = EXCLUDED.last_activity_at
            `,
          );
        }).pipe(Effect.ignore);

      const setActivityCost = (
        sessionId: SessionId,
        costTotal: number,
      ): Effect.Effect<void> =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          yield* paper(
            "write session spend",
            sql`
              INSERT INTO session_activity (session_id, cost_total, last_activity_at)
              VALUES (${sessionId}, ${costTotal}, to_timestamp(${now / 1000}))
              ON CONFLICT (session_id) DO UPDATE
              SET cost_total = EXCLUDED.cost_total, last_activity_at = EXCLUDED.last_activity_at
            `,
          );
        }).pipe(Effect.ignore);

      /**
       * Record (or replace) one cited knowledge page (LOB-204).
       *
       * The log is the truth and it is committed once: the `factory.page` member and the entry that
       * announces it are one commit, exactly as the PR step's document and entry are. The row is a
       * second statement after it — the same shape as that step's index write — so a failure between
       * the two leaves the log ahead of `session_pages` until a rebuild refills it, which is why the
       * rebuild fold exists rather than being an optimisation.
       *
       * A citation is stored exactly as given, unknown session id included: `sources` is data, not a
       * foreign key, so a page that names a session nobody can find still reads back.
       */
      const recordPage = (
        input: RecordPageInput,
      ): Effect.Effect<Page, SessionError> =>
        Effect.gen(function* () {
          // Trimmed once, and the trimmed name is the one written: whitespace is not part of an
          // identity, and a name that differs only in its padding would be a second page.
          const name = input.name.trim();
          if (name.length === 0) {
            return yield* new SessionErrorClass({
              code: "invalid_input",
              message: "a page needs a non-empty name",
            });
          }
          const row = yield* requireSession(input.sessionId);
          const owner = yield* acquireOwner(input.sessionId, row);
          const page: Page = {
            name,
            kind: input.kind,
            content: input.content,
            links: input.links,
            sources: input.sources,
          };
          yield* paper("record page", writePage(owner.root, page));
          const links = yield* paper(
            "encode page links",
            Schema.encodeEffect(PageStrings)(page.links),
          );
          const sources = yield* paper(
            "encode page sources",
            Schema.encodeEffect(PageStrings)(page.sources),
          );
          yield* paper(
            "write page row",
            sql`
              INSERT INTO session_pages (session_id, name, kind, content, links, sources)
              VALUES (
                ${input.sessionId},
                ${page.name},
                ${page.kind},
                ${page.content},
                ${links}::jsonb,
                ${sources}::jsonb
              )
              ON CONFLICT (session_id, name) DO UPDATE SET
                kind = EXCLUDED.kind,
                content = EXCLUDED.content,
                links = EXCLUDED.links,
                sources = EXCLUDED.sources
            `,
          );
          yield* touchActivity(input.sessionId);
          return page;
        });

      /** The pages one session's log holds, by name — one query, never a fold of the log. */
      const listPages = (
        input: ListPagesInput,
      ): Effect.Effect<ListPagesOutput, SessionError> =>
        Effect.gen(function* () {
          yield* requireSession(input.sessionId);
          return { pages: [...(yield* pagesFor(input.sessionId))] };
        });

      /**
       * One curator pass over a finished session (LOB-206, part 3 of LOB-47).
       *
       * The pass is one model call and nothing else: no scheduler, no embedding, no second request,
       * and no curator session of its own. The session is read as a live snapshot — its transcript as
       * folded and the pages it already holds — and the answer is written back through `recordPage`,
       * so a curated page is the same log fact as a page a session recorded itself.
       *
       * Three decisions are worth naming:
       *
       * - A **running** session is refused rather than curated. The transcript a pass reads would be
       *   half a piece of work, and its spend would race the run's own. The status is read once, so
       *   a message sent *during* the call is not refused: the charge and the activity index are
       *   both written from the ledger read after the call, so neither loses that run's spend.
       * - A proposal the session **already holds**, field for field, is not written. `recordPage`
       *   upserts, so writing it again would be a second log entry for an unchanged page: "learned
       *   nothing new" would cost a commit, which is the one thing this pass promises it does not.
       * - The call's spend is charged to the curated session **before** the page writes, in that
       *   session's `pi.usage` and in its activity row: the session paid for the call whether or not
       *   a later write succeeds, and a curator is not a session with a bill of its own.
       */
      const curate = (
        input: CurateSessionInput,
      ): Effect.Effect<CurateSessionResult, SessionError> =>
        Effect.gen(function* () {
          const maxPages = clampCurationPages(input.maxPages);
          const row = yield* requireSession(input.sessionId);
          const owner = yield* acquireOwner(input.sessionId, row);
          const snapshot = yield* readLiveSnapshot(
            owner,
            refOf(input.sessionId, row, owner.workspace, owner.model),
          );
          if (snapshot.session.status === "busy") {
            return yield* new SessionErrorClass({
              code: "busy",
              message: `session ${input.sessionId} is running; a curator reads finished work`,
            });
          }
          const existing = yield* listPages({ sessionId: input.sessionId });
          const request = yield* requestCuration({
            model: options.model,
            sourceId: input.sessionId,
            entries: snapshot.entries,
            pages: existing.pages,
            maxPages,
          });
          // The spend is charged before the answer is read, not after it is liked: the call was
          // made and billed either way, and a curator that answers unreadably is the case where
          // forgetting the charge would silently lose it.
          yield* writeCurationUsage(
            owner.root,
            modelKey(options.model),
            request.usage,
          );
          // The activity index is derived from the ledger *after* the charge, never from the
          // pre-call snapshot plus an increment: a run that emitted its own usage event while the
          // call was in flight would otherwise have its spend overwritten by the snapshot's total.
          // Reading the ledger back can only be at least that event's value.
          const ledger = yield* readCurationUsage(owner.harness);
          yield* setActivityCost(input.sessionId, costOf(ledger));
          const curation = yield* curationProposals(request, {
            sourceId: input.sessionId,
            maxPages,
          });
          const written: Page[] = [];
          for (const proposal of curation.proposals) {
            // Skip a page the session already holds, and a repeat inside the answer itself: a
            // curation that names the same page twice is one page, and the second write would be a
            // log entry for nothing.
            if (
              samePage(existing.pages, proposal) ||
              samePage(written, proposal)
            ) {
              continue;
            }
            written.push(
              yield* recordPage({ sessionId: input.sessionId, ...proposal }),
            );
          }
          yield* touchActivity(input.sessionId);
          return { pages: written, proposed: curation.proposed };
        });

      /**
       * One decomposition of a session's spec (LOB-201, part 1 of LOB-43).
       *
       * The shape is the curator's (`curate` above): one call, no session of its own, the spend
       * charged to the session before the answer is judged. What it reads is the spec, not the
       * transcript, and what it may commit is decided by `decodeProposedIssues` alone.
       *
       * Refused before any call is made, so a refusal costs nothing:
       *
       * - a **running** session — its specifier may be rewriting the spec the call would read;
       * - a session with **no spec** — there is nothing to decompose;
       * - a spec that still **declares gaps** — a gap is the stage's evidence that a person has to
       *   answer first (LOB-73), and proposals cut from a spec with holes in it would bake the
       *   holes into every child;
       * - a spec with **no acceptance criteria** — every proposal needs acceptance lines, and a
       *   spec that states none gives the call nothing to ground them in;
       * - a spec **too large to show whole** (`decompositionInputFault`: more than 50 criteria, or a
       *   goal or criterion over 1 000 characters) — the prompt never cuts a criterion, because the
       *   criteria are the contract the children are checked against.
       *
       * A refused answer stores nothing, so the proposals an earlier decomposition committed are
       * still what the session reports.
       */
      const proposeDecomposition = (
        input: ProposeDecompositionInput,
      ): Effect.Effect<
        ProposeDecompositionResult,
        SessionError | ProposalsRefused
      > =>
        Effect.gen(function* () {
          const row = yield* requireSession(input.sessionId);
          const owner = yield* acquireOwner(input.sessionId, row);
          if (yield* isBusy(owner.harness, owner.root)) {
            return yield* new SessionErrorClass({
              code: "busy",
              message: `session ${input.sessionId} is running; a decomposition reads a settled spec`,
            });
          }
          const spec = yield* readSpec(owner.harness, owner.root);
          if (spec === undefined) {
            return yield* new SessionErrorClass({
              code: "invalid_input",
              message: `session ${input.sessionId} has no spec to decompose`,
            });
          }
          if (spec.gaps.length > 0) {
            return yield* new SessionErrorClass({
              code: "invalid_input",
              message: `session ${input.sessionId}'s spec declares ${spec.gaps.length} gap(s); a person closes them before it is decomposed`,
            });
          }
          const fault = decompositionInputFault(spec);
          if (fault !== undefined) {
            return yield* new SessionErrorClass({
              code: "invalid_input",
              message: `session ${input.sessionId}'s spec ${fault}`,
            });
          }
          const skill = yield* skills.get(DECOMPOSITION_SKILL).pipe(
            Effect.mapError(
              (cause) =>
                new SessionErrorClass({
                  code: "storage",
                  message: `read the ${DECOMPOSITION_SKILL} skill: ${cause.message}`,
                }),
            ),
          );
          const request = yield* requestDecomposition({
            model: options.model,
            instructions: skill.body,
            sessionId: input.sessionId,
            spec,
          });
          // Charged before the answer is judged, as a curation is: a refused answer was still a
          // billed call, and the activity row is derived from the ledger read after the charge.
          yield* writeCurationUsage(
            owner.root,
            modelKey(options.model),
            request.usage,
          );
          const ledger = yield* readCurationUsage(owner.harness);
          yield* setActivityCost(input.sessionId, costOf(ledger));
          const proposed = yield* decompositionProposals(request);
          const committed = yield* writeProposedIssues(owner.root, proposed);
          yield* touchActivity(input.sessionId);
          return committed;
        });

      /**
       * One approval of proposals (LOB-202, part 2 of LOB-43).
       *
       * Everything that can be refused without the tracker is refused first, from the document and
       * the indices; the tracker is then opened, which refuses a process with no tracker and a
       * session with no delegating issue before any request is made. Creations run in index order,
       * one request at a time, and a created proposal is recorded in the document before the next is
       * sent: a failure stops there with `tracker_failed` naming what was created, and the retry
       * skips those. The edges are the last pass and run over every created proposal, not only the
       * ones this call created, which is how approving a blocker later creates the edge that was
       * waiting for it.
       */
      const approveProposals = (
        input: ApproveProposalsInput,
      ): Effect.Effect<
        ApproveProposalsResult,
        SessionError | ApproveProposalsError
      > =>
        withProposalGate(
          input.sessionId,
          Effect.gen(function* () {
            const refuse = (
              reason: ApproveProposalsError["reason"],
              message: string,
              created: readonly number[] = [],
            ) => new ApproveProposalsError({ reason, message, created });
            const row = yield* requireSession(input.sessionId);
            const owner = yield* acquireOwner(input.sessionId, row);
            const stored = yield* readProposedIssues(owner.harness, owner.root);
            if (stored === undefined) {
              return yield* refuse(
                "no_proposals",
                `session ${input.sessionId} has no proposed issues to approve`,
              );
            }
            const unknown = input.approved.filter(
              (index) => index < 0 || index >= stored.proposals.length,
            );
            if (unknown.length > 0) {
              return yield* refuse(
                "unknown_proposal",
                `${unknown.join(", ")} ${unknown.length === 1 ? "is" : "are"} not proposals of session ${input.sessionId}, which has ${stored.proposals.length}`,
              );
            }
            const target = yield* tracker.open(input.sessionId);
            const proposals = [...stored.proposals];
            const created: number[] = [];
            const retag = (error: ApproveProposalsError) =>
              refuse(error.reason, error.message, [...created]);
            for (const index of [...new Set(input.approved)].sort(
              (left, right) => left - right,
            )) {
              const proposal = proposals[index];
              if (proposal === undefined || proposal.created !== undefined) {
                continue;
              }
              const issue = yield* target
                .create({
                  title: proposal.title,
                  body: proposalIssueBody(proposal),
                })
                .pipe(Effect.mapError(retag));
              const recorded = yield* recordCreatedIssue(
                owner.root,
                index,
                proposal.title,
                issue,
              );
              if (!recorded) {
                return yield* refuse(
                  "proposals_changed",
                  `the proposals of session ${input.sessionId} changed while proposal ${index} was being created as ${issue.identifier}; approve again`,
                  created,
                );
              }
              proposals[index] = { ...proposal, created: issue };
              created.push(index);
            }
            let related = 0;
            for (const proposal of proposals) {
              if (proposal.created === undefined) continue;
              for (const blockerIndex of proposal.blockedBy) {
                const blocker = proposals[blockerIndex]?.created;
                if (blocker === undefined) continue;
                const made = yield* target
                  .relate({ blocker, blocked: proposal.created })
                  .pipe(Effect.mapError(retag));
                if (made) related += 1;
              }
            }
            yield* touchActivity(input.sessionId);
            return { proposals, created, related };
          }),
        );

      /**
       * One page of the session list, newest activity first.
       *
       * A page is exact: the cursor carries `last_activity_exact` at microsecond precision, so the
       * keyset comparison is against the `timestamptz` Postgres ordered by and a page boundary
       * inside a group of rows sharing a millisecond loses none of it (LOB-95).
       *
       * `nextCursor` is minted only when a row beyond this page exists: the query asks Postgres for
       * `limit + 1` rows and a page that comes back short is the end of the walk. A page whose size
       * equals the table's row count therefore carries no cursor, and paging from it repeats the
       * page rather than continuing past it (LOB-140).
       *
       * A *walk* — this call repeated from `nextCursor` until it is gone — is not a snapshot, and
       * cannot be one from here: the ordering key is `session_activity.last_activity_at`, which
       * every live event for an owned session rewrites to "now" (`recordActivity` reaches it
       * through `touch`, `setActivityStatus` and `setActivityCost`). So a row can move between two
       * pages of the same walk, and both directions are observable:
       *
       * - A row below the cursor whose key advances *above* it leaves the range the walk is
       *   traversing. It is not returned by that walk, and `nextCursor` still reports the walk
       *   finished. It is not lost: a session that just became active now belongs at the head, and
       *   the next walk finds it there.
       * - A row already returned whose key moves *back below* the cursor is returned again. Only
       *   `rebuildIndexes` moves a key backwards — every incremental writer sets it to "now" — so
       *   reaching this needs a whole-table rewrite in flight, and it is still a wrong answer.
       *
       * Callers that page the whole table should therefore treat a walk as a best-effort snapshot
       * rather than a count, and should re-walk from the top to pick up what moved. Making a walk
       * a true snapshot needs either one transaction spanning every page — impossible from here, a
       * walk is a client's loop across calls — or a materialised snapshot id carried in the cursor;
       * both are a decision about this contract rather than a fix, so neither is taken.
       */
      const list = (
        input: ListSessionsInput,
      ): Effect.Effect<ListSessionsOutput, SessionError> =>
        Effect.gen(function* () {
          const limit = Math.min(
            Math.max(input.limit ?? DEFAULT_PAGE_SIZE, 1),
            MAX_PAGE_SIZE,
          );
          const cursor =
            input.cursor === undefined
              ? undefined
              : yield* parseCursor(input.cursor);
          // One statement, whatever the number of sessions: the keyset comparison is against a
          // parameter, not against a fold of anything (R6).
          const rows = yield* paper(
            "list sessions",
            sql<ListRow>`
              SELECT
                s.id,
                s.title,
                s.repo,
                s.base_ref,
                s.forked_from,
                s.model,
                s.pr_url,
                a.status,
                a.cost_total,
                to_char(a.last_activity_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS last_activity_at,
                to_char(a.last_activity_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS last_activity_exact,
                to_char(s.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at
              FROM session_activity a
              JOIN sessions s ON s.id = a.session_id
              WHERE (
                ${cursor?.at ?? null}::timestamptz IS NULL
                OR (a.last_activity_at, s.id) < (${cursor?.at ?? null}::timestamptz, ${cursor?.id ?? null}::text)
              )
              ORDER BY a.last_activity_at DESC, s.id DESC
              LIMIT ${limit + 1}
            `,
          );
          const page = rows.slice(0, limit);
          const last = page.at(-1);
          // The cursor carries the exact instant, not the millisecond display value: the keyset
          // comparison is against the stored `timestamptz`, so the cursor has to be too. A cursor
          // minted by an older build is millisecond-truncated and stays lossy for that one page
          // boundary; nothing can repair a value that has already been rounded.
          const nextCursor =
            rows.length > limit && last !== undefined
              ? `${last.lastActivityExact}|${last.id}`
              : undefined;
          const sessions: SessionListEntry[] = [];
          for (const row of page) {
            const repo =
              row.repo === null ? undefined : yield* toRepoSlug(row.repo);
            // Lineage is a display field: a malformed value is a broken index, not a reason to
            // fail the page, and `rebuildIndexes` refolds it from the fork's document.
            const forkedFrom =
              row.forkedFrom !== null &&
              Schema.is(SessionIdSchema)(row.forkedFrom)
                ? row.forkedFrom
                : undefined;
            sessions.push({
              id: yield* toSessionId(row.id),
              title: row.title,
              status: row.status === "busy" ? "busy" : "idle",
              createdAt: row.createdAt,
              lastActivityAt: row.lastActivityAt,
              costTotal: row.costTotal,
              ...(repo === undefined ? {} : { repo }),
              ...(repo === undefined || row.baseRef === null
                ? {}
                : { baseRef: row.baseRef }),
              ...(forkedFrom === undefined ? {} : { forkedFrom }),
              ...(row.model === null ? {} : { model: row.model }),
              ...(row.prUrl === null ? {} : { prUrl: row.prUrl }),
            });
          }
          return {
            sessions,
            ...(nextCursor === undefined ? {} : { nextCursor }),
          };
        });

      /**
       * Spend keyed by repo and actor (LOB-162). The same join `list` reads, grouped: a session is
       * counted here exactly when the list would show it, and its cost is the list's `costTotal`,
       * so the pane's sums are the list's numbers added up. A fork's `cost_total` is its own spend
       * (what it inherited for its cap is the budget's `carried`, not `pi.usage`), so a parent and
       * its fork are never counted twice.
       *
       * The order is the report's contract: costliest first, then by repo and actor, an absent one
       * last — so two reads of the same index answer the same rows in the same order.
       */
      const spend: Effect.Effect<SpendReport, SessionError> = Effect.gen(
        function* () {
          const groups = yield* paper(
            "read spend",
            sql<SpendGroupRow>`
              SELECT
                s.repo,
                s.actor,
                count(*)::int AS sessions,
                COALESCE(sum(a.cost_total), 0)::double precision AS cost_total
              FROM session_activity a
              JOIN sessions s ON s.id = a.session_id
              GROUP BY s.repo, s.actor
              ORDER BY cost_total DESC, s.repo ASC NULLS LAST, s.actor ASC NULLS LAST
            `,
          );
          const rows: SpendRow[] = [];
          for (const group of groups) {
            const repo =
              group.repo === null ? undefined : yield* toRepoSlug(group.repo);
            const actor =
              group.actor === null
                ? Option.none()
                : Schema.decodeOption(SessionActor)(group.actor);
            if (group.actor !== null && Option.isNone(actor)) {
              // Folding a malformed actor into "unattributed" would move its spend to a row it is
              // not; the index is broken, and `rebuildIndexes` refolds it from the log.
              return yield* new SessionErrorClass({
                code: "storage",
                message: `the sessions table holds an invalid actor: "${group.actor}"`,
              });
            }
            rows.push({
              ...(repo === undefined ? {} : { repo }),
              ...(Option.isSome(actor) ? { actor: actor.value } : {}),
              sessions: group.sessions,
              costTotal: group.costTotal,
            });
          }
          return {
            rows,
            sessions: rows.reduce((total, row) => total + row.sessions, 0),
            costTotal: rows.reduce((total, row) => total + row.costTotal, 0),
          };
        },
      );

      const parseCursor = (
        raw: string,
      ): Effect.Effect<
        { readonly at: string; readonly id: SessionId },
        SessionError
      > =>
        Effect.gen(function* () {
          const separator = raw.indexOf("|");
          const at = separator === -1 ? "" : raw.slice(0, separator);
          const id = separator === -1 ? "" : raw.slice(separator + 1);
          if (at === "" || !Schema.is(SessionIdSchema)(id)) {
            return yield* new SessionErrorClass({
              code: "invalid_input",
              message: `"${raw}" is not a list cursor`,
            });
          }
          return { at, id };
        });

      const readSessionById = (sessionId: SessionId) =>
        sql<SessionRow>`
          SELECT
            id,
            title,
            repo,
            base_ref,
            branch,
            pr_url,
            forked_from,
            actor,
            to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
            to_char(workspace_released_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS workspace_released_at,
            workspace_release_reason,
            model
          FROM sessions
          WHERE id = ${sessionId}
        `;

      const readSessionByRequest = (requestId: string) =>
        sql<SessionRow>`
          SELECT
            id,
            title,
            repo,
            base_ref,
            branch,
            pr_url,
            forked_from,
            actor,
            to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
            to_char(workspace_released_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS workspace_released_at,
            workspace_release_reason,
            model
          FROM sessions
          WHERE request_id = ${requestId}
        `;

      const insertSession = (
        id: SessionId,
        title: string,
        requestId: string | undefined,
        binding: Binding,
        forkedFrom: string | null,
        actor: string | null,
      ) =>
        sql<SessionRow>`
          INSERT INTO sessions (id, title, request_id, repo, base_ref, branch, forked_from, actor)
          VALUES (
            ${id},
            ${title},
            ${requestId ?? null},
            ${binding.repo ?? null},
            ${binding.baseRef ?? null},
            ${binding.branch ?? null},
            ${forkedFrom},
            ${actor}
          )
          RETURNING
            id,
            title,
            repo,
            base_ref,
            branch,
            pr_url,
            forked_from,
            actor,
            to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
            to_char(workspace_released_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS workspace_released_at,
            workspace_release_reason,
            model
        `;

      const readRepo = (slug: string) =>
        sql<RepoRow>`
          SELECT
            slug,
            url,
            default_base_ref,
            local_path,
            to_char(registered_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS registered_at
          FROM repos
          WHERE slug = ${slug}
        `;

      const readRepos = sql<RepoRow>`
        SELECT
          slug,
          url,
          default_base_ref,
          local_path,
          to_char(registered_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS registered_at
        FROM repos
        ORDER BY slug
      `;

      const upsertRepo = (input: {
        readonly slug: string;
        readonly url: string;
        readonly defaultBaseRef: string;
        readonly localPath: string | null;
      }) =>
        sql<RepoRow>`
          INSERT INTO repos (slug, url, default_base_ref, local_path)
          VALUES (${input.slug}, ${input.url}, ${input.defaultBaseRef}, ${input.localPath})
          ON CONFLICT (slug) DO UPDATE SET
            url = EXCLUDED.url,
            default_base_ref = EXCLUDED.default_base_ref,
            local_path = EXCLUDED.local_path
          RETURNING
            slug,
            url,
            default_base_ref,
            local_path,
            to_char(registered_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS registered_at
        `;

      const events = (
        sessionId: SessionId,
      ): Stream.Stream<SessionEvent, SessionError> =>
        Stream.unwrap(
          Effect.gen(function* () {
            const row = yield* requireSession(sessionId);
            const owners = yield* Ref.get(live);
            const owner = HashMap.get(owners, sessionId);
            if (Option.isSome(owner)) {
              yield* touch(sessionId);
              return liveSessionEvents(
                owner.value,
                refOf(sessionId, row, owner.value.workspace, owner.value.model),
              );
            }
            // Nobody owns it: fold once, send the snapshot, and end the stream, so a client can
            // tell a completed fold from a dropped connection (D8).
            const workspace = yield* workspaceFor(row, { cut: false });
            // As `get` does: a fold notices a replay still owed its comparison (LOB-199).
            yield* armComparison(sessionId);
            const snapshot = yield* withReader(sessionId, (storage) =>
              readHistoricalSnapshot(storage, refOf(sessionId, row, workspace)),
            );
            return Stream.make(snapshotEvent(snapshot));
          }),
        );

      /**
       * Release what this process holds for a session: the projection, the harness and the log
       * handle. Only that — the worktree and the branch are the session's, not the owner's, and stay
       * for its next run (LOB-268); `releaseWorkspace` is the one place they are torn down.
       */
      const releaseOwner = (
        sessionId: SessionId,
        owner: LiveOwner,
      ): Effect.Effect<void> =>
        Effect.gen(function* () {
          // Interrupting the projection first: a released owner has no status to report.
          yield* FiberMap.remove(projectors, sessionId);
          yield* closeHarness(owner.harness).pipe(Effect.ignore);
          // Then its sandboxes, which nothing runs in once the harness is closed; never the
          // worktree's files, which stay for the session's next run like the worktree itself.
          yield* owner.releaseEnvironment;
          yield* Effect.promise(() => owner.storage.dispose());
          // Nobody owns the session now, so the list's honest status is idle (D8).
          yield* setActivityStatus(sessionId, "idle");
        });

      /**
       * Record the release once: the first terminal event's reason and time are kept, and a repeat
       * reads them back. The update is conditional, so of two concurrent releases one marks the row
       * and the other — blocked on its lock, then matching nothing — reads what the first wrote, in
       * a statement of its own so its snapshot is taken after that commit.
       */
      const markReleased = (
        sessionId: SessionId,
        reason: WorkspaceReleaseReason,
      ) =>
        Effect.gen(function* () {
          type Marked = {
            readonly reason: string;
            readonly at: string;
          };
          const marked = yield* paper(
            "record the workspace release",
            sql<Marked>`
              UPDATE sessions
              SET workspace_released_at = now(), workspace_release_reason = ${reason},
                -- A released session takes no new run, so no boot resumes its mission (LOB-231).
                mission_in_flight = false, mission_session_root = NULL
              WHERE id = ${sessionId} AND workspace_released_at IS NULL
              RETURNING
                workspace_release_reason AS reason,
                to_char(workspace_released_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at
            `,
          );
          const first = marked[0];
          if (first !== undefined) return { ...first, first: true };
          const earlier = yield* paper(
            "read the workspace release",
            sql<Marked>`
              SELECT
                workspace_release_reason AS reason,
                to_char(workspace_released_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at
              FROM sessions
              WHERE id = ${sessionId} AND workspace_released_at IS NOT NULL
            `,
          );
          const kept = earlier[0];
          return kept === undefined ? undefined : { ...kept, first: false };
        });

      const releaseWorkspace = (input: {
        readonly sessionId: SessionId;
        readonly reason: WorkspaceReleaseReason;
      }): Effect.Effect<ReleaseWorkspaceResult, SessionError> =>
        Effect.gen(function* () {
          const row = yield* requireSession(input.sessionId);
          // Under the owners' gate, so no acquisition opens an owner between the two: one that
          // already read the row waits here, and opens after the mark, which it reads (below).
          const { marked, owner } = yield* gate.withPermits(1)(
            Effect.gen(function* () {
              const marked = yield* markReleased(input.sessionId, input.reason);
              const owner = yield* Ref.modify(live, (current) => [
                HashMap.get(current, input.sessionId),
                HashMap.remove(current, input.sessionId),
              ]);
              return { marked, owner };
            }),
          );
          if (marked === undefined) {
            return yield* new SessionErrorClass({
              code: "storage",
              message: `session ${input.sessionId}: the workspace release did not record`,
            });
          }
          const release = yield* decodeRelease(marked);
          if (Option.isSome(owner)) {
            // A run still going is stopped, not abandoned in a directory about to vanish: the log
            // settles the interrupted turn, and the session's transcript says where it ended.
            const busy = yield* isBusy(
              owner.value.harness,
              owner.value.root,
            ).pipe(Effect.orElseSucceed(() => false));
            if (busy) {
              yield* interruptConversation(owner.value.root).pipe(
                Effect.ignore,
              );
            }
            yield* releaseOwner(input.sessionId, owner.value);
          }
          // Every time, not only the first: a teardown a crash cut short is finished by the repeat.
          const workspace = yield* workspaceFor(row, {
            cut: false,
            released: release,
          });
          const repo =
            row.repo === null ? undefined : yield* toRepoSlug(row.repo);
          const checkouts = yield* checkoutsFor(repo);
          // Once with no checkout when there is none, so a plain session directory is still removed.
          for (const localPath of checkouts.length === 0
            ? [undefined]
            : checkouts) {
            yield* removeWorkspace(
              {
                directory: workspace.path,
                ...(workspace.branch === undefined
                  ? {}
                  : { branch: workspace.branch }),
                ...(localPath === undefined ? {} : { localPath }),
              },
              { fs, path },
            );
          }
          if (marked.first) {
            yield* Effect.logInfo(
              `session ${input.sessionId}: workspace released (${release.reason}); removed ${workspace.path}${workspace.branch === undefined ? "" : ` and ${workspace.branch}`}`,
            );
          }
          return {
            sessionId: input.sessionId,
            release,
            first: marked.first,
          };
        });

      // The model `openSession` gives a run in this role (LOB-270), taken from `resolveRole` itself so
      // the description and the run share one rule. `source` says whether the answer is the role
      // table's row or the deployment's model.
      const roleModel = (role: string | undefined): ResolvedModel => {
        const roles = options.roleModels ?? NO_ROLE_MODELS;
        const { model } = resolveRole(
          role === undefined ? undefined : { ...EMPTY_RUN_PROFILE, role },
          options.model,
          roles,
        );
        const fromRole = role !== undefined && roles.get(role) === model;
        return {
          model: modelKey(model),
          source: fromRole ? "role" : "deployment",
        };
      };

      const resumeMissions: Effect.Effect<readonly SessionId[], SessionError> =
        Effect.gen(function* () {
          // A row released while its mark stood (one released before the release cleared it) takes
          // no new run, so its mark is dropped rather than read at every boot.
          yield* paper(
            "clear missions on released sessions",
            sql`
              UPDATE sessions
              SET mission_in_flight = false, mission_session_root = NULL
              WHERE mission_in_flight AND mission_session_root = ${missionRoot}
                AND workspace_released_at IS NOT NULL
            `,
          );
          // Only the rows marked under this process's root: a process with another root would work
          // in a worktree beside the mission's, and the verify skills' throwaway APIs share the
          // development database under roots of their own.
          const rows = yield* paper(
            "read sessions with a mission in flight",
            sql<{ readonly id: string }>`
              SELECT id FROM sessions
              WHERE mission_in_flight AND mission_session_root = ${missionRoot}
                AND workspace_released_at IS NULL
              ORDER BY id
            `,
          );
          const resumed: SessionId[] = [];
          for (const { id } of rows) {
            const outcome = yield* Effect.result(
              Effect.gen(function* () {
                const sessionId = yield* toSessionId(id);
                const row = yield* requireSession(sessionId);
                // `starts`: a release that committed after the query read the row is refused under
                // the owners' gate, as a `startMission` would be.
                const owner = yield* acquireOwner(sessionId, row, {
                  starts: true,
                });
                // Asked before anything is scheduled: the reopened graph already lists a mission the
                // stop left pending. The row outlived its mission (a crash between the two writes):
                // nothing to resume, so nothing else in the log is scheduled on the boot's behalf
                // either, and the sweep releases the owner like any idle one.
                const live = yield* missionInFlight(owner.harness);
                if (!live) {
                  yield* setMissionInFlight(sessionId, false);
                  return undefined;
                }
                // Scheduling is what a reopen does not do by itself: Pi Durable runs the log's
                // pending tasks once its harness is resumed, and a mission's phases are among them.
                owner.harness.resume();
                return sessionId;
              }),
            );
            if (outcome._tag === "Failure") {
              yield* Effect.logWarning(
                `session ${id}: could not resume its mission: ${outcome.failure.message}`,
              );
              continue;
            }
            if (outcome.success !== undefined) resumed.push(outcome.success);
          }
          return resumed;
        });

      const closeAll = Effect.gen(function* () {
        // A comparison still waiting would reopen the owners this is closing (LOB-199), so the waits
        // end first. Nothing is lost: what is owed is in the logs, and the next owner or fold of
        // each replay arms its comparison again.
        yield* FiberMap.clear(comparisons);
        const owners = yield* Ref.get(live);
        yield* Ref.set(live, HashMap.empty());
        yield* Effect.forEach(
          HashMap.toEntries(owners),
          ([sessionId, owner]) => releaseOwner(sessionId, owner),
          { discard: true },
        );
      });

      const sweep = Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const owners = yield* Ref.get(live);
        for (const [sessionId, owner] of HashMap.toEntries(owners)) {
          if (now - owner.lastUsedAt < (options.idleTimeoutMs ?? 0)) continue;
          // Only idle owners are closed: a run in flight is durable either way, but closing it
          // would throw away the fold a live client is streaming from.
          const busy = yield* isBusy(owner.harness, owner.root).pipe(
            Effect.orElseSucceed(() => true),
          );
          if (busy) continue;
          // A mission in flight is work too, however quiet the conversation (LOB-231): released, it
          // would stay `pending` in the log until something reopened the session, so its workers
          // would stop until the next boot. The owner stays until the mission settles.
          const mission = yield* missionInFlight(owner.harness).pipe(
            Effect.orElseSucceed(() => true),
          );
          if (mission) continue;
          // Removed only if it is still the owner the snapshot read: a caller that acquired it while
          // `isBusy` was answering touched it (a new value), and is about to use the harness this
          // would otherwise close under it — a replay's comparison commit among them (LOB-199).
          const removed = yield* Ref.modify(live, (current) =>
            Option.match(HashMap.get(current, sessionId), {
              onNone: () => [false, current] as const,
              onSome: (still) =>
                still === owner
                  ? ([true, HashMap.remove(current, sessionId)] as const)
                  : ([false, current] as const),
            }),
          );
          if (!removed) continue;
          yield* releaseOwner(sessionId, owner);
        }
      });

      if (options.idleTimeoutMs !== undefined) {
        // Sweep at least twice per timeout window, so the timeout means what it says. Idle here
        // means nobody has touched the session: a read counts as use, so a client watching a
        // session keeps it open, and only a genuinely quiet session is released to its log.
        const sweepIntervalMs =
          options.sweepIntervalMs ??
          Math.max(
            250,
            Math.min(DEFAULT_SWEEP_INTERVAL_MS, options.idleTimeoutMs / 2),
          );
        yield* Effect.gen(function* () {
          for (;;) {
            yield* Effect.sleep(sweepIntervalMs);
            yield* sweep;
          }
        }).pipe(Effect.forkScoped);
      }

      return SessionService.of({
        create,
        get,
        history,
        send,
        interrupt,
        withdraw,
        fork,
        replay,
        reset,
        compact,
        startMission,
        list,
        spend,
        registerRepo,
        listRepos,
        getRepo,
        syncRepo,
        events,
        requestApproval,
        decideApproval,
        listApprovals,
        listPendingApprovals,
        recordPage,
        listPages,
        curate,
        proposeDecomposition,
        approveProposals,
        openPullRequest: openPr,
        releaseWorkspace,
        roleModel,
        resumeMissions,
        close: closeAll,
      });
    }),
  ).pipe(
    // D11's policy is a service so it can be replaced without touching a session's code; today the
    // only implementation is the autonomy rules, and `options.autonomy` is how a deployment
    // narrows or widens them.
    Layer.provide(PolicyLive(options.autonomy)),
    // The run's prompt is assembled from the factory's skill records (B6), so the service reads
    // them through `SkillService` rather than a second reader of the `skills` table.
    Layer.provide(SkillServiceLive),
    // A run's thread and its ask are the card's (B7, LOB-73), so the service reads and writes them
    // through `TaskService` rather than a second writer of `task_events`.
    Layer.provide(TaskServiceLive),
  );
