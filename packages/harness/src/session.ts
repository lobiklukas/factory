/**
 * Opening and reading one session's log.
 *
 * This is the only place in the control plane that touches Pi Durable's runtime, so its churn
 * (design R1) stops here: callers get a `Harness` to drive, or a projected snapshot to serve.
 *
 * Pi Durable is Promise-based, so every call into it is wrapped at this boundary; everything that
 * leaves this module is an Effect, like the rest of the repo.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord";
import type {
  AnyTask,
  Conversation,
  ConversationId,
  ConversationView,
  Cursor,
  EntryDraft,
  EntryId,
  EntryRecord,
  Harness,
  Page,
  Storage,
  Submission,
  SubmissionRecord,
  TaskId,
  Tx,
} from "@earendil-works/pi-durable";
import {
  AgentDoc,
  ConversationBusy,
  defineDoc,
  defineEntry,
  defineExtension,
  Harness as HarnessRuntime,
  LiveDoc,
  ROOT_CONVERSATION_ID,
  UsageDoc,
} from "@earendil-works/pi-durable";
import { createRegistry } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { BindableSandboxRuntimeShape } from "@repo/sandbox";
import { Effect, Option, Queue, Schema, Stream } from "effect";
import type {
  PrEvidence,
  QueuedMessage,
  ReplayComparison,
  SessionError,
  SessionErrorCode,
  SessionEvent,
  SessionId,
  SessionLive,
  SessionSnapshot,
  SessionTask,
  SessionUsage,
  SessionWorkspace,
  Timestamp,
  TranscriptEntry,
  WithdrawOutcome,
} from "@repo/domain/Session";
import type { ApprovalRequest, ApprovalVerdict } from "@repo/domain/Approval";
import {
  MISSION_VERSION,
  missionSnapshot,
  readMissionWorkers,
  type MissionSnapshot,
  type MissionWorkerEntry,
  type MissionWorkerSpend,
} from "@repo/domain/Mission";
import type { Page as CitedPage } from "@repo/domain/Page";
import {
  projectProposedIssues,
  type ProposedIssues,
} from "@repo/domain/Decomposition";
import {
  projectPlanRevisions,
  type PlanRevision,
} from "@repo/domain/PlanFreshness";
import {
  PrEvidence as PrEvidenceSchema,
  SessionError as SessionErrorClass,
} from "@repo/domain/Session";
import { openSessionEnvironment, type SessionEnvironment } from "./environment";
import {
  resolveRole,
  skillsExtension,
  type RoleModels,
  type RunProfile,
  type RunSkill,
  type SkillPin,
} from "./loader";
import {
  compactionPolicyFor,
  modelAccessFor,
  type ModelAccess,
} from "./models";
// The typed document tokens (`factory.pr` among them) live in one module so the kind strings and
// the shapes they promise have a single writer and a single reader.
import {
  APPROVALS_DOC_KIND,
  ApprovalsDoc,
  MISSION_BINDING_DOC_KIND,
  MISSION_DOC_KIND,
  MissionBindingDoc,
  MergeDoc,
  MissionDoc,
  PageDoc,
  PagePromptDoc,
  PrDoc,
  REVIEW_DOC_KIND,
  ReviewDoc,
  ReplayDoc,
  PLAN_REVISIONS_DOC_KIND,
  REPO_PROMPT_DOC_KIND,
  RepoPromptDoc,
  SKILLS_DOC_KIND,
  SkillPinsDoc,
  PlanRevisionsDoc,
  PROPOSED_ISSUES_DOC_KIND,
  ProposedIssuesDoc,
  SpecDoc,
} from "./docs";
import { decodeSpec, projectSpec, type Spec, type SpecRefused } from "./spec";
import { assemblePages, pagesExtension, PAGES_TOKEN_CAP } from "./pages";
import {
  assembleRepoPrompt,
  repoInstructionsExtension,
  type RepoContext,
  type RepoPromptRecord,
  repoPromptRecord,
  repoSkillsExtension,
} from "./repoContext";
import {
  BudgetDoc,
  budgetExtension,
  type BudgetSession,
  inheritBudget,
  setBudget,
  type BudgetSeed,
  type BudgetSource,
} from "./budget";
import {
  verifyCallsIn,
  verifyExtension,
  type VerifyOptions,
  type VerifyRecord,
} from "./verify";
import { bodyExtension, renderBody } from "./body";
import {
  askExtension,
  threadExtension,
  type AskOptions,
  type ThreadReader,
} from "./ask";
import { commitSpec, specExtension, type SpecOptions } from "./specify";
import {
  REVIEW_DIMENSIONS,
  reviewExtension,
  type ReviewDimension,
  type ReviewOptions,
  type ReviewTarget,
} from "./review";
import {
  autonomyPolicy,
  DEFAULT_AUTONOMY,
  DOCS_SKILL,
  docsPolicy,
  policyExtension,
  readOnlyStagePolicy,
  type ApprovalAsker,
  type SessionPolicy,
} from "./policy";
import {
  diffView,
  evidenceAt,
  pendingApprovals,
  projectApprovals,
  projectBudgetDoc,
  projectEntry,
  runEndingOf,
  type RunEnding,
  projectMergeDoc,
  projectPrDoc,
  projectPages,
  projectReplayComparisons,
  projectReplayDoc,
  projectTasks,
  mergeUsage,
  projectUsageDoc,
  projectView,
  sameTasks,
  totalSpend,
  usageCostTotal,
  SESSION_DOC_KIND,
  ACTOR_DOC_KIND,
  TASK_DOC_KIND,
  SPEC_DOC_KIND,
  CRITERIA_DOC_KIND,
  PR_DOC_KIND,
  MERGE_DOC_KIND,
  type MergeDocView,
  PR_OPENED_ENTRY_KIND,
  PR_INHERITED_ENTRY_KIND,
  NO_CHANGE_ENTRY_KIND,
  PR_NOT_OPENED_ENTRY_KIND,
  INTERRUPTED_ENTRY_KIND,
  INTERRUPT_DOC_KIND,
  LIVE_DOC,
  PAGE_ENTRY_KIND,
  type PageLogRecord,
  TITLE_ENTRY_KIND,
  APPROVAL_DECIDED_KIND,
  APPROVAL_USED_KIND,
  APPROVAL_REQUESTED_KIND,
  APPROVAL_ENTRY_KINDS,
  BUDGET_DOC_KIND,
  FORK_DOC_KIND,
  REPLAY_DOC_KIND,
  USAGE_DOC,
  type ApprovalLogRecord,
  type JsonRecord,
} from "./projection";

/**
 * A session's title, committed to the log so a rebuild of the index can recover it (D7). It
 * carries no model content, so the agent never sees it.
 */
export const TitleEntry = defineEntry<{ readonly title: string }>(
  TITLE_ENTRY_KIND,
);

/**
 * A session's repo binding, committed to the log so the index and the workspace are derivable
 * from it (D7, docs/features.md §3 A1). Empty strings mean "no repo", which is the scratch
 * session tests use, so the document is written once at create and never needs a tombstone.
 *
 * It is a document rather than an entry on purpose: it is session state, not transcript, and the
 * agent should not see it (Group D's `defineDoc`).
 */
export const SessionDoc = defineDoc({
  kind: SESSION_DOC_KIND,
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({ repo: "", baseRef: "", branch: "" }),
});

/**
 * Who the session's spend is attributed to (LOB-162), committed to the log so the index's
 * `sessions.actor` is derivable from it (D7). A document of its own rather than a field of the repo
 * binding: a scratch session writes no binding, and it still has an actor. Written once, at create
 * (or at a fork or a replay, with the source's actor); a session nobody was attributed has none.
 */
export const ActorDoc = defineDoc({
  kind: ACTOR_DOC_KIND,
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({ actor: "" }),
});

/** A task's binding, committed to the log so a rebuild can recover it (LOB-60). */
export const TaskDoc = defineDoc({
  kind: TASK_DOC_KIND,
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({}),
});

/**
 * A forked session's lineage, committed to its own log (LOB-180).
 *
 * `parent` is the session it was forked from. `at` is the fork's *own* copy of the last entry it
 * took, which is where the fork point sits in this log; entry ids are minted per log, so the
 * parent's id for that entry would name a different entry here. Nothing reads `at` yet. The
 * `sessions` row carries the same parent as an index, so a summary never folds a log; this document
 * is what a rebuild recovers that parent from (D7).
 */
export const ForkDoc = defineDoc({
  kind: FORK_DOC_KIND,
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({ parent: "", at: "" }),
});

/** The repo a session is bound to, as the log records it. */
export type RepoBinding = {
  readonly repo: string;
  readonly baseRef: string;
  /**
   * The branch the session's worktree is cut on, when a caller named one (LOB-197). Absent means
   * the default `factory/<session-id>` (D10), so a session that never named a branch records
   * nothing here rather than recording the default twice — the id derives it.
   *
   * A fork and a replay do not inherit it: two sessions on one branch would commit over each other,
   * so the parent's binding is copied without this field.
   */
  readonly branch?: string;
};

/** Storage is remote here, so partial answers commit less often than the 100 ms default. */
export const SESSION_PROGRESS = {
  partialIntervalMs: 250,
  outputIntervalMs: 250,
} as const;

const describe = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/** Pi Durable rejects a submission to a busy conversation with `ConversationBusy`. */
const isBusyCause = (cause: unknown): boolean =>
  cause instanceof ConversationBusy ||
  (typeof cause === "object" &&
    cause !== null &&
    "_tag" in cause &&
    cause._tag === "ConversationBusy");

const sessionError = (
  what: string,
  cause: unknown,
  code: SessionErrorCode = "harness",
): SessionError =>
  new SessionErrorClass({ code, message: `${what}: ${describe(cause)}` });

/**
 * Cross the Promise boundary. Every Pi Durable failure becomes a `SessionError`.
 *
 * The Chord context is deliberately the never-cancelling one: cancelling a caller's Effect (a
 * client closing a stream, an HTTP request timing out) must not cancel the agent's work, which is
 * durable and belongs to the session, not to the request.
 */
export const attempt = <A>(
  what: string,
  operation: () => Promise<A>,
): Effect.Effect<A, SessionError> =>
  Effect.tryPromise({
    try: operation,
    catch: (cause) => sessionError(what, cause),
  });

export type OpenSessionOptions = {
  readonly storage: Storage;
  /**
   * The deployment's model: what a run talks to unless its column's role has a row in `roles`, and
   * what a session with no card (a scratch session, a fork, a replay) always talks to.
   */
  readonly model: ModelAccess;
  /**
   * The deployment's role → model table (B6, LOB-207, `./loader`'s `RoleModels`), already resolved
   * against the catalog `model` holds. Absent: every run talks to `model`.
   */
  readonly roles?: RoleModels;
  /**
   * The model the session was created on (LOB-274), already resolved against `model`'s catalog
   * (`modelAccessFor`): it wins over the role's row and the deployment's model. Like either of them
   * it only decides the open that creates the root; a later open keeps the model the root was pinned
   * to. Absent: the role's model, else `model`.
   */
  readonly sessionModel?: ModelAccess;
  /** The session's working directory, which must exist. One per session, so sessions share no files. */
  readonly cwd: string;
  /**
   * The runtime the session's commands run through (LOB-244, `./environment`): the deployment's,
   * selected by its configuration. Each conversation's environment is a sandbox it binds to the
   * conversation's working directory, `cwd` for the root. Absent: an in-process runtime of the
   * session's own, which runs them on the host as every session did before there was a choice.
   */
  readonly sandbox?: BindableSandboxRuntimeShape;
  /**
   * What may run unattended here (D11, `./policy`). Absent: D11's defaults resolved for `cwd`, so a
   * session opened without a policy is still policed — an unpoliced session is not a default anyone
   * can reach by forgetting an argument.
   */
  readonly policy?: SessionPolicy;
  /**
   * How a gated call asks a person (D15, LOB-52). The recorder is the control plane's approvals
   * service, so it is handed in here rather than imported. A session with no asker still gates: a
   * gated call is blocked with a sentence saying there is nobody to ask, never run ungated.
   */
  readonly approvalAsker?: ApprovalAsker;
  /**
   * What the run's column gives it (B6, `./loader`): the skill bodies its prompt carries, resolved
   * by the control plane from the card's pinned board definition. Absent: no card, or a column that
   * names no skills, so nothing is injected.
   */
  readonly run?: RunProfile;
  /**
   * Durable tasks this session may start (LOB-230). Pi Durable resolves a task by kind against the
   * registry, and a kind nobody installed settles `orphaned` — so a caller that starts one
   * (`startMission`) has to install it here. Absent: a session that starts no tasks of its own,
   * which is every caller but the control plane.
   */
  readonly tasks?: readonly AnyTask[];
  /**
   * The cited pages the session's prompt carries (LOB-205), read by the control plane at open.
   *
   * Absent: no pages, so no `pages` section. The module that assembles them (`./pages`) owns the
   * budget and the drop order; this option is the pages themselves, because only the control plane
   * can read them — they live in the session's log and its derived rows, not in a document family
   * that a prompt section could enumerate.
   */
  readonly pages?: readonly CitedPage[];
  /**
   * What the session's repository tells every run (S-repo-instructions-and-skills, `./repoContext`):
   * its `AGENTS.md` and the skills it ships, read by the control plane at the session's base ref.
   * The open assembles them into the `repo_instructions` section and the `repo_skills` index under
   * their caps, defers to the column's skills where a name overlaps, and commits what that came to
   * (`RepoPromptDoc`). Absent — a scratch session, a released workspace, a directory that is not a
   * checkout — installs nothing and records nothing, so such a session runs as it did before.
   */
  readonly repo?: RepoContext;
  /**
   * What the `verify` tool runs (LOB-78, `./verify`): the repo's declared `verify` command and the
   * base its changes are measured against, from the workspace the control plane resolved. Absent:
   * no declared command and no base, so the tool falls back on the worktree's verify skills and
   * measures only uncommitted work.
   */
  readonly verify?: VerifyOptions;
  /**
   * How this run asks a person (LOB-73, `./ask`): the control plane's callback that records the
   * question on the run's card and blocks it `needs_input`. Absent: a session with no card, which
   * has nobody to ask on, so it gets no `ask` tool at all.
   */
  readonly ask?: AskOptions;
  /**
   * How to read the card's thread (LOB-73): called before every request, its comments rendered
   * verbatim, oldest first, as the `task_thread` section — so an answer that lands while this harness
   * is open reaches the next request. Absent (a session with no card), or a thread with no comments:
   * no section.
   */
  readonly thread?: ThreadReader;
  /**
   * The card's body (LOB-260, `./body`): what the task asks for, quoted verbatim as the `task_body`
   * section beside the thread. Read by the control plane when it opens the owner, like the pages.
   * Absent (a session with no card), empty, or all whitespace: no section.
   */
  readonly body?: string;
  /**
   * How a specifying run posts its spec on its card (LOB-238, `./specify`): the control plane's
   * callback that records the spec as a `specified` event. The `spec` tool is installed only when
   * this is given *and* the run's role writes the spec (`SPEC_ROLES`); any other run — a planner on
   * the same card, a scratch session — is not offered it.
   */
  readonly spec?: SpecOptions;
  /**
   * How a review run posts its review on the pull request (LOB-36, `./review`): the control plane's
   * callback that posts one comment under the reviewer's own identity. The `review` tool is installed
   * only when this is given *and* the run is a review (`RunProfile.reviewing`).
   */
  readonly review?: ReviewOptions;
  /**
   * Whether the open continues the submissions the log's root left unsettled (LOB-25,
   * `resumePending`). Absent or `true`: it does, so a run a dead process left behind carries on in
   * this one — and, Pi Durable's scheduler being one per harness, so does every other pending task
   * in the log. `false`: the harness opens paused, and nothing in the log runs until a caller asks
   * for progress — the control plane's choice for a session whose workspace is gone, where a run
   * has no directory, and for a caller that opens only to stop or withdraw work.
   */
  readonly resume?: boolean;
};

export type OpenSession = {
  readonly harness: Harness;
  readonly root: Conversation;
  /**
   * End the sandboxes the session's commands ran in (LOB-244): their commands, handles and
   * temporary files, never the worktree's files or the exec spill files its transcript names.
   * After `closeHarness`, which settles what still runs in them; `closeSession` does both, in
   * that order.
   */
  readonly releaseEnvironment: Effect.Effect<void>;
  /**
   * The environment the session's commands run in for a working directory (LOB-244): the one the
   * harness's tools get, so what the control plane runs on the session's behalf before a turn — the
   * repo's setup (`./setup`) — runs where the tools would, sandbox and all.
   */
  readonly env: (cwd: string) => Promise<ExecutionEnv>;
  /**
   * The model the root conversation is pinned to, which its requests go to and its compaction
   * thresholds follow: the role's (or the deployment's) when this open created the root, and the
   * one the root was created with on every later open, whatever the role table says now (LOB-207).
   */
  readonly model: ModelAccess;
  /**
   * The submissions this open continued (LOB-25): the ids of the inputs the root conversation held
   * queued or placed — a run a previous process was in the middle of, or queued behind — in id
   * order. A mission worker's submission in its own conversation is not one. Empty when the root
   * held none, and when the open was asked not to resume.
   */
  readonly resumed: readonly string[];
};

