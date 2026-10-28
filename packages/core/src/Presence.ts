/**
 * Presence (docs/design.md D12, LOB-18): which process holds what, as lease rows with a heartbeat.
 *
 * A lease is a claim on one thing — a session's log today (`session`), a board card for the
 * dispatcher in wave 2 (`card`) — that lapses unless its holder renews it. That is the whole point:
 * a process that dies stops renewing, so after the TTL its claims are anybody's rather than hanging on
 * a process nobody can ask. The table is `leases` (migration 0033); this module is its only reader
 * and writer.
 *
 * Every claim names its holder (one process, minted at boot) and its home (`homeOf`: that process's
 * host and absolute session root). `fence` counts the claim's holders: it rises when the claim changes hands, and a
 * holder renews or releases only the claim it took, so one that lost its claim cannot renew it back.
 *
 * Time is the database's (`now()`), never a process clock: two processes on two machines agree on
 * whether a lease has lapsed because only one clock decides it.
 */
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { Effect, Option } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

/** What a lease is a claim on: a session's log, or (wave 2) a board card. */
export type LeaseKind = "session" | "card";

/** A lease as the table holds it: who has it, under which fence, and until when. */
export type Lease = {
  readonly kind: LeaseKind;
  readonly key: string;
  readonly holder: string;
  readonly home: string;
  readonly fence: number;
  /** When the lease lapses unless its holder renews it, ISO-8601 in UTC. */
  readonly expiresAt: string;
};

/** What an acquisition got: the claim and its fence, or the live lease of somebody else. */
export type Claim =
  | { readonly _tag: "Held"; readonly fence: number }
  | { readonly _tag: "HeldElsewhere"; readonly lease: Lease };

/** One claim this process means to keep: its key and the fence it took it under. */
export type HeldClaim = { readonly key: string; readonly fence: number };

export type PresenceShape = {
  /** This process's identity: every claim it makes names it. */
  readonly holder: string;
  /** This process's absolute session root (`Lease.home`). */
  readonly home: string;
  /** How long a claim lives without a renewal. */
  readonly ttlMs: number;
  /**
   * Claim one thing. Answered `Held` when nobody holds it, when this process already does (same
   * fence), or when the lease there has lapsed (the next fence); otherwise `HeldElsewhere`, naming the
   * live holder.
   *
   * `takeoverHome` also takes a live claim whose holder shares this process's home: a previous
   * incarnation of this process, which a restart replaces rather than waiting out its TTL (LOB-25,
   * LOB-231). Two live processes in one home is already the misconfiguration D12 warns about.
   */
  readonly acquire: (
    kind: LeaseKind,
    key: string,
    options?: { readonly takeoverHome?: boolean },
  ) => Effect.Effect<Claim, SqlError>;
  /**
   * Push the claims this process holds out by a TTL, and answer the keys that were renewed. A key
   * missing from the answer is a claim lost: it lapsed and somebody else took it, or it was taken
   * over, and the caller has to stop acting on it.
   */
  readonly renew: (
    kind: LeaseKind,
    claims: readonly HeldClaim[],
  ) => Effect.Effect<ReadonlySet<string>, SqlError>;
  /** Give one claim up, if it is still this process's under that fence. */
  readonly release: (
    kind: LeaseKind,
    key: string,
    fence: number,
  ) => Effect.Effect<void, SqlError>;
  /** Give up every claim this process holds: what a shutdown does. */
  readonly releaseAll: Effect.Effect<void, SqlError>;
  /** The live lease on one thing, whoever holds it; none when nobody does or it has lapsed. */
  readonly leaseOf: (
    kind: LeaseKind,
    key: string,
  ) => Effect.Effect<Option.Option<Lease>, SqlError>;
};

/** A claim's life without a renewal, when the deployment names none. */
export const DEFAULT_LEASE_TTL_MS = 30_000;

/**
 * A process's home: the host and the absolute session root it works in — where a session's worktree
 * lives. A process started again in the same home is the one it replaces, and may take back its
 * claims (`takeoverHome`); two replicas share a root path but not a host.
 */
export const homeOf = (sessionRoot: string): string =>
  `${hostname()}:${sessionRoot}`;

/** A fresh holder identity: unique per process, readable enough to say which process it was. */
export const mintHolder = (): string =>
  `${process.pid}-${randomUUID().slice(0, 8)}`;

type LeaseRow = {
  readonly holder: string;
  readonly home: string;
  readonly fence: string | number;
  readonly expires: string;
};

