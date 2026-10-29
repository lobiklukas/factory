/**
 * The one line a run's repo instructions come to (F19), shared by `factory show` and the session
 * pane: the counts, and the things an operator must not have to infer — a truncated file, skills the
 * budget dropped or the column's own shadowed, nested instruction files, and the absence of any.
 */
import { describe, expect, it } from "vitest";
import { repoContextText, type RepoPromptRecord } from "./RepoContext";

const skills = (
  over: Partial<RepoPromptRecord["skills"]> = {},
): RepoPromptRecord["skills"] => ({
  tokens: 0,
  cap: 1536,
  listed: [],
  nested: [],
  dropped: [],
  shadowed: [],
  ...over,
});

const record = (over: Partial<RepoPromptRecord> = {}): RepoPromptRecord => ({
  ref: "main",
  commit: "0123456789abcdef",
  instructions: null,
  skills: skills(),
  ...over,
});

const listed = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    name: `s${index}`,
    path: `.pi/skills/s${index}/SKILL.md`,
  }));

describe("repoContextText", () => {
  it("says no repo instructions for no record, and for a record of nothing", () => {
    expect(repoContextText(undefined)).toBe("no repo instructions");
    expect(repoContextText(record())).toBe("no repo instructions");
  });

  it("counts the file and the skills", () => {
    expect(
      repoContextText(
        record({
          instructions: {
            path: "AGENTS.md",
            bytes: 5823,
            tokens: 1522,
            cap: 4096,
            truncated: false,
          },
          skills: skills({ listed: listed(8) }),
        }),
      ),
    ).toBe("told AGENTS.md (5823 bytes, 1522 tokens) and 8 repo skills");
  });

  it("names the file that was read, and speaks of one skill and one byte in the singular", () => {
    expect(
      repoContextText(
        record({
          instructions: {
            path: "CLAUDE.md",
            bytes: 1,
            tokens: 1,
            cap: 4096,
            truncated: false,
          },
          skills: skills({ listed: listed(1) }),
        }),
      ),
    ).toBe("told CLAUDE.md (1 byte, 1 token) and 1 repo skill");
  });

  it("calls out a truncated file", () => {
    const text = repoContextText(
      record({
        instructions: {
          path: "AGENTS.md",
          bytes: 90_000,
          tokens: 4090,
          cap: 4096,
          truncated: true,
        },
      }),
    );

    expect(text).toContain("truncated");
    expect(text).toContain("cap 4096 tokens");
  });

  it("calls out dropped and shadowed skills, and nested files", () => {
    expect(
      repoContextText(
        record({
          skills: skills({
            listed: listed(2),
            dropped: ["a"],
            shadowed: ["b", "c"],
            nested: ["x/AGENTS.md"],
          }),
        }),
      ),
    ).toBe(
      "told 2 repo skills (1 dropped for the budget, 2 shadowed by the column's own skills) and 1 nested AGENTS.md listed",
    );
  });
});
