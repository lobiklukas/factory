/**
 * A card's run that falls back onto its role's next model (S-model-provider-breadth), as the control
 * plane sees it: the session's model — on its summary, its snapshot and its list row — follows the
 * recorded switch, and a run that switched and then answered is not a failed run.
 *
 * The faux backend plays both models: `faux-1`, the specifier's model, answers its `bash` call and
 * then answers 529 (F6's `overloaded`), and `faux-backup` is the chain's one link. The harness half —
 * the switch itself, the transcript's order, each answer charged to its model, a second provider —
 * is `packages/harness/src/fallback.test.ts`.
 *
 * Postgres only, not mocked: `docker compose up -d --wait postgres`.
 */
import { BunServices } from "@effect/platform-bun";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RepoSlug } from "@repo/domain/Session";
import { DEFAULT_DEFINITION_ID, DefinitionId } from "@repo/domain/Task";
import {
  createFauxModelAccess,
  parseRoleFallbacks,
  resolveRoleFallbacks,
} from "@repo/harness";
import { DatabaseLive } from "@repo/storage-postgres";
import { Effect, Layer, ManagedRuntime } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { afterAll, describe, expect, it } from "vitest";
import { SessionService, SessionServiceLive } from "./SessionService";
import { TaskService, TaskServiceLive } from "./TaskService";

const root = mkdtempSync(join(tmpdir(), "factory-core-fallback-"));
const access = createFauxModelAccess({
  fauxModels: ["faux-1", "faux-backup"],
  fauxModelScripts: new Map([
    ["faux-1", { fail: { afterAnswers: 1, kind: "overloaded" } }],
  ]),
}).access;
const roleFallbacks = Effect.runSync(
  parseRoleFallbacks("specifier=faux/faux-backup").pipe(
    Effect.flatMap((declared) =>
      resolveRoleFallbacks(access, new Map(), declared),
    ),
  ),
);

const runtime = ManagedRuntime.make(
  Layer.mergeAll(
    SessionServiceLive({ model: access, roleFallbacks, sessionRoot: root }),
    TaskServiceLive,
  ).pipe(Layer.provideMerge(Layer.mergeAll(DatabaseLive, BunServices.layer))),
);
afterAll(() => runtime.dispose());

describe("a card's run on its role's fallback (S-model-provider-breadth)", () => {
  /**
   * Mutation: drop the owner's model update after a switch — the summary and snapshot say faux-1.
   * Mutation: drop the index write — the list row says faux-1.
   * Mutation: count a switched run's 529 as its ending — a `run_failures` row appears.
   */
  it("names the fallback as the session's model once it switched, and indexes no failed run", async () => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const sessions = yield* SessionService;
        const sql = yield* SqlClient;
        const board = yield* tasks.createBoard({
          repo: RepoSlug.make(
            `factory-test/${randomBytes(4).toString("hex")}`,
          ),
          definitionId: DefinitionId.make(DEFAULT_DEFINITION_ID),
        });
        const card = yield* tasks.create({
          boardId: board.id,
          title: "a card whose model goes down",
          actor: "person:lukas",
        });
        const moved = yield* tasks.move({
          taskId: card.id,
          expectedRevision: card.revision,
          to: "specifying",
          actor: "person:lukas",
        });
        const created = yield* sessions.create({
          taskId: moved.id,
          taskColumn: moved.column,
        });
        yield* sessions.send({ sessionId: created.id, content: "go" });
        let snapshot = yield* sessions.get(created.id);
        for (let attempt = 0; attempt < 400; attempt += 1) {
          snapshot = yield* sessions.get(created.id);
          const last = snapshot.entries.at(-1);
          if (
            !snapshot.live.busy &&
            last?.kind === "assistant" &&
            last.isError !== true &&
            snapshot.session.model === "faux/faux-backup"
          )
            break;
          yield* Effect.sleep(50);
        }
        const row = (yield* sessions.list({ limit: 200 })).sessions.find(
          (entry) => entry.id === created.id,
        );
        const failures = yield* sql<{ readonly reason: string }>`
          SELECT reason FROM run_failures WHERE session_id = ${created.id}
        `;
        return {
          createdModel: created.model,
          snapshot,
          listModel: row?.model,
          failures: failures.map((failure) => failure.reason),
        };
      }),
    );

    // It opened on the role's own model, and the switch moved it.
    expect(result.createdModel).toBe("faux/faux-1");
    expect(
      result.snapshot.entries.filter((entry) => entry.kind === "modelSwitch"),
    ).toHaveLength(1);
    expect(result.snapshot.entries.at(-1)?.text).toBe("faux-ok (re: go)");
    expect(result.snapshot.session.model).toBe("faux/faux-backup");
    expect(result.listModel).toBe("faux/faux-backup");
    expect(
      result.snapshot.usage.models.map((entry) => entry.key).sort(),
    ).toEqual(["faux/faux-1", "faux/faux-backup"]);
    expect(result.failures).toEqual([]);
  }, 60_000);
});
