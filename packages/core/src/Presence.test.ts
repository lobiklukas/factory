/**
 * Presence leases (LOB-18): one table, claims with a heartbeat, a TTL and a fence.
 *
 * Postgres only, not mocked: `docker compose up -d --wait postgres`. Every case claims keys of its
 * own, so the cases share the table without touching each other's rows. A lapse is made by moving a
 * row's `expires_at` into the past rather than by sleeping out a TTL: the database's clock is the
 * one that decides, and this is the deterministic way to ask it.
 */
import { BunServices } from "@effect/platform-bun";
import { randomBytes } from "node:crypto";
import { DatabaseLive } from "@repo/storage-postgres";
import { Effect, Layer, ManagedRuntime, Option } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { afterAll, describe, expect, it } from "vitest";
import { makePresence } from "./Presence";

const runtime = ManagedRuntime.make(
  Layer.mergeAll(DatabaseLive, BunServices.layer),
);
afterAll(() => runtime.dispose());

const run = <A, E>(effect: Effect.Effect<A, E, SqlClient>) =>
  runtime.runPromise(effect);

const freshKey = () => `presence-${randomBytes(6).toString("hex")}`;

/** Make a row lapse now, as a holder that stopped renewing would let it. */
const lapse = (key: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql`
      UPDATE leases SET expires_at = now() - interval '1 second'
      WHERE kind = 'card' AND key = ${key}
    `;
  });

describe("presence leases", () => {
  /**
   * Mutation: drop the `WHERE` on the upsert — the second process takes a live claim.
   * Mutation: keep the fence on a change of hands — the reclaimed fence is 1, not 2.
   * Mutation: `leaseOf` without `expires_at > now()` — the lapsed lease still reads as held.
   */
  it("holds a claim against another process until it lapses, then hands it on under the next fence", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        const key = freshKey();
        const first = yield* makePresence({ home: "/first", ttlMs: 60_000 });
        const second = yield* makePresence({ home: "/second", ttlMs: 60_000 });
        const taken = yield* first.acquire("card", key);
        const again = yield* first.acquire("card", key);
        const refused = yield* second.acquire("card", key);
        const held = yield* second.leaseOf("card", key);
        yield* lapse(key);
        const lapsed = yield* second.leaseOf("card", key);
        const reclaimed = yield* second.acquire("card", key);
        const now = yield* first.leaseOf("card", key);
        return {
          first: first.holder,
          second: second.holder,
          taken,
          again,
          refused,
          held,
          lapsed,
          reclaimed,
          now,
        };
      }),
    );
    expect(outcome.first).not.toBe(outcome.second);
    expect(outcome.taken).toEqual({ _tag: "Held", fence: 1 });
    // Taking a claim one already holds is a renewal, not a change of hands.
    expect(outcome.again).toEqual({ _tag: "Held", fence: 1 });
    expect(outcome.refused._tag).toBe("HeldElsewhere");
    if (outcome.refused._tag === "HeldElsewhere") {
      expect(outcome.refused.lease).toMatchObject({
        holder: outcome.first,
        home: "/first",
        fence: 1,
      });
    }
    expect(Option.getOrUndefined(outcome.held)?.holder).toBe(outcome.first);
    expect(Option.isNone(outcome.lapsed)).toBe(true);
    expect(outcome.reclaimed).toEqual({ _tag: "Held", fence: 2 });
    expect(Option.getOrUndefined(outcome.now)).toMatchObject({
      holder: outcome.second,
      home: "/second",
      fence: 2,
    });
  }, 30_000);

  /**
   * Mutation: renew by holder alone, without the fence — the stale fence is renewed too.
   * Mutation: renew without the holder — the loser renews the winner's row back.
   * Mutation: release without the fence — the old holder's release deletes the new claim.
   */
  it("renews and releases only the claim a holder took, so a lost claim stays lost", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        const kept = freshKey();
        const lost = freshKey();
        const loser = yield* makePresence({ home: "/loser", ttlMs: 60_000 });
        const winner = yield* makePresence({ home: "/winner", ttlMs: 60_000 });
        yield* loser.acquire("card", kept);
        yield* loser.acquire("card", lost);
        yield* lapse(lost);
        const taken = yield* winner.acquire("card", lost);
        const renewed = yield* loser.renew("card", [
          { key: kept, fence: 1 },
          { key: lost, fence: 1 },
        ]);
        // A fence that is not the row's is not renewed either, even by the holder of the row.
        const staleFence = yield* winner.renew("card", [
          { key: lost, fence: 1 },
        ]);
        yield* loser.release("card", lost, 1);
        const afterRelease = yield* winner.leaseOf("card", lost);
        yield* loser.releaseAll;
        const afterReleaseAll = yield* winner.leaseOf("card", kept);
        return {
          taken,
          renewed: [...renewed],
          staleFence: [...staleFence],
          afterRelease,
          afterReleaseAll,
          winner: winner.holder,
        };
      }),
    );
    expect(outcome.taken).toEqual({ _tag: "Held", fence: 2 });
    expect(outcome.renewed).toHaveLength(1);
    expect(outcome.staleFence).toEqual([]);
    expect(Option.getOrUndefined(outcome.afterRelease)?.holder).toBe(
      outcome.winner,
    );
    expect(Option.isNone(outcome.afterReleaseAll)).toBe(true);
  }, 30_000);

  /**
   * Mutation: take over regardless of home — the other home's live claim is taken.
   * Mutation: ignore `takeoverHome` — the same home waits out the TTL and is refused.
   */
  it("lets a boot take back what its own home held, and nothing of another home's", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        const ours = freshKey();
        const theirs = freshKey();
        const dead = yield* makePresence({ home: "/root", ttlMs: 60_000 });
        const other = yield* makePresence({
          home: "/elsewhere",
          ttlMs: 60_000,
        });
        const booted = yield* makePresence({ home: "/root", ttlMs: 60_000 });
        yield* dead.acquire("card", ours);
        yield* other.acquire("card", theirs);
        const plain = yield* booted.acquire("card", ours);
        const takeover = yield* booted.acquire("card", ours, {
          takeoverHome: true,
        });
        const foreign = yield* booted.acquire("card", theirs, {
          takeoverHome: true,
        });
        return { plain, takeover, foreign };
      }),
    );
    expect(outcome.plain._tag).toBe("HeldElsewhere");
    expect(outcome.takeover).toEqual({ _tag: "Held", fence: 2 });
    expect(outcome.foreign._tag).toBe("HeldElsewhere");
  }, 30_000);
});
