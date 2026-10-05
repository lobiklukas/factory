import { Console, Effect, Schema } from "effect";
import { SessionError } from "@repo/domain/Session";

/**
 * Report a failure the way a CLI should: the code a caller can branch on, then a non-zero exit.
 *
 * `SessionError.code` is the interesting half (docs/design.md D9): the control plane answers
 * `not_found`, `busy`, `invalid_input`, `storage`, or `harness`, and a script driving `factory`
 * should see that word rather than parse a message. Anything that is not a `SessionError` — a
 * server that is not listening, a stream that dropped — is reported as `error`.
 */
export const reportFailure = (
  code: string,
  message: string,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    yield* Console.error(`error: ${code}: ${message}`);
    return yield* Effect.sync(() => process.exit(1));
  });

/**
 * The shared failure handler for every subcommand: keep a `SessionError`'s code, report everything
 * else as `error`, and always exit non-zero.
 */
export const reportFailures = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A | void, never, R> =>
  effect.pipe(
    Effect.catch((error) =>
      Schema.is(SessionError)(error)
        ? reportFailure(error.code, error.message)
        : reportFailure("error", String(error)),
    ),
  );
