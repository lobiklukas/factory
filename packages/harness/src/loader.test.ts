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
} from "./loader";

const library: readonly RunSkill[] = [
  { name: "specify", body: "# Specify\n\nClarify the goal first.\n" },
  { name: "implement", body: "# Implement\n\nChange as little as possible.\n" },
  { name: "review", body: "# Review\n\nReport evidenced findings.\n" },
];

type Loaded =
  | { readonly ok: true; readonly profile: RunProfile }
  | { readonly ok: false; readonly message: string; readonly column: string };

/** Resolve a column, keeping the refusal rather than throwing it. */
const run = (
  column: RunColumn | undefined,
  skills: readonly RunSkill[] = library,
): Loaded =>
  Effect.runSync(
    loadRun(column, skills).pipe(
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
    const review: RunSkill = { name: "review", body: "# Review\n" };
    const specify: RunSkill = { name: "specify", body: "# Specify\n" };

    const extension = skillsExtension([review, specify]);

    expect(extension.sections?.map((section) => section.key)).toEqual([
      "skill_review",
      "skill_specify",
    ]);
  });
});
