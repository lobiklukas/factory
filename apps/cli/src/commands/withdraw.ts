import { SessionId } from "@repo/domain/Session";
import type { WithdrawOutcome } from "@repo/domain/Session";
import { Console, Effect } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { resolveApiUrl } from "../api";
import { reportFailure, reportFailures } from "../errors";
import { SessionClient } from "../rpc";

/** Why a message could not be withdrawn, in the words the line after the code carries. */
const notWithdrawn = (
  outcome: Exclude<WithdrawOutcome, "withdrawn">,
  submissionId: string,
): string =>
  outcome === "already_placed"
    ? `message ${submissionId} was already taken by a run`
    : `message ${submissionId} is already settled`;

/**
 * `factory withdraw <session-id> <submission-id>` — take a queued message back before a run places
 * it (LOB-166).
 *
 * The submission id is the one `factory send` printed, and the one `factory watch` shows in a
 * `[queued:<mode>:<id>]` line. A withdrawn message leaves the queue in the same commit that settles
 * it, so every attached `watch` sees the queue shrink and the message never reaches the transcript.
 *
 * Only `withdrawn` exits 0. A message a run already took (`already_placed`) or one that is over
 * (`settled`) is reported as that word with a non-zero exit, as a refusal is: the command did not do
 * what it was asked, and a script must be able to tell. An id the session never admitted is
 * `not_found`.
 */
export const withdrawCommand = Command.make(
  "withdraw",
  {
    sessionId: Argument.String("session-id").pipe(
      Argument.withDescription("Session the message was sent to"),
      Argument.withSchema(SessionId),
    ),
    submissionId: Argument.String("submission-id").pipe(
      Argument.withDescription(
        "The queued message, as `factory send` named it",
      ),
    ),
    api: Flag.String("api").pipe(
      Flag.withDescription("Control plane base URL"),
      Flag.optional,
    ),
  },
  Effect.fnUntraced(function* ({ sessionId, submissionId, api }) {
    const apiUrl = yield* resolveApiUrl(api);

    const program = Effect.gen(function* () {
      const { client } = yield* SessionClient;
      const result = yield* client.withdrawMessage({ sessionId, submissionId });
      if (result.outcome !== "withdrawn") {
        return yield* reportFailure(
          result.outcome,
          notWithdrawn(result.outcome, result.submissionId),
        );
      }
      yield* Console.log(`withdrawn ${result.submissionId}`);
    });

    yield* reportFailures(Effect.provide(program, SessionClient.layer(apiUrl)));
  }),
).pipe(
  Command.withDescription("Withdraw a queued message before a run takes it"),
  Command.withExamples([
    {
      command: "factory withdraw ses_00000000000000000000000000 12",
      description: "Withdraw the message `factory send` named 12",
    },
  ]),
);
