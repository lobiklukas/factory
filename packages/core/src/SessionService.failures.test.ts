/**
 * Failed runs, as the activity projection indexes them for the notifier (S-notifications): a run
 * its budget stopped, and a run whose model request failed for good, each leave one `run_failures`
 * row keyed by the entry that announced it; a run that answered leaves none.
 *
 * The faux model is scripted per case: priced for the budget stop (`fauxCost`), and answering a
 * non-retryable provider error for the failed request — Pi Durable retries a transient one, so the
 * message is one its retry policy does not match, and the run ends `unanswered`, `model_error`.
 *
 * Postgres only, not mocked: `docker compose up -d --wait postgres`.
 */
import { BunServices } from "@effect/platform-bun";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionId } from "@repo/domain/Session";
import { createFauxModelAccess, type FauxModelAccess } from "@repo/harness";
import { DatabaseLive } from "@repo/storage-postgres";
import { Effect, Layer, ManagedRuntime } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { describe, expect, it } from "vitest";
import { SessionService, SessionServiceLive } from "./SessionService";

const root = mkdtempSync(join(tmpdir(), "factory-core-failures-"));

const runtimeOver = (faux: FauxModelAccess) =>
  ManagedRuntime.make(
    SessionServiceLive({ model: faux.access, sessionRoot: root }).pipe(
      Layer.provideMerge(Layer.mergeAll(DatabaseLive, BunServices.layer)),
    ),
  );

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

const failuresOf = (sessionId: SessionId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    return yield* sql<{
      readonly entryId: string;
      readonly reason: string;
      readonly detail: string;
    }>`
      SELECT entry_id, reason, detail FROM run_failures
      WHERE session_id = ${sessionId} ORDER BY failed_at
    `;
  });

/** Run one message to its end and read what the projection indexed. */
const runOnce = (faux: FauxModelAccess, budget?: number) =>
  Effect.gen(function* () {
    const sessions = yield* SessionService;
    const created = yield* sessions.create(
      budget === undefined ? {} : { budget },
    );
    yield* sessions.send({ sessionId: created.id, content: "go" });
    yield* waitUntil(
      Effect.map(
        sessions.get(created.id),
        (snapshot) =>
          snapshot.session.status === "idle" &&
          snapshot.entries.some(
            (entry) => entry.kind === "assistant" || entry.kind === "budget",
          ),
      ),
      "the run to end",
    );
    const snapshot = yield* sessions.get(created.id);
    // The row is a best-effort write after the status; wait for it, or for long enough to say none.
    let rows = yield* failuresOf(created.id);
    for (let attempt = 0; attempt < 20 && rows.length === 0; attempt += 1) {
      yield* Effect.sleep(50);
      rows = yield* failuresOf(created.id);
    }
    // The rows are read; leave none behind for a notifier on the same database to send.
    const sql = yield* SqlClient;
    yield* sql`DELETE FROM run_failures WHERE session_id = ${created.id}`;
    return { snapshot, rows, calls: faux.faux.state.callCount };
  });

const PROVIDER_ERROR = "invalid_api_key: the provider refused the credential";
const RETRYABLE_ERROR = "overloaded_error: try again later";

/** An assistant message whose request failed with `errorMessage`, as a provider ends one. */
const failedAnswer = (errorMessage: string) => ({
  role: "assistant" as const,
  content: [],
  api: "faux",
  provider: "faux",
  model: "faux-1",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "error" as const,
  errorMessage,
  timestamp: 0,
});

describe("failed runs in run_failures", () => {
  it("indexes a budget stop under its entry, once", async () => {
    const faux = createFauxModelAccess({ fauxCost: 0.01 });
    const runtime = runtimeOver(faux);
    try {
      const { snapshot, rows } = await runtime.runPromise(runOnce(faux, 0.01));
      const stop = snapshot.entries.find((entry) => entry.kind === "budget");
      expect(stop).toBeDefined();
      expect(rows).toEqual([
        { entryId: stop?.id, reason: "budget", detail: stop?.text },
      ]);
      expect(rows[0]?.detail).toContain("budget reached");
    } finally {
      await runtime.dispose();
    }
  }, 60_000);

  it("indexes a run whose model request failed, with the provider's message", async () => {
    const faux = createFauxModelAccess();
    faux.faux.setResponses([failedAnswer(PROVIDER_ERROR)]);
    const runtime = runtimeOver(faux);
    try {
      const { snapshot, rows, calls } = await runtime.runPromise(runOnce(faux));
      // Not retried: one request, and the run ended on it.
      expect(calls).toBe(1);
      const failed = snapshot.entries.find(
        (entry) => entry.kind === "assistant" && entry.isError === true,
      );
      // The provider's message rides beside the text; the text stays the (empty) answer.
      expect(failed?.error).toBe(PROVIDER_ERROR);
      expect(failed?.text).toBe("");
      expect(rows).toEqual([
        { entryId: failed?.id, reason: "model_error", detail: PROVIDER_ERROR },
      ]);
    } finally {
      await runtime.dispose();
    }
  }, 60_000);

  it("indexes nothing for a run an operator interrupted while a failed request waited to be retried", async () => {
    const faux = createFauxModelAccess();
    // A transient error Pi Durable retries after its backoff (two seconds); the answer is never
    // asked for, because the interrupt lands inside the backoff.
    faux.faux.setResponses([
      failedAnswer(RETRYABLE_ERROR),
      {
        ...failedAnswer(""),
        content: [{ type: "text", text: "late answer" }],
        stopReason: "stop",
      },
    ]);
    const runtime = runtimeOver(faux);
    try {
      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const sessions = yield* SessionService;
          const created = yield* sessions.create({});
          yield* sessions.send({ sessionId: created.id, content: "go" });
          yield* waitUntil(
            Effect.map(sessions.get(created.id), (snapshot) =>
              snapshot.entries.some(
                (entry) => entry.kind === "assistant" && entry.isError === true,
              ),
            ),
            "the failed request",
          );
          const stopped = yield* sessions.interrupt(created.id);
          yield* waitUntil(
            Effect.map(
              sessions.get(created.id),
              (snapshot) =>
                snapshot.session.status === "idle" &&
                snapshot.entries.some((entry) => entry.kind === "interrupted"),
            ),
            "the interrupted run to settle",
          );
          // Long enough for a best-effort row that should not exist to have landed.
          yield* Effect.sleep(500);
          return {
            stopped,
            rows: yield* failuresOf(created.id),
            calls: faux.faux.state.callCount,
          };
        }),
      );
      expect(result.stopped.outcome).toBe("interrupted");
      // The retry never ran: the interrupt stopped the run inside its backoff.
      expect(result.calls).toBe(1);
      expect(result.rows).toEqual([]);
    } finally {
      await runtime.dispose();
    }
  }, 60_000);

  it("indexes nothing for a run that answered", async () => {
    const faux = createFauxModelAccess();
    const runtime = runtimeOver(faux);
    try {
      const { snapshot, rows } = await runtime.runPromise(runOnce(faux));
      expect(
        snapshot.entries.some(
          (entry) => entry.kind === "assistant" && entry.text !== "",
        ),
      ).toBe(true);
      expect(rows).toEqual([]);
    } finally {
      await runtime.dispose();
    }
  }, 60_000);
});
