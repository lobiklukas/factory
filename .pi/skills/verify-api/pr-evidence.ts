// The PR body's evidence block through the real service (LOB-79, part 2 of LOB-16).
//
//   bun pr-evidence.ts      (via ./pr-evidence.sh, which owns the fake GitHub and the database)
//
// What this drives: a run makes a change in its own git worktree, calls (or does not call) the
// `verify` tool, and the control plane opens the session's PR. The body GitHub receives must state
// what was verified from the log's record — the skill's name, its exit code and a bounded excerpt of
// its output — and say so explicitly when nothing was. Every part of that is production code:
// `SessionService` on the run's `DATABASE_URL`, `openSession` installing `verify`, the tool running
// the fixture's skill, `openPullRequest` reading the record and rendering the body, and the
// `FetchHttpClient` call to `GITHUB_API_URL` — which `./pr-evidence.sh` points at the loopback fake
// (`./github-fake.ts`), whose ledger on disk is where the body is read back from. Nothing reaches a
// network: the model is pi-ai's faux provider and the fixture repos have no remote.
//
// Three scenarios, each its own fixture repo and its own session:
//
//   pass        the `verify-api` skill prints a verdict and exits 0 → the body names `verify-api`,
//               exit 0, and quotes the output whole
//   fail        the skill prints 400 lines and exits 3 → exit 3 (failed), and a 40-line tail marked
//               as truncated, the same tail the record's output gives under `PR_EVIDENCE_EXCERPT`
//   unverified  the run commits its change and never calls `verify` → the body says "No verification
//               evidence" rather than leaving the section out
//
// Env: DATABASE_URL (via DatabaseLive), GITHUB_API_URL, PR_EVIDENCE_LEDGER, SESSION_ROOT,
// PR_EVIDENCE_REPOS, EVIDENCE_DIR.
import { BunServices } from "@effect/platform-bun";
import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Effect, Layer, ManagedRuntime, Option, Redacted } from "effect";
import { FetchHttpClient } from "effect/http";
import { SqlClient } from "effect/sql/SqlClient";
import { RepoSlug as RepoSlugSchema } from "@repo/domain/Session";
import type { PrEvidence } from "@repo/domain/Session";
import {
  createFauxModelAccess,
  PR_EVIDENCE_EXCERPT,
  readSessionLog,
  readVerifyRecords,
  tailOf,
} from "@repo/harness";
import type { VerifyRecord } from "@repo/harness";
import { DatabaseLive, PostgresStorage } from "@repo/storage-postgres";
import {
  CredentialProvider,
  SessionService,
  SessionServiceLive,
  staticTokenProvider,
} from "@repo/core";
import { makeChecker, waitUntil } from "./harness.ts";
import type { CheckRecord } from "./harness.ts";

const SESSION_ROOT =
  process.env["SESSION_ROOT"] ?? ".verify/run/pr-evidence/sessions";
const REPOS =
  process.env["PR_EVIDENCE_REPOS"] ?? ".verify/run/pr-evidence/repos";
const LEDGER =
  process.env["PR_EVIDENCE_LEDGER"] ??
  ".verify/run/pr-evidence/github-ledger.json";
const EVIDENCE_DIR =
  process.env["EVIDENCE_DIR"] ?? ".verify/evidence/latest/api";
const OWNER = "pr-evidence";

type Scenario = {
  readonly name: string;
  /** The fixture's `verify-api` driver, committed on `main`. */
  readonly drive: string;
  /** Whether the faux model calls `verify` after its `bash` turn. */
  readonly verify: boolean;
};

const SCENARIOS: readonly Scenario[] = [
  {
    name: "pass",
    drive: 'echo "verify-api fixture: 3/3 checks passed"\n',
    verify: true,
  },
  {
    name: "fail",
    drive:
      'for i in $(seq 1 400); do echo "check $i"; done\necho "FAIL: 1 required check failed"\nexit 3\n',
    verify: true,
  },
  {
    name: "unverified",
    drive: 'echo "never run"\n',
    verify: false,
  },
];

type Outcome = {
  sessionId: string;
  answer: unknown;
  body: string;
  records: readonly VerifyRecord[];
  evidence: PrEvidence | undefined;
};

const observed: {
  scenarios: Record<string, Outcome>;
  checks: Record<string, CheckRecord>;
} = { scenarios: {}, checks: {} };
const assert = makeChecker(observed);

