/**
 * Typed session documents: state that is not the transcript, committed atomically with it
 * (LOB-23). Each is a `defineDoc` token so reads and writes go through the typed surface
 * instead of raw string kinds.
 */
import type { JsonValue } from "@earendil-works/chord";
import type { TaskId } from "@earendil-works/pi-durable";
import { defineDoc, defineDocFamily } from "@earendil-works/pi-durable";
import { MERGE_DOC_KIND, REPLAY_DOC_KIND } from "./projection";

export const SPEC_DOC_KIND = "factory.spec";
export const PLAN_DOC_KIND = "factory.plan";
export const CRITERIA_DOC_KIND = "factory.criteria";
export const PR_DOC_KIND = "factory.pr";
export const RETRY_DOC_KIND = "factory.retry";
export const PAGE_DOC_KIND = "factory.page";
export const PAGE_PROMPT_DOC_KIND = "factory.pages.prompt";
export const MISSION_DOC_KIND = "factory.mission";
export const MISSION_BINDING_DOC_KIND = "factory.mission.binding";
export const PROPOSED_ISSUES_DOC_KIND = "factory.proposedIssues";
export const REVIEW_DOC_KIND = "factory.review";
export const APPROVALS_DOC_KIND = "factory.approvals";
export const PLAN_REVISIONS_DOC_KIND = "factory.planRevisions";
export const SKILLS_DOC_KIND = "factory.skills";
export const REPO_PROMPT_DOC_KIND = "factory.repo.prompt";

/** What `SpecDoc` holds before anything was written, and what a version-1 value migrates to. */
const unspecified = () => ({
  goal: "",
  acceptance: [] as string[],
  gaps: [] as string[],
  openQuestions: [] as string[],
});

/**
 * The specifying stage's artifact (LOB-72): goal, acceptance criteria, declared gaps and open
 * questions. The shape and its rule — `gaps` declared, `[]` when there are none — are `./spec`'s;
 * this token is only where the value is stored, and its two writers — `writeSpec` and a specifying
 * run's `spec` tool (LOB-238, `./specify`) — both decode with `decodeSpec` and commit through
 * `commitSpec`, so nothing reaches it without passing that rule.
 *
 * The seed is not a spec: its `goal` is empty, which the validator refuses, so a session that never
 * specified reads as no spec rather than as one declaring no gaps.
 *
 * Version 2 because version 1 was a single `spec` string that nothing ever wrote. A version-1 value
 * would still have to migrate somewhere, and it migrates to the seed rather than to a spec: it holds
 * no gaps, and turning that into `gaps: []` would record "no gaps" for a specifier that declared none
 * — the one answer this document exists to refuse.
 */
export const SpecDoc = defineDoc({
  kind: SPEC_DOC_KIND,
  version: 2,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: unspecified,
  migrate: unspecified,
});

/** What `PlanDoc` holds before anything was written: no steps, which the validator refuses. */
const unplanned = () => ({
  summary: "",
  steps: [] as string[],
  surfaces: [] as string[],
  risks: [] as string[],
});

/**
 * The planning stage's artifact (D10): summary, steps, surfaces and declared risks. The shape and its
 * rule — at least one step and one surface, `risks` declared (`[]` when there are none) — are
 * `./plan`'s; this token is only where the value is stored, and its one writer, a planning run's
 * `plan` tool (`./planning`), decodes with `decodePlan` before it commits.
 *
 * The seed is not a plan: it has no steps, which the validator refuses, so a session that never
 * planned reads as no plan rather than as one declaring no risks.
 */
export const PlanDoc = defineDoc({
  kind: PLAN_DOC_KIND,
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: unplanned,
});

/**
 * Legacy: a free-text criteria string that nothing writes. `SpecDoc`'s `acceptance` is the source of
 * truth for a session's acceptance criteria (LOB-72); write criteria there, never here. Kept only so
 * `readSessionLog` still folds a log that happens to hold one.
 */
export const CriteriaDoc = defineDoc({
  kind: CRITERIA_DOC_KIND,
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({ criteria: "" }),
});

