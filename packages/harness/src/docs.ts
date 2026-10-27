/**
 * Typed session documents: state that is not the transcript, committed atomically with it
 * (LOB-23). Each is a `defineDoc` token so reads and writes go through the typed surface
 * instead of raw string kinds.
 */
import type { JsonValue } from "@earendil-works/chord";
import { defineDoc, defineDocFamily } from "@earendil-works/pi-durable";
import { REPLAY_DOC_KIND } from "./projection";

export const SPEC_DOC_KIND = "factory.spec";
export const CRITERIA_DOC_KIND = "factory.criteria";
export const PR_DOC_KIND = "factory.pr";
export const RETRY_DOC_KIND = "factory.retry";
export const PAGE_DOC_KIND = "factory.page";
export const PAGE_PROMPT_DOC_KIND = "factory.pages.prompt";
export const MISSION_DOC_KIND = "factory.mission";
export const MISSION_BINDING_DOC_KIND = "factory.mission.binding";
export const PROPOSED_ISSUES_DOC_KIND = "factory.proposedIssues";

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
 * which is why adding it needs no version bump.
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
 */
export const MissionDoc = defineDocFamily({
  kind: MISSION_DOC_KIND,
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  family: true,
  initial: (mission: string) => ({
    mission,
    phase: "",
    definitionVersion: 0,
    entered: [] as string[],
  }),
});

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
type StoredProposal = {
  title: string;
  goal: string;
  change: string;
  acceptance: string[];
  blockedBy: number[];
};

/**
 * The child issues a decomposition proposed from this session's spec (LOB-201, part 1 of LOB-43).
 *
 * The shape and its rules are `@repo/domain/Decomposition`'s; this token is only where the value is
 * stored. Its one writer, `commitProposedIssues` (`./decompose`), takes a value `decodeProposedIssues`
 * already accepted, and the snapshot reads it back through the same decoder, so a set the rules
 * refuse is never stored and never reported.
 *
 * `history: "latest"` because a decomposition replaces the one before it: the proposals are a
 * draft a person reviews, not an append-only record. The seed holds no proposals, which the
 * validator refuses, so a session that never decomposed reads as none rather than as an empty set.
 */
export const ProposedIssuesDoc = defineDoc({
  kind: PROPOSED_ISSUES_DOC_KIND,
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({ proposals: [] as StoredProposal[] }),
});
