import type { ReplayComparison, ReplayRun } from "@repo/domain/Session";
import { SessionId } from "@repo/domain/Session";
import { Console, Duration, Effect, Option, Schedule, Schema } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { resolveApiUrl } from "../api";
import { reportFailures } from "../errors";
import { BoardClient } from "../rpc";
import { followSession, formatDollars } from "../transcript";

/**
 * `--model` names a model the control plane does not serve (LOB-200). Checked against
 * `getServerInfo` before anything is replayed, so the refusal names the whole allowed list and no
 * replay is opened for a mistake. The server refuses the same name too, but its `invalid_input`
 * says only which name it did not find, not which are allowed. `errors.ts` reports this as
 * `error: unknown_replay_model: …`.
 */
export class UnknownReplayModel extends Schema.TaggedError<UnknownReplayModel>()(
  "UnknownReplayModel",
  {
    model: Schema.String,
    allowed: Schema.Array(Schema.String),
    message: Schema.String,
  },
) {}

/** The replay was opened but its comparison is not on the log after the wait (see `awaitComparison`). */
export class ReplayComparisonPending extends Schema.TaggedError<ReplayComparisonPending>()(
  "ReplayComparisonPending",
  { replay: Schema.String, message: Schema.String },
) {}

/**
 * `model` as one of the models the control plane serves, or an `UnknownReplayModel` that lists them.
 * `served` is `getServerInfo().models`, which is the catalog `replaySession` resolves a name against.
 */
export const requireServedModel = (
  model: string,
  served: readonly string[],
): Effect.Effect<string, UnknownReplayModel> =>
  served.includes(model)
    ? Effect.succeed(model)
    : Effect.fail(
        new UnknownReplayModel({
          model,
          allowed: served,
          message: `model ${model} is not one this control plane serves; allowed: ${served.join(", ")}`,
        }),
      );

/** How a side's task settled: `unanswered` carries Pi Durable's reason, which is the useful part. */
const resultCell = (run: ReplayRun): string =>
  run.outcome === "unanswered" && run.reason !== undefined
    ? `unanswered (${run.reason})`
    : run.outcome;

/** A fork's copied prefix is its parent's run, so it is shown beside `turns` and never inside it. */
const turnsCell = (run: ReplayRun): string =>
  run.inherited === undefined || run.inherited.turns === 0
    ? String(run.turns)
    : `${run.turns} (+${run.inherited.turns} inherited)`;

/**
 * `amount` with its sign, or unsigned when it prints as zero. The sign is decided from the
 * *formatted* magnitude, not the raw number: a cost delta of $0.00003 prints as `$0.0000`, and
 * `+$0.0000` would read as a change of nothing.
 */
const signed = (amount: number, format: (magnitude: number) => string) => {
  const magnitude = format(Math.abs(amount));
  return magnitude === format(0)
    ? magnitude
    : amount > 0
      ? `+${magnitude}`
      : `-${magnitude}`;
};

/**
 * The comparison as the table `factory replay` prints: one column per side, then the delta.
 *
 * Read from the *replay's* comparison, so the columns are `source` (its counterpart) and `replay`
 * (itself) and the delta is the replay's minus the source's — "what changing the model did". The
 * delta is the one the log stored, not a subtraction made here: both sessions carry the same
 * reading, and a client that recomputed it could disagree with them. `model` is empty when the
 * source recorded none, which is a session that ran no turn.
 */
export const formatComparison = (
  comparison: ReplayComparison,
): readonly string[] => {
  const source = comparison.counterpart;
  const replay = comparison.self;
  const rows: readonly (readonly [string, string, string, string])[] = [
    ["", "source", "replay", "delta"],
    ["session", source.session, replay.session, ""],
    [
      "model",
      source.model === "" ? "(none recorded)" : source.model,
      replay.model,
      "",
    ],
    ["result", resultCell(source), resultCell(replay), ""],
    [
      "turns",
      turnsCell(source),
      turnsCell(replay),
      signed(comparison.delta.turns, String),
    ],
    [
      "cost",
      formatDollars(source.cost),
      formatDollars(replay.cost),
      signed(comparison.delta.cost, formatDollars),
    ],
  ];
  const widths = [0, 1, 2].map((column) =>
    Math.max(...rows.map((row) => row[column]?.length ?? 0)),
  );
  return rows.map((row) =>
    [
      row[0].padEnd(widths[0] ?? 0),
      row[1].padEnd(widths[1] ?? 0),
      row[2].padEnd(widths[2] ?? 0),
      row[3],
    ]
      .join("  ")
      .trimEnd(),
  );
};

