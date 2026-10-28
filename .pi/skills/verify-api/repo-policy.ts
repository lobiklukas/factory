// A repository's policy from `.factory/config` at the base, over the real API
// (S-factory-config-as-code).
//
//   bun repo-policy.ts      (via ./repo-policy.sh, which boots the API twice with the faux script)
//
// The faux run calls `./bin/bun publish` on every turn: each fixture commits `bin/bun`, a script that
// only echoes a marker, so the gate reads it as `bun publish` and, where nothing gates it, the run
// executes the fixture's script and nothing else.
//
// PHASE=arm, on the first process:
//   gated     a repo whose config gates `bun publish`: the run parks on an approval for it, the
//             marker never appears, and the log's `factory.policy` record names the base commit, the
//             repo's gate and the effective rules.
//   bare      a repo with no config: no approval, and the marker is in the run's bash result.
//   denying   a repo whose config denies `bun publish`: refused outright, no approval asked.
//   widening  a repo whose config allows `evil.example`, which the deployment does not: the create
//             is refused `policy_rejected`, naming the host, and leaves no session row.
//   Then, as the agent could with its own tools, `.factory/config` is rewritten to `{}` in the gated
//   session's worktree and committed on its branch.
// PHASE=verify, on a fresh process (the owner reopens over the same log):
//   the gated session still parks, with the one approval still pending and no marker; the base
//   relaxes on main, and the gated session still parks (its policy is pinned in its log); a new
//   session on the same repo reads the relaxed base and runs the script.
//
// Env: API_URL, DATABASE_URL (to read the session logs), PHASE, REPO_POLICY_REPOS, REPO_POLICY_STATE,
// EVIDENCE_DIR.
import { execSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { RpcApi } from "@repo/domain/Rpc";
import {
  RepoSlug,
  type SessionId,
  type SessionSnapshot,
} from "@repo/domain/Session";
import { readPolicyRecord } from "@repo/harness";
import { DatabaseLive, PostgresStorage } from "@repo/storage-postgres";
import { Effect, Exit, Layer } from "effect";
import { RpcClient } from "effect/rpc";
import { SqlClient } from "effect/sql/SqlClient";
import { makeChecker, protocolFor, waitUntil } from "./harness.ts";
import type { CheckRecord } from "./harness.ts";

const API_URL = process.env["API_URL"] ?? "http://localhost:9441";
const PHASE = process.env["PHASE"] === "verify" ? "verify" : "arm";
const REPOS = path.resolve(
  process.env["REPO_POLICY_REPOS"] ?? ".verify/run/repo-policy/repos",
);
const STATE = path.resolve(
  process.env["REPO_POLICY_STATE"] ?? ".verify/run/repo-policy/state.json",
);
const EVIDENCE_DIR = path.resolve(
  process.env["EVIDENCE_DIR"] ?? ".verify/evidence/latest/api",
);
/** What repo-policy.sh's `FAUX_COMMAND` calls, and what the fixture's script prints. */
const COMMAND = "./bin/bun publish";
const MARKER = process.env["REPO_POLICY_MARKER"] ?? "fake-bun-publish-ran";
const GATED = JSON.stringify({
  policy: { approvalRequired: ["bun publish"] },
});

type State = {
  readonly run: string;
  readonly gatedRepo: string;
  readonly gatedPath: string;
  readonly gatedSession: string;
  readonly worktree: string;
};

const observed: {
  apiUrl: string;
  phase: string;
  scenarios: Record<string, unknown>;
  checks: Record<string, CheckRecord>;
} = { apiUrl: API_URL, phase: PHASE, scenarios: {}, checks: {} };
const assert = makeChecker(observed);

const git = (cwd: string, command: string) =>
  execSync(command, { cwd, stdio: "ignore" });

/** A checkout with `files` and the `bin/bun` script committed on `main`, and no remote. */
const fixtureRepo = (name: string, files: Record<string, string>): string => {
  const root = path.join(REPOS, name);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  git(root, "git init -q -b main");
  git(root, "git config user.email verify-repo-policy@localhost");
  git(root, "git config user.name verify-repo-policy");
  const all = { ...files, "bin/bun": `#!/bin/sh\necho ${MARKER}\n` };
  for (const [file, content] of Object.entries(all)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), content);
  }
  chmodSync(path.join(root, "bin/bun"), 0o755);
  git(root, "git add -A");
  git(root, "git commit -q -m base");
  return root;
};

/** The policy a session's log records, read like any reader would. */
const recorded = (sessionId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    return yield* Effect.acquireUseRelease(
      Effect.promise(() => PostgresStorage.reader(sql, sessionId)),
      readPolicyRecord,
      (storage) => Effect.promise(() => storage.dispose()),
    );
  });

const bashResults = (snapshot: SessionSnapshot) =>
  snapshot.entries.filter(
    (entry) => entry.kind === "toolResult" && entry.toolName === "bash",
  );