/**
 * Continue what a reopened log left unsettled in its root conversation (LOB-25), and answer the
 * submissions that is.
 *
 * Pi Durable reconciles a dead process's `running` tasks to `pending` when a harness opens, but it
 * schedules nothing until something asks for progress (`Harness.resume()`, or a submit or a wait).
 * A run whose process died — a SIGTERM's close or a SIGKILL that ran no finalizer at all — would
 * otherwise sit, placed and unanswered, until somebody happened to send the session something. So
 * a log whose root holds a queued or placed submission is resumed here, deliberately: the run
 * continues as the same submission in the same conversation, with the tool call the death
 * interrupted settled as interrupted rather than run twice, and nothing is submitted again.
 *
 * Only the root's submissions decide it: a mission worker's conversation (`mission-worker.ts`)
 * holds a placed submission of its own while it talks to the model, and that is the mission's work,
 * which LOB-231's `resumeMissions` decides about — a log that holds only that is left paused. What
 * the decision turns on is the whole harness, though: Pi Durable has one scheduler per harness, so
 * resuming continues every pending task in the log, a mission's included — as any submit or wait
 * on that log already does. A log with no root submission unsettled is left paused: nothing a
 * reopen did not need to schedule is. Read through `inspect`, which writes nothing and runs no task
 * code.
 */
export const resumePending = (
  harness: Harness,
  root: Conversation,
): Effect.Effect<readonly string[], SessionError> =>
  Effect.gen(function* () {
    const inspection = yield* attempt("inspect pending work", () =>
      harness.inspect(BACKGROUND_CONTEXT),
    );
    const pending = inspection.submissions
      .filter((record) => record.conversationId === root.id)
      .map((record) => String(record.id));
    if (pending.length > 0) yield* Effect.sync(() => harness.resume());
    return pending;
  });

/**
 * Credential-shaped variables the control plane holds in its own environment (LOB-51, D14).
 *
 * `NodeExecutionEnv` hands every tool command the whole process environment, so a token the server
 * reads at boot would reach the session's shell. A session never needs one: model calls happen in
 * the control plane, and anything that needs a forge token gets it from `CredentialProvider` per
 * call. Each such variable is set to the empty string for the session's commands, which overrides
 * the inherited value and leaves no token bytes in the environment. It is read when the session's
 * sandbox is bound (`./environment`), and the runtime starts every command with it.
 */
const CREDENTIAL_VARIABLE = /(TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY)/i;

export const sessionShellEnv = (
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> =>
  Object.fromEntries(
    Object.keys(env)
      .filter((name) => CREDENTIAL_VARIABLE.test(name))
      .map((name) => [name, ""]),
  );

/**
 * Open a harness over one session's log, ensure its root conversation exists, and continue the
 * submissions the log left unsettled unless told not to (`resume`, LOB-25).
 */
export const openSession = (
  options: OpenSessionOptions,
): Effect.Effect<OpenSession, SessionError> =>
  // Where the commands run (LOB-244): a sandbox per working directory, bound on first use, so a
  // session whose worktree is gone still opens. An open that fails after this releases it.
  openSessionEnvironment(options.sandbox, sessionShellEnv).pipe(
    Effect.flatMap((environment) =>
      openSessionIn(options, environment).pipe(
        Effect.onError(() => environment.release),
      ),
    ),
  );

const openSessionIn = (
  options: OpenSessionOptions,
  environment: SessionEnvironment,
): Effect.Effect<OpenSession, SessionError> =>
  Effect.gen(function* () {
    const registry = createRegistry();
    // What the run's role is (B6, LOB-207): its model, the tools it is not offered, and the
    // read-only stage it makes the run, all from one resolution of the column's role.
    const role = resolveRole(options.run, options.model, options.roles);
    // The agent is pinned when the root is created, and only then (`harness.root` below writes it
    // into a root that does not exist yet), so a reopened run keeps talking to the model it started
    // on. Its compaction thresholds have to follow that same model rather than whatever the role
    // table — or a replay's target — resolves to today, so the pinned one is read first. A root that
    // does not exist yet is pinned to the session's own model when it was created on one (LOB-274),
    // ahead of the role's row, which is ahead of the deployment's model.
    const pinned = yield* readPinnedModel(options.storage);
    // The skill versions the log already pins (D7), read before the root opens like the model is:
    // the open adds a pin only for a skill it has not recorded, and writes nothing when there is none.
    const recordedPins = yield* readSkillPins(options.storage);
    const chosen = options.sessionModel ?? role.model;
    const model =
      pinned === undefined
        ? chosen
        : pinnedAccess(chosen, pinned.provider, pinned.modelId);
    // The column's skills, as prompt sections beside the tools (B6). Installed before the tools so
    // the whole code extension — tools and sections — renders after the run's own instructions.
    const skills = options.run?.skills ?? [];
    // What the repository says (S-repo-instructions-and-skills), assembled once like the pages, so
    // the record below is the value the sections render. Its standing instructions go first, ahead
    // of the column's skills, so the factory's text for this stage reads as the more specific word;
    // its skill index right after them, which it defers to where a name is the column's.
    const repoPrompt =
      options.repo === undefined
        ? undefined
        : assembleRepoPrompt(
            options.repo,
            skills.map((skill) => skill.name),
          );
    if (repoPrompt?.instructions !== undefined) {
      registry.install(repoInstructionsExtension(repoPrompt));
    }
    if (skills.length > 0) registry.install(skillsExtension(skills));
    if (repoPrompt?.skills.text !== undefined) {
      registry.install(repoSkillsExtension(repoPrompt));
    }
    // The knowledge the session carries, one section beside the skills, installed before the tools
    // for the same reason they are. It is assembled and measured here, once, so what the run was
    // told and what it cost are the same value — the record written below is that value, not a
    // second measurement of the same text.
    const pages = options.pages ?? [];
    const pagesPrompt = assemblePages(pages, PAGES_TOKEN_CAP);
    if (pages.length > 0) registry.install(pagesExtension(pagesPrompt));
    // The card's body (LOB-260): what the task asks for, as it was filed, before the thread that
    // answers questions about it. A card with an empty body installs nothing.
    if (options.body !== undefined && renderBody(options.body) !== undefined) {
      registry.install(bodyExtension(options.body));
    }
    // The card's thread beside them (B7, LOB-73): what earlier runs asked and what a person answered,
    // so a run that follows a parked one starts from the answer rather than from the bare card.
    if (options.thread !== undefined) {
      registry.install(threadExtension(options.thread));
    }
    registry.install(CodingTools);
    // Verification beside the tools that make the change (LOB-78): the run can produce evidence of
    // its own surface rather than prose about it.
    registry.install(verifyExtension(options.verify));
    // The ask on the task (B7, LOB-73): only a run bound to a card can ask, because the question is
    // recorded on the card — a scratch session has nobody to ask on and no tool to ask with.
    if (options.ask !== undefined) registry.install(askExtension(options.ask));
    // The specifier's spec (LOB-238): committed to the log and posted on the card, by a tool rather
    // than a file so the read-only stage can make it. Only the role that writes the spec gets it.
    if (options.spec !== undefined && role.writesSpec) {
      registry.install(specExtension(options.spec));
    }
    // The reviewer's review (LOB-36): committed to the log and posted on the PR, the one thing the
    // read-only reviewing stage may say outside its log. Only a review run gets it.
    if (options.review !== undefined && role.writesReview) {
      registry.install(reviewExtension(options.review));
    }
    // The tasks the control plane starts on a session's behalf, installed like any other extension:
    // that is what makes the kind resolvable when a caller creates the task.
    const tasks = options.tasks ?? [];
    if (tasks.length > 0)
      registry.install(defineExtension({ name: "factory.tasks", tasks }));
    // The policy is an extension beside the tools, not a wrapper around them (D15): Pi Durable
    // resolves the hooks of every selected extension before the tool task runs, so a refusal is a
    // task result the model reads, not an exception somewhere in the call path.
    const policy =
      options.policy ?? autonomyPolicy(DEFAULT_AUTONOMY, options.cwd);
    // A column that holds the `docs` skill makes this a documentation run, which may write
    // documentation and nothing else (LOB-195). Composed here, where a policy becomes hooks, so a
    // session cannot be opened with the skill and without the rule.
    const columnPolicy = skills.some((skill) => skill.name === DOCS_SKILL)
      ? docsPolicy(policy)
      : policy;
    // A column whose role is a read-only stage is refused its writes (LOB-74): `write`, `edit`,
    // `verify`, and any `bash` that is not a known read command. The stage is the run's
    // column's, resolved from the same profile, so a session cannot be opened in `specifying` and
    // without the rule either. The refusal stays even though the stage is not offered those three
    // tools (below), because the filter is pinned with the root: a root created before it existed,
    // or one whose tool list was configured since, offers `write` and `edit` again, and the hook is
    // what refuses them there (`policy.hook.test.ts`). Every other call meets `tool_unavailable`.
    const stage = role.stage;
    registry.install(
      policyExtension(
        stage === undefined
          ? columnPolicy
          : readOnlyStagePolicy(columnPolicy, stage),
        options.approvalAsker,
      ),
    );
    // The budget cap (LOB-163, `./budget`), on every session: the cap is a document in the log, so
    // the hook is a no-op until `writeBudget` commits one. It stops a run through the root
    // conversation, which exists only once the harness below is open — and no request can be sent
    // before then, so the hook reads it late rather than taking it here.
    let opened: BudgetSession | undefined;
    registry.install(budgetExtension(() => opened));

    const harness = yield* attempt("open harness", () =>
      HarnessRuntime.open(
        options.storage,
        {
          models: model.models,
          registry,
          env: (target) => environment.env(target.cwd ?? options.cwd),
          settings: {
            progress: SESSION_PROGRESS,
            // Long sessions compact (B4). The thresholds follow the model's context window
            // (`compactionPolicyFor`), so a small-window model compacts where it can instead of
            // never, and a large one keeps pi-durable's pinned defaults. `model` is the root's
            // pinned model on a reopen, so the window is the one the requests actually go to.
            compaction: compactionPolicyFor(model.contextWindow),
          },
        },
        BACKGROUND_CONTEXT,
      ),
    );

    // Everything after the open can fail, and a harness that opened owns a scheduler: one that
    // fails here closes it rather than leaving it running with no owner. `openSession` then releases
    // the environment, and the caller disposes the storage.
    return yield* Effect.gen(function* () {
      // The tools the role is not offered, as the registrations the registry holds: Pi Durable's
      // filter takes tools, and stores their names in the conversation's `pi.agent`.
      const withheld = registry
        .snapshot()
        .tools()
        .map(({ tool }) => tool)
        .filter((tool) => role.withheldTools.has(tool.name));
      // The agent is written when the root is created, and only then: the role's model and its tool
      // filter are pinned to the run when its session first opens, so a change to the deployment's
      // role table reaches the next run rather than one in flight, and a replay keeps the model it
      // was replayed onto. (Under the faux backend the catalog is only the ids the process was booted
      // with, so a run pinned to a `faux/*` id the current `ROLE_MODELS` no longer names finds no
      // model to send to: docs/board.md B6.)
      const root = yield* attempt("open root conversation", () =>
        harness.root(BACKGROUND_CONTEXT, {
          agent: {
            model: {
              provider: model.provider,
              modelId: model.modelId,
            },
            ...(withheld.length === 0 ? {} : { tools: { remove: withheld } }),
            cwd: options.cwd,
          },
        }),
      );
      opened = { root, harness };

      // What the section came to, committed beside it: a page the budget dropped is a fact about this
      // open, and a fact about a prompt that is not in the log is not a fact anyone can check later.
      // Written on every open, an empty page set included, so a session that was told pages once and
      // holds none now records the absence instead of leaving the last answer standing.
      // The skill versions the run was told ride the same commit (D7): what pins a reopened run to
      // the bodies it opened with is in the log by the time anything can be sent.
      yield* writePagePrompt(
        root,
        {
          cap: PAGES_TOKEN_CAP,
          tokens: pagesPrompt.tokens,
          held: pages.length,
          included: pagesPrompt.included,
          dropped: pagesPrompt.dropped,
        },
        mergeSkillPins(recordedPins, skills),
        repoPrompt === undefined ? undefined : repoPromptRecord(repoPrompt),
      );

      // Last, once the harness is fully set up (LOB-25): a run a dead process left in the log carries
      // on here rather than waiting for the next message.
      const resumed =
        options.resume === false ? [] : yield* resumePending(harness, root);

      return {
        harness,
        root,
        model,
        releaseEnvironment: environment.release,
        env: environment.env,
        resumed,
      };
    }).pipe(Effect.onError(() => Effect.exit(closeHarness(harness))));
  });

/**
 * The model the session's root conversation is pinned to, read from its committed `pi.agent`; absent
 * for a log whose root does not exist yet, which is the open that creates it.
 */
const readPinnedModel = (
  storage: Storage,
): Effect.Effect<
  { readonly provider: string; readonly modelId: string } | undefined,
  SessionError
> =>
  Effect.gen(function* () {
    const agent = yield* readDocument(storage, AgentDoc.definition.kind);
    const model = agent?.["model"];
    if (typeof model !== "object" || model === null || Array.isArray(model)) {
      return undefined;
    }
    const { provider, modelId } = model;
    return typeof provider === "string" && typeof modelId === "string"
      ? { provider, modelId }
      : undefined;
  });

/**
 * The model the session's root conversation is pinned to, as `provider/modelId` (LOB-269): what the
 * session summary and the index's `model` column report. Absent for a log whose root does not exist.
 */
export const readPinnedModelKey = (
  storage: Storage,
): Effect.Effect<string | undefined, SessionError> =>
  Effect.map(readPinnedModel(storage), (pinned) =>
    pinned === undefined ? undefined : `${pinned.provider}/${pinned.modelId}`,
  );

/**
 * The access for the model a root is pinned to, from the catalog `access` was built with. A model
 * the catalog no longer serves keeps its name — the request fails with Pi Durable's "no model"
 * rather than silently going to another one — and gets the package's own compaction defaults,
 * because there is no window to derive thresholds from.
 */
const pinnedAccess = (
  access: ModelAccess,
  provider: string,
  modelId: string,
): ModelAccess =>
  modelAccessFor(access, `${provider}/${modelId}`) ?? {
    ...access,
    provider,
    modelId,
    contextWindow: 0,
  };

/** What the `pages` section came to when a session opened, as the log records it (LOB-205). */
export type PagePromptRecord = {
  /** The budget the section was assembled under, in tokens. */
  readonly cap: number;
  /** What the rendered section cost, tag included. */
  readonly tokens: number;
  /** How many pages the session held when it opened: `0` is a session with no pages at all. */
  readonly held: number;
  /** The pages it carried, in the order it carried them. */
  readonly included: readonly string[];
  /** The pages the budget left out, in the order they were ranked. */
  readonly dropped: readonly string[];
};

/**
 * Commit what the session's `pages` section came to.
 *
 * A document rather than an entry: this is state — the latest answer for this session's prompt — and
 * not an event in the transcript, so an attached client has nothing to render and the model has
 * nothing to read.
 */
export const writePagePrompt = (
  conversation: Conversation,
  record: PagePromptRecord,
  /** The run's skill pins (D7), when this open changes them; absent leaves the document alone. */
  skillPins?: readonly SkillPin[],
  /**
   * What the repository's sections came to (S-repo-instructions-and-skills), for an open that read
   * a repository; absent leaves the document alone.
   */
  repoPrompt?: RepoPromptRecord,
): Effect.Effect<void, SessionError> =>
  attempt("write page prompt", () =>
    conversation.commit(
      (tx) =>
        // The open's one commit also opens the approval ledger (LOB-243), before anything in this
        // session can append an approval entry: a no-op once it is seeded, and the one-time seed of
        // a log written before the ledger existed. No open pays a commit of its own for it.
        approvalLedger(tx, conversation.id).then(() =>
          Promise.all([
            tx.doc(PagePromptDoc, conversation.id).then((doc) => {
              doc.cap = record.cap;
              doc.tokens = record.tokens;
              doc.held = record.held;
              doc.included = [...record.included];
              doc.dropped = [...record.dropped];
            }),
            skillPins === undefined
              ? Promise.resolve()
              : tx.doc(SkillPinsDoc, conversation.id).then((doc) => {
                  doc.skills = skillPins.map((pin) => ({
                    name: pin.name,
                    version: pin.version,
                  }));
                }),
            repoPrompt === undefined
              ? Promise.resolve()
              : tx.doc(RepoPromptDoc, conversation.id).then((doc) => {
                  doc.ref = repoPrompt.ref;
                  doc.commit = repoPrompt.commit;
                  doc.instructions =
                    repoPrompt.instructions === null
                      ? null
                      : { ...repoPrompt.instructions };
                  doc.skills = {
                    tokens: repoPrompt.skills.tokens,
                    cap: repoPrompt.skills.cap,
                    listed: repoPrompt.skills.listed.map(({ name, path }) => ({
                      name,
                      path,
                    })),
                    dropped: [...repoPrompt.skills.dropped],
                    shadowed: [...repoPrompt.skills.shadowed],
                  };
                }),
          ]).then(() => undefined),
        ),
      BACKGROUND_CONTEXT,
    ),
  );

/**
 * The pins a run's log should hold after this open (D7): every pin it already recorded, then one for
 * each skill the run was given that it had not pinned, in the order given. `undefined` when that adds
 * nothing, so an open that changes no pin writes no pin. A recorded pin is never replaced: the
 * control plane resolved this run's skills *from* those pins (`loadRun`), so a given skill whose
 * version disagrees with its pin would be a bug upstream, and the pin is what stays true.
 */
export const mergeSkillPins = (
  recorded: readonly SkillPin[],
  given: readonly RunSkill[],
): readonly SkillPin[] | undefined => {
  const pinned = new Set(recorded.map((pin) => pin.name));
  const added = given
    .filter((skill) => !pinned.has(skill.name))
    .map((skill) => ({ name: skill.name, version: skill.version }));
  // One pin per name, the first given winning: a column that names a skill twice pins it once.
  const unique = added.filter(
    (pin, index) =>
      added.findIndex((other) => other.name === pin.name) === index,
  );
  return unique.length === 0 ? undefined : [...recorded, ...unique];
};

/**
 * The skill versions a log pins (D7, `factory.skills`), read without owning it: what the control
 * plane hands `loadRun` so a reopened run keeps the bodies it opened with, and what a reader checks
 * to learn which version a run was told. Empty for a log no open has pinned — a scratch session, a
 * column with no skills, or a log older than the document. An entry that is not a name and a
 * positive integer version is skipped rather than trusted.
 */
export const readSkillPins = (
  storage: Storage,
): Effect.Effect<readonly SkillPin[], SessionError> =>
  Effect.map(readDocument(storage, SKILLS_DOC_KIND), (value) => {
    const skills = value?.["skills"];
    if (!Array.isArray(skills)) return [];
    const pins: SkillPin[] = [];
    for (const entry of skills) {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry))
        continue;
      const { name, version } = entry;
      if (
        typeof name === "string" &&
        typeof version === "number" &&
        Number.isInteger(version) &&
        version >= 1
      ) {
        pins.push({ name, version });
      }
    }
    return pins;
  });

