/**
 * The repository's `AGENTS.md` and its skills reach every run, through the real service
 * (S-repo-instructions-and-skills): a session on a repo is told its `AGENTS.md` as a section of its
 * recorded prompt and its skills as an index of names and paths, the log records what that cost, and
 * the run reads a listed skill from its worktree with its own tools — a skill the factory's skills
 * table never heard of. A repo with neither file is told nothing new. A later run is told what the
 * base says then, never what a run wrote on its own branch.
 *
 * The fixtures are local git repos with no remote; the model is pi-ai's faux provider, whose first
 * turn calls `bash` with a command that reads the skill and edits `AGENTS.md` in the worktree.
 *
 * Postgres only, not mocked: `docker compose up -d --wait postgres`.
 */
import { BunServices } from "@effect/platform-bun";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { RepoSlug, type SessionId } from "@repo/domain/Session";
import {
  createFauxModelAccess,
  readPromptSections,
  readRepoPrompt,
} from "@repo/harness";
import { DatabaseLive, PostgresStorage } from "@repo/storage-postgres";
import { Effect, Layer, ManagedRuntime } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { afterAll, describe, expect, it } from "vitest";
import { SessionService, SessionServiceLive } from "./SessionService";

/** A run of this file's, so two runs on one database never share a slug or a skill name. */
const RUN = randomBytes(4).toString("hex");
const scratch = mkdtempSync(join(tmpdir(), "factory-core-repo-context-"));

/** A skill name no migration seeds and no other run of this file uses. */
const SKILL_NAME = `fixture-skill-${RUN}`;
const SKILL_PATH = `.pi/skills/${SKILL_NAME}/SKILL.md`;
const SKILL_BODY = `The fixture skill's body, read on demand (${RUN}).`;

/** The faux run's first turn: read the listed skill, then rewrite the rules on its own branch. */
const PROBE = `cat ${SKILL_PATH} 2>/dev/null || echo "no-skill"; echo "RUN-WROTE-THIS" >> AGENTS.md`;

const faux = createFauxModelAccess({ fauxCommand: PROBE });

const runtime = ManagedRuntime.make(
  SessionServiceLive({
    model: faux.access,
    sessionRoot: join(scratch, "sessions"),
  }).pipe(Layer.provideMerge(Layer.mergeAll(DatabaseLive, BunServices.layer))),
);

afterAll(async () => {
  await runtime.dispose();
  rmSync(scratch, { recursive: true, force: true });
});

const waitUntil = <E, R>(
  check: Effect.Effect<boolean, E, R>,
  label: string,
): Effect.Effect<void, E, R> =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 600; attempt += 1) {
      if (yield* check) return;
      yield* Effect.sleep(50);
    }
    return yield* Effect.die(new Error(`timed out waiting for ${label}`));
  });

const git = (root: string, command: string) =>
  execSync(command, { cwd: root, stdio: "ignore" });

const write = (root: string, files: Record<string, string>) => {
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), content);
  }
};

/** A checkout with `files` committed on `main`, and no remote. */
const fixtureRepo = (name: string, files: Record<string, string>): string => {
  const root = join(scratch, "repos", name);
  mkdirSync(root, { recursive: true });
  git(root, "git init -q -b main");
  git(root, "git config user.email context@localhost");
  git(root, "git config user.name context");
  write(root, files);
  git(root, "git add -A");
  git(root, "git commit -q -m base");
  return root;
};

const AGENTS = `# Fixture rules (${RUN})\n\n- Postgres is on 5442.\n- Gate every change.\n`;

const register = (name: string, files: Record<string, string>) =>
  Effect.gen(function* () {
    const sessions = yield* SessionService;
    const repo = RepoSlug.make(`repo-context-${RUN}/${name}`);
    const localPath = fixtureRepo(name, files);
    yield* sessions.registerRepo({
      repo,
      url: `https://example.invalid/${name}.git`,
      defaultBaseRef: "main",
      localPath,
    });
    return { repo, localPath };
  });

