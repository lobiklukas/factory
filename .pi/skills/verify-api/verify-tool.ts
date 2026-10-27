// The `verify` tool through the real service (LOB-78, part 1 of LOB-16).
//
//   bun verify-tool.ts      (via ./verify-tool.sh, which owns the database precondition)
//
// What this drives, and why it is not only a unit test: a *run* makes a change in its own git
// worktree, calls the `verify` tool, and the verdict is in the session's log. Every part of that is
// production code — `SessionService` on the run's `DATABASE_URL` resolving the workspace (its
// `.factory/config` and base ref), `openSession` installing the tool beside `CodingTools`, the tool
// measuring the branch with git and running the repo's skill or declared command, and the record
// read back out of the log with `readVerifyRecords`. The model is pi-ai's faux provider with
// `fauxVerify`: its `bash` turn writes (and commits) the change, its next turn calls `verify`. Nothing
// reaches a network.
//
// Five scenarios, each its own fixture repo and its own session:
//
//   pass       the surface's skill (`.pi/skills/verify-api/drive.sh`) exits 0 → exit 0 and its output
//   fail       the skill prints 400 lines and exits 3 → exit 3, the output's tail, the run still idle
//   no-skill   the change is under apps/web and the repo has no verify-web → typed no evidence
//   declared   `.factory/config` declares `verify` and a disagreeing skill exists → the declared one
//   repo       the change is `src/app.ts`, outside every package, and the declared `verify` fails →
//              the declared command ran once for the repo surface (`.`), exit 1, an error result
//
// Env: DATABASE_URL (via DatabaseLive), SESSION_ROOT, VERIFY_TOOL_REPOS, EVIDENCE_DIR.
import { BunServices } from "@effect/platform-bun";
import { execSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Effect, Layer, ManagedRuntime } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { RepoSlug as RepoSlugSchema } from "@repo/domain/Session";
import { createFauxModelAccess, readVerifyRecords } from "@repo/harness";
import type { VerifyRecord } from "@repo/harness";
import { DatabaseLive, PostgresStorage } from "@repo/storage-postgres";
import { SessionService, SessionServiceLive } from "@repo/core";
import { makeChecker, waitUntil } from "./harness.ts";
import type { CheckRecord } from "./harness.ts";

const SESSION_ROOT =
  process.env["SESSION_ROOT"] ?? ".verify/run/verify-tool/sessions";
const REPOS =
  process.env["VERIFY_TOOL_REPOS"] ?? ".verify/run/verify-tool/repos";
const EVIDENCE_DIR =
  process.env["EVIDENCE_DIR"] ?? ".verify/evidence/latest/api";

const DECLARED = 'echo "declared verify for $FACTORY_VERIFY_SURFACE"';
const DECLARED_FAILING =
  'echo "repo verify for $FACTORY_VERIFY_SURFACE"; exit 1';

type Scenario = {
  readonly name: string;
  /** Files committed on `main` before the session's worktree is cut. */
  readonly base: Record<string, string>;
  /** The file the run's `bash` turn writes and commits on its branch. */
  readonly change: string;
};

const SCENARIOS: readonly Scenario[] = [
  {
    name: "pass",
    base: {
      ".pi/skills/verify-api/drive.sh":
        'echo "verify-api fixture: 3/3 checks passed (surface=$FACTORY_VERIFY_SURFACE)"\n',
    },
    change: "apps/api/src/feature.ts",
  },
  {
    name: "fail",
    base: {
      ".pi/skills/verify-api/drive.sh":
        'for i in $(seq 1 400); do echo "check $i"; done\necho "FAIL: 1 required check failed" >&2\nexit 3\n',
    },
    change: "apps/api/src/feature.ts",
  },
  {
    name: "no-skill",
    base: {
      ".pi/skills/verify-api/drive.sh": 'echo "api only"\n',
    },
    change: "apps/web/src/page.tsx",
  },
  {
    name: "declared",
    base: {
      ".factory/config": JSON.stringify({ verify: DECLARED }),
      ".pi/skills/verify-api/drive.sh": 'echo "the skill ran"\nexit 9\n',
    },
    change: "apps/api/src/feature.ts",
  },
  {
    name: "repo",
    base: {
      ".factory/config": JSON.stringify({ verify: DECLARED_FAILING }),
    },
    change: "src/app.ts",
  },
];

