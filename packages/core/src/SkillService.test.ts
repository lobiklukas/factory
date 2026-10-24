/**
 * The skill service against the real `skills` table (LOB-173, part 2 of LOB-48).
 *
 * Postgres only, not mocked: `docker compose up -d --wait postgres`. The table is the one
 * `0009_create_skills.ts` creates, seeded with the three stage skills. Cases that write use their
 * own randomly named skill and delete it afterwards, so the seeded rows are never disturbed.
 */
import { randomBytes } from "node:crypto";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { afterAll, describe, expect, it } from "vitest";
import { DatabaseLive } from "@repo/storage-postgres";
import { Skill, type SkillError } from "@repo/domain/Skill";
import {
  SkillService,
  SkillServiceLive,
  type SkillServiceShape,
} from "./SkillService";

const runtime = ManagedRuntime.make(
  SkillServiceLive.pipe(Layer.provideMerge(DatabaseLive)),
);

afterAll(() => runtime.dispose());

const withService = <A, E>(
  f: (service: SkillServiceShape) => Effect.Effect<A, E>,
): Promise<A> =>
  runtime.runPromise(
    Effect.gen(function* () {
      const service = yield* SkillService;
      return yield* f(service);
    }),
  );

/** The refusal an operation failed with, or a test failure if it succeeded. */
const refusal = (
  f: (service: SkillServiceShape) => Effect.Effect<unknown, SkillError>,
): Promise<SkillError> =>
  runtime.runPromise(
    Effect.gen(function* () {
      const service = yield* SkillService;
      return yield* f(service).pipe(
        Effect.match({
          onFailure: (error): SkillError => error,
          onSuccess: (): SkillError => {
            throw new Error("expected a refusal, but the operation succeeded");
          },
        }),
      );
    }),
  );

const hex = (bytes: number) => randomBytes(bytes).toString("hex");

/** A skill document under a name no other case uses. */
const newSkill = (name = `test-skill-${hex(6)}`): Skill => ({
  name,
  version: "1",
  description: "a skill written by a test",
  body: "# Test\n\nA body with **markdown** and a trailing newline.\n",
  attachments: ["docs/board.md", ".pi/skills/effect/SKILL.md"],
});

/** Deletes a skill a case wrote, leaving the seeded rows alone. */
const removeSkill = (name: string): Promise<void> =>
  runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      yield* sql`DELETE FROM skills WHERE name = ${name}`;
    }),
  );

/** How many rows the table holds under one name. An upsert must never add a second. */
const rowCount = (name: string): Promise<number> =>
  runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const rows = yield* sql<{ n: number }>`
        SELECT count(*)::int AS n FROM skills WHERE name = ${name}
      `;
      return rows[0]?.n ?? -1;
    }),
  );

describe("Skill domain contract", () => {
  it("round-trips a skill document through the schema", () => {
    const skill = newSkill();
    const encoded = Schema.encodeSync(Schema.fromJsonString(Skill))(skill);
    expect(Schema.decodeSync(Schema.fromJsonString(Skill))(encoded)).toEqual(
      skill,
    );
  });

  it("refuses a document with a non-string attachment", () => {
    const decoded = Schema.decodeUnknownExit(Skill)({
      ...newSkill(),
      attachments: [1],
    });
    expect(decoded._tag).toBe("Failure");
  });
});

describe("SkillService", () => {
  it("lists the seeded stage skills in name order", async () => {
    const skills = await withService((s) => s.list);
    const names = skills.map((skill) => skill.name);
    expect(names).toEqual([...names].sort());
    for (const seeded of ["implement", "review", "specify"]) {
      expect(names).toContain(seeded);
    }
    const specify = skills.find((skill) => skill.name === "specify");
    expect(specify?.description.length).toBeGreaterThan(0);
    expect(specify?.body.length).toBeGreaterThan(0);
    expect(Array.isArray(specify?.attachments)).toBe(true);
  });

  it("reads one seeded skill by name", async () => {
    const skill = await withService((s) => s.get("review"));
    expect(skill.name).toBe("review");
    expect(skill.version.length).toBeGreaterThan(0);
    expect(skill.body).toContain("Review");
  });

  it("refuses a name the table does not hold, and names it", async () => {
    const missing = `test-missing-${hex(6)}`;
    const error = await refusal((s) => s.get(missing));
    expect(error._tag).toBe("SkillNotFound");
    if (error._tag !== "SkillNotFound") throw new Error("unreachable");
    expect(error.name).toBe(missing);
    expect(error.message).toContain(missing);
  });

  it("writes a new skill and reads every field back unchanged", async () => {
    const skill = newSkill();
    try {
      await withService((s) => s.upsert(skill));
      expect(await withService((s) => s.get(skill.name))).toEqual(skill);
      expect(await rowCount(skill.name)).toBe(1);
      const listed = await withService((s) => s.list);
      expect(listed.map((it) => it.name)).toContain(skill.name);
    } finally {
      await removeSkill(skill.name);
    }
  });

  it("refuses a row whose attachments are not a string array, and names it", async () => {
    const name = `test-corrupt-${hex(6)}`;
    try {
      await runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          yield* sql`
            INSERT INTO skills (name, version, description, body, attachments)
            VALUES (${name}, '1', '', '', '{"nope": true}'::jsonb)
          `;
        }),
      );
      const error = await refusal((s) => s.get(name));
      expect(error._tag).toBe("SkillStorageError");
      if (error._tag !== "SkillStorageError") throw new Error("unreachable");
      expect(error.message).toContain(name);
    } finally {
      await removeSkill(name);
    }
  });

  it("replaces the document of an existing name instead of adding a second row", async () => {
    const skill = newSkill();
    const replaced: Skill = {
      ...skill,
      version: "2",
      description: "a rewritten description",
      body: "# Rewritten\n",
      attachments: [],
    };
    try {
      await withService((s) => s.upsert(skill));
      await withService((s) => s.upsert(replaced));
      expect(await withService((s) => s.get(skill.name))).toEqual(replaced);
      expect(await rowCount(skill.name)).toBe(1);
    } finally {
      await removeSkill(skill.name);
    }
  });
});
