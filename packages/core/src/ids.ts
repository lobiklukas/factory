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

export const mintSessionId: Effect.Effect<SessionId> = Effect.gen(function* () {
  const millis = yield* Clock.currentTimeMillis;
  const random: string[] = [];
  for (let index = 0; index < RANDOM_CHUNKS; index += 1) {
    random.push(encode(yield* Random.nextIntBetween(0, 2 ** 20), RANDOM_CHARS));
  }
  return SessionId.make(`ses_${encode(millis, TIME_CHARS)}${random.join("")}`);
});

/**
 * Task ids: `tsk_` and the same ten-plus-sixteen shape as a session id (`TaskId` in the domain),
 * minted by the server. A card is typed by a person, so its id is the only handle the board has on
 * it; it is sortable and unique for the same reason a session id is.
 */
export const mintTaskId: Effect.Effect<TaskId> = Effect.gen(function* () {
  const millis = yield* Clock.currentTimeMillis;
  const random: string[] = [];
  for (let index = 0; index < RANDOM_CHUNKS; index += 1) {
    random.push(encode(yield* Random.nextIntBetween(0, 2 ** 20), RANDOM_CHARS));
  }
  return TaskId.make(`tsk_${encode(millis, TIME_CHARS)}${random.join("")}`);
});
