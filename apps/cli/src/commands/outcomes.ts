import { Console, Effect, Option, Schema } from "effect";
import { Command, Flag } from "effect/cli";
import { OutcomeReport, type OutcomeValue } from "@repo/domain/Outcomes";
import { RepoSlug } from "@repo/domain/Session";
import { resolveApiUrl } from "../api";
import { reportFailure, reportFailures } from "../errors";
import { SessionClient } from "../rpc";

/** The report as `--json` prints it: the wire schema's own encoding, indented. */
const encodeReport = Schema.encodeEffect(
  Schema.fromJsonString(OutcomeReport, { space: 2 }),
);

/** The header `factory outcomes` prints above its rows. */
export const OUTCOMES_HEADER = "metric  name  value  unit  denominator  of";

/** A value as a person reads it: `-` for none (an empty denominator), otherwise the number. */
const shown = (value: OutcomeValue): string => {
  if (value.value === null) return "-";
  switch (value.unit) {
    case "ratio":
      return value.value.toFixed(3);
    case "seconds":
      return value.value.toFixed(1);
    case "usd":
      return value.value.toFixed(4);
    case "count":
      return String(value.value);
  }
};

/**
 * One `factory outcomes` row: the metric, the value's name, the value, its unit, and its denominator
 * — the count and what it counts, last because it is the one field with spaces in it. The window is
 * the report's, printed once above the rows; `--json` carries it on every value.
 */
export const outcomeRow = (value: OutcomeValue): string =>
  [
    value.metric,
    value.name,
    shown(value),
    value.unit,
    String(value.denominator.count),
    value.denominator.of,
  ].join("  ");

/** Every line `factory outcomes` prints for a report: the window, the header, one row per value. */
export const outcomeLines = (report: OutcomeReport): readonly string[] => [
  `window ${report.window.since} ${report.window.until}${report.repo === undefined ? "" : ` repo ${report.repo}`}`,
  OUTCOMES_HEADER,
  ...report.values.map(outcomeRow),
];

/**
 * `factory outcomes` — is the factory accelerating delivery? (LOB-44)
 *
 * The outcome metrics over a window: lead time, cycle time, defect pressure, recovery, adoption and
 * cost, each with its denominator (`@repo/core`'s `outcomes.ts` defines every one). Read from the
 * server's index tables, never from GitHub or Linear. `--json` prints the report as the server sent
 * it, every value with its window, denominator and source.
 */
export const outcomesCommand = Command.make(
  "outcomes",
  {
    since: Flag.String("since").pipe(
      Flag.withDescription(
        "Window start, an ISO-8601 instant (default: 30 days before --until)",
      ),
      Flag.optional,
    ),
    until: Flag.String("until").pipe(
      Flag.withDescription("Window end, exclusive (default: now)"),
      Flag.optional,
    ),
    repo: Flag.String("repo").pipe(
      Flag.withDescription("Only this repo's cards and sessions (owner/name)"),
      Flag.optional,
    ),
    json: Flag.Boolean("json").pipe(
      Flag.withDescription("Print the report as JSON"),
      Flag.withDefault(false),
    ),
    api: Flag.String("api").pipe(
      Flag.withDescription("Control plane base URL"),
      Flag.optional,
    ),
  },
  Effect.fnUntraced(function* ({ since, until, repo, json, api }) {
    const apiUrl = yield* resolveApiUrl(api);
    const slug = Option.isSome(repo)
      ? Schema.decodeOption(RepoSlug)(repo.value)
      : Option.none();
    if (Option.isSome(repo) && Option.isNone(slug)) {
      return yield* reportFailure(
        "invalid_input",
        `--repo is not owner/name: "${repo.value}"`,
      );
    }

    const program = Effect.gen(function* () {
      const { client } = yield* SessionClient;
      const report = yield* client.getOutcomes({
        ...(Option.isSome(since) ? { since: since.value } : {}),
        ...(Option.isSome(until) ? { until: until.value } : {}),
        ...(Option.isSome(slug) ? { repo: slug.value } : {}),
      });
      if (json) {
        yield* Console.log(yield* encodeReport(report));
        return;
      }
      for (const line of outcomeLines(report)) yield* Console.log(line);
    });

    yield* reportFailures(Effect.provide(program, SessionClient.layer(apiUrl)));
  }),
).pipe(
  Command.withDescription(
    "Outcome metrics over a window: lead time, cycle time, defect pressure, recovery, adoption, cost",
  ),
  Command.withExamples([
    {
      command: "factory outcomes",
      description: "The last 30 days, every repo",
    },
    {
      command:
        "factory outcomes --since 2026-10-01T00:00:00Z --repo acme/widgets --json",
      description:
        "One repo since October, with every value's window and source",
    },
  ]),
);