/**
 * What the session's repository told its last open (S-repo-instructions-and-skills), read without
 * owning the log: `undefined` for a log no open on a repository has written — a scratch session, or
 * one older than the record. A value that is not the record's shape is `undefined` too, rather than
 * a record trusted half-read.
 */
export const readRepoPrompt = (
  storage: Storage,
): Effect.Effect<RepoPromptRecord | undefined, SessionError> =>
  Effect.map(readDocument(storage, REPO_PROMPT_DOC_KIND), (value) => {
    if (value === undefined) return undefined;
    const decoded = Schema.decodeUnknownOption(RepoPromptRecordSchema)(value);
    return Option.isNone(decoded) || decoded.value.skills.cap === 0
      ? undefined
      : decoded.value;
  });

/** The record's shape, as a reader of the log checks it (`readRepoPrompt`). */
const RepoPromptRecordSchema = Schema.Struct({
  ref: Schema.String,
  commit: Schema.String,
  instructions: Schema.NullOr(
    Schema.Struct({
      path: Schema.String,
      bytes: Schema.Number,
      tokens: Schema.Number,
      cap: Schema.Number,
      truncated: Schema.Boolean,
    }),
  ),
  skills: Schema.Struct({
    tokens: Schema.Number,
    cap: Schema.Number,
    listed: Schema.Array(
      Schema.Struct({ name: Schema.String, path: Schema.String }),
    ),
    dropped: Schema.Array(Schema.String),
    shadowed: Schema.Array(Schema.String),
  }),
});

/**
 * What this session's last open was told, or `undefined` when it has never been opened.
 *
 * The record is written on every open, so "no pages" is a record saying `held: 0` rather than a
 * missing one; `undefined` is the document's seed, which only a session this harness never opened
 * can have.
 */
export const readPagePrompt = (
  harness: Harness,
  conversation: Conversation,
): Effect.Effect<PagePromptRecord | undefined, SessionError> =>
  attempt("read page prompt", () =>
    harness.snapshot(PagePromptDoc, conversation.id, BACKGROUND_CONTEXT),
  ).pipe(
    Effect.map((record) =>
      record === undefined || record.cap === 0 ? undefined : record,
    ),
  );
/**
 * An approval request, committed to the log the moment the session asks (D11). Like the title it
 * carries no model content, so the agent never sees it.
 *
 * The three approval entry definitions are module-private on purpose (LOB-243): an approval entry
 * appended without its copy in the approval ledger is one a historical read cannot see, so the only
 * way to append one is `writeApprovalRequested`, `writeApprovalDecided` or `writeApprovalUsed`.
 */
const ApprovalRequestedEntry = defineEntry<{
  readonly requestId: string;
  readonly action: string;
  readonly detail: string;
  readonly requestedAt: string;
}>(APPROVAL_REQUESTED_KIND);

/** The answer to one approval request, committed beside it. */
const ApprovalDecidedEntry = defineEntry<{
  readonly requestId: string;
  readonly decision: ApprovalVerdict;
  readonly actor: string;
  readonly decidedAt: string;
}>(APPROVAL_DECIDED_KIND);

/** Entries per transaction scan while seeding or catching up an approval ledger. */
const LEDGER_SEED_PAGE = 500;

/**
 * The conversation's approval ledger (`ApprovalsDoc`, LOB-243), opened for writing in `tx` and
 * complete through the log's newest entry.
 *
 * A ledger that is not seeded yet is rebuilt from every approval entry the conversation holds,
 * oldest first. With `catchUp`, a seeded ledger is also given the approval entries appended after
 * `through` without a copy — what a build from before the ledger writes into a log this build
 * already seeded (a rollback, a mixed-version deploy, two worktrees on one database). Either way
 * `through` moves to the newest entry scanned, so each entry is scanned at most once over the life
 * of the log. Every write that appends an approval entry opens the ledger here first and then copies
 * its entry in, so a seeded ledger holds exactly the conversation's approval entries up to `through`
 * — the property a reader relies on when it folds the ledger instead of the transcript.
 *
 * The seed walks the transcript once per log: a new log has nothing to walk, and a log written
 * before the ledger existed pays it the first time it is opened (`writePagePrompt`, the open's own
 * commit). An open does not catch up — it would cost every open the entries of the run before it —
 * and an approval write does, which is human-paced and rare.
 */
const approvalLedger = (
  tx: Tx,
  conversationId: ConversationId,
  options: { readonly catchUp: boolean } = { catchUp: false },
) => {
  /** Every approval entry from `cursor` on, newest first, appended to `held`. */
  const scan = (
    from: number,
    held: { kind: string; data: JsonValue }[],
    newest: { id: number },
    cursor: Cursor | undefined,
  ): Promise<{ kind: string; data: JsonValue }[]> =>
    tx
      .scanEntries(
        from > 0
          ? { conversationId, minEntryId: (from + 1) as EntryId }
          : { conversationId },
        LEDGER_SEED_PAGE,
        cursor,
      )
      .then((page) => {
        for (const entry of page.items) {
          newest.id = Math.max(newest.id, Number(entry.id));
          if (APPROVAL_ENTRY_KINDS.has(entry.kind))
            held.push({ kind: entry.kind, data: entry.data ?? null });
        }
        return page.next === undefined
          ? held
          : scan(from, held, newest, page.next);
      });
  return tx.doc(ApprovalsDoc, conversationId).then((ledger) => {
    // A ledger without a numeric `through` predates it and is rebuilt like an unseeded one.
    const through =
      ledger.seeded && typeof ledger.through === "number"
        ? ledger.through
        : undefined;
    if (through !== undefined && !options.catchUp) return ledger;
    const newest = { id: through ?? 0 };
    return scan(through ?? 0, [], newest, undefined).then((held) => {
      if (through === undefined) ledger.entries.splice(0);
      // Scans are newest first; the ledger is in log order, which is the order the fold reads.
      for (const entry of held.reverse()) ledger.entries.push(entry);
      ledger.seeded = true;
      ledger.through = newest.id;
      return ledger;
    });
  });
};

/**
 * Commit one approval entry and its copy in the conversation's ledger, in one commit: the entry is
 * what the transcript and a rebuild fold, the copy what a historical read folds (LOB-243).
 */
const commitApprovalEntry = (
  conversation: Conversation,
  entry: {
    readonly kind: string;
    readonly data: JsonValue;
    readonly append: (tx: Tx) => Promise<{ readonly id: EntryId }>;
  },
  label: string,
): Effect.Effect<EntryId, SessionError> =>
  attempt(label, () =>
    conversation.commit(
      (tx) =>
        approvalLedger(tx, conversation.id, { catchUp: true }).then((ledger) =>
          entry.append(tx).then((appended) => {
            ledger.entries.push({ kind: entry.kind, data: entry.data });
            ledger.through = Math.max(ledger.through, Number(appended.id));
            return appended.id;
          }),
        ),
      BACKGROUND_CONTEXT,
    ),
  );

/** Commit an approval request. Appends to the log; the pending set is the caller's to update. */
export const writeApprovalRequested = (
  conversation: Conversation,
  data: {
    readonly requestId: string;
    readonly action: string;
    readonly detail: string;
    readonly requestedAt: string;
  },
): Effect.Effect<EntryId, SessionError> =>
  commitApprovalEntry(
    conversation,
    {
      kind: ApprovalRequestedEntry.kind,
      data,
      append: (tx) =>
        tx.appendEntry(ApprovalRequestedEntry, conversation.id, { data }),
    },
    "write approval request",
  );

/** Commit an approval decision. Appends to the log; the pending set is the caller's to update. */
export const writeApprovalDecided = (
  conversation: Conversation,
  data: {
    readonly requestId: string;
    readonly decision: ApprovalVerdict;
    readonly actor: string;
    readonly decidedAt: string;
  },
): Effect.Effect<EntryId, SessionError> =>
  commitApprovalEntry(
    conversation,
    {
      kind: ApprovalDecidedEntry.kind,
      data,
      append: (tx) =>
        tx.appendEntry(ApprovalDecidedEntry, conversation.id, { data }),
    },
    "write approval decision",
  );

/** An approval spent: a gated call ran on it (LOB-52). Committed before the call runs. */
const ApprovalUsedEntry = defineEntry<{
  readonly requestId: string;
  readonly usedAt: string;
}>(APPROVAL_USED_KIND);

/** Commit an approval's use. Appends to the log; the index is the caller's to update. */
export const writeApprovalUsed = (
  conversation: Conversation,
  data: { readonly requestId: string; readonly usedAt: string },
): Effect.Effect<EntryId, SessionError> =>
  commitApprovalEntry(
    conversation,
    {
      kind: ApprovalUsedEntry.kind,
      data,
      append: (tx) =>
        tx.appendEntry(ApprovalUsedEntry, conversation.id, { data }),
    },
    "write approval use",
  );

/** Commit a title. Appends to the log; the `sessions` index is the caller's to update. */
export const writeTitle = (
  conversation: Conversation,
  title: string,
): Effect.Effect<EntryId, SessionError> =>
  attempt("write title", () =>
    conversation
      .commit(
        (tx) =>
          tx.appendEntry(TitleEntry, conversation.id, { data: { title } }),
        BACKGROUND_CONTEXT,
      )
      .then((entry) => entry.id),
  );

/**
 * Commit the repo binding. The log, not the `sessions` row, is what makes the binding survive a
 * dropped index; the caller updates the row as well so summaries need no fold (docs/features.md §3
 * A1).
 */
export const writeRepoBinding = (
  conversation: Conversation,
  binding: RepoBinding,
): Effect.Effect<void, SessionError> =>
  attempt("write repo binding", () =>
    conversation.commit(
      (tx) =>
        tx.doc(SessionDoc, conversation.id).then((doc) => {
          doc.repo = binding.repo;
          doc.baseRef = binding.baseRef;
          // Written on every binding commit, empty included: a document that kept an earlier
          // session's branch after a rebind would name a branch the worktree is not on.
          doc.branch = binding.branch ?? "";
        }),
      BACKGROUND_CONTEXT,
    ),
  );

/** Commit the session's actor (LOB-162). The `sessions` row is the caller's to update. */
export const writeActor = (
  conversation: Conversation,
  actor: string,
): Effect.Effect<void, SessionError> =>
  attempt("write actor", () =>
    conversation.commit(
      (tx) =>
        tx.doc(ActorDoc, conversation.id).then((doc) => {
          doc.actor = actor;
        }),
      BACKGROUND_CONTEXT,
    ),
  );

export type TaskBinding = {
  readonly taskId: string;
  readonly column: string;
};

/** The PR a session opened, as the log records it. */
export type PullRequestRecord = {
  readonly url: string;
  readonly number: number;
  readonly base: string;
  readonly head: string;
  readonly openedAt: string;
  /**
   * What the PR's body states was verified (LOB-79). Absent only on a PR recorded before evidence
   * existed: the step always derives one, `EvidenceNone` included.
   */
  readonly evidence?: PrEvidence;
};

/**
 * The PR a session opened, announced in the transcript so an attached client learns the link
 * (LOB-177) and, since LOB-79, what it says was verified. It carries no model content, so the agent
 * never sees it.
 */
export const PrOpenedEntry = defineEntry<{
  readonly url: string;
  readonly number: number;
  readonly evidence?: JsonValue;
}>(PR_OPENED_ENTRY_KIND);

/** Evidence as a document field: the schema's own encoding, which is plain JSON. */
const encodeEvidence = (evidence: PrEvidence): JsonValue =>
  Schema.encodeSync(PrEvidenceSchema)(evidence);

/**
 * Commit the PR a session opened. The log, not the `sessions` row, is what makes the link survive a
 * dropped index; the caller updates the row as well so a list needs no fold (LOB-177).
 *
 * One commit, two shapes of the same fact, because they answer different questions: the `factory.pr`
 * document is the record a retried step reads before it calls GitHub, and the entry is what an
 * attached client can see — Pi Durable mounts only its own documents in a conversation view, so a
 * document alone would open the PR silently for everyone already watching.
 */
export const writePullRequestDoc = (
  conversation: Conversation,
  pullRequest: PullRequestRecord,
): Effect.Effect<void, SessionError> =>
  attempt("write pull request", () =>
    conversation.commit(
      (tx) =>
        Promise.all([
          tx.doc(PrDoc, conversation.id).then((doc) => {
            doc.url = pullRequest.url;
            doc.number = pullRequest.number;
            doc.base = pullRequest.base;
            doc.head = pullRequest.head;
            doc.openedAt = pullRequest.openedAt;
            doc.evidence =
              pullRequest.evidence === undefined
                ? null
                : encodeEvidence(pullRequest.evidence);
          }),
          tx.appendEntry(PrOpenedEntry, conversation.id, {
            data: {
              url: pullRequest.url,
              number: pullRequest.number,
              ...(pullRequest.evidence === undefined
                ? {}
                : { evidence: encodeEvidence(pullRequest.evidence) }),
            },
          }),
        ]),
      BACKGROUND_CONTEXT,
    ),
  );

/**
 * The PR this session already opened, read from the committed document — so a step that runs twice
 * reads the first run's answer instead of asking GitHub again. `undefined` when there is none.
 */
export const readPullRequestDoc = (
  harness: Harness,
  conversation: Conversation,
): Effect.Effect<PullRequestRecord | undefined, SessionError> =>
  Effect.gen(function* () {
    const doc = yield* attempt("read pull request", () =>
      harness.snapshot(PrDoc, conversation.id, BACKGROUND_CONTEXT),
    );
    if (doc === undefined || doc.url === "") return undefined;
    const evidence = evidenceAt(doc);
    return {
      url: doc.url,
      number: doc.number,
      base: doc.base,
      head: doc.head,
      openedAt: doc.openedAt,
      ...(evidence === undefined ? {} : { evidence }),
    };
  });

/**
 * What a session's `factory.merge` records (LOB-44): the merge of the PR it opened, and the revert
 * that undid it once one merged. `revert` is absent while nothing reverted it.
 */