/** Send, and wait for the run to answer. */
const run = (sessionId: SessionId, content: string) =>
  Effect.gen(function* () {
    const sessions = yield* SessionService;
    const before = (yield* sessions.get(sessionId)).entries.filter(
      (entry) => entry.kind === "assistant" && entry.text !== "",
    ).length;
    yield* sessions.send({ sessionId, content });
    yield* waitUntil(
      Effect.map(
        sessions.get(sessionId),
        (snapshot) =>
          !snapshot.live.busy &&
          snapshot.entries.filter(
            (entry) => entry.kind === "assistant" && entry.text !== "",
          ).length > before,
      ),
      "the run to answer",
    );
    return yield* sessions.get(sessionId);
  });

/** The prompt the log leaves in effect and the repo record, read without owning the log. */
const logged = (sessionId: SessionId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    return yield* Effect.acquireUseRelease(
      Effect.promise(() => PostgresStorage.reader(sql, sessionId)),
      (storage) =>
        Effect.all({
          sections: readPromptSections(storage),
          record: readRepoPrompt(storage),
        }),
      (storage) => Effect.promise(() => storage.dispose()),
    );
  });

describe("the repository's instructions and skills in every run", () => {
  it("tells the run AGENTS.md and the skill index, records their size, and the run reads the skill", async () => {
    const outcome = await runtime.runPromise(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const sql = yield* SqlClient;
        const { repo, localPath } = yield* register("told", {
          "AGENTS.md": AGENTS,
          [SKILL_PATH]: `---\nname: ${SKILL_NAME}\ndescription: Use when the fixture needs its skill.\n---\n\n${SKILL_BODY}\n`,
          ".agents/skills/other/SKILL.md": "No frontmatter.\n",
        });
        const created = yield* sessions.create({ repo, title: "told" });
        const first = yield* run(created.id, "read the skill");
        const firstLog = yield* logged(created.id);
        // The base moves on, the run's own branch has rewritten the rules; the next owner rereads.
        write(localPath, {
          "AGENTS.md": `${AGENTS}- A rule merged later (${RUN}).\n`,
        });
        git(localPath, "git commit -q -am later");
        yield* sessions.close;
        yield* run(created.id, "again");
        const secondLog = yield* logged(created.id);
        const known = yield* sql<{ count: number }>`
          SELECT count(*)::int AS count FROM skills WHERE name = ${SKILL_NAME}
        `;
        return {
          first,
          firstLog,
          secondLog,
          known: known[0]?.count,
          head: execSync("git rev-parse main", {
            cwd: localPath,
            encoding: "utf8",
          }).trim(),
        };
      }),
    );

    // The AGENTS.md section is in the recorded prompt, verbatim.
    const instructions = outcome.firstLog.sections["repo_instructions"] ?? "";
    expect(instructions.startsWith("<repo_instructions>\n")).toBe(true);
    expect(instructions).toContain(`\n\n${AGENTS}\n</repo_instructions>`);
    // And the log records its size: the file's bytes, and what the section cost.
    expect(outcome.firstLog.record?.instructions).toEqual({
      path: "AGENTS.md",
      bytes: Buffer.byteLength(AGENTS),
      tokens: expect.any(Number),
      cap: expect.any(Number),
      truncated: false,
    });
    expect(outcome.firstLog.record?.instructions?.tokens).toBeGreaterThan(0);
    // The skill's name and path are in the run's context, its body is not.
    const index = outcome.firstLog.sections["repo_skills"] ?? "";
    expect(index).toContain(
      `- ${SKILL_NAME} (${SKILL_PATH}): Use when the fixture needs its skill.`,
    );
    expect(index).toContain("- other (.agents/skills/other/SKILL.md)");
    expect(index).not.toContain(SKILL_BODY);
    expect(outcome.firstLog.record?.skills.listed).toEqual([
      { name: SKILL_NAME, path: SKILL_PATH },
      { name: "other", path: ".agents/skills/other/SKILL.md" },
    ]);
    // The run read the skill from its worktree by that path, and the factory's table has no row.
    const read = outcome.first.entries.find(
      (entry) => entry.kind === "toolResult" && entry.toolName === "bash",
    );
    expect(read?.text).toContain(SKILL_BODY);
    expect(outcome.known).toBe(0);
    // The next run is told what the base says now, never what the run wrote on its branch.
    const second = outcome.secondLog.sections["repo_instructions"] ?? "";
    expect(second).toContain(`A rule merged later (${RUN}).`);
    expect(second).not.toContain("RUN-WROTE-THIS");
    expect(outcome.secondLog.record?.commit).toBe(outcome.head);
  }, 120_000);

  it("runs a repository with no AGENTS.md and no skills unchanged", async () => {
    const outcome = await runtime.runPromise(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const { repo } = yield* register("bare", {
          "README.md": "nothing for agents\n",
        });
        const bare = yield* sessions.create({ repo, title: "bare" });
        const answered = yield* run(bare.id, "begin");
        const scratchSession = yield* sessions.create({ title: "no repo" });
        yield* run(scratchSession.id, "begin");
        return {
          answered,
          bare: yield* logged(bare.id),
          scratch: yield* logged(scratchSession.id),
        };
      }),
    );

    // No repository section at all — the same sections a session with no repository is told.
    expect(Object.keys(outcome.bare.sections)).toEqual(
      Object.keys(outcome.scratch.sections),
    );
    expect(
      Object.keys(outcome.bare.sections).filter((key) =>
        key.startsWith("repo_"),
      ),
    ).toEqual([]);
    // The record says there was nothing, rather than leaving it to be inferred.
    expect(outcome.bare.record?.instructions).toBeNull();
    expect(outcome.bare.record?.skills.listed).toEqual([]);
    expect(outcome.scratch.record).toBeUndefined();
    // And the run ran: the tool call and the answer, as before.
    expect(
      outcome.answered.entries.some(
        (entry) => entry.kind === "toolResult" && entry.toolName === "bash",
      ),
    ).toBe(true);
  }, 120_000);

  // F20. Mutation: read AGENTS.md only — the CLAUDE.md-only repo gets no section, and a repo with
  // both could be told either.
  it("falls back to CLAUDE.md for a repo with no AGENTS.md, lets AGENTS.md win when both exist, and lists nested AGENTS.md by path", async () => {
    const outcome = await runtime.runPromise(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const claude = yield* register("claude-only", {
          "CLAUDE.md": "# Claude rules\n\n- Use bun.\n",
        });
        const both = yield* register("agents-and-claude", {
          "AGENTS.md": "# Agents rules\n",
          "CLAUDE.md": "# Claude rules\n",
          "packages/web/AGENTS.md": "# Web rules (nested)\n",
        });
        const claudeSession = yield* sessions.create({
          repo: claude.repo,
          title: "claude",
        });
        yield* run(claudeSession.id, "begin");
        const bothSession = yield* sessions.create({
          repo: both.repo,
          title: "both",
        });
        yield* run(bothSession.id, "begin");
        return {
          claude: yield* logged(claudeSession.id),
          claudeContext: yield* sessions.context(claudeSession.id),
          both: yield* logged(bothSession.id),
          bothContext: yield* sessions.context(bothSession.id),
        };
      }),
    );

    const claude = outcome.claude.sections["repo_instructions"] ?? "";
    expect(claude).toContain(
      "The repository's CLAUDE.md, as committed at main",
    );
    expect(claude).toContain("- Use bun.");
    expect(outcome.claude.record?.instructions?.path).toBe("CLAUDE.md");
    expect(outcome.claudeContext.repo?.instructions?.path).toBe("CLAUDE.md");
    // With both, AGENTS.md is the one told, and the record says so; CLAUDE.md is not read in.
    const both = outcome.both.sections["repo_instructions"] ?? "";
    expect(both).toContain("The repository's AGENTS.md, as committed at main");
    expect(both).toContain("# Agents rules");
    expect(both).not.toContain("Claude rules");
    expect(outcome.both.record?.instructions?.path).toBe("AGENTS.md");
    // The nested file is named in the skills index, its text is not in the prompt.
    const index = outcome.both.sections["repo_skills"] ?? "";
    expect(index).toContain("- packages/web/AGENTS.md");
    expect(JSON.stringify(outcome.both.sections)).not.toContain("Web rules");
    expect(outcome.both.record?.skills.nested).toEqual([
      "packages/web/AGENTS.md",
    ]);
  }, 120_000);

  // F19. Mutations: answer `{}` for every session (no record is read); read the record with `owned`
  // semantics only; drop `truncated` or the skills counts from the answer.
  it("answers what the run was told for getSessionContext: the file, its size, truncation, skills; and nothing for a scratch session", async () => {
    const outcome = await runtime.runPromise(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const told = yield* register("ctx-told", {
          "AGENTS.md": AGENTS,
          [SKILL_PATH]: `---\nname: ${SKILL_NAME}\ndescription: Use when the fixture needs its skill.\n---\n\n${SKILL_BODY}\n`,
          ".agents/skills/other/SKILL.md": "No frontmatter.\n",
        });
        // A file far past the instructions cap: cut at a line boundary, and the record says so.
        const longRules = Array.from(
          { length: 3000 },
          (_, line) => `- rule ${line}: keep the gate green`,
        ).join("\n");
        const long = yield* register("ctx-long", { "AGENTS.md": longRules });
        const bare = yield* register("ctx-bare", { "README.md": "nothing\n" });
        const open = (repo: typeof told.repo, title: string) =>
          Effect.gen(function* () {
            const created = yield* sessions.create({ repo, title });
            yield* run(created.id, "begin");
            return created.id;
          });
        const toldId = yield* open(told.repo, "told");
        const longId = yield* open(long.repo, "long");
        const bareId = yield* open(bare.repo, "bare");
        const scratchId = (yield* sessions.create({ title: "scratch" })).id;
        yield* run(scratchId, "begin");
        // A session no process owns still answers: it is read from the log.
        yield* sessions.close;
        return {
          told: yield* sessions.context(toldId),
          long: yield* sessions.context(longId),
          bare: yield* sessions.context(bareId),
          scratch: yield* sessions.context(scratchId),
        };
      }),
    );

    expect(outcome.told.repo?.instructions).toEqual({
      path: "AGENTS.md",
      bytes: Buffer.byteLength(AGENTS),
      tokens: expect.any(Number),
      cap: expect.any(Number),
      truncated: false,
    });
    expect(outcome.told.repo?.skills.listed.map((skill) => skill.path)).toEqual(
      [SKILL_PATH, ".agents/skills/other/SKILL.md"],
    );
    expect(outcome.long.repo?.instructions?.truncated).toBe(true);
    expect(outcome.long.repo?.instructions?.tokens).toBeLessThanOrEqual(
      outcome.long.repo?.instructions?.cap ?? 0,
    );
    // A repo with neither file is a record of that, a scratch session has no record.
    expect(outcome.bare.repo?.instructions).toBeNull();
    expect(outcome.bare.repo?.skills.listed).toEqual([]);
    expect(outcome.scratch.repo).toBeUndefined();
  }, 120_000);

  it("refuses an unknown session", async () => {
    const error = await runtime.runPromise(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        return yield* Effect.flip(
          sessions.context("ses_00000000000000000000000000" as SessionId),
        );
      }),
    );

    expect(error.code).toBe("not_found");
  });
});