const observed: {
  scenarios: Record<
    string,
    {
      sessionId: string;
      worktree: string;
      records: readonly VerifyRecord[];
      transcript: readonly { kind: string; toolName?: string; text: string }[];
      status: string;
    }
  >;
  checks: Record<string, CheckRecord>;
} = { scenarios: {}, checks: {} };
const assert = makeChecker(observed);

/** A fixture checkout with `base` committed on `main`, and no remote: no git call can leave it. */
const fixtureRepo = (scenario: Scenario): string => {
  const root = path.resolve(REPOS, scenario.name);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  const git = (command: string) =>
    execSync(command, { cwd: root, stdio: "ignore" });
  git("git init -q -b main");
  git("git config user.email verify-tool@localhost");
  git("git config user.name verify-tool");
  writeFileSync(path.join(root, "README.md"), `# ${scenario.name}\n`);
  for (const [file, content] of Object.entries(scenario.base)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), content);
  }
  git("git add -A");
  git("git commit -q -m base");
  return root;
};

/** The run's change, committed on its own branch in its own worktree — a branch diff, nothing else. */
const changeCommand = (file: string) =>
  [
    `mkdir -p ${path.posix.dirname(file)}`,
    `echo 'export const feature = 1;' > ${file}`,
    "git add -A",
    "git -c user.email=t@t.com -c user.name=t commit -q -m feature",
    "echo committed",
  ].join(" && ");

const runScenario = async (scenario: Scenario) => {
  const repoRoot = fixtureRepo(scenario);
  const faux = createFauxModelAccess({
    fauxVerify: true,
    fauxCommand: changeCommand(scenario.change),
  });
  const runtime = ManagedRuntime.make(
    SessionServiceLive({
      model: faux.access,
      sessionRoot: path.resolve(SESSION_ROOT),
    }).pipe(
      Layer.provideMerge(Layer.mergeAll(DatabaseLive, BunServices.layer)),
    ),
  );
  const repo = RepoSlugSchema.make(`verify-tool/${scenario.name}`);
  try {
    return await runtime.runPromise(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        yield* sessions.registerRepo({
          repo,
          url: `https://example.invalid/verify-tool/${scenario.name}.git`,
          localPath: repoRoot,
        });
        const created = yield* sessions.create({
          repo,
          baseRef: "main",
          title: `verify-tool ${scenario.name}`,
        });
        yield* sessions.send({
          sessionId: created.id,
          content: "make the change and verify it",
        });
        const settled = yield* waitUntil(
          Effect.map(sessions.get(created.id), (snapshot) =>
            snapshot.session.status === "idle" &&
            snapshot.entries.some(
              (entry) => entry.kind === "assistant" && entry.text !== "",
            )
              ? snapshot
              : false,
          ),
          `the ${scenario.name} run to verify and answer`,
        );
        const sql = yield* SqlClient;
        const records = yield* Effect.acquireUseRelease(
          Effect.promise(() => PostgresStorage.reader(sql, created.id)),
          (storage) => readVerifyRecords(storage),
          (storage) => Effect.promise(() => storage.dispose()),
        );
        const entry = {
          sessionId: created.id,
          worktree: settled.workspace.path,
          records,
          transcript: settled.entries.map((item) => ({
            kind: item.kind,
            ...(item.toolName === undefined ? {} : { toolName: item.toolName }),
            text: item.text,
          })),
          status: settled.session.status,
        };
        observed.scenarios[scenario.name] = entry;
        return entry;
      }),
    );
  } finally {
    await runtime.dispose();
  }
};

/** The single report a run's one `verify` call made, or `undefined`. */
const reportOf = (records: readonly VerifyRecord[]) => {
  const [record] = records;
  return records.length === 1 && record?._tag === "VerifyReport"
    ? record
    : undefined;
};

const verifyText = (entry: {
  readonly transcript: readonly {
    kind: string;
    toolName?: string;
    text: string;
  }[];
}) =>
  entry.transcript.find(
    (item) => item.kind === "toolResult" && item.toolName === "verify",
  )?.text ?? "";

const checks: Record<
  string,
  (entry: Awaited<ReturnType<typeof runScenario>>) => void
