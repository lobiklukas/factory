import { RepoSlug } from "@repo/domain/Session";
import { Console, Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { resolveApiUrl } from "../api";
import { reportFailures } from "../errors";
import { SessionClient } from "../rpc";
import { followSession } from "../transcript";

/**
 * `factory run "<task>"` — mint a session, hand it the task, and follow the transcript until the
 * run settles.
 *
 * `--repo` binds the session to a repository (and registers it on first use); `--base-ref` picks
 * the ref it starts from. The workspace line is the server's own answer for where the work will
 * live, so the run proves the read path as well as the write.
 */
export const runCommand = Command.make(
  "run",
  {
    task: Argument.String("task").pipe(
      Argument.withDescription("The task to delegate to the session"),
    ),
    repo: Flag.String("repo").pipe(
      Flag.withDescription("Repository to work on, as owner/name"),
      Flag.withSchema(RepoSlug),
      Flag.optional,
    ),
    baseRef: Flag.String("base-ref").pipe(
      Flag.withDescription("Ref the session starts from"),
      Flag.optional,
    ),
    api: Flag.String("api").pipe(
      Flag.withDescription("Control plane base URL"),
      Flag.optional,
    ),
  },
  Effect.fnUntraced(function* ({ task, repo, baseRef, api }) {
    const apiUrl = yield* resolveApiUrl(api);

    const program = Effect.gen(function* () {
      const { client } = yield* SessionClient;

      const input: { repo?: RepoSlug; baseRef?: string } = {};
      if (Option.isSome(repo)) input.repo = repo.value;
      if (Option.isSome(baseRef)) input.baseRef = baseRef.value;

      const session = yield* client.createSession(input);
      yield* Console.log(`session ${session.id}`);

      const opened = yield* client.getSession({ sessionId: session.id });
      yield* Console.log(`workspace ${opened.workspace.path}`);
      if (opened.workspace.repo !== undefined) {
        const ref =
          opened.workspace.baseRef === undefined
            ? ""
            : ` base-ref ${opened.workspace.baseRef}`;
        yield* Console.log(`repo ${opened.workspace.repo}${ref}`);
      }

      yield* client.sendMessage({ sessionId: session.id, content: task });

      const { answer } = yield* followSession(client, session.id, {
        printMode: false,
      });
      yield* Console.log(`answer: ${answer ?? "(no answer)"}`);
    });

    yield* reportFailures(Effect.provide(program, SessionClient.layer(apiUrl)));
  }),
).pipe(
  Command.withDescription(
    "Create a session, send it a task, and stream the transcript",
  ),
  Command.withExamples([
    {
      command: 'factory run "fix the flaky test"',
      description: "Run a task in a scratch session",
    },
    {
      command: 'factory run "tighten the parser" --repo lobiklukas/factory',
      description: "Run a task against a repository",
    },
  ]),
);