export type MergeRecord = {
  readonly url: string;
  readonly number: number;
  readonly mergedAt: string;
  /** The merge commit GitHub reported, when it reported one. */
  readonly commit?: string;
  readonly revert?: { readonly by: string; readonly at: string };
};

/** One fact the GitHub webhook reports about a session's PR: its merge, or its revert. */
export type MergeEvent =
  | {
      readonly _tag: "merged";
      readonly url: string;
      readonly number: number;
      readonly mergedAt: string;
      readonly commit?: string;
    }
  | {
      readonly _tag: "reverted";
      /** The PR that reverted this one, by its page. */
      readonly by: string;
      readonly revertedAt: string;
    };

/** A `factory.merge` view as the record readers take: `undefined` for a document with neither fact. */
const mergeRecordOf = (doc: MergeDocView): MergeRecord | undefined => {
  if (doc.mergedAt === "" && doc.revertedAt === "") return undefined;
  return {
    url: doc.url,
    number: doc.number,
    mergedAt: doc.mergedAt,
    ...(doc.commit === "" ? {} : { commit: doc.commit }),
    ...(doc.revertedAt === ""
      ? {}
      : { revert: { by: doc.revertedBy, at: doc.revertedAt } }),
  };
};

/**
 * Commit one merge fact to a session this process owns (LOB-44), unless the log already holds it:
 * the first merge and the first revert stand, so a redelivered webhook commits nothing and answers
 * `first: false` with what the log already says. The `sessions` columns are the caller's to update.
 *
 * Decided inside the commit, from the document as the mutation line holds it, and writing only the
 * fields the event owns: a merge and a revert committed at once each keep the other's fact. A
 * repeat touches no field, so it commits nothing.
 */
export const recordMergeEvent = (
  conversation: Conversation,
  event: MergeEvent,
): Effect.Effect<
  { readonly first: boolean; readonly merge: MergeRecord },
  SessionError
> =>
  Effect.gen(function* () {
    const { first, next } = yield* attempt("write merge", () =>
      conversation.commit(
        (tx) =>
          tx.doc(MergeDoc, conversation.id).then((doc) => {
            const current = projectMergeDoc(doc);
            if (event._tag === "merged") {
              if (current.mergedAt !== "")
                return { first: false, next: current };
              doc.url = event.url;
              doc.number = event.number;
              doc.mergedAt = event.mergedAt;
              doc.commit = event.commit ?? "";
            } else {
              if (current.revertedAt !== "")
                return { first: false, next: current };
              doc.revertedBy = event.by;
              doc.revertedAt = event.revertedAt;
            }
            return { first: true, next: projectMergeDoc(doc) };
          }),
        BACKGROUND_CONTEXT,
      ),
    );
    const merge = mergeRecordOf(next);
    // `next` holds the event's own fact whichever branch built it, so a record is always there.
    if (merge === undefined) {
      return yield* new SessionErrorClass({
        code: "storage",
        message: "a merge record was written with neither a merge nor a revert",
      });
    }
    return { first, merge };
  });

/** The merge a log nobody owns records (LOB-44), from its `factory.merge` document alone. */
export const readRecordedMerge = (
  storage: Storage,
): Effect.Effect<MergeRecord | undefined, SessionError> =>
  Effect.map(readDocument(storage, MERGE_DOC_KIND), (value) =>
    mergeRecordOf(projectMergeDoc(value)),
  );

/**
 * Every `verify` call in a session this process owns, oldest first, read through its conversation
 * (LOB-79): its record, or `undefined` for a call that left none (blocked or crashed). What the PR
 * step derives the body's evidence from, so a newest call without a record is said rather than
 * skipped. `readVerifyRecords` reads the records alone from a log nobody owns.
 */
export const readConversationVerifyCalls = (
  conversation: Conversation,
): Effect.Effect<readonly (VerifyRecord | undefined)[], SessionError> =>
  Effect.map(readConversationEntries(conversation), verifyCallsIn);

/**
 * Commit the session's spec (LOB-72), after `decodeSpec` accepts it.
 *
 * The input is `unknown` on purpose: a spec arrives from a model's completion call or a request
 * body, and the validator is the only thing that may say it is one. A refusal commits nothing — the
 * log keeps whatever spec it held before, so a bad second attempt cannot erase a good first one — and
 * fails with the `SpecRefused` that names the field, `gaps` when the specifier declared none. A run's
 * own writer is the `spec` tool (LOB-238, `./specify`), which shares the validator and `commitSpec`.
 *
 * Every field is written on every commit, empty lists included: a spec that kept an earlier
 * attempt's gaps after a rewrite would declare gaps the specifier withdrew. Answers the spec as
 * committed, which is the decoded value rather than the input.
 */
export const writeSpec = (
  conversation: Conversation,
  input: unknown,
): Effect.Effect<Spec, SpecRefused | SessionError> =>
  Effect.gen(function* () {
    const spec = yield* decodeSpec(input);
    yield* attempt("write spec", () =>
      conversation.commit(
        (tx) => commitSpec(tx, conversation.id, spec),
        BACKGROUND_CONTEXT,
      ),
    );
    return spec;
  });

/**
 * The session's spec, read from the committed document. `undefined` when it never committed one:
 * the document's seed is not a spec (`projectSpec`), so "never specified" and "specified, no gaps"
 * stay two answers.
 */
export const readSpec = (
  harness: Harness,
  conversation: Conversation,
): Effect.Effect<Spec | undefined, SessionError> =>
  attempt("read spec", () =>
    harness.snapshot(SpecDoc, conversation.id, BACKGROUND_CONTEXT),
  ).pipe(Effect.map(projectSpec));

/**
 * A run that found nothing to publish, announced in the transcript (LOB-196).
 *
 * It carries no model content, so the agent never sees it — which is the point: the step's answer
 * is a fact about the branch, not a turn. It is an entry rather than a document because a no-change
 * answer leaves no state behind (no `factory.pr`, no `pr_url` row), so the log's transcript is the
 * only place a person can see that the run ran and published nothing.
 *
 * The sentence names documentation because an unchanged branch is the *docs* run's ordinary result
 * (LOB-37: docs that need no edit). The guard itself is about the diff, not about the skill: any
 * run whose branch is even with its base has no PR to open, and GitHub would refuse one anyway.
 */
export const NoDocumentationChangeEntry = defineEntry<{
  readonly text: string;
}>(NO_CHANGE_ENTRY_KIND);

/** The line this entry carries: what a no-op run says it did. */
export const noDocumentationChange = (base: string): string =>
  `no documentation change: the branch has nothing to publish against ${base}`;

/**
 * Announce that the run published nothing. Nothing else is written: there is no PR to record, so a
 * retry of this step re-measures the branch rather than reading this entry.
 */
export const writeNoDocumentationChange = (
  conversation: Conversation,
  base: string,
): Effect.Effect<EntryId, SessionError> =>
  attempt("write no documentation change", () =>
    conversation
      .commit(
        (tx) =>
          tx.appendEntry(NoDocumentationChangeEntry, conversation.id, {
            data: { text: noDocumentationChange(base) },
          }),
        BACKGROUND_CONTEXT,
      )
      .then((entry) => entry.id),
  );

/**
 * A settled run whose PR step opened no PR, announced in the transcript (C18). Like the no-change
 * entry it carries no model content, so the agent never reads it as a turn, and nothing else is
 * written: the next settle (or an operator's call) runs the step afresh.
 */
export const PullRequestNotOpenedEntry = defineEntry<{
  readonly text: string;
}>(PR_NOT_OPENED_ENTRY_KIND);

/** Announce why a settled run's PR step opened nothing; `text` is the control plane's sentence. */
export const writePullRequestNotOpened = (
  conversation: Conversation,
  text: string,
): Effect.Effect<EntryId, SessionError> =>
  attempt("write PR not opened", () =>
    conversation
      .commit(
        (tx) =>
          tx.appendEntry(PullRequestNotOpenedEntry, conversation.id, {
            data: { text },
          }),
        BACKGROUND_CONTEXT,
      )
      .then((entry) => entry.id),
  );

/** Entries per round trip while reading back to a run's start; most runs fit in one page. */
const RUN_ENDING_PAGE = 50;

/**
 * How the root's newest run ended (C18, `runEndingOf`), read newest first and only as far back as
 * that run's newest user input, so a long session costs a page, not its whole transcript.
 */
export const readRunEnding = (
  conversation: Conversation,
): Effect.Effect<RunEnding, SessionError> =>
  Effect.gen(function* () {
    const read: EntryRecord[] = [];
    let cursor: Cursor | undefined;
    for (;;) {
      const page = yield* attempt("scan the run's entries", () =>
        conversation.entries({}, RUN_ENDING_PAGE, cursor, BACKGROUND_CONTEXT),
      );
      read.push(...page.items);
      cursor = page.next;
      if (cursor === undefined) break;
      if (page.items.some((entry) => entry.kind === "pi.user")) break;
    }
    return runEndingOf(read);
  });

/**
 * A cited knowledge page, announced in the transcript (LOB-204).
 *
 * It carries no model content, so the agent never sees it; the fold over these entries is what a
 * rebuild reads, because a document is not part of `commits`.
 */
export const PageEntry = defineEntry<{
  readonly name: string;
  readonly kind: string;
  readonly content: string;
  readonly links: string[];
  readonly sources: string[];
}>(PAGE_ENTRY_KIND);

/**
 * Commit one page: the `factory.page` family member, keyed by its name, and the entry that
 * announces it, in one commit (LOB-204).
 *
 * Two shapes of one fact, for the reason the PR step has two (LOB-177): the document is the typed
 * record a reader asks for by name, and the entry is what a fold — a rebuild included — can see.
 * The row `session_pages` reads is the caller's to write, as the `sessions` row is the PR step's.
 */
export const writePage = (
  conversation: Conversation,
  page: PageLogRecord,
): Effect.Effect<void, SessionError> =>
  attempt("write page", () =>
    conversation.commit(
      (tx) =>
        Promise.all([
          tx.doc(PageDoc, conversation.id, page.name, page.name).then((doc) => {
            doc.name = page.name;
            doc.kind = page.kind;
            doc.content = page.content;
            doc.links = [...page.links];
            doc.sources = [...page.sources];
          }),
          tx.appendEntry(PageEntry, conversation.id, {
            // Copied into mutable arrays: the entry's data is JSON, and a `readonly string[]` is
            // not one (`JsonValue` wants the mutable array).
            data: {
              name: page.name,
              kind: page.kind,
              content: page.content,
              links: [...page.links],
              sources: [...page.sources],
            },
          }),
        ]),
      BACKGROUND_CONTEXT,
    ),
  );

/**
 * One page, read from the committed document. `undefined` when this session never committed one by
 * that name — a family member that was never written has no record to read, and an empty seed is
 * not a page.
 */
export const readPage = (
  harness: Harness,
  conversation: Conversation,
  name: string,
): Effect.Effect<PageLogRecord | undefined, SessionError> =>
  Effect.gen(function* () {
    const doc = yield* attempt("read page", () =>
      harness.snapshot(PageDoc, conversation.id, name, BACKGROUND_CONTEXT),
    );
    if (doc === undefined || doc.kind === "") return undefined;
    return {
      name: doc.name,
      kind: doc.kind,
      content: doc.content,
      links: doc.links,
      sources: doc.sources,
    };
  });

/**
 * Commit the pull request and head a reviewer run is opened for (LOB-36), as `factory.review`'s target.
 * Written by the control plane at create, before the run is told anything, so the review the tool
 * commits later is about a head the log already names rather than one the model chose.
 */
export const writeReviewTarget = (
  conversation: Conversation,
  target: ReviewTarget,
): Effect.Effect<void, SessionError> =>
  attempt("write review target", () =>
    conversation.commit(
      (tx) =>
        tx.doc(ReviewDoc, conversation.id).then((doc) => {
          doc.repo = target.repo;
          doc.number = target.number;
          doc.url = target.url;
          doc.base = target.base;
          doc.head = target.head;
        }),
      BACKGROUND_CONTEXT,
    ),
  );

/** A reviewer run's target and, once the `review` tool ran, its verdict (`factory.review`). */
export type RecordedReview = {
  readonly target: ReviewTarget;
  /** Absent until the tool committed one. */
  readonly verdict?: "pass" | "fail";
  /** `unposted`, `clean`, `posted` or `stale`; absent with the verdict. */
  readonly outcome?: string;
  /** The comment's link when `posted`, the head the PR moved to when `stale`. */
  readonly outcomeDetail?: string;
  /**
   * The dimensions the verdict failed, in the comment's order; present with the verdict, and empty
   * on a `pass` (a review fails exactly when one of its dimensions does). What a board's
   * `review_verdict` refusal names (LOB-241).
   */
  readonly failing?: readonly ReviewDimension[];
};

/**
 * The review a log records, read from its `factory.review` document alone — `undefined` for a run that
 * was opened for no pull request. Works on a log nobody owns, as `readRecordedPullRequest` does.
 */
export const readRecordedReview = (
  storage: Storage,
): Effect.Effect<RecordedReview | undefined, SessionError> =>
  Effect.map(readDocument(storage, REVIEW_DOC_KIND), (value) => {
    const text = (key: string): string => {
      const field = value?.[key];
      return typeof field === "string" ? field : "";
    };
    const number = value?.["number"];
    if (text("head") === "" || typeof number !== "number") return undefined;
    const verdict = text("verdict");
    // Plain JSON, as `commitVerdict` stores it: each dimension `{ verdict, findings }`.
    const dimensions = value?.["dimensions"];
    const failed = (dimension: ReviewDimension): boolean => {
      const entry =
        typeof dimensions === "object" &&
        dimensions !== null &&
        !Array.isArray(dimensions)
          ? dimensions[dimension]
          : undefined;
      return (
        typeof entry === "object" &&
        entry !== null &&
        !Array.isArray(entry) &&
        entry["verdict"] === "fail"
      );
    };
    return {
      target: {
        repo: text("repo"),
        number,
        url: text("url"),
        base: text("base"),
        head: text("head"),
      },
      ...(verdict === "pass" || verdict === "fail"
        ? {
            verdict,
            outcome: text("outcome"),
            outcomeDetail: text("outcomeDetail"),
            failing: REVIEW_DIMENSIONS.filter(failed),
          }
        : {}),
    };
  });

/** Commit the task binding. */
export const writeTaskBinding = (
  conversation: Conversation,
  binding: TaskBinding,
): Effect.Effect<void, SessionError> =>
  attempt("write task binding", () =>
    conversation.commit(
      (tx) =>
        tx.doc(TaskDoc, conversation.id).then((doc) => {
          (doc as { taskId?: string; column?: string }).taskId = binding.taskId;
          (doc as { taskId?: string; column?: string }).column = binding.column;
        }),
      BACKGROUND_CONTEXT,
    ),
  );

/** Where a fork came from, as the fork's own log records it. */
export type ForkLineage = {
  readonly parent: string;
  /** The entry the fork was taken at, or `""` when the parent had no entries. */
  readonly at: string;
};

/** The message a caller sends a session, in the control plane's terms. */
export type MessageDraft = {
  readonly content: string;
  readonly requestId?: string;
  readonly whenBusy?: "steer" | "followUp" | "reject";
};

/**
 * A message Pi Durable has admitted. `submissionId` is the wire form of its id: Pi Durable's ids
 * are branded numbers today, and the API contract keeps them opaque strings.
 */
export type SubmittedMessage = {
  readonly submissionId: string;
  readonly submission: Submission;
  readonly queued: boolean;
};

export const submitMessage = (
  conversation: Conversation,
  draft: MessageDraft,
): Effect.Effect<SubmittedMessage, SessionError> =>
  Effect.gen(function* () {
    const submission = yield* Effect.tryPromise({
      try: () =>
        conversation.submit(
          {
            type: "input",
            content: draft.content,
            ...(draft.requestId === undefined
              ? {}
              : { requestId: draft.requestId }),
            ...(draft.whenBusy === undefined
              ? {}
              : { whenBusy: draft.whenBusy }),
          },
          BACKGROUND_CONTEXT,
        ),
      catch: (cause) =>
        sessionError(
          "submit message",
          cause,
          isBusyCause(cause) ? "busy" : "harness",
        ),
    });
    const record = yield* attempt("read submission", () =>
      submission.status(BACKGROUND_CONTEXT),
    );
    // A queued input waits in the conversation's inbox; a placed one is owned by a run (spec §6).
    return {
      submissionId: String(submission.id),
      submission,
      queued: record.status === "queued",
    };
  });

/**
 * Wait for a prompt this harness runs to settle — answered, or over without an answer (LOB-199). The
 * record is what `readPromptSubmission` found in committed storage; one that is already over needs
 * no wait, and the handle is looked up by id rather than kept from the submit, so a process that
 * reopened the log after a restart waits on the same run its predecessor started.
 */