const program = Effect.gen(function* () {
  const client = yield* RpcClient.make(RpcApi);
  const sql = yield* SqlClient;

  /** Send, and wait for the turn to settle with one more `bash` result than before. */
  const turn = (sessionId: string) =>
    Effect.gen(function* () {
      const id = sessionId as SessionId;
      const before = bashResults(
        yield* client.getSession({ sessionId: id }),
      ).length;
      yield* client.sendMessage({ sessionId: id, content: "publish it" });
      return yield* waitUntil(
        Effect.map(client.getSession({ sessionId: id }), (current) =>
          !current.live.busy && bashResults(current).length > before
            ? current
            : undefined,
        ),
        `session ${sessionId}'s turn to settle`,
      );
    });

  const register = (run: string, name: string, files: Record<string, string>) =>
    Effect.gen(function* () {
      const repo = RepoSlug.make(`verify-repo-policy-${run}/${name}`);
      const localPath = fixtureRepo(`${run}-${name}`, files);
      yield* client.registerRepo({ repo, defaultBaseRef: "main", localPath });
      return { repo, localPath };
    });

  if (PHASE === "arm") {
    const run = Date.now().toString(36);

    // --- gated -------------------------------------------------------------------------------------
    const gated = yield* register(run, "gated", { ".factory/config": GATED });
    const onGated = yield* client.createSession({
      repo: gated.repo,
      title: "verify-repo-policy gated",
    });
    const gatedTurn = yield* turn(onGated.id);
    const gatedApprovals = yield* client.listApprovals({
      sessionId: onGated.id,
    });
    const gatedRecord = yield* recorded(onGated.id);
    const head = execSync("git rev-parse main", {
      cwd: gated.localPath,
      encoding: "utf8",
    }).trim();
    const asked = bashResults(gatedTurn)[0];
    observed.scenarios["gated"] = {
      sessionId: onGated.id,
      approvals: gatedApprovals.approvals,
      bashResult: asked?.text,
      record: gatedRecord,
    };
    assert(
      "gated: the run parks on an approval for bun publish",
      gatedApprovals.approvals.length === 1 &&
        gatedApprovals.approvals[0]?.action === "bun publish" &&
        gatedApprovals.approvals[0]?.detail === COMMAND,
      JSON.stringify(gatedApprovals.approvals.map((a) => a.action)),
    );
    assert(
      "gated: the gated command did not run",
      asked?.isError === true &&
        asked.text.includes("one has been asked for") &&
        !asked.text.includes(MARKER),
      asked?.text.slice(0, 100) ?? "no bash result",
    );
    assert(
      "gated: the log's factory.policy names the base commit, the repo's gate and the effective rules",
      gatedRecord?.source?.ref === "main" &&
        gatedRecord.source.commit === head &&
        gatedRecord.source.path === ".factory/config" &&
        gatedRecord.source.found &&
        JSON.stringify(gatedRecord.repo.approvalRequired) ===
          JSON.stringify(["bun publish"]) &&
        gatedRecord.effective.approvalRequired.includes("bun publish"),
      JSON.stringify(gatedRecord),
    );

    // --- bare --------------------------------------------------------------------------------------
    const bare = yield* register(run, "bare", { "README.md": "no config\n" });
    const onBare = yield* client.createSession({
      repo: bare.repo,
      title: "verify-repo-policy bare",
    });
    const bareTurn = yield* turn(onBare.id);
    const bareApprovals = yield* client.listApprovals({ sessionId: onBare.id });
    const bareRecord = yield* recorded(onBare.id);
    const ran = bashResults(bareTurn)[0];
    observed.scenarios["bare"] = {
      sessionId: onBare.id,
      approvals: bareApprovals.approvals,
      bashResult: ran?.text,
      record: bareRecord,
    };
    assert(
      "bare: a repo without the config gets no approval prompt, and the command runs",
      bareApprovals.approvals.length === 0 &&
        ran?.text.includes(MARKER) === true,
      ran?.text.trim().slice(0, 80) ?? "no bash result",
    );
    assert(
      "bare: the log records a base with no config and no repo gate",
      bareRecord?.source?.found === false &&
        bareRecord.repo.approvalRequired.length === 0,
      JSON.stringify(bareRecord?.source),
    );

    // --- denying -----------------------------------------------------------------------------------
    const denying = yield* register(run, "denying", {
      ".factory/config": JSON.stringify({ policy: { deny: ["bun publish"] } }),
    });
    const onDenying = yield* client.createSession({
      repo: denying.repo,
      title: "verify-repo-policy denying",
    });
    const denyingTurn = yield* turn(onDenying.id);
    const denyingApprovals = yield* client.listApprovals({
      sessionId: onDenying.id,
    });
    const refused = bashResults(denyingTurn)[0];
    observed.scenarios["denying"] = {
      sessionId: onDenying.id,
      approvals: denyingApprovals.approvals,
      bashResult: refused?.text,
    };
    assert(
      "denying: a command the config denies is refused outright, with no approval asked",
      refused?.isError === true &&
        refused.text.includes("bun publish is refused") &&
        !refused.text.includes(MARKER) &&
        denyingApprovals.approvals.length === 0,
      refused?.text.slice(0, 100) ?? "no bash result",
    );

    // --- widening ----------------------------------------------------------------------------------
    const widening = yield* register(run, "widening", {
      ".factory/config": JSON.stringify({
        policy: { allowedHosts: ["github.com", "evil.example"] },
      }),
    });
    const rejected = yield* Effect.flip(
      client.createSession({
        repo: widening.repo,
        title: "verify-repo-policy widening",
      }),
    );
    const rows = yield* sql<{ count: number }>`
      SELECT count(*)::int AS count FROM sessions WHERE repo = ${widening.repo}
    `;
    const code = "code" in rejected ? rejected.code : rejected._tag;
    observed.scenarios["widening"] = {
      error: rejected,
      sessionRows: rows[0]?.count,
    };
    assert(
      "widening: a config allowing a host the deployment denies is rejected at load, typed",
      code === "policy_rejected" &&
        rejected.message.includes(
          "allowedHosts names evil.example, which this deployment does not allow",
        ),
      rejected.message,
    );
    assert(
      "widening: the refused create leaves no session behind",
      rows[0]?.count === 0,
      `${rows[0]?.count} rows`,
    );

    // --- the agent edits .factory/config in its worktree -------------------------------------------
    const worktree = gatedTurn.workspace.path;
    writeFileSync(path.join(worktree, ".factory", "config"), "{}\n");
    git(worktree, "git commit -q -am 'relax the policy'");
    const state: State = {
      run,
      gatedRepo: gated.repo,
      gatedPath: gated.localPath,
      gatedSession: onGated.id,
      worktree,
    };
    mkdirSync(path.dirname(STATE), { recursive: true });
    writeFileSync(STATE, `${JSON.stringify(state, null, 2)}\n`);
    return;
  }

  // --- verify, on a fresh process --------------------------------------------------------------------
  const state = JSON.parse(readFileSync(STATE, "utf8")) as State;
  const branchConfig = execSync("git show HEAD:.factory/config", {
    cwd: state.worktree,
    encoding: "utf8",
  }).trim();
  const reopened = yield* turn(state.gatedSession);
  const reopenedApprovals = yield* client.listApprovals({
    sessionId: state.gatedSession as SessionId,
  });
  const reopenedResult = bashResults(reopened).at(-1);
  // The base relaxes on main after the session opened.
  writeFileSync(path.join(state.gatedPath, ".factory", "config"), "{}\n");
  git(state.gatedPath, "git commit -q -am 'relax on main'");
  const afterBase = yield* turn(state.gatedSession);
  const afterBaseResult = bashResults(afterBase).at(-1);
  const record = yield* recorded(state.gatedSession);
  const fresh = yield* client.createSession({
    repo: RepoSlug.make(state.gatedRepo),
    title: "verify-repo-policy fresh",
  });
  const freshTurn = yield* turn(fresh.id);
  const freshApprovals = yield* client.listApprovals({ sessionId: fresh.id });
  const freshRecord = yield* recorded(fresh.id);
  observed.scenarios["edited"] = {
    sessionId: state.gatedSession,
    branchConfig,
    reopenedResult: reopenedResult?.text,
    afterBaseResult: afterBaseResult?.text,
    approvals: reopenedApprovals.approvals,
    record,
  };
  observed.scenarios["fresh"] = {
    sessionId: fresh.id,
    bashResult: bashResults(freshTurn)[0]?.text,
    approvals: freshApprovals.approvals,
    record: freshRecord,
  };
  assert(
    "edited: the session's branch holds the relaxed config the agent committed",
    branchConfig === "{}",
    branchConfig,
  );
  assert(
    "edited: on a fresh process the run still meets the gate, and the command does not run",
    reopenedResult?.isError === true &&
      !bashResults(reopened).some((result) => result.text.includes(MARKER)) &&
      reopenedApprovals.approvals.length === 1 &&
      reopenedApprovals.approvals[0]?.action === "bun publish",
    reopenedResult?.text.slice(0, 100) ?? "no bash result",
  );
  assert(
    "edited: a base that relaxed under the session does not relax its run either",
    afterBaseResult?.isError === true &&
      !bashResults(afterBase).some((result) => result.text.includes(MARKER)) &&
      JSON.stringify(record?.repo.approvalRequired) ===
        JSON.stringify(["bun publish"]),
    afterBaseResult?.text.slice(0, 100) ?? "no bash result",
  );
  assert(
    "fresh: a new session on the repo reads the base as it is now",
    freshApprovals.approvals.length === 0 &&
      bashResults(freshTurn)[0]?.text.includes(MARKER) === true &&
      freshRecord?.repo.approvalRequired.length === 0,
    bashResults(freshTurn)[0]?.text.trim().slice(0, 80) ?? "no bash result",
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
  path.join(EVIDENCE_DIR, `repo-policy-${PHASE}.json`),
  `${JSON.stringify(observed, null, 2)}\n`,
);
const failed = Object.entries(observed.checks).filter(
  ([, check]) => !check.passed,
);
console.log(
  `\nrepo-policy ${PHASE}: ${Object.keys(observed.checks).length - failed.length}/${Object.keys(observed.checks).length} checks passed — evidence in ${EVIDENCE_DIR}/repo-policy-${PHASE}.json`,
);
if (failed.length > 0) process.exitCode = 1;
