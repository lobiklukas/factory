import { Console, Effect, Option } from "effect";
import { Command, Flag } from "effect/cli";
import { resolveApiUrl } from "../api";
import { reportFailures } from "../errors";
import { SessionClient } from "../rpc";

/**
 * `factory ls` — the server's list of sessions, newest activity first.
 *
 * One row per session with the fields the index already carries (id, status, repo, title, last
 * activity, spend); nothing here folds a log. When the server has more than a page it returns a
 * keyset cursor, which is echoed so `--cursor` can ask for the next page.
 */
export const lsCommand = Command.make(
  "ls",
  {
    limit: Flag.Int("limit").pipe(
      Flag.withDescription("Page size (the server clamps it)"),
      Flag.optional,
    ),
    cursor: Flag.String("cursor").pipe(
      Flag.withDescription("Keyset cursor from a previous page"),
      Flag.optional,
    ),
    api: Flag.String("api").pipe(
      Flag.withDescription("Control plane base URL"),
      Flag.optional,
    ),
  },
  Effect.fnUntraced(function* ({ limit, cursor, api }) {
    const apiUrl = yield* resolveApiUrl(api);

    const program = Effect.gen(function* () {
      const { client } = yield* SessionClient;

      const input: { limit?: number; cursor?: string } = {};
      if (Option.isSome(limit)) input.limit = limit.value;
      if (Option.isSome(cursor)) input.cursor = cursor.value;

      const output = yield* client.listSessions(input);

      if (output.sessions.length === 0) {
        yield* Console.log("no sessions");
      } else {
        yield* Console.log("id  status  repo  last-activity  cost  title");
        for (const session of output.sessions) {
          yield* Console.log(
            [
              session.id,
              session.status,
              session.repo ?? "-",
              session.lastActivityAt,
              String(session.costTotal),
              session.title,
            ].join("  "),
          );
        }
      }

      if (output.nextCursor !== undefined) {
        yield* Console.log(`cursor: ${output.nextCursor}`);
      }
    });

    yield* reportFailures(Effect.provide(program, SessionClient.layer(apiUrl)));
  }),
).pipe(
  Command.withDescription("List sessions, newest activity first"),
  Command.withExamples([
    { command: "factory ls", description: "List the newest sessions" },
    {
      command: "factory ls --limit 10 --cursor <cursor>",
      description: "Ask for the next page",
    },
  ]),
);