export const waitForPrompt = (
  harness: Harness,
  record: SubmissionRecord,
): Effect.Effect<void, SessionError> =>
  Effect.gen(function* () {
    if (record.status !== "queued" && record.status !== "placed") return;
    const submission = yield* attempt("find submission", () =>
      harness.submission(record.id, BACKGROUND_CONTEXT),
    );
    if (submission === undefined) return;
    yield* attempt("wait for submission", () =>
      submission.wait(BACKGROUND_CONTEXT),
    );
  });

export const interrupt = (
  conversation: Conversation,
): Effect.Effect<void, SessionError> =>
  attempt("interrupt", () => conversation.abort(BACKGROUND_CONTEXT));

/**
 * An operator's interrupt, announced in the transcript (C8). It carries no model content, so the
 * agent never sees it: a later message starts a run whose context is the turns before it.
 */
export const InterruptedEntry = defineEntry<{
  readonly text: string;
}>(INTERRUPTED_ENTRY_KIND);

/** The line an interrupted turn ends with, in the transcript and in a terminal. */
export const INTERRUPTED_TEXT =
  "interrupted: the run was stopped before it finished";

/**
 * What an interrupt came to (C8): `interrupted` when there was a run to stop, `not_running` when the
 * root had no run and no unsettled submission, so nothing was aborted and nothing was written.
 */
export type StopOutcome = "interrupted" | "not_running";

/**
 * Which work an interrupt marked (C8): the run's task, or — for a root holding only queued or placed
 * submissions and no run, a log a dead process left behind — those submissions. `""` before the
 * first interrupt. `fork: "initial"`: a fork's task ids are its own log's, so a parent's key would
 * match a fork's first run by number alone.
 */
export const InterruptDoc = defineDoc({
  kind: INTERRUPT_DOC_KIND,
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ marked: "" }),
});

/** The work `stopRun` marks: the run in flight, or the root's unsettled submissions without one. */
const workKey = (
  run: { readonly taskId: TaskId } | undefined,
  pending: readonly number[],
): string | undefined =>
  run !== undefined
    ? `task:${String(run.taskId)}`
    : pending.length > 0
      ? `submissions:${pending.join(",")}`
      : undefined;

/**
 * Stop the root's run, and say so in the transcript (C8).
 *
 * Work is a run in flight (`pi.live`'s `run`) or a root submission still queued or placed — the
 * latter is what a log a dead process left behind holds before anything continued it (LOB-25), and
 * aborting withdraws it. With neither, the abort is skipped: an interrupt of an idle session is an
 * answer, not a write.
 *
 * Otherwise the entry is committed first and the abort settles the run `unanswered` after it, as a
 * budget stop records itself before its abort (`./budget`): a client following the run stops
 * reading when the session goes idle, so an entry written after the abort would reach a watcher
 * that `factory run` had already let go of. So the marker is the turn's, not necessarily its last
 * entry: an interrupt that lands during a tool call or a streamed answer is followed by what Pi
 * Durable commits for the work it stopped — the call's aborted result, a committed partial.
 *
 * The commit decides from what it reads, not from the check before it: a run that settled on its
 * own in between is gone from `pi.live`, so nothing is written and the answer is `not_running`; and
 * work already marked (`InterruptDoc`) — two interrupts that overlap, or a retry after an abort
 * that failed — is not marked again, though it is aborted again.
 */
export const stopRun = (
  harness: Harness,
  root: Conversation,
): Effect.Effect<StopOutcome, SessionError> =>
  Effect.gen(function* () {
    const inspection = yield* attempt("inspect pending work", () =>
      harness.inspect(BACKGROUND_CONTEXT),
    );
    const pending = inspection.submissions
      .filter((record) => record.conversationId === root.id)
      .map((record) => Number(record.id));
    const marked = yield* attempt("write interrupted", () =>
      root.commit(
        (tx) =>
          Promise.all([
            tx.doc(LiveDoc, root.id),
            tx.doc(InterruptDoc, root.id),
          ]).then(([live, doc]) => {
            const key = workKey(live.run, pending);
            if (key === undefined) return false;
            if (doc.marked === key) return true;
            doc.marked = key;
            return tx
              .appendEntry(InterruptedEntry, root.id, {
                data: { text: INTERRUPTED_TEXT },
              })
              .then(() => true);
          }),
        BACKGROUND_CONTEXT,
      ),
    );
    if (!marked) return "not_running";
    yield* interrupt(root);
    return "interrupted";
  });

/**
 * Whether a log's root has work an interrupt would stop, read without owning it (C8): a run in
 * `pi.live`, or a root submission still queued or placed. What `stopRun` would find, so a caller
 * that holds no owner can answer `not_running` without opening one.
 */
export const rootHasWork = (
  storage: Storage,
): Effect.Effect<boolean, SessionError> =>
  Effect.gen(function* () {
    const live = yield* readLogDocument(storage, LIVE_DOC);
    if (live !== undefined && live["run"] !== undefined) return true;
    for (const status of ["queued", "placed"] as const) {
      const page = yield* attempt("scan unsettled submissions", () =>
        storage.scanSubmissions(
          { conversationId: ROOT_CONVERSATION_ID, status },
          1,
          undefined,
          BACKGROUND_CONTEXT,
        ),
      );
      if (page.items.length > 0) return true;
    }
    return false;
  });

/** Submissions read per storage page while looking one up by its wire id. */
const SUBMISSION_PAGE = 100;

/**
 * The wire id as the number Pi Durable's ids are, or `undefined` for one no submission can have.
 *
 * The wire id is the opaque string `submitMessage` answered; the brand is applied only by the
 * package, so a record is matched by comparing numbers rather than by minting a branded id here.
 */
const submissionNumber = (submissionId: string): number | undefined =>
  /^[0-9]+$/.test(submissionId) ? Number(submissionId) : undefined;

/**
 * The submission of `conversationId` whose wire id is `submissionId`, or `undefined`.
 *
 * A full scan of the conversation's submissions in ascending id order, stopping at the first id
 * past the one asked for. It is the slow path: the withdraw of a message still queued finds it in
 * `Harness.inspect()` instead, and only a message that is over, or never existed, comes here.
 */
const findSubmission = (
  storage: Storage,
  conversationId: ConversationId,
  target: number,
): Effect.Effect<SubmissionRecord | undefined, SessionError> =>
  Effect.gen(function* () {
    let cursor: Cursor | undefined;
    for (;;) {
      const page: Page<SubmissionRecord, Cursor> = yield* attempt(
        "scan submissions",
        () =>
          storage.scanSubmissions(
            { conversationId },
            SUBMISSION_PAGE,
            cursor,
            BACKGROUND_CONTEXT,
          ),
      );
      for (const record of page.items) {
        if (record.id === target) return record;
        if (record.id > target) return undefined;
      }
      cursor = page.next;
      if (cursor === undefined) return undefined;
    }
  });

/**
 * Where a session's submission stands, read from committed storage alone (LOB-166): `open` while it
 * is queued or placed, `settled` once it is over, `undefined` for an id the session never admitted.
 *
 * What a withdraw asks before it opens an owner: a session nobody owns can still hold a durable
 * queue (an API restart, an idle sweep), but an unknown or finished id needs no owner to answer.
 */
export const submissionStanding = (
  storage: Storage,
  submissionId: string,
): Effect.Effect<"open" | "settled" | undefined, SessionError> =>
  Effect.gen(function* () {
    const target = submissionNumber(submissionId);
    if (target === undefined) return undefined;
    const record = yield* findSubmission(storage, ROOT_CONVERSATION_ID, target);
    if (record === undefined) return undefined;
    return record.status === "queued" || record.status === "placed"
      ? "open"
      : "settled";
  });

/**
 * The input submission that put `entry` in the transcript, read from committed storage alone
 * (LOB-199): how a replay comparison tells how a side's task settled. With `entry` absent it is the
 * root's first input submission — a prompt withdrawn before it was placed has no entry to name.
 *
 * `undefined` when no submission placed that entry, which is what a fork's copied prefix is: the
 * entries were appended by the copy, not submitted, so the caller reads the outcome off the
 * transcript instead. A passive write is never a prompt.
 */
export const readPromptSubmission = (
  storage: Storage,
  entry: string | undefined,
): Effect.Effect<SubmissionRecord | undefined, SessionError> =>
  Effect.gen(function* () {
    let cursor: Cursor | undefined;
    for (;;) {
      const page: Page<SubmissionRecord, Cursor> = yield* attempt(
        "scan submissions",
        () =>
          storage.scanSubmissions(
            { conversationId: ROOT_CONVERSATION_ID },
            SUBMISSION_PAGE,
            cursor,
            BACKGROUND_CONTEXT,
          ),
      );
      const prompt = page.items.find(
        (record) =>
          record.type === "input" &&
          (entry === undefined ||
            (record.entry !== undefined && String(record.entry) === entry)),
      );
      if (prompt !== undefined) return prompt;
      cursor = page.next;
      if (cursor === undefined) return undefined;
    }
  });

/**
 * Withdraw a queued message (LOB-166): Pi Durable settles the submission `unanswered` with reason
 * `aborted` and removes its inbox item in one commit, so the message never reaches the transcript
 * and every watcher sees the queue shrink.
 *
 * A message a run has already taken, or one that is over, is not an error — it is an answer the
 * caller branches on, because the request was well-formed and the log simply moved first. An id
 * this session never admitted is `not_found`.
 *
 * The message is looked up in `Harness.inspect()`, which holds exactly the queued and placed
 * submissions, so withdrawing on a long session does not read its history. Only an id missing there
 * is scanned for, to tell one that is over from one that never was.
 */
export const withdrawMessage = (
  open: Pick<OpenSession, "harness" | "root">,
  storage: Storage,
  submissionId: string,
): Effect.Effect<WithdrawOutcome, SessionError> =>
  Effect.gen(function* () {
    const notFound = new SessionErrorClass({
      code: "not_found",
      message: `submission ${submissionId} is not in this session`,
    });
    const target = submissionNumber(submissionId);
    if (target === undefined) return yield* notFound;
    const inspection = yield* attempt("inspect submissions", () =>
      open.harness.inspect(BACKGROUND_CONTEXT),
    );
    const record =
      inspection.submissions.find(
        (candidate) =>
          candidate.conversationId === open.root.id && candidate.id === target,
      ) ?? (yield* findSubmission(storage, open.root.id, target));
    if (record === undefined) return yield* notFound;
    // Pi Durable's own answer decides the outcome, so a message that settled between the read and
    // the abort is reported as settled rather than as withdrawn.
    const result = yield* attempt("withdraw message", () =>
      open.harness.abortSubmission(record.id, BACKGROUND_CONTEXT, open.root.id),
    );
    switch (result) {
      case "aborted":
        return "withdrawn";
      case "not_found":
        return yield* notFound;
      default:
        return result;
    }
  });

/**
 * Start a new model context (LOB-181). Pi Durable appends a `pi.reset` entry that heads the next
 * context, carrying `handoff` as its user message when given; the entries before it stay in the
 * log, so the transcript keeps the past and marks where the reset happened.
 */
export const resetSession = (
  conversation: Conversation,
  handoff: string | undefined,
): Effect.Effect<void, SessionError> =>
  attempt("reset session", () =>
    conversation.reset(handoff, BACKGROUND_CONTEXT),
  );

/**
 * Close a harness: settle what runs in it and release its lease. For a harness `openSession`
 * opened, use `closeSession`, which also ends the sandboxes its commands ran in; this alone leaves
 * them to the session's `releaseEnvironment`, which the caller then owes.
 */
export const closeHarness = (harness: Harness): Effect.Effect<void> =>
  Effect.promise(() => harness.close(BACKGROUND_CONTEXT));

/**
 * Close the session's harness, then end the sandboxes its commands ran in (LOB-244). The order is
 * the point: closing the harness settles what runs, so nothing is still using an environment when
 * its sandbox ends. The sandboxes end even when the close fails.
 */
export const closeSession = (session: OpenSession): Effect.Effect<void> =>
  closeHarness(session.harness).pipe(
    Effect.ensuring(session.releaseEnvironment),
  );

/**
 * Compact the session on demand (B4): Pi Durable admits a compaction task that summarizes an old
 * prefix of the model context and places the summary as the new head marker, so the transcript
 * keeps every entry and the model's next request starts from the summary.
 *
 * The task id is the wire form of Pi Durable's branded id, like a submission's. Nothing to compact
 * — a context shorter than the policy keeps verbatim — completes the task without a summary, which
 * is the package's rule (range selection finds no cut), not a failure here.
 */
export const compactSession = (
  conversation: Conversation,
  instructions: string | undefined,
): Effect.Effect<string, SessionError> =>
  attempt("compact session", () =>
    conversation.compact(instructions, BACKGROUND_CONTEXT),
  ).pipe(Effect.map(String));

/**
 * Whether a run is in flight. Read from the committed `pi.live` document, so it is what the log
 * says, not what this process remembers.
 */
export const isBusy = (
  harness: Harness,
  conversation: Conversation,
): Effect.Effect<boolean, SessionError> =>
  attempt("read live state", () =>
    harness
      .snapshot(LiveDoc, conversation.id, BACKGROUND_CONTEXT)
      .then((live) => live?.run !== undefined),
  );

const readDocument = (
  storage: Storage,
  kind: string,
  /** One family member by key; absent reads the singleton of that kind. */
  key?: string,
  /** The conversation whose document it is; the root's unless named. */
  conversationId: ConversationId = ROOT_CONVERSATION_ID,
): Effect.Effect<JsonRecord | undefined, SessionError> =>
  Effect.gen(function* () {
    const address = {
      kind,
      scope: { kind: "conversation", conversationId },
      ...(key === undefined ? {} : { key }),
    } as const;
    const record = yield* attempt(`find ${kind}`, () =>
      storage.findDocument(address, "current", BACKGROUND_CONTEXT),
    );
    if (record === undefined) return undefined;
    const stored = yield* attempt(`read ${kind}`, () =>
      storage.document(record.id, "current", BACKGROUND_CONTEXT),
    );
    return stored?.value;
  });

/** One document of a log read without owning it (`readDocument`), for the follower (LOB-18). */
export const readLogDocument = (
  storage: Storage,
  kind: string,
): Effect.Effect<JsonRecord | undefined, SessionError> =>
  readDocument(storage, kind);

/** Conversations per storage round trip while summing a log's spend. */
const CONVERSATION_PAGE = 100;

/**
 * A log's spend, read without owning it: every conversation's `pi.usage`, summed (`mergeUsage`).
 *
 * The root's ledger alone is not the session's spend once a mission fans out (LOB-193): each worker
 * talks in a conversation of its own, and its requests are charged there. This is `Harness.usage()`
 * for a reader-mode `Storage`, so a fold, a fork's carried spend and a rebuilt index count what the
 * budget cap counted while the session ran.
 */
export const readLogUsage = (
  storage: Storage,
): Effect.Effect<SessionUsage, SessionError> =>
  Effect.gen(function* () {
    const usages: SessionUsage[] = [];
    let cursor: Cursor | undefined;
    for (;;) {
      const page = yield* attempt("scan conversations", () =>
        storage.scanConversations(
          {},
          CONVERSATION_PAGE,
          cursor,
          BACKGROUND_CONTEXT,
        ),
      );
      for (const conversation of page.items)
        usages.push(
          projectUsageDoc(
            yield* readDocument(storage, USAGE_DOC, undefined, conversation.id),
          ),
        );
      cursor = page.next;
      if (cursor === undefined) break;
    }
    return mergeUsage(usages);
  });

/**
 * A live session's spend: `Harness.usage()`, every conversation's `pi.usage` summed — the root's
 * and those of a mission's workers (LOB-193) — projected the way a fold projects one ledger.
 */
export const readSessionUsage = (
  harness: Harness,
): Effect.Effect<SessionUsage, SessionError> =>
  Effect.map(
    attempt("read session usage", () => harness.usage(BACKGROUND_CONTEXT)),
    (state) => mergeUsage([projectUsageDoc(state)]),
  );

/** Entries per storage round trip while folding a log. */
const ENTRY_PAGE = 500;

/**
 * The transcript: every entry the conversation ever committed, oldest first.
 *
 * It is read from the start of the log rather than from the newest head marker, because a head
 * marker (`pi.reset`, `pi.compaction`) says where the *model's* context begins, not where the
 * transcript does. A reset keeps the past and marks where it happened (LOB-181), and a fold that
 * started at the head would also drop the `factory.title` entry a rebuild reads the title from.
 * Both read paths use this, so a fold and a live attach still describe the same session.
 */
const scanEntries = (
  scan: (
    cursor: Cursor | undefined,
  ) => Effect.Effect<Page<EntryRecord, Cursor>, SessionError>,
): Effect.Effect<readonly EntryRecord[], SessionError> =>
  Effect.gen(function* () {
    const records: EntryRecord[] = [];
    let cursor: Cursor | undefined;
    for (;;) {
      const page = yield* scan(cursor);
      records.push(...page.items);
      cursor = page.next;
      if (cursor === undefined) break;
    }
    // Storage scans newest first.
    return records.reverse();
  });

