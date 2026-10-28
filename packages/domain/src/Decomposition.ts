/**
 * Spec → tickets, part 1 (LOB-201, part 1 of LOB-43): the proposed child issues a decomposition
 * run commits, and the validation that decides what may be committed.
 *
 * A decomposition reads a session's spec (`factory.spec`, LOB-72) and proposes child issues — title,
 * goal, change, acceptance lines, and the `blockedBy` edges where the order is real. This module is
 * the contract and nothing else: the shape, the rules, and the refusal. The model call and the
 * commit are the harness's (`packages/harness/src/decompose.ts`), the RPC is `SessionRpc`'s
 * `proposeDecomposition`, and the stored token is `ProposedIssuesDoc` (`factory.proposedIssues`).
 *
 * **The seam.** A model's answer is not asserted by reading the model: it is decoded here, by a
 * function that takes `unknown` and answers proposals or a `ProposalsRefused` naming every fault.
 * That is what makes the rules testable without a model, and what makes a model's answer — faux or
 * real — pass through the same rules a request body would. Nothing reaches the document without
 * passing `decodeProposedIssues`, and the snapshot reads the document back through it too, so a
 * value a writer that bypassed it could have left reads as no proposals rather than as ones the
 * rules would have refused.
 *
 * **The rules**, each a fault the refusal names by proposal index:
 *
 * - at least one proposal, and at most `MAX_PROPOSALS` — agents overestimate scope (LOB-43), and a
 *   decomposition is something a person reviews before anything exists;
 * - a non-empty title, unique across the set (compared trimmed, case- and space-insensitively,
 *   because two tracker issues a person cannot tell apart by title are a duplicate);
 * - at least one acceptance line, and no empty line among them;
 * - `blockedBy` names other proposals by index: in range, never the proposal itself, and the edges
 *   form no cycle — an order with a cycle in it is not an order anything can be started in (LOB-42
 *   consumes the edges).
 *
 * `goal` and `change` are carried but not judged: they are prose a person edits before approval.
 *
 * **Reconciliation** (LOB-203, part 3 of LOB-43). A decomposition does not replace the set before it:
 * `reconcileProposals` folds the new draft into what the session already holds, by title (`titleKey`).
 * A title the session already proposed is updated in place and keeps its recorded tracker issue; a
 * new title is added; a title the draft no longer proposes is *marked removed* — moved to `removed`
 * with its recorded issue, never dropped — and comes back with that issue if a later draft proposes
 * it again. So the same spec twice yields the same set and approving it twice creates nothing the
 * second time, and a changed spec answers with a diff (`ProposalDiff`) rather than a second full set.
 *
 * This module imports `@repo/domain/Ids` and nothing else of this package, as `Mission` does:
 * `Session.ts` imports *this* module for the snapshot's `proposedIssues` field.
 */
import { Effect, Result, Schema } from "effect";
import { SessionId } from "@repo/domain/Ids";

/** The most proposals one decomposition may commit. */
export const MAX_PROPOSALS = 20;

/**
 * The tracker issue a proposal became (LOB-202): the id the tracker's API addresses it by, and the
 * identifier a person reads (`ENG-43`). Written only by `approveProposals`, once the tracker has
 * answered; a proposal without one has not been created.
 */
export const CreatedIssue = Schema.Struct({
  id: Schema.String,
  identifier: Schema.String,
});
export type CreatedIssue = typeof CreatedIssue.Type;

/**
 * One proposed child issue, as it is stored and read back.
 *
 * `blockedBy` holds indices into the same proposal list: the proposals do not exist anywhere yet, so
 * an index is the only name one has for another. `approveProposals` (LOB-202) maps them to the
 * tracker's ids once both ends are created, and `created` is where a created proposal says so — it
 * is what makes approving the same proposal twice send nothing the second time.
 */
export const ProposedIssue = Schema.Struct({
  title: Schema.String,
  goal: Schema.String,
  change: Schema.String,
  acceptance: Schema.Array(Schema.String),
  blockedBy: Schema.Array(Schema.Int),
  created: Schema.optional(CreatedIssue),
});
export type ProposedIssue = typeof ProposedIssue.Type;

