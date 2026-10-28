/**
 * The skill service against the real `skills` table (LOB-173, part 2 of LOB-48).
 *
 * Postgres only, not mocked: `docker compose up -d --wait postgres`. The table is the one
 * `0009_create_skills.ts` creates and `0037_version_skills.ts` keys by `(name, version)`, seeded
 * with the three stage skills at version 1. Cases that write use their own randomly named skill and
 * delete every version of it afterwards, so the seeded rows are never disturbed.
 */
import { randomBytes } from "node:crypto";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { afterAll, describe, expect, it } from "vitest";
import { DatabaseLive } from "@repo/storage-postgres";
import { PutSkillInput, Skill, type SkillError } from "@repo/domain/Skill";
import {
  SkillService,
  SkillServiceLive,
  summarizeSkills,
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

/** A put of a skill under a name no other case uses. */
const newSkill = (name = `test-skill-${hex(6)}`): PutSkillInput => ({
  name,
  description: "a skill written by a test",
  body: "# Test\n\nA body with **markdown** and a trailing newline.\n",
  attachments: ["docs/board.md", ".pi/skills/effect/SKILL.md"],
});

/** Deletes every version of a skill a case wrote, leaving the seeded rows alone. */
const removeSkill = (name: string): Promise<void> =>
  runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      yield* sql`DELETE FROM skills WHERE name = ${name}`;
    }),
  );

/** Every stored row of one name, oldest first, as the table holds it. */
const rowsOf = (name: string) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      return yield* sql<{ version: number; body: string; author: string }>`
        SELECT version, body, author FROM skills WHERE name = ${name} ORDER BY version
      `;
    }),
  );

describe("Skill domain contract", () => {
  it("round-trips a skill document through the schema", () => {
    const skill: Skill = { ...newSkill(), version: 1, attachments: [] };
    const encoded = Schema.encodeSync(Schema.fromJsonString(Skill))(skill);
    expect(Schema.decodeSync(Schema.fromJsonString(Skill))(encoded)).toEqual(
      skill,
    );
  });

  it("refuses a document with a non-string attachment, or a version that is not a positive integer", () => {
    const skill = { ...newSkill(), version: 1 };
    expect(
      Schema.decodeUnknownExit(Skill)({ ...skill, attachments: [1] })._tag,
    ).toBe("Failure");
    for (const version of [0, 1.5, "1"]) {
      expect(Schema.decodeUnknownExit(Skill)({ ...skill, version })._tag).toBe(
        "Failure",
      );
    }
  });

  it("refuses to put a name that would fold into another's prompt section", () => {
    for (const name of ["Specify", "my skill", "", "-lead", "x".repeat(65)]) {
      expect(
        Schema.decodeExit(PutSkillInput)({ ...newSkill(), name })._tag,
      ).toBe("Failure");
    }
    expect(
      Schema.decodeExit(PutSkillInput)({
        ...newSkill(),
        name: "plan-freshness",
      })._tag,
    ).toBe("Success");
  });
});

