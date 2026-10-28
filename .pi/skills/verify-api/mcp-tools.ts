// MCP tools for the agent, allowlisted per repo and policed by the approval hook, over the real API
// (S-agent-mcp-tools).
//
//   bun mcp-tools.ts      (via ./mcp-tools.sh, which boots the API with MCP_SERVERS and FAUX_MCP_CALLS)
//
// The deployment registers two servers, `tracker` (its token from the repo secret
// TRACKER_MCP_TOKEN) and `rogue`, both served by one fake on loopback. The fixture repo's
// `.factory/config` allows the tracker's `get_issue` and `update_issue` and nothing of `rogue`. The
// faux run, on every turn, runs `bash` (does its shell hold the token?), then calls
// `mcp__tracker__get_issue`, `mcp__tracker__update_issue` and `mcp__rogue__get_issue`.
//
//   read      get_issue runs unattended: the call and the fake's answer are in the transcript, and the
//             fake saw it with `Authorization: Bearer <the secret>`; the shell never held the token.
//   write     update_issue is blocked on an approval naming `tracker/update_issue (MCP)`, and the fake
//             saw no call. A person denies it; the next turn's call is refused as denied by them, and
//             the fake still saw none.
//   rogue     the tool of the server the repo does not allow is not offered: the call is the harness's
//             unknown-tool error, and the fake saw no request on /rogue at all — not even initialize.
//   record    the log's factory.policy names the repo's allowlist and the two tools the open offered.
//
// Env: API_URL, DATABASE_URL (to read the session log), MCP_FAKE_PORT, MCP_TOOLS_REPOS,
// MCP_TOOLS_TOKEN, EVIDENCE_DIR.
import { execSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { RpcApi } from "@repo/domain/Rpc";
import { RepoSlug, type SessionSnapshot } from "@repo/domain/Session";
import { readPolicyRecord } from "@repo/harness";
import { startFakeMcpServer } from "@repo/harness/mcpFake";
import { DatabaseLive, PostgresStorage } from "@repo/storage-postgres";
import { Effect, Exit, Layer, Redacted } from "effect";
import { RpcClient } from "effect/rpc";
import { SqlClient } from "effect/sql/SqlClient";
import {
  makeChecker,
  protocolFor,
  recordedActor,
  waitUntil,
} from "./harness.ts";
import type { CheckRecord } from "./harness.ts";

const API_URL = process.env["API_URL"] ?? "http://localhost:9446";
const FAKE_PORT = Number(process.env["MCP_FAKE_PORT"] ?? "9447");
const REPOS = path.resolve(
  process.env["MCP_TOOLS_REPOS"] ?? ".verify/run/mcp-tools/repos",
);
const EVIDENCE_DIR = path.resolve(
  process.env["EVIDENCE_DIR"] ?? ".verify/evidence/latest/api",
);
const TOKEN = process.env["MCP_TOOLS_TOKEN"] ?? "";
const READ = "mcp__tracker__get_issue";
const WRITE = "mcp__tracker__update_issue";
const ROGUE = "mcp__rogue__get_issue";
const ANSWER = "ISS-7: the login page answers 500 since the last deploy";

const observed: {
  apiUrl: string;
  scenarios: Record<string, unknown>;
  checks: Record<string, CheckRecord>;
} = { apiUrl: API_URL, scenarios: {}, checks: {} };
const assert = makeChecker(observed);

const git = (cwd: string, command: string) =>
  execSync(command, { cwd, stdio: "ignore" });

const fixtureRepo = (name: string, files: Record<string, string>): string => {
  const root = path.join(REPOS, name);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  git(root, "git init -q -b main");
  git(root, "git config user.email verify-mcp-tools@localhost");
  git(root, "git config user.name verify-mcp-tools");
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), content);
  }
  git(root, "git add -A");
  git(root, "git commit -q -m base");
  return root;
};

const results = (snapshot: SessionSnapshot, tool: string) =>
  snapshot.entries.filter(
    (entry) => entry.kind === "toolResult" && entry.toolName === tool,
  );

const called = (snapshot: SessionSnapshot, tool: string) =>
  snapshot.entries.some(
    (entry) =>
      entry.kind === "assistant" &&
      entry.toolCalls.some((call) => call.name === tool),
  );

const fake = await startFakeMcpServer({
  port: FAKE_PORT,
  servers: {
    tracker: [
      {
        name: "get_issue",
        description: "Read one issue.",
        readOnly: true,
        inputSchema: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
        answer: () => ANSWER,
      },
      {
        name: "update_issue",
        description: "Change an issue's state.",
        inputSchema: {
          type: "object",
          properties: { id: { type: "string" }, state: { type: "string" } },
          required: ["id", "state"],
        },
        answer: (args) =>
          `${String(args["id"])} is now ${String(args["state"])}`,
      },
      { name: "delete_issue", description: "Delete an issue." },
    ],
    rogue: [{ name: "get_issue", readOnly: true }],
  },
});