const readAllEntries = (
  storage: Storage,
): Effect.Effect<readonly EntryRecord[], SessionError> =>
  scanEntries((cursor) =>
    attempt("scan entries", () =>
      storage.scanEntries(
        { conversationId: ROOT_CONVERSATION_ID },
        ENTRY_PAGE,
        cursor,
        BACKGROUND_CONTEXT,
      ),
    ),
  );

/** The same transcript for a session this process owns, read through its conversation. */
const readConversationEntries = (
  conversation: Conversation,
): Effect.Effect<readonly EntryRecord[], SessionError> =>
  scanEntries((cursor) =>
    attempt("scan entries", () =>
      conversation.entries({}, ENTRY_PAGE, cursor, BACKGROUND_CONTEXT),
    ),
  );

/**
 * The *active window*: the newest head marker, then the entries from its head. That is what Pi
 * Durable folds into a request, so it is the right slice for a question about the model's current
 * context — the prompt sections a run has in effect — and the wrong one for the transcript, which
 * is `readAllEntries`, because a `pi.reset` would truncate it.
 */
const readActiveEntries = (
  storage: Storage,
): Effect.Effect<readonly EntryRecord[], SessionError> =>
  Effect.gen(function* () {
    const marker = yield* attempt("find head marker", () =>
      storage.findLatestHeadMarker(
        ROOT_CONVERSATION_ID,
        undefined,
        BACKGROUND_CONTEXT,
      ),
    );
    return yield* scanEntries((cursor) =>
      attempt("scan entries", () =>
        storage.scanEntries(
          marker === undefined
            ? { conversationId: ROOT_CONVERSATION_ID }
            : {
                conversationId: ROOT_CONVERSATION_ID,
                minEntryId: marker.head,
              },
          ENTRY_PAGE,
          cursor,
          BACKGROUND_CONTEXT,
        ),
      ),
    );
  });

/**
 * The entries a fork of this log keeps: its whole transcript, oldest first, through `at`.
 *
 * The transcript is read from the beginning rather than from the newest head marker, because the
 * copy that follows reassigns entry ids and every head marker names an id: reading from the start
 * keeps every marker inside the copy, so a fork of a session that was reset keeps the same active
 * context it had. `at` absent means "the last entry", which is the fork `verify-api` drives; an id
 * that is not an entry of this log is refused as `invalid_input`, not silently rounded to the end.
 */
export const readForkSource = (
  storage: Storage,
  at: string | undefined,
): Effect.Effect<readonly EntryRecord[], SessionError> =>
  Effect.gen(function* () {
    const records: EntryRecord[] = [];
    let cursor: Cursor | undefined;
    for (;;) {
      const page = yield* attempt("scan entries", () =>
        storage.scanEntries(
          { conversationId: ROOT_CONVERSATION_ID },
          ENTRY_PAGE,
          cursor,
          BACKGROUND_CONTEXT,
        ),
      );
      records.push(...page.items);
      cursor = page.next;
      if (cursor === undefined) break;
    }
    // Storage scans newest first; a transcript reads oldest first.
    records.reverse();
    if (at === undefined) return records;
    const end = records.findIndex((entry) => String(entry.id) === at);
    if (end === -1) {
      return yield* new SessionErrorClass({
        code: "invalid_input",
        message: `entry ${at} is not in this session`,
      });
    }
    return records.slice(0, end + 1);
  });

/**
 * The kind a copied entry is written under: its own, except a parent's PR announcement, which a
 * fork keeps as an inherited line (LOB-211). The fork's `factory.pr` is not copied, so an announcement
 * copied verbatim would tell an attached client about a PR the fork's own summary does not report —
 * and a second one once the fork opens its own.
 */
const forkedKind = (kind: string): string =>
  kind === PR_OPENED_ENTRY_KIND ? PR_INHERITED_ENTRY_KIND : kind;

/** The draft for one copied entry, its head marker rewritten to the copy of the entry it names. */
const draftOf = (
  entry: EntryRecord,
  copied: ReadonlyMap<EntryId, EntryId>,
): EntryDraft => {
  // `"self"` is how the draft API says "the entry being written", which is what a reset's head
  // marker is in the parent.
  const head =
    entry.head === undefined
      ? undefined
      : entry.head === entry.id
        ? ("self" as const)
        : copied.get(entry.head);
  if (entry.head !== undefined && head === undefined) {
    throw new Error(
      `entry ${entry.id} starts its context at ${entry.head}, which is not an earlier entry`,
    );
  }
  return {
    kind: forkedKind(entry.kind),
    ...(entry.model === undefined ? {} : { model: entry.model }),
    ...(entry.data === undefined ? {} : { data: entry.data }),
    ...(entry.edits === undefined ? {} : { edits: entry.edits }),
    ...(head === undefined ? {} : { head }),
  };
};

/** Where a fork came from, and the repo binding its parent had, in the fork's own commit. */
type ForkPreamble = {
  readonly parent: string;
  readonly binding?: RepoBinding;
  /** The cap the fork inherits (LOB-163), in the same commit, so no run starts under it uncapped. */
  readonly budget?: BudgetSeed;
  /** The parent's actor (LOB-162), in the same commit, so a rebuilt fork keeps its attribution. */
  readonly actor?: string;
};

/**
 * Copy a parent's entries into a fork's own log, oldest first, in the callers' one commit.
 *
 * Entry ids are minted per log, so every copy gets a new id and every head marker has to be
 * rewritten to the copy of the entry it named. Walking oldest first is what makes that possible:
 * a marker's entry has already been copied by the time the marker is written, and a marker that
 * names something later is a parent log whose entries do not precede their marker — a broken log
 * rather than a fork to guess at, so it fails the commit instead of writing a wrong transcript.
 *
 * The lineage, the repo binding, the cap and the actor are documents in the same commit, so a fork
 * that exists at all exists with all of them: there is no window in which a fork is readable but `rebuildIndexes` would fold
 * it without its parent. Documents are not entries, so the fork's transcript stays exactly the
 * parent's prefix — entry for entry, with the parent's PR announcement kept as an inherited line
 * (`forkedKind`), because the parent's `factory.pr` is the one document a fork does not take.
 */
const copyEntries = (
  tx: Tx,
  conversationId: ConversationId,
  source: readonly EntryRecord[],
  preamble: ForkPreamble,
): Promise<ForkLineage> => {
  const copied = new Map<EntryId, EntryId>();
  let at = "";
  // The fork's approval ledger takes the copies of the parent's approval entries, as every other
  // approval entry's commit does (LOB-243), so a historical read of the fork reports what its
  // transcript would.
  return approvalLedger(tx, conversationId)
    .then((ledger) =>
      source.reduce<Promise<void>>(
        (previous, entry) =>
          previous.then(() =>
            tx
              .appendEntry(conversationId, draftOf(entry, copied))
              .then((record) => {
                copied.set(entry.id, record.id);
                at = String(record.id);
                ledger.through = Math.max(ledger.through, Number(record.id));
                if (APPROVAL_ENTRY_KINDS.has(record.kind))
                  ledger.entries.push({
                    kind: record.kind,
                    data: record.data ?? null,
                  });
              }),
          ),
        Promise.resolve(),
      ),
    )
    .then(() =>
      tx.doc(ForkDoc, conversationId).then((doc) => {
        doc.parent = preamble.parent;
        doc.at = at;
        return doc;
      }),
    )
    .then(() =>
      preamble.binding === undefined
        ? undefined
        : tx.doc(SessionDoc, conversationId).then((doc) => {
            doc.repo = preamble.binding?.repo ?? "";
            doc.baseRef = preamble.binding?.baseRef ?? "";
          }),
    )
    .then(() =>
      preamble.budget === undefined
        ? undefined
        : setBudget(tx, conversationId, preamble.budget),
    )
    .then(() =>
      preamble.actor === undefined
        ? undefined
        : tx.doc(ActorDoc, conversationId).then((doc) => {
            doc.actor = preamble.actor ?? "";
          }),
    )
    .then(() => ({ parent: preamble.parent, at }));
};

/** What a fork needs: the log to copy from, the log to write, and where to run. */
export type ForkSessionOptions = {
  /** The parent's log, opened in reader mode: a fork never takes ownership of the parent. */
  readonly parent: Storage;
  /** The fork's own log, opened in owner mode. */
  readonly child: Storage;
  /** The entry to fork at, or absent for the parent's last entry. */
  readonly at?: string;
  /** The session the fork is taken from, committed into the fork's log as its lineage. */
  readonly lineage: string;
  /** The parent's repo binding, committed into the fork's log beside the lineage. */
  readonly binding?: RepoBinding;
  /**
   * Who the fork's spend is attributed to (LOB-162): the parent's actor, committed beside the
   * lineage so a fork never exists with an indexed actor its log does not record.
   */
  readonly actor?: string;
  readonly model: ModelAccess;
  readonly cwd: string;
  /** The runtime the fork's commands run through (LOB-244), as `OpenSessionOptions.sandbox`. */
  readonly sandbox?: BindableSandboxRuntimeShape;
  readonly policy?: SessionPolicy;
  /** How the fork's gated calls ask a person (D15, LOB-52); see `OpenSessionOptions.approvalAsker`. */
  readonly approvalAsker?: ApprovalAsker;
  /**
   * What the run's column gives the fork's prompt (B6). A fork carries no task binding, so this is
   * `EMPTY_RUN_PROFILE` in practice; it is a parameter so a fork opens exactly as any other session
   * does, rather than through a second, special-cased open path.
   */
  readonly run?: RunProfile;
  /**
   * The cited pages the session's prompt carries (LOB-205), read by the control plane at open.
   *
   * Absent: no pages, so no `pages` section. The module that assembles them (`./pages`) owns the
   * budget and the drop order; this option is the pages themselves, because only the control plane
   * can read them (they live in the session's log and its derived rows, not in a document family a
   * prompt section could enumerate).
   */
  readonly pages?: readonly CitedPage[];
  /** What the fork's repository tells it, as `OpenSessionOptions.repo`. */
  readonly repo?: RepoContext;
  /** What the fork's `verify` tool runs (LOB-78), as `OpenSessionOptions.verify`. */
  readonly verify?: VerifyOptions;
  /**
   * The cap a fork of an uncapped parent gets (LOB-163): the server's default, as a create gets it.
   * A capped parent's fork keeps the parent's cap and carries its spend (`inheritBudget`), so a fork
   * is never a way around a cap — a fork of a session the cap stopped is stopped too.
   */
  readonly defaultBudget?: number;
};

export type ForkedSession = OpenSession & {
  /** The entry the fork was taken at, `""` when the parent had no entries. */
  readonly at: string;
};

/**
 * Open a new session whose transcript is another session's prefix (LOB-180, D7).
 *
 * A session *is* a log (D7), so a fork is another log with the parent's entries copied in: Pi
 * Durable's own `Conversation.fork` forks a conversation *inside* one storage, which would make
 * the fork unreadable as a session of its own. The copy is one commit on the new log, so a fork
 * either has the whole prefix or does not exist.
 */
export const forkSession = (
  options: ForkSessionOptions,
): Effect.Effect<ForkedSession, SessionError> =>
  Effect.gen(function* () {
    const source = yield* readForkSource(options.parent, options.at);
    const budget = inheritBudget(
      yield* readBudgetSource(options.parent),
      options.defaultBudget,
      true,
    );
    const opened = yield* openSession({
      storage: options.child,
      model: options.model,
      cwd: options.cwd,
      ...(options.sandbox === undefined ? {} : { sandbox: options.sandbox }),
      ...(options.policy === undefined ? {} : { policy: options.policy }),
      ...(options.approvalAsker === undefined
        ? {}
        : { approvalAsker: options.approvalAsker }),
      ...(options.run === undefined ? {} : { run: options.run }),
      ...(options.pages === undefined ? {} : { pages: options.pages }),
      ...(options.repo === undefined ? {} : { repo: options.repo }),
      ...(options.verify === undefined ? {} : { verify: options.verify }),
    });
    const lineage = yield* attempt(
      "copy the parent's entries",
      () =>
        opened.root.commit(
          (tx) =>
            copyEntries(tx, opened.root.id, source, {
              parent: options.lineage,
              ...(options.binding === undefined
                ? {}
                : { binding: options.binding }),
              ...(budget === undefined ? {} : { budget }),
              ...(options.actor === undefined ? {} : { actor: options.actor }),
            }),
          BACKGROUND_CONTEXT,
        ),
      // A copy that fails leaves no fork, and an open harness on a child log nobody can read is a
      // lease the caller never releases: close it here, where the failure is.
    ).pipe(Effect.tapError(() => closeSession(opened).pipe(Effect.ignore)));
    return { ...opened, at: lineage.at };
  });

export type SessionLog = {
  readonly entries: readonly TranscriptEntry[];
  readonly usage: SessionUsage;
  /** The repo binding the log records, empty when the session is a scratch one. */
  readonly binding: RepoBinding;
  /** The PR the log records, when the session opened one. */
  readonly pr?: PullRequestRecord;
  /** The merge of that PR and its revert (LOB-44), when the webhook reported either. */
  readonly merge?: MergeRecord;
  /** The task binding the log records, when the session runs against a task. */
  readonly task?: { readonly taskId: string; readonly column: string };
  /**
   * The spec committed to the log (LOB-72), when the session specified one. Read through the same
   * validator `writeSpec` applies, so a value the stage would refuse never folds back as a spec.
   */
  readonly spec?: Spec;
  /**
   * The legacy `factory.criteria` string, when a log holds one. Nothing writes it; `spec.acceptance`
   * is the source of truth for acceptance criteria (see `CriteriaDoc`).
   */
  readonly criteria?: string;
  /** The session this log was forked from, when it was forked (LOB-180). */
  readonly forkedFrom?: string;
  /**
   * The last entry the fork copied from its parent, when it was forked from a parent that had any
   * (LOB-180): every entry up to it is the parent's run, appended by the copy, and every one after it
   * is this log's own — which is how a replay comparison tells the two apart (LOB-199).
   */
  readonly forkedAt?: string;
  /** Who the session's spend is attributed to (LOB-162), when anyone was. */
  readonly actor?: string;
  /**
   * The model the root conversation is pinned to, `provider/modelId` (LOB-269), from its committed
   * `pi.agent`: what the index's `model` column is refolded from. Absent for a log with no root.
   */
  readonly model?: string;
  /**
   * Every approval the log records, requested order (LOB-147). Pending ones are what a snapshot
   * reports; the settled ones are here because the index rows a rebuild derives cover both.
   */
  readonly approvals: readonly ApprovalLogRecord[];
  /**
   * The cited knowledge pages the log holds, by name (LOB-204), folded from the `factory.page`
   * entries. Read from the raw entries rather than from the transcript projection, because a page
   * is not a transcript entry a client renders.
   */
  readonly pages: readonly PageLogRecord[];
  /**
   * The replay this log is, when it is one (LOB-198): the session it replays and the model it ran on,
   * with the model its source recorded. The link is committed to this log alone, which is why a
   * source never reads as a replay; all its `factory.replay` ever gains is `replayComparisons`.
   */
  readonly replay?: {
    readonly source: string;
    readonly model: string;
    readonly from: string;
  };
  /**
   * The replay comparisons the log holds (LOB-199), oldest first: on a replay, the one naming its
   * source; on a source, one per replay of it. Empty for a session that was never compared.
   */
  readonly replayComparisons: readonly ReplayComparison[];
};

/** Read a string field from a document defensively: an unknown shape yields "". */
const bindingString = (value: JsonValue | undefined, key: string): string =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (() => {
        const field = (value as JsonRecord)[key];
        return typeof field === "string" ? field : "";
      })()
    : "";

/**
 * A log's cap and spend, as a fork or a replay of it inherits them (LOB-163): read through the same
 * projection a snapshot uses, so the spend a fork carries is the spend its parent reported.
 */
export const readBudgetSource = (
  storage: Storage,
): Effect.Effect<BudgetSource, SessionError> =>
  Effect.gen(function* () {
    // Every conversation's spend, a mission's workers' included (LOB-193): what the cap counted.
    const usage = yield* readLogUsage(storage);
    const budget = projectBudgetDoc(
      yield* readDocument(storage, BUDGET_DOC_KIND),
      usage,
    );
    return budget === undefined
      ? { spent: usageCostTotal(usage) }
      : { cap: budget.cap, spent: budget.spent };
  });

/**
 * The PR a log nobody owns records (LOB-177), read from its `factory.pr` document alone, without
 * folding the rest of the log — what a board's `pr_link` requirement checks (LOB-240). `undefined`
 * when the session opened none: the document's seed has no URL, and a fork never copies its
 * parent's (LOB-211).
 */
