#!/usr/bin/env bun
// The planning run's plan, as `drive.sh` cannot read it from a terminal (D10): what the run's own log
// committed and offered, what the card's `getTaskPlan` answers, and what the run's transcript says the
// `plan` tool told it. What a person reads — the plan in `factory board show`, the card pane —
// `drive.sh` and `plan-pane.mjs` read from the surfaces; this file reads the facts no command prints.
//
//   SESSION_ID=… TASK_ID=…  the planning run settled on its own answer; it was offered `plan` and none of `write`, `edit` or
//                           `verify`; its first call (no `risks`) was refused naming the field, its
//                           retry accepted; its log (the read-only fold, `readSessionLog`) and the
//                           card both hold EXPECT_PLAN, by this run, from planning
//
// Env: API_URL, SESSION_ID, TASK_ID, EXPECT_PLAN (the JSON plan the faux's accepted attempt sends:
// up.sh's FAUX_PLAN_ACCEPTED, in .verify/run/faux-plan), DATABASE_URL (for the log read),
// EVIDENCE_DIR. Writes `plan-declared.json` and exits non-zero when a check fails.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { RpcApi } from "@repo/domain/Rpc";
import type { SessionId } from "@repo/domain/Session";
import type { TaskId } from "@repo/domain/Task";
import {
  PLAN_TOOL,
  readOfferedTools,
  readSessionLog,
  STAGE_REFUSED_TOOLS,
  type Plan,
} from "@repo/harness";
import { DatabaseLive, PostgresStorage } from "@repo/storage-postgres";
import { Effect, Scope } from "effect";
import { RpcClient } from "effect/rpc";
import { SqlClient } from "effect/sql/SqlClient";
import { makeChecker, protocolFor } from "../verify-api/harness.ts";
import type { CheckRecord } from "../verify-api/harness.ts";

const API_URL = process.env["API_URL"] ?? "http://localhost:9400";
const SESSION = (process.env["SESSION_ID"] ?? "") as SessionId;
const TASK = (process.env["TASK_ID"] ?? "") as TaskId;
const EXPECT: Plan | null = JSON.parse(process.env["EXPECT_PLAN"] ?? "null");
const EVIDENCE_DIR =
  process.env["EVIDENCE_DIR"] ?? ".verify/evidence/latest/board";
const REFUSAL =
  "plan refused: `risks` is missing — declare the risks, `[]` when there are none";

const observed: {
  sessionId: string;
  taskId: string;
  facts: Record<string, unknown>;
  checks: Record<string, CheckRecord>;
} = { sessionId: SESSION, taskId: TASK, facts: {}, checks: {} };
const check = makeChecker(observed);

/** Field by field, so a reordered list or a dropped item is a difference. */
const same = (
  a:
    | Pick<Plan, "summary" | "steps" | "surfaces" | "risks">
    | undefined
    | null,
  b: Plan,
): boolean =>
  a !== undefined &&
  a !== null &&
  JSON.stringify([a.summary, a.steps, a.surfaces, a.risks]) ===
    JSON.stringify([b.summary, b.steps, b.surfaces, b.risks]);

/** What the run's own log says: the committed plan, and the tools its requests offered. */
const logOf = (sessionId: SessionId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    return yield* Effect.acquireUseRelease(
      Effect.promise(() => PostgresStorage.reader(sql, sessionId)),
      (storage) =>
        Effect.all({
          plan: Effect.map(readSessionLog(storage), (log) => log.plan),
          offered: readOfferedTools(storage),
        }),
      (storage) => Effect.promise(() => storage.dispose()),
    );
  }).pipe(Effect.provide(DatabaseLive));

/** How long the planning run has to settle on its own answer: one `ls` turn and two `plan` calls. */
const SETTLE_TIMEOUT_MS = Number(process.env["SETTLE_TIMEOUT_MS"] ?? "90000");

const probe = (expected: Plan) =>
  Effect.gen(function* () {
    const client = yield* RpcClient.make(RpcApi);
    // The run was started by `board start`, which answers before the turn ends: wait until it is
    // idle on an answer of its own (an assistant entry calling no tool), never on a fixed sleep.
    const deadline = Date.now() + SETTLE_TIMEOUT_MS;
    let snapshot = yield* client.getSession({ sessionId: SESSION });
    const settled = (s: typeof snapshot) => {
      const last = s.entries.at(-1);
      return (
        !s.live.busy &&
        last?.kind === "assistant" &&
        last.toolCalls.length === 0
      );
    };
    while (!settled(snapshot) && Date.now() < deadline) {
      yield* Effect.sleep("500 millis");
      snapshot = yield* client.getSession({ sessionId: SESSION });
    }
    check(
      "the planning run settled on its own answer",
      settled(snapshot),
      `busy=${String(snapshot.live.busy)} last=${snapshot.entries.at(-1)?.kind ?? "-"}`,
    );
    const results = snapshot.entries.filter(
      (entry) => entry.kind === "toolResult" && entry.toolName === PLAN_TOOL,
    );
    observed.facts["planResults"] = results.map((entry) => ({
      isError: entry.isError === true,
      text: entry.text,
    }));
    const log = yield* logOf(SESSION);
    observed.facts["offeredTools"] = log.offered;
    observed.facts["loggedPlan"] = log.plan ?? null;
    check(
      "the planning run was offered the plan tool",
      log.offered.includes(PLAN_TOOL),
      `offered=${log.offered.join(",")}`,
    );
    const writes = [...STAGE_REFUSED_TOOLS].filter((tool) =>
      log.offered.includes(tool),
    );
    check(
      "and none of write, edit or verify: the planning stage only reads",
      writes.length === 0 && log.offered.includes("read"),
      `offered write tools: ${writes.join(",") || "none"}`,
    );
    check(
      "a plan missing risks was refused, naming the field",
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
    check(
      "the plan is committed to the run's log",
      same(log.plan, expected),
      `log=${JSON.stringify(log.plan ?? null)}`,
    );
    const card = yield* client.getTaskPlan({ taskId: TASK });
    observed.facts["cardPlan"] = card;
    check(
      "the card's plan (getTaskPlan) is the one this run declared, from planning",
      card !== null &&
        card.sessionId === SESSION &&
        card.column === "planning" &&
        same(card, expected),
      `by=${card?.sessionId ?? "-"} column=${card?.column ?? "-"} steps=${card?.steps.length ?? 0}`,
    );
    const task = yield* client.getTask({ taskId: TASK });
    check(
      "the run left the card in planning: a person approves the plan",
      task.column === "planning",
      `column=${task.column}`,
    );
  });

if (EXPECT === null) {
  console.error(
    "plan.ts: EXPECT_PLAN must be the plan the faux's accepted attempt sends",
  );
  process.exit(2);
}

/** Run the probe; one that fails outright is a failed check, not a crash with no evidence. */
const run = <E>(
  phase: Effect.Effect<void, E, RpcClient.Protocol | Scope.Scope>,
): Promise<void> =>
  Effect.runPromise(
    Effect.scoped(phase).pipe(
      Effect.provide(protocolFor(API_URL)),
      Effect.catch((error) =>
        Effect.sync(() => {
          check("the plan probe ran", false, String(error));
        }),
      ),
    ),
  );

await run(probe(EXPECT));

await mkdir(EVIDENCE_DIR, { recursive: true });
await writeFile(
  path.join(EVIDENCE_DIR, "plan-declared.json"),
  `${JSON.stringify(observed, null, 2)}\n`,
);
process.exit(Object.values(observed.checks).every((c) => c.passed) ? 0 : 1);
