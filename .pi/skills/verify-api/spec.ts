// The specifying stage's artifact across a process boundary (LOB-72, part 1 of LOB-46).
//
//   MODE=write    open a fresh log, show it holds no spec, offer a spec with no `gaps` field and a
//                 spec whose `gaps` is `null` — both refused, naming `gaps`, with different reasons,
//                 and neither committed — then commit a spec whose gaps are declared `[]`.
//   MODE=reopen   a fresh process on the same log: the spec it reads is the one `write` committed,
//                 `[]` still `[]`, and the reader-mode fold the control plane uses for a session it
//                 does not own reads the same value.
//
// What this drives is the harness's own client: `openSession` on a real `PostgresStorage`, and the
// `writeSpec`/`readSpec` pair the specifying stage will call. Not RPC — LOB-72 is harness-only (no
// task table, no RPC, no UI), and the first caller over the wire is the stage itself (LOB-73). Two
// processes rather than one, because "readable after reopen" is a claim about the log, and a single
// process could be answering out of memory.
//
// The log id is not a `ses_…` id on purpose: `rebuild.ts` skips such ids, so a drive run leaves no
// session row in the run's database and nothing for the session list to show.
//
// The model is pi-ai's in-process faux provider and no turn is run, so nothing here reaches a
// network or needs a key.
//
// Env: MODE, DATABASE_URL (via DatabaseLive), SPEC_STATE (the log id file), SPEC_CWD, EVIDENCE_DIR.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Effect, ManagedRuntime, Schema } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import {
  closeHarness,
  createModelAccess,
  openSession,
  readSessionLog,
  readSpec,
  SpecRefused,
  writeSpec,
} from "@repo/harness";
import { DatabaseLive, PostgresStorage } from "@repo/storage-postgres";
import { makeChecker } from "./harness.ts";
import type { CheckRecord } from "./harness.ts";

const MODE = process.env["MODE"] ?? "write";
const STATE = process.env["SPEC_STATE"] ?? ".verify/run/spec/log-id";
const CWD = process.env["SPEC_CWD"] ?? ".verify/run/spec/cwd";
const EVIDENCE_DIR =
  process.env["EVIDENCE_DIR"] ?? ".verify/evidence/latest/api";

/** A complete card's spec: nothing is missing, so nothing is asked — both declared as `[]`. */
const SPEC = {
  goal: "the specifying stage's artifact is typed and its gaps are explicit",
  acceptance: [
    "a spec with gaps: [] round-trips and reads the same after a reopen",
    "a spec missing gaps is refused with a typed error naming the field",
  ],
  gaps: [],
  openQuestions: [],
};

await mkdir(path.dirname(STATE), { recursive: true });
await mkdir(CWD, { recursive: true });
await mkdir(EVIDENCE_DIR, { recursive: true });

const observed: {
  mode: string;
  logId: string | null;
  pid: number;
  before: unknown;
  missing: unknown;
  invalid: unknown;
  committed: unknown;
  reopened: unknown;
  folded: unknown;
  checks: Record<string, CheckRecord>;
} = {
  mode: MODE,
  logId: null,
  pid: process.pid,
  before: null,
  missing: null,
  invalid: null,
  committed: null,
  reopened: null,
  folded: null,
  checks: {},
};
const assert = makeChecker(observed);

const runtime = ManagedRuntime.make(DatabaseLive);
const model = createModelAccess("faux");

/** Same content, `[]` included: a deep compare through JSON, which is what the log stores. */
const same = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

/** The refusal as evidence: its tag and the fields a caller branches on. */
const refusalRecord = (error: unknown) =>
  Schema.is(SpecRefused)(error)
    ? {
        tag: error._tag,
        field: error.field,
        reason: error.reason,
        fields: error.fields,
        message: error.message,
      }
    : { tag: "not a SpecRefused", value: String(error) };

const openOwned = (logId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const storage = yield* Effect.promise(() =>
      PostgresStorage.owner(sql, logId),
    );
    return yield* openSession({ storage, model, cwd: CWD });
  });

