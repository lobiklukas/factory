import { SessionId, WhenBusy } from "@repo/domain/Session";
import { Console, Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { resolveApiUrl } from "../api";
import { reportFailures } from "../errors";
import { SessionClient } from "../rpc";

/**
 * `factory send <session-id> "<message>"` — hand an existing session one more message and return.
 *
 * `run` sends one task and follows it; this is the other half of driving a session from a terminal
 * (LOB-166): a steer or a follow-up while a run is in flight, which Pi Durable queues rather than
 * interrupting for. The line it prints is the server's answer — the submission id a later
 * `factory withdraw` names, and where the message landed (`run`, `steer`, or `followUp`) — so a
 * script reads what happened instead of inferring it from the transcript.
 *
 * `--when-busy reject` is refused with `error: busy` when the session is running, which is the
 * typed code a script branches on (docs/design.md D9).
 */
export const sendCommand = Command.make(
  "send",
  {
    sessionId: Argument.String("session-id").pipe(
      Argument.withDescription("Session to send the message to"),
      Argument.withSchema(SessionId),
    ),
    message: Argument.String("message").pipe(
      Argument.withDescription("The message"),
    ),
    whenBusy: Flag.Literals("when-busy", WhenBusy.literals).pipe(
      Flag.withDescription(
        "What a running session does with it: steer the current run, follow up after it, or reject",
      ),
      Flag.optional,
    ),
    api: Flag.String("api").pipe(
      Flag.withDescription("Control plane base URL"),
      Flag.optional,
    ),
  },
  Effect.fnUntraced(function* ({ sessionId, message, whenBusy, api }) {
    const apiUrl = yield* resolveApiUrl(api);

    const program = Effect.gen(function* () {
      const { client } = yield* SessionClient;
      const sent = yield* client.sendMessage({
        sessionId,
        content: message,
        ...Option.match(whenBusy, {
          onNone: () => ({}),
          onSome: (value) => ({ whenBusy: value }),
        }),
      });
      yield* Console.log(
        `submission ${sent.submissionId} placement ${sent.placement}`,
      );
    });

    yield* reportFailures(Effect.provide(program, SessionClient.layer(apiUrl)));
  }),
).pipe(
  Command.withDescription("Send a message to a session without following it"),
  Command.withExamples([
    {
      command:
        'factory send ses_00000000000000000000000000 "also fix the docs" --when-busy steer',
      description: "Steer a running session",
    },
  ]),
);
