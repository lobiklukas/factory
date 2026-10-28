import { SessionBudgetCap, SessionId } from "@repo/domain/Session";
import type { SetSessionBudgetResult } from "@repo/domain/Session";
import { Console, Effect } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { resolveApiUrl } from "../api";
import { reportFailures } from "../errors";
import { SessionClient } from "../rpc";
import { formatDollars } from "../transcript";

/**
 * The line `factory budget` prints: the cap now in force and the spend it is measured against, so a
 * script can match `capped <id>`. A stop the old cap made is cleared by the call, which the line
 * does not need to say — `factory status` shows the session's budget, and no stop with it.
 */
export const budgetLine = (result: SetSessionBudgetResult): string =>
  `capped ${result.session.id}: ${formatDollars(result.budget.cap)} cap, ${formatDollars(result.budget.spent)} spent`;

/**
 * `factory budget <session-id> --cap <usd>` — set a session's spend cap (C23): raise the cap a run
 * hit, so the session runs again on its next message.
 *
 * The cap is committed on the session's own log and the stop the old cap recorded is cleared, so
 * `factory send` then starts a run that is let through up to the new cap. A cap the session's spend
 * already reaches is accepted and the server says so on a second line: the next run stops before its
 * first request, as it does under any reached cap. An unknown session is `error: not_found`.
 */
export const budgetCommand = Command.make(
  "budget",
  {
    sessionId: Argument.String("session-id").pipe(
      Argument.withDescription("Session whose spend cap to set"),
      Argument.withSchema(SessionId),
    ),
    cap: Flag.Finite("cap").pipe(
      Flag.withDescription(
        "The new spend ceiling, in US dollars: a run stops before a model request once the session's spend reaches it",
      ),
      Flag.withSchema(SessionBudgetCap),
    ),
    api: Flag.String("api").pipe(
      Flag.withDescription("Control plane base URL"),
      Flag.optional,
    ),
  },
  Effect.fnUntraced(function* ({ sessionId, cap, api }) {
    const apiUrl = yield* resolveApiUrl(api);

    const program = Effect.gen(function* () {
      const { client } = yield* SessionClient;
      const result = yield* client.setSessionBudget({
        sessionId,
        budget: cap,
      });
      yield* Console.log(budgetLine(result));
      yield* Console.log(result.message);
    });

    yield* reportFailures(Effect.provide(program, SessionClient.layer(apiUrl)));
  }),
).pipe(
  Command.withDescription("Set a session's spend cap"),
  Command.withExamples([
    {
      command: "factory budget ses_00000000000000000000000000 --cap 2.50",
      description:
        "Raise the cap a run hit to $2.50; the session's next message runs again",
    },
  ]),
);
