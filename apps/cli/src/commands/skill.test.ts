/**
 * `factory skill`'s rendering and its reading of a `SKILL.md` (D7).
 *
 * The commands themselves are proven by `.pi/skills/verify-cli/skill.sh`, which runs them in a
 * terminal against a real control plane. These cases are the ones a pane capture would not localize:
 * which frontmatter a put reads, what an edit inherits from the version it supersedes, and which
 * field of a row the columns land in.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseSkillDocument,
  type SkillRecord,
  type SkillSummary,
} from "@repo/domain/Skill";
import { describe, expect, it } from "vitest";
import {
  NONE,
  putInputFor,
  SKILL_LS_HEADER,
  skillLsLines,
  skillPutLines,
  skillRow,
  skillShowLines,
} from "./skill";

const record = (extra: Partial<SkillRecord> = {}): SkillRecord => ({
  name: "specify",
  version: 2,
  newest: 2,
  description: "Turn a task into a checkable specification.",
  body: "# Specify\n\nClarify the goal.\n",
  attachments: [],
  createdAt: "2026-10-28T10:00:00.000Z",
  author: "",
  ...extra,
});

const summary = (extra: Partial<SkillSummary> = {}): SkillSummary => ({
  name: "specify",
  version: 3,
  description: "Turn a task into a checkable specification.",
  createdAt: "2026-10-28T10:00:00.000Z",
  columns: ["specifying"],
  ...extra,
});

const field = (row: string, name: string): string | undefined =>
  row.split("\t")[SKILL_LS_HEADER.split("\t").indexOf(name)];

describe("parseSkillDocument", () => {
  it("reads the name, a plain description and the body after the frontmatter", () => {
    expect(
      parseSkillDocument(
        "---\nname: specify\ndescription: Ask first.\nlicense: MIT\n---\n\n# Specify\n\nAsk.\n",
      ),
    ).toEqual({
      name: "specify",
      description: "Ask first.",
      body: "# Specify\n\nAsk.\n",
    });
  });

  it("reads quoted values and block scalars, kept or folded", () => {
    expect(
      parseSkillDocument(
        '---\nname: "plan-freshness"\ndescription: |\n  Line one.\n  Line two.\n---\nBody\n',
      ),
    ).toEqual({
      name: "plan-freshness",
      description: "Line one.\nLine two.",
      body: "Body\n",
    });
    expect(
      parseSkillDocument(
        "---\nname: 'x'\ndescription: >-\n  Folded\n  together.\nnext: y\n---\nBody",
      ).description,
    ).toBe("Folded together.");
  });

  it("is all body without frontmatter, or with one that never closes", () => {
    expect(parseSkillDocument("# Just a body\n")).toEqual({
      body: "# Just a body\n",
    });
    expect(parseSkillDocument("---\nname: x\n# no close\n")).toEqual({
      body: "---\nname: x\n# no close\n",
    });
  });

  it("reads a SKILL.md this repo ships, name and multi-line description included", () => {
    const text = readFileSync(
      join(__dirname, "../../../../.pi/skills/effect/SKILL.md"),
      "utf8",
    );
    const document = parseSkillDocument(text);
    expect(document.name).toBe("effect");
    expect(document.description).toContain(
      "Opinionated guide for building production TypeScript applications",
    );
    expect(document.body.startsWith("# Effect")).toBe(true);
  });
});

describe("putInputFor", () => {
  it("takes --name over the frontmatter, and the file's description over the old one", () => {
    expect(
      putInputFor(
        { name: "other", description: "new words", body: "# B\n" },
        "specify",
        record({ attachments: ["docs/board.md"] }),
      ),
    ).toEqual({
      input: {
        name: "specify",
        description: "new words",
        body: "# B\n",
        attachments: ["docs/board.md"],
      },
    });
  });

  it("keeps the superseded version's description when the file declares none", () => {
    const decided = putInputFor({ body: "# B\n" }, "specify", record());
    expect("input" in decided && decided.input.description).toBe(
      record().description,
    );
    // A new skill with no description is put with an empty one, not refused.
    const fresh = putInputFor(
      { name: "brand-new", body: "# B\n" },
      undefined,
      undefined,
    );
    expect(fresh).toEqual({
      input: {
        name: "brand-new",
        description: "",
        body: "# B\n",
        attachments: [],
      },
    });
  });

  it("refuses a document with no name, or a name that is not a skill name, before sending", () => {
    expect(putInputFor({ body: "# B\n" }, undefined, undefined)).toMatchObject({
      refused: expect.stringContaining("--name"),
    });
    expect(
      putInputFor({ name: "Specify", body: "# B\n" }, undefined, undefined),
    ).toMatchObject({ refused: expect.stringContaining('"Specify"') });
  });
});

describe("rendering", () => {
  it("lists a skill's name, newest version, columns and description in their columns", () => {
    const row = skillRow(summary({ columns: ["specifying", "rework"] }));
    expect(field(row, "name")).toBe("specify");
    expect(field(row, "version")).toBe("3");
    expect(field(row, "columns")).toBe("specifying,rework");
    expect(field(row, "updated-at")).toBe("2026-10-28T10:00:00.000Z");
    expect(field(row, "description")).toBe(
      "Turn a task into a checkable specification.",
    );
  });

  it("says none for a skill no column binds, and for an empty list", () => {
    expect(field(skillRow(summary({ columns: [] })), "columns")).toBe(NONE);
    expect(skillLsLines([])).toEqual(["no skills"]);
    expect(skillLsLines([summary()])[0]).toBe(SKILL_LS_HEADER);
  });

  it("shows whether a version is the newest, then the body", () => {
    expect(skillShowLines(record())[1]).toBe("version      2 (newest)");
    const old = skillShowLines(record({ version: 1, newest: 3 }));
    expect(old[1]).toBe("version      1 (newest is 3)");
    expect(old.at(-1)).toBe("# Specify\n\nClarify the goal.");
  });

  it("says a put reaches the next run and not one already open", () => {
    const lines = skillPutLines(record({ version: 3, newest: 3 }), record());
    expect(lines[0]).toBe("put          specify@3");
    expect(lines[1]).toBe("previous     specify@2");
    expect(lines.at(-1)).toBe(
      "note         runs already open keep the version they opened with; the next run is told specify@3",
    );
    expect(skillPutLines(record({ version: 1, newest: 1 }), undefined)[1]).toBe(
      `previous     ${NONE} (a new skill)`,
    );
  });
});
