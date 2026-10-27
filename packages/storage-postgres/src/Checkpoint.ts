import { MemoryStorage } from "@earendil-works/pi-durable";
import piDurable from "@earendil-works/pi-durable/package.json";
import { gunzipSync, gzipSync } from "node:zlib";

/**
 * The fold a log checkpoint holds: `MemoryStorage`'s state, encoded and restored (LOB-186).
 *
 * `MemoryStorage` is the fold every `PostgresStorage` read is answered by, and Pi Durable gives it
 * no snapshot or restore. Two ways to restore it were rejected: re-committing writes derived from
 * the public reads collapses every entry's `commitSeq` to the checkpoint's seq, which `entry()`
 * answers and `findLatestHeadMarker` orders by; and a snapshot API upstream is a change to a
 * dependency this repo consumes as an interface. So this module reads and writes the store's own
 * fields, and pays for that coupling three ways:
 *
 * - **The shape is pinned.** `CHECKPOINT_SHAPE` names this encoding and the installed Pi Durable
 *   release, and a checkpoint of any other shape is never restored. A dependency bump therefore
 *   costs one full fold per log, not a wrong answer.
 * - **The fields are checked, not assumed.** `foldShape` compares a fresh store's own fields, and
 *   the kind of each state field, with `FIELDS`. Any difference turns checkpoints off — none is
 *   written and none is read — and the conformance suite in `PostgresStorage.test.ts` fails on it,
 *   so the bump that changes the store is the change that has to revisit this file.
 * - **Nothing is mutated.** The fold is read and a fresh store is written; a live store's state is
 *   never touched, so the worst a mismatch can do is skip the shortcut.
 *
 * What a restore cannot carry is the store's id counter, and it does not have to: a fold's
 * `nextId` is one past the greatest id it applied (every applied id is a `recordTypes` key), so it
 * is derived from the state, exactly as a fold would leave it. An owner that minted ids it never
 * committed holds a higher counter than that, and a reopen through the full fold forgets those
 * ids too — the checkpoint answers what the fold would, which is the property being claimed.
 */

/**
 * The state fields of `MemoryStorage` in Pi Durable 1.0.3, each with how many `Map` layers it
 * nests: `0` is a JSON value as it stands (an id array, or an object of id arrays), `1` a `Map` of
 * JSON values, `2` a `Map` of `Map`s (`submissionIdsByRequest`).
 */
const FIELDS = {
  recordTypes: 1,
  conversations: 1,
  conversationIds: 0,
  conversationIdsByOwnerConversation: 1,
  conversationIdsByOwnerTask: 1,
  entries: 1,
  entryIds: 1,
  headEntryIds: 1,
  entryCommitSeqs: 1,
  tasks: 1,
  taskIds: 0,
  taskIdsByStatus: 0,
  submissions: 1,
  submissionIds: 0,
  submissionIdsByStatus: 0,
  submissionIdsByRequest: 2,
  documents: 1,
  documentAddresses: 1,
  documentIdsByScope: 1,
} as const satisfies Record<string, 0 | 1 | 2>;

type Depth = 0 | 1 | 2;

/** `MemoryStorage`'s own fields: the fold, the two counters, and the closed flag. */
const OWN_FIELDS = ["closed", "nextId", "nextSeq", "state"] as const;

/** The encoding and the release whose fold it encodes. Bump the leading version on any change here. */
export const CHECKPOINT_SHAPE = `memory-fold/1 pi-durable@${piDurable.version}`;

/** The first id a fresh `MemoryStorage` mints, which a fold of no ids keeps. */
const FIRST_ID = 2;

type State = Record<string, unknown>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const sameNames = (
  actual: readonly string[],
  expected: readonly string[],
): boolean => {
  if (actual.length !== expected.length) return false;
  const wanted = new Set(expected);
  return actual.every((name) => wanted.has(name));
};

/** The store's fold, when the store is the shape `FIELDS` describes. */
const stateOf = (store: MemoryStorage): State | undefined => {
  if (!sameNames(Object.keys(store), OWN_FIELDS)) return undefined;
  const state: unknown = Reflect.get(store, "state");
  if (!isRecord(state) || !sameNames(Object.keys(state), Object.keys(FIELDS)))
    return undefined;
  for (const [name, depth] of Object.entries(FIELDS)) {
    if (depth > 0 !== state[name] instanceof Map) return undefined;
  }
  return state;
};

