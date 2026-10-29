import { repoContextText, type SessionContext } from "@repo/domain/RepoContext";
import { SessionId, type SessionSnapshot } from "@repo/domain/Session";
import { Console, Effect } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { resolveApiUrl } from "../api";
import { reportFailures } from "../errors";
import { SessionClient } from "../rpc";

/**
 * The lines `factory show` prints: one `name value` per fact about a session, the way
 * `factory status` prints the server's. `context` is what the session's run was told about its
 * repository (F19): "no repo instructions", or "told AGENTS.md (5823 bytes, 1522 tokens) and 8 repo
 * skills" with a truncated file and shadowed skills called out, so an operator need not read the log
 * to know what a run was given.
 */
export const showLines = (
  snapshot: SessionSnapshot,
  context: SessionContext,
): readonly string[] => {
  const { session, workspace } = snapshot;
  return [
    `session ${session.id}`,
    `title ${session.title === "" ? "-" : session.title}`,
    `status ${session.status}`,
    `repo ${session.repo ?? "-"}${session.baseRef === undefined ? "" : ` base-ref ${session.baseRef}`}`,
    `workspace ${workspace.path}`,
    `model ${session.model ?? "unknown"}`,
    `pr ${session.prUrl ?? "-"}`,
    `context ${repoContextText(context.repo)}`,
    ...(context.repo === undefined
      ? []
      : [
          `context-read ${context.repo.ref} (${context.repo.commit.slice(0, 12)})`,
        ]),
    ...(context.repo?.skills.nested ?? []).map(
      (path) => `context-nested ${path}`,
    ),
    ...(context.repo?.skills.dropped ?? []).map(
      (path) => `context-dropped ${path}`,
    ),
    ...(context.repo?.skills.shadowed ?? []).map(
      (path) => `context-shadowed ${path}`,
    ),
  ];
};

/**
 * `factory show <session-id>` — what the control plane knows of one session: its status, repo,
 * workspace, model and PR, and what its run was told about its repository (F19).
 *
 * Read from the session's snapshot and its recorded context, so it answers for a session no process
 * owns. An unknown id is `error: not_found`, with a non-zero exit, as every command reports it.
 */
export const showCommand = Command.make(
  "show",
  {
    sessionId: Argument.String("session-id").pipe(
      Argument.withDescription("Session to show"),
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
      const snapshot = yield* client.getSession({ sessionId });
      const context = yield* client.getSessionContext({ sessionId });
      for (const line of showLines(snapshot, context)) {
        yield* Console.log(line);
      }
    });

    yield* reportFailures(Effect.provide(program, SessionClient.layer(apiUrl)));
  }),
).pipe(
  Command.withDescription(
    "Show a session's status, workspace, PR and what its run was told about its repo",
  ),
  Command.withExamples([
    {
      command: "factory show ses_00000000000000000000000000",
      description:
        "Print the session's facts and its `context` line (the repo instructions its run was given)",
    },
  ]),
);
