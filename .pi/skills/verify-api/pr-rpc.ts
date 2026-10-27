// The PR step over the wire (LOB-213), driven with the real Effect RPC client.
//
//   bun pr-rpc.ts      (via ./pr-rpc.sh, which owns the API instance and the fake GitHub this drives)
//
// Until LOB-213 no client could open a session's PR: `SessionRpc` had no member for the step and the
// API no handler, so `sessions.pr_url` was written only by tests and in-process scripts. This driver
// is a client, exactly as the CLI and the dashboard are — `RpcClient.make(SessionRpc)` over NDJSON —
// and the API it talks to reaches a loopback GitHub fake through `GITHUB_API_URL`:
//
//   opened     a session bound to a repo; `openPullRequest` answers `outcome: "opened"` with the
//              fake's page link, and `getSession` and `listSessions` read the same link back
//   repeat     the same call again answers the same PR tagged `already-open` (the shell counts the
//              fake's ledger: one request for the two calls)
//   refusals   a session bound to no repo is a typed `SessionError{invalid_input}`, an unknown one
//              `SessionError{not_found}` — tagged errors across the wire, not a defect
//
// Env: API_URL, EVIDENCE_DIR, PR_RPC_REPO (the slug the session binds to; the shell mints one per run).
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { SessionRpc } from "@repo/domain/Rpc";
import type {
  CredentialError,
  PrError,
  PullRequestStep,
} from "@repo/domain/PullRequest";
import { RepoSlug, SessionId, type SessionError } from "@repo/domain/Session";
import { Effect } from "effect";
import { RpcClient } from "effect/rpc";
import type { RpcClientError } from "effect/rpc/RpcClientError";
import { makeChecker, protocolFor } from "./harness.ts";
import type { CheckRecord } from "./harness.ts";

const API_URL = process.env["API_URL"] ?? "http://localhost:9420";
const EVIDENCE_DIR =
  process.env["EVIDENCE_DIR"] ?? ".verify/evidence/latest/api";
const REPO = RepoSlug.make(
  process.env["PR_RPC_REPO"] ?? `lobiklukas/factory-pr-rpc-${Date.now()}`,
);
const TASK = "pr-rpc probe";

await mkdir(EVIDENCE_DIR, { recursive: true });

const observed: {
  apiUrl: string;
  repo: string;
  sessionId: SessionId | null;
  opened: PullRequestStep | null;
  repeated: PullRequestStep | null;
  refusals: Record<string, unknown>;
  checks: Record<string, CheckRecord>;
} = {
  apiUrl: API_URL,
  repo: REPO,
  sessionId: null,
  opened: null,
  repeated: null,
  refusals: {},
  checks: {},
};
const assert = makeChecker(observed);

/** The link an answer carries, or nothing for an answer that opened no PR. */
const linkOf = (answer: PullRequestStep) =>
  answer.outcome === "opened" || answer.outcome === "already-open"
    ? answer
    : undefined;

/** A refusal as the client decoded it: a `SessionError` with its code, or what arrived instead. */
const refusalOf = (
  error: SessionError | PrError | CredentialError | RpcClientError,
): { readonly _tag: string; readonly code?: string } =>
  error._tag === "SessionError"
    ? { _tag: error._tag, code: error.code }
    : { _tag: error._tag };

const program = Effect.gen(function* () {
  const client = yield* RpcClient.make(SessionRpc);

  // --- opened: the first call goes to the forge ----------------------------------------------------
  const created = yield* client.createSession({
    repo: REPO,
    baseRef: "main",
    title: TASK,
  });
  observed.sessionId = created.id;
  const asked = {
    sessionId: created.id,
    title: `factory: ${TASK}`,
    head: `factory/${created.id}`,
    base: "main",
  };
  const opened = yield* client.openPullRequest(asked);
  observed.opened = opened;
  const first = linkOf(opened);
  assert(
    "openPullRequest answers over RPC, tagged opened (LOB-213)",
    opened.outcome === "opened",
    `answer=${JSON.stringify(opened)}`,
  );
  assert(
    "and the link is the fake GitHub's page for the session's repo",
    first !== undefined &&
      first.number > 0 &&
      first.url === `https://github.com/${REPO}/pull/${first.number}`,
    `url=${first?.url ?? "none"}`,
  );

  const snapshot = yield* client.getSession({ sessionId: created.id });
  assert(
    "getSession reads the link the RPC caller wrote",
    first !== undefined && snapshot.session.prUrl === first.url,
    `prUrl=${String(snapshot.session.prUrl)}`,
  );
  const listed = yield* client.listSessions({ limit: 50 });
  const row = listed.sessions.find((entry) => entry.id === created.id);
  assert(
    "and listSessions reads it from the index",
    first !== undefined && row?.prUrl === first.url,
    `listed prUrl=${String(row?.prUrl)}`,
  );

  // --- repeat: the log answers, the forge is not asked ----------------------------------------------
  const repeated = yield* client.openPullRequest(asked);
  observed.repeated = repeated;
  const second = linkOf(repeated);
  assert(
    "a repeat answers the same PR, tagged already-open (LOB-212)",
    repeated.outcome === "already-open" &&
      first !== undefined &&
      second?.number === first.number &&
      second.url === first.url,
    `answer=${JSON.stringify(repeated)}`,
  );

  // --- refusals: typed errors across the wire ----------------------------------------------------------
  const unbound = yield* client.createSession({ title: `${TASK} (no repo)` });
  const noRepo = yield* client
    .openPullRequest({ ...asked, sessionId: unbound.id })
    .pipe(Effect.flip, Effect.map(refusalOf));
  observed.refusals["noRepo"] = noRepo;
  assert(
    "a session bound to no repo is refused as SessionError{invalid_input}",
    noRepo._tag === "SessionError" && noRepo.code === "invalid_input",
    JSON.stringify(noRepo),
  );
  const unknown = yield* client
    .openPullRequest({
      ...asked,
      sessionId: SessionId.make("ses_00000000000000000000000000"),
    })
    .pipe(Effect.flip, Effect.map(refusalOf));
  observed.refusals["unknown"] = unknown;
  assert(
    "an unknown session is refused as SessionError{not_found}",
    unknown._tag === "SessionError" && unknown.code === "not_found",
    JSON.stringify(unknown),
  );
});

try {
  await Effect.runPromise(
    program.pipe(Effect.provide(protocolFor(API_URL)), Effect.scoped),
  );
} catch (error) {
  assert("the drive completed", false, `threw: ${String(error)}`);
}

await writeFile(
  path.join(EVIDENCE_DIR, "pr-rpc.json"),
  `${JSON.stringify(observed, null, 2)}\n`,
);
await writeFile(
  path.join(EVIDENCE_DIR, "pr-rpc-session.env"),
  `SESSION=${observed.sessionId ?? ""}\nREPO=${REPO}\n`,
);

const failed = Object.entries(observed.checks).filter(
  ([, check]) => !check.passed,
);
if (failed.length > 0) {
  console.error(`\n${failed.length} required check(s) failed`);
  process.exitCode = 1;
}