const write = Effect.gen(function* () {
  const logId = `verify-spec-${Date.now()}-${process.pid}`;
  observed.logId = logId;
  const { harness, root } = yield* openOwned(logId);

  const before = yield* readSpec(harness, root);
  observed.before = before ?? null;
  assert(
    "a log that never specified reads as no spec, not as one declaring no gaps",
    before === undefined,
    `readSpec=${JSON.stringify(before)}`,
  );

  const { gaps: _gaps, ...withoutGaps } = SPEC;
  const missing = yield* Effect.flip(writeSpec(root, withoutGaps));
  observed.missing = refusalRecord(missing);
  assert(
    "a spec with no gaps field is refused with a typed error naming gaps as missing",
    Schema.is(SpecRefused)(missing) &&
      missing.field === "gaps" &&
      missing.reason === "missing",
    JSON.stringify(observed.missing),
  );
  const afterRefusal = yield* readSpec(harness, root);
  assert(
    "and the refusal committed nothing",
    afterRefusal === undefined,
    `readSpec=${JSON.stringify(afterRefusal)}`,
  );

  const invalid = yield* Effect.flip(writeSpec(root, { ...SPEC, gaps: null }));
  observed.invalid = refusalRecord(invalid);
  assert(
    "gaps: null is refused for the same field with a different reason, so absent is its own answer",
    Schema.is(SpecRefused)(invalid) &&
      invalid.field === "gaps" &&
      invalid.reason === "invalid",
    JSON.stringify(observed.invalid),
  );

  const committed = yield* writeSpec(root, SPEC);
  observed.committed = committed;
  const live = yield* readSpec(harness, root);
  assert(
    "a spec with gaps: [] is accepted and reads back with the same content",
    same(committed, SPEC) && same(live, SPEC),
    `readSpec=${JSON.stringify(live)}`,
  );
  yield* closeHarness(harness);
  yield* Effect.promise(() => writeFile(STATE, logId));
});

const reopen = Effect.gen(function* () {
  const logId = yield* Effect.promise(() =>
    readFile(STATE, "utf8").then((value) => value.trim()),
  );
  observed.logId = logId;
  const { harness, root } = yield* openOwned(logId);
  const reopened = yield* readSpec(harness, root);
  observed.reopened = reopened ?? null;
  yield* closeHarness(harness);
  assert(
    "a fresh process reads the spec the first process committed, with the same content",
    same(reopened, SPEC),
    `readSpec=${JSON.stringify(reopened)}`,
  );
  assert(
    "and its gaps are still declared as [] — present and empty, not dropped",
    reopened !== undefined &&
      Array.isArray(reopened.gaps) &&
      reopened.gaps.length === 0,
    `gaps=${JSON.stringify(reopened?.gaps)}`,
  );

  const sql = yield* SqlClient;
  const reader = yield* Effect.promise(() =>
    PostgresStorage.reader(sql, logId),
  );
  const folded = yield* readSessionLog(reader);
  yield* Effect.promise(() => reader.dispose());
  observed.folded = folded.spec ?? null;
  assert(
    "the read-only fold of the same log reads the same spec",
    same(folded.spec, SPEC),
    `readSessionLog.spec=${JSON.stringify(folded.spec)}`,
  );
});

try {
  await runtime.runPromise(MODE === "write" ? write : reopen);
} catch (error) {
  assert(
    `${MODE} phase completed`,
    false,
    `threw: ${error instanceof Error ? error.message : JSON.stringify(error)}`,
  );
} finally {
  await runtime.dispose();
}

await writeFile(
  path.join(EVIDENCE_DIR, `spec-${MODE}.json`),
  `${JSON.stringify(observed, null, 2)}\n`,
);

const failed = Object.entries(observed.checks).filter(
  ([, check]) => !check.passed,
);
if (failed.length > 0) {
  console.error(`\n${failed.length} required check(s) failed (${MODE})`);
  process.exitCode = 1;
}
