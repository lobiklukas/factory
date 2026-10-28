// The git side of a loopback forge (C17): bare repositories served over git's smart-HTTP protocol by
// the real `git http-backend`, behind a Basic-auth gate that answers `401` to any request without
// `x-access-token:<token>` — so a push or fetch that did not carry the control plane's token fails
// here exactly as it would on GitHub, and one over a plain path would prove nothing.
//
// Nothing is mocked but the host: the repositories are real, the protocol is git's own, and the
// ledger is a file so the drive can count what reached the forge after the API has exited. It holds
// one row per request — method, path, the `service` git asked for (`git-upload-pack` is a fetch or
// an `ls-remote`, `git-receive-pack` a push) and which credential it carried: `none` (git's first,
// unauthenticated request, which the `401` challenge answers), `token`, or `other`. The token itself
// is never written to the ledger.
//
//   GIT_FORGE_PORT    port to listen on, required
//   GIT_FORGE_ROOT    the directory of bare repositories (`<root>/<owner>/<repo>.git`), required
//   GIT_FORGE_TOKEN   the one token the gate accepts, required
//   GIT_FORGE_LEDGER  ledger file path, required
//
// The bridge itself is core's (`startGitRemote`, `@repo/core/testing`), the one the core suites use:
// this file is only the process around it, its port, and its ledger.
import { readFileSync, writeFileSync } from "node:fs";
import { startGitRemote, type GitRemoteRequest } from "@repo/core/testing";

const port = Number(process.env["GIT_FORGE_PORT"] ?? "");
const root = process.env["GIT_FORGE_ROOT"] ?? "";
const token = process.env["GIT_FORGE_TOKEN"] ?? "";
const ledgerPath = process.env["GIT_FORGE_LEDGER"] ?? "";
if (
  !Number.isInteger(port) ||
  root === "" ||
  token === "" ||
  ledgerPath === ""
) {
  console.error(
    "GIT_FORGE_PORT, GIT_FORGE_ROOT, GIT_FORGE_TOKEN and GIT_FORGE_LEDGER are required",
  );
  process.exit(1);
}

const read = (): { readonly requests: ReadonlyArray<GitRemoteRequest> } => {
  try {
    return JSON.parse(readFileSync(ledgerPath, "utf8")) as {
      readonly requests: ReadonlyArray<GitRemoteRequest>;
    };
  } catch {
    return { requests: [] };
  }
};
const record = (row: GitRemoteRequest): void =>
  writeFileSync(
    ledgerPath,
    `${JSON.stringify({ requests: [...read().requests, row] }, null, 2)}\n`,
  );

writeFileSync(ledgerPath, `${JSON.stringify({ requests: [] }, null, 2)}\n`);

const forge = await startGitRemote(root, token, { port, onRequest: record });
console.log(`git-forge-fake listening on ${forge.url} root=${root}`);
