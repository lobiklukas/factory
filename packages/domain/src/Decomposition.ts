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
 * This module imports `@repo/domain/Ids` and nothing else of this package, as `Mission` does:
 * `Session.ts` imports *this* module for the snapshot's `proposedIssues` field.
 */
import { Effect, Result, Schema } from "effect";
import { SessionId } from "@repo/domain/Ids";

/** The most proposals one decomposition may commit. */
export const MAX_PROPOSALS = 20;

/**
 * One proposed child issue, as it is stored and read back.
 *
 * `blockedBy` holds indices into the same proposal list: the proposals do not exist anywhere yet, so
 * an index is the only name one has for another. Part 2 (LOB-202) maps them to the tracker's ids
 * when it creates the issues.
 */
export const ProposedIssue = Schema.Struct({
  title: Schema.String,
  goal: Schema.String,
  change: Schema.String,
  acceptance: Schema.Array(Schema.String),
  blockedBy: Schema.Array(Schema.Int),
});
export type ProposedIssue = typeof ProposedIssue.Type;

/** A decomposition's whole answer: the proposals, in the order their indices name them. */
export const ProposedIssues = Schema.Struct({
  proposals: Schema.Array(ProposedIssue),
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
});

const ProposalsInput = Schema.Struct({
  proposals: Schema.Array(ProposalInput),
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
const titleKey = (title: string): string =>
  title.trim().replaceAll(/\s+/g, " ").toLowerCase();

/** The input with its text trimmed and its edges deduplicated, in the order they were named. */
const normalized = (
  input: typeof ProposalsInput.Type,
): readonly ProposedIssue[] =>
  input.proposals.map((proposal) => ({
    title: proposal.title.trim(),
    goal: proposal.goal.trim(),
    change: proposal.change.trim(),
    acceptance: proposal.acceptance.map((line) => line.trim()),
    blockedBy: [...new Set(proposal.blockedBy ?? [])],
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

const decodeShape = Schema.decodeUnknownResult(ProposalsInput);

/**
 * The rules, as a pure function: the normalized `ProposedIssues` when every rule holds, every fault
 * when one does not. No effect runs here, so the snapshot's read (`projectProposedIssues`) and the
 * writer's (`decodeProposedIssues`) share one judgement without either running a runtime.
 */
export const validateProposedIssues = (
  input: unknown,
): Result.Result<ProposedIssues, readonly ProposalFault[]> => {
  const shape = decodeShape(input, { errors: "all" });
  if (Result.isFailure(shape)) {
    return Result.fail([
      {
        index: null,
        reason: "unreadable",
        detail: `not a {"proposals": [{title, goal, change, acceptance, blockedBy}]} object: ${shape.failure.message}`,
      },
    ]);
  }
  const proposals = normalized(shape.success);
  const faults = proposalFaults(proposals);
  return faults.length === 0
    ? Result.succeed({ proposals })
    : Result.fail(faults);
};

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
 */
export const projectProposedIssues = (
  value: unknown,
): ProposedIssues | undefined =>
  Result.getOrUndefined(validateProposedIssues(value));

/** Propose child issues from a session's spec (LOB-201). */
export const ProposeDecompositionInput = Schema.Struct({
  sessionId: SessionId,
});
export type ProposeDecompositionInput = typeof ProposeDecompositionInput.Type;

/**
 * What one decomposition committed: the proposals, as stored. The same value `getSession`'s
 * snapshot carries as `proposedIssues` until the next decomposition replaces it.
 */
export const ProposeDecompositionResult = ProposedIssues;
export type ProposeDecompositionResult = ProposedIssues;
