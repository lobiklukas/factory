/**
 * What the repository tells a run reaches its prompt and its log (S-repo-instructions-and-skills).
 *
 * The control plane reads `AGENTS.md` and the skills at the session's base and hands them to
 * `openSession`; this suite proves the hand-off becomes the committed `pi.system` sections — what the
 * model is sent — and the `factory.repo.prompt` record, that the column's skills keep their place
 * and win an overlap, and that a session given no repository context is told nothing new.
 *
 * Postgres only, not mocked: `docker compose up -d --wait postgres`.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { estimateTextTokens } from "@earendil-works/pi-ai/utils/estimate";
import { DatabaseLive, PostgresStorage } from "@repo/storage-postgres";
import { Clock, Effect, ManagedRuntime, Random } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createModelAccess } from "./models";
import type { RunProfile } from "./loader";
import {
  REPO_INSTRUCTIONS_TOKEN_CAP,
  REPO_SKILLS_TOKEN_CAP,
  type RepoContext,
} from "./repoContext";
import {
  closeHarness,
  openSession,
  readPromptSections,
  readRepoPrompt,
  submitMessage,
} from "./session";

const runtime = ManagedRuntime.make(DatabaseLive);
const context = BACKGROUND_CONTEXT;
const model = createModelAccess("faux");
const workdir = mkdtempSync(join(tmpdir(), "factory-harness-repo-"));

let sql: SqlClient;

beforeAll(async () => {
  try {
    sql = await runtime.runPromise(SqlClient);
  } catch (cause) {
    throw new Error(
      "Postgres is unreachable. Start it with `docker compose up -d --wait postgres`. " +
        String(cause),
      { cause },
    );
  }
}, 60_000);

afterAll(async () => {
  await runtime.dispose();
});

const freshLogId = () =>
  `harness-repo-${Effect.runSync(Random.nextIntBetween(0, 2 ** 31))}-${Effect.runSync(Clock.currentTimeMillis)}`;

const AGENTS = "# Rules\n\n- Postgres is on 5442.\n- Gate every change.\n";

const REPO: RepoContext = {
  ref: "main",
  commit: "fedcba9876543210fedcba9876543210fedcba98",
  instructions: { path: "AGENTS.md", bytes: AGENTS.length, text: AGENTS },
  skills: [
    {
      name: "verify-api",
      description: "Drive the API over HTTP.",
      path: ".pi/skills/verify-api/SKILL.md",
    },
    {
      name: "specify",
      description: "The repo's own idea of a spec.",
      path: ".agents/skills/specify/SKILL.md",
    },
  ],
};

const SPECIFY_BODY = "Write the spec: goal, acceptance, gaps.";

/** Open with `options`, send one message, and read back the prompt and the record. */
const openAndSend = (
  logId: string,
  options: { readonly repo?: RepoContext; readonly run?: RunProfile },
) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const storage = yield* Effect.promise(() =>
        PostgresStorage.owner(sql, logId),
      );
      const { harness, root } = yield* openSession({
        storage,
        model,
        cwd: workdir,
        ...options,
      });
      const submitted = yield* submitMessage(root, { content: "begin" });
      yield* Effect.promise(() => submitted.submission.wait(context));
      const sections = yield* readPromptSections(storage);
      const record = yield* readRepoPrompt(storage);
      yield* closeHarness(harness);
      yield* Effect.promise(() => storage.dispose());
      return { sections, record };
    }),
  );

