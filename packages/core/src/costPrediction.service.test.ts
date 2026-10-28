/**
 * Cost prediction through the service (LOB-38): `predictCost` and `backtestCost` read the completed
 * sessions the index holds, and only those.
 *
 * `costPrediction.test.ts` proves the arithmetic over hand-made histories; these cases prove what
 * the service adds — which sessions count as history (idle, priced, no run or mission in flight),
 * that a session's title, repo, model and `cost_total` reach the predictor as the index holds them,
 * that a prompt with no model is predicted on the deployment's, and that a model the process does not
 * serve is refused as `create` refuses it.
 *
 * The sessions are real runs on a priced faux model (`fauxCost`, a cent a request): the first
 * message is two requests (the `bash` call and the reply) and each later one a reply alone, so a
 * session sent k messages costs k + 1 cents, and four of them cost 2, 2, 3 and 4 cents in creation
 * order. Every expected number is worked out by hand beside it. The repo is this run's own, so the
 * suite's other sessions never land in the repo's comparables; the backtest's fallback tiers read the
 * whole shared index, so only the row whose own tier answers is asserted number for number.
 *
 * Postgres only, not mocked: `docker compose up -d --wait postgres`.
 */
import { BunServices } from "@effect/platform-bun";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RepoSlug, type SessionId } from "@repo/domain/Session";
import { createFauxModelAccess, usageCostTotal } from "@repo/harness";
import { DatabaseLive } from "@repo/storage-postgres";
import { Effect, Layer, ManagedRuntime } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { afterAll, describe, expect, it } from "vitest";
import { SessionService, SessionServiceLive } from "./SessionService";

const DatabaseLayer = Layer.mergeAll(DatabaseLive, BunServices.layer);
const COST = 0.01;
const root = mkdtempSync(join(tmpdir(), "factory-core-cost-"));
const runtime = ManagedRuntime.make(
  SessionServiceLive({
    model: createFauxModelAccess({ fauxCost: COST }).access,
    sessionRoot: root,
  }).pipe(Layer.provideMerge(DatabaseLayer)),
);

afterAll(async () => {
  await runtime.dispose();
});

const waitUntil = <E, R>(
  check: Effect.Effect<boolean, E, R>,
  label: string,
): Effect.Effect<void, E, R> =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      if (yield* check) return;
      yield* Effect.sleep(50);
    }
    return yield* Effect.die(new Error(`timed out waiting for ${label}`));
  });

