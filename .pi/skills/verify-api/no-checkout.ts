// Register one repo against a running API, with this skill's fixture checkout as its local path.
//
//   API_URL=http://localhost:9560 NO_CHECKOUT_REPO=acme/x bun no-checkout.ts
//
// `no-checkout.sh` calls it between its two boots (LOB-263): the second boot's log must no longer
// warn about the repo this registers, and must still warn about the one it leaves alone.
import path from "node:path";
import { SessionRpc } from "@repo/domain/Rpc";
import { RepoSlug } from "@repo/domain/Session";
import { Effect } from "effect";
import { RpcClient } from "effect/rpc";
import { protocolFor } from "./harness.ts";

const API_URL = process.env["API_URL"] ?? "http://localhost:9200";
const repo = process.env["NO_CHECKOUT_REPO"];
if (repo === undefined) {
  console.error("no-checkout.ts needs NO_CHECKOUT_REPO");
  process.exit(2);
}

const fixture = path.resolve(
  new URL(".", import.meta.url).pathname,
  "fixtures",
  "repo",
);

await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const client = yield* RpcClient.make(SessionRpc);
      const row = yield* client.registerRepo({
        repo: RepoSlug.make(repo),
        localPath: fixture,
      });
      console.log(`registered ${row.repo} at ${row.localPath}`);
    }),
  ).pipe(Effect.provide(protocolFor(API_URL))),
);
