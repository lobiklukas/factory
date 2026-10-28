import { Effect } from "effect";
import { Atom } from "effect/reactivity";
import type { DeleteSecretInput, SetSecretInput } from "@repo/domain/Secret";
import { runtime } from "../atom";
import { RpcClient } from "../rpc-client";

/** The reactivity key a write that changes the secrets invalidates. */
export const SECRETS_KEY = "secrets";

/**
 * Every repo's secrets, by name (S-agent-secrets): `listSecrets`, which answers summaries and never
 * a value. Read once per opening and again when this page sets or deletes one; a secret changes only
 * by a write, so nothing here polls.
 */
export const secretsAtom = runtime
  .atom(
    Effect.gen(function* () {
      const rpc = yield* RpcClient;
      return yield* rpc.client.listSecrets({});
    }),
  )
  .pipe(Atom.withReactivity([SECRETS_KEY]));

/**
 * Stores a secret, as `factory secret set` does. The answer is its summary or the server's typed
 * refusal; the value goes out once and is never read back.
 */
export const setSecretAtom = runtime.fn(
  (input: SetSecretInput) =>
    Effect.gen(function* () {
      const rpc = yield* RpcClient;
      return yield* rpc.client.setSecret(input);
    }),
  { reactivityKeys: [SECRETS_KEY] },
);

/** Deletes a secret, as `factory secret rm` does. */
export const deleteSecretAtom = runtime.fn(
  (input: DeleteSecretInput) =>
    Effect.gen(function* () {
      const rpc = yield* RpcClient;
      return yield* rpc.client.deleteSecret(input);
    }),
  { reactivityKeys: [SECRETS_KEY] },
);
