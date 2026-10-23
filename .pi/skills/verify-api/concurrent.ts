// Concurrent drive: two sessions on one repo must not interfere.
//
//   bun concurrent.ts   (against an API on API_URL)
//
// Env: API_URL, EVIDENCE_DIR
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { SessionRpc } from "@repo/domain/Rpc";
import { Effect } from "effect";
import { RpcClient } from "effect/rpc";
import { makeChecker, protocolFor } from "./harness.ts";

const API_URL = process.env["API_URL"] ?? "http://localhost:9200";
const EVIDENCE_DIR = process.env["EVIDENCE_DIR"] ?? ".verify/evidence/latest";

await mkdir(EVIDENCE_DIR, { recursive: true });

const observed: { apiUrl: string; checks: Record<string, unknown> } = {
  apiUrl: API_URL,
  checks: {},
};
const assert = makeChecker(observed);
const ProtocolLive = protocolFor(API_URL);

const repoSlug = "lobiklukas/verify-api-fixture";
const repoUrl = "https://github.com/lobiklukas/factory.git";
const fixture = path.resolve(
  new URL(".", import.meta.url).pathname,
  "fixtures",
  "repo",
);

const program = Effect.gen(function* () {
  const client = yield* RpcClient.make(SessionRpc);

  yield* client.registerRepo({
    repo: repoSlug,
    url: repoUrl,
    defaultBaseRef: "main",
    localPath: fixture,
  });

  const a = yield* client.createSession({
    repo: repoSlug,
    baseRef: "main",
    title: "concurrent A",
  });
  const b = yield* client.createSession({
    repo: repoSlug,
    baseRef: "main",
    title: "concurrent B",
  });

  const sa = yield* client.getSession({ sessionId: a.id });
  const sb = yield* client.getSession({ sessionId: b.id });

  assert(
    "two distinct workspace.path values",
    sa.workspace.path !== sb.workspace.path,
    `a=${sa.workspace.path} b=${sb.workspace.path}`,
  );

  // Write a marker into session A's worktree; it must be absent from session B's.
  const marker = path.join(sa.workspace.path, "concurrent-marker.txt");
  yield* Effect.promise(() => writeFile(marker, "A-only"));
  assert(
    "marker absent from the other session's worktree",
    !existsSync(path.join(sb.workspace.path, "concurrent-marker.txt")),
    `b=${sb.workspace.path}`,
  );

  observed.checks = { a: sa.workspace.path, b: sb.workspace.path };
});

const exit = await Effect.runPromiseExit(
  program.pipe(Effect.provide(ProtocolLive)),
);
if (exit._tag !== "Success") {
  console.error(exit);
  process.exit(1);
}
const failed = Object.entries(observed.checks).filter(
  ([, check]) => (check as { passed?: boolean }).passed === false,
);
await writeFile(
  path.join(EVIDENCE_DIR, "concurrent-observed.json"),
  JSON.stringify(observed, null, 2),
);
if (failed.length > 0) {
  console.error(`\n${failed.length} required check(s) failed`);
  process.exitCode = 1;
} else {
  console.log("concurrent: all checks passed");
}