/**
 * A proposal a later decomposition no longer proposes (LOB-203), kept rather than dropped: if it
 * had become a tracker issue, `created` is the only record of which one, and a draft that proposes
 * the title again takes it back. It has no `blockedBy`: those indices named slots of a list that
 * no longer exists, and a revived proposal's edges come from the draft that revives it.
 */
export const RemovedProposal = Schema.Struct({
  title: Schema.String,
  goal: Schema.String,
  change: Schema.String,
  acceptance: Schema.Array(Schema.String),
  created: Schema.optional(CreatedIssue),
});
export type RemovedProposal = typeof RemovedProposal.Type;

/**
 * A decomposition's whole answer: the proposals, in the order their indices name them. A stored set
 * may also carry `removed` (LOB-203): the proposals earlier decompositions made that the newest no
 * longer does. Absent, not empty, when there are none — a draft never has any.
 */
export const ProposedIssues = Schema.Struct({
  proposals: Schema.Array(ProposedIssue),
  removed: Schema.optional(Schema.Array(RemovedProposal)),
});
export type ProposedIssues = typeof ProposedIssues.Type;

/**
 * One proposal as a writer may send it: `blockedBy` may be left out, which is "blocked by nothing".
 * A model that has no edges to declare should not be refused for not writing `[]`; the stored value
 * always carries the field.
 */
const ProposalInput = Schema.Struct({
  title: Schema.String,
  goal: Schema.String,
  change: Schema.String,
  acceptance: Schema.Array(Schema.String),
  blockedBy: Schema.optional(Schema.Array(Schema.Int)),
  /** Only a stored document carries this; `validate` below drops it from a writer's answer. */
  created: Schema.optional(CreatedIssue),
});

/** The proposals as above, and — in a stored document only — the ones marked removed (LOB-203). */
const ProposalsInput = Schema.Struct({
  proposals: Schema.Array(ProposalInput),
  removed: Schema.optional(Schema.Array(RemovedProposal)),
});

/** Why a proposal set was refused. */
export const ProposalFaultReason = Schema.Literals([
  /** Not the shape at all: a missing field, a field of the wrong type, or text that is not JSON. */
  "unreadable",
  /** No proposals. */
  "none",
  /** More than `MAX_PROPOSALS`. */
  "too_many",
  "empty_title",
  /** The title is another proposal's, by the comparison the module header names. */
  "duplicate_title",
  /** No acceptance line at all. */
  "no_acceptance",
  /** An acceptance line that says nothing. */
  "empty_acceptance_line",
  /** A `blockedBy` index no proposal has. */
  "unknown_blocker",
  /** A proposal that names itself as its own blocker. */
  "self_blocker",
  /** Proposals whose edges block each other round a cycle. */
  "cycle",
]);
export type ProposalFaultReason = typeof ProposalFaultReason.Type;

/**
 * One fault. `index` is the proposal it is about, or `null` for a fault of the whole set (`none`,
 * `too_many`, `unreadable` before any proposal could be read, and `cycle`, whose members `detail`
 * names). `detail` is the sentence a person or a model reads.
 */
export const ProposalFault = Schema.Struct({
  index: Schema.NullOr(Schema.Int),
  reason: ProposalFaultReason,
  detail: Schema.String,
});
export type ProposalFault = typeof ProposalFault.Type;

/**
 * A proposal set the validator refused, with every fault it found, so fixing one title does not
 * reveal on the retry that another proposal had no acceptance line. Nothing was stored.
 */
export class ProposalsRefused extends Schema.TaggedError<ProposalsRefused>()(
  "ProposalsRefused",
  {
    faults: Schema.Array(ProposalFault),
    message: Schema.String,
  },
) {}

/** Two titles are one when a person could not tell them apart in a list. */
export const titleKey = (title: string): string =>
  title.trim().replaceAll(/\s+/g, " ").toLowerCase();

/**
 * The input with its text trimmed and its edges deduplicated, in the order they were named.
 * `created` is kept only when the caller is reading a stored document: a model's answer is a fresh
 * draft, and nothing a model writes may say a tracker issue exists.
 */
