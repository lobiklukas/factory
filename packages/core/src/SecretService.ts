/**
 * Secrets: the named values a registered repository's commands need (S-agent-secrets), stored in
 * the `secrets` table encrypted under the control plane's own key (`0042_create_secrets.ts`).
 *
 * **Write-only.** `set` takes a value and answers its summary; `list` and `remove` answer summaries.
 * Only `reveal` decrypts, and it is the control plane's alone: no RPC handler calls it, so no client
 * is ever answered a value. What reveals one is the session service, which injects the values the
 * repository's `.factory/config` declares into the commands it declares them for (`@repo/harness`'s
 * `./secrets`) and scans a branch's commits for every stored value before it pushes (`./secretScan`).
 *
 * **The key.** `FACTORY_SECRETS_KEY` is 32 bytes, base64 (`openssl rand -base64 32`) or 64 hex
 * digits. Absent, the store holds nothing new — `set` is `SecretsUnconfigured` — and every value it
 * already holds is unreadable, which `reveal` says by name. A key that is set but malformed fails the
 * layer: an operator who set one expects it to be used, never a silent store without one. Each row
 * records a digest of the key it was written under (`key_id`), so a control plane started with a
 * different key names the rows it cannot read. AES-256-GCM, a fresh nonce per write, and the repo and
 * name as additional data, so a ciphertext moved to another row does not decrypt there. A KMS is a
 * later key source behind the same table.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { Config, Context, Effect, Layer, Option, Redacted } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import {
  InvalidSecret,
  SECRET_MAX_LENGTH,
  SECRET_MIN_LENGTH,
  SecretNotFound,
  SecretsUnconfigured,
  SecretStorageError,
  type SecretSummary,
  type SetSecretInput,
} from "@repo/domain/Secret";
import { RepoNotFound, RepoSlug } from "@repo/domain/Session";
import type { InjectedSecrets } from "@repo/harness";

/** What `reveal` answers: the values it decrypted, and the names it holds but could not read. */
export type RevealedSecrets = {
  readonly values: InjectedSecrets;
  readonly unreadable: readonly string[];
};

export type SecretServiceShape = {
  /** Whether the control plane holds a key: without one nothing new is stored. */
  readonly configured: boolean;
  /**
   * Encrypt and store a value under `(repo, name)`, replacing any it held. Refused before anything is
   * written: a value shorter than `SECRET_MIN_LENGTH` or longer than `SECRET_MAX_LENGTH`
   * (`InvalidSecret`), a repo the registry does not hold (`RepoNotFound`), no key
   * (`SecretsUnconfigured`).
   */
  readonly set: (
    input: SetSecretInput,
  ) => Effect.Effect<
    SecretSummary,
    InvalidSecret | SecretsUnconfigured | RepoNotFound | SecretStorageError
  >;
  /** Every secret's summary, or one repo's, ordered by repo and name. Never a value. */
  readonly list: (
    repo?: RepoSlug,
  ) => Effect.Effect<ReadonlyArray<SecretSummary>, SecretStorageError>;
  /** Delete one secret, answering the summary it had. */
  readonly remove: (
    repo: RepoSlug,
    name: string,
  ) => Effect.Effect<SecretSummary, SecretNotFound | SecretStorageError>;
  /**
   * The control plane's own read: the values of `repo`'s secrets — the ones `names` lists, or every
   * one — decrypted. A row this key cannot decrypt is named in `unreadable`, never guessed at. A
   * name with no row is in neither list. Never called by a handler a client reaches.
   */
  readonly reveal: (
    repo: RepoSlug,
    names?: readonly string[],
  ) => Effect.Effect<RevealedSecrets, SecretStorageError>;
};

export class SecretService extends Context.Service<
  SecretService,
  SecretServiceShape
>()("@repo/core/SecretService") {}

/** The key the store encrypts with. Absent: nothing new is stored, nothing stored is readable. */
export const SecretsConfig = Config.option(
  Config.Redacted("FACTORY_SECRETS_KEY"),
);

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const ALGORITHM = "aes-256-gcm";