/** A fixture checkout with the scenario's skill committed on `main`, and no remote. */
const fixtureRepo = (scenario: Scenario): string => {
  const root = path.resolve(REPOS, scenario.name);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(path.join(root, ".pi", "skills", "verify-api"), {
    recursive: true,
  });
  const git = (command: string) =>
    execSync(command, { cwd: root, stdio: "ignore" });
  git("git init -q -b main");
  git("git config user.email pr-evidence@localhost");
  git("git config user.name pr-evidence");
  writeFileSync(path.join(root, "README.md"), `# ${scenario.name}\n`);
  writeFileSync(
    path.join(root, ".pi", "skills", "verify-api", "drive.sh"),
    scenario.drive,
  );
  git("git add -A");
  git("git commit -q -m base");
  return root;
};

/** The run's change: `apps/api/feature.ts`, committed on the session's own branch. */
const CHANGE =
  "mkdir -p apps/api && echo 'export const feature = 1;' > apps/api/feature.ts && " +
  "git add -A && git -c user.email=t@t.com -c user.name=t commit -q -m feature && echo committed";

/** A static token, as `apps/api` wires one; the fake never reads it. */
const github = Layer.merge(
  Layer.succeed(
    CredentialProvider,
    staticTokenProvider(Option.some(Redacted.make("pr-evidence-fake-token"))),
  ),
  FetchHttpClient.layer,
);

/** The body the fake was sent for one scenario's repo, read from its ledger on disk. */
const sentBody = (scenario: Scenario): string => {
  const ledger = JSON.parse(readFileSync(LEDGER, "utf8")) as {
    readonly requests: ReadonlyArray<{
      readonly method: string;
      readonly path: string;
      readonly body?: { readonly body?: string };
    }>;
  };
  const posts = ledger.requests.filter(
    (request) =>
      request.method === "POST" &&
      request.path === `/repos/${OWNER}/${scenario.name}/pulls`,
  );
  return posts.length === 1 ? (posts[0]?.body?.body ?? "") : "";
};

const runScenario = async (scenario: Scenario): Promise<Outcome> => {
  const repoRoot = fixtureRepo(scenario);
  const faux = createFauxModelAccess({
    fauxVerify: scenario.verify,
    fauxCommand: CHANGE,
  });
  const runtime = ManagedRuntime.make(
    SessionServiceLive({
      model: faux.access,
      sessionRoot: path.resolve(SESSION_ROOT),
    }).pipe(
      Layer.provideMerge(Layer.mergeAll(DatabaseLive, BunServices.layer)),
    ),
  );
  const repo = RepoSlugSchema.make(`${OWNER}/${scenario.name}`);
  try {
    return await runtime.runPromise(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        yield* sessions.registerRepo({
          repo,
          url: `https://example.invalid/${OWNER}/${scenario.name}.git`,
          localPath: repoRoot,
        });
        const created = yield* sessions.create({
          repo,
          baseRef: "main",
          title: `pr-evidence ${scenario.name}`,
        });
        yield* sessions.send({
          sessionId: created.id,
          content: "make the change and verify it",
        });
        yield* waitUntil(
          Effect.map(
            sessions.get(created.id),
            (snapshot) =>
              snapshot.session.status === "idle" &&
              snapshot.entries.some(
                (entry) => entry.kind === "assistant" && entry.text !== "",
              ),
          ),
          `the ${scenario.name} run to answer`,
        );
        const answer = yield* sessions
          .openPullRequest({
            sessionId: created.id,
            title: `pr-evidence: ${scenario.name}`,
            head: `factory/${created.id}`,
            base: "main",
          })
          .pipe(Effect.provide(github));
        const sql = yield* SqlClient;
        const { records, log } = yield* Effect.acquireUseRelease(
          Effect.promise(() => PostgresStorage.reader(sql, created.id)),
          (storage) =>
            Effect.all({
              records: readVerifyRecords(storage),
              log: readSessionLog(storage),
            }),
          (storage) => Effect.promise(() => storage.dispose()),
        );
        const outcome: Outcome = {
          sessionId: created.id,
          answer,
          body: sentBody(scenario),
          records,
          evidence: log.pr?.evidence,
        };
        observed.scenarios[scenario.name] = outcome;
        return outcome;
      }),
    );
  } finally {
    await runtime.dispose();
  }
};