/**
 * The PR a session opened (LOB-177), and since LOB-79 the evidence its body states: the encoded
 * `PrEvidence` the body's `## Verification` section was rendered from, so a later reader (a column's
 * `requires[]` check, LOB-80) reads the same verdict the reviewer did. `null` in the seed and in a
 * document written before evidence existed; readers decode it and treat anything else as absent,
 * which is why adding it needs no version bump. `commit` (C19) is the same kind of addition: the
 * commit the PR's head was published at when this session recorded it, `""` in the seed and in a
 * document written before it existed, which a reader treats as unknown.
 */
export const PrDoc = defineDoc({
  kind: PR_DOC_KIND,
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({
    url: "",
    number: 0,
    base: "",
    head: "",
    openedAt: "",
    evidence: null as JsonValue,
    commit: "",
  }),
});

/**
 * The merge of the session's PR, and its revert (LOB-44): written by the GitHub webhook when the PR
 * it recorded in `factory.pr` merges, and again when a merged PR's body says it reverts that one
 * (`Reverts owner/repo#N`, what GitHub's revert button writes). The first merge and the first revert
 * stand: a redelivered event rewrites nothing. A fork never takes it — a fork copies entries and
 * writes its own lineage, so the merge stays the session's whose PR it was.
 *
 * `rebuildIndexes` folds it into `sessions.pr_merged_at` and `pr_reverted_at`, which is where the
 * outcome metrics read delegation-to-merge lead time, recovery and defect pressure from.
 */
export const MergeDoc = defineDoc({
  kind: MERGE_DOC_KIND,
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({
    url: "",
    number: 0,
    mergedAt: "",
    commit: "",
    revertedBy: "",
    revertedAt: "",
  }),
});

export const RetryDoc = defineDoc({
  kind: RETRY_DOC_KIND,
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({ count: 0 }),
});

/**
 * A cited knowledge page (LOB-204, part 1 of LOB-47), keyed by the page's name.
 *
 * A family rather than a singleton because a session teaches more than one page, and each page is
 * its own record: a later commit rewrites the member it names and leaves its siblings alone. The
 * seed is the key, so a member that has never been written reads as an empty page of that name
 * rather than as a page with no name.
 */
export const PageDoc = defineDocFamily({
  kind: PAGE_DOC_KIND,
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  family: true,
  initial: (name: string) => ({
    name,
    kind: "",
    content: "",
    links: [] as string[],
    sources: [] as string[],
  }),
});

/**
 * What the session's `pages` section came to when the session opened (LOB-205, part 2 of LOB-47).
 *
 * The section itself is prompt text (`./pages`), and prompt text is not a fact anyone can audit: it
 * is rendered, sent, and gone. This document is the record beside it — how many pages the session
 * held, which of them the budget carried, which it left out, and what the rendered section cost — so
 * "what did this run receive" is a read rather than a reconstruction. Every open rewrites it, a
 * session that has pages no longer included included as `held` with nothing carried, so the latest
 * answer is never a stale one.
 *
 * `included` and `dropped` are the names, not the bodies: a page's content is already in this log
 * (`PageDoc`), and copying it here would be a second copy a rebuild could leave disagreeing with
 * the first. `cap` is the sentinel: it is the budget the record was assembled under, so a seed
 * (`0`) says the session has never been opened with this harness.
 */
export const PagePromptDoc = defineDoc({
  kind: PAGE_PROMPT_DOC_KIND,
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({
    cap: 0,
    tokens: 0,
    held: 0,
    included: [] as string[],
    dropped: [] as string[],
  }),
});

/**
 * The skill versions a run was given (D7, docs/board.md B2): one `{ name, version }` per skill its
 * column binds, in the column's order, written by the open that first resolved them.
 *
 * This is what makes "in-flight runs keep the version they opened with" hold across a reopen. The
 * skills table keeps every version (`0037_version_skills.ts`), and the control plane reads this
 * document before it resolves the run's prompt (`loadRun`'s `pinned`), so a run opened on
 * `specify@1` is told version 1 again after an operator put version 2 — and a new run is told 2.
 * Pins only accumulate: a skill pinned once keeps its version for the life of the log, and an open
 * adds a pin only for a skill the log had not pinned yet.
 *
 * `fork: "current"`, so a fork carries its parent's pins and continues on the bodies its transcript
 * was written under. A log written before this document existed holds the seed (`skills: []`) and
 * is pinned to the newest versions the first time it is opened.
 */
