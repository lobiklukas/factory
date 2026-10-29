/**
 * Session contracts shared by the control plane, the CLI, and the dashboard.
 *
 * A session is one Pi Durable log (docs/design.md D7): `SessionId` *is* the `log_id`. The id is
 * minted by the server, never recycled, and safe in a URL or a git branch
 * (`factory/<session-id>`, D10). `title` is the human label and may change.
 *
 * Nothing here knows about Pi Durable. The projection from its records into these shapes lives
 * in `packages/harness`, so a change in that dependency (R1) stops at that boundary instead of
 * reaching the wire contract and the dashboard.
 */
import { Schema } from "effect";
import { ApprovalRequest } from "@repo/domain/Approval";
import { SessionId, Timestamp } from "@repo/domain/Ids";
import { ProposedIssues } from "@repo/domain/Decomposition";
import { MissionSnapshot, ModelUsage } from "@repo/domain/Mission";
import { PlanRevision } from "@repo/domain/PlanFreshness";

// The two scalars every contract names. They are defined in `Ids` so `Approval` can name a session
// without importing this module, which imports it back for the snapshot's pending approvals; the
// re-export keeps `@repo/domain/Session` the place a caller imports them from.
export { SessionId, Timestamp } from "@repo/domain/Ids";

/** Whether these reads come from a harness running here, or from folding the log (D8). */
export const SessionMode = Schema.Literals(["live", "historical"]);
export type SessionMode = typeof SessionMode.Type;

export const SessionStatus = Schema.Literals(["idle", "busy"]);
export type SessionStatus = typeof SessionStatus.Type;

/**
 * A repository the factory knows about, as `owner/name` (D10's branch, D14's credential, and a
 * trigger all need a repo to name). Lowercase, because a git remote is case-insensitive on GitHub
 * and two spellings of one repo would be two registrations.
 */
export const RepoSlug = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/)),
  Schema.brand("RepoSlug"),
);
export type RepoSlug = typeof RepoSlug.Type;

/**
 * Who a session's spend is attributed to (LOB-162, part 2 of LOB-17): the actor the call's
 * credential authenticated as (LOB-20, `@repo/domain/Auth`), or a trigger's `trigger:<source>` for a
 * session a signed delivery opened.
 *
 * The value comes from the credential, not the body: a create, a fork and a replay over the RPC
 * surface record the server's `Caller`, and a body `actor` naming someone else changes nothing. Only
 * a control plane running with auth off keeps a declared one (`cli`, `dashboard`, …). The credential
 * changed where the value comes from, not this shape, the `sessions.actor` column, or the
 * `factory.actor` document that records it. The checks keep a name
 * readable in the spend pane: nothing blank, no surrounding whitespace and no control character
 * anywhere — an embedded newline or NUL renders as nothing, so two spellings of one actor would look
 * like one name in two rows — and at most 200 characters.
 */
export const SessionActor = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[^\s\p{Cc}](?:[^\p{Cc}]*[^\s\p{Cc}])?$/u)),
  Schema.check(Schema.isMaxLength(200)),
);
export type SessionActor = typeof SessionActor.Type;

/**
 * A branch a session's worktree may be cut on (D10, LOB-197).
 *
 * The default is `factory/<session-id>`, minted by the server and safe by construction. A caller
 * that names its own branch is naming a *git* branch, and the workspace passes it to `git worktree
 * add` — so the shape is checked here rather than trusted: no space, no `~^:?*[\\`, no `..`, no
 * leading `-` or `/`, and no shell metacharacter (`$`, backtick, quote, `;`), which a shell-quoted
 * `execSync` would otherwise expand. A branch a docs run names is `factory/doc-<id>`.
 */
export const BranchName = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/)),
  Schema.check(Schema.isMaxLength(200)),
  Schema.brand("BranchName"),
);
export type BranchName = typeof BranchName.Type;

/**
 * The commands a repo declares for itself, from `.factory/config` in the checkout
 * (docs/features.md §3 A1). Every field is optional: a repo with no config still opens a session,
 * it just cannot say how to build or test itself.
 */
export const RepoCommands = Schema.Struct({
  install: Schema.optional(Schema.String),
  build: Schema.optional(Schema.String),
  test: Schema.optional(Schema.String),
  verify: Schema.optional(Schema.String),
});
export type RepoCommands = typeof RepoCommands.Type;

/**
 * One check of a checkout's agent-readiness (LOB-29, `@repo/harness`'s `scoreRepoReadiness`): its
 * name (`agents-md`, `package-scripts`, `verify-skills`, `skill-dir`), whether it passed, and why.
 */
export const RepoReadinessCheck = Schema.Struct({
  name: Schema.String,
  passed: Schema.Boolean,
  reason: Schema.String,
});
export type RepoReadinessCheck = typeof RepoReadinessCheck.Type;

/**
 * How ready a checkout is for an agent to work in (LOB-29): how many of the checks passed (`score`)
 * out of how many there are (`max`), and each check with its reason.
 */
export const RepoReadiness = Schema.Struct({
  score: Schema.Int,
  max: Schema.Int,
  checks: Schema.Array(RepoReadinessCheck),
});
export type RepoReadiness = typeof RepoReadiness.Type;

/**
 * One row of the repo registry: where a repo is cloned from and which ref sessions start at, with
 * what its local checkout says about itself (LOB-253).
 *
 * `url` is `""` for a repo nobody gave a clone URL — the row `createSession` writes the first time
 * a session names a slug — and `localPath` is absent for a repo with no checkout on this machine.
 * Such a repo still opens sessions, but in an empty directory: no worktree is cut, so nothing it
 * changes can be measured. The two booleans are read from the checkout at the moment the row is
 * answered, never stored, so a checkout that was moved or deleted since it was registered reads as
 * `localPathIsGit: false` rather than as the fact it was when registered.
 */
export const RepoSummary = Schema.Struct({
  repo: RepoSlug,
  url: Schema.String,
  defaultBaseRef: Schema.String,
  /** A checkout on this machine to read `.factory/config` and the default ref from, if any. */
  localPath: Schema.optional(Schema.String),
  registeredAt: Timestamp,
  /** `localPath` is inside a git work tree, so a session's worktree can be cut from it. */
  localPathIsGit: Schema.Boolean,
  /** `localPath` holds a `.factory/config` declaring the repo's commands. */
  hasFactoryConfig: Schema.Boolean,
  /**
   * The root of the git work tree `localPath` is inside (`git rev-parse --show-toplevel`): the
   * repository a session's worktree is cut from. The path itself for a checkout's root, an
   * enclosing directory for one inside it (a monorepo package, or a plain directory under an
   * unrelated repository). Present exactly when `localPathIsGit`.
   */
  workTree: Schema.optional(Schema.String),
  /**
   * The factory's own bare clone of `url`, when one exists on the API's disk (LOB-265): a repo with
   * no `localPath` and a `url` is cloned there on registration, and a session's worktree is cut from
   * it. Read from the disk each time the row is answered, like the checkout's facts. Absent for a
   * repo that has a `localPath`, has no `url`, or has not been cloned yet.
   */
  mirrorPath: Schema.optional(Schema.String),
  /**
   * The checkout's agent-readiness score (LOB-29, S-env-setup), scored from `localPath` when the row
   * is answered — so a registration answers it, and every read re-scores it, like the facts above:
   * an AGENTS.md added since registration counts on the next read. Absent for a repo whose
   * `localPath` is not a git work tree (or that has none): a bare mirror has no files to score.
   */
  readiness: Schema.optional(RepoReadiness),
});
export type RepoSummary = typeof RepoSummary.Type;