/** The key's bytes from its configured text, base64 or hex; `undefined` for anything else. */
export const parseSecretsKey = (text: string): Buffer | undefined => {
  const trimmed = text.trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return Buffer.from(trimmed, "hex");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) return undefined;
  const bytes = Buffer.from(trimmed, "base64");
  return bytes.length === KEY_BYTES ? bytes : undefined;
};

/** The key's id: a digest of it, short enough to compare, never enough to recover it. */
const keyIdOf = (key: Buffer): string =>
  createHash("sha256").update(key).digest("hex").slice(0, 16);

/** The additional data a row's ciphertext is bound to: its repo and its name. */
const aadOf = (repo: string, name: string): Buffer =>
  Buffer.from(`${repo}\0${name}`, "utf8");

type Sealed = {
  readonly ciphertext: string;
  readonly nonce: string;
  readonly tag: string;
  readonly keyId: string;
};

/** Encrypt one value for one row. */
export const sealSecret = (
  key: Buffer,
  repo: string,
  name: string,
  value: string,
): Sealed => {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, nonce);
  cipher.setAAD(aadOf(repo, name));
  const ciphertext = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  return {
    ciphertext: ciphertext.toString("base64"),
    nonce: nonce.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    keyId: keyIdOf(key),
  };
};

/** Decrypt one row's value; `undefined` when this key, this repo and this name do not open it. */
export const openSecret = (
  key: Buffer,
  repo: string,
  name: string,
  sealed: Sealed,
): string | undefined => {
  if (sealed.keyId !== keyIdOf(key)) return undefined;
  try {
    const decipher = createDecipheriv(
      ALGORITHM,
      key,
      Buffer.from(sealed.nonce, "base64"),
    );
    decipher.setAAD(aadOf(repo, name));
    decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(sealed.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return undefined;
  }
};

type SummaryRow = {
  readonly repo: string;
  readonly name: string;
  readonly createdAt: Date | string;
  readonly updatedAt: Date | string;
  readonly updatedBy: string;
};

type SealedRow = Sealed & { readonly name: string };

const iso = (value: Date | string): string =>
  (value instanceof Date ? value : new Date(value)).toISOString();

const summaryOf = (row: SummaryRow): SecretSummary => ({
  repo: RepoSlug.make(row.repo),
  name: row.name,
  createdAt: iso(row.createdAt),
  updatedAt: iso(row.updatedAt),
  updatedBy: row.updatedBy,
});

const withStorage = <A>(
  effect: Effect.Effect<A, SqlError>,
): Effect.Effect<A, SecretStorageError> =>
  effect.pipe(
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(new SecretStorageError({ message: cause.message })),
    ),
  );

