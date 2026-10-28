// A repository's AGENTS.md and SKILL.md skills in every run, over the real API
// (S-repo-instructions-and-skills).
//
//   bun repo-context.ts      (via ./repo-context.sh, which boots the API with the faux script)
//
// Three repos, each registered over RPC:
//
//   told   a fixture with an AGENTS.md, a `.pi/skills/<name>/SKILL.md` and an `.agents/skills`
//          one. The session's recorded prompt (its log's `pi.system` sections) carries AGENTS.md
//          verbatim as `repo_instructions` and both skills, by name and path, as `repo_skills`; the
//          log's `factory.repo.prompt` record names the file, its bytes and the sections' tokens. The
//          faux run's `bash` reads the skill by that path from its worktree, and `listSkills` — the
//          factory's skills table — has no row of that name.
//   bare   a fixture with neither file: the run answers, its prompt has no `repo_*` section — the
//          same section keys a session with no repo gets — and the record says `instructions: null`.
//   self   a clone of this checkout: the run is told this repository's own AGENTS.md (the Postgres
//          gate rule) and its verify skills.
//
// Env: API_URL, DATABASE_URL (to read the session logs), REPO_CONTEXT_REPOS, REPO_CONTEXT_SKILL,
// EVIDENCE_DIR.
import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { RpcApi } from "@repo/domain/Rpc";
import { RepoSlug, type SessionId } from "@repo/domain/Session";
import { readPromptSections, readRepoPrompt } from "@repo/harness";
import { DatabaseLive, PostgresStorage } from "@repo/storage-postgres";
import { Effect, Exit, Layer } from "effect";
import { RpcClient } from "effect/rpc";
import { SqlClient } from "effect/sql/SqlClient";
import { makeChecker, protocolFor, waitUntil } from "./harness.ts";
import type { CheckRecord } from "./harness.ts";

const API_URL = process.env["API_URL"] ?? "http://localhost:9440";
const REPOS = path.resolve(
  process.env["REPO_CONTEXT_REPOS"] ?? ".verify/run/repo-context/repos",
);
const EVIDENCE_DIR = path.resolve(
  process.env["EVIDENCE_DIR"] ?? ".verify/evidence/latest/api",
);
/** The fixture skill's directory name: what repo-context.sh's `FAUX_COMMAND` reads. */
const SKILL_NAME = process.env["REPO_CONTEXT_SKILL"] ?? "verify-fixture";
const SKILL_PATH = `.pi/skills/${SKILL_NAME}/SKILL.md`;
const RUN = `${Date.now().toString(36)}`;
const SKILL_BODY = `The fixture skill's body, read on demand (${RUN}).`;
const AGENTS = `# Fixture rules (${RUN})\n\n- Postgres is on 5442.\n- Gate every change with five commands.\n`;
/** This checkout: the `self` scenario clones it, so a session runs on the factory repo itself. */
const SELF = path.resolve(import.meta.dirname, "..", "..", "..");

const observed: {
  apiUrl: string;
  run: string;
  told?: unknown;
  bare?: unknown;
  self?: unknown;
  checks: Record<string, CheckRecord>;
} = { apiUrl: API_URL, run: RUN, checks: {} };
const assert = makeChecker(observed);

/** A checkout with `files` committed on `main`, and no remote. */
const fixtureRepo = (name: string, files: Record<string, string>): string => {
  const root = path.join(REPOS, name);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  const git = (command: string) =>
    execSync(command, { cwd: root, stdio: "ignore" });
  git("git init -q -b main");
  git("git config user.email verify-repo-context@localhost");
  git("git config user.name verify-repo-context");
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), content);
  }
  git("git add -A");
  git("git commit -q -m base");
  return root;
};

/** The prompt a session's log leaves in effect, and its repo record, read like any reader would. */
const logged = (sessionId: string) =>
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

