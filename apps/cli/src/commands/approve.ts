import type { ApprovalRequest, ApprovalVerdict } from "@repo/domain/Approval";
import { SessionId } from "@repo/domain/Session";
import { Console, Effect, Option, Result } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { resolveApiUrl } from "../api";
import { reportFailure, reportFailures } from "../errors";
import { BoardClient } from "../rpc";
import { followSession } from "../transcript";

/**
 * `factory approvals` / `factory approve` / `factory deny` — the operator's half of an approval
 * (docs/design.md D11, LOB-53).
 *
 * A gated tool call asks once and parks its run (LOB-52); these are how a person at a terminal sees
 * what is waiting and answers it. The answer resumes the session: the decision is handed to it as a
 * follow-up message (`decideApproval` with `resume`), so an approved call runs on the turn it wakes
 * and a denied one is carried on without — the same thing the dashboard's Approve and Deny do.
 */

const apiFlag = Flag.String("api").pipe(
  Flag.withDescription("Control plane base URL"),
  Flag.optional,
);

/** The header `factory approvals` prints above its rows: one name per column, in row order. */
export const APPROVALS_HEADER = "request  session  requested  action";

/**
 * One pending request as a `factory approvals` row. The action is last because it is the only field
 * that may contain spaces (`npm publish`): everything before it is one token, so a script can split
 * the line on whitespace and read the request id first and the session second.
 */
export const approvalRow = (request: ApprovalRequest): string =>
  [
    request.requestId,
    request.sessionId,
    request.requestedAt,
    request.action,
  ].join("  ");

/**
 * The line `factory approvals` prints under a page the server cut (LOB-53): the page is the newest
 * `shown` of `total` pending, so the count a person reads is the real one. `undefined` when nothing
 * was cut.
 */
export const truncationNote = (
  shown: number,
  total: number,
): string | undefined =>
  total > shown
    ? `showing the newest ${shown} of ${total} pending approvals; decide or narrow with --session to see the rest`
    : undefined;

/**
 * What `factory approve` / `deny` says when the decision is recorded but the session was not handed
 * it (LOB-53): the decision stands, the run is still parked, and the retry is the same decision by
 * request id — `--id`, because a bare `approve` finds nothing pending once the decision is on file.
 */
export const resumeFailedMessage = (
  verb: string,
  sessionId: string,
  requestId: string,
  reason: string,
): string =>
  `the decision is recorded, but ${sessionId} was not resumed (${reason}); retry with: factory ${verb} ${sessionId} --id ${requestId}`;

/** Why `--id` had to be named, in the code and the words `reportFailure` prints. */
export type PickRefusal = {
  readonly code: "not_found" | "invalid_input";
  readonly message: string;
};

/**
 * Which of a session's pending requests a decision is for, when `--id` was not given.
 *
 * Exactly one pending is unambiguous, so it is the one. None is `not_found` — there is nothing to
 * decide, and a script must not read that as success. More than one is refused rather than guessed:
 * deciding the oldest would answer a question the person may not have read, so the refusal lists the
 * ids to name with `--id`.
 */
export const pickPending = (
  sessionId: SessionId,
  pending: ReadonlyArray<ApprovalRequest>,
): Result.Result<ApprovalRequest, PickRefusal> => {
  const [only, ...rest] = pending;
  if (only === undefined) {
    return Result.fail({
      code: "not_found",
      message: `no approval is pending in ${sessionId}`,
    });
  }
  if (rest.length > 0) {
    return Result.fail({
      code: "invalid_input",
      message: `${pending.length} approvals are pending in ${sessionId}; name one with --id: ${pending
        .map((request) => request.requestId)
        .join(", ")}`,
    });
  }
  return Result.succeed(only);
};

/**
 * `factory approvals [--session <id>]` — what is waiting for a person: every session's pending
 * requests, newest first and at most one page (a note under the rows says when more are waiting), or
 * one session's, oldest first.
 */