export const SkillPinsDoc = defineDoc({
  kind: SKILLS_DOC_KIND,
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({
    skills: [] as Array<{ name: string; version: number }>,
  }),
});

/**
 * What the repository told the session's last open (S-repo-instructions-and-skills, `./repoContext`):
 * the ref and commit its `AGENTS.md` and skills were read at, the instructions' size in bytes and in
 * prompt tokens (and whether the cap cut them), and the skills the index listed, dropped for the
 * budget, or left to the column's own skill of the same name.
 *
 * Written by every open of a session on a repository checkout, in the open's one commit, so "what did
 * this run's repo tell it, and what did that cost" is a read rather than a reconstruction; a
 * scratch session, which has no repository, never writes it. An open that reads nothing after one
 * that recorded something (a released workspace, a base that no longer resolves, a git read that
 * timed out) resets it to the seed, so the record never names sections its prompt does not carry. `instructions` is `null` for a repo with
 * no `AGENTS.md`, which is the record of the absence. `skills.cap` is the sentinel: the seed's `0`
 * says no open recorded one.
 */
export const RepoPromptDoc = defineDoc({
  kind: REPO_PROMPT_DOC_KIND,
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({
    ref: "",
    commit: "",
    instructions: null as {
      path: string;
      bytes: number;
      tokens: number;
      cap: number;
      truncated: boolean;
    } | null,
    skills: {
      tokens: 0,
      cap: 0,
      listed: [] as Array<{ name: string; path: string }>,
      dropped: [] as string[],
      shadowed: [] as string[],
    },
  }),
});

/**
 * The phase a mission reached (LOB-229), keyed by the mission's task id.
 *
 * A conversation family rather than one document per conversation, because a conversation holds more
 * than one mission: a single conversation-scoped document would interleave two missions' phases into
 * one list, and a mission that never ran would read the previous one's phase back as its own.
 *
 * A conversation family rather than a `scope: "task"` document, because Pi Durable retires every
 * task document when its task reaches a terminal state (`transaction.js`, "Terminal settlement
 * retires every task document"). The phase record is exactly what has to survive the mission
 * finishing: a reopen reads it after the mission is terminal, which is when a task document is gone.
 *
 * `phase` is the phase the mission is in, which is what a resume reads. `entered` is every phase it
 * has entered, in order, because a conversation document keeps only its latest value: without the
 * list the log would name the phase the mission stopped in and say nothing about how it got there.
 * Re-entering the phase the mission is already in appends nothing, so a resumed phase is one entry,
 * not two. `mission` is the key, so a member names the mission it belongs to.
 *
 * `definitionVersion` is the version of `mission.ts` that named the phase, because a stored document
 * is read back through the definition that wrote it: a version-1 document names the phase one
 * behind its checkpoint, and `readMissionDoc` (`@repo/domain/Mission`) reads it forward (LOB-233).
 * The value's shape did not change with it, so this document's own `version` did not either.
 *
 * Empty `phase` is "this mission has not entered a phase yet", which is what the seed says; the seed
 * cannot say `plan`, because a mission that never ran never planned anything.
 *
 * `workers` is the roster a fan-out writes (LOB-194): per worker, its id, its task and the
 * conversation its first commit created, which is how a read finds the ledger a worker's spend is
 * in. The seed has none and a mission that fanned out to none never writes one, so — like
 * `factory.pr`'s `evidence` — a document written before the field existed reads as an empty roster
 * and its version did not change. Each entry is written in the commit that creates what it names; a
 * worker only fills in an entry that exists, so a mission that fanned out before the roster stays at
 * no workers instead of listing the ones that opened after an upgrade.
 */
export const MissionDoc = defineDocFamily({
  kind: MISSION_DOC_KIND,
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  family: true,
  initial: (
    mission: string,
  ): {
    mission: string;
    phase: string;
    definitionVersion: number;
    entered: string[];
    workers?: { id: string; taskId: string; conversationId: string }[];
  } => ({
    mission,
    phase: "",
    definitionVersion: 0,
    entered: [] as string[],
  }),
});

/**
 * The key a mission's own documents are filed under: its task id. One conversation holds several
 * missions, so each one's phase record is its own.
 */