/** What `listRepos` reads: every registered repo — the registry is small, so no page. */
export const ListReposInput = Schema.Struct({});
export type ListReposInput = typeof ListReposInput.Type;

export const ListReposOutput = Schema.Struct({
  /** Ordered by slug. */
  repos: Schema.Array(RepoSummary),
});
export type ListReposOutput = typeof ListReposOutput.Type;

export const GetRepoInput = Schema.Struct({ repo: RepoSlug });
export type GetRepoInput = typeof GetRepoInput.Type;

/**
 * `getRepo` was asked for a slug the registry has no row for (LOB-253). A tag of its own rather
 * than `SessionError`'s `not_found`, which means a session: the CLI prints it as `repo_not_found`.
 */
export class RepoNotFound extends Schema.TaggedError<RepoNotFound>()(
  "RepoNotFound",
  { repo: Schema.String, message: Schema.String },
) {}

/**
 * Why the factory could not clone or fetch a repo into its own cache (LOB-265): `auth` is a token
 * the remote refused, `credential` is no token to send, `missing-ref` is a base ref the remote does
 * not have, `refused` is a URL or ref outside what a token may be sent to, `timeout` and `failed`
 * are the network and everything else. A tag of its own rather than a `SessionError`, so
 * `factory repo add` and `factory doctor` name the repo and the reason (`repo_clone_failed`).
 */
export const RepoCloneFailureReason = Schema.Literals([
  "auth",
  "credential",
  "missing-ref",
  "refused",
  "timeout",
  "failed",
]);
export type RepoCloneFailureReason = typeof RepoCloneFailureReason.Type;

export class RepoCloneFailed extends Schema.TaggedError<RepoCloneFailed>()(
  "RepoCloneFailed",
  {
    repo: Schema.String,
    reason: RepoCloneFailureReason,
    message: Schema.String,
  },
) {}

/**
 * A repository's `.factory/config` policy that cannot be loaded (S-factory-config-as-code): read at
 * the session's base ref, it is not a JSON object, its `policy` block is not the policy's shape (an
 * unknown key is refused, so a key that would widen something is never silently dropped), or it tries
 * to allow something the deployment denies (`widens`: a host off the deployment's allowlist).
 * `reasons` names each problem; `ref` and `commit` say which base it was read at, and `path` where.
 * A session on the repository does not open until the config on its base is fixed
 * (`policy_rejected`), because running under part of a policy its author wrote would be running
 * under a policy nobody wrote.
 */
export const RepoPolicyRejectionKind = Schema.Literals([
  "unreadable",
  "invalid",
  "widens",
]);
export type RepoPolicyRejectionKind = typeof RepoPolicyRejectionKind.Type;

export class RepoPolicyRejected extends Schema.TaggedError<RepoPolicyRejected>()(
  "RepoPolicyRejected",
  {
    repo: Schema.String,
    ref: Schema.String,
    commit: Schema.String,
    path: Schema.String,
    kind: RepoPolicyRejectionKind,
    reasons: Schema.Array(Schema.String),
    message: Schema.String,
  },
) {}

/**
 * A repository's `.factory/config` policy that git could not read at the session's base
 * (S-factory-config-as-code): the lookup of the base, or the listing or read of the config at the
 * commit it names, failed or outlived its deadline — a busy machine, a lock, a corrupt object — rather
 * than answering. Not a verdict on the config: nothing ran, because a run under the deployment's policy
 * alone would drop the repository's gates without a word, and the same request is worth retrying
 * (`policy_unreadable`). `ref` is the base it was read at; `commit` is absent when the base itself
 * could not be looked up.
 */
export class RepoPolicyUnavailable extends Schema.TaggedError<RepoPolicyUnavailable>()(
  "RepoPolicyUnavailable",
  {
    repo: Schema.String,
    ref: Schema.String,
    commit: Schema.optional(Schema.String),
    message: Schema.String,
  },
) {}

export const SessionSummary = Schema.Struct({
  id: SessionId,
  title: Schema.String,
  status: SessionStatus,
  mode: SessionMode,
  createdAt: Timestamp,
  /** The repo this session works on, absent for a scratch session. */
  repo: Schema.optional(RepoSlug),
  baseRef: Schema.optional(Schema.String),
  /** The URL of the PR opened for this session, once one exists. */
  prUrl: Schema.optional(Schema.String),
  /** The session this one was forked from, once one was (LOB-180). */
  forkedFrom: Schema.optional(SessionId),
  /**
   * The model the session's root conversation is pinned to, as `provider/modelId` (LOB-269): what
   * its requests go to, `faux/faux-1` under the faux backend. Read from the log's `pi.agent`, so a
   * replay names the model it was replayed onto and a run on a card names its role's model. Absent
   * only for an index row written before the column existed that `rebuildIndexes` has not refolded
   * yet, and only on a read that does not fold the log.
   */
  model: Schema.optional(Schema.String),
  /**
   * Whether this process serves the model the session is pinned to (E9): `false` when a pin names a
   * model the catalog it was booted with does not hold (a faux session after the API switched to
   * anthropic), so a send is refused as `model_unavailable` and the dashboard says why. Absent when
   * the session names no model, which is to say there is nothing to serve; `true` is a model this
   * process serves.
   */
  modelAvailable: Schema.optional(Schema.Boolean),
});
export type SessionSummary = typeof SessionSummary.Type;

/** One tool call on an assistant entry, as the transcript shows it. */
export const ToolCallRef = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
});
export type ToolCallRef = typeof ToolCallRef.Type;

/**
 * One transcript entry, projected from a Pi Durable `EntryRecord` (`packages/harness` maps the
 * kinds). `text` is the model-facing text, flattened; `toolName` is set on tool results. `isError` is
 * a tool result's own flag, and on an assistant entry it marks a model request that failed; `error` is
 * then the provider's message for it, kept out of `text` so the failure is never read as an answer.
 * `inherited` is a line a fork copied from the session it was forked from that is history, not
 * its own (LOB-211): the parent's PR, which the fork does not have.
 */
export const TranscriptEntryKind = Schema.Literals([
  "user",
  "assistant",
  "toolResult",
  "system",
  "reset",
  "compaction",
  "title",
  "budget",
  "interrupted",
  "inherited",
  "other",
]);
export type TranscriptEntryKind = typeof TranscriptEntryKind.Type;

export const TranscriptEntry = Schema.Struct({
  id: Schema.String,
  kind: TranscriptEntryKind,
  text: Schema.String,
  toolCalls: Schema.Array(ToolCallRef),
  toolName: Schema.optional(Schema.String),
  isError: Schema.optional(Schema.Boolean),
  error: Schema.optional(Schema.String),
  /**
   * Set on the entries a settled run's PR step announces when it opened no PR (F17): an unchanged
   * branch, a refusal, a push of later commits. Their kind is `other`, as every entry this package
   * writes is, so a reader that waits for the step's answer (`factory run --open-pr`) matches this
   * flag instead of taking any `other` entry — an approval or a page the run wrote — for it.
   */
  prStep: Schema.optional(Schema.Boolean),
});
export type TranscriptEntry = typeof TranscriptEntry.Type;