const normalized = (
  input: typeof ProposalsInput.Type,
  keepCreated: boolean,
): readonly ProposedIssue[] =>
  input.proposals.map((proposal) => ({
    title: proposal.title.trim(),
    goal: proposal.goal.trim(),
    change: proposal.change.trim(),
    acceptance: proposal.acceptance.map((line) => line.trim()),
    blockedBy: [...new Set(proposal.blockedBy ?? [])],
    ...(keepCreated && proposal.created !== undefined
      ? { created: proposal.created }
      : {}),
  }));

/**
 * The indices left over once every proposal that can be ordered has been: Kahn's algorithm over the
 * `blockedBy` edges. Empty when the edges are an order. Assumes every edge is in range and none is a
 * self-edge, which the per-proposal checks have already refused.
 */
const unorderable = (proposals: readonly ProposedIssue[]): number[] => {
  const waiting = proposals.map((proposal) => proposal.blockedBy.length);
  const unblocks = proposals.map((): number[] => []);
  proposals.forEach((proposal, index) => {
    for (const blocker of proposal.blockedBy) unblocks[blocker]?.push(index);
  });
  const ready = waiting.flatMap((count, index) => (count === 0 ? [index] : []));
  let ordered = 0;
  while (ready.length > 0) {
    const next = ready.pop();
    if (next === undefined) break;
    ordered += 1;
    for (const blocked of unblocks[next] ?? []) {
      const left = (waiting[blocked] ?? 0) - 1;
      waiting[blocked] = left;
      if (left === 0) ready.push(blocked);
    }
  }
  if (ordered === proposals.length) return [];
  return waiting.flatMap((count, index) => (count > 0 ? [index] : []));
};

/** Every fault in a set that has the right shape, in proposal order, set-wide faults first. */
export const proposalFaults = (
  proposals: readonly ProposedIssue[],
): readonly ProposalFault[] => {
  const faults: ProposalFault[] = [];
  if (proposals.length === 0) {
    faults.push({
      index: null,
      reason: "none",
      detail: "a decomposition proposes at least one issue",
    });
  }
  if (proposals.length > MAX_PROPOSALS) {
    faults.push({
      index: null,
      reason: "too_many",
      detail: `${proposals.length} proposals is more than the ${MAX_PROPOSALS} one decomposition may propose`,
    });
  }
  const seen = new Map<string, number>();
  let edgesInRange = true;
  proposals.forEach((proposal, index) => {
    if (proposal.title.length === 0) {
      faults.push({
        index,
        reason: "empty_title",
        detail: `proposal ${index} has no title`,
      });
    } else {
      const key = titleKey(proposal.title);
      const first = seen.get(key);
      if (first === undefined) {
        seen.set(key, index);
      } else {
        faults.push({
          index,
          reason: "duplicate_title",
          detail: `proposal ${index}'s title "${proposal.title}" is proposal ${first}'s`,
        });
      }
    }
    if (proposal.acceptance.length === 0) {
      faults.push({
        index,
        reason: "no_acceptance",
        detail: `proposal ${index} has no acceptance line`,
      });
    }
    proposal.acceptance.forEach((line, lineIndex) => {
      if (line.length === 0) {
        faults.push({
          index,
          reason: "empty_acceptance_line",
          detail: `proposal ${index}'s acceptance line ${lineIndex} is empty`,
        });
      }
    });
    for (const blocker of proposal.blockedBy) {
      if (blocker === index) {
        edgesInRange = false;
        faults.push({
          index,
          reason: "self_blocker",
          detail: `proposal ${index} names itself in blockedBy`,
        });
      } else if (blocker < 0 || blocker >= proposals.length) {
        edgesInRange = false;
        faults.push({
          index,
          reason: "unknown_blocker",
          detail: `proposal ${index} is blocked by ${blocker}, which is not a proposal`,
        });
      }
    }
  });
  // A cycle is only a claim about edges that all name real, distinct proposals.
  const cycle = edgesInRange ? unorderable(proposals) : [];
  if (cycle.length > 0) {
    faults.push({
      index: null,
      reason: "cycle",
      detail: `proposals ${cycle.join(", ")} block each other in a cycle`,
    });
  }
  return faults;
};

