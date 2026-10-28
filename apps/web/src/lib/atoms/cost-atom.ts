import { RepoSlug } from "@repo/domain/Session";
import { Duration, Effect, Option, Schema } from "effect";
import { Atom } from "effect/reactivity";
import { runtime } from "../atom";
import { fromPredictionKey } from "../cost-view";
import { modelInput } from "../model-picker-view";
import { RpcClient } from "../rpc-client";
import { SESSIONS_KEY } from "./session-list";

/**
 * What a session would cost before it exists (LOB-38): `predictCost` for one prompt, one model
 * choice and one repo (none for a scratch session, E6), keyed by `predictionKey`. The server's default choice sends no model, as a create with it
 * does, so the prediction is for the model the session would really run. Re-read when a session is
 * started from this dashboard (`SESSIONS_KEY`), and every `PREDICTION_REFRESH`: a run only becomes
 * history once it finishes, which no event here announces, so the poll is what picks it up. A blank
 * prompt is answered `undefined` without a request.
 */
export const PREDICTION_REFRESH = Duration.seconds(30);

/**
 * How often `/spend` re-reads the backtest. Not the spend's 5 s: the backtest walks the whole
 * history (quadratic in it), and its numbers move only as runs finish.
 */
export const BACKTEST_REFRESH = Duration.minutes(1);

export const costPredictionAtom = Atom.family((key: string) =>
  runtime
    .atom(
      Effect.gen(function* () {
        const rpc = yield* RpcClient;
        const { prompt, model, repo } = fromPredictionKey(key);
        // A form with no prompt yet asks for nothing: there is no task to predict.
        if (prompt.trim() === "") return undefined;
        // The key's repo is a `listRepos` slug the form picked; one that is not a slug predicts as none.
        const slug = Schema.decodeOption(RepoSlug)(repo);
        return yield* rpc.client.predictCost({
          prompt,
          ...modelInput(model),
          ...(Option.isSome(slug) ? { repo: slug.value } : {}),
        });
      }),
    )
    .pipe(
      Atom.withReactivity([SESSIONS_KEY]),
      Atom.withRefresh(PREDICTION_REFRESH),
    ),
);

/**
 * How wrong the prediction has been (LOB-38): `backtestCost` over every completed session, the
 * number `/spend` publishes. The summary alone: the strip shows no scored row, so none travels.
 */
export const costBacktestAtom = runtime
  .atom(
    Effect.gen(function* () {
      const rpc = yield* RpcClient;
      return yield* rpc.client.backtestCost({});
    }),
  )
  .pipe(
    Atom.withReactivity([SESSIONS_KEY]),
    Atom.withRefresh(BACKTEST_REFRESH),
  );