/** The one recorded `verify` output of a run, or "". */
const recordedOutput = (records: readonly VerifyRecord[]): string => {
  const [record] = records;
  const result =
    record?._tag === "VerifyReport" ? record.results[0] : undefined;
  return result?._tag === "VerifyRan" ? result.output : "";
};

const section = (body: string): string => {
  const start = body.indexOf("## Verification");
  const end = body.indexOf("## Prompt");
  return start === -1 ? "" : body.slice(start, end === -1 ? undefined : end);
};

const checks: Record<string, (outcome: Outcome) => void> = {
  pass: (outcome) => {
    const text = section(outcome.body);
    assert(
      "pass: the PR was opened through the fake, with a body",
      outcome.body !== "",
      `answer=${JSON.stringify(outcome.answer)}`,
    );
    assert(
      "pass: the body names the skill and its exit code",
      text.includes("### `verify-api`: exit 0") &&
        text.includes("- Exit code: 0"),
      text.split("\n").slice(0, 6).join(" | "),
    );
    assert(
      "pass: and quotes the recorded output, whole and unmarked",
      text.includes("```text\nverify-api fixture: 3/3 checks passed\n```") &&
        !text.includes("truncated"),
      JSON.stringify(recordedOutput(outcome.records)),
    );
    assert(
      "pass: the factory.pr document holds the evidence the body was rendered from",
      outcome.evidence?._tag === "EvidenceRecorded" &&
        outcome.evidence.results[0]?._tag === "VerificationRan" &&
        outcome.evidence.results[0].name === "verify-api" &&
        outcome.evidence.results[0].exitCode === 0,
      JSON.stringify(outcome.evidence),
    );
  },
  fail: (outcome) => {
    const text = section(outcome.body);
    const excerpt = tailOf(
      recordedOutput(outcome.records),
      PR_EVIDENCE_EXCERPT,
    ).output;
    assert(
      "fail: the body names the failing exit code",
      text.includes("### `verify-api`: exit 3 (failed)") &&
        text.includes("- Exit code: 3"),
      text.split("\n")[4] ?? "",
    );
    assert(
      "fail: the excerpt is bounded and its truncation is visible",
      text.includes(
        `Output (truncated: earlier output omitted, the last ${PR_EVIDENCE_EXCERPT.maxLines} line(s) shown):`,
      ) &&
        text.includes("FAIL: 1 required check failed") &&
        !text.includes("check 1\n"),
      `${text.length} chars in the section`,
    );
    assert(
      "fail: the excerpt is exactly the PR bound's tail of the recorded output (deterministic)",
      excerpt !== "" && text.includes(`\`\`\`text\n${excerpt}\`\`\``),
      `${excerpt.split("\n").length - 1} line(s), starts ${JSON.stringify(excerpt.split("\n")[0])}`,
    );
  },
  unverified: (outcome) => {
    const text = section(outcome.body);
    assert(
      "unverified: the run made no verify record",
      outcome.records.length === 0,
      `${outcome.records.length} record(s)`,
    );
    assert(
      "unverified: the body says so explicitly instead of omitting the section",
      text.includes(
        "**No verification evidence.** Nothing in this PR was verified by a recorded run: " +
          "the run never called the `verify` tool.",
      ),
      text.split("\n")[2] ?? "no section",
    );
    assert(
      "unverified: and the document records the same EvidenceNone",
      outcome.evidence?._tag === "EvidenceNone" &&
        outcome.evidence.reason === "not-verified",
      JSON.stringify(outcome.evidence),
    );
  },
};

for (const scenario of SCENARIOS) {
  try {
    const outcome = await runScenario(scenario);
    checks[scenario.name]?.(outcome);
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
  path.join(EVIDENCE_DIR, "pr-evidence.json"),
  `${JSON.stringify(observed, null, 2)}\n`,
);
for (const [name, outcome] of Object.entries(observed.scenarios)) {
  await writeFile(
    path.join(EVIDENCE_DIR, `pr-evidence-${name}.md`),
    outcome.body,
  );
}

const failed = Object.entries(observed.checks).filter(
  ([, check]) => !check.passed,
);
console.log(
  `\npr-evidence: ${Object.keys(observed.checks).length - failed.length}/${Object.keys(observed.checks).length} checks passed — evidence in ${EVIDENCE_DIR}/pr-evidence.json`,
);
if (failed.length > 0) process.exitCode = 1;