/** A queued submission waiting in `pi.inbox` for a boundary. */
export const QueuedMessage = Schema.Struct({
  id: Schema.String,
  mode: Schema.Literals(["steer", "followUp", "write"]),
  content: Schema.optional(Schema.Unknown),
});
export type QueuedMessage = typeof QueuedMessage.Type;

/** A tool of the round the current generation is running. */
export const ToolSlotView = Schema.Struct({
  callId: Schema.String,
  name: Schema.String,
  status: Schema.Literals(["pending", "running", "done"]),
  output: Schema.optional(Schema.String),
});
export type ToolSlotView = typeof ToolSlotView.Type;

/**
 * What is happening right now. `busy` is the same signal as `SessionStatus`, and `partial` is the
 * in-flight answer as Pi Durable last committed it — the whole reason the UI attaches instead of
 * polling the fold (D8).
 */
export const SessionLive = Schema.Struct({
  busy: Schema.Boolean,
  partial: Schema.optional(Schema.String),
  tools: Schema.Array(ToolSlotView),
});
export type SessionLive = typeof SessionLive.Type;

// Defined in `Mission.ts`, which this module imports: a mission's workers report it too (LOB-194).
export { ModelUsage };

/**
 * One live task in a session: what is running right now, in which phase, on whose behalf, and what
 * it waits for. Mirrors Pi Durable's `TaskGraph` node (LOB-183).
 *
 * Only live tasks appear — `pending`, `running`, `waiting` and `completing`. A settled task is gone
 * from the list rather than carried as a fourth kind of history, because the durable record is the
 * log and this is the "what is happening now" projection.
 *
 * `phase` is absent for `completing`: a task that has decided its outcome runs no more phases. `id`
 * and `owner` are strings because a Pi Durable id is a number that clients should not do arithmetic
 * on; `waitingOn` names the live task ids a `waiting` task joins.
 */
export const SessionTask = Schema.Struct({
  id: Schema.String,
  kind: Schema.String,
  status: Schema.Literals(["pending", "running", "waiting", "completing"]),
  phase: Schema.optional(Schema.String),
  waitingOn: Schema.Array(Schema.String),
  owner: Schema.optional(Schema.String),
  conversations: Schema.Array(Schema.String),
});
export type SessionTask = typeof SessionTask.Type;

/**
 * Spend, keyed the way Pi Durable keys it: `provider/modelId` for models, tool name for tools.
 *
 * Both buckets carry the same counters, because a tool result may report spend of its own (an
 * execution that calls a model, like a subagent) and it lands in `pi.usage.tools` with no model
 * identity. A session's total is therefore the two buckets added, never `models` alone — which is
 * what `usageCostTotal` in the harness does, for both the live writer and the rebuild fold.
 *
 * `tools` is empty rather than absent for a session whose tools report nothing: an empty list is
 * "nothing to attribute", and the list surface's cost total is unaffected by the distinction.
 */
export const SessionUsage = Schema.Struct({
  models: Schema.Array(
    Schema.Struct({ key: Schema.String, usage: ModelUsage }),
  ),
  tools: Schema.Array(Schema.Struct({ key: Schema.String, usage: ModelUsage })),
});
export type SessionUsage = typeof SessionUsage.Type;

/**
 * A session's spend ceiling (LOB-163), in the currency `pi.usage` reports (US dollars). A positive
 * finite number: a cap of zero would stop every run before its first request, which is not a budget
 * but a disabled session, and nothing asks for that.
 */
export const SessionBudgetCap = Schema.Finite.pipe(
  Schema.check(Schema.isGreaterThan(0)),
);
export type SessionBudgetCap = typeof SessionBudgetCap.Type;

/**
 * The last time the cap stopped a run: when, what the session had spent, and the cap it was held to.
 * `spent` is at least `cap` — the cap stops a run once spend *reaches* it.
 */
export const SessionBudgetStop = Schema.Struct({
  at: Timestamp,
  spent: Schema.Finite,
  cap: Schema.Finite,
});
export type SessionBudgetStop = typeof SessionBudgetStop.Type;

/**
 * A capped session's budget, as its log records it (LOB-163): the cap, the spend it is measured
 * against (both `pi.usage` buckets, the same total the list shows), and the last stop, if the cap has
 * stopped a run. A session with no cap has no budget, so the snapshot's field is absent rather than
 * carrying an infinite one.
 */
export const SessionBudget = Schema.Struct({
  cap: Schema.Finite,
  spent: Schema.Finite,
  stopped: Schema.optional(SessionBudgetStop),
});
export type SessionBudget = typeof SessionBudget.Type;

/**
 * The terminal events that tear a session's worktree and branch down (LOB-268), and nothing else
 * does: the idle sweep and a shutdown release the harness and leave the work where it is.
 *
 * - `done`, `canceled` — the card the session is a run of reached that terminal column.
 * - `merged` — the pull request the session opened merged.
 * - `discarded` — an operator discarded the session (`factory discard`, `discardSession`).
 */
export const WorkspaceReleaseReason = Schema.Literals([
  "done",
  "canceled",
  "merged",
  "discarded",
]);
export type WorkspaceReleaseReason = typeof WorkspaceReleaseReason.Type;

/** When and why a session's workspace was torn down: the first terminal event, kept. */
export const WorkspaceRelease = Schema.Struct({
  reason: WorkspaceReleaseReason,
  at: Timestamp,
});
export type WorkspaceRelease = typeof WorkspaceRelease.Type;

/**
 * What a teardown answers (LOB-268). `first` says this call is the one that released the workspace;
 * a repeat answers `false` with the release the first call recorded, its reason included, so a
 * second terminal event (a merge, then the card's `done`) is a no-op that says so.
 */
export const ReleaseWorkspaceResult = Schema.Struct({
  sessionId: SessionId,
  release: WorkspaceRelease,
  first: Schema.Boolean,
});
export type ReleaseWorkspaceResult = typeof ReleaseWorkspaceResult.Type;

/**
 * Where a session's work actually lives, as the server resolved it (docs/features.md §3 A1).
 *
 * `path` is the session's working directory — one per session, so sessions never share files — and
 * under a repo it is scoped by that repo. `commands` is what the repo declares about itself, and
 * `commandsSource` says whether that came from a `.factory/config` the server could read or from
 * nothing at all: a repo with no config is a fact the caller can see, not an empty answer.
 *
 * `released` is set once the worktree and branch were torn down (LOB-268): `path` is where they
 * were, not a directory that exists, and the session takes no new run.
 *
 * `warning` is set when the session is bound to a repo that has no local checkout (LOB-263): no
 * worktree is cut, `path` is an empty directory, and nothing the run changes can be measured, so a
 * `non_empty_diff` gate or a PR step would fail columns later. The session still opens — a repo is
 * registered on first use, and a person can fix the registry while it runs — but the answer says so
 * when it is created and names the command that fixes it. Never set for a scratch session.
 */