export const missionKey = (taskId: TaskId): string => String(taskId);

/**
 * The mission this session is running (LOB-230), keyed by nothing: one conversation has one current
 * mission, and starting another rebinds this document rather than appending a second one.
 *
 * The phase is not stored here. It is the mission's own document (`MissionDoc`) that records it, and
 * this document only names *which* mission to read, so the phase has one source of truth: a phase
 * written here as well would be a second copy that a failed commit could leave disagreeing with the
 * checkpoint the mission actually resumed from.
 *
 * A document rather than a field on the session's binding (`factory.session`), because a mission is
 * started after the session is and a rebind is its own commit: rewriting the repo binding every time
 * a mission starts would make a session's repo look like it changed.
 *
 * `taskId` empty is "this session never started a mission", which is what the seed says and what the
 * snapshot reports as no mission at all.
 *
 * `fork` says what a fork would take of it, and the answer for this control plane is nothing: a fork
 * is a new log whose *entries* are copied (`copyEntries` in `session.ts`), and the only documents it
 * writes are its own lineage and repo binding. So a forked session reports no mission, which is what
 * it should report — its task list is empty and nothing in it ever ran — and it does not need this
 * declaration to be `"initial"` to say so. It is `"current"`, matching the mission's own document.
 */
export const MissionBindingDoc = defineDoc({
  kind: MISSION_BINDING_DOC_KIND,
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({ taskId: "" }),
});

/**
 * The link between a replay and the session it replays (LOB-198), and the comparison of the two
 * runs once the replay's task settles (LOB-199).
 *
 * On the replay's log: `source` is the session the prompt came from; `replay` is this log's own
 * session id, which the control plane mints before the log exists — so the pair is named by one
 * document in one place. `from` is the model the source's log records (empty when it recorded none)
 * and `model` is the one this replay ran on, which is what makes "the same task, a different model"
 * checkable from the log rather than from the call that asked for it.
 *
 * On both logs: `comparisons` holds the encoded `ReplayComparison`s (`@repo/domain/Session`), keyed by
 * the counterpart's session id, so a source replayed three times carries three and recording one
 * again rewrites it rather than adding a fourth. A source's document carries only these: its link
 * fields stay empty, so it never reads as a replay. A document written before comparisons existed
 * holds none, and its readers project it that way, which is why adding the field needs no version
 * bump (as `factory.pr` added `evidence`).
 */
export const ReplayDoc = defineDoc({
  kind: REPLAY_DOC_KIND,
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({
    source: "",
    replay: "",
    model: "",
    from: "",
    comparisons: {} as { [counterpart: string]: JsonValue },
  }),
});

/** One stored proposal: `ProposedIssue` (`@repo/domain/Decomposition`) as a mutable document value. */
export type StoredProposal = {
  title: string;
  goal: string;
  change: string;
  acceptance: string[];
  blockedBy: number[];
  /** Set by `recordCreatedIssue` (LOB-202) once the tracker has created the proposal. */
  created?: { id: string; identifier: string };
};

/** A stored proposal a later decomposition dropped (LOB-203): `RemovedProposal`, mutable. */
export type StoredRemoved = {
  title: string;
  goal: string;
  change: string;
  acceptance: string[];
  created?: { id: string; identifier: string };
};

/** The document's value. `removed` is absent until a decomposition has removed something. */
type StoredProposedIssues = {
  proposals: StoredProposal[];
  removed?: StoredRemoved[];
};

/**
 * The child issues a decomposition proposed from this session's spec (LOB-201, part 1 of LOB-43).
 *
 * The shape and its rules are `@repo/domain/Decomposition`'s; this token is only where the value is
 * stored. Its one writer, `commitProposedIssues` (`./decompose`), takes a value `decodeProposedIssues`
 * already accepted, and the snapshot reads it back through the same decoder, so a set the rules
 * refuse is never stored and never reported.
 *
 * `history: "latest"` because a decomposition reconciles into the one before it (LOB-203) and the
 * document is the current answer: the proposals are a draft a person reviews, not an append-only
 * record, and the ones a rerun dropped sit in `removed` with their tracker issues. The seed holds no proposals, which the
 * validator refuses, so a session that never decomposed reads as none rather than as an empty set.
 */
