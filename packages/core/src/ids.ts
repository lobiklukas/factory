import { Clock, Effect, Random } from "effect";
import { SessionId } from "@repo/domain/Session";
import { TaskId } from "@repo/domain/Task";

/**
 * Session ids: Crockford base32 (no `i`, `l`, `o`, `u`) with ten characters of millisecond
 * timestamp and sixteen of randomness.
 *
 * A session id is a `log_id` (D7), a git branch (`factory/<session-id>`, D10), and a URL segment,
 * so it has to be sortable, unique, and safe in all three. The server mints it and never recycles.
 */
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const TIME_CHARS = 10;
const RANDOM_CHARS = 4;
const RANDOM_CHUNKS = 4;

const encode = (value: number, chars: number): string => {
  let remaining = value;
  const out: string[] = [];
  for (let index = 0; index < chars; index += 1) {
    out.unshift(ALPHABET.charAt(remaining % ALPHABET.length));
    remaining = Math.floor(remaining / ALPHABET.length);
  }
  return out.join("");
};

const mint = (prefix: string): Effect.Effect<string> =>
  Effect.gen(function* () {
    const millis = yield* Clock.currentTimeMillis;
    const random: string[] = [];
    for (let index = 0; index < RANDOM_CHUNKS; index += 1) {
      random.push(
        encode(yield* Random.nextIntBetween(0, 2 ** 20), RANDOM_CHARS),
      );
    }
    return `${prefix}${encode(millis, TIME_CHARS)}${random.join("")}`;
  });

export const mintSessionId: Effect.Effect<SessionId> = mint("ses_").pipe(
  Effect.map((id) => SessionId.make(id)),
);

/** Task ids (`tsk_`, same alphabet and shape as session ids; see `packages/domain/src/Task.ts`). */
export const mintTaskId: Effect.Effect<TaskId> = mint("tsk_").pipe(
  Effect.map((id) => TaskId.make(id)),
);
