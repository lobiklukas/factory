/**
 * What the repository tells a run (S-repo-instructions-and-skills), as pure assembly: the
 * `repo_instructions` section from `AGENTS.md` and the `repo_skills` index, each under its cap and
 * measured with the estimator compaction uses. That the sections reach the committed prompt and the
 * record reaches the log is `repoContext.session.test.ts`; that the control plane reads the files at
 * the base is `@repo/core`'s `repoContext.test.ts`.
 */
import { estimateTextTokens } from "@earendil-works/pi-ai/utils/estimate";
import { describe, expect, it } from "vitest";
import {
  assembleRepoPrompt,
  REPO_INSTRUCTIONS_TOKEN_CAP,
  REPO_SKILL_DESCRIPTION_CHARS,
  REPO_SKILLS_TOKEN_CAP,
  repoPromptRecord,
  type RepoContext,
  type RepoSkill,
} from "./repoContext";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";

const context = (overrides: Partial<RepoContext> = {}): RepoContext => ({
  ref: "main",
  commit: COMMIT,
  skills: [],
  ...overrides,
});

const skill = (
  name: string,
  description = `what ${name} is for`,
): RepoSkill => ({
  name,
  description,
  path: `.pi/skills/${name}/SKILL.md`,
});

const PREAMBLE =
  "The repository's AGENTS.md, as committed at main (0123456789ab). These are the repository's " +
  "standing instructions to anyone working in it: follow them as you would the task's own, unless " +
  "the task says otherwise.";

const tagged = (key: string, inner: string) => `<${key}>\n${inner}\n</${key}>`;

describe("the repo_instructions section", () => {
  it("carries AGENTS.md verbatim under its preamble, and measures what it renders", () => {
    const text = "# Rules\n\n- Gate every change with `bun run test`.\n";
    const prompt = assembleRepoPrompt(
      context({ instructions: { path: "AGENTS.md", bytes: 48, text } }),
    );

    expect(prompt.instructions).toEqual({
      path: "AGENTS.md",
      bytes: 48,
      text: `${PREAMBLE}\n\n${text}`,
      tokens: estimateTextTokens(
        tagged("repo_instructions", `${PREAMBLE}\n\n${text}`),
      ),
      truncated: false,
      cap: REPO_INSTRUCTIONS_TOKEN_CAP,
    });
  });

  it("cuts a file over the cap at a line boundary, inside the cap, and says where the rest is", () => {
    const lines = Array.from(
      { length: 400 },
      (_, index) => `rule ${index}: ${"keep the gate green ".repeat(4)}`,
    );
    const text = lines.join("\n");
    const prompt = assembleRepoPrompt(
      context({
        instructions: { path: "AGENTS.md", bytes: text.length, text },
      }),
      [],
      { instructions: 600, skills: REPO_SKILLS_TOKEN_CAP },
    );
    const section = prompt.instructions;

    expect(section?.truncated).toBe(true);
    expect(section?.tokens).toBeLessThanOrEqual(600);
    // Mutation: cut mid-line — the kept body is no longer a prefix of whole lines.
    const body = (section?.text ?? "")
      .slice(`${PREAMBLE}\n\n`.length)
      .split("\n\n[AGENTS.md continues")[0];
    const kept = body?.split("\n") ?? [];
    expect(kept.length).toBeGreaterThan(0);
    expect(kept).toEqual(lines.slice(0, kept.length));
    expect(section?.text).toContain(
      `[AGENTS.md continues: this section carries its first ${kept.length} of 400 lines. Read AGENTS.md for the rest before relying on what is missing here.]`,
    );
    // The longest cut that fits: one more line would not.
    const oneMore = `${PREAMBLE}\n\n${lines.slice(0, kept.length + 1).join("\n")}\n\n[AGENTS.md continues: this section carries its first ${kept.length + 1} of 400 lines. Read AGENTS.md for the rest before relying on what is missing here.]`;
    expect(
      estimateTextTokens(tagged("repo_instructions", oneMore)),
    ).toBeGreaterThan(600);
  });

  it("names a file too large to read, by path and size, rather than carrying any of it", () => {
    const prompt = assembleRepoPrompt(
      context({ instructions: { path: "docs/AGENTS.md", bytes: 900_000 } }),
    );

    expect(prompt.instructions?.truncated).toBe(true);
    expect(prompt.instructions?.text).toContain(
      "[docs/AGENTS.md is 900000 bytes, more than a prompt carries: read it from the worktree before you start.]",
    );
  });

  it("renders no section for a repository with no AGENTS.md, or an empty one", () => {
    expect(assembleRepoPrompt(context()).instructions).toBeUndefined();
    expect(
      assembleRepoPrompt(
        context({
          instructions: { path: "AGENTS.md", bytes: 3, text: " \n\n" },
        }),
      ).instructions,
    ).toBeUndefined();
  });
});