const refusal = (faults: readonly ProposalFault[]): ProposalsRefused =>
  new ProposalsRefused({
    faults,
    message: `proposals refused: ${faults.map((fault) => fault.detail).join("; ")}`,
  });

/** A draft read as a stored shape: whatever `removed` it sent is not read, so it cannot refuse it. */
const draftOnly = (input: unknown): unknown =>
  typeof input === "object" && input !== null && !Array.isArray(input)
    ? { ...input, removed: undefined }
    : input;

const decodeShape = Schema.decodeUnknownResult(ProposalsInput);

/**
 * `stored` is a document read back: it keeps each `created` and carries `removed`. Otherwise the
 * input is a writer's draft, which may claim neither (and is not refused for an extra key it sends).
 */
const validate = (
  input: unknown,
  stored: boolean,
): Result.Result<ProposedIssues, readonly ProposalFault[]> => {
  const shape = decodeShape(stored ? input : draftOnly(input), {
    errors: "all",
  });
  if (Result.isFailure(shape)) {
    return Result.fail([
      {
        index: null,
        reason: "unreadable",
        detail: `not a {"proposals": [{title, goal, change, acceptance, blockedBy}]} object: ${shape.failure.message}`,
      },
    ]);
  }
  const proposals = normalized(shape.success, stored);
  const faults = proposalFaults(proposals);
  if (faults.length > 0) return Result.fail(faults);
  const removed = stored ? shape.success.removed : undefined;
  return Result.succeed(
    removed === undefined || removed.length === 0
      ? { proposals }
      : { proposals, removed },
  );
};

/**
 * The rules, as a pure function: the normalized `ProposedIssues` when every rule holds, every fault
 * when one does not. No effect runs here, so the snapshot's read (`projectProposedIssues`) and the
 * writer's (`decodeProposedIssues`) share one judgement without either running a runtime. A
 * `created` on an input proposal is dropped: this judges a draft.
 */
export const validateProposedIssues = (
  input: unknown,
): Result.Result<ProposedIssues, readonly ProposalFault[]> =>
  validate(input, false);

/**
 * Validate an untrusted value as a proposal set: the normalized `ProposedIssues` when every rule
 * holds, a `ProposalsRefused` naming every fault when one does not. The only way into the
 * `factory.proposedIssues` document goes through here.
 */
export const decodeProposedIssues = (
  input: unknown,
): Effect.Effect<ProposedIssues, ProposalsRefused> => {
  const result = validateProposedIssues(input);
  return Result.isSuccess(result)
    ? Effect.succeed(result.success)
    : Effect.fail(refusal(result.failure));
};

/**
 * A stored document read as a proposal set, or `undefined` when it is not one — its seed (no
 * proposals) included, so a session that never decomposed reads as none rather than as an empty set.
 * Unlike a draft, it keeps each proposal's `created`.
 */
export const projectProposedIssues = (
  value: unknown,
): ProposedIssues | undefined => Result.getOrUndefined(validate(value, true));

/**
 * What a decomposition changed against the set the session already held (LOB-203), as titles — a
 * title is what names a proposal across runs, and the indices move. Every proposal of the new set
 * is in exactly one of `added`, `updated` and `unchanged`; `removed` names the proposals the set
 * no longer has, now in `removed` of the stored set. A first decomposition adds everything; a rerun
 * over an unchanged spec, answered the same way, is all `unchanged`.
 */
export const ProposalDiff = Schema.Struct({
  /** New titles, and titles a draft brought back from `removed` (which keep their tracker issue). */
  added: Schema.Array(Schema.String),
  /** Titles the session already proposed whose goal, change, acceptance or edges differ. */
  updated: Schema.Array(Schema.String),
  unchanged: Schema.Array(Schema.String),
  /** Titles the previous set proposed that this draft does not, newly marked removed. */
  removed: Schema.Array(Schema.String),
});
export type ProposalDiff = typeof ProposalDiff.Type;

