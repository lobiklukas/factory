/**
 * `SETUP_TIMEOUT_SECONDS` (F24): the per-step bound on a worktree's setup is a deployment setting,
 * read as a positive finite number of seconds, and a value that is not one refuses the boot.
 */
import { SETUP_TIMEOUT_SECONDS } from "@repo/harness";
import { ConfigProvider, Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";
import { effectiveSetupTimeout, SetupTimeoutConfig } from "./SetupTimeout";

const read = (env: Record<string, string>) =>
  Effect.runPromiseExit(
    Effect.map(SetupTimeoutConfig, effectiveSetupTimeout).pipe(
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromEnv({ env }),
      ),
    ),
  );

describe("SETUP_TIMEOUT_SECONDS", () => {
  /** Mutation: ignore the variable and always answer the harness's default. */
  it("is the harness's default when unset, and the value when set, fractions included", async () => {
    expect(await read({})).toEqual(Exit.succeed(SETUP_TIMEOUT_SECONDS));
    expect(await read({ SETUP_TIMEOUT_SECONDS: "1" })).toEqual(Exit.succeed(1));
    expect(await read({ SETUP_TIMEOUT_SECONDS: "5400" })).toEqual(
      Exit.succeed(5400),
    );
    expect(await read({ SETUP_TIMEOUT_SECONDS: "0.5" })).toEqual(
      Exit.succeed(0.5),
    );
  });

  /** An empty variable is an unset one, as for every other setting the environment provider reads. */
  it("reads an empty variable as unset", async () => {
    expect(await read({ SETUP_TIMEOUT_SECONDS: "" })).toEqual(
      Exit.succeed(SETUP_TIMEOUT_SECONDS),
    );
  });

  /** Mutation: accept zero or a negative number, which would stop every step at once. */
  it("refuses a value that is not a positive finite number", async () => {
    for (const bad of ["0", "-3", "abc", "  ", "Infinity", "NaN", "1h"]) {
      const exit = await read({ SETUP_TIMEOUT_SECONDS: bad });
      expect(Exit.isFailure(exit), `"${bad}" is refused`).toBe(true);
      expect(String(exit)).toContain("SETUP_TIMEOUT_SECONDS");
    }
  });
});
