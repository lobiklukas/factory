/**
 * Which sandbox runtime sessions' commands run through (LOB-244): `SANDBOX_RUNTIME`, read at boot.
 *
 * `in-process` — the default, and the only runtime so far — binds each session's sandbox to its
 * worktree on this host and runs its commands as the host's own processes, which is what every
 * session did before the choice existed. A Kubernetes runtime (LOB-89) is a new value here and a
 * new case below; a value this server does not know fails the boot rather than quietly running
 * sessions somewhere else.
 */
import {
  type BindableSandboxRuntimeShape,
  InProcess,
  type SandboxCapabilities,
} from "@repo/sandbox";
import { Config, type Effect, type Scope } from "effect";

export const SANDBOX_RUNTIMES = ["in-process"] as const;
export type SandboxRuntimeName = (typeof SANDBOX_RUNTIMES)[number];

/** What runs when `SANDBOX_RUNTIME` is unset. */
export const DEFAULT_SANDBOX_RUNTIME: SandboxRuntimeName = "in-process";

/** The runtime the deployment names, if it names one; one it cannot name fails to decode. */
export const SandboxRuntimeConfig = Config.option(
  Config.Literals(SANDBOX_RUNTIMES, "SANDBOX_RUNTIME"),
);

/** The runtime `name` selects, living as long as the scope it is built in. */
export const selectSandboxRuntime = (
  name: SandboxRuntimeName,
): Effect.Effect<BindableSandboxRuntimeShape, never, Scope.Scope> => {
  switch (name) {
    case "in-process":
      return InProcess.make();
  }
};

/** The boot line: which runtime, and what its descriptor says separates a command from the host. */
export const describeSandboxRuntime = (
  capabilities: SandboxCapabilities,
  configured: boolean,
): string =>
  `sandbox runtime: ${capabilities.runtime}${configured ? " (SANDBOX_RUNTIME)" : ""}, isolation ${capabilities.isolation}${
    capabilities.isolation === "none"
      ? " — a session's commands run on this host as the server's user, in its worktree"
      : ""
  }`;
