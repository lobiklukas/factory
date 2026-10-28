/**
 * Where an approved proposal becomes a tracker issue (LOB-202, part 2 of LOB-43).
 *
 * `proposeDecomposition` (LOB-201) commits proposals and creates nothing. `approveProposals` is the
 * half that does, and the tracker it writes to is this port's: the session layer decides *which*
 * proposals to create and records what came back; the tracker decides how an issue is made. The one
 * implementation is Linear's (`LinearProposalTracker`, `./LinearSync`).
 *
 * **A `Context.Reference` whose default refuses.** `SessionServiceLive` does not require a tracker —
 * every test, every drive and a deployment with no `LINEAR_API_KEY` builds it without one — so the
 * default is the one answer that is true without a tracker: `no_tracker`, with nothing sent. That is
 * what makes "no tracker" a state the process can be in (`NoLinearIssueSync`'s own), rather than a
 * silent success that created nothing.
 *
 * **Everything is idempotent on what the tracker already holds.** `create` is asked for a proposal
 * by its title: an issue this session already made for that title — the answer to a request whose
 * acknowledgement was lost — is returned, not made again. `relate` answers `false` for an edge that
 * exists. So a retry of a failed approval repeats nothing, which is the whole of the failure
 * contract: the session layer records each id as the tracker answers, and re-asks for the rest.
 */
import { createHash } from "node:crypto";
import { Context, Effect } from "effect";
import {
  ApproveProposalsError,
  type CreatedIssue,
  type ProposedIssue,
} from "@repo/domain/Decomposition";
import type { PlanIssue } from "@repo/domain/PlanFreshness";
import type { SessionError, SessionId } from "@repo/domain/Session";

/** The tracker, bound to one session's delegating issue. */
export type ProposalTarget = {
  /** Create `issue` as a child of the delegating issue, or find the one a lost answer left. */
  readonly create: (input: {
    readonly title: string;
    readonly body: string;
  }) => Effect.Effect<CreatedIssue, ApproveProposalsError>;
  /** Make `blocker` block `blocked`. `false`: the edge was already there, and nothing was sent. */
  readonly relate: (input: {
    readonly blocker: CreatedIssue;
    readonly blocked: CreatedIssue;
  }) => Effect.Effect<boolean, ApproveProposalsError>;
  /**
   * The plan as the tracker holds it now (LOB-45): the delegating issue's children, each with its
   * state and the acceptance checklist its description carries. A read, and the only thing a
   * plan-freshness pass asks of the tracker.
   */
  readonly issues: Effect.Effect<readonly PlanIssue[], ApproveProposalsError>;
  /**
   * Re-scope `issue` (LOB-45): its title and description become the revised ones, and one comment
   * carrying `marker` says so. A retry finds the comment and sends nothing.
   */
  readonly rescope: (input: {
    readonly issue: CreatedIssue;
    readonly title: string;
    readonly body: string;
    readonly marker: string;
  }) => Effect.Effect<void, ApproveProposalsError>;
  /**
   * Close `issue` as obsolete (LOB-45): one comment carrying `marker` and the reason, and a move to
   * the team's canceled state. An issue already closed is not moved; a retry repeats nothing.
   */
  readonly close: (input: {
    readonly issue: CreatedIssue;
    readonly reason: string;
    readonly marker: string;
  }) => Effect.Effect<void, ApproveProposalsError>;
};

export type ProposalTrackerShape = {
  /**
   * Bind the tracker to the session's delegating issue. Refuses — `no_tracker` or
   * `no_delegating_issue`, before any request is made — when there is nowhere to create under.
   * A failure to read the session's own record is a `SessionError` (`storage`): the tracker was
   * never contacted, and must not read as though it had failed.
   */
  readonly open: (
    sessionId: SessionId,
  ) => Effect.Effect<ProposalTarget, ApproveProposalsError | SessionError>;
};

export const ProposalTracker = Context.Reference<ProposalTrackerShape>(
  "@repo/core/ProposalTracker",
  {
    defaultValue: () => ({
      open: () =>
        Effect.fail(
          new ApproveProposalsError({
            reason: "no_tracker",
            message:
              "no tracker is configured (LINEAR_API_KEY is unset), so there is nowhere to create the issues; nothing was sent",
            created: [],
          }),
        ),
    }),
  },
);

/**
 * The line a created issue is recognized by on a retry: this session, and a digest of the proposal's
 * title. The title and not the index, because titles are unique across a proposal set (the validator
 * refuses a duplicate) and an index names a different proposal once a decomposition is rerun.
 */
export const proposalMarker = (sessionId: SessionId, title: string): string =>
  `factory:${sessionId}:proposal:${createHash("sha256")
    .update(title.trim().replaceAll(/\s+/g, " ").toLowerCase())
    .digest("hex")
    .slice(0, 12)}`;

/**
 * The line a plan revision's re-scope or close is recognized by on a retry (LOB-45): this session,
 * the revision's key and the issue. One per revision and issue, so a later revision's change to the
 * same issue is a change of its own, and a retried approval of this one sends nothing.
 */
export const planMarker = (
  sessionId: SessionId,
  key: string,
  identifier: string,
): string =>
  `factory:${sessionId}:plan:${createHash("sha256")
    .update(key)
    .digest("hex")
    .slice(0, 12)}:${identifier}`;

/** The issue text a proposal becomes: the goal, the change, and the acceptance lines as a checklist. */
export const proposalIssueBody = (proposal: ProposedIssue): string =>
  [
    proposal.goal,
    "",
    "**Change**",
    "",
    proposal.change,
    "",
    "**Acceptance**",
    "",
    ...proposal.acceptance.map((line) => `- [ ] ${line}`),
  ].join("\n");