/**
 * The most removed proposals that never became a tracker issue a stored set keeps (LOB-203), oldest
 * first out. A removed proposal that was created is never dropped — its `created` is the only
 * record of the issue — so only drafts nothing was made for age out, which keeps a document a
 * model rewrites on every run from growing without bound.
 */
export const MAX_REMOVED_DRAFTS = 50;

/** A reconciliation: the set to store, and what changed against the one before it. */
export type Reconciliation = {
  readonly proposals: readonly ProposedIssue[];
  readonly removed: readonly RemovedProposal[];
  readonly diff: ProposalDiff;
};

/** A proposal's edges as the titles they name, sorted: the comparison that survives a reorder. */
const blockerKeys = (
  proposal: ProposedIssue,
  list: readonly ProposedIssue[],
): readonly string[] =>
  proposal.blockedBy
    .map((index) => titleKey(list[index]?.title ?? `#${index}`))
    .sort();

const sameLines = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && left.every((line, i) => line === right[i]);

/** The written content of a proposal and its edges, by title; `created` is not content. */
const sameContent = (
  previous: ProposedIssue,
  previousList: readonly ProposedIssue[],
  draft: ProposedIssue,
  draftList: readonly ProposedIssue[],
): boolean =>
  previous.title === draft.title &&
  previous.goal === draft.goal &&
  previous.change === draft.change &&
  sameLines(previous.acceptance, draft.acceptance) &&
  sameLines(blockerKeys(previous, previousList), blockerKeys(draft, draftList));

/**
 * Fold a new draft into the set a session already holds (LOB-203), by title.
 *
 * - A draft proposal whose title the previous set has is the **same proposal**: the draft's content
 *   replaces it in place and the recorded `created` stays. It is `updated` when its content differs
 *   (goal, change, acceptance, or the *titles* of its blockers — indices move when proposals are
 *   reordered, titles do not), `unchanged` when it does not.
 * - A draft proposal whose title only `removed` has comes back with that entry's `created`, and is
 *   `added`.
 * - Any other draft proposal is `added`, with no `created`.
 * - A previous proposal the draft does not have is marked removed with its `created`, never
 *   dropped. Uncreated removed proposals past `MAX_REMOVED_DRAFTS` age out, oldest first.
 *
 * The order of `proposals` is the draft's: the indices a person approves by name the newest answer.
 * `previous` is whatever the session stores (`undefined` for a session that never decomposed), and
 * `draft` a set `decodeProposedIssues` accepted. Pure.
 */
export const reconcileProposals = (
  previous: ProposedIssues | undefined,
  draft: ProposedIssues,
): Reconciliation => {
  const before = previous?.proposals ?? [];
  const removedBefore = previous?.removed ?? [];
  const beforeByKey = new Map(
    before.map((proposal) => [titleKey(proposal.title), proposal] as const),
  );
  const removedByKey = new Map(
    removedBefore.map(
      (proposal) => [titleKey(proposal.title), proposal] as const,
    ),
  );
  const draftKeys = new Set(
    draft.proposals.map((proposal) => titleKey(proposal.title)),
  );
  const added: string[] = [];
  const updated: string[] = [];
  const unchanged: string[] = [];
  const proposals = draft.proposals.map((proposal): ProposedIssue => {
    const key = titleKey(proposal.title);
    const existing = beforeByKey.get(key);
    const revived = existing === undefined ? removedByKey.get(key) : undefined;
    const created = existing?.created ?? revived?.created;
    if (existing === undefined) {
      added.push(proposal.title);
    } else if (sameContent(existing, before, proposal, draft.proposals)) {
      unchanged.push(proposal.title);
    } else {
      updated.push(proposal.title);
    }
    return {
      title: proposal.title,
      goal: proposal.goal,
      change: proposal.change,
      acceptance: [...proposal.acceptance],
      blockedBy: [...proposal.blockedBy],
      ...(created === undefined
        ? {}
        : { created: { id: created.id, identifier: created.identifier } }),
    };
  });
  const dropped = before.filter(
    (proposal) => !draftKeys.has(titleKey(proposal.title)),
  );
  const kept = removedBefore.filter(
    (proposal) => !draftKeys.has(titleKey(proposal.title)),
  );
  const marked = dropped.map((proposal): RemovedProposal => ({
    title: proposal.title,
    goal: proposal.goal,
    change: proposal.change,
    acceptance: [...proposal.acceptance],
    ...(proposal.created === undefined
      ? {}
      : {
          created: {
            id: proposal.created.id,
            identifier: proposal.created.identifier,
          },
        }),
  }));
  const all = [...kept, ...marked];
  // Oldest first in `all`, so the drafts to forget are the first ones past the cap.
  let draftsToForget =
    all.filter((proposal) => proposal.created === undefined).length -
    MAX_REMOVED_DRAFTS;
  const removed = all.filter((proposal) => {
    if (proposal.created !== undefined || draftsToForget <= 0) return true;
    draftsToForget -= 1;
    return false;
  });
  return {
    proposals,
    removed,
    diff: {
      added,
      updated,
      unchanged,
      removed: marked.map((proposal) => proposal.title),
    },
  };
};

