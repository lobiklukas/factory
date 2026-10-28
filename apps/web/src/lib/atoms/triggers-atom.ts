import { Duration, Effect } from "effect";
import { Atom } from "effect/reactivity";
import type { ListTriggerDeliveriesInput } from "@repo/domain/Trigger";
import { runtime } from "../atom";
import { RpcClient } from "../rpc-client";
import { inputOfKey, PAGE_SIZE } from "../triggers-view";

/**
 * How often the page re-reads the newest deliveries. A delivery arrives off this page (a webhook,
 * a cadence), and the page is where an operator waits for one to show, so it polls; one indexed
 * read of a page is cheap.
 */
export const TRIGGERS_POLL = Duration.seconds(5);

/**
 * The newest page of recorded deliveries (T4): `listTriggerDeliveries`, keyed by the filter's key (`filterKey`)
 * because an atom family is keyed by value. Older pages are read on demand by
 * `olderDeliveriesAtom` and held by the page, so a poll never discards what the person scrolled to.
 */
export const triggerDeliveriesAtom = Atom.family((filter: string) =>
  runtime
    .atom(
      Effect.gen(function* () {
        const rpc = yield* RpcClient;
        return yield* rpc.client.listTriggerDeliveries({
          ...inputOfKey(filter),
          limit: PAGE_SIZE,
        });
      }),
    )
    .pipe(Atom.withRefresh(TRIGGERS_POLL)),
);

/** The page after a cursor, as the person asked for it: the same read, one page at a time. */
export const olderDeliveriesAtom = runtime.fn(
  (input: ListTriggerDeliveriesInput) =>
    Effect.gen(function* () {
      const rpc = yield* RpcClient;
      return yield* rpc.client.listTriggerDeliveries({
        ...input,
        limit: PAGE_SIZE,
      });
    }),
);
