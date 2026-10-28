/**
 * Plan freshness (LOB-45): after a factory PR merges, the plan is read again.
 *
 * A decomposition (`./Decomposition`, LOB-201) turns a spec into proposed child issues once. Plans go
 * stale as the work shows where the gaps are, so this is the second look: one read-only model call
 * compares the goal of record — the session's `factory.spec` (LOB-72) — with the tracker's current
 * issue set, the children of the issue the session was delegated from (where LOB-202 files approved
 * proposals), and proposes three kinds of change:
 *
 * - `add` — a new issue, in a decomposition proposal's shape (title, goal, change, acceptance);
 * - `rescope` — an existing issue, named by its identifier, with a revised title, goal, change and
 *   acceptance;
 * - `close` — an existing issue the spec no longer needs, with the reason it is obsolete.
 *
 * This module is the contract: the shapes, the rules, and the refusal. The call and the commit are
 * the harness's (`packages/harness/src/planFreshness.ts`), the cadence is `@repo/core`'s
 * (`PlanFreshness.ts`, a merged PR on `POST /webhooks/github`), and the stored token is
 * `PlanRevisionsDoc` (`factory.planRevisions`) on the spec's session.
 *
 * **The seam** is `Decomposition`'s: a model's answer is decoded here, by a function that takes
 * `unknown` and the issue set the call was shown, and answers proposals or every fault. Nothing
 * reaches the document without passing `validatePlanProposals`.
 *
 * **The rules**, each a fault the refusal names by proposal index:
 *
 * - at most `MAX_PLAN_PROPOSALS` — agents overestimate scope, and a person reviews every one. Unlike
 *   a decomposition, **none** is an answer: "the plan is still fresh" is what most merges should
 *   say, and recording it is what makes the merge's redelivery a no-op;
 * - an `add` or a `rescope` has a non-empty title, at least one acceptance line, and no empty one;
 * - an `add`'s title is no other proposal's and no tracker issue's (compared as `titleKey` compares)
 *   — an issue a person cannot tell apart from another by title is a duplicate of it;
 * - a `rescope` or a `close` names an issue **in the input set**, by identifier or id: a model may
 *   only change what it was shown;
 * - no two proposals are about one issue — a rescope and a close of the same issue are a
 *   contradiction a person would have to resolve;
 * - an issue already closed is not rescoped or closed again;
 * - a `close` says why.
 *
 * **The human gate is the point** (the talk this came from reports agents grossly overestimating
 * scope): a revision is shown on the spec's session, and only `approvePlanRevision` — through the
 * same tracker port LOB-202's approval uses — turns a proposal into a tracker write. Nothing here is
 * dispatched, and nothing is approved by a timer (`docs/board.md`, "What the board is not").
 *
 * This module imports `@repo/domain/Ids` and `@repo/domain/Decomposition` only, so `Session.ts` can
 * import it for the snapshot's `planRevisions` field.
 */
import { Result, Schema } from "effect";
import { CreatedIssue, titleKey } from "@repo/domain/Decomposition";
import { SessionId } from "@repo/domain/Ids";

/** The most proposals one plan-freshness pass may commit. */
export const MAX_PLAN_PROPOSALS = 20;

/** The most tracker issues one pass is shown; a larger plan is refused before the call. */
export const MAX_PLAN_ISSUES = 100;

/**
 * One tracker issue as the pass was shown it: what a proposal may name (`identifier`, or `id`), and
 * what a person reads beside the proposal. `closed` is the tracker's own word for a finished or
 * canceled issue; `acceptance` is the checklist its description carries, `[]` when it carries none.
 */
export const PlanIssue = Schema.Struct({
  id: Schema.String,
  identifier: Schema.String,
  title: Schema.String,
  state: Schema.String,
  closed: Schema.Boolean,
  acceptance: Schema.Array(Schema.String),
});
export type PlanIssue = typeof PlanIssue.Type;

/**
 * Where an approved proposal landed (`approvePlanRevision`): the issue an `add` created, or the issue
 * a `rescope` or `close` changed. Absent until the tracker answered.
 */
const applied = Schema.optional(CreatedIssue);

export const AddProposal = Schema.Struct({
  kind: Schema.Literal("add"),
  title: Schema.String,
  goal: Schema.String,
  change: Schema.String,
  acceptance: Schema.Array(Schema.String),
  applied,
});
export type AddProposal = typeof AddProposal.Type;

export const RescopeProposal = Schema.Struct({
  kind: Schema.Literal("rescope"),
  /** The tracker issue's identifier, as the input set names it (`ENG-43`). */
  issue: Schema.String,
  title: Schema.String,
  goal: Schema.String,
  change: Schema.String,
  acceptance: Schema.Array(Schema.String),
  applied,
});
export type RescopeProposal = typeof RescopeProposal.Type;

