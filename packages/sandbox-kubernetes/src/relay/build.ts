/* oxlint-disable effecttsgo/node-builtin-import -- a build step for tests and fakes, run before any runtime exists. */
/**
 * The relay as one file (LOB-91): `bun build` of `./main.ts` for Node, with Pi Durable inside it.
 * The sandbox image runs that file (`node /opt/factory/relay.mjs`, infra/sandbox/Dockerfile), and
 * the tests and the fake cluster build the same one, so what they exercise is what a pod runs.
 *
 * Node, not Bun: Pi Durable's environment conformance holds on Node, and Bun's `fs.opendir` opens a
 * missing directory without failing, which the suite's "directory reader refuses missing paths"
 * case catches.
 */
import { execFileSync } from "node:child_process";
import { join } from "node:path";

/** The relay's entry point, for a build that runs elsewhere (the image). */
export const RELAY_ENTRY = join(import.meta.dirname, "main.ts");

/** Bundle the relay to `outfile` and return it. */
export const buildRelay = (outfile: string): string => {
  execFileSync(
    "bun",
    ["build", RELAY_ENTRY, "--target=node", "--outfile", outfile],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
  return outfile;
};