describe("cost prediction from the session index", () => {
  const tag = randomBytes(4).toString("hex");
  const repo = RepoSlug.make(`cost-${tag}/web`);
  const other = RepoSlug.make(`cost-${tag}/api`);

  it("predicts from the repo's completed fixes, backtests them, and counts only completed, priced sessions", async () => {
    const outcome = await runtime.runPromise(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const sql = yield* SqlClient;

        // Settled means answered *and* indexed: the activity row holds the spend the log does.
        const settled = (id: SessionId, answers: number) =>
          waitUntil(
            Effect.gen(function* () {
              const snapshot = yield* sessions.get(id);
              const indexed = yield* sql<{ costTotal: number }>`
                SELECT cost_total::float8 AS cost_total
                FROM session_activity WHERE session_id = ${id}
              `;
              return (
                !snapshot.live.busy &&
                snapshot.entries.filter(
                  (entry) => entry.kind === "assistant" && entry.text !== "",
                ).length >= answers &&
                indexed[0]?.costTotal === usageCostTotal(snapshot.usage)
              );
            }),
            `session ${id} to settle`,
          );
        // One session sent `messages` messages, the first of which titles it.
        const run = (prompt: string, messages: number, on = repo) =>
          Effect.gen(function* () {
            const created = yield* sessions.create({ repo: on });
            for (let sent = 1; sent <= messages; sent += 1) {
              yield* sessions.send({
                sessionId: created.id,
                content: sent === 1 ? prompt : "and again",
              });
              yield* settled(created.id, sent);
            }
            return created.id;
          });

        const first = yield* run("fix the parser bug", 1);
        yield* run("fix the lexer crash", 1);
        yield* run("fix the failing build", 2);
        const last = yield* run("fix the broken import", 3);
        // A session that never ran: it costs nothing, so it is no history.
        yield* sessions.create({ repo, title: "fix nothing at all" });
        // Another repo's session, more expensive than any of ours: never scored in a repo-scoped
        // backtest, and created after ours, so never history any of them is predicted from.
        yield* run("fix the api bug", 4, other);

        const costs = yield* sql<{ costTotal: number }>`
          SELECT a.cost_total::float8 AS cost_total
          FROM session_activity a JOIN sessions s ON s.id = a.session_id
          WHERE s.repo = ${repo} ORDER BY s.created_at
        `;

        const prediction = yield* sessions.predictCost({
          prompt: "fix the flaky test\n\nit fails one run in ten",
          repo,
        });
        const backtest = yield* sessions.backtestCost({ repo, rows: true });

        // A session still running, or one whose run or mission is in flight, is not completed.
        const without = <A, E>(statement: Effect.Effect<A, E>) =>
          Effect.gen(function* () {
            yield* Effect.orDie(statement);
            return (yield* sessions.backtestCost({ repo })).sessions;
          });
        const busy = yield* without(
          sql`UPDATE session_activity SET status = 'busy' WHERE session_id = ${last}`,
        );
        yield* sql`UPDATE session_activity SET status = 'idle' WHERE session_id = ${last}`;
        const running = yield* without(
          sql`UPDATE sessions SET run_session_root = ${root} WHERE id = ${last}`,
        );
        yield* sql`UPDATE sessions SET run_session_root = NULL WHERE id = ${last}`;
        const mission = yield* without(
          sql`UPDATE sessions SET mission_in_flight = true WHERE id = ${first}`,
        );
        yield* sql`UPDATE sessions SET mission_in_flight = false WHERE id = ${first}`;

        const refused = yield* Effect.flip(
          sessions.predictCost({ prompt: "fix it", model: "faux/no-such" }),
        );
        return {
          costs: costs.map((row) => row.costTotal),
          prediction,
          backtest,
          busy,
          running,
          mission,
          refused,
        };
      }),
    );

    // The runs cost what their requests did: 2, 2, 3 and 4 cents, and the unrun one nothing.
    expect(outcome.costs.map((cost) => Math.round(cost * 100))).toEqual([
      2, 2, 3, 4, 0,
    ]);

    // A fix (the first line says so) on this repo and the deployment's model: the four priced fixes.
    // [0.02, 0.02, 0.03, 0.04]: p10 at position 0.3 → 0.02; the median at 1.5 → 0.025; p90 at 2.7
    // → 0.03 + 0.7 × 0.01 = 0.037.
    const { prediction } = outcome;
    expect(prediction.shape).toBe("fix");
    expect(prediction.repo).toBe(repo);
    expect(prediction.model).toBe("faux/faux-1");
    expect(prediction.basis).toBe("repo+model+shape");
    expect(prediction.comparables).toBe(4);
    expect(prediction.history).toBeGreaterThanOrEqual(5);
    expect(prediction.range?.low).toBeCloseTo(0.02, 10);
    expect(prediction.range?.median).toBeCloseTo(0.025, 10);
    expect(prediction.range?.high).toBeCloseTo(0.037, 10);

    // The backtest scores the repo's four. The first three have fewer than three of the repo's own
    // before them, so they are skipped or answered from the suite's other sessions on a fallback
    // tier, which this case does not pin. The last is predicted from the three fixes before it on
    // repo+model+shape, [0.02, 0.02, 0.03] — median 0.02, high 0.02 + 0.8 × 0.01 = 0.028 — and cost
    // 0.04: off by 0.02, which is half of it, and outside its range.
    const { backtest } = outcome;
    expect(backtest.sessions).toBe(4);
    expect(backtest.scored + backtest.skipped).toBe(4);
    expect(backtest.rows).toHaveLength(backtest.scored);
    const lastRow = backtest.rows?.find(
      (row) => row.title === "fix the broken import",
    );
    expect(lastRow?.basis).toBe("repo+model+shape");
    expect(lastRow?.range.median).toBeCloseTo(0.02, 10);
    expect(lastRow?.range.high).toBeCloseTo(0.028, 10);
    expect(lastRow?.relativeError).toBeCloseTo(0.5, 10);
    expect(backtest.meaningful).toBe(false);

    expect(outcome.busy).toBe(3);
    expect(outcome.running).toBe(3);
    expect(outcome.mission).toBe(3);

    // A model the process does not serve is refused, as `create` refuses it.
    expect(outcome.refused.code).toBe("invalid_input");
    expect(outcome.refused.message).toContain("faux/no-such");
  }, 180_000);
});