export const SessionWorkspace = Schema.Struct({
  path: Schema.String,
  repo: Schema.optional(RepoSlug),
  baseRef: Schema.optional(Schema.String),
  branch: Schema.optional(Schema.String),
  commands: RepoCommands,
  commandsSource: Schema.Literals(["repo", "none"]),
  released: Schema.optional(WorkspaceRelease),
  warning: Schema.optional(Schema.String),
});
export type SessionWorkspace = typeof SessionWorkspace.Type;

/**
 * One verification a PR cites, as the run's `verify` tool recorded it (LOB-79, part 2 of LOB-16).
 *
 * `name` is what ran: the skill directory's name (`verify-api`) when the surface's skill ran, or
 * `commands.verify` when the repo's declared command did. `excerpt` is a bounded tail of the output
 * the record holds, cut deterministically (the same record always gives the same excerpt), and
 * `truncated` says the excerpt is shorter than what the command printed — either because the record
 * already kept only a tail or because the excerpt cut it further. The output stays the record's: a
 * PR quotes it, it never paraphrases it.
 */
export const VerificationRan = Schema.TaggedStruct("VerificationRan", {
  surface: Schema.String,
  name: Schema.String,
  source: Schema.Literals(["workspace", "skill"]),
  command: Schema.String,
  exitCode: Schema.Int,
  excerpt: Schema.String,
  truncated: Schema.Boolean,
});
export type VerificationRan = typeof VerificationRan.Type;

/** A verification that was found and could not run to an exit code (spawn failure, timeout). */
export const VerificationUnrunnable = Schema.TaggedStruct(
  "VerificationUnrunnable",
  {
    surface: Schema.String,
    name: Schema.String,
    source: Schema.Literals(["workspace", "skill"]),
    command: Schema.String,
    /** The execution environment's error code (`timeout`, `spawn_failed`, …). */
    code: Schema.String,
    message: Schema.String,
    excerpt: Schema.String,
    truncated: Schema.Boolean,
  },
);
export type VerificationUnrunnable = typeof VerificationUnrunnable.Type;

/** A changed surface the repo gives no way to verify: named, so its absence is on the PR. */
export const VerificationMissing = Schema.TaggedStruct("VerificationMissing", {
  surface: Schema.String,
  message: Schema.String,
});
export type VerificationMissing = typeof VerificationMissing.Type;

export const Verification = Schema.Union([
  VerificationRan,
  VerificationUnrunnable,
  VerificationMissing,
]);
export type Verification = typeof Verification.Type;

/**
 * Whether the cited `verify` call saw the paths the PR publishes (LOB-79): `published` is how many
 * the PR's `base...head` diff names, `covered` how many of those the call measured, and `missed` the
 * first few it did not (sorted; at most `EVIDENCE_MISSED_LIMIT`). A missed path is one the run
 * changed after it verified, so the verdict predates it. Paths, not contents: a later edit to a path
 * the call did measure is not seen here.
 */
export const EvidenceCoverage = Schema.Struct({
  published: Schema.Int,
  covered: Schema.Int,
  missed: Schema.mutable(Schema.Array(Schema.String)),
});
export type EvidenceCoverage = typeof EvidenceCoverage.Type;

/** How many of the PR's paths the cited call missed an `EvidenceCoverage` names. */
export const EVIDENCE_MISSED_LIMIT = 20;

/**
 * The run's last recorded `verify` call, as the PR carries it: one row per verification it ran.
 *
 * The last call rather than every call, because a later call is the one that saw the change the PR
 * publishes; `calls` says how many there were (recorded or not), so a reader knows earlier verdicts
 * exist. `results` is never empty — a call that verified nothing is `EvidenceNone` — and mutable only
 * so its encoding is a plain JSON value Pi Durable's documents accept.
 */
export const EvidenceRecorded = Schema.TaggedStruct("EvidenceRecorded", {
  calls: Schema.Int,
  changedCount: Schema.Int,
  results: Schema.mutable(Schema.Array(Verification)),
  /**
   * How many `verify` calls after the cited one left no record (blocked or crashed). Absent means
   * none: the cited call is the run's last. Otherwise the body says so, because the newest call is
   * the one that would have seen the latest change, and it has nothing to show.
   */
  unrecordedAfter: Schema.optionalKey(Schema.Int),
  /**
   * How the cited call's measured paths compare with the paths the PR publishes. Absent when the
   * PR's paths were not measured (a session directory that is not its own checkout).
   */
  coverage: Schema.optionalKey(EvidenceCoverage),
});
export type EvidenceRecorded = typeof EvidenceRecorded.Type;

/**
 * A run with nothing to show: it never called `verify` (`not-verified`), every call it made left no
 * record because it was blocked or crashed (`unrecorded`), its last recorded call could not measure
 * what changed (`unmeasured`), or that call found no changed path (`no-changes`). A value rather than
 * an absent section, so a PR without evidence says so instead of looking like one whose evidence was
 * left out.
 */
export const EvidenceNone = Schema.TaggedStruct("EvidenceNone", {
  reason: Schema.Literals([
    "not-verified",
    "unrecorded",
    "unmeasured",
    "no-changes",
  ]),
  /** Why, in the factory's words: a sentence the body renders as Markdown. */
  message: Schema.String,
  /**
   * What the tool itself said, when it said something (`unmeasured`: git's stderr, the directory it
   * could not measure). Tool-authored, so the body quotes it as code rather than as Markdown.
   */
  detail: Schema.optionalKey(Schema.String),
});
export type EvidenceNone = typeof EvidenceNone.Type;

/**
 * What a session's PR states was verified (LOB-79), derived from the run's recorded `verify` results
 * — never from prose the model wrote. Attached to the PR's `factory.pr` document and its `prOpened`
 * event, and rendered as the PR body's `## Verification` section.
 */
export const PrEvidence = Schema.Union([EvidenceRecorded, EvidenceNone]);
export type PrEvidence = typeof PrEvidence.Type;

/**
 * How one side of a replay ran its task (LOB-199): what the comparison measures on each session.
 *
 * `model` is the `provider/modelId` the replay's link names for that side — the model the replay
 * ran on, or the one its source recorded (empty when the source recorded none). `outcome` is how the
 * session's first user entry — the task a replay runs — settled: `answered`, `unanswered` with Pi
 * Durable's `reason` (an abort, a failed request), or `open` when it had not settled yet.
 *
 * `turns` counts the assistant entries the log ran itself and `cost` is both its `pi.usage` buckets —
 * the whole log, at the moment the comparison was taken, because spend is not split per submission.
 * A fork's copied prefix is its parent's run, so it is neither: `inherited` names the parent and the
 * assistant entries the copy holds, whose spend is the parent's. That is also where a fork's
 * `outcome` comes from when its task was copied — read off the transcript, as no submission of the
 * fork's placed it.
 */
export const ReplayRun = Schema.Struct({
  session: SessionId,
  model: Schema.String,
  outcome: Schema.Literals(["answered", "unanswered", "open"]),
  reason: Schema.optionalKey(Schema.String),
  turns: Schema.Int,
  cost: Schema.Finite,
  inherited: Schema.optionalKey(
    Schema.Struct({ from: Schema.String, turns: Schema.Int }),
  ),
});
export type ReplayRun = typeof ReplayRun.Type;