> = {
  pass: (entry) => {
    const report = reportOf(entry.records);
    const result = report?.results[0];
    assert(
      "pass: the change is measured on the branch against main",
      JSON.stringify(report?.changed) ===
        JSON.stringify(["apps/api/src/feature.ts"]),
      JSON.stringify(report?.changed),
    );
    assert(
      "pass: the api skill ran and exit 0 is in the log",
      result?._tag === "VerifyRan" &&
        result.source === "skill" &&
        result.directory === ".pi/skills/verify-api" &&
        result.exitCode === 0,
      JSON.stringify(result),
    );
    assert(
      "pass: with its output, and the surface it was told",
      result?._tag === "VerifyRan" &&
        result.output.includes("3/3 checks passed (surface=api)"),
      result?._tag === "VerifyRan" ? result.output.trim() : "no run",
    );
    assert(
      "pass: the model read the same verdict",
      verifyText(entry).includes("[api] exit 0"),
      verifyText(entry).split("\n")[1] ?? "",
    );
  },
  fail: (entry) => {
    const result = reportOf(entry.records)?.results[0];
    assert(
      "fail: a non-zero skill records exit 3",
      result?._tag === "VerifyRan" && result.exitCode === 3,
      JSON.stringify(result?._tag === "VerifyRan" ? result.exitCode : result),
    );
    assert(
      "fail: and the output's tail — the verdict kept, the first lines cut",
      result?._tag === "VerifyRan" &&
        result.truncated &&
        result.output.endsWith("FAIL: 1 required check failed\n") &&
        !result.output.split("\n").includes("check 1"),
      result?._tag === "VerifyRan"
        ? `truncated=${result.truncated} first=${result.output.split("\n")[0]}`
        : "no run",
    );
    assert(
      "fail: the tool did not throw — the run answered and is idle",
      entry.status === "idle" && verifyText(entry).includes("[api] exit 3"),
      `status=${entry.status}`,
    );
  },
  "no-skill": (entry) => {
    const result = reportOf(entry.records)?.results[0];
    assert(
      "no-skill: a surface with no verify skill is a typed no-evidence result naming it",
      result?._tag === "VerifyNoEvidence" &&
        result.surface === "web" &&
        result.reason === "no-verify-skill",
      JSON.stringify(result),
    );
    assert(
      "no-skill: and the model is told, not left in silence",
      verifyText(entry).includes('no evidence for surface "web"'),
      verifyText(entry).split("\n")[1] ?? "",
    );
  },
  declared: (entry) => {
    const result = reportOf(entry.records)?.results[0];
    assert(
      "declared: the workspace's verify command wins over the disagreeing skill",
      result?._tag === "VerifyRan" &&
        result.source === "workspace" &&
        result.command === DECLARED &&
        result.exitCode === 0 &&
        result.output === "declared verify for api\n",
      JSON.stringify(result),
    );
  },
  repo: (entry) => {
    const report = reportOf(entry.records);
    const result = report?.results[0];
    assert(
      "repo: a change outside every package still runs the declared verify, once, for the repo",
      report?.results.length === 1 &&
        result?._tag === "VerifyRan" &&
        result.surface === "." &&
        result.source === "workspace" &&
        result.command === DECLARED_FAILING &&
        result.output === "repo verify for .\n",
      JSON.stringify(report),
    );
    assert(
      "repo: and its failure is the verdict, not silence",
      result?._tag === "VerifyRan" &&
        result.exitCode === 1 &&
        verifyText(entry).includes("[.] exit 1"),
      verifyText(entry).split("\n")[1] ?? "",
    );
  },
};

for (const scenario of SCENARIOS) {
  try {
    const entry = await runScenario(scenario);
    checks[scenario.name]?.(entry);
  } catch (error) {
    assert(
      `${scenario.name}: the scenario completed`,
      false,
      `threw: ${String(error)}`,
    );
  }
}

await mkdir(EVIDENCE_DIR, { recursive: true });
await writeFile(
  path.join(EVIDENCE_DIR, "verify-tool.json"),
  `${JSON.stringify(observed, null, 2)}\n`,
);

const failed = Object.entries(observed.checks).filter(
  ([, check]) => !check.passed,
);
console.log(
  `\nverify-tool: ${Object.keys(observed.checks).length - failed.length}/${Object.keys(observed.checks).length} checks passed — evidence in ${EVIDENCE_DIR}/verify-tool.json`,
);
if (failed.length > 0) process.exitCode = 1;