/** The store over `key` (or none). `SecretServiceLive` reads the key from `FACTORY_SECRETS_KEY`. */
export const makeSecretService = (
  key: Buffer | undefined,
): Effect.Effect<SecretServiceShape, never, SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;

    const set = Effect.fn("SecretService.set")(function* (
      input: SetSecretInput,
    ) {
      const value = Redacted.value(input.value);
      if (
        value.length < SECRET_MIN_LENGTH ||
        value.length > SECRET_MAX_LENGTH
      ) {
        return yield* new InvalidSecret({
          name: input.name,
          message: `secret ${input.name}: a value is ${SECRET_MIN_LENGTH} to ${SECRET_MAX_LENGTH} characters (it is masked wherever a command prints it, and a shorter one would mask ordinary words); nothing was stored`,
        });
      }
      if (key === undefined) {
        return yield* new SecretsUnconfigured({
          message: `secret ${input.name}: the control plane holds no FACTORY_SECRETS_KEY to encrypt it with, so nothing was stored; set one (openssl rand -base64 32) and restart it`,
        });
      }
      const registered = yield* withStorage(
        sql<{ readonly slug: string }>`
          SELECT slug FROM repos WHERE slug = ${input.repo}
        `,
      );
      if (registered.length === 0) {
        return yield* new RepoNotFound({
          repo: input.repo,
          message: `no repo ${input.repo} is registered, so it holds no secrets; register it first`,
        });
      }
      const sealed = sealSecret(key, input.repo, input.name, value);
      const rows = yield* withStorage(
        sql<SummaryRow>`
          INSERT INTO secrets (repo, name, ciphertext, nonce, tag, key_id, updated_by)
          VALUES (
            ${input.repo}, ${input.name}, ${sealed.ciphertext}, ${sealed.nonce},
            ${sealed.tag}, ${sealed.keyId}, ${input.actor ?? ""}
          )
          ON CONFLICT (repo, name) DO UPDATE SET
            ciphertext = EXCLUDED.ciphertext,
            nonce = EXCLUDED.nonce,
            tag = EXCLUDED.tag,
            key_id = EXCLUDED.key_id,
            updated_by = EXCLUDED.updated_by,
            updated_at = now()
          RETURNING repo, name, created_at, updated_at, updated_by
        `,
      );
      const row = rows[0];
      if (row === undefined) {
        return yield* new SecretStorageError({
          message: `secret ${input.name}: the write answered no row`,
        });
      }
      return summaryOf(row);
    });

    const list = Effect.fn("SecretService.list")(function* (repo?: RepoSlug) {
      const rows = yield* withStorage(
        repo === undefined
          ? sql<SummaryRow>`
              SELECT repo, name, created_at, updated_at, updated_by FROM secrets
              ORDER BY repo, name
            `
          : sql<SummaryRow>`
              SELECT repo, name, created_at, updated_at, updated_by FROM secrets
              WHERE repo = ${repo}
              ORDER BY name
            `,
      );
      return rows.map(summaryOf);
    });

    const remove = Effect.fn("SecretService.remove")(function* (
      repo: RepoSlug,
      name: string,
    ) {
      const rows = yield* withStorage(
        sql<SummaryRow>`
          DELETE FROM secrets WHERE repo = ${repo} AND name = ${name}
          RETURNING repo, name, created_at, updated_at, updated_by
        `,
      );
      const row = rows[0];
      if (row === undefined) {
        return yield* new SecretNotFound({
          repo,
          name,
          message: `repo ${repo} holds no secret ${name}`,
        });
      }
      return summaryOf(row);
    });

    const reveal = Effect.fn("SecretService.reveal")(function* (
      repo: RepoSlug,
      names?: readonly string[],
    ) {
      if (names !== undefined && names.length === 0) {
        return { values: [], unreadable: [] } satisfies RevealedSecrets;
      }
      const rows = yield* withStorage(
        names === undefined
          ? sql<SealedRow>`
              SELECT name, ciphertext, nonce, tag, key_id FROM secrets
              WHERE repo = ${repo} ORDER BY name
            `
          : sql<SealedRow>`
              SELECT name, ciphertext, nonce, tag, key_id FROM secrets
              WHERE repo = ${repo} AND name IN ${sql.in(names)} ORDER BY name
            `,
      );
      const values: Array<InjectedSecrets[number]> = [];
      const unreadable: string[] = [];
      for (const row of rows) {
        const value =
          key === undefined ? undefined : openSecret(key, repo, row.name, row);
        if (value === undefined) unreadable.push(row.name);
        else values.push({ name: row.name, value: Redacted.make(value) });
      }
      return { values, unreadable } satisfies RevealedSecrets;
    });

    return {
      configured: key !== undefined,
      set,
      list,
      remove,
      reveal,
    } satisfies SecretServiceShape;
  });

/**
 * The store, keyed by `FACTORY_SECRETS_KEY`. A key that is set and malformed fails the layer
 * (`SecretsUnconfigured`) rather than storing with none.
 */
export const SecretServiceLive = Layer.effect(
  SecretService,
  Effect.gen(function* () {
    const configured = yield* SecretsConfig;
    const key = Option.match(configured, {
      onNone: () => undefined,
      onSome: (text) => parseSecretsKey(Redacted.value(text)),
    });
    if (Option.isSome(configured) && key === undefined) {
      return yield* new SecretsUnconfigured({
        message:
          "FACTORY_SECRETS_KEY is set but is not 32 bytes in base64 or 64 hex digits (openssl rand -base64 32)",
      });
    }
    if (key === undefined) {
      yield* Effect.logInfo(
        "no FACTORY_SECRETS_KEY: the control plane stores no secret, and runs get none",
      );
    }
    return SecretService.of(yield* makeSecretService(key));
  }),
);