/**
 * A replay and its source, compared (LOB-199, part 2 of LOB-39): committed to *both* logs, so either
 * session reports the pairing without the other one being read.
 *
 * `role` is which side this session is; `self` is this session's run and `counterpart` the other's,
 * and `delta` is `self` minus `counterpart`. Both sides are written from one reading, so the source's
 * delta is exactly the replay's with the sign flipped. `at` is when that reading was taken: the
 * moment the replay's task settled.
 */
export const ReplayComparison = Schema.Struct({
  role: Schema.Literals(["source", "replay"]),
  at: Timestamp,
  self: ReplayRun,
  counterpart: ReplayRun,
  delta: Schema.Struct({ turns: Schema.Int, cost: Schema.Finite }),
});
export type ReplayComparison = typeof ReplayComparison.Type;

export const SessionSnapshotFields = {
  session: SessionSummary,
  workspace: SessionWorkspace,
  /**
   * The transcript, oldest first. A live snapshot carries all of it; a historical one carries the
   * newest entries only (LOB-243), so a read of a long session costs what it shows — `earlier` says
   * when there are more.
   */
  entries: Schema.Array(TranscriptEntry),
  /**
   * Present when the transcript holds entries before `entries`: the id of the oldest entry carried,
   * which `readSessionHistory` takes as `before` to return the page before it (LOB-243). Absent
   * means `entries` starts the transcript.
   */
  earlier: Schema.optional(Schema.String),
  live: SessionLive,
  usage: SessionUsage,
  queued: Schema.Array(QueuedMessage),
  tasks: Schema.Array(SessionTask),
  /**
   * The approvals still waiting for a decision, oldest first (LOB-147). Folded from the log, so a
   * snapshot read after its owner was released still reports them; a settled approval is not here.
   */
  approvals: Schema.Array(ApprovalRequest),
  /**
   * The mission this session is running, if it ever started one (LOB-230).
   *
   * Absent means no mission, not an empty phase: a mission that has entered no phase is absent too,
   * because a phase the client cannot read is not a phase it was told about. `taskId` names the
   * mission, and `entered` is every phase it passed through, in order — a mission that settled still
   * reports the phase it reached, because the document it commits outlives the task.
   */
  mission: Schema.optional(MissionSnapshot),
  /**
   * The session's spend ceiling and where it stands (LOB-163). Absent for a session created without
   * a cap. `stopped` is what tells an operator the cap ended a run, rather than a person or an error;
   * the transcript carries the same stop as a `budget` entry.
   */
  budget: Schema.optional(SessionBudget),
  /**
   * Every replay comparison this session's log holds (LOB-199), oldest first: one per replay of it,
   * and one naming its source when it is a replay itself. Absent for a session that was never
   * replayed and is no replay — "no comparison", not an empty one.
   */
  replayComparisons: Schema.optional(Schema.Array(ReplayComparison)),
  /**
   * The child issues the session's newest decomposition proposed from its spec (LOB-201), as the
   * `factory.proposedIssues` document holds them. Absent when the session never decomposed: a
   * proposal set is never empty (`decodeProposedIssues`), so absent and "proposed nothing" cannot be
   * confused. A proposal is not an issue — nothing exists in any tracker until it is approved.
   */
  proposedIssues: Schema.optional(ProposedIssues),
  /**
   * The plan-freshness passes run against this session's spec (LOB-45), oldest first: each proposes
   * issues to add, re-scope or close against the tracker's issue set after a merge, and waits for a
   * person. Absent when no pass ever ran — a pass that found the plan fresh is a revision with no
   * proposals, so absent and "nothing to change" cannot be confused.
   */
  planRevisions: Schema.optional(Schema.Array(PlanRevision)),
} as const;

export const SessionSnapshot = Schema.Struct(SessionSnapshotFields);
export type SessionSnapshot = typeof SessionSnapshot.Type;

/**
 * What a session stream carries, in order and without gaps.
 *
 * `snapshot` is always first, and for a historical session it is the only event: the stream then
 * ends, so a client can tell a completed fold from a dropped connection. A session another process
 * owns streams live from its log (LOB-18), and its stream ends when that ownership does. Entries are append-only
 * (Pi Durable commits the in-flight answer into `pi.live`, not into the transcript), so an
 * `entry` event is never an update to an entry already sent.
 *
 * The snapshot's `session` is the summary at attachment. Later changes to it arrive as events of
 * their own: `status` when the run starts or stops, and a `title` entry (the control plane commits
 * one, D7) when the session is renamed. `tasks` is the live-task list, sent when Pi Durable's task
 * graph changes — on a commit, not on a poll — so a panel of live work settles with the work.
 */
export const SessionEvent = Schema.Union([
  Schema.TaggedStruct("snapshot", SessionSnapshotFields),
  Schema.TaggedStruct("entry", { entry: TranscriptEntry }),
  Schema.TaggedStruct("live", { live: SessionLive }),
  Schema.TaggedStruct("usage", { usage: SessionUsage }),
  Schema.TaggedStruct("status", { status: SessionStatus }),
  Schema.TaggedStruct("queued", { queued: Schema.Array(QueuedMessage) }),
  Schema.TaggedStruct("tasks", { tasks: Schema.Array(SessionTask) }),
  Schema.TaggedStruct("prOpened", {
    prUrl: Schema.String,
    /** What the PR says was verified (LOB-79). Absent on a PR recorded before evidence existed. */
    evidence: Schema.optional(PrEvidence),
  }),
]);
export type SessionEvent = typeof SessionEvent.Type;

/** How a message behaves when the session is already running. Mirrors Pi Durable's `whenBusy`. */
export const WhenBusy = Schema.Literals(["steer", "followUp", "reject"]);
export type WhenBusy = typeof WhenBusy.Type;

/**
 * What happened to a sent message: `run` when it started one, otherwise the queue it joined
 * (`steer` joins the running work after the current tool round, `followUp` starts the next run).
 */
export const MessagePlacement = Schema.Literals(["run", "steer", "followUp"]);
export type MessagePlacement = typeof MessagePlacement.Type;

export const SendMessageResult = Schema.Struct({
  session: SessionSummary,
  submissionId: Schema.String,
  placement: MessagePlacement,
});
export type SendMessageResult = typeof SendMessageResult.Type;

/**
 * What withdrawing a queued message came to (LOB-166). `withdrawn` is the only outcome that changed
 * anything: the message left the queue and will never reach the transcript. `already_placed` means
 * a run took it first, `settled` that it is already over — the log moved before the request did.
 */
export const WithdrawOutcome = Schema.Literals([
  "withdrawn",
  "already_placed",
  "settled",
]);
export type WithdrawOutcome = typeof WithdrawOutcome.Type;

/** Withdraw one queued message, named by the `submissionId` `sendMessage` answered. */
export const WithdrawMessageInput = Schema.Struct({
  sessionId: SessionId,
  submissionId: Schema.String,
});
export type WithdrawMessageInput = typeof WithdrawMessageInput.Type;

export const WithdrawMessageResult = Schema.Struct({
  session: SessionSummary,
  submissionId: Schema.String,
  outcome: WithdrawOutcome,
});
export type WithdrawMessageResult = typeof WithdrawMessageResult.Type;

