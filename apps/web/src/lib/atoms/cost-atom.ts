import { Effect } from "effect";
import { Atom } from "effect/reactivity";
import { runtime } from "../atom";
import { fromPredictionKey } from "../cost-view";
import { modelInput } from "../model-picker-view";
import { RpcClient } from "../rpc-client";
import { SPEND_POLL } from "./spend-atom";
import { SESSIONS_KEY } from "./session-list";

/**
 * What a session would cost before it exists (LOB-38): `predictCost` for one prompt and one model
 * choice, keyed by `predictionKey`. The server's default choice sends no model, as a create with it
 * does, so the prediction is for the model the session would really run. Re-read when a session is
 * started from this dashboard (`SESSIONS_KEY`): a run that finishes is history the next range uses.
 */
export const costPredictionAtom = Atom.family((key: string) =>
  runtime
    .atom(
      Effect.gen(function* () {
        const rpc = yield* RpcClient;
        const { prompt, model } = fromPredictionKey(key);
        return yield* rpc.client.predictCost({
          prompt,
          ...modelInput(model),
        });
      }),
    )
    .pipe(Atom.withReactivity([SESSIONS_KEY])),
);

/**
 * How wrong the prediction has been (LOB-38): `backtestCost` over every completed session, the
 * number `/spend` publishes. Polled with the spend it sits beside, since it moves as runs finish.
 */
export const costBacktestAtom = runtime
  .atom(
    Effect.gen(function* () {
      const rpc = yield* RpcClient;
      return yield* rpc.client.backtestCost({});
    }),
  )
  .pipe(Atom.withReactivity([SESSIONS_KEY]), Atom.withRefresh(SPEND_POLL));
