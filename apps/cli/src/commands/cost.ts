import { Console, Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import type {
  CostBacktest,
  CostBacktestRow,
  CostPrediction,
} from "@repo/domain/Cost";
import { RepoSlug } from "@repo/domain/Session";
import { resolveApiUrl } from "../api";
import { reportFailures } from "../errors";
import { SessionClient } from "../rpc";
import { formatDollars } from "../transcript";

/**
 * `factory cost` — cost prediction before a run (LOB-38): what a task would cost, as a range from the
 * completed sessions most like it (`predict`), and how wrong that has been on this control plane's
 * own history (`backtest`). `factory run` prints the same prediction line before it creates a
 * session, and `--cap-at-prediction` caps the session at the range's high.
 *
 * Every number is the server's (`predictCost`, `backtestCost`); this file only words them.
 */

const sessionsWord = (n: number): string =>
  `${n} ${n === 1 ? "session" : "sessions"}`;

const percent = (fraction: number): string => `${(fraction * 100).toFixed(1)}%`;

/**
 * The one line a prediction prints: the range and its median, how many sessions it is from and how
 * they were chosen; or, with too little history, that there is no range and why.
 */
export const predictionLine = (prediction: CostPrediction): string => {
  const what = `${prediction.shape} on ${prediction.model}`;
  const range = prediction.range;
  if (range === undefined) {
    return `predicted: no estimate (${sessionsWord(prediction.history)} completed, ${prediction.minimumComparables} comparable needed; ${what})`;
  }
  return `predicted ${formatDollars(range.low)} to ${formatDollars(range.high)}, median ${formatDollars(range.median)}, from ${sessionsWord(prediction.comparables)} (${prediction.basis}; ${what})`;
};

/**
 * The cap `--cap-at-prediction` asks for: the range's high, or a reason there is none — a history
 * too small to predict from, said in the terms `predictionLine` uses.
 */
export const predictedCap = (
  prediction: CostPrediction,
): { readonly cap: number } | { readonly refused: string } =>
  prediction.range === undefined
    ? {
        refused: `no prediction to cap at: ${sessionsWord(prediction.history)} completed, ${prediction.minimumComparables} comparable needed; pass --budget instead`,
      }
    : { cap: prediction.range.high };

/**
 * What `factory cost backtest` prints: the headline median error first — the number LOB-38
 * publishes — then the absolute error, how often the range held the actual, and, below the minimum
 * sample, that the number is too few to mean much.
 */
export const backtestLines = (report: CostBacktest): readonly string[] => {
  if (
    report.scored === 0 ||
    report.medianRelativeError === undefined ||
    report.medianAbsoluteError === undefined ||
    report.coverage === undefined
  ) {
    return [
      `backtest: no session could be scored (${sessionsWord(report.sessions)} completed; each needs ${report.minimumComparables} comparable before it)`,
    ];
  }
  const within = Math.round(report.coverage * report.scored);
  return [
    `backtest: median error ${percent(report.medianRelativeError)} over ${sessionsWord(report.scored)} (${report.skipped} skipped, ${report.sessions} completed)`,
    `median absolute error ${formatDollars(report.medianAbsoluteError)}`,
    `range held the actual in ${percent(report.coverage)} (${within} of ${report.scored})`,
    ...(report.meaningful
      ? []
      : [
          `too few to mean much: ${report.scored} of the ${report.minimumSample} scored sessions a meaningful number needs`,
        ]),
  ];
};

/** `factory cost backtest --rows`: one tab-separated line per scored session, oldest first. */
export const BACKTEST_ROWS_HEADER = [
  "id",
  "shape",
  "basis",
  "actual",
  "low",
  "median",
  "high",
  "error",
  "title",
].join("\t");

export const backtestRow = (row: CostBacktestRow): string =>
  [
    row.id,
    row.shape,
    row.basis,
    formatDollars(row.actual),
    formatDollars(row.range.low),
    formatDollars(row.range.median),
    formatDollars(row.range.high),
    percent(row.relativeError),
    row.title,
  ].join("\t");

const apiFlag = Flag.String("api").pipe(
  Flag.withDescription("Control plane base URL"),
  Flag.optional,
);

const repoFlag = Flag.String("repo").pipe(
  Flag.withDescription("Repository, as owner/name"),
  Flag.withSchema(RepoSlug),
  Flag.optional,
);

/** `factory cost predict "<task>"` — the range a run of the task would likely cost. */
const predictCommand = Command.make(
  "predict",
  {
    task: Argument.String("task").pipe(
      Argument.withDescription("The task a run would be given"),
    ),
    repo: repoFlag,
    model: Flag.String("model").pipe(
      Flag.withDescription(
        "Model the run would use, as provider/modelId; defaults to the server's",
      ),
      Flag.optional,
    ),
    api: apiFlag,
  },
  Effect.fnUntraced(function* ({ task, repo, model, api }) {
    const apiUrl = yield* resolveApiUrl(api);
    const program = Effect.gen(function* () {
      const { client } = yield* SessionClient;
      const prediction = yield* client.predictCost({
        prompt: task,
        ...(Option.isSome(repo) ? { repo: repo.value } : {}),
        ...(Option.isSome(model) ? { model: model.value } : {}),
      });
      yield* Console.log(predictionLine(prediction));
    });
    yield* reportFailures(Effect.provide(program, SessionClient.layer(apiUrl)));
  }),
).pipe(
  Command.withDescription(
    "Predict what a run of a task would cost, from the completed sessions most like it",
  ),
  Command.withExamples([
    {
      command: 'factory cost predict "fix the flaky test" --repo acme/web',
      description: "The likely range for a fix on acme/web",
    },
  ]),
);

/** `factory cost backtest` — how wrong the prediction has been on this control plane's sessions. */
const backtestCommand = Command.make(
  "backtest",
  {
    repo: repoFlag,
    rows: Flag.Boolean("rows").pipe(
      Flag.withDescription("Also print every scored session, oldest first"),
      Flag.withDefault(false),
    ),
    api: apiFlag,
  },
  Effect.fnUntraced(function* ({ repo, rows, api }) {
    const apiUrl = yield* resolveApiUrl(api);
    const program = Effect.gen(function* () {
      const { client } = yield* SessionClient;
      // The scored rows travel only when they will be printed.
      const report = yield* client.backtestCost({
        ...(Option.isSome(repo) ? { repo: repo.value } : {}),
        ...(rows ? { rows: true } : {}),
      });
      for (const line of backtestLines(report)) yield* Console.log(line);
      const scored = report.rows ?? [];
      if (rows && scored.length > 0) {
        yield* Console.log(BACKTEST_ROWS_HEADER);
        for (const row of scored) yield* Console.log(backtestRow(row));
      }
    });
    yield* reportFailures(Effect.provide(program, SessionClient.layer(apiUrl)));
  }),
).pipe(
  Command.withDescription(
    "Backtest the cost prediction on the completed sessions: each predicted from the ones before it",
  ),
);

export const costCommand = Command.make("cost").pipe(
  Command.withDescription(
    "Predict what a run will cost, and say how wrong the prediction has been",
  ),
  Command.withSubcommands([predictCommand, backtestCommand]),
);