/** Propose child issues from a session's spec (LOB-201). */
export const ProposeDecompositionInput = Schema.Struct({
  sessionId: SessionId,
});
export type ProposeDecompositionInput = typeof ProposeDecompositionInput.Type;

/**
 * What one decomposition committed: the set as stored — the same value `getSession`'s snapshot
 * carries as `proposedIssues` until the next decomposition reconciles into it — and the `diff`
 * against the set the session held before (LOB-203).
 */
export const ProposeDecompositionResult = Schema.Struct({
  proposals: Schema.Array(ProposedIssue),
  removed: Schema.optional(Schema.Array(RemovedProposal)),
  diff: ProposalDiff,
});
export type ProposeDecompositionResult = typeof ProposeDecompositionResult.Type;

/**
 * Approve a subset of a session's proposals (LOB-202, part 2 of LOB-43): the indices into
 * `factory.proposedIssues` a person accepted. Only those become tracker issues; the rest are left as
 * they were, and a later call may approve them.
 */
export const ApproveProposalsInput = Schema.Struct({
  sessionId: SessionId,
  approved: Schema.Array(Schema.Int),
});
export type ApproveProposalsInput = typeof ApproveProposalsInput.Type;

/**
 * What one approval did. `proposals` is the document as it now stands, each created proposal
 * carrying its `created`; `created` names the indices this call created (an approval that finds
 * every approved proposal already created answers `[]`), and `related` counts the
 * `blockedBy` edges this call sent to the tracker.
 */
export const ApproveProposalsResult = Schema.Struct({
  proposals: Schema.Array(ProposedIssue),
  created: Schema.Array(Schema.Int),
  related: Schema.Int,
});
export type ApproveProposalsResult = typeof ApproveProposalsResult.Type;

/** Why an approval could not be carried out. */
export const ApproveProposalsReason = Schema.Literals([
  /** The session never decomposed its spec: there is nothing to approve. */
  "no_proposals",
  /** An approved index no proposal has. */
  "unknown_proposal",
  /** This process has no tracker configured (no `LINEAR_API_KEY`). Nothing was sent. */
  "no_tracker",
  /** No tracker issue opened this session, so there is no parent and no team to create under. */
  "no_delegating_issue",
  /** The tracker refused, failed or went unanswered: a retry creates only what is still missing. */
  "tracker_failed",
  /** A decomposition replaced the proposals while the approval was in flight; approve again. */
  "proposals_changed",
]);
export type ApproveProposalsReason = typeof ApproveProposalsReason.Type;

/**
 * An approval that did not complete. For `no_proposals`, `unknown_proposal`, `no_tracker` and
 * `no_delegating_issue` nothing was sent and the document is unchanged. `tracker_failed` and
 * `proposals_changed` may follow requests that were sent and answered: `created` lists the
 * proposals the call had already created (each recorded in the document before the next request,
 * so a retry does not repeat them); the rest, and the edges, are what the retry does.
 */
export class ApproveProposalsError extends Schema.TaggedError<ApproveProposalsError>()(
  "ApproveProposalsError",
  {
    reason: ApproveProposalsReason,
    message: Schema.String,
    created: Schema.Array(Schema.Int),
  },
) {}
