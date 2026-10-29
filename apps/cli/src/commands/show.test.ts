/**
 * `factory show`'s lines (F19): the session's facts and the `context` line — what its run was told
 * about its repository — with the cases a pane capture would not localize: a scratch session, a repo
 * with nothing, a truncated file, skills dropped and shadowed, nested files. The command itself is
 * proven in a terminal by `.pi/skills/verify-cli/repo-context.sh`.
 */
import type { RepoPromptRecord } from "@repo/domain/RepoContext";
import {
  RepoSlug,
  SessionId,
  type SessionSnapshot,
} from "@repo/domain/Session";
import { describe, expect, it } from "vitest";
import { showLines } from "./show";

const SESSION = SessionId.make("ses_01m5yvfya2tsyn56ycr5jj3pvs");

const snapshot = (
  summary: Partial<SessionSnapshot["session"]> = {},
): SessionSnapshot => ({
  session: {
    id: SESSION,
    title: "a run",
    status: "idle",
    mode: "live",
    createdAt: "2026-10-28T00:00:00.000Z",
    ...summary,
  },
  workspace: { path: "/work/ses", commands: {}, commandsSource: "none" },
  entries: [],
  live: { busy: false, tools: [] },
  usage: { models: [], tools: [] },
  queued: [],
  tasks: [],
  approvals: [],
});

const record = (
  overrides: Partial<RepoPromptRecord> = {},
): RepoPromptRecord => ({
  ref: "main",
  commit: "0123456789abcdef0123456789abcdef01234567",
  instructions: {
    path: "AGENTS.md",
    bytes: 5823,
    tokens: 1522,
    cap: 4096,
    truncated: false,
  },
  skills: {
    tokens: 300,
    cap: 1536,
    listed: Array.from({ length: 8 }, (_, index) => ({
      name: `skill-${index}`,
      path: `.pi/skills/skill-${index}/SKILL.md`,
    })),
    nested: [],
    dropped: [],
    shadowed: [],
  },
  ...overrides,
});

describe("showLines", () => {
  it("says no repo instructions for a scratch session and prints its facts", () => {
    const lines = showLines(snapshot(), {});

    expect(lines).toEqual([
      `session ${SESSION}`,
      "title a run",
      "status idle",
      "repo -",
      "workspace /work/ses",
      "model unknown",
      "pr -",
      "context no repo instructions",
    ]);
  });

  it("says no repo instructions for a repo with neither file nor skills", () => {
    const bare = record({
      instructions: null,
      skills: {
        tokens: 0,
        cap: 1536,
        listed: [],
        nested: [],
        dropped: [],
        shadowed: [],
      },
    });

    expect(
      showLines(snapshot({ repo: RepoSlug.make("a/b") }), { repo: bare }),
    ).toContain("context no repo instructions");
  });

  it("counts the file and the skills a run was told", () => {
    const lines = showLines(snapshot(), { repo: record() });

    expect(lines).toContain(
      "context told AGENTS.md (5823 bytes, 1522 tokens) and 8 repo skills",
    );
    expect(lines).toContain("context-read main (0123456789ab)");
  });

  it("calls out a truncated file, and names dropped and shadowed skills", () => {
    const base = record();
    const lines = showLines(snapshot(), {
      repo: record({
        instructions: {
          path: "CLAUDE.md",
          bytes: 90_000,
          tokens: 4090,
          cap: 4096,
          truncated: true,
        },
        skills: {
          ...base.skills,
          listed: base.skills.listed.slice(0, 1),
          nested: ["packages/web/AGENTS.md"],
          dropped: [".pi/skills/z/SKILL.md"],
          shadowed: [".agents/skills/specify/SKILL.md"],
        },
      }),
    });

    expect(lines).toContain(
      "context told CLAUDE.md (90000 bytes, 4090 tokens, truncated: the prompt carries only part of it, cap 4096 tokens) and 1 repo skill (1 dropped for the budget, 1 shadowed by the column's own skills) and 1 nested AGENTS.md listed",
    );
    expect(lines).toContain("context-nested packages/web/AGENTS.md");
    expect(lines).toContain("context-dropped .pi/skills/z/SKILL.md");
    expect(lines).toContain("context-shadowed .agents/skills/specify/SKILL.md");
  });
});