describe("SkillService", () => {
  it("lists the seeded stage skills in name order, one row per name", async () => {
    const skills = await withService((s) => s.list);
    const names = skills.map((skill) => skill.name);
    expect(names).toEqual([...names].sort());
    expect(new Set(names).size).toBe(names.length);
    for (const seeded of ["implement", "review", "specify"]) {
      expect(names).toContain(seeded);
    }
    const specify = skills.find((skill) => skill.name === "specify");
    expect(specify?.description.length).toBeGreaterThan(0);
    expect(specify?.body.length).toBeGreaterThan(0);
    expect(Array.isArray(specify?.attachments)).toBe(true);
  });

  it("reads one seeded skill by name, and its first version by number", async () => {
    const skill = await withService((s) => s.get("review"));
    expect(skill.name).toBe("review");
    expect(skill.version).toBeGreaterThanOrEqual(1);
    expect(skill.version).toBe(skill.newest);
    expect(skill.body).toContain("Review");
    // 0037 kept the row 0009 seeded as version 1, whatever was put since.
    const first = await withService((s) => s.get("review", 1));
    expect(first.version).toBe(1);
    expect(first.body).toContain("Check the diff against the issue");
  });

  it("refuses a name the table does not hold, and a version it does not hold, naming both", async () => {
    const missing = `test-missing-${hex(6)}`;
    const error = await refusal((s) => s.get(missing));
    expect(error._tag).toBe("SkillNotFound");
    if (error._tag !== "SkillNotFound") throw new Error("unreachable");
    expect(error.name).toBe(missing);
    expect(error.message).toContain(missing);

    const noVersion = await refusal((s) => s.get("review", 9_999));
    expect(noVersion._tag).toBe("SkillNotFound");
    if (noVersion._tag !== "SkillNotFound") throw new Error("unreachable");
    expect(noVersion.version).toBe(9_999);
    expect(noVersion.message).toBe('skill "review" has no version 9999');
  });

  it("puts a new skill as version 1 and reads every field back unchanged", async () => {
    const skill = newSkill();
    try {
      const put = await withService((s) =>
        s.put({ ...skill, actor: "person:lukas" }),
      );
      expect(put).toMatchObject({
        ...skill,
        version: 1,
        newest: 1,
        author: "person:lukas",
      });
      expect(Number.isNaN(Date.parse(put.createdAt))).toBe(false);
      expect(await withService((s) => s.get(skill.name))).toEqual(put);
      const listed = await withService((s) => s.list);
      expect(listed.map((it) => it.name)).toContain(skill.name);
    } finally {
      await removeSkill(skill.name);
    }
  });

  /**
   * The acceptance's "put creates version N+1 and never overwrites". Mutation: an upsert on the
   * name — version 1 is rewritten, and the history has one row.
   */
  it("puts an edit as version N+1 and leaves every earlier version as it was", async () => {
    const skill = newSkill();
    try {
      const first = await withService((s) => s.put(skill));
      const second = await withService((s) =>
        s.put({ ...skill, body: "# Rewritten\n", attachments: [] }),
      );
      const third = await withService((s) =>
        s.put({ ...skill, body: "# Third\n" }),
      );
      expect([first.version, second.version, third.version]).toEqual([1, 2, 3]);
      expect((await rowsOf(skill.name)).map((row) => row.body)).toEqual([
        skill.body,
        "# Rewritten\n",
        "# Third\n",
      ]);
      // The newest is what a bare read answers; the first is still there to be read by number, and
      // says it is not the newest.
      expect((await withService((s) => s.get(skill.name))).body).toBe(
        "# Third\n",
      );
      const old = await withService((s) => s.get(skill.name, 1));
      expect(old).toMatchObject({ version: 1, newest: 3, body: skill.body });
      expect(old.attachments).toEqual(skill.attachments);
      // The list answers one row for the name, at its newest.
      const listed = (await withService((s) => s.list)).filter(
        (it) => it.name === skill.name,
      );
      expect(listed.map((it) => it.version)).toEqual([3]);
    } finally {
      await removeSkill(skill.name);
    }
  });

  /**
   * D8's history. Mutations: oldest first, the newest only (a `LIMIT 1` copied from `get`), another
   * name's versions mixed in, or an empty list for an unknown name instead of `SkillNotFound`.
   */
  it("lists every version of one skill, newest first, with who put each, and refuses an unknown name", async () => {
    const skill = newSkill();
    const other = newSkill();
    try {
      await withService((s) => s.put(skill));
      await withService((s) => s.put(other));
      await withService((s) =>
        s.put({ ...skill, description: "the second", actor: "person:ana" }),
      );
      const third = await withService((s) =>
        s.put({ ...skill, body: "# Third\n" }),
      );
      const history = await withService((s) => s.versions(skill.name));
      expect(
        history.map((entry) => [
          entry.version,
          entry.description,
          entry.author,
        ]),
      ).toEqual([
        [3, skill.description, ""],
        [2, "the second", "person:ana"],
        [1, skill.description, ""],
      ]);
      expect(history.every((entry) => entry.name === skill.name)).toBe(true);
      expect(history[0]?.createdAt).toBe(third.createdAt);
      // No body: the history is the small read, and a version's body is `get` with its number.
      expect(history[0]).not.toHaveProperty("body");

      const missing = `test-missing-${hex(6)}`;
      const error = await refusal((s) => s.versions(missing));
      expect(error).toMatchObject({ _tag: "SkillNotFound", name: missing });
    } finally {
      await removeSkill(skill.name);
      await removeSkill(other.name);
    }
  });

  it("gives concurrent puts of one name distinct versions, losing none", async () => {
    const skill = newSkill();
    try {
      const puts = await withService((s) =>
        Effect.all(
          Array.from({ length: 4 }, (_, i) =>
            s.put({ ...skill, body: `# Put ${i}\n` }),
          ),
          { concurrency: "unbounded" },
        ),
      );
      expect(puts.map((put) => put.version).sort((a, b) => a - b)).toEqual([
        1, 2, 3, 4,
      ]);
      expect(await rowsOf(skill.name)).toHaveLength(4);
    } finally {
      await removeSkill(skill.name);
    }
  });

  it("refuses a blank body, and writes nothing", async () => {
    const skill = newSkill();
    const error = await refusal((s) => s.put({ ...skill, body: "  \n\t" }));
    expect(error._tag).toBe("InvalidSkill");
    expect(error.message).toContain(skill.name);
    expect(await rowsOf(skill.name)).toEqual([]);
  });

  it("refuses a row whose attachments are not a string array, and names it", async () => {
    const name = `test-corrupt-${hex(6)}`;
    try {
      await runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient;
          yield* sql`
            INSERT INTO skills (name, version, description, body, attachments)
            VALUES (${name}, 1, '', '', '{"nope": true}'::jsonb)
          `;
        }),
      );
      const error = await refusal((s) => s.get(name));
      expect(error._tag).toBe("SkillStorageError");
      if (error._tag !== "SkillStorageError") throw new Error("unreachable");
      expect(error.message).toContain(`${name}@1`);
    } finally {
      await removeSkill(name);
    }
  });
});

describe("summarizeSkills", () => {
  const record = (name: string, version: number) => ({
    name,
    version,
    newest: version,
    description: `${name}'s rules`,
    body: "",
    attachments: [],
    createdAt: "2026-10-28T10:00:00.000Z",
    author: "",
  });

  it("names the columns that bind each skill, in column order, and none for an unbound one", () => {
    const summaries = summarizeSkills(
      [record("review", 2), record("specify", 3), record("docs", 1)],
      [
        { name: "intake", skills: [] },
        { name: "specifying", skills: ["specify"] },
        { name: "reviewing", skills: ["review"] },
        { name: "rework", skills: ["review", "specify"] },
      ],
    );
    expect(
      summaries.map((summary) => [
        summary.name,
        summary.version,
        summary.columns,
      ]),
    ).toEqual([
      ["review", 2, ["reviewing", "rework"]],
      ["specify", 3, ["specifying", "rework"]],
      ["docs", 1, []],
    ]);
  });
});