export const approvalsCommand = Command.make(
  "approvals",
  {
    session: Flag.String("session").pipe(
      Flag.withDescription("Only this session's pending approvals"),
      Flag.withSchema(SessionId),
      Flag.optional,
    ),
    api: apiFlag,
  },
  Effect.fnUntraced(function* ({ session, api }) {
    const apiUrl = yield* resolveApiUrl(api);

    const program = Effect.gen(function* () {
      const { client } = yield* BoardClient;
      const { approvals, total } = yield* Option.match(session, {
        onNone: () => client.listPendingApprovals({}),
        onSome: (sessionId) =>
          client.listApprovals({ sessionId }).pipe(
            Effect.map(({ approvals }) => ({
              approvals,
              total: approvals.length,
            })),
          ),
      });
      if (approvals.length === 0) {
        yield* Console.log("no approvals pending");
        return;
      }
      yield* Console.log(APPROVALS_HEADER);
      for (const request of approvals) {
        yield* Console.log(approvalRow(request));
      }
      const note = truncationNote(approvals.length, total);
      // On stderr, so a script splitting stdout into rows never reads the note as one.
      if (note !== undefined) yield* Console.error(note);
    });

    yield* reportFailures(Effect.provide(program, BoardClient.layer(apiUrl)));
  }),
).pipe(
  Command.withDescription("List the approvals waiting for a person"),
  Command.withExamples([
    { command: "factory approvals", description: "Every session's" },
    {
      command: "factory approvals --session ses_00000000000000000000000000",
      description: "One session's",
    },
  ]),
);

/** The command each verdict is typed as; the decision it records is the verdict itself. */
const VERB: Record<ApprovalVerdict, string> = {
  approved: "approve",
  denied: "deny",
};

/**
 * `factory approve` and `factory deny`: one command shape, two verdicts.
 *
 * The decision is recorded, the session is handed it, and the command then follows the session the
 * way `factory run` does — printing the resumed run's transcript and its answer — so "the parked run
 * resumed" is something the terminal shows rather than something to go and check. An approval id the
 * session never asked for is `not_found` from the service, with a non-zero exit.
 */
const decideCommand = (decision: ApprovalVerdict) =>
  Command.make(
    VERB[decision],
    {
      sessionId: Argument.String("session-id").pipe(
        Argument.withDescription("Session the approval was asked in"),
        Argument.withSchema(SessionId),
      ),
      id: Flag.String("id").pipe(
        Flag.withDescription(
          "The approval's request id (`factory approvals` lists them); optional when only one is pending",
        ),
        Flag.optional,
      ),
      actor: Flag.String("actor").pipe(
        Flag.withDescription("Who decides; recorded with the decision"),
        Flag.withDefault("cli"),
      ),
      api: apiFlag,
    },
    Effect.fnUntraced(function* ({ sessionId, id, actor, api }) {
      const apiUrl = yield* resolveApiUrl(api);

      const program = Effect.gen(function* () {
        const { client } = yield* BoardClient;
        let requestId: string;
        if (Option.isSome(id)) {
          requestId = id.value;
        } else {
          const { approvals } = yield* client.listApprovals({ sessionId });
          const picked = pickPending(sessionId, approvals);
          if (Result.isFailure(picked)) {
            return yield* reportFailure(
              picked.failure.code,
              picked.failure.message,
            );
          }
          requestId = picked.success.requestId;
        }

        const decided = yield* client.decideApproval({
          sessionId,
          requestId,
          decision,
          actor,
          resume: true,
        });
        yield* Console.log(
          `${decided.decision} ${decided.requestId} by ${decided.actor}`,
        );
        if (decided.resumeFailed !== undefined) {
          // Not "the decision failed": it is on file, and a retry by id resends the follow-up.
          return yield* reportFailure(
            decided.resumeFailed.code,
            resumeFailedMessage(
              VERB[decision],
              sessionId,
              requestId,
              decided.resumeFailed.message,
            ),
          );
        }
        if (decided.resumedWith !== undefined) {
          yield* Console.log(
            `resumed ${sessionId} with submission ${decided.resumedWith}`,
          );
        }

        const { answer } = yield* followSession(client, sessionId, {
          printMode: false,
        });
        yield* Console.log(`answer: ${answer ?? "(no answer)"}`);
      });

      yield* reportFailures(Effect.provide(program, BoardClient.layer(apiUrl)));
    }),
  ).pipe(
    Command.withDescription(
      decision === "approved"
        ? "Approve a pending approval and resume the session"
        : "Deny a pending approval and resume the session without it",
    ),
    Command.withExamples([
      {
        command: `factory ${VERB[decision]} ses_00000000000000000000000000`,
        description: "The session's only pending approval",
      },
      {
        command: `factory ${VERB[decision]} ses_00000000000000000000000000 --id ask-bash-0123`,
        description: "One of several, by request id",
      },
    ]),
  );

export const approveCommand = decideCommand("approved");
export const denyCommand = decideCommand("denied");
