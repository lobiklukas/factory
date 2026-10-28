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

/** The service's tag as the snake_case word a script branches on, matching `SessionError.code`. */
const refusalCode = (tag: string): string =>
  tag.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();

const hasMessage = (error: unknown): error is { message: string } =>
  typeof error === "object" &&
  error !== null &&
  "message" in error &&
  typeof (error as { message: unknown }).message === "string";

/**
 * The shared failure handler for every subcommand: keep a `SessionError`'s code, report a typed
 * refusal (a `_tag`-carrying error with a `message`, which is every one of the board's refusals) as
 * the snake_case form of its tag, report everything else as `error`, and always exit non-zero.
 *
 * The refusal branch is what lets `factory board move` print the service's own words: the board's
 * errors are typed values that name what failed (docs/board.md B5), so a script can branch on
 * `stale_revision` rather than parse prose.
 */
export const reportFailures = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A | void, never, R> =>
  effect.pipe(
    Effect.catch((error) => {
      const { code, message } = describeFailure(error);
      return reportFailure(code, message);
    }),
  );

/**
 * A failure as `reportFailures` names it — the code a caller branches on and the service's own
 * message — for a surface that reports it without exiting (`factory mcp`'s tool results).
 */
export const describeFailure = (
  error: unknown,
): { readonly code: string; readonly message: string } =>
  Schema.is(SessionError)(error)
    ? { code: error.code, message: error.message }
    : typeof error === "object" &&
        error !== null &&
        "_tag" in error &&
        hasMessage(error)
      ? {
          code: refusalCode(String((error as { _tag: unknown })._tag)),
          message: error.message,
        }
      : { code: "error", message: String(error) };