export const readRecordedPullRequest = (
  storage: Storage,
): Effect.Effect<PullRequestRecord | undefined, SessionError> =>
  Effect.map(readDocument(storage, PR_DOC_KIND), (value) => {
    const doc = projectPrDoc(value);
    if (doc.url === "") return undefined;
    return {
      url: doc.url,
      number: doc.number,
      base: doc.base,
      head: doc.head,
      openedAt: doc.openedAt,
      ...(doc.evidence === undefined ? {} : { evidence: doc.evidence }),
    };
  });

/**
 * A log's `factory.replay` document alone (LOB-199), without folding the rest of the log: the link
 * when the log is a replay, and every comparison it holds. What the control plane reads to decide
 * whether a replay still owes a comparison, on every owner it opens and every fold it serves — so it
 * is one document read, not a fold.
 */
export const readReplayDocument = (
  storage: Storage,
): Effect.Effect<
  {
    readonly link?: {
      readonly source: string;
      readonly model: string;
      readonly from: string;
    };
    readonly comparisons: readonly ReplayComparison[];
  },
  SessionError
> =>
  Effect.map(readDocument(storage, REPLAY_DOC_KIND), (value) => {
    const doc = projectReplayDoc(value);
    return {
      comparisons: projectReplayComparisons(value),
      ...(doc.source === ""
        ? {}
        : { link: { source: doc.source, model: doc.model, from: doc.from } }),
    };
  });

/**
 * Read a session nobody owns by folding its log through a reader-mode `Storage`. No `Harness` is
 * opened: Pi Durable allows exactly one owner, and this is the read-only path D7 asks for — the
 * control plane must be able to read a session without owning it.
 */
export const readSessionLog = (
  storage: Storage,
): Effect.Effect<SessionLog, SessionError> =>
  Effect.gen(function* () {
    const records = yield* readAllEntries(storage);
    const pages = projectPages(records);
    const usage = yield* readLogUsage(storage);
    const binding = yield* readDocument(storage, SESSION_DOC_KIND);
    const taskDoc = yield* readDocument(storage, TASK_DOC_KIND);
    const specDoc = yield* readDocument(storage, SPEC_DOC_KIND);
    const criteriaDoc = yield* readDocument(storage, CRITERIA_DOC_KIND);
    const pr = yield* readRecordedPullRequest(storage);
    const merge = yield* readRecordedMerge(storage);
    const forkDoc = yield* readDocument(storage, FORK_DOC_KIND);
    const actor = bindingString(
      yield* readDocument(storage, ACTOR_DOC_KIND),
      "actor",
    );
    const replayValue = yield* readDocument(storage, REPLAY_DOC_KIND);
    const replayDoc = projectReplayDoc(replayValue);
    const taskId = bindingString(taskDoc, "taskId");
    const spec = projectSpec(specDoc);
    const criteria = bindingString(criteriaDoc, "criteria");
    const forkedFrom = bindingString(forkDoc, "parent");
    const forkedAt = bindingString(forkDoc, "at");
    const model = yield* readPinnedModelKey(storage);
    return {
      entries: records.map(projectEntry),
      pages,
      usage,
      approvals: projectApprovals(records),
      replayComparisons: projectReplayComparisons(replayValue),
      binding: {
        repo: bindingString(binding, "repo"),
        baseRef: bindingString(binding, "baseRef"),
        ...(bindingString(binding, "branch") === ""
          ? {}
          : { branch: bindingString(binding, "branch") }),
      },
      ...(pr === undefined ? {} : { pr }),
      ...(merge === undefined ? {} : { merge }),
      ...(spec === undefined ? {} : { spec }),
      ...(criteria === "" ? {} : { criteria }),
      ...(forkedFrom === "" ? {} : { forkedFrom }),
      ...(forkedFrom === "" || forkedAt === "" ? {} : { forkedAt }),
      ...(actor === "" ? {} : { actor }),
      ...(model === undefined ? {} : { model }),
      ...(replayDoc.source === ""
        ? {}
        : {
            replay: {
              source: replayDoc.source,
              model: replayDoc.model,
              from: replayDoc.from,
            },
          }),
      ...(taskId === ""
        ? {}
        : {
            task: {
              taskId,
              column: bindingString(taskDoc, "column") || "building",
            },
          }),
    };
  });

/** The Pi Durable entry kind that carries system prompt sections. */
const PROMPT_ENTRY_KIND = "pi.system";

export type PromptSections = Readonly<Record<string, string>>;

/**
 * The prompt sections a session's log leaves in effect, folded the way Pi Durable folds them: a
 * later `pi.system` entry replaces a section by name, and a `null` removes it.
 *
 * This is what the run was actually told, read from the log rather than from the extension that
 * built it, so a caller can show or measure the injected text (B6's "its size measurable") and a
 * test can assert on the prompt without intercepting a model request.
 */
export const readPromptSections = (
  storage: Storage,
): Effect.Effect<PromptSections, SessionError> =>
  Effect.gen(function* () {
    const records = yield* readActiveEntries(storage);
    const shown: Record<string, string> = {};
    for (const record of records) {
      if (record.kind !== PROMPT_ENTRY_KIND) continue;
      for (const message of record.model ?? []) {
        if (message.role !== "system") continue;
        for (const [key, value] of Object.entries(message.sections ?? {})) {
          if (value === null) delete shown[key];
          else shown[key] = value;
        }
      }
    }
    return shown;
  });

/**
 * The tools a session's requests offer the model now, by name, folded from the log's system
 * messages the way pi-ai folds them (`toolsAdded`, then `toolsRemoved`, in order).
 *
 * What the run was actually offered, read from the log rather than from the registry or the role
 * that chose it (LOB-207): a role whose tool filter stopped reaching `openSession` shows up here as
 * a write tool the run was offered, whatever the resolution says it should have been.
 */
export const readOfferedTools = (
  storage: Storage,
): Effect.Effect<readonly string[], SessionError> =>
  Effect.gen(function* () {
    const records = yield* readActiveEntries(storage);
    const system = records.flatMap((record) =>
      record.kind === PROMPT_ENTRY_KIND
        ? (record.model ?? []).filter((message) => message.role === "system")
        : [],
    );
    return getCurrentTools(system).map((tool) => tool.name);
  });

export type { Conversation, ConversationView, Harness, Storage };

/**
 * A session this process owns: the conversation its transcript lives in, and the harness whose
 * task graph says what is running there (LOB-183).
 *
 * Both are needed to answer "what is this session doing": entries and documents come from the
 * conversation view, and tasks are session-wide, so only the harness sees them.
 */
export type LiveSession = {
  readonly harness: Harness;
  readonly root: Conversation;
};

/** What the control plane knows about a session outside its log. */
export type SessionRef = {
  readonly id: SessionId;
  readonly title: string;
  readonly createdAt: Timestamp;
  /** Where the session works, already resolved by the control plane (`@repo/domain/Session`). */
  readonly workspace: SessionWorkspace;
  /** The PR the index remembers, so a read needs no fold to report it (LOB-177). */
  readonly prUrl?: string;
  /** The session this one was forked from, when the index row says so (LOB-180). */
  readonly forkedFrom?: SessionId;
  /**
   * The model the session is pinned to, `provider/modelId` (LOB-269): the owner's, or the index
   * row's. Absent, a fold reads it from the log's `pi.agent` instead.
   */
  readonly model?: string;
};

const pendingOf = (
  sessionId: SessionId,
  records: readonly ApprovalLogRecord[],
): readonly ApprovalRequest[] =>
  pendingApprovals(records).map((record) => ({
    sessionId,
    requestId: record.requestId,
    action: record.action,
    detail: record.detail,
    requestedAt: record.requestedAt,
  }));

const snapshotOf = (
  view: ConversationView,
  tasks: readonly SessionTask[],
  ref: SessionRef,
  entries: readonly EntryRecord[],
  mission: MissionSnapshot | undefined,
  budgetDoc: JsonValue | undefined,
  /** The session's spend: every conversation's (`readSessionUsage`), not the view's root alone. */
  usage: SessionUsage,
  replayDoc: JsonValue | undefined,
  proposedIssues: ProposedIssues | undefined,
  planRevisions: readonly PlanRevision[] | undefined,
): SessionSnapshot => {
  const projection = projectView(view, entries);
  const budget = projectBudgetDoc(budgetDoc, usage);
  const replayComparisons = projectReplayComparisons(replayDoc);
  return {
    session: {
      id: ref.id,
      title: ref.title,
      createdAt: ref.createdAt,
      mode: "live",
      status: projection.status,
      ...(ref.workspace.repo === undefined ? {} : { repo: ref.workspace.repo }),
      ...(ref.workspace.baseRef === undefined
        ? {}
        : { baseRef: ref.workspace.baseRef }),
      ...(ref.prUrl === undefined ? {} : { prUrl: ref.prUrl }),
      ...(ref.forkedFrom === undefined ? {} : { forkedFrom: ref.forkedFrom }),
      ...(ref.model === undefined ? {} : { model: ref.model }),
    },
    workspace: ref.workspace,
    entries: projection.entries,
    live: projection.live,
    usage,
    queued: projection.queued,
    tasks,
    // Folded from the whole log, not from the view: an approval is not a turn, and the view holds
    // the active window only — a request older than a compaction still has to be answered.
    approvals: pendingOf(ref.id, projectApprovals(entries)),
    // Absent rather than an empty phase when the session never started a mission, and present with
    // the phase it reached even after the mission settled: the record outlives the task (LOB-230).
    ...(mission === undefined ? {} : { mission }),
    // Absent for a session with no cap (LOB-163); a stop the cap made is `budget.stopped`.
    ...(budget === undefined ? {} : { budget }),
    // Absent for a session no replay was ever compared with (LOB-199).
    ...(replayComparisons.length === 0 ? {} : { replayComparisons }),
    // Absent for a session that never decomposed its spec (LOB-201).
    ...(proposedIssues === undefined ? {} : { proposedIssues }),
    // Absent for a session no plan-freshness pass ever ran against (LOB-45).
    ...(planRevisions === undefined ? {} : { planRevisions }),
  };
};

/**
 * The proposed issues of a session this process owns (LOB-201), read through the validator the
 * writer applied (`projectProposedIssues`), so the seed and any value a writer that bypassed it
 * could have left read as none. The fold reads the same document from the log the same way.
 */
export const readProposedIssues = (
  harness: Harness,
  conversation: Conversation,
): Effect.Effect<ProposedIssues | undefined, SessionError> =>
  attempt("read proposed issues", () =>
    harness.snapshot(ProposedIssuesDoc, conversation.id, BACKGROUND_CONTEXT),
  ).pipe(Effect.map(projectProposedIssues));

/**
 * The plan-freshness revisions of a session this process owns (LOB-45), read through the same
 * projection the fold uses (`projectPlanRevisions`), so the seed reads as none.
 */
export const readPlanRevisions = (
  harness: Harness,
  conversation: Conversation,
): Effect.Effect<readonly PlanRevision[] | undefined, SessionError> =>
  attempt("read plan revisions", () =>
    harness.snapshot(PlanRevisionsDoc, conversation.id, BACKGROUND_CONTEXT),
  ).pipe(Effect.map(projectPlanRevisions));

/**
 * The budget document of a session this process owns (LOB-163), as JSON for `projectBudgetDoc` —
 * the same reader the fold uses, so the two paths cannot disagree about a cap or a stop.
 */
const readBudgetDoc = (
  harness: Harness,
  conversation: Conversation,
): Effect.Effect<JsonValue | undefined, SessionError> =>
  attempt("read budget", () =>
    harness.snapshot(BudgetDoc, conversation.id, BACKGROUND_CONTEXT),
  );

/**
 * The replay document of a session this process owns (LOB-199), as JSON for
 * `projectReplayComparisons` — the reader the fold uses too, so a live and a folded snapshot report
 * the same comparisons.
 */
const readReplayDoc = (
  harness: Harness,
  conversation: Conversation,
): Effect.Effect<JsonValue | undefined, SessionError> =>
  attempt("read replay", () =>
    harness.snapshot(ReplayDoc, conversation.id, BACKGROUND_CONTEXT),
  );

const snapshotEvent = (snapshot: SessionSnapshot): SessionEvent => ({
  _tag: "snapshot",
  ...snapshot,
});

/**
 * The live checkpoint of a mission whose document an older definition wrote, for `readMissionDoc`
 * (`@repo/domain/Mission`) to read that document by (LOB-233). `undefined` when the document is
 * current — it already names the checkpoint's phase, so the task is not read at all — or when the
 * task has settled (a terminal record holds no checkpoint) or is gone. Lives here rather than in
 * `mission.ts` because the session snapshot reads it too, and `mission.ts` imports this module.
 */
export const missionCheckpoint = (
  harness: Harness,
  taskId: TaskId,
  definitionVersion: unknown,
): Effect.Effect<unknown, SessionError> =>
  typeof definitionVersion === "number" && definitionVersion < MISSION_VERSION
    ? attempt("read mission task", () =>
        harness.getTask(taskId, BACKGROUND_CONTEXT),
      ).pipe(Effect.map((task) => task?.state.checkpoint))
    : Effect.void;

/** A conversation id as the roster stores it; `undefined` for an empty one (the worker has none yet) or a stray one. */
const conversationIdOf = (stored: string): ConversationId | undefined =>
  /^[0-9]+$/.test(stored) ? (Number(stored) as ConversationId) : undefined;

/**
 * Each worker of a mission with what it spent (LOB-194): the mission document's roster, each entry
 * priced from the `pi.usage` of the conversation it names. `readLedger` reads one conversation's
 * ledger from whichever source the caller has — a live harness or a reader-mode storage — so a
 * live read and a fold attribute through one function.
 *
 * A worker with no conversation yet, or one whose ledger holds nothing, is listed with zero
 * counters, never left out.
 */
const workerSpends = (
  roster: readonly MissionWorkerEntry[],
  readLedger: (
    conversationId: ConversationId,
  ) => Effect.Effect<SessionUsage, SessionError>,
): Effect.Effect<readonly MissionWorkerSpend[], SessionError> =>
  Effect.forEach(roster, (entry) =>
    Effect.gen(function* () {
      const conversationId = conversationIdOf(entry.conversationId);
      const usage =
        conversationId === undefined
          ? totalSpend({ models: [], tools: [] })
          : totalSpend(yield* readLedger(conversationId));
      return {
        id: entry.id,
        taskId: entry.taskId,
        ...(conversationId === undefined
          ? {}
          : { conversationId: entry.conversationId }),
        usage,
      };
    }),
  );

/**
 * The mission a session is running, read off the two documents a start commits (LOB-230): the
 * binding names the mission's task id, and the mission's own document names the phase it reached.
 *
 * `undefined` is "no mission": either the session never started one, or the mission's document still
 * holds its seed because no phase has committed yet. The snapshot reports that as an absent field
 * rather than as an empty phase — the two are different facts, and a client handed an empty phase
 * would have to guess which one it got.
 */
const readMissionSnapshot = (
  harness: Harness,
  conversation: Conversation,
): Effect.Effect<MissionSnapshot | undefined, SessionError> =>
  Effect.gen(function* () {
    const binding = yield* attempt("read mission binding", () =>
      harness.snapshot(MissionBindingDoc, conversation.id, BACKGROUND_CONTEXT),
    );
    const taskId = binding?.taskId ?? "";
    if (taskId === "") return undefined;
    const doc = yield* attempt("read mission", () =>
      harness.snapshot(MissionDoc, conversation.id, taskId, BACKGROUND_CONTEXT),
    );
    if (doc === undefined) return undefined;
    // The live task's checkpoint is what tells an older definition's document apart where the
    // document alone cannot (`readMissionDoc`); the folded read below has no live task to ask.
    const checkpoint = /^[0-9]+$/.test(taskId)
      ? yield* missionCheckpoint(
          harness,
          Number(taskId) as TaskId,
          doc.definitionVersion,
        )
      : undefined;
    // Each worker's own ledger, from the harness this process owns (LOB-194).
    const workers = yield* workerSpends(readMissionWorkers(doc), (id) =>
      attempt("read worker usage", () =>
        harness.snapshot(UsageDoc, id, BACKGROUND_CONTEXT),
      ).pipe(Effect.map((state) => projectUsageDoc(state))),
    );
    return missionSnapshot(taskId, doc, checkpoint, workers);
  });

/** `readMissionSnapshot` for a session nobody owns: the same two documents, folded from its log. */
const readFoldedMission = (
  storage: Storage,
): Effect.Effect<MissionSnapshot | undefined, SessionError> =>
  Effect.gen(function* () {
    const binding = yield* readDocument(storage, MISSION_BINDING_DOC_KIND);
    const taskId = bindingString(binding, "taskId");
    if (taskId === "") return undefined;
    const doc = yield* readDocument(storage, MISSION_DOC_KIND, taskId);
    if (doc === undefined) return undefined;
    // The same roster, priced from the log's own ledgers: a released session reports the spend a
    // live one did (LOB-194).
    const workers = yield* workerSpends(readMissionWorkers(doc), (id) =>
      readDocument(storage, USAGE_DOC, undefined, id).pipe(
        Effect.map(projectUsageDoc),
      ),
    );
    return missionSnapshot(taskId, doc, undefined, workers);
  });