/**
 * What interrupting a session came to (C8). `interrupted` stopped a run: it settled without an
 * answer, its queued messages were withdrawn, and the turn carries one `interrupted` entry — committed
 * before the abort, so what Pi Durable writes for work the abort stopped mid-way (a tool call's
 * aborted result, a partial answer) follows it. `not_running` means there was no run to stop — the
 * session was already idle — so nothing changed. An outcome in the answer rather than an error, as a withdraw's is: the log moved before
 * the request did, and the caller asked for a state the session is already in.
 */
export const InterruptOutcome = Schema.Literals(["interrupted", "not_running"]);
export type InterruptOutcome = typeof InterruptOutcome.Type;

/**
 * The session as the interrupt left it (`session.status` is the settled status), what the call came
 * to, and the server's sentence for it — what the dashboard's toast and `factory interrupt` print.
 */
export const InterruptSessionResult = Schema.Struct({
  session: SessionSummary,
  outcome: InterruptOutcome,
  message: Schema.String,
});
export type InterruptSessionResult = typeof InterruptSessionResult.Type;

/** Set a session's spend cap (C23): the session, and the ceiling its spend is to be held to. */
export const SetSessionBudgetInput = Schema.Struct({
  sessionId: SessionId,
  budget: SessionBudgetCap,
});
export type SetSessionBudgetInput = typeof SetSessionBudgetInput.Type;

/**
 * What setting a cap came to (C23): the session, its budget as the log now records it (the new cap,
 * the spend it is measured against, and no stop — setting a cap clears the one the old cap made),
 * and the server's sentence for it, which says when the spend already reaches the new cap (a run
 * then stops before its first request, as under any cap that is reached).
 */
export const SetSessionBudgetResult = Schema.Struct({
  session: SessionSummary,
  budget: SessionBudget,
  message: Schema.String,
});
export type SetSessionBudgetResult = typeof SetSessionBudgetResult.Type;

/**
 * The pull request a reviewer run is opened for (LOB-36): the PR by its number and page, the ref it
 * merges into, and the commit under review. The session's worktree is cut at `head` (its `baseRef`),
 * and the `review` tool reviews `base...HEAD` there, so what was reviewed is this value, not a guess.
 */
export const ReviewTargetInput = Schema.Struct({
  number: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
  url: Schema.String,
  base: Schema.NonEmptyString,
  head: Schema.String.pipe(Schema.check(Schema.isPattern(/^[0-9a-f]{40}$/))),
});
export type ReviewTargetInput = typeof ReviewTargetInput.Type;

export const CreateSessionInput = Schema.Struct({
  title: Schema.optional(Schema.String),
  /** Deduplicates a retried create: the same request id returns the same session. */
  requestId: Schema.optional(Schema.String),
  /**
   * The repo the session works on. Absent with a `taskId`, the card's repository, which is its
   * board's (LOB-255); absent without one, a scratch session, which is what tests use.
   */
  repo: Schema.optional(RepoSlug),
  /** The ref the session starts from. Defaults to the repo registry's default base ref. */
  baseRef: Schema.optional(Schema.String),
  /**
   * The branch the session's worktree is cut on. Absent means `factory/<session-id>` (D10); a docs
   * trigger names `factory/doc-<id>` so the branch says what produced it.
   */
  branch: Schema.optional(BranchName),
  /** The task this session runs against. Absent means a scratch session. */
  taskId: Schema.optional(Schema.String),
  /**
   * The column the run starts in, which the card's pinned definition must declare (C22: the run's
   * prompt and autonomy are its). Absent: the card's own column.
   */
  taskColumn: Schema.optional(Schema.String),
  /**
   * The session's spend ceiling, in US dollars (LOB-163). A run stops before the first model request
   * it would send once the session's spend has reached it. Absent: the server's default cap, if it
   * was started with one, and otherwise no cap.
   */
  budget: Schema.optional(SessionBudgetCap),
  /**
   * Who the session's spend is attributed to (LOB-162), as the caller declares it. Over the RPC
   * surface the server records its authenticated `Caller` instead (LOB-20), so this only counts on a
   * control plane running with auth off, or for an in-process caller such as a trigger. Absent there:
   * nobody, which the spend pane shows as unattributed.
   */
  actor: Schema.optional(SessionActor),
  /**
   * The pull request this session reviews (LOB-36). Requires `repo`: the PR is that repo's. The PR's
   * `pull_request` event is what names one (`@repo/core`'s review trigger); absent, the session
   * reviews nothing, and a reviewer run that was not given one is refused its `review` tool's call.
   */
  review: Schema.optional(ReviewTargetInput),
  /**
   * The model the session runs on, `provider/modelId` (LOB-274): one of `getServerInfo.models`. It
   * is pinned into the session's root when the session first opens, ahead of its column's role model
   * (`ROLE_MODELS`) and the deployment's default (`DEFAULT_MODEL`, else the backend's own), so a card
   * run created on a model runs that model whatever its column's role says. A model the server does
   * not serve is refused as `invalid_input` before anything is written. Absent: the role's model,
   * else the deployment's.
   */
  model: Schema.optional(Schema.String),
  /**
   * Open the session's pull request when its run settles with a change (F17, `@repo/core`'s
   * `prOnSettle`). A person's session keeps its PR their call (`factory pr`, "Open pull request");
   * this is how they say at the start that it opens by itself. Recorded in the session's log, so a
   * rebuild keeps it. Requires `repo` and no `taskId`: a scratch session has no PR to open, and a
   * card's run opens its PR by its column. Absent or `false`: nothing changes.
   */
  openPrOnSettle: Schema.optional(Schema.Boolean),
});
export type CreateSessionInput = typeof CreateSessionInput.Type;

/**
 * Register or update a repo so sessions can bind to it. A session that names an unregistered repo
 * still opens: `createSession` registers it with no clone URL, and this is how the URL and the
 * local checkout arrive (a trigger, later, is the other writer — D14 needs the URL to clone).
 *
 * A field left out keeps the row's value, so a second registration that names only a new base ref
 * keeps the checkout. A `localPath` that is named must be absolute and inside a git work tree, or
 * the call is `invalid_input` naming the path and nothing is written (LOB-253).
 */
export const RegisterRepoInput = Schema.Struct({
  repo: RepoSlug,
  url: Schema.optional(Schema.String),
  defaultBaseRef: Schema.optional(Schema.String),
  localPath: Schema.optional(Schema.String),
});
export type RegisterRepoInput = typeof RegisterRepoInput.Type;

/**
 * Clone or fetch a registered repo into the factory's cache now (LOB-265), instead of at the next
 * session: what `factory doctor` runs to say whether a URL-only repo can run. The answer is the
 * row, with its `mirrorPath`.
 */
export const SyncRepoInput = Schema.Struct({ repo: RepoSlug });
export type SyncRepoInput = typeof SyncRepoInput.Type;

