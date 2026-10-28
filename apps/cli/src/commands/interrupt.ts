import { SessionId } from "@repo/domain/Session";
import type { InterruptSessionResult } from "@repo/domain/Session";
import { Console, Effect } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { resolveApiUrl } from "../api";
import { reportFailures } from "../errors";
import { SessionClient } from "../rpc";

/**
 * The line `factory interrupt` prints: what the call came to, then the status the session settled
 * in. `not running` leads its line so a script can match the word, as it matches an error's code.
 */
export const interruptLine = (result: InterruptSessionResult): string =>
  result.outcome === "interrupted"
    ? `interrupted ${result.session.id}: ${result.session.status}`
    : `not running: ${result.session.id} is ${result.session.status}`;

/**
 * `factory interrupt <session-id>` — stop the session's run (C8, D9's steer and interrupt).
 *
 * The run settles without an answer, its queued messages are withdrawn, and the transcript ends the
 * turn with an `[interrupted]` line; a later `factory send` runs normally. The call returns once the
 * session is idle, so the status it prints is the settled one.
 *
 * A session with no run is `not running`, and exits 0: the session is already where the command
 * would put it. An unknown id is `error: not_found`, with a non-zero exit, as every command reports it.
 */
export const interruptCommand = Command.make(
  "interrupt",
  {
    sessionId: Argument.String("session-id").pipe(
      Argument.withDescription("Session whose run to stop"),
      Argument.withSchema(SessionId),
    ),
    api: Flag.String("api").pipe(
      Flag.withDescription("Control plane base URL"),
      Flag.optional,
    ),
  },
  Effect.fnUntraced(function* ({ sessionId, api }) {
    const apiUrl = yield* resolveApiUrl(api);

    const program = Effect.gen(function* () {
      const { client } = yield* SessionClient;
      const result = yield* client.interruptSession({ sessionId });
      yield* Console.log(interruptLine(result));
    });

    yield* reportFailures(Effect.provide(program, SessionClient.layer(apiUrl)));
  }),
).pipe(
  Command.withDescription("Interrupt a session's run"),
  Command.withExamples([
    {
      command: "factory interrupt ses_00000000000000000000000000",
      description: "Stop the run and print the status the session settled in",
    },
  ]),
);