export const CloseProposal = Schema.Struct({
  kind: Schema.Literal("close"),
  /** The tracker issue's identifier, as the input set names it. */
  issue: Schema.String,
  /** Why the issue is obsolete: what the person reads before approving, and the comment it posts. */
  reason: Schema.String,
  applied,
});
export type CloseProposal = typeof CloseProposal.Type;

/** One proposal of a plan revision. */
export const PlanProposal = Schema.Union([
  AddProposal,
  RescopeProposal,
  CloseProposal,
]);
export type PlanProposal = typeof PlanProposal.Type;

/** What produced a revision: the merged PR, by its page and number, and its title when known. */
export const PlanTrigger = Schema.Struct({
  pr: Schema.String,
  number: Schema.Int,
  title: Schema.optional(Schema.String),
});
export type PlanTrigger = typeof PlanTrigger.Type;

/**
 * The spec a revision was derived from: the session that holds it, its goal as a person reads it,
 * and a digest of its goal and acceptance criteria — so a revision read after the spec changed says
 * it was made against another one.
 */
export const PlanSpecRef = Schema.Struct({
  sessionId: SessionId,
  goal: Schema.String,
  digest: Schema.String,
});
export type PlanSpecRef = typeof PlanSpecRef.Type;

/** A revision waits for a person (`pending`) until they decline it; approving is per proposal. */
export const PlanDecision = Schema.Literals(["pending", "declined"]);
export type PlanDecision = typeof PlanDecision.Type;

/**
 * One plan-freshness pass, as stored on the spec's session and listed by its snapshot. `key` names
 * the merge it answers (`merged:<pr url>`), so a redelivery of that merge finds it.
 */
export const PlanRevision = Schema.Struct({
  key: Schema.String,
  at: Schema.String,
  trigger: PlanTrigger,
  spec: PlanSpecRef,
  /** The tracker issues the pass was shown, which are the only ones a proposal may name. */
  issues: Schema.Array(PlanIssue),
  proposals: Schema.Array(PlanProposal),
  decision: PlanDecision,
});
export type PlanRevision = typeof PlanRevision.Type;

/** Why a plan-freshness answer was refused. */
export const PlanFaultReason = Schema.Literals([
  /** Not the shape at all: a missing field, an unknown `kind`, or text that is not JSON. */
  "unreadable",
  /** More than `MAX_PLAN_PROPOSALS`. */
  "too_many",
  "empty_title",
  /** An `add`'s title is another `add`'s. */
  "duplicate_title",
  /** An `add`'s title is a tracker issue's already. */
  "title_exists",
  "no_acceptance",
  "empty_acceptance_line",
  /** A `rescope` or `close` names an issue the pass was not shown. */
  "unknown_issue",
  /** Two proposals are about one issue. */
  "duplicate_issue",
  /** A `rescope` or `close` of an issue the tracker already closed. */
  "closed_issue",
  /** A `close` that does not say why. */
  "no_reason",
]);
export type PlanFaultReason = typeof PlanFaultReason.Type;

/** One fault; `index` is the proposal it is about, `null` for a fault of the whole answer. */
export const PlanFault = Schema.Struct({
  index: Schema.NullOr(Schema.Int),
  reason: PlanFaultReason,
  detail: Schema.String,
});
export type PlanFault = typeof PlanFault.Type;

/** A plan-freshness answer the validator refused, with every fault it found. Nothing was stored. */
export class PlanProposalsRefused extends Schema.TaggedError<PlanProposalsRefused>()(
  "PlanProposalsRefused",
  {
    faults: Schema.Array(PlanFault),
    message: Schema.String,
  },
) {}

/** Why a pass was not made. Each is decided before the model call, so a refusal costs nothing. */
export const PlanFreshnessReason = Schema.Literals([
  /** The spec's session is running. */
  "busy",
  /** The session holds no spec. */
  "no_spec",
  /** The spec still declares gaps a person has to close. */
  "spec_gaps",
  /** The spec cannot be shown whole (`decompositionInputFault`'s limits). */
  "spec_too_large",
  /** No tracker is configured: there is no plan to read. */
  "no_tracker",
  /** No tracker issue opened the session, so there is no plan under it. */
  "no_delegating_issue",
  /** The tracker's issue set could not be read. */
  "tracker_failed",
  /** More than `MAX_PLAN_ISSUES` issues. */
  "too_many_issues",
  /** The call's worst-case cost is over the configured bound. */
  "over_bound",
]);
export type PlanFreshnessReason = typeof PlanFreshnessReason.Type;

