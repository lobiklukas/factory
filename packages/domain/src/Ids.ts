/**
 * The scalars every contract names: a session's id and an instant.
 *
 * They live here rather than in `Session` because a session snapshot now contains an `Approval`
 * (LOB-147 folds the pending approvals into it), so `Session` imports `Approval`. `Approval` has to
 * name the session id it belongs to, and taking that from `Session` would close the loop. A cycle
 * here is not a style problem: `Approval` builds its structs at module load, so whichever module is
 * evaluated second reads the other's half-built namespace and throws a temporal-dead-zone error at
 * import time. One leaf module both sides import keeps the graph acyclic.
 *
 * `Session` re-exports both, so `@repo/domain/Session` keeps the contract it always had.
 */
import { Schema } from "effect";

/** Ten characters of millisecond timestamp then sixteen of randomness, Crockford base32. */
export const SessionId = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^ses_[0-9abcdefghjkmnpqrstvwxyz]{26}$/)),
  Schema.brand("SessionId"),
);
export type SessionId = typeof SessionId.Type;

/** ISO 8601, UTC. */
export const Timestamp = Schema.String;
export type Timestamp = typeof Timestamp.Type;
