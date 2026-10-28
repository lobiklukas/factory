/**
 * The run's prompt is resolved from its column (docs/board.md B6, LOB-174).
 *
 * These are the loader's own rules, without a database or a model: which skills a column resolves
 * to, in what order, and what happens when a column names a skill the factory does not hold. That
 * the resolved text actually reaches a run's system prompt is asserted where it can be observed —
 * the committed `pi.system` entries — in `session.test.ts` and in `packages/core`'s session suite,
 * which drives the same path through a board card.
 */
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  loadRun,
  SKILLS_EXTENSION,
  skillSectionKey,
  skillsExtension,
  type RunColumn,
  type RunProfile,
  type RunSkill,
  type SkillPin,
} from "./loader";
import { mergeSkillPins } from "./session";

const library: readonly RunSkill[] = [
  {
    name: "specify",
    version: 1,
    body: "# Specify\n\nClarify the goal first.\n",
  },
  {
    name: "implement",
    version: 1,
    body: "# Implement\n\nChange as little as possible.\n",
  },
  {
    name: "review",
    version: 1,
    body: "# Review\n\nReport evidenced findings.\n",
  },
];

type Loaded =
  | { readonly ok: true; readonly profile: RunProfile }
  | { readonly ok: false; readonly message: string; readonly column: string };

/** Resolve a column, keeping the refusal rather than throwing it. */
const run = (
  column: RunColumn | undefined,
  skills: readonly RunSkill[] = library,
  pinned: readonly SkillPin[] = [],
): Loaded =>
  Effect.runSync(
    loadRun(column, skills, pinned).pipe(
      Effect.match({
        onFailure: (error) => ({
          ok: false as const,
          message: error.message,
          column: error.column,
        }),
        onSuccess: (profile) => ({ ok: true as const, profile }),
      }),
    ),
  );

describe("loadRun", () => {
  it("resolves a column's skills in the order the column names them", () => {
    const loaded = run({ name: "review", skills: ["review", "specify"] });

    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.profile.column).toBe("review");
    expect(loaded.profile.skills.map((skill) => skill.name)).toEqual([
      "review",
      "specify",
    ]);
    expect(loaded.profile.skills[0]?.body).toContain(
      "Report evidenced findings.",
    );
  });

  it("injects nothing for a session with no card, or a column that names no skills", () => {
    expect(run(undefined)).toEqual({ ok: true, profile: { skills: [] } });
    expect(run({ name: "intake", skills: [] })).toEqual({
      ok: true,
      profile: { column: "intake", skills: [] },
    });
  });

  it("carries the column's role, which is what selects a read-only stage (LOB-74)", () => {
    expect(
      run({ name: "specifying", role: "specifier", skills: ["specify"] }),
    ).toMatchObject({
      ok: true,
      profile: { column: "specifying", role: "specifier" },
    });
    // No role declared, none invented.
    expect(run({ name: "intake", skills: [] })).toEqual({
      ok: true,
      profile: { column: "intake", skills: [] },
    });
  });

  it("carries the autonomy a column with skills declares, and invents none (C22)", () => {
    const autonomy = {
      approvalRequired: ["npm publish"],
      write: "docs",
      push: "none",
    } as const;
    expect(
      run({ name: "careful", skills: ["implement"], autonomy }),
    ).toMatchObject({
      ok: true,
      profile: {
        column: "careful",
        skills: [{ name: "implement" }],
        autonomy,
      },
    });
    const plain = run({ name: "building", skills: ["implement"] });
    expect(plain.ok).toBe(true);
    if (!plain.ok) return;
    expect("autonomy" in plain.profile).toBe(false);
  });

  it("refuses a column that names a skill the factory does not hold, naming both", () => {
    const loaded = run({ name: "specifying", skills: ["specify", "explain"] });

    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.column).toBe("specifying");
    expect(loaded.message).toBe(
      'column "specifying" names skill "explain", which the factory does not hold',
    );
  });
});

/**
 * Which version of a skill a run is told (D7, docs/board.md B2): the newest for a run whose log pins
 * nothing, and the pinned one for a run reopened after a newer version was put.
 */
describe("loadRun's versions", () => {
  const v1: RunSkill = { name: "specify", version: 1, body: "# Specify v1\n" };
  const v2: RunSkill = { name: "specify", version: 2, body: "# Specify v2\n" };
  const v3: RunSkill = { name: "specify", version: 3, body: "# Specify v3\n" };
  const specifying: RunColumn = { name: "specifying", skills: ["specify"] };

  const told = (loaded: Loaded): readonly number[] =>
    loaded.ok ? loaded.profile.skills.map((skill) => skill.version) : [];

  it("tells a run with no pin the newest version, whatever order the library is in", () => {
    expect(told(run(specifying, [v2, v3, v1]))).toEqual([3]);
    expect(told(run(specifying, [v3, v1, v2]))).toEqual([3]);
  });

  it("tells a pinned run its pinned version, even when a newer one exists", () => {
    const loaded = run(
      specifying,
      [v1, v2, v3],
      [{ name: "specify", version: 2 }],
    );
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.profile.skills).toEqual([v2]);
  });

  it("ignores a pin for a skill the column does not name, and pins nothing it was not given", () => {
    const loaded = run(
      { name: "specifying", skills: ["specify", "review"] },
      [...library, v2],
      [{ name: "implement", version: 7 }],
    );
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(
      loaded.profile.skills.map((skill) => `${skill.name}@${skill.version}`),
    ).toEqual(["specify@2", "review@1"]);
  });

  it("refuses a pinned version the factory does not hold, naming it, rather than move to another", () => {
    const loaded = run(specifying, [v1, v2], [{ name: "specify", version: 3 }]);
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.message).toBe(
      'column "specifying" runs pinned to skill specify@3, which the factory does not hold',
    );
  });
});

describe("mergeSkillPins", () => {
  const v1: RunSkill = { name: "specify", version: 1, body: "" };
  const review: RunSkill = { name: "review", version: 4, body: "" };

  it("pins what a first open was given, in the column's order", () => {
    expect(mergeSkillPins([], [v1, review])).toEqual([
      { name: "specify", version: 1 },
      { name: "review", version: 4 },
    ]);
  });

  it("writes nothing when every skill given is already pinned, or none was given", () => {
    expect(mergeSkillPins([{ name: "specify", version: 1 }], [v1])).toBe(
      undefined,
    );
    expect(mergeSkillPins([], [])).toBe(undefined);
  });

  it("never replaces a pin, and adds only the skills it lacked", () => {
    expect(
      mergeSkillPins(
        [{ name: "specify", version: 1 }],
        [{ ...v1, version: 2 }, review, review],
      ),
    ).toEqual([
      { name: "specify", version: 1 },
      { name: "review", version: 4 },
    ]);
  });
});

describe("skillsExtension", () => {
  it("is one section per skill, addressed by name", () => {
    const extension = skillsExtension(library);

    expect(extension.name).toBe(SKILLS_EXTENSION);
    expect(extension.sections?.map((section) => section.key)).toEqual([
      "skill_specify",
      "skill_implement",
      "skill_review",
    ]);
    expect(skillSectionKey("specify")).toBe("skill_specify");
  });

  it("orders the sections the profile gave it, not the library's order", () => {
    const review: RunSkill = { name: "review", version: 1, body: "# Review\n" };
    const specify: RunSkill = {
      name: "specify",
      version: 1,
      body: "# Specify\n",
    };

    const extension = skillsExtension([review, specify]);

    expect(extension.sections?.map((section) => section.key)).toEqual([
      "skill_review",
      "skill_specify",
    ]);
  });
});
