/**
 * A board's settings follow its pin (F9, D5): `boardConfigAtom` is read once per opening, so the
 * re-pin from the dashboard (`upgradeBoardAtom`) is what makes the settings page and the lane
 * disclosures read the new version's columns and drop the newer-version notice. The atoms under test
 * are the real ones, on the real `Atom.runtime`; only the RPC client behind them is a fake server
 * holding one board, so what is proven is the invalidation and not a copy of it.
 */
import { BoardInstanceId } from "@repo/domain/Task";
import type { UpgradeBoardInput } from "@repo/domain/Task";
import { Effect } from "effect";
import { AsyncResult, AtomRegistry } from "effect/reactivity";
import { afterEach, describe, expect, it, vi } from "vitest";

/** The fake server: the version the board pins, and every call the page made. */
const server = vi.hoisted(() => ({
  pinned: 1,
  reads: 0,
  upgrades: [] as Array<unknown>,
}));

vi.mock("../rpc-client", async () => {
  const { Context, Effect: E, Layer } = await import("effect");
  class RpcClient extends Context.Service<RpcClient>()("RpcClient", {
    make: E.sync(() => ({
      client: {
        getBoardConfig: () =>
          E.sync(() => {
            server.reads += 1;
            return { definition: { version: server.pinned } };
          }),
        upgradeBoard: (input: unknown) =>
          E.sync(() => {
            server.upgrades.push(input);
            server.pinned = 3;
            return { fromVersion: 1 };
          }),
        listBoards: () => E.sync(() => []),
      },
    })),
  }) {
    static layer = Layer.effect(RpcClient)(RpcClient.make);
  }
  return { RpcClient };
});

import { boardConfigAtom, upgradeBoardAtom } from "./board-atom";

const BOARD = BoardInstanceId.make("brd_00000000000000000000000001");

const versionOf = (registry: AtomRegistry.AtomRegistry): number | undefined => {
  const result = registry.get(boardConfigAtom(BOARD));
  return AsyncResult.isSuccess(result)
    ? (result.value as unknown as { definition: { version: number } })
        .definition.version
    : undefined;
};

const settled = (until: () => boolean) =>
  vi.waitFor(() => expect(until()).toBe(true), { timeout: 1_000 });

afterEach(() => {
  server.pinned = 1;
  server.reads = 0;
  server.upgrades.length = 0;
});

describe("boardConfigAtom after a re-pin (F9)", () => {
  /**
   * Mutation: drop `BOARD_PIN_KEY` from `boardConfigAtom`, or from `upgradeBoardAtom`'s keys — the
   * settings page would keep v1 until reload. The read count says the page re-asked rather than
   * that a value happened to differ.
   */
  it("re-reads the board's configuration when the upgrade lands, without a reload", async () => {
    const registry = AtomRegistry.make();
    const unmount = registry.mount(boardConfigAtom(BOARD));
    await settled(() => versionOf(registry) !== undefined);
    expect(versionOf(registry)).toBe(1);
    expect(server.reads).toBe(1);

    const input = {
      boardId: BOARD,
      toVersion: 3,
      expectedVersion: 1,
      actor: "dashboard",
    } satisfies UpgradeBoardInput;
    registry.set(upgradeBoardAtom, input);
    await settled(() => versionOf(registry) === 3);

    expect(server.upgrades).toEqual([input]);
    expect(server.reads).toBe(2);
    expect(versionOf(registry)).toBe(3);
    unmount();
  });

  /** Mutation: poll or refresh on a timer instead — the read count would climb with no upgrade. */
  it("does not re-read while nothing changed the pin", async () => {
    const registry = AtomRegistry.make();
    const unmount = registry.mount(boardConfigAtom(BOARD));
    await settled(() => versionOf(registry) !== undefined);
    await Effect.runPromise(Effect.sleep("100 millis"));
    expect(server.reads).toBe(1);
    unmount();
  });
});