export const ProposedIssuesDoc = defineDoc({
  kind: PROPOSED_ISSUES_DOC_KIND,
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: (): StoredProposedIssues => ({ proposals: [] }),
});

/**
 * The plan-freshness passes run against this session's spec (LOB-45, `./planFreshness`), oldest
 * first: each a `PlanRevision` (`@repo/domain/PlanFreshness`) as JSON, keyed by the merge it answers.
 *
 * On the **spec's** session, because the spec is what a revision is derived from: the session that
 * holds the goal of record is the one that lists the proposals against it. One document rather than
 * a family because the snapshot lists every revision in one read, and a revision is small — the
 * proposals, and the issue set it was shown. `history: "latest"` and bounded (`MAX_PLAN_REVISIONS`):
 * the newest answer to each merge is the record, and the oldest ones age out. The seed holds none,
 * which the snapshot reports as absent.
 */
export const PlanRevisionsDoc = defineDoc({
  kind: PLAN_REVISIONS_DOC_KIND,
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({ revisions: [] as JsonValue[] }),
});

/**
 * A reviewer run's pull request and its verdict (LOB-36, `./review`).
 *
 * Two writers, in order. The control plane writes the **target** when it creates the run — the PR
 * (`repo`, `number`, `url`), the ref it merges into (`base`) and the commit under review (`head`) — so
 * what the run reviews is a fact in its log before the model says anything. The `review` tool writes
 * the **verdict**: the call that made it (`callId`), `pass` or `fail`, the summary, the four dimensions
 * as the tool's own encoding, and where the call left the PR (`outcome`: `unposted` until the post
 * answers, then `clean`, `posted` with the comment's link, `stale` with the head the PR moved to, or
 * `withheld` with why this deployment can never post it).
 *
 * An empty `head` is "this run was opened for no pull request", and an empty `verdict` is "not reviewed
 * yet", which is what the seed says for both.
 */
export const ReviewDoc = defineDoc({
  kind: REVIEW_DOC_KIND,
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({
    repo: "",
    number: 0,
    url: "",
    base: "",
    head: "",
    callId: "",
    verdict: "",
    summary: "",
    dimensions: null as JsonValue,
    outcome: "",
    outcomeDetail: "",
  }),
});

/** One approval entry as the ledger keeps it: the two fields `projectApprovals` reads. */
type LedgerEntry = { kind: string; data: JsonValue };

/**
 * A conversation's approval ledger (LOB-243): a copy of every `factory.approval.*` entry it holds,
 * oldest first, kind and data only, committed in the same commit as the entry it copies.
 *
 * It exists so a historical read can report pending approvals without walking the transcript: the
 * approvals a snapshot reports are folded from the whole log (LOB-147), and before the ledger that
 * meant every entry of it. `projectApprovals` folds the ledger's entries exactly as it folds the
 * transcript's, so the two cannot disagree on what a request id came to; the ledger is bounded by
 * the approvals the session asked for, not by the length of its log.
 *
 * `seeded` is the promise that the ledger is complete through entry `through`. The seed says
 * `false`, and the one helper that opens the ledger for writing (`approvalLedger`) copies every
 * approval entry the conversation already holds before it sets it — a log written before the
 * ledger existed is seeded once, the first time it is opened or asked for an approval — so a
 * reader trusts a ledger only when it says `true` and folds the transcript otherwise.
 *
 * `through` is the newest entry id the ledger has accounted for. It is what keeps the ledger honest
 * against a writer that does not know it — a build from before LOB-243 appending approval entries
 * to a log this build seeded (a rollback, a mixed-version deploy, worktrees on different commits
 * sharing one database): the next approval write catches the ledger up from `through`, and a
 * historical read that finds an approval entry newer than `through` among the entries it already
 * read folds the transcript instead of the ledger. What neither sees is such an entry older than a
 * read's window and newer than the ledger's last write; it reads as missing until this build next
 * writes an approval in that log (design.md R6).
 */
export const ApprovalsDoc = defineDoc({
  kind: APPROVALS_DOC_KIND,
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({
    seeded: false as boolean,
    through: 0,
    entries: [] as LedgerEntry[],
  }),
});