/** One row of `listSessions`: what the index remembers without folding a single log (R6). */
export const SessionListEntry = Schema.Struct({
  id: SessionId,
  title: Schema.String,
  repo: Schema.optional(RepoSlug),
  baseRef: Schema.optional(Schema.String),
  status: SessionStatus,
  createdAt: Timestamp,
  lastActivityAt: Timestamp,
  costTotal: Schema.Finite,
  /** The URL of the PR opened for this session, once one exists. */
  prUrl: Schema.optional(Schema.String),
  /**
   * The session this one was forked from, once one was (LOB-180/LOB-182). Read from the index row,
   * which `rebuildIndexes` refolds from the fork's own `factory.fork` document, so the list can show
   * lineage without folding a log (R6).
   */
  forkedFrom: Schema.optional(SessionId),
  /**
   * The model the session is pinned to, `provider/modelId` (LOB-269), from the index row: written
   * when its owner first opens and refolded by `rebuildIndexes` from the log's `pi.agent`, so the
   * list names it without folding a log (R6). Absent for a row nothing has written it on yet.
   */
  model: Schema.optional(Schema.String),
  /** Whether this process serves `model` (E9); see `SessionSummary.modelAvailable`. */
  modelAvailable: Schema.optional(Schema.Boolean),
});
export type SessionListEntry = typeof SessionListEntry.Type;

export const ListSessionsInput = Schema.Struct({
  /** Page size. The server clamps it. */
  limit: Schema.optional(Schema.Int),
  /** Opaque keyset cursor from a previous page's `nextCursor`. */
  cursor: Schema.optional(Schema.String),
  /**
   * Only the runs of this card (C7b): the sessions `task_runs` binds to it, however many sessions
   * the index holds, so a card's run rows are not limited to the newest page of every session.
   */
  taskId: Schema.optional(Schema.String),
  /**
   * Only this session (C7b): one index row, read without folding its log — what the "Open pull
   * request" control watches to tell that a session has moved on since it was refused.
   */
  sessionId: Schema.optional(SessionId),
});
export type ListSessionsInput = typeof ListSessionsInput.Type;

export const ListSessionsOutput = Schema.Struct({
  /** Newest activity first. */
  sessions: Schema.Array(SessionListEntry),
  nextCursor: Schema.optional(Schema.String),
});
export type ListSessionsOutput = typeof ListSessionsOutput.Type;

/** What `listSpend` reads (LOB-162): everything the index holds, for now — no window, no filter. */
export const ListSpendInput = Schema.Struct({});
export type ListSpendInput = typeof ListSpendInput.Type;

/**
 * One (repo, actor) pair's spend: how many sessions it holds and what they cost, in the dollars
 * `pi.usage` reports. The cost is the list's own `costTotal` summed, so the spend pane and the
 * session list cannot disagree. `repo` is absent for scratch sessions, and `actor` is absent for
 * sessions nobody was attributed (every session created before LOB-162, or a caller that named
 * nobody).
 */
export const SpendRow = Schema.Struct({
  repo: Schema.optional(RepoSlug),
  actor: Schema.optional(SessionActor),
  sessions: Schema.Int,
  costTotal: Schema.Finite,
});
export type SpendRow = typeof SpendRow.Type;

/**
 * Spend keyed by repo and actor (LOB-162): one row per pair, costliest first (then by repo, then by
 * actor, absent last), and the totals across all of them. The pairs are the finest grain the server
 * answers; a roll-up by repo or by actor alone is a sum the reader does, because every pair is here.
 */
export const SpendReport = Schema.Struct({
  rows: Schema.Array(SpendRow),
  sessions: Schema.Int,
  costTotal: Schema.Finite,
});
export type SpendReport = typeof SpendReport.Type;

export const SendMessageInput = Schema.Struct({
  sessionId: SessionId,
  content: Schema.String,
  whenBusy: Schema.optional(WhenBusy),
  /** Deduplicates a retried send: the same request id admits one submission. */
  requestId: Schema.optional(Schema.String),
});
export type SendMessageInput = typeof SendMessageInput.Type;

export const SessionIdInput = Schema.Struct({ sessionId: SessionId });
export type SessionIdInput = typeof SessionIdInput.Type;

/**
 * Page back through a session's transcript (LOB-243): the entries before entry `before`, newest
 * `limit` of them (200 when absent, at most 500), oldest first. `before` is a snapshot's `earlier`
 * or a previous page's.
 */
export const ReadSessionHistoryInput = Schema.Struct({
  sessionId: SessionId,
  before: Schema.String,
  limit: Schema.optional(Schema.Int),
});
export type ReadSessionHistoryInput = typeof ReadSessionHistoryInput.Type;

/** One page of earlier transcript, and where the page before it starts (`earlier`, as on a snapshot). */
export const SessionHistoryPage = Schema.Struct({
  entries: Schema.Array(TranscriptEntry),
  earlier: Schema.optional(Schema.String),
});
export type SessionHistoryPage = typeof SessionHistoryPage.Type;

/**
 * Replay a recorded session against another model (LOB-198).
 *
 * A replay is the same task in a new session: the source's first user entry becomes this session's,
 * run on `model` (a `provider/modelId` name) at the source's repo and base ref. The source's recorded
 * run is only read, so its transcript is unchanged; the link between the two is a `factory.replay`
 * document in the replay's own log. Once the replay's task settles, both logs gain the comparison
 * (`ReplayComparison`, LOB-199) — the one thing a replay ever adds to its source.
 *
 * `model` absent means the control plane's own model, which is a replay that records the lineage
 * without changing the model — the same task, the same model, a new log. A name the process's model
 * catalog does not hold is refused as `invalid_input` rather than substituted.
 */
export const ReplaySessionInput = Schema.Struct({
  sessionId: SessionId,
  model: Schema.optional(Schema.String),
});
export type ReplaySessionInput = typeof ReplaySessionInput.Type;

/**
 * Fork a session at one of its entries (LOB-180, D7).
 *
 * `at` is the id of a transcript entry — the `id` a `TranscriptEntry` carries — and the fork keeps
 * the parent's entries through it. Absent, the fork is taken at the parent's last entry.
 *
 * An id that names no entry of *this* session is refused as `invalid_input`: no such history exists
 * to fork. Entry ids are minted per log, so an id read out of another session is indistinguishable
 * from this session's entry of the same number when both exist — the fork then takes this session's
 * entry, which is the only thing that number can mean here. Making an entry id unique across
 * sessions is a change to every client's view of a transcript, not something a fork can decide.
 */
export const ForkSessionInput = Schema.Struct({
  sessionId: SessionId,
  at: Schema.optional(Schema.String),
});
export type ForkSessionInput = typeof ForkSessionInput.Type;

/**
 * Start a new model context for a session (LOB-181).
 *
 * `handoff` is what the fresh context opens with, as its first user message; absent or empty means
 * the context starts from nothing. The transcript keeps everything before the reset and marks where
 * it happened, so a handoff note is a summary the reader can check against the turns above it.
 */
export const ResetSessionInput = Schema.Struct({
  sessionId: SessionId,
  handoff: Schema.optional(Schema.String),
});
export type ResetSessionInput = typeof ResetSessionInput.Type;

/**
 * Compact a session's model context on demand (B4).
 *
 * `instructions` is what the summarizer should focus on, when the caller has a reason to steer it.
 * The compaction is a task in the log: this call admits it and answers the task's id, and the
 * summary arrives as a `compaction` entry when the task settles, so a caller watches the
 * transcript rather than waiting on this call. Nothing is dropped: entries before the summary
 * stay in the transcript, which is what makes the summary checkable.
 */
export const CompactSessionInput = Schema.Struct({
  sessionId: SessionId,
  instructions: Schema.optional(Schema.String),
});
export type CompactSessionInput = typeof CompactSessionInput.Type;

