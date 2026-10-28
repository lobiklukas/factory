/**
 * Setting a session's cap (C23): a session the cap stopped runs again once the cap is raised, and
 * the answer reports the budget as the log now holds it.
 *
 * Real runs on a priced faux model (`fauxCost`, a cent a request, as `SessionService.failures.test.ts`
 * does): the first message's run spends a cent on its tool call and the cap stops it there; the next
 * message's run answers from the tool's output, one request.
 *
 * Postgres only, not mocked: `docker compose up -d --wait postgres`.
 */
import { BunServices } from "@effect/platform-bun";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionId } from "@repo/domain/Session";
import { createFauxModelAccess, type FauxModelAccess } from "@repo/harness";
import { DatabaseLive } from "@repo/storage-postgres";
import { Effect, Layer, ManagedRuntime } from "effect";
import { describe, expect, it } from "vitest";
import { SessionService, SessionServiceLive } from "./SessionService";

const COST = 0.01;
const root = mkdtempSync(join(tmpdir(), "factory-core-budget-"));

const runtimeOver = (faux: FauxModelAccess) =>
  ManagedRuntime.make(
    SessionServiceLive({ model: faux.access, sessionRoot: root }).pipe(
      Layer.provideMerge(Layer.mergeAll(DatabaseLive, BunServices.layer)),
    ),
  );

/** Send `content` and wait until the run it starts has ended: idle, with `count` entries of `kind`. */
const sendAndSettle = (
  sessionId: SessionId,
  content: string,
  until: { readonly kind: "assistant" | "budget"; readonly count: number },
) =>
  Effect.gen(function* () {
    const sessions = yield* SessionService;
    yield* sessions.send({ sessionId, content });
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const snapshot = yield* sessions.get(sessionId);
      const seen = snapshot.entries.filter(
        (entry) => entry.kind === until.kind,
      ).length;
      if (snapshot.session.status === "idle" && seen >= until.count) {
        return snapshot;
      }
      yield* Effect.sleep(50);
    }
    return yield* Effect.die(new Error(`the run of "${content}" did not end`));
  });

describe("setBudget", () => {
  it("lets a session the cap stopped run again, and reports the new cap with no stop", async () => {
    const faux = createFauxModelAccess({ fauxCost: COST });
    const runtime = runtimeOver(faux);
    try {
      await runtime.runPromise(
        Effect.gen(function* () {
          const sessions = yield* SessionService;
          const created = yield* sessions.create({ budget: COST });
          const stopped = yield* sendAndSettle(created.id, "go", {
            kind: "budget",
            count: 1,
          });
          expect(stopped.budget?.stopped?.cap).toBeCloseTo(COST, 10);
          expect(faux.faux.state.callCount).toBe(1);

          const raised = yield* sessions.setBudget({
            sessionId: created.id,
            budget: 5 * COST,
          });
          expect(raised.budget.cap).toBeCloseTo(5 * COST, 10);
          expect(raised.budget.spent).toBeCloseTo(COST, 10);
          expect(raised.budget.stopped).toBeUndefined();
          expect(raised.message).toContain("$0.0500");
          expect(raised.message).toContain("let through");
          expect(raised.session.id).toBe(created.id);

          // The cap is the log's, not the call's: a fresh read agrees.
          const read = yield* sessions.get(created.id);
          expect(read.budget?.cap).toBeCloseTo(5 * COST, 10);
          expect(read.budget?.stopped).toBeUndefined();

          const after = yield* sendAndSettle(created.id, "go on", {
            kind: "assistant",
            count: 2,
          });
          // The reply the stopped session could not send: one more request, and no second stop.
          expect(faux.faux.state.callCount).toBe(2);
          expect(
            after.entries.filter((entry) => entry.kind === "budget"),
          ).toHaveLength(1);
          expect(after.budget?.stopped).toBeUndefined();
        }),
      );
    } finally {
      await runtime.dispose();
    }
  }, 60_000);

  it("says so when the spend already reaches the cap it sets", async () => {
    const faux = createFauxModelAccess({ fauxCost: COST });
    const runtime = runtimeOver(faux);
    try {
      await runtime.runPromise(
        Effect.gen(function* () {
          const sessions = yield* SessionService;
          const created = yield* sessions.create({ budget: COST });
          yield* sendAndSettle(created.id, "go", { kind: "budget", count: 1 });
          const same = yield* sessions.setBudget({
            sessionId: created.id,
            budget: COST,
          });
          expect(same.message).toContain("already reaches");
          // Not raised past the spend, so the next run is stopped before its request, and says so.
          const again = yield* sendAndSettle(created.id, "go on", {
            kind: "budget",
            count: 2,
          });
          expect(faux.faux.state.callCount).toBe(1);
          expect(again.budget?.stopped?.cap).toBeCloseTo(COST, 10);
        }),
      );
    } finally {
      await runtime.dispose();
    }
  }, 60_000);

  it("sets a cap on a session that had none", async () => {
    const faux = createFauxModelAccess({ fauxCost: COST });
    const runtime = runtimeOver(faux);
    try {
      await runtime.runPromise(
        Effect.gen(function* () {
          const sessions = yield* SessionService;
          const created = yield* sessions.create({});
          expect((yield* sessions.get(created.id)).budget).toBeUndefined();
          const capped = yield* sessions.setBudget({
            sessionId: created.id,
            budget: COST,
          });
          expect(capped.budget.cap).toBeCloseTo(COST, 10);
          const stopped = yield* sendAndSettle(created.id, "go", {
            kind: "budget",
            count: 1,
          });
          expect(stopped.budget?.stopped?.cap).toBeCloseTo(COST, 10);
        }),
      );
    } finally {
      await runtime.dispose();
    }
  }, 60_000);

  it("refuses a session that does not exist", async () => {
    const faux = createFauxModelAccess({ fauxCost: COST });
    const runtime = runtimeOver(faux);
    try {
      const error = await runtime.runPromise(
        Effect.gen(function* () {
          const sessions = yield* SessionService;
          return yield* sessions
            .setBudget({
              sessionId: SessionId.make(`ses_${"0".repeat(26)}`),
              budget: 1,
            })
            .pipe(Effect.flip);
        }),
      );
      expect(error.code).toBe("not_found");
    } finally {
      await runtime.dispose();
    }
  }, 60_000);
});