/** A live session's current state, read without subscribing to anything. */
export const readLiveSnapshot = (
  session: LiveSession,
  ref: SessionRef,
): Effect.Effect<SessionSnapshot, SessionError> =>
  Effect.gen(function* () {
    const state = yield* attempt("read conversation view", () =>
      session.root.viewState(BACKGROUND_CONTEXT),
    );
    // The view holds the active window only; the transcript is the whole log. The scan is fallible,
    // so the handle is released whether it answers or not — a leaked mount keeps this session's
    // projections alive in the process for as long as the API runs. The task graph is a third mount
    // and is released the same way: it is session-wide, so only the harness can answer "what is
    // running here".
    return yield* Effect.gen(function* () {
      const graph = yield* attempt("read task graph", () =>
        session.harness.taskGraph(BACKGROUND_CONTEXT),
      );
      const tasks = yield* Effect.ensuring(
        Effect.succeed(projectTasks(graph.value)),
        Effect.sync(() => graph.dispose()),
      );
      const entries = yield* readConversationEntries(session.root);
      const mission = yield* readMissionSnapshot(session.harness, session.root);
      const budget = yield* readBudgetDoc(session.harness, session.root);
      const usage = yield* readSessionUsage(session.harness);
      const replay = yield* readReplayDoc(session.harness, session.root);
      const proposed = yield* readProposedIssues(session.harness, session.root);
      const plans = yield* readPlanRevisions(session.harness, session.root);
      return snapshotOf(
        state.value,
        tasks,
        ref,
        entries,
        mission,
        budget,
        usage,
        replay,
        proposed,
        plans,
      );
    }).pipe(Effect.ensuring(Effect.sync(() => state.dispose())));
  });

/**
 * A live session's events: a snapshot of the committed view and the live-task list, then one event
 * per change for as long as the stream runs.
 *
 * Views are diffed rather than op streams are forwarded, so a subscriber that falls behind still
 * receives a correct picture: entries are appended, and a document compared by reference tells us
 * it changed. The task graph is diffed the same way, through its projection: a task that appears,
 * changes phase or settles publishes a graph revision, and a revision that projects the same list
 * is dropped so the panel is not woken for nothing.
 */
export const liveSessionEvents = (
  session: LiveSession,
  ref: SessionRef,
): Stream.Stream<SessionEvent, SessionError> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const state = yield* attempt("read conversation view", () =>
        session.root.viewState(BACKGROUND_CONTEXT),
      );
      const graph = yield* attempt("read task graph", () =>
        session.harness.taskGraph(BACKGROUND_CONTEXT),
      );
      const queue = yield* Queue.unbounded<SessionEvent>();
      let previous = state.value;
      let previousTasks = projectTasks(graph.value);
      let unsubscribe: (() => void) | undefined;
      let unsubscribeTasks: (() => void) | undefined;

      // Registered before the fallible scan below, so a failed read releases the mount instead of
      // leaving this session's projections running in the process.
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          unsubscribe?.();
          unsubscribeTasks?.();
          state.dispose();
          graph.dispose();
        }),
      );

      // The transcript the snapshot below carries is the whole log, while the view the diffs come
      // from holds the active window: a `pi.reset` truncates the view. Entry ids already sent are
      // tracked here so an entry committed between the view read and the scan reaches the client
      // exactly once, whether it arrives in the snapshot or as an event.
      const entries = yield* readConversationEntries(session.root);
      const sent = new Set(entries.map((entry) => String(entry.id)));

      // The session's spend is every conversation's (LOB-193): a mission's worker is charged in its
      // own conversation, which the root's view never shows changing. So a `usage` event carries
      // `Harness.usage()`, re-read whenever the root's ledger changes and whenever the task graph
      // does — a worker's request is a task of its conversation, so its spend lands beside a graph
      // revision. Reads are chained, so totals are reported in the order they were read, and one
      // that matches the last reported is dropped. Totals only grow.
      let reported = yield* readSessionUsage(session.harness);
      let reading: Promise<void> = Promise.resolve();
      const refreshUsage = () => {
        reading = reading.then(() =>
          session.harness.usage(BACKGROUND_CONTEXT).then(
            (state) => {
              const usage = mergeUsage([projectUsageDoc(state)]);
              if (JSON.stringify(usage) === JSON.stringify(reported)) return;
              reported = usage;
              Queue.offerUnsafe(queue, { _tag: "usage", usage });
            },
            // A harness that closed under the stream has nothing more to report.
            () => undefined,
          ),
        );
      };

      unsubscribe = state.subscribe((next) => {
        const events = diffView(previous, next, sent);
        previous = next;
        for (const event of events)
          if (event._tag === "usage") refreshUsage();
          else Queue.offerUnsafe(queue, event);
      });

      unsubscribeTasks = graph.subscribe((next) => {
        refreshUsage();
        const tasks = projectTasks(next);
        if (sameTasks(previousTasks, tasks)) return;
        previousTasks = tasks;
        Queue.offerUnsafe(queue, { _tag: "tasks", tasks });
      });

      // Offer the snapshot before subscribing has a chance to enqueue anything, so a client never
      // sees an event for a session it has not been told about. The mission is read once, with the
      // snapshot: a phase change is a document commit, and the stream reports entries and tasks, so
      // a subscriber that needs the new phase re-reads the snapshot rather than being told twice.
      const mission = yield* readMissionSnapshot(session.harness, session.root);
      const budget = yield* readBudgetDoc(session.harness, session.root);
      const replay = yield* readReplayDoc(session.harness, session.root);
      const proposed = yield* readProposedIssues(session.harness, session.root);
      const plans = yield* readPlanRevisions(session.harness, session.root);
      yield* Queue.offer(
        queue,
        snapshotEvent(
          snapshotOf(
            state.value,
            previousTasks,
            ref,
            entries,
            mission,
            budget,
            reported,
            replay,
            proposed,
            plans,
          ),
        ),
      );
      return Stream.fromQueue(queue);
    }),
  );

/**
 * Transcript entries a historical read serves before anyone asks for earlier ones (LOB-243): the
 * newest this many, so what a read of a long session costs is what it shows, not the log's length.
 */
export const HISTORY_WINDOW = 200;

/** The most entries one page of earlier history serves (`readTranscriptPage`). */
export const HISTORY_PAGE_MAX = 500;

/** One page of a transcript, oldest first, and where the page before it starts. */
export type TranscriptPage = {
  readonly entries: readonly TranscriptEntry[];
  /**
   * The id of the oldest entry in `entries` when the transcript holds entries before it — what a
   * caller passes as `before` for the page before this one. Absent when `entries` starts the
   * transcript.
   */
  readonly earlier?: string;
};

/**
 * An entry id as the transcript names it (`TranscriptEntry.id`), or `undefined` for anything that
 * is not one. Pi Durable mints entry ids as positive integers, and a transcript prints them as
 * decimal strings; the brand is the one thing this adds.
 */
const entryIdOf = (text: string): EntryId | undefined => {
  if (!/^[1-9][0-9]*$/.test(text)) return undefined;
  const id = Number(text);
  return Number.isSafeInteger(id) ? (id as EntryId) : undefined;
};

/**
 * The newest `limit` entries of the root's transcript before entry `before` (all of them when it
 * is absent), oldest first — one storage scan of one page, whatever the log's length, because Pi
 * Durable scans a conversation newest first from an id bound (LOB-243).
 */
const readTranscriptRecords = (
  storage: Storage,
  options: { readonly before?: EntryId; readonly limit: number },
): Effect.Effect<
  { readonly records: readonly EntryRecord[]; readonly earlier?: string },
  SessionError
> =>
  Effect.gen(function* () {
    const page = yield* attempt("scan entries", () =>
      storage.scanEntries(
        options.before === undefined
          ? { conversationId: ROOT_CONVERSATION_ID }
          : {
              conversationId: ROOT_CONVERSATION_ID,
              maxEntryId: (options.before - 1) as EntryId,
            },
        options.limit,
        undefined,
        BACKGROUND_CONTEXT,
      ),
    );
    // Storage scans newest first; a transcript reads oldest first.
    const records = [...page.items].reverse();
    const oldest = records[0];
    return page.next === undefined || oldest === undefined
      ? { records }
      : { records, earlier: String(oldest.id) };
  });

/**
 * The page of a session's transcript before entry `before`, read without owning the log: what a
 * client asks for when it wants more of a long session than a historical snapshot carried
 * (`SessionSnapshot.earlier`, LOB-243). `limit` is clamped to `1..HISTORY_PAGE_MAX`; a `before` that
 * is not an entry id is refused as `invalid_input`.
 */
export const readTranscriptPage = (
  storage: Storage,
  options: { readonly before: string; readonly limit?: number },
): Effect.Effect<TranscriptPage, SessionError> =>
  Effect.gen(function* () {
    const before = entryIdOf(options.before);
    if (before === undefined) {
      return yield* new SessionErrorClass({
        code: "invalid_input",
        message: `before "${options.before}" is not an entry id`,
      });
    }
    const limit = Math.min(
      HISTORY_PAGE_MAX,
      Math.max(1, Math.trunc(options.limit ?? HISTORY_WINDOW)),
    );
    const page = yield* readTranscriptRecords(storage, { before, limit });
    return {
      entries: page.records.map(projectEntry),
      ...(page.earlier === undefined ? {} : { earlier: page.earlier }),
    };
  });

/**
 * Every approval the root records, folded from its approval ledger (`ApprovalsDoc`, LOB-243) — a
 * document bounded by the approvals asked for — when the ledger is seeded, and from the whole
 * transcript when it is not: a log written before the ledger existed and not opened since. Either
 * way it is `projectApprovals` over the same approval entries, so both answer alike.
 *
 * `recent` is entries the caller already read (a historical read's window). One of approval kind
 * newer than the ledger's `through` was appended without its copy — by a build that predates the
 * ledger — so the ledger is stale and the transcript is folded instead. The check costs no read.
 */
export const readApprovalRecords = (
  storage: Storage,
  recent: readonly EntryRecord[] = [],
): Effect.Effect<readonly ApprovalLogRecord[], SessionError> =>
  Effect.gen(function* () {
    const ledger = yield* readDocument(storage, APPROVALS_DOC_KIND);
    const entries = ledger?.["entries"];
    const through = ledger?.["through"];
    const trusted =
      ledger?.["seeded"] === true &&
      Array.isArray(entries) &&
      typeof through === "number" &&
      !recent.some(
        (record) =>
          Number(record.id) > through && APPROVAL_ENTRY_KINDS.has(record.kind),
      );
    if (trusted) {
      return projectApprovals(
        entries.flatMap((value) => {
          const entry = asLedgerEntry(value);
          return entry === undefined ? [] : [entry];
        }),
      );
    }
    return projectApprovals(yield* readAllEntries(storage));
  });

/** One ledger entry read defensively: a value that is not `{ kind, data }` folds to nothing. */
const asLedgerEntry = (
  value: JsonValue,
): { readonly kind: string; readonly data: JsonValue } | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  const kind = value["kind"];
  return typeof kind === "string"
    ? { kind, data: value["data"] ?? null }
    : undefined;
};

/**
 * A session nobody owns, read through a reader-mode `Storage`.
 *
 * No `Harness` is opened, because Pi Durable allows exactly one owner, and this is the read-only
 * path D7 asks for — the control plane must be able to read a session without owning it.
 *
 * Bounded by what it shows (LOB-243, R6): the storage open restores the log's checkpoint and folds
 * only the commits after it (LOB-186), and this reads documents — the approval ledger, usage, budget,
 * mission, replay, proposals — and the newest `HISTORY_WINDOW` transcript entries, never the whole
 * transcript. `earlier` says there is more; `readTranscriptPage` pages back through it on request.
 * The full fold (`readSessionLog`) is still what a rebuild, a fork and a replay read.
 */
export const readHistoricalSnapshot = (
  storage: Storage,
  ref: SessionRef,
): Effect.Effect<SessionSnapshot, SessionError> =>
  readFoldedSnapshot(storage, ref);

/**
 * What a log says is happening now (LOB-18): its run, its queue, its spend and its live tasks, read
 * through a reader-mode `Storage` — the parts of a snapshot a historical read reports as "nothing",
 * because nobody owns the log, and a followed read reports as the owner elsewhere committed them.
 */
export type FollowedState = {
  readonly live: SessionLive;
  readonly queued: readonly QueuedMessage[];
  readonly usage: SessionUsage;
  readonly tasks: readonly SessionTask[];
};

/**
 * `readHistoricalSnapshot`'s fold, and the one a followed read takes too (LOB-18): with `followed`,
 * the session is live in another process, so the snapshot says `live`, and its run, queue, spend and
 * tasks are what the log holds now rather than an owner-less idle. Everything else — the bounded
 * transcript window, the documents — is the same read, so the two can never disagree about them.
 */
export const readFoldedSnapshot = (
  storage: Storage,
  ref: SessionRef,
  followed?: FollowedState,
): Effect.Effect<SessionSnapshot, SessionError> =>
  Effect.gen(function* () {
    const transcript = yield* readTranscriptRecords(storage, {
      limit: HISTORY_WINDOW,
    });
    const usage = followed?.usage ?? (yield* readLogUsage(storage));
    const approvals = yield* readApprovalRecords(storage, transcript.records);
    const replayComparisons = projectReplayComparisons(
      yield* readDocument(storage, REPLAY_DOC_KIND),
    );
    const log = {
      entries: transcript.records.map(projectEntry),
      usage,
      approvals,
      replayComparisons,
    };
    const mission = yield* readFoldedMission(storage);
    const proposedIssues = projectProposedIssues(
      yield* readDocument(storage, PROPOSED_ISSUES_DOC_KIND),
    );
    const planRevisions = projectPlanRevisions(
      yield* readDocument(storage, PLAN_REVISIONS_DOC_KIND),
    );
    const budget = projectBudgetDoc(
      yield* readDocument(storage, BUDGET_DOC_KIND),
      log.usage,
    );
    // The index's value when it has one, otherwise the log's own `pi.agent` — one document read, so
    // the bounded fold stays bounded — and a row written before the column existed still answers
    // its model (LOB-269).
    const model = ref.model ?? (yield* readPinnedModelKey(storage));
    return {
      session: {
        id: ref.id,
        title: ref.title,
        createdAt: ref.createdAt,
        mode: followed === undefined ? "historical" : "live",
        // Nothing is running here by definition; the sandbox that ran it is paused or gone (D8).
        // Followed, the owner elsewhere says so through the log's `pi.live` (LOB-18).
        status: followed?.live.busy === true ? "busy" : "idle",
        ...(ref.workspace.repo === undefined
          ? {}
          : { repo: ref.workspace.repo }),
        ...(ref.workspace.baseRef === undefined
          ? {}
          : { baseRef: ref.workspace.baseRef }),
        ...(ref.prUrl === undefined ? {} : { prUrl: ref.prUrl }),
        ...(ref.forkedFrom === undefined ? {} : { forkedFrom: ref.forkedFrom }),
        ...(model === undefined ? {} : { model }),
      },
      workspace: ref.workspace,
      entries: log.entries,
      ...(transcript.earlier === undefined
        ? {}
        : { earlier: transcript.earlier }),
      live: followed?.live ?? { busy: false, tools: [] },
      usage: log.usage,
      queued: followed?.queued ?? [],
      // Nobody owns this log, so nothing runs in it: a sandbox that ran it is paused or gone (D8).
      // Followed, somebody does, and its live tasks are in the log (LOB-18).
      tasks: followed?.tasks ?? [],
      // The mission is document state, not live state: a released session still reports the phase
      // its mission reached, which is what part 3 reads to resume it (LOB-230).
      ...(mission === undefined ? {} : { mission }),
      // The point of the fold (LOB-147): a request committed before the owner was released is still
      // waiting here, so a restarted control plane asks a person for the same answer, not again.
      approvals: pendingOf(ref.id, log.approvals),
      // The cap and its last stop are document state (LOB-163): a released session reports both.
      ...(budget === undefined ? {} : { budget }),
      // So is a replay comparison (LOB-199): both sides report it with nobody owning either.
      ...(log.replayComparisons.length === 0
        ? {}
        : { replayComparisons: log.replayComparisons }),
      // Proposals are document state too (LOB-201): a released session still reports them.
      ...(proposedIssues === undefined ? {} : { proposedIssues }),
      // So are the plan-freshness revisions (LOB-45).
      ...(planRevisions === undefined ? {} : { planRevisions }),
    };
  });

export { snapshotEvent };