let checkedShape: boolean | undefined;

/**
 * Whether the installed `MemoryStorage` is the one this module encodes. Checked once against a
 * fresh store; `false` turns checkpoints off rather than failing an open.
 */
export const foldShape = (): boolean => {
  checkedShape ??= stateOf(new MemoryStorage()) !== undefined;
  return checkedShape;
};

const encodeField = (value: unknown, depth: Depth): unknown => {
  if (depth === 0) return value;
  if (!(value instanceof Map)) throw new TypeError("expected a Map");
  return Array.from(value, ([key, inner]: [unknown, unknown]) => [
    key,
    encodeField(inner, depth === 2 ? 1 : 0),
  ]);
};

const decodeField = (value: unknown, depth: Depth): unknown => {
  if (depth === 0) return value;
  if (!Array.isArray(value)) throw new TypeError("expected an entry array");
  return new Map(
    value.map((pair: unknown): [unknown, unknown] => {
      if (!Array.isArray(pair) || pair.length !== 2) {
        throw new TypeError("expected a key and a value");
      }
      return [pair[0], decodeField(pair[1], depth === 2 ? 1 : 0)];
    }),
  );
};

/**
 * The store's fold as a checkpoint holds it: one JSON object with a member per state field, each
 * `Map` as an array of `[key, value]` pairs so number keys stay numbers. `undefined` when the
 * store is not the shape this module knows.
 */
export const encodeFold = (store: MemoryStorage): string | undefined => {
  if (!foldShape()) return undefined;
  const state = stateOf(store);
  if (state === undefined) return undefined;
  const fields: Record<string, unknown> = {};
  for (const [name, depth] of Object.entries(FIELDS)) {
    fields[name] = encodeField(state[name], depth);
  }
  return JSON.stringify(fields);
};

/**
 * The encoded fold as a checkpoint row stores it: gzip of its UTF-8 bytes.
 *
 * A fold is as large as the log's live records, and past the tail an open's cost is moving those
 * bytes out of Postgres; a session's JSON compresses several times over, so the row holds the
 * compressed bytes rather than `json` text. UTF-8 is lossless here because `JSON.stringify` escapes
 * the two things it could lose — lone surrogates and U+0000 — and Postgres never parses the bytes,
 * so neither can be rejected on the way in. `node:zlib` rather than the web `CompressionStream`,
 * which measured three times slower to inflate a 9 MB fold under Bun (LOB-186's benchmark).
 */
export const compressFold = (encoded: string): Uint8Array =>
  new Uint8Array(gzipSync(encoded));

/** The encoded fold a checkpoint row's bytes hold; throws on bytes that are not gzip. */
export const decompressFold = (compressed: Uint8Array): string =>
  gunzipSync(compressed).toString("utf8");

/**
 * A fresh store holding the fold `encoded` describes, as a fold of the log through commit `seq`
 * would leave it: the next commit is `seq + 1` and the next id one past the greatest applied.
 * `undefined` for anything that is not a fold this module wrote, so the caller folds instead.
 */
export const restoreFold = (
  encoded: string,
  seq: number,
): MemoryStorage | undefined => {
  if (!foldShape() || !Number.isSafeInteger(seq) || seq < 1) return undefined;
  try {
    const parsed: unknown = JSON.parse(encoded);
    if (
      !isRecord(parsed) ||
      !sameNames(Object.keys(parsed), Object.keys(FIELDS))
    )
      return undefined;
    const store = new MemoryStorage();
    const state = stateOf(store);
    if (state === undefined) return undefined;
    const decoded: State = {};
    for (const [name, depth] of Object.entries(FIELDS)) {
      const value = decodeField(parsed[name], depth);
      // A depth-0 field keeps its kind: an id array stays an array, a status table an object.
      if (depth === 0 && Array.isArray(value) !== Array.isArray(state[name]))
        return undefined;
      decoded[name] = value;
    }
    const recordTypes = decoded["recordTypes"];
    if (!(recordTypes instanceof Map)) return undefined;
    let nextId = FIRST_ID;
    for (const id of recordTypes.keys()) {
      if (typeof id !== "number" || !Number.isSafeInteger(id)) return undefined;
      nextId = Math.max(nextId, id + 1);
    }
    Object.assign(state, decoded);
    Reflect.set(store, "nextId", nextId);
    Reflect.set(store, "nextSeq", seq + 1);
    return store;
  } catch {
    return undefined;
  }
};
