/**
 * Compaction thresholds follow the model's context window (B4, LOB-185).
 *
 * `compactionPolicyFor` is pure, so the whole rule is a table here: no harness, no database, no
 * model. That the derived policy is what a session actually opens with — and that crossing the
 * threshold commits one summary and heads the context with it — is
 * `session.test.ts`'s "compaction" block, and the RPC path is `.pi/skills/verify-api`.
 */
import { describe, expect, it } from "vitest";
import { compactionPolicyFor, createModelAccess } from "./models";

/** pi-durable's pinned defaults, which a large window must keep to the token. */
const PINNED = {
  enabled: true,
  reserveTokens: 16_384,
  keepRecentTokens: 20_000,
  backgroundTokens: 32_768,
};

describe("compactionPolicyFor", () => {
  it("returns the pinned defaults for the window the real model publishes", () => {
    const model = createModelAccess("anthropic");
    // pi-ai's catalog says a million tokens for the pinned Anthropic model; nothing about it
    // should need a smaller reserve than the package's own default.
    expect(model.contextWindow).toBe(1_000_000);
    expect(compactionPolicyFor(model.contextWindow)).toEqual(PINNED);
  });

  it("shrinks every threshold to a quarter of a small window and turns background off", () => {
    // A window whose pinned defaults would be larger than the window itself: with them, the
    // blocking threshold (window - 16384) is negative and nothing ever compacts.
    expect(compactionPolicyFor(8_000)).toEqual({
      enabled: true,
      reserveTokens: 2_000,
      keepRecentTokens: 2_000,
      backgroundTokens: 0,
    });
  });

  it("keeps background compaction where the window still has room for it", () => {
    // 32k: half the window is the answer reserve and the recent tail, so summarizing ahead of a
    // request has 16k to work in.
    expect(compactionPolicyFor(32_768)).toEqual({
      enabled: true,
      reserveTokens: 8_192,
      keepRecentTokens: 8_192,
      backgroundTokens: 0,
    });
    // 128k is pi-durable's own reference window: close to its defaults, never above them.
    expect(compactionPolicyFor(128_000)).toEqual({
      enabled: true,
      reserveTokens: 16_384,
      keepRecentTokens: 20_000,
      backgroundTokens: 32_000,
    });
  });

  it("falls back to the pinned defaults when the catalog does not publish a window", () => {
    // 0 is "unknown", not "tiny": deriving from nothing would summarize everything on a manual
    // compact (a zero-token tail is always a cut).
    expect(compactionPolicyFor(0)).toEqual(PINNED);
  });
});

describe("createModelAccess", () => {
  it("publishes the window the model was registered with", () => {
    expect(createModelAccess("faux").contextWindow).toBe(128_000);
    expect(
      createModelAccess("faux", { contextWindow: 8_000 }).contextWindow,
    ).toBe(8_000);
  });
});