export const makePresence = (config: {
  readonly home: string;
  readonly ttlMs?: number;
  readonly holder?: string;
}): Effect.Effect<PresenceShape, never, SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const holder = config.holder ?? mintHolder();
    const home = config.home;
    const ttlMs = Math.max(1, Math.trunc(config.ttlMs ?? DEFAULT_LEASE_TTL_MS));

    const leaseOf = (
      kind: LeaseKind,
      key: string,
    ): Effect.Effect<Option.Option<Lease>, SqlError> =>
      Effect.map(
        sql<LeaseRow>`
          SELECT holder, home, fence,
            to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires
          FROM leases
          WHERE kind = ${kind} AND key = ${key} AND expires_at > now()
        `,
        (rows) => {
          const row = rows[0];
          return row === undefined
            ? Option.none()
            : Option.some({
                kind,
                key,
                holder: row.holder,
                home: row.home,
                fence: Number(row.fence),
                expiresAt: row.expires,
              });
        },
      );

    const acquire = (
      kind: LeaseKind,
      key: string,
      options: { readonly takeoverHome?: boolean } = {},
    ): Effect.Effect<Claim, SqlError> =>
      Effect.gen(function* () {
        const takeover = options.takeoverHome === true;
        // Twice at most: a row the insert collided with can lapse or be released before the read
        // below, which then finds nothing to name, and one more attempt takes it.
        for (let attempt = 0; ; attempt += 1) {
          // One statement, so two processes racing for one claim are ordered by the row lock: the
          // loser's update re-reads the winner's row and its `WHERE` no longer matches.
          const taken = yield* sql<{ readonly fence: string | number }>`
            INSERT INTO leases (kind, key, holder, home, expires_at)
            VALUES (
              ${kind}, ${key}, ${holder}, ${home},
              now() + ${ttlMs}::int * interval '1 millisecond'
            )
            ON CONFLICT (kind, key) DO UPDATE SET
              fence = CASE WHEN leases.holder = EXCLUDED.holder
                THEN leases.fence ELSE leases.fence + 1 END,
              acquired_at = CASE WHEN leases.holder = EXCLUDED.holder
                THEN leases.acquired_at ELSE now() END,
              holder = EXCLUDED.holder,
              home = EXCLUDED.home,
              renewed_at = now(),
              expires_at = EXCLUDED.expires_at
            WHERE leases.holder = EXCLUDED.holder
              OR leases.expires_at <= now()
              OR (${takeover}::boolean AND leases.home = EXCLUDED.home)
            RETURNING fence
          `;
          const row = taken[0];
          if (row !== undefined)
            return { _tag: "Held", fence: Number(row.fence) } as const;
          const current = yield* leaseOf(kind, key);
          if (Option.isSome(current))
            return { _tag: "HeldElsewhere", lease: current.value } as const;
          if (attempt >= 1) {
            // Lapsing in the gap twice running is a clock the two statements disagree on, not a
            // race; nobody holds it either way, so the honest answer is to try again later.
            return yield* Effect.die(
              new Error(`lease ${kind}/${key} could be neither taken nor read`),
            );
          }
        }
      });

    const renew = (
      kind: LeaseKind,
      claims: readonly HeldClaim[],
    ): Effect.Effect<ReadonlySet<string>, SqlError> =>
      claims.length === 0
        ? Effect.succeed(new Set<string>())
        : Effect.map(
            sql<{ readonly key: string }>`
              UPDATE leases l
              SET renewed_at = now(),
                expires_at = now() + ${ttlMs}::int * interval '1 millisecond'
              FROM unnest(
                ${claims.map((claim) => claim.key)}::text[],
                ${claims.map((claim) => claim.fence)}::bigint[]
              ) AS c(key, fence)
              WHERE l.kind = ${kind} AND l.key = c.key AND l.fence = c.fence
                AND l.holder = ${holder}
              RETURNING l.key
            `,
            (rows) => new Set(rows.map((row) => row.key)),
          );

    const release = (
      kind: LeaseKind,
      key: string,
      fence: number,
    ): Effect.Effect<void, SqlError> =>
      Effect.asVoid(
        sql`
          DELETE FROM leases
          WHERE kind = ${kind} AND key = ${key} AND holder = ${holder} AND fence = ${fence}
        `,
      );

    const releaseAll = Effect.asVoid(
      sql`DELETE FROM leases WHERE holder = ${holder}`,
    );

    return {
      holder,
      home,
      ttlMs,
      acquire,
      renew,
      release,
      releaseAll,
      leaseOf,
    };
  });
