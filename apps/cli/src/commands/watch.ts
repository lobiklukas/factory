import { SessionId } from "@repo/domain/Session";
import { Console, Effect } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { resolveApiUrl } from "../api";
import { reportFailures } from "../errors";
import { SessionClient } from "../rpc";
import { followSession } from "../transcript";

/**
 * `factory watch <session-id>` — attach to any session and print the read-path mode label first.
 *
 * The label is the point (docs/design.md D8): `live` means this control plane owns the session and
 * is streaming commits as they land; `historical` means it folded the log and the stream will end
 * after one snapshot. A caller that cannot tell them apart cannot tell a finished run from a
 * paused one.
 */
export const watchCommand = Command.make(
  "watch",
  {
    sessionId: Argument.String("session-id").pipe(
      Argument.withDescription("Session to attach to"),
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
      const { answer } = yield* followSession(client, sessionId, {
        printMode: true,
      });
      yield* Console.log(`answer: ${answer ?? "(no answer)"}`);
    });

    yield* reportFailures(Effect.provide(program, SessionClient.layer(apiUrl)));
  }),
).pipe(
  Command.withDescription("Attach to a session and stream its transcript"),
  Command.withExamples([
    {
      command: "factory watch ses_00000000000000000000000000",
      description: "Follow a session by id",
    },
  ]),
);
