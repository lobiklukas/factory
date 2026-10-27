import { SessionId } from "@repo/domain/Session";
import type { ReleaseWorkspaceResult } from "@repo/domain/Session";
import { Console, Effect } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { resolveApiUrl } from "../api";
import { reportFailures } from "../errors";
import { SessionClient } from "../rpc";

/** The line `factory discard` prints: what was released, and whether this call released it. */
export const discardLine = (result: ReleaseWorkspaceResult): string =>
  result.first
    ? `discarded ${result.sessionId}: its worktree and branch are removed`
    : `${result.sessionId} was already released (${result.release.reason} at ${result.release.at})`;

/**
 * `factory discard <session-id>` — an operator's terminal event for a session (LOB-268): its
 * worktree and branch are torn down, a run still going is interrupted first, and the session takes
 * no new message afterwards. Its transcript stays readable.
 *
 * Nothing else an operator does removes a session's work — leaving it idle, or restarting the API,
 * keeps the worktree and branch for its next run — so this is the way to say the work is abandoned.
 * A repeat exits 0 and names the first release, as the RPC answers it.
 */
export const discardCommand = Command.make(
  "discard",
  {
    sessionId: Argument.String("session-id").pipe(
      Argument.withDescription("Session whose worktree and branch to remove"),
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
      const result = yield* client.discardSession({ sessionId });
      yield* Console.log(discardLine(result));
    });

    yield* reportFailures(Effect.provide(program, SessionClient.layer(apiUrl)));
  }),
).pipe(
  Command.withDescription(
    "Discard a session: remove its worktree and branch, and stop it taking runs",
  ),
  Command.withExamples([
    {
      command: "factory discard ses_00000000000000000000000000",
      description: "Abandon the session's work",
    },
  ]),
);
