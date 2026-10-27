#!/usr/bin/env bun
// The specifying run's spec, as `drive.sh` cannot read it from a terminal (LOB-238): what the run's
// own log committed, what the card's `getTaskSpec` answers, and what the run's transcript says the
// `spec` tool told it. Everything a person reads — the spec in `factory board show` — `drive.sh`
// reads from the pane; this file reads the two facts no command prints: the log, and the refusal.
//
//   MODE=declared SESSION_ID=… TASK_ID=…  the asking run was offered `spec`; its first call (no
//                                         `gaps`) was refused naming the field, its retry accepted;
//                                         its log (the read-only fold, `readSessionLog`) and the card both
//                                         hold EXPECT_SPEC, by this run
//   MODE=closed   SESSION_ID=… TASK_ID=…  the run after the answer declared the same spec with its
//                                         gaps closed (`gaps: []`), and the card's spec is now its
//
// Env: API_URL, MODE, SESSION_ID, TASK_ID, EXPECT_SPEC (the JSON spec the faux's accepted attempt
// sends: the last element of up.sh's FAUX_SPEC), DATABASE_URL (for the log read), EVIDENCE_DIR.
// Writes `spec-<mode>.json` and exits non-zero when a check fails.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { RpcApi } from "@repo/domain/Rpc";
import type { SessionId } from "@repo/domain/Session";
import type { TaskId } from "@repo/domain/Task";
import {
  readOfferedTools,
  readSessionLog,
  SPEC_TOOL,
  type Spec,
} from "@repo/harness";
import { DatabaseLive, PostgresStorage } from "@repo/storage-postgres";
import { Effect, Scope } from "effect";
import { RpcClient } from "effect/rpc";
import { SqlClient } from "effect/sql/SqlClient";
import { makeChecker, protocolFor } from "../verify-api/harness.ts";
import type { CheckRecord } from "../verify-api/harness.ts";

const API_URL = process.env["API_URL"] ?? "http://localhost:9400";
const MODE = process.env["MODE"] ?? "";
const SESSION = (process.env["SESSION_ID"] ?? "") as SessionId;
const TASK = (process.env["TASK_ID"] ?? "") as TaskId;
const EXPECT: Spec = JSON.parse(process.env["EXPECT_SPEC"] ?? "null");
const EVIDENCE_DIR =
  process.env["EVIDENCE_DIR"] ?? ".verify/evidence/latest/board";
const REFUSAL =
  "spec refused: `gaps` is missing — declare the gaps, `[]` when there are none";

const observed: {
  mode: string;
  sessionId: string;
  taskId: string;
  facts: Record<string, unknown>;
  checks: Record<string, CheckRecord>;
} = { mode: MODE, sessionId: SESSION, taskId: TASK, facts: {}, checks: {} };
const check = makeChecker(observed);

/** Field by field, so a reordered list or a dropped item is a difference. */
const same = (a: Spec | undefined | null, b: Spec): boolean =>
  a !== undefined &&
  a !== null &&
  JSON.stringify([a.goal, a.acceptance, a.gaps, a.openQuestions]) ===
    JSON.stringify([b.goal, b.acceptance, b.gaps, b.openQuestions]);

/** What the run's own log says: the committed spec, and the tools its requests offered. */
const logOf = (sessionId: SessionId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    return yield* Effect.acquireUseRelease(
      Effect.promise(() => PostgresStorage.reader(sql, sessionId)),
      (storage) =>
        Effect.all({
          spec: Effect.map(readSessionLog(storage), (log) => log.spec),
          offered: readOfferedTools(storage),
        }),
      (storage) => Effect.promise(() => storage.dispose()),
    );
  }).pipe(Effect.provide(DatabaseLive));

const probe = (expected: Spec, refusedFirst: boolean) =>
  Effect.gen(function* () {
    const client = yield* RpcClient.make(RpcApi);
    const snapshot = yield* client.getSession({ sessionId: SESSION });
    const results = snapshot.entries.filter(
      (entry) => entry.kind === "toolResult" && entry.toolName === SPEC_TOOL,
    );
    observed.facts["specResults"] = results.map((entry) => ({
      isError: entry.isError === true,
      text: entry.text,
    }));
    const log = yield* logOf(SESSION);
    observed.facts["offeredTools"] = log.offered;
    observed.facts["loggedSpec"] = log.spec ?? null;
    check(
      "the run was offered the spec tool",
      log.offered.includes(SPEC_TOOL),
      `offered=${log.offered.join(",")}`,
    );
    if (refusedFirst) {
      check(
        "a spec missing gaps was refused, naming the field",
        results.length === 2 &&
          results[0]?.isError === true &&
          results[0].text.includes(REFUSAL),
        `results=${results.map((entry) => (entry.isError === true ? "refused" : "accepted")).join(",")}: ${results[0]?.text.slice(0, 90) ?? "-"}`,
      );
      check(
        "and the run's retry was accepted",
        results[1] !== undefined && results[1].isError !== true,
        `${results[1]?.text.slice(0, 90) ?? "no retry"}`,
      );
    } else {
      check(
        "the run's one spec was accepted",
        results.length === 1 && results[0]?.isError !== true,
        `results=${results.length}: ${results[0]?.text.slice(0, 90) ?? "-"}`,
      );
    }
    check(
      "the spec is committed to the run's log",
      same(log.spec, expected),
      `log=${JSON.stringify(log.spec ?? null)}`,
    );
    const card = yield* client.getTaskSpec({ taskId: TASK });
    observed.facts["cardSpec"] = card;
    check(
      "the card's spec (getTaskSpec) is the one this run declared",
      card !== null &&
        card.sessionId === SESSION &&
        card.column === "specifying" &&
        same(card, expected),
      `by=${card?.sessionId ?? "-"} column=${card?.column ?? "-"} gaps=${JSON.stringify(card?.gaps ?? null)}`,
    );
  });

/** Run one phase; a phase that fails outright is a failed check, not a crash with no evidence. */
const run = <E>(
  phase: Effect.Effect<void, E, RpcClient.Protocol | Scope.Scope>,
): Promise<void> =>
  Effect.runPromise(
    Effect.scoped(phase).pipe(
      Effect.provide(protocolFor(API_URL)),
      Effect.catch((error) =>
        Effect.sync(() => {
          check(`the ${MODE} probe ran`, false, String(error));
        }),
      ),
    ),
  );

if (EXPECT === null) {
  console.error(
    "spec.ts: EXPECT_SPEC must be the spec the faux's accepted attempt sends",
  );
  process.exit(2);
}
if (MODE === "declared") await run(probe(EXPECT, true));
else if (MODE === "closed")
  await run(
    probe(
      {
        goal: EXPECT.goal,
        acceptance: EXPECT.acceptance,
        gaps: [],
        openQuestions: [],
      },
      false,
    ),
  );
else {
  console.error("spec.ts: MODE must be one of declared, closed");
  process.exit(2);
}

await mkdir(EVIDENCE_DIR, { recursive: true });
await writeFile(
  path.join(EVIDENCE_DIR, `spec-${MODE}.json`),
  `${JSON.stringify(observed, null, 2)}\n`,
);
process.exit(Object.values(observed.checks).every((c) => c.passed) ? 0 : 1);
