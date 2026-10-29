/**
 * How long each step of a worktree's setup may run (F24): `SETUP_TIMEOUT_SECONDS`, read once at boot.
 *
 * A step is the repo's declared `install` or `build`, and `@repo/harness` stops one that outlives
 * the bound and records the setup failed (`SETUP_TIMEOUT_SECONDS` there is the default, 1800 s). A
 * slow monorepo install needs more than that without a code change, and a drive that proves the
 * timeout needs less. The value is a positive finite number of seconds, fractions included; one that
 * is not (zero, negative, text) refuses the boot rather than leaving every setup on a bound
 * the operator did not choose, as `NOTIFY_TYPES` and `SESSION_MAX_CONCURRENT` refuse theirs.
 */
import { SETUP_TIMEOUT_SECONDS } from "@repo/harness";
import { Config, Option, Schema } from "effect";

/** The longest timeout Pi Durable's `exec` accepts, in seconds: a longer one is refused per call. */
export const MAX_SETUP_TIMEOUT_SECONDS = 2_147_483.647;

export const SetupTimeoutConfig = Config.option(
  Config.schema(
    Schema.Finite.pipe(
      Schema.check(
        Schema.isGreaterThan(0),
        Schema.isLessThanOrEqualTo(MAX_SETUP_TIMEOUT_SECONDS),
      ),
    ),
    "SETUP_TIMEOUT_SECONDS",
  ),
);

/** The bound a setup step runs under: the deployment's, or the harness's default. */
export const effectiveSetupTimeout = (
  configured: Option.Option<number>,
): number => Option.getOrElse(configured, () => SETUP_TIMEOUT_SECONDS);
