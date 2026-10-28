import { SessionId } from "@repo/domain/Session";
import { Console, Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { resolveApiUrl } from "../api";
import { reportFailures } from "../errors";
import { SessionClient } from "../rpc";
import { formatEarlier, formatEntry, readEarlier } from "../transcript";

/**
 * `factory history <session-id> --before <entry-id> [--limit n] [--all]` — the part of a long
 * session's transcript `factory watch` did not print (LOB-243).
 *
 * A historical read carries the newest entries only, and `watch` opens with an `[earlier]` line
 * naming the oldest entry it printed; that id is this command's `--before`. One page is printed
 * oldest first, under an `[earlier]` line of its own when there is still more before it; `--all`
 * pages back to the first entry instead.
 */
export const historyCommand = Command.make(
  "history",
  {
    sessionId: Argument.String("session-id").pipe(
      Argument.withDescription("Session to read"),
      Argument.withSchema(SessionId),
    ),
    before: Flag.String("before").pipe(
      Flag.withDescription(
        "Print the entries before this entry id (the one an `[earlier]` line names)",
      ),
    ),
    limit: Flag.Int("limit").pipe(
      Flag.withDescription(
        "Entries per page (the server's default when absent, at most 500)",
      ),
      Flag.optional,
    ),
    all: Flag.Boolean("all").pipe(
      Flag.withDescription("Page back to the first entry"),
      Flag.withDefault(false),
    ),
    ids: Flag.Boolean("ids").pipe(
      Flag.withDescription(
        "Print each entry's id as [kind#id], the id `factory fork --at` takes",
      ),
      Flag.withDefault(false),
    ),
    api: Flag.String("api").pipe(
      Flag.withDescription("Control plane base URL"),
      Flag.optional,
    ),
  },
  Effect.fnUntraced(function* ({ sessionId, before, limit, all, ids, api }) {
    const apiUrl = yield* resolveApiUrl(api);

    const program = Effect.gen(function* () {
      const { client } = yield* SessionClient;
      const page = yield* readEarlier(
        (cursor) =>
          client.readSessionHistory({
            sessionId,
            before: cursor,
            ...Option.match(limit, {
              onNone: () => ({}),
              onSome: (value) => ({ limit: value }),
            }),
          }),
        before,
        { all },
      );
      if (page.earlier !== undefined) {
        yield* Console.log(formatEarlier(page.earlier, sessionId));
      }
      for (const entry of page.entries) {
        // The same lines `watch` prints: an entry with no text is a marker, not a line.
        if (entry.text.trim() !== "")
          yield* Console.log(formatEntry(entry, { ids }));
      }
    });

    yield* reportFailures(Effect.provide(program, SessionClient.layer(apiUrl)));
  }),
).pipe(
  Command.withDescription(
    "Print the earlier entries of a long session's transcript",
  ),
  Command.withExamples([
    {
      command:
        "factory history ses_00000000000000000000000000 --before 301 --all",
      description: "Print every entry before entry 301",
    },
  ]),
);
