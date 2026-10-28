import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";

/**
 * Secrets (S-agent-secrets): one row per named value a registered repository's commands need.
 *
 * The value is never stored in the clear. `@repo/core`'s `SecretService` encrypts it with AES-256-GCM
 * under the control plane's own key (`FACTORY_SECRETS_KEY`, a KMS later) and writes the ciphertext,
 * the nonce and the authentication tag, each base64. The repository and the name are the cipher's
 * additional data, so a ciphertext copied onto another row does not decrypt there. `key_id` names the
 * key a row was written under (a digest of it, never the key), so a control plane started with a
 * different key says which rows it cannot read rather than answering garbage.
 *
 * A secret is a repository's: deleting the repo's row deletes its secrets.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS secrets (
      repo TEXT NOT NULL REFERENCES repos (slug) ON DELETE CASCADE,
      name TEXT NOT NULL CHECK (name ~ '^[A-Z_][A-Z0-9_]*$'),
      ciphertext TEXT NOT NULL,
      nonce TEXT NOT NULL,
      tag TEXT NOT NULL,
      key_id TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_by TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (repo, name)
    )
  `;
});
