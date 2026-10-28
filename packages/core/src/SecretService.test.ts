/**
 * The secrets store against the real `secrets` table (S-agent-secrets): write-only summaries,
 * ciphertext at rest, refusals that write nothing, and a key that cannot read another key's rows.
 *
 * Postgres only, not mocked: `docker compose up -d --wait postgres`. Each case uses its own repo,
 * registered for it and deleted after (its secrets go with it). Every value is obviously fake.
 */
import { randomBytes } from "node:crypto";
import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { afterAll, describe, expect, it } from "vitest";
import { DatabaseLive } from "@repo/storage-postgres";
import { RepoSlug } from "@repo/domain/Session";
import {
  makeSecretService,
  openSecret,
  parseSecretsKey,
  sealSecret,
  type SecretServiceShape,
} from "./SecretService";

const runtime = ManagedRuntime.make(DatabaseLive);
const KEY = randomBytes(32);
const OTHER_KEY = randomBytes(32);
const FAKE = `fake-store-value-${randomBytes(6).toString("hex")}`;
const repos: RepoSlug[] = [];

afterAll(async () => {
  await runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      for (const repo of repos)
        yield* sql`DELETE FROM repos WHERE slug = ${repo}`;
    }),
  );
  await runtime.dispose();
});

const newRepo = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const repo = RepoSlug.make(`secrets-${randomBytes(4).toString("hex")}/store`);
  repos.push(repo);
  yield* sql`INSERT INTO repos (slug) VALUES (${repo})`;
  return repo;
});

const withStore = <A, E>(
  key: Buffer | undefined,
  f: (store: SecretServiceShape) => Effect.Effect<A, E, SqlClient>,
): Promise<A> => runtime.runPromise(Effect.flatMap(makeSecretService(key), f));

describe("the secrets store", () => {
  it("stores a value encrypted, answers only summaries, and reveals it to the control plane", async () => {
    const outcome = await withStore(KEY, (store) =>
      Effect.gen(function* () {
        const repo = yield* newRepo;
        const set = yield* store.set({
          repo,
          name: "TEST_API_KEY",
          value: Redacted.make(FAKE),
          actor: "person:test",
        });
        const listed = yield* store.list(repo);
        const all = yield* store.list();
        const sql = yield* SqlClient;
        const rows = yield* sql<{ readonly row: string }>`
          SELECT s::text AS row FROM secrets s WHERE repo = ${repo}
        `;
        const revealed = yield* store.reveal(repo);
        const named = yield* store.reveal(repo, ["OTHER"]);
        return { repo, set, listed, all, rows, revealed, named };
      }),
    );
    expect(outcome.set).toMatchObject({
      repo: outcome.repo,
      name: "TEST_API_KEY",
      updatedBy: "person:test",
    });
    expect(outcome.listed).toEqual([outcome.set]);
    expect(outcome.all).toContainEqual(outcome.set);
    for (const answered of [outcome.set, outcome.listed, outcome.all]) {
      expect(JSON.stringify(answered)).not.toContain(FAKE);
    }
    // At rest, the row holds ciphertext: not the value.
    expect(outcome.rows).toHaveLength(1);
    expect(outcome.rows[0]?.row).not.toContain(FAKE);
    expect(
      outcome.revealed.values.map((secret) => [
        secret.name,
        Redacted.value(secret.value),
      ]),
    ).toEqual([["TEST_API_KEY", FAKE]]);
    expect(outcome.named).toEqual({ values: [], unreadable: [] });
  });

  it("replaces a value under the same name, and deletes it for good", async () => {
    const outcome = await withStore(KEY, (store) =>
      Effect.gen(function* () {
        const repo = yield* newRepo;
        yield* store.set({ repo, name: "TOKEN_A", value: Redacted.make(FAKE) });
        yield* store.set({
          repo,
          name: "TOKEN_A",
          value: Redacted.make(`${FAKE}-2`),
        });
        const revealed = yield* store.reveal(repo);
        const removed = yield* store.remove(repo, "TOKEN_A");
        const again = yield* Effect.flip(store.remove(repo, "TOKEN_A"));
        return { revealed, removed, again, after: yield* store.list(repo) };
      }),
    );
    expect(
      outcome.revealed.values.map((secret) => Redacted.value(secret.value)),
    ).toEqual([`${FAKE}-2`]);
    expect(outcome.removed.name).toBe("TOKEN_A");
    expect(outcome.again._tag).toBe("SecretNotFound");
    expect(outcome.after).toEqual([]);
  });

  it("refuses a short value, an unregistered repo and a missing key, writing nothing", async () => {
    const outcome = await runtime.runPromise(
      Effect.gen(function* () {
        const repo = yield* newRepo;
        const keyed = yield* makeSecretService(KEY);
        const unkeyed = yield* makeSecretService(undefined);
        const short = yield* Effect.flip(
          keyed.set({ repo, name: "SHORT", value: Redacted.make("1234567") }),
        );
        const unknown = yield* Effect.flip(
          keyed.set({
            repo: RepoSlug.make(`nobody-${randomBytes(4).toString("hex")}/x`),
            name: "TOKEN",
            value: Redacted.make(FAKE),
          }),
        );
        const unconfigured = yield* Effect.flip(
          unkeyed.set({ repo, name: "TOKEN", value: Redacted.make(FAKE) }),
        );
        return {
          short,
          unknown,
          unconfigured,
          after: yield* keyed.list(repo),
          configured: [keyed.configured, unkeyed.configured],
        };
      }),
    );
    expect(outcome.short._tag).toBe("InvalidSecret");
    expect(outcome.unknown._tag).toBe("RepoNotFound");
    expect(outcome.unconfigured._tag).toBe("SecretsUnconfigured");
    expect(outcome.after).toEqual([]);
    expect(outcome.configured).toEqual([true, false]);
  });

  it("names a row another key wrote as unreadable rather than answering garbage", async () => {
    const outcome = await runtime.runPromise(
      Effect.gen(function* () {
        const repo = yield* newRepo;
        const writer = yield* makeSecretService(KEY);
        yield* writer.set({ repo, name: "TOKEN", value: Redacted.make(FAKE) });
        const other = yield* makeSecretService(OTHER_KEY);
        const unkeyed = yield* makeSecretService(undefined);
        return {
          other: yield* other.reveal(repo),
          unkeyed: yield* unkeyed.reveal(repo, ["TOKEN"]),
        };
      }),
    );
    expect(outcome.other).toEqual({ values: [], unreadable: ["TOKEN"] });
    expect(outcome.unkeyed).toEqual({ values: [], unreadable: ["TOKEN"] });
  });
});

describe("the cipher", () => {
  it("binds a ciphertext to its repo and name", () => {
    const sealed = sealSecret(KEY, "a/b", "TOKEN", FAKE);
    expect(openSecret(KEY, "a/b", "TOKEN", sealed)).toBe(FAKE);
    expect(openSecret(KEY, "a/c", "TOKEN", sealed)).toBeUndefined();
    expect(openSecret(KEY, "a/b", "OTHER", sealed)).toBeUndefined();
    expect(openSecret(OTHER_KEY, "a/b", "TOKEN", sealed)).toBeUndefined();
  });

  it("reads a key as base64 or hex of 32 bytes, and nothing else", () => {
    expect(parseSecretsKey(KEY.toString("base64"))?.equals(KEY)).toBe(true);
    expect(parseSecretsKey(KEY.toString("hex"))?.equals(KEY)).toBe(true);
    expect(parseSecretsKey(randomBytes(16).toString("base64"))).toBeUndefined();
    expect(parseSecretsKey("not a key")).toBeUndefined();
  });
});
