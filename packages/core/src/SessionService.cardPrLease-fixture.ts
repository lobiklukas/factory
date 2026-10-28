/**
 * The other API process `SessionService.cardProcesses.test.ts` steps a card's PR against (F13): a
 * real process, so the lease it holds is another process's, and the SIGKILL that ends it is a real
 * one — no finalizer, no release of its claim.
 *
 * It takes the card's PR lease (`./Presence`, kind `card_pr`) the way a PR step in the API does,
 * renews it every third of the TTL it is given, prints `READY <fence>` once it holds it, and waits to
 * be killed. Its claim then lapses after the TTL, as a dead process's does.
 *
 * Its settings are arguments rather than environment variables: the API's environment is checked
 * against `apps/api/turbo.json` (LOB-257), and these are a test's, not the API's.
 *
 *   DATABASE_URL=… bun packages/core/src/SessionService.cardPrLease-fixture.ts <task-id> <ttl-ms>
 */
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { DatabaseLive } from "@repo/storage-postgres";
import { Console, Effect, Layer } from "effect";
import { makePresence } from "./Presence";

const [taskId = "", ttl = "1500"] = process.argv.slice(2);

const program = Effect.gen(function* () {
  const ttlMs = Number(ttl);
  const presence = yield* makePresence({
    home: `card-pr-lease-fixture:${process.pid}`,
    ttlMs,
  });
  const claim = yield* presence.acquire("card_pr", taskId);
  if (claim._tag !== "Held")
    return yield* Effect.die(
      new Error(`task ${taskId}'s PR lease is held by ${claim.lease.holder}`),
    );
  yield* Console.log(`READY ${claim.fence}`);
  for (;;) {
    yield* Effect.sleep(Math.max(1, Math.trunc(ttlMs / 3)));
    yield* presence.renew("card_pr", [{ key: taskId, fence: claim.fence }]);
  }
});

BunRuntime.runMain(
  program.pipe(Effect.provide(Layer.mergeAll(DatabaseLive, BunServices.layer))),
);