/** The admitted compaction task, and the session it belongs to. */
export const CompactSessionResult = Schema.Struct({
  session: SessionSummary,
  /** Opaque, like a submission id; the log's own numbering is not the wire contract. */
  taskId: Schema.String,
});
export type CompactSessionResult = typeof CompactSessionResult.Type;

/**
 * A session request that cannot be served. `code` is the part callers branch on.
 *
 * - `not_found` — no such session, or no such message in it to withdraw.
 * - `busy` — the session is running and the caller asked for `whenBusy: "reject"`.
 * - `invalid_input` — the request was well-formed but refused: a message over the length cap, a
 *   malformed repo slug, an unreadable list cursor.
 * - `storage` — the log could not be read or appended.
 * - `harness` — Pi Durable rejected the operation (bad input, closed harness, failed submit).
 * - `repo_clone_failed` — a session's worktree could not be cut because the factory's clone of its
 *   repo could not be made or brought up to date (LOB-265); the message names the repo and the reason.
 * - `owned_elsewhere` — the request needs the session's owner, and another process holds it (its
 *   presence lease is live, LOB-18): the session reads and streams from anywhere, but work on it is
 *   taken where it is owned, or once that lease lapses. The message names the holder.
 * - `at_capacity` — admission control (LOB-70): the request would open one more session than the
 *   server runs at once, so nothing was written and nothing opened. The message names the cap and
 *   where it is configured (`SESSION_MAX_CONCURRENT`). Transient: the same request succeeds once a
 *   session is released (the idle sweep), and a retried create with the same `requestId` is a fresh
 *   attempt, because the refused one left no row behind. A card's start is refused the same way past
 *   one of its board definition's run caps (B9, LOB-71): the message names the cap, the board, task,
 *   repository or column it counts, and the definition version it is configured in, and `cap` says
 *   which it was.
 * - `budget_exceeded` — an aggregate spend cap (S-aggregate-spend-caps): the spend already recorded
 *   for the request's repository, or for the actor making it, reaches the cap configured for the
 *   current UTC day or month (`SPEND_CAPS`), so a new run on it is refused before anything is
 *   written or any model is called. `spendCap` names the cap, the scope it counted, the window, the
 *   limit, the spend and where the limit is configured. Not transient in the way `at_capacity` is:
 *   the same request succeeds once the window rolls over or the cap is raised, and runs on any other
 *   repository or by any other actor are unaffected. Distinct from a session's own budget (C23), which
 *   stops a run already under way.
 * - `setup_failed` — the session's worktree setup failed before the agent's first turn
 *   (S-env-setup): the repo's declared `install` or `build` exited non-zero or could not run, so the
 *   message was not submitted and no model was called. The message names the step, the command, its
 *   exit code and its output's last lines; the whole tail is the log's `factory.setup` document, and
 *   a session that is a card's run blocked the card `setup_failed` and ended. The next send to a
 *   session that is no card's run runs the setup again; one to a card's run whose setup failed is
 *   refused the same way without running it, because that run has ended: fix the repo, unblock the
 *   card and start a new run.
 * - `setup_running` — the session's worktree setup is still running after the send waited the time
 *   it waits for one (S-env-setup), so nothing was submitted. Transient: the setup goes on without
 *   the request, and the same send again waits for that setup rather than starting another.
 * - `policy_rejected` — the repository's `.factory/config` at the session's base declares a policy
 *   that cannot be loaded (S-factory-config-as-code, `RepoPolicyRejected`): not JSON, not the
 *   policy's shape, or allowing something the deployment denies. Nothing ran; the message names the
 *   repo, the base, the commit and each problem. Fix the config on the base and try again.
 * - `policy_unreadable` — git could not read the repository's `.factory/config` at the session's
 *   base (S-factory-config-as-code, `RepoPolicyUnavailable`): the lookup or read failed or timed out
 *   rather than answering, so the policy is unknown and nothing ran. Transient: not a fault in the
 *   config, and the same request succeeds once git can read the base again.
 * - `model_unavailable` — the session is pinned to a model this process does not serve (E9): it
 *   was created under another backend (a faux session after the API switched to anthropic), and a
 *   pin never changes. The message names the model; no run was started and nothing was written. The
 *   fix is a replay onto a model this process serves (`replaySession`), not a retry.
 */
export const SessionErrorCode = Schema.Literals([
  "not_found",
  "busy",
  "invalid_input",
  "storage",
  "harness",
  "repo_clone_failed",
  "owned_elsewhere",
  "at_capacity",
  "budget_exceeded",
  "setup_failed",
  "setup_running",
  "policy_rejected",
  "policy_unreadable",
  "model_unavailable",
]);
export type SessionErrorCode = typeof SessionErrorCode.Type;

/**
 * Which cap an `at_capacity` refusal hit (LOB-70, LOB-71): the server's own (`SESSION_MAX_CONCURRENT`)
 * or one of a board definition's run caps (B9) — runs in flight on one board, on one task, in one
 * repository, or started in one column.
 */
export const CapacityCapKind = Schema.Literals([
  "server",
  "board",
  "task",
  "repo",
  "column",
]);
export type CapacityCapKind = typeof CapacityCapKind.Type;

/**
 * The cap an `at_capacity` refusal names, typed: its kind, its limit, where an operator changes it
 * (`source`: a configuration key, or a definition version's field), and the board, task, repository
 * or column it counted (`scope`; absent for the server's cap, which counts the whole process).
 */
export const CapacityCap = Schema.Struct({
  kind: CapacityCapKind,
  limit: Schema.Int,
  source: Schema.String,
  scope: Schema.optional(Schema.String),
});
export type CapacityCap = typeof CapacityCap.Type;

/** What an aggregate spend cap counts: one repository's spend, or one actor's. */
export const SpendCapScope = Schema.Literals(["repo", "actor"]);
export type SpendCapScope = typeof SpendCapScope.Type;

/** The window a spend cap counts over: the current UTC day or the current UTC month. */
export const SpendCapWindow = Schema.Literals(["day", "month"]);
export type SpendCapWindow = typeof SpendCapWindow.Type;

/**
 * The cap a `budget_exceeded` refusal names, typed (S-aggregate-spend-caps): what it counted (`scope`
 * of `subject`, the repository slug or the actor), over which `window`, the `limit` in US dollars,
 * the `spent` that reaches it, where an operator changes it (`source`, the configuration key and the
 * entry), and when the window ends and the request would be let through (`resetsAt`, and the
 * `retryAfterSeconds` to it from the refusal, which a webhook's `Retry-After` is).
 */
export const SpendCap = Schema.Struct({
  scope: SpendCapScope,
  subject: Schema.String,
  window: SpendCapWindow,
  limit: Schema.Finite,
  spent: Schema.Finite,
  source: Schema.String,
  resetsAt: Timestamp,
  retryAfterSeconds: Schema.Int,
});
export type SpendCap = typeof SpendCap.Type;

export class SessionError extends Schema.TaggedError<SessionError>()(
  "SessionError",
  {
    code: SessionErrorCode,
    message: Schema.String,
    /** Set on an `at_capacity` refusal only: the cap that was hit (LOB-70, LOB-71). */
    cap: Schema.optional(CapacityCap),
    /** Set on a `budget_exceeded` refusal only: the aggregate spend cap that was reached. */
    spendCap: Schema.optional(SpendCap),
  },
) {}
