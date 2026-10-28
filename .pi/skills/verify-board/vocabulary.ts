#!/usr/bin/env bun
// The RPC's answer for `factory board vocabulary` (F5): `getDefinitionVocabulary`, read over the
// API's RPC surface and printed as one line per requirement key and per role in the layout the
// command is expected to print. `definitions.sh` diffs the command's stdout with this, so the
// command is compared with the server, not with itself: a key it dropped, an unmarked human gate or
// a role it never printed is a line this has and it lacks.
//
// Env: API_URL. Exits non-zero when the read fails.
import { RpcApi } from "@repo/domain/Rpc";
import { Effect } from "effect";
import { RpcClient } from "effect/rpc";
import { protocolFor } from "../verify-api/harness.ts";

const API_URL = process.env["API_URL"] ?? "http://localhost:9400";

const lines = Effect.gen(function* () {
  const client = yield* RpcClient.make(RpcApi);
  const vocabulary = yield* client.getDefinitionVocabulary({});
  return [
    ...vocabulary.requirements.map(
      (requirement) =>
        `requirement  ${requirement.key}  ${requirement.checked ? "checked" : "unchecked"}${requirement.humanGate ? "  [human gate]" : ""}  ${requirement.description}`,
    ),
    ...vocabulary.roles.map((role) => `role  ${role}`),
  ];
});

const printed = await Effect.runPromise(
  Effect.scoped(lines).pipe(Effect.provide(protocolFor(API_URL, null))),
);
for (const line of printed) console.log(line);
