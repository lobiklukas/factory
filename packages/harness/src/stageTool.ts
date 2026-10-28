/**
 * What the stage tools share (`./specify`'s `spec`, `./planning`'s `plan`): the validator that turns
 * a decoder's refusal into the tool's error, the optional list parameter every field is declared
 * as, and how a result's sentence names a list. One module, so a third stage tool imports these
 * rather than copying them a third time.
 */
import { Type } from "@earendil-works/pi-ai";
import { Cause, Effect, Exit, Option } from "effect";

/** A list as a result's sentence names it: `none`, or each item quoted, in order. */
export const listed = (items: readonly string[]): string =>
  items.length === 0 ? "none" : items.map((item) => `"${item}"`).join("; ");

/**
 * Run `decode` over the tool's arguments, or reject with the refusal's own sentence (it names the
 * field), so the model reads the stage's refusal rather than a generic schema error.
 */
export const validated = <A, E extends { readonly message: string }>(
  decode: (input: unknown) => Effect.Effect<A, E>,
  args: unknown,
): Promise<A> =>
  Effect.runPromiseExit(decode(args)).then((exit) => {
    if (Exit.isSuccess(exit)) return exit.value;
    const refused = Cause.findErrorOption(exit.cause);
    throw new Error(
      Option.isSome(refused) ? refused.value.message : Cause.pretty(exit.cause),
    );
  });

/**
 * A list parameter, optional in the schema the model sees so that a missing field reaches the
 * decoder's own refusal instead of the tool layer's.
 */
export const items = (description: string) =>
  Type.Optional(Type.Array(Type.String(), { description }));