const program = Effect.gen(function* () {
  const client = yield* RpcClient.make(RpcApi);

  /** Create a session, send one message, and wait for the run to answer. */
  const runOn = (repo: RepoSlug | undefined, title: string) =>
    Effect.gen(function* () {
      const created = yield* client.createSession({
        ...(repo === undefined ? {} : { repo }),
        title,
      });
      yield* client.sendMessage({
        sessionId: created.id,
        content: "start on the task",
      });
      const snapshot = yield* waitUntil(
        Effect.map(client.getSession({ sessionId: created.id }), (current) =>
          !current.live.busy &&
          current.entries.some(
            (entry) => entry.kind === "assistant" && entry.text !== "",
          )
            ? current
            : undefined,
        ),
        `the ${title} run to answer`,
      );
      return { id: created.id as SessionId, snapshot };
    });

  // --- told: AGENTS.md and a skill index, recorded; the run reads the skill ------------------------
  const toldRepo = RepoSlug.make(`verify-repo-context-${RUN}/told`);
  yield* client.registerRepo({
    repo: toldRepo,
    defaultBaseRef: "main",
    localPath: fixtureRepo("told", {
      "AGENTS.md": AGENTS,
      [SKILL_PATH]: `---\nname: ${SKILL_NAME}\ndescription: Use when the fixture needs its skill.\n---\n\n${SKILL_BODY}\n`,
      ".agents/skills/other/SKILL.md":
        "No frontmatter, so the directory names it.\n",
    }),
  });
  const told = yield* runOn(toldRepo, "verify-repo-context told");
  const toldLog = yield* logged(told.id);
  const instructions = toldLog.sections["repo_instructions"] ?? "";
  const index = toldLog.sections["repo_skills"] ?? "";
  const read = told.snapshot.entries.find(
    (entry) => entry.kind === "toolResult" && entry.toolName === "bash",
  );
  const library = yield* client.listSkills({});
  observed.told = {
    sessionId: told.id,
    worktree: told.snapshot.workspace.path,
    sectionKeys: Object.keys(toldLog.sections),
    repoInstructions: instructions,
    repoSkills: index,
    record: toldLog.record,
    bashResult: read?.text,
    factorySkills: library.map((skill) => skill.name),
  };
  assert(
    "told: the recorded prompt carries AGENTS.md verbatim as repo_instructions",
    instructions.startsWith("<repo_instructions>\n") &&
      instructions.includes(`\n\n${AGENTS}\n</repo_instructions>`),
    `${instructions.length} chars`,
  );
  assert(
    "told: the log records AGENTS.md's size and the section's token cost",
    toldLog.record?.instructions?.path === "AGENTS.md" &&
      toldLog.record.instructions.bytes === Buffer.byteLength(AGENTS) &&
      toldLog.record.instructions.tokens > 0 &&
      toldLog.record.instructions.truncated === false,
    JSON.stringify(toldLog.record?.instructions),
  );
  assert(
    "told: repo_skills names each skill and its path, not its body",
    index.includes(
      `- ${SKILL_NAME} (${SKILL_PATH}): Use when the fixture needs its skill.`,
    ) &&
      index.includes("- other (.agents/skills/other/SKILL.md)") &&
      !index.includes(SKILL_BODY),
    `${toldLog.record?.skills.listed.length ?? 0} listed, ${toldLog.record?.skills.tokens ?? 0} tokens`,
  );
  assert(
    "told: the run read the skill from its worktree by the listed path",
    read?.text.includes(SKILL_BODY) === true,
    read?.text.trim().slice(0, 80) ?? "no bash result",
  );
  assert(
    "told: the factory's skills table does not know the repo's skill",
    !library.some((skill) => skill.name === SKILL_NAME) &&
      !library.some((skill) => skill.name === "other"),
    `${library.length} factory skills`,
  );

  // --- bare: neither file, nothing new ------------------------------------------------------------
  const bareRepo = RepoSlug.make(`verify-repo-context-${RUN}/bare`);
  yield* client.registerRepo({
    repo: bareRepo,
    defaultBaseRef: "main",
    localPath: fixtureRepo("bare", { "README.md": "nothing for agents\n" }),
  });
  const bare = yield* runOn(bareRepo, "verify-repo-context bare");
  const bareLog = yield* logged(bare.id);
  const scratch = yield* runOn(undefined, "verify-repo-context scratch");
  const scratchLog = yield* logged(scratch.id);
  observed.bare = {
    sessionId: bare.id,
    sectionKeys: Object.keys(bareLog.sections),
    scratchSectionKeys: Object.keys(scratchLog.sections),
    record: bareLog.record,
    scratchRecord: scratchLog.record ?? null,
  };
  assert(
    "bare: no repo_* section, the same section keys as a session with no repo",
    !Object.keys(bareLog.sections).some((key) => key.startsWith("repo_")) &&
      JSON.stringify(Object.keys(bareLog.sections)) ===
        JSON.stringify(Object.keys(scratchLog.sections)),
    JSON.stringify(Object.keys(bareLog.sections)),
  );
  assert(
    "bare: the run answered, and the log records no AGENTS.md and no skills",
    bare.snapshot.entries.some((entry) => entry.kind === "assistant") &&
      bareLog.record?.instructions === null &&
      bareLog.record.skills.listed.length === 0,
    JSON.stringify(bareLog.record),
  );

  // --- self: a session on this repository is told its own rules ------------------------------------
  const selfPath = path.join(REPOS, "self");
  rmSync(selfPath, { recursive: true, force: true });
  execSync(`git clone -q "${SELF}" "${selfPath}"`, { stdio: "ignore" });
  const selfBase = execSync("git rev-parse --abbrev-ref HEAD", {
    cwd: selfPath,
    encoding: "utf8",
  }).trim();
  const selfRepo = RepoSlug.make(`verify-repo-context-${RUN}/factory`);
  yield* client.registerRepo({
    repo: selfRepo,
    defaultBaseRef: selfBase,
    localPath: selfPath,
  });
  const self = yield* runOn(selfRepo, "verify-repo-context self");
  const selfLog = yield* logged(self.id);
  const selfInstructions = selfLog.sections["repo_instructions"] ?? "";
  const selfIndex = selfLog.sections["repo_skills"] ?? "";
  const committedAgents = readFileSync(
    path.join(selfPath, "AGENTS.md"),
    "utf8",
  );
  observed.self = {
    sessionId: self.id,
    base: selfBase,
    record: selfLog.record,
    repoSkills: selfIndex,
  };
  assert(
    "self: this repository's AGENTS.md, its Postgres gate rule included, reaches the run",
    selfInstructions.includes("Local Postgres is part of the gate") &&
      selfLog.record?.instructions?.bytes ===
        Buffer.byteLength(committedAgents),
    `${selfLog.record?.instructions?.bytes ?? 0} bytes, ${selfLog.record?.instructions?.tokens ?? 0} tokens, truncated ${selfLog.record?.instructions?.truncated}`,
  );
  assert(
    "self: this repository's verify skills are listed by path",
    selfIndex.includes("(.pi/skills/verify-api/SKILL.md)") &&
      selfIndex.includes("(.pi/skills/effect/SKILL.md)"),
    `${selfLog.record?.skills.listed.length ?? 0} listed, ${selfLog.record?.skills.dropped.length ?? 0} dropped`,
  );
});

const result = await Effect.runPromiseExit(
  Effect.scoped(program).pipe(
    Effect.provide(Layer.mergeAll(protocolFor(API_URL), DatabaseLive)),
  ),
);
if (Exit.isFailure(result)) {
  assert("the drive completed", false, String(result.cause));
}

await mkdir(EVIDENCE_DIR, { recursive: true });
await writeFile(
  path.join(EVIDENCE_DIR, "repo-context.json"),
  `${JSON.stringify(observed, null, 2)}\n`,
);
const failed = Object.entries(observed.checks).filter(
  ([, check]) => !check.passed,
);
console.log(
  `\nrepo-context: ${Object.keys(observed.checks).length - failed.length}/${Object.keys(observed.checks).length} checks passed — evidence in ${EVIDENCE_DIR}/repo-context.json`,
);
if (failed.length > 0) process.exitCode = 1;