describe("the repo_skills index", () => {
  it("lists each skill by name, path and one-line description, not its body", () => {
    const prompt = assembleRepoPrompt(
      context({
        skills: [
          skill("verify-api", "Drive the API.\n  Use after changing apps/api."),
          {
            name: "bare",
            description: "",
            path: ".agents/skills/bare/SKILL.md",
          },
        ],
      }),
    );

    expect(prompt.skills.text).toBe(
      [
        "Skills this repository ships, by name, with what each is for and where it is. Their bodies are not loaded: when a skill's description matches the task, read its SKILL.md (the path is from the worktree root) before acting on it. A factory skill in this prompt is the one to follow where the two disagree.",
        "",
        "- verify-api (.pi/skills/verify-api/SKILL.md): Drive the API. Use after changing apps/api.",
        "- bare (.agents/skills/bare/SKILL.md)",
      ].join("\n"),
    );
    expect(prompt.skills.tokens).toBe(
      estimateTextTokens(tagged("repo_skills", prompt.skills.text ?? "")),
    );
    expect(prompt.skills.listed.map((listed) => listed.name)).toEqual([
      "verify-api",
      "bare",
    ]);
  });

  it("cuts a long description to one bounded line", () => {
    const prompt = assembleRepoPrompt(
      context({ skills: [skill("long", "word ".repeat(200))] }),
    );
    const line = (prompt.skills.text ?? "").split("\n").at(-1) ?? "";
    const description = line.slice(line.indexOf("): ") + 3);

    expect(description.length).toBe(REPO_SKILL_DESCRIPTION_CHARS);
    expect(description.endsWith("…")).toBe(true);
  });

  it("defers to the column's skill of the same name, and lists a repeated name once", () => {
    const prompt = assembleRepoPrompt(
      context({
        skills: [
          skill("Specify"),
          skill("effect"),
          { ...skill("effect"), path: ".agents/skills/effect/SKILL.md" },
        ],
      }),
      ["specify"],
    );

    // Mutation: compare names case-sensitively — the run is told two `specify` skills.
    expect(prompt.skills.listed.map((listed) => listed.path)).toEqual([
      ".pi/skills/effect/SKILL.md",
    ]);
    expect(prompt.skills.shadowed).toEqual([
      ".pi/skills/Specify/SKILL.md",
      ".agents/skills/effect/SKILL.md",
    ]);
    expect(prompt.skills.text).not.toContain("Specify");
  });

  it("keeps the index inside its cap as a prefix, and names what it dropped", () => {
    const many = Array.from({ length: 40 }, (_, index) =>
      skill(`skill-${String(index).padStart(2, "0")}`, "x".repeat(200)),
    );
    const prompt = assembleRepoPrompt(context({ skills: many }), [], {
      instructions: REPO_INSTRUCTIONS_TOKEN_CAP,
      skills: 400,
    });
    const listed = prompt.skills.listed.length;

    expect(listed).toBeGreaterThan(0);
    expect(listed).toBeLessThan(40);
    expect(prompt.skills.tokens).toBeLessThanOrEqual(400);
    expect(prompt.skills.listed).toEqual(many.slice(0, listed));
    expect(prompt.skills.dropped).toEqual(
      many.slice(listed).map((dropped) => dropped.path),
    );
  });

  it("renders no index when the repository ships no skills, or only shadowed ones", () => {
    expect(assembleRepoPrompt(context()).skills).toEqual({
      cap: REPO_SKILLS_TOKEN_CAP,
      tokens: 0,
      listed: [],
      dropped: [],
      shadowed: [],
    });
    const shadowedOnly = assembleRepoPrompt(
      context({ skills: [skill("docs")] }),
      ["docs"],
    );
    expect(shadowedOnly.skills.text).toBeUndefined();
    expect(shadowedOnly.skills.tokens).toBe(0);
  });
});

describe("the record of an open", () => {
  it("keeps sizes and names, and says null for no instructions", () => {
    const withFile = repoPromptRecord(
      assembleRepoPrompt(
        context({
          instructions: { path: "AGENTS.md", bytes: 5, text: "rule\n" },
          skills: [skill("a")],
        }),
      ),
    );
    expect(withFile).toEqual({
      ref: "main",
      commit: COMMIT,
      instructions: {
        path: "AGENTS.md",
        bytes: 5,
        tokens: estimateTextTokens(
          tagged("repo_instructions", `${PREAMBLE}\n\nrule\n`),
        ),
        cap: REPO_INSTRUCTIONS_TOKEN_CAP,
        truncated: false,
      },
      skills: {
        tokens: withFile.skills.tokens,
        cap: REPO_SKILLS_TOKEN_CAP,
        listed: [{ name: "a", path: ".pi/skills/a/SKILL.md" }],
        dropped: [],
        shadowed: [],
      },
    });
    expect(withFile.skills.tokens).toBeGreaterThan(0);
    expect(repoPromptRecord(assembleRepoPrompt(context())).instructions).toBe(
      null,
    );
  });
});
