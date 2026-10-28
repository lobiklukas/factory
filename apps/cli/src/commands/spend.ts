import type { SpendReport, SpendRow } from "@repo/domain/Session";
import { RepoSlug, SessionActor } from "@repo/domain/Session";
import { Console, Effect, Option } from "effect";
import { Command, Flag } from "effect/cli";
import { resolveApiUrl } from "../api";
import { reportFailures } from "../errors";
import { SessionClient } from "../rpc";
import { formatDollars } from "../transcript";

/**
 * `factory spend` — what the sessions cost, keyed by repo and actor (LOB-162): the terminal's copy
 * of the dashboard's spend pane. Every number is `listSpend`'s; the filters only choose rows of it,
 * and the total line is those rows added, so it is the server's own total when nothing is filtered.
 */

/** What a session bound to no repo, or one nobody was attributed, prints as: `factory ls`'s `-`. */
export const NO_VALUE = "-";

/** The header `factory spend` prints above its rows: one name per column, in row order. */
export const SPEND_HEADER = "repo  actor  sessions  cost";

const sessionsWord = (n: number): string =>
  `${n} ${n === 1 ? "session" : "sessions"}`;

/** One (repo, actor) pair as a row; the cost is last and `$`-prefixed, so a row splits on whitespace. */
export const spendRow = (row: SpendRow): string =>
  [
    row.repo ?? NO_VALUE,
    row.actor ?? NO_VALUE,
    String(row.sessions),
    formatDollars(row.costTotal),
  ].join("  ");

/** The report narrowed to the rows that match every filter given, with the totals recomputed. */
export const filterSpend = (
  report: SpendReport,
  filters: {
    readonly repo?: string | undefined;
    readonly actor?: string | undefined;
  },
): SpendReport => {
  if (filters.repo === undefined && filters.actor === undefined) return report;
  const rows = report.rows.filter(
    (row) =>
      (filters.repo === undefined || row.repo === filters.repo) &&
      (filters.actor === undefined || row.actor === filters.actor),
  );
  return {
    rows,
    sessions: rows.reduce((sum, row) => sum + row.sessions, 0),
    costTotal: rows.reduce((sum, row) => sum + row.costTotal, 0),
  };
};

/** The table `factory spend` prints: the header, a row per pair, then the totals. */
export const spendLines = (report: SpendReport): readonly string[] => [
  SPEND_HEADER,
  ...report.rows.map(spendRow),
  `total  ${sessionsWord(report.sessions)}  ${formatDollars(report.costTotal)}`,
];

export const spendCommand = Command.make(
  "spend",
  {
    repo: Flag.String("repo").pipe(
      Flag.withDescription("Only this repository, as owner/name"),
      Flag.withSchema(RepoSlug),
      Flag.optional,
    ),
    actor: Flag.String("actor").pipe(
      Flag.withDescription("Only sessions attributed to this actor"),
      Flag.withSchema(SessionActor),
      Flag.optional,
    ),
    api: Flag.String("api").pipe(
      Flag.withDescription("Control plane base URL"),
      Flag.optional,
    ),
  },
  Effect.fnUntraced(function* ({ repo, actor, api }) {
    const apiUrl = yield* resolveApiUrl(api);
    const program = Effect.gen(function* () {
      const { client } = yield* SessionClient;
      const report = filterSpend(yield* client.listSpend({}), {
        repo: Option.getOrUndefined(repo),
        actor: Option.getOrUndefined(actor),
      });
      for (const line of spendLines(report)) yield* Console.log(line);
    });
    yield* reportFailures(Effect.provide(program, SessionClient.layer(apiUrl)));
  }),
).pipe(
  Command.withDescription(
    "Print what sessions cost, per repository and actor, with the total",
  ),
  Command.withExamples([
    {
      command: "factory spend --repo acme/web --actor alice",
      description: "One repository's spend by one actor",
    },
  ]),
);