describe("what the repository tells a run", () => {
  it("commits AGENTS.md and the skill index as sections, and records their size", async () => {
    const { sections, record } = await openAndSend(freshLogId(), {
      repo: REPO,
      run: {
        column: "specifying",
        skills: [{ name: "specify", version: 1, body: SPECIFY_BODY }],
      },
    });

    // The exact text the model was sent, read from the log.
    const instructions = sections["repo_instructions"];
    expect(instructions).toBe(
      [
        "<repo_instructions>",
        "The repository's AGENTS.md, as committed at main (fedcba987654). These are the repository's standing instructions to anyone working in it: follow them as you would the task's own, unless the task says otherwise.",
        "",
        AGENTS,
        "</repo_instructions>",
      ].join("\n"),
    );
    expect(sections["repo_skills"]).toBe(
      [
        "<repo_skills>",
        "Skills this repository ships, by name, with what each is for and where it is. Their bodies are not loaded: when a skill's description matches the task, read its SKILL.md (the path is from the worktree root) before acting on it. A factory skill in this prompt is the one to follow where the two disagree.",
        "",
        "- verify-api (.pi/skills/verify-api/SKILL.md): Drive the API over HTTP.",
        "</repo_skills>",
      ].join("\n"),
    );
    // The repository's word first, the column's skill after it, the index it defers to last.
    // Mutation: install the index before the column's skills — the order changes.
    expect(Object.keys(sections)).toEqual([
      "repo_instructions",
      "skill_specify",
      "repo_skills",
    ]);
    // What the log records is what the sections cost, measured on the text the log holds.
    expect(record).toEqual({
      ref: "main",
      commit: REPO.commit,
      instructions: {
        path: "AGENTS.md",
        bytes: AGENTS.length,
        tokens: estimateTextTokens(instructions ?? ""),
        cap: REPO_INSTRUCTIONS_TOKEN_CAP,
        truncated: false,
      },
      skills: {
        tokens: estimateTextTokens(sections["repo_skills"] ?? ""),
        cap: REPO_SKILLS_TOKEN_CAP,
        listed: [
          { name: "verify-api", path: ".pi/skills/verify-api/SKILL.md" },
        ],
        dropped: [],
        // The column binds `specify`, so the repo's skill of that name is left to it.
        shadowed: [".agents/skills/specify/SKILL.md"],
      },
    });
  }, 120_000);

  it("records a repository with no AGENTS.md and no skills, and adds no section", async () => {
    const { sections, record } = await openAndSend(freshLogId(), {
      repo: { ref: "main", commit: REPO.commit, skills: [] },
    });

    expect(sections).toEqual({});
    expect(record).toEqual({
      ref: "main",
      commit: REPO.commit,
      instructions: null,
      skills: {
        tokens: 0,
        cap: REPO_SKILLS_TOKEN_CAP,
        listed: [],
        dropped: [],
        shadowed: [],
      },
    });
  }, 120_000);

  it("writes no record for a session given no repository", async () => {
    const { sections, record } = await openAndSend(freshLogId(), {});

    expect(sections).toEqual({});
    expect(record).toBeUndefined();
  }, 120_000);

  it("tells a reopened run what the base says now, and records that", async () => {
    const logId = freshLogId();
    await openAndSend(logId, { repo: REPO });
    const moved = "# Rules\n\n- Postgres moved to 5443.\n";
    const { sections, record } = await openAndSend(logId, {
      repo: {
        ...REPO,
        commit: "1111111111111111111111111111111111111111",
        instructions: { path: "AGENTS.md", bytes: moved.length, text: moved },
        skills: [],
      },
    });

    expect(sections["repo_instructions"]).toContain("Postgres moved to 5443.");
    expect(sections["repo_instructions"]).not.toContain("5442");
    // A skill index the base no longer has is removed from the prompt, not left standing.
    expect(sections["repo_skills"]).toBeUndefined();
    expect(record?.commit).toBe("1111111111111111111111111111111111111111");
    expect(record?.instructions?.bytes).toBe(moved.length);
    expect(record?.skills.listed).toEqual([]);
  }, 120_000);

  it("clears the record when a reopen reads no repository context", async () => {
    const logId = freshLogId();
    const first = await openAndSend(logId, { repo: REPO });
    expect(first.record?.commit).toBe(REPO.commit);

    // A released workspace, a base that no longer resolves, a git read that timed out: the
    // control plane hands the open nothing, so the sections go and the record must say so.
    // Mutation: leave the document alone when `repo` is absent — the first open's record stands.
    const { sections, record } = await openAndSend(logId, {});

    expect(sections["repo_instructions"]).toBeUndefined();
    expect(sections["repo_skills"]).toBeUndefined();
    expect(record).toBeUndefined();
  }, 120_000);
});
