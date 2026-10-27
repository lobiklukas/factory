import { Console, Effect, Option } from "effect";
import { Command, Flag } from "effect/cli";
import type { SessionListEntry } from "@repo/domain/Session";
import { resolveApiUrl } from "../api";
import { reportFailures } from "../errors";
import { SessionClient } from "../rpc";

/**
 * What the `pr` column says for a session no PR was opened for (LOB-65).
 *
 * The same `-` the `repo` column already prints for an unbound session, so the table has one
 * spelling for "nothing here" — and never an empty cell, which on a two-space-separated line would
 * shift every column after it and read as the title.
 */
export const NO_PR = "-";

/** The header `factory ls` prints above its rows: one name per column, in row order. */
export const LS_HEADER = "id  status  repo  last-activity  cost  pr  title";

/**
 * One `factory ls` row.
 *
 * The title is last because it is the only field that may contain spaces: everything before it is
 * one token, so a script can split the line on whitespace and read the PR link as the sixth field.
 */
export const lsRow = (session: SessionListEntry): string =>
  [
    session.id,
    session.status,
    session.repo ?? "-",
    session.lastActivityAt,
    String(session.costTotal),
    session.prUrl ?? NO_PR,
    session.title,
  ].join("  ");

/**
 * `factory ls` — the server's list of sessions, newest activity first.
 *
 * One row per session with the fields the index already carries (id, status, repo, last activity,
 * spend, the PR link once one was opened, title); nothing here folds a log. When the server has more
 * than a page it returns a keyset cursor, which is echoed so `--cursor` can ask for the next page.
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
        yield* Console.log(LS_HEADER);
        for (const session of output.sessions) {
          yield* Console.log(lsRow(session));
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