export class PlanFreshnessRefused extends Schema.TaggedError<PlanFreshnessRefused>()(
  "PlanFreshnessRefused",
  {
    reason: PlanFreshnessReason,
    message: Schema.String,
  },
) {}

/** Two issue references are one when they name the same identifier, whatever the case. */
const issueKey = (reference: string): string => reference.trim().toUpperCase();

/** The draft as a writer may send it: `applied` is a stored fact, never read from a draft. */
const DraftAnswer = Schema.Struct({
  proposals: Schema.Array(
    Schema.Union([
      Schema.Struct({
        kind: Schema.Literal("add"),
        title: Schema.String,
        goal: Schema.String,
        change: Schema.String,
        acceptance: Schema.Array(Schema.String),
      }),
      Schema.Struct({
        kind: Schema.Literal("rescope"),
        issue: Schema.String,
        title: Schema.String,
        goal: Schema.String,
        change: Schema.String,
        acceptance: Schema.Array(Schema.String),
      }),
      Schema.Struct({
        kind: Schema.Literal("close"),
        issue: Schema.String,
        reason: Schema.String,
      }),
    ]),
  ),
});

const decodeDraft = Schema.decodeUnknownResult(DraftAnswer);

/** The draft trimmed, and each issue reference resolved to the identifier the input set uses. */
const normalized = (
  draft: typeof DraftAnswer.Type,
  issues: readonly PlanIssue[],
): readonly PlanProposal[] => {
  const byKey = new Map<string, PlanIssue>();
  for (const issue of issues) {
    byKey.set(issueKey(issue.identifier), issue);
    byKey.set(issueKey(issue.id), issue);
  }
  const resolve = (reference: string) =>
    byKey.get(issueKey(reference))?.identifier ?? reference.trim();
  return draft.proposals.map((proposal): PlanProposal => {
    switch (proposal.kind) {
      case "add":
        return {
          kind: "add",
          title: proposal.title.trim(),
          goal: proposal.goal.trim(),
          change: proposal.change.trim(),
          acceptance: proposal.acceptance.map((line) => line.trim()),
        };
      case "rescope":
        return {
          kind: "rescope",
          issue: resolve(proposal.issue),
          title: proposal.title.trim(),
          goal: proposal.goal.trim(),
          change: proposal.change.trim(),
          acceptance: proposal.acceptance.map((line) => line.trim()),
        };
      case "close":
        return {
          kind: "close",
          issue: resolve(proposal.issue),
          reason: proposal.reason.trim(),
        };
    }
  });
};