const program = Effect.gen(function* () {
  const client = yield* RpcClient.make(RpcApi);
  const sql = yield* SqlClient;

  /** Send, and wait for the turn to settle with one more result of the last scripted call. */
  const turn = (sessionId: SessionSnapshot["id"], content: string) =>
    Effect.gen(function* () {
      const before = results(
        yield* client.getSession({ sessionId }),
        ROGUE,
      ).length;
      yield* client.sendMessage({ sessionId, content });
      return yield* waitUntil(
        Effect.map(client.getSession({ sessionId }), (current) =>
          !current.live.busy && results(current, ROGUE).length > before
            ? current
            : undefined,
        ),
        `session ${sessionId}'s turn to settle`,
      );
    });

  const run = Date.now().toString(36);
  const repo = RepoSlug.make(`verify-mcp-tools-${run}/app`);
  yield* client.registerRepo({
    repo,
    defaultBaseRef: "main",
    localPath: fixtureRepo(`${run}-app`, {
      ".factory/config": JSON.stringify({
        policy: {
          mcp: { tracker: { tools: ["get_issue", "update_issue"] } },
        },
      }),
    }),
  });
  yield* client.setSecret({
    repo,
    name: "TRACKER_MCP_TOKEN",
    value: Redacted.make(TOKEN),
  });
  const session = yield* client.createSession({
    repo,
    title: "verify-mcp-tools",
  });

  // --- the first turn ----------------------------------------------------------------------------
  const first = yield* turn(session.id, "triage ISS-7");
  const read = results(first, READ)[0];
  const write = results(first, WRITE)[0];
  const rogue = results(first, ROGUE)[0];
  const shell = results(first, "bash")[0];
  const approvals = yield* client.listApprovals({ sessionId: session.id });
  const afterFirst = {
    calls: [...fake.calls],
    requests: [...fake.requests],
  };
  observed.scenarios["first"] = {
    sessionId: session.id,
    read,
    write,
    rogue,
    shell,
    approvals: approvals.approvals,
    fake: afterFirst,
  };

  assert(
    "read: the allowed read tool's call and its answer are in the transcript",
    called(first, READ) && read?.isError === false && read.text === ANSWER,
    read?.text.slice(0, 100) ?? "no result",
  );
  assert(
    "read: it ran unattended, and the server got it with the repo secret as the bearer token",
    afterFirst.calls.filter((call) => call.tool === "get_issue").length === 1 &&
      afterFirst.calls[0]?.path === "/tracker" &&
      afterFirst.calls[0]?.authorization === `Bearer ${TOKEN}` &&
      JSON.stringify(afterFirst.calls[0]?.arguments) ===
        JSON.stringify({ id: "ISS-7" }),
    JSON.stringify(afterFirst.calls.map((call) => [call.path, call.tool])),
  );
  assert(
    "read: the token never reached the agent's shell",
    shell?.text.includes("no-mcp-token-in-shell") === true &&
      !first.entries.some((entry) => entry.text.includes(TOKEN)),
    shell?.text.trim().slice(0, 80) ?? "no bash result",
  );
  const pending = approvals.approvals.find(
    (approval) => approval.action === "tracker/update_issue (MCP)",
  );
  assert(
    "write: the write tool raises an approval, and did not run",
    called(first, WRITE) &&
      write?.isError === true &&
      write.text.includes("one has been asked for") &&
      pending !== undefined &&
      pending.detail.includes(WRITE) &&
      !afterFirst.calls.some((call) => call.tool === "update_issue"),
    `${write?.text.slice(0, 100) ?? "no result"} | approvals: ${JSON.stringify(approvals.approvals.map((a) => a.action))}`,
  );
  assert(
    "rogue: a server the repo does not allow is not offered, and never contacted",
    called(first, ROGUE) &&
      rogue?.isError === true &&
      !rogue.text.includes(ANSWER) &&
      !afterFirst.requests.some((request) => request.path === "/rogue"),
    `${rogue?.text.slice(0, 100) ?? "no result"} | /rogue requests: ${afterFirst.requests.filter((request) => request.path === "/rogue").length}`,
  );

  // --- a person denies the write; the next turn tries it again -------------------------------------
  if (pending !== undefined) {
    yield* client.decideApproval({
      sessionId: session.id,
      requestId: pending.requestId,
      decision: "denied",
      actor: "verify-mcp-tools-reviewer",
    });
  }
  const second = yield* turn(session.id, "go on");
  const denied = results(second, WRITE).at(-1);
  const deniedBy = recordedActor("verify-mcp-tools-reviewer");
  observed.scenarios["second"] = {
    denied,
    fake: { calls: [...fake.calls], requests: [...fake.requests] },
  };
  assert(
    "write: a denial reaches the agent as the blocked call's result, and the server never sees the write",
    results(second, WRITE).length === 2 &&
      denied?.isError === true &&
      denied.text.includes(
        `\`tracker/update_issue (MCP)\` was denied by ${deniedBy}`,
      ) &&
      !fake.calls.some((call) => call.tool === "update_issue"),
    denied?.text.slice(0, 140) ?? "no result",
  );

  // --- the record ----------------------------------------------------------------------------------
  const record = yield* Effect.acquireUseRelease(
    Effect.promise(() => PostgresStorage.reader(sql, session.id)),
    readPolicyRecord,
    (storage) => Effect.promise(() => storage.dispose()),
  );
  observed.scenarios["record"] = record;
  assert(
    "record: the log names the repo's MCP allowlist and the tools the open offered",
    JSON.stringify(record?.repo.mcp) ===
      JSON.stringify({
        tracker: {
          tools: ["get_issue", "update_issue"],
          approvalRequired: [],
        },
      }) &&
      JSON.stringify(
        record?.effective.mcpTools?.map((tool) => [tool.name, tool.gated]),
      ) ===
        JSON.stringify([
          [READ, false],
          [WRITE, true],
        ]),
    JSON.stringify(record?.effective.mcpTools),
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
await fake.close();

await mkdir(EVIDENCE_DIR, { recursive: true });
await writeFile(
  path.join(EVIDENCE_DIR, "mcp-tools.json"),
  `${JSON.stringify(observed, null, 2)}\n`,
);
const failed = Object.entries(observed.checks).filter(
  ([, check]) => !check.passed,
);
console.log(
  `\nmcp-tools: ${Object.keys(observed.checks).length - failed.length}/${Object.keys(observed.checks).length} checks passed — evidence in ${EVIDENCE_DIR}/mcp-tools.json`,
);
if (failed.length > 0) process.exitCode = 1;