/** The replay's own comparison against `source`, among every one its session holds. */
export const comparisonAgainst = (
  comparisons: readonly ReplayComparison[] | undefined,
  source: string,
): ReplayComparison | undefined =>
  comparisons?.find(
    (comparison) =>
      comparison.role === "replay" && comparison.counterpart.session === source,
  );

/** How long the CLI waits for the comparison once the replay's transcript has settled. */
export const COMPARISON_WAIT = Duration.seconds(30);
const COMPARISON_POLL = Duration.millis(250);

/**
 * Wait for the replay's comparison to be on its log.
 *
 * The control plane writes it in the background once the replay's task settles (LOB-199), so it is
 * normally there a moment after the transcript stream ends and sometimes not yet: this polls
 * `read` until it answers one. Past `wait` it fails as `ReplayComparisonPending` naming the replay,
 * because the replay itself exists and a later `getSession` will have the comparison — a timeout is
 * a report of that, not a failure to replay.
 */
export const awaitComparison = <E, R>(
  read: Effect.Effect<ReplayComparison | undefined, E, R>,
  replay: string,
  options: {
    readonly wait?: Duration.Input;
    readonly poll?: Duration.Input;
  } = {},
): Effect.Effect<ReplayComparison, E | ReplayComparisonPending, R> =>
  Effect.gen(function* () {
    const wait = options.wait ?? COMPARISON_WAIT;
    const found = yield* read.pipe(
      Effect.repeat({
        schedule: Schedule.spaced(options.poll ?? COMPARISON_POLL),
        until: (comparison) => comparison !== undefined,
      }),
      Effect.timeoutOption(wait),
    );
    if (Option.isNone(found) || found.value === undefined) {
      return yield* new ReplayComparisonPending({
        replay,
        message: `replay ${replay} was opened but its comparison is not recorded after ${Duration.format(Duration.fromInputUnsafe(wait))}; \`factory watch ${replay}\` follows it`,
      });
    }
    return found.value;
  });

/**
 * `factory replay <session-id> [--model <provider/modelId>]` — run a recorded session's task again,
 * in a new session on another model, and print how the two compare (LOB-200, LOB-39).
 *
 * It opens the replay (`replaySession`), follows the replay's transcript as `factory run` does, then
 * prints the comparison the control plane stored on both sessions (`replayComparisons`, LOB-199):
 * result, turns and cost per side, and the delta. Nothing here measures anything — the numbers are
 * the log's, so a later `getSession` on either session reports the same table.
 *
 * Without `--model` the replay runs on the control plane's own model: the same task and model in a
 * new log. A session that cannot be replayed (bound to no repo, nothing to replay) is the server's
 * refusal, printed as it is worded.
 */
export const replayCommand = Command.make(
  "replay",
  {
    sessionId: Argument.String("session-id").pipe(
      Argument.withDescription("Session whose task to run again"),
      Argument.withSchema(SessionId),
    ),
    model: Flag.String("model").pipe(
      Flag.withDescription(
        "Model to replay onto, as provider/modelId (the control plane's own model when absent)",
      ),
      Flag.optional,
    ),
    api: Flag.String("api").pipe(
      Flag.withDescription("Control plane base URL"),
      Flag.optional,
    ),
  },
  Effect.fnUntraced(function* ({ sessionId, model, api }) {
    const apiUrl = yield* resolveApiUrl(api);

    const program = Effect.gen(function* () {
      const { client } = yield* BoardClient;

      if (Option.isSome(model)) {
        const info = yield* client.getServerInfo({});
        yield* requireServedModel(model.value, info.models);
      }

      const replay = yield* client.replaySession({
        sessionId,
        ...Option.match(model, {
          onNone: () => ({}),
          onSome: (value) => ({ model: value }),
        }),
      });
      yield* Console.log(`replay ${replay.id} of ${sessionId}`);

      const { answer } = yield* followSession(client, replay.id, {
        printMode: false,
      });
      yield* Console.log(`answer: ${answer ?? "(no answer)"}`);

      const comparison = yield* awaitComparison(
        client
          .getSession({ sessionId: replay.id })
          .pipe(
            Effect.map((snapshot) =>
              comparisonAgainst(snapshot.replayComparisons, sessionId),
            ),
          ),
        replay.id,
      );
      for (const line of formatComparison(comparison)) {
        yield* Console.log(line);
      }
    });

    yield* reportFailures(Effect.provide(program, BoardClient.layer(apiUrl)));
  }),
).pipe(
  Command.withDescription(
    "Replay a session's task on another model and print the comparison",
  ),
  Command.withExamples([
    {
      command:
        "factory replay ses_00000000000000000000000000 --model anthropic/claude-haiku-4-5",
      description: "Run the same task on another model and compare the runs",
    },
    {
      command: "factory replay ses_00000000000000000000000000",
      description: "Run it again on the control plane's own model",
    },
  ]),
);