/** Every fault of a well-shaped answer against the issue set it was shown, in proposal order. */
export const planProposalFaults = (
  proposals: readonly PlanProposal[],
  issues: readonly PlanIssue[],
): readonly PlanFault[] => {
  const faults: PlanFault[] = [];
  if (proposals.length > MAX_PLAN_PROPOSALS) {
    faults.push({
      index: null,
      reason: "too_many",
      detail: `${proposals.length} proposals is more than the ${MAX_PLAN_PROPOSALS} one pass may propose`,
    });
  }
  const known = new Map(
    issues.map((issue) => [issueKey(issue.identifier), issue] as const),
  );
  const existingTitles = new Map(
    issues.map((issue) => [titleKey(issue.title), issue.identifier] as const),
  );
  const addTitles = new Map<string, number>();
  const about = new Map<string, number>();
  proposals.forEach((proposal, index) => {
    if (proposal.kind !== "close") {
      if (proposal.title.length === 0) {
        faults.push({
          index,
          reason: "empty_title",
          detail: `proposal ${index} has no title`,
        });
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
    }
    if (proposal.kind === "add") {
      if (proposal.title.length > 0) {
        const key = titleKey(proposal.title);
        const first = addTitles.get(key);
        const existing = existingTitles.get(key);
        if (first !== undefined) {
          faults.push({
            index,
            reason: "duplicate_title",
            detail: `proposal ${index}'s title "${proposal.title}" is proposal ${first}'s`,
          });
        } else {
          addTitles.set(key, index);
        }
        if (existing !== undefined) {
          faults.push({
            index,
            reason: "title_exists",
            detail: `proposal ${index} adds "${proposal.title}", which is ${existing}'s title already`,
          });
        }
      }
      return;
    }
    const issue = known.get(issueKey(proposal.issue));
    if (issue === undefined) {
      faults.push({
        index,
        reason: "unknown_issue",
        detail: `proposal ${index} would ${proposal.kind} ${proposal.issue}, which is not an issue of the plan it was shown`,
      });
    } else {
      const first = about.get(issue.identifier);
      if (first !== undefined) {
        faults.push({
          index,
          reason: "duplicate_issue",
          detail: `proposal ${index} is about ${issue.identifier}, which proposal ${first} is already about`,
        });
      } else {
        about.set(issue.identifier, index);
      }
      if (issue.closed) {
        faults.push({
          index,
          reason: "closed_issue",
          detail: `proposal ${index} would ${proposal.kind} ${issue.identifier}, which is already ${issue.state}`,
        });
      }
    }
    if (proposal.kind === "close" && proposal.reason.length === 0) {
      faults.push({
        index,
        reason: "no_reason",
        detail: `proposal ${index} closes ${proposal.issue} without saying why`,
      });
    }
  });
  return faults;
};

/**
 * Validate an untrusted answer as plan proposals against the issue set the pass was shown: the
 * normalized proposals when every rule holds, every fault when one does not. Pure. An `applied` a
 * draft claims is dropped: only an approval says a tracker write happened.
 */
export const validatePlanProposals = (
  input: unknown,
  issues: readonly PlanIssue[],
): Result.Result<readonly PlanProposal[], readonly PlanFault[]> => {
  const shape = decodeDraft(input, { errors: "all" });
  if (Result.isFailure(shape)) {
    return Result.fail([
      {
        index: null,
        reason: "unreadable",
        detail: `not a {"proposals": [{"kind": "add" | "rescope" | "close", ...}]} object: ${shape.failure.message}`,
      },
    ]);
  }
  const proposals = normalized(shape.success, issues);
  const faults = planProposalFaults(proposals, issues);
  return faults.length > 0 ? Result.fail(faults) : Result.succeed(proposals);
};

/** The refusal a set of faults is. */
export const planProposalsRefused = (
  faults: readonly PlanFault[],
): PlanProposalsRefused =>
  new PlanProposalsRefused({
    faults,
    message: `plan proposals refused: ${faults.map((fault) => fault.detail).join("; ")}`,
  });

const decodeRevision = Schema.decodeUnknownResult(PlanRevision);

/**
 * A stored document's revisions, newest last, each read through the schema: an entry that does not
 * decode is left out rather than failing the snapshot. `undefined` when there are none, so a session
 * no pass ever ran on reports no revisions rather than an empty list.
 */
export const projectPlanRevisions = (
  value: unknown,
): readonly PlanRevision[] | undefined => {
  const entries =
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Array.isArray((value as { revisions?: unknown }).revisions)
      ? ((value as { revisions: readonly unknown[] }).revisions ?? [])
      : [];
  const revisions = entries.flatMap((entry) => {
    const decoded = decodeRevision(entry);
    return Result.isSuccess(decoded) ? [decoded.success] : [];
  });
  return revisions.length === 0 ? undefined : revisions;
};

/** The key a merge's revision is filed under. */
export const planRevisionKey = (pr: string): string => `merged:${pr}`;

/** Decline a revision (LOB-45): it stays listed, marked declined, and nothing is sent anywhere. */
export const DeclinePlanRevisionInput = Schema.Struct({
  sessionId: SessionId,
  key: Schema.String,
});
export type DeclinePlanRevisionInput = typeof DeclinePlanRevisionInput.Type;

/**
 * Approve a subset of a revision's proposals, by index: through the tracker port LOB-202's approval
 * uses, `add` creates a child of the delegating issue, `rescope` rewrites the issue's title and
 * description, `close` comments the reason and moves it to the team's canceled state.
 */
export const ApprovePlanRevisionInput = Schema.Struct({
  sessionId: SessionId,
  key: Schema.String,
  approved: Schema.Array(Schema.Int),
});
export type ApprovePlanRevisionInput = typeof ApprovePlanRevisionInput.Type;

/** What one approval did: the revision as it now stands, and the indices this call applied. */
export const ApprovePlanRevisionResult = Schema.Struct({
  revision: PlanRevision,
  applied: Schema.Array(Schema.Int),
});
export type ApprovePlanRevisionResult = typeof ApprovePlanRevisionResult.Type;

/**
 * The acceptance checklist an issue description carries: its `- [ ]` and `- [x]` lines, in order,
 * which is how `proposalIssueBody` (LOB-202) writes them.
 */
export const acceptanceOfDescription = (
  description: string,
): readonly string[] =>
  description.split("\n").flatMap((line) => {
    const match = /^\s*[-*]\s+\[[ xX]\]\s+(.*)$/.exec(line);
    const text = match?.[1]?.trim();
    return text === undefined || text === "" ? [] : [text];
  });
