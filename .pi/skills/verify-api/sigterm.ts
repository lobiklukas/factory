// Two phases of one driver, so a single file owns both halves of the SIGTERM story (LOB-21).
//
//   MODE=arm     create a session on a repo with a real checkout, commit on its branch and leave an
//                uncommitted edit beside it, hand it a task whose faux tool call sleeps, wait until
//                the session is genuinely busy, write its id to SIGTERM_STATE (and the branch, the
//                commit and the worktree to SIGTERM_STATE.work.json), and hold the stream open.
//                ./sigterm.sh kills that API while the run is in flight.
//   MODE=verify  read the session the interrupted API left behind: the log must fold, the task must
//                still be there, the branch and the worktree must still hold the commit and the edit
//                (LOB-268), and a new message must continue the session rather than restart it,
//                leaving the branch on that commit. (That the next run's tool calls see the commit
//                is `packages/core`'s claim: the faux resumed turn here replies without one.)
//
// Env: API_URL, MODE, SIGTERM_STATE, EVIDENCE_DIR, SIGTERM_CHECKOUT (the checkout the session's
// worktree is cut from), SIGTERM_REPO (the slug it is registered as).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { SessionRpc } from "@repo/domain/Rpc";
import { RepoSlug, type SessionId } from "@repo/domain/Session";
import { Effect, Fiber, Stream } from "effect";
import { RpcClient } from "effect/rpc";
import { makeChecker, protocolFor, waitUntil } from "./harness.ts";
import type { CheckRecord } from "./harness.ts";

const API_URL = process.env["API_URL"] ?? "http://localhost:9400";
const MODE = process.env["MODE"] ?? "arm";
const STATE = process.env["SIGTERM_STATE"] ?? ".verify/run/sigterm/session-id";
const EVIDENCE_DIR =
  process.env["EVIDENCE_DIR"] ?? ".verify/evidence/latest/api";

const CHECKOUT =
  process.env["SIGTERM_CHECKOUT"] ?? ".verify/run/sigterm/checkout";
const REPO = RepoSlug.make(
  process.env["SIGTERM_REPO"] ?? "lobiklukas/factory-sigterm",
);
const WORK = `${STATE}.work.json`;

const TASK = "sigterm probe";
const ANSWER = `faux-ok (re: ${TASK})`;
// Committed on the session's branch before the signal, and an edit left beside it (LOB-268).
const COMMITTED = "SIGTERM.md";
const UNCOMMITTED = "NOTES.md";
const NOTES = "an edit nobody committed";

type Work = {
  readonly branch: string;
  readonly sha: string;
  readonly path: string;
};

/** git in `cwd`, its output trimmed; `undefined` when it fails (a branch that is gone). */
const git = (cwd: string, ...args: string[]): string | undefined => {
  try {
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
};

await mkdir(path.dirname(STATE), { recursive: true });
await mkdir(EVIDENCE_DIR, { recursive: true });

type TranscriptRow = {
  readonly kind: string;
  readonly text: string;
  readonly toolName: string | null;
};

const observed: {
  apiUrl: string;
  mode: string;
  sessionId: SessionId | null;
  transcript: ReadonlyArray<TranscriptRow>;
  checks: Record<string, CheckRecord>;
} = {
  apiUrl: API_URL,
  mode: MODE,
  sessionId: null,
  transcript: [],
  checks: {},
};
const assert = makeChecker(observed);

const ProtocolLive = protocolFor(API_URL);

const transcriptOf = (
  entries: ReadonlyArray<{
    kind: string;
    text: string;
    toolName?: string | undefined;
  }>,
): ReadonlyArray<TranscriptRow> =>
  entries.map((entry) => ({
    kind: entry.kind,
    text: entry.text,
    toolName: entry.toolName ?? null,
  }));

const lastAssistant = (
  entries: ReadonlyArray<{ kind: string; text: string }>,
) => entries.filter((entry) => entry.kind === "assistant").at(-1);

/**
 * Arm: get a run genuinely in flight and leave the session id where the orchestrator can find it.
 *
 * The stream is held open on purpose. When the process is signalled, the stream fails — that is the
 * interruption, not a test failure — so the fiber's exit is swallowed and the phase ends normally.
 */
const arm = Effect.gen(function* () {
  const client = yield* RpcClient.make(SessionRpc);
  yield* client.registerRepo({ repo: REPO, localPath: CHECKOUT });
  const created = yield* client.createSession({
    title: TASK,
    repo: REPO,
    baseRef: "main",
  });
  // The run's work, made before the signal: a commit on the session's branch and an edit beside it.
  const workspace = (yield* client.getSession({ sessionId: created.id }))
    .workspace;
  yield* Effect.promise(async () => {
    await writeFile(path.join(workspace.path, COMMITTED), "faux-ok\n");
    git(workspace.path, "add", COMMITTED);
    git(
      workspace.path,
      "-c",
      "user.email=sigterm@localhost",
      "-c",
      "user.name=sigterm",
      "commit",
      "-q",
      "-m",
      "work made before the signal",
    );
    await writeFile(path.join(workspace.path, UNCOMMITTED), `${NOTES}\n`);
  });
  const work: Work = {
    branch: workspace.branch ?? "",
    sha: git(workspace.path, "rev-parse", "HEAD") ?? "",
    path: workspace.path,
  };
  assert(
    "the session's worktree is cut on its own branch, with a commit on it",
    work.branch === `factory/${created.id}` &&
      work.sha !== "" &&
      git(CHECKOUT, "rev-parse", "--verify", "--quiet", work.branch) ===
        work.sha,
    `branch=${work.branch} sha=${work.sha}`,
  );
  yield* Effect.promise(() => writeFile(WORK, JSON.stringify(work)));
  const watcher = yield* client
    .watchSession({ sessionId: created.id })
    .pipe(Stream.runDrain, Effect.forkChild);

  yield* client.sendMessage({ sessionId: created.id, content: TASK });
  const busy = yield* waitUntil(
    client
      .getSession({ sessionId: created.id })
      .pipe(Effect.map((snapshot) => snapshot.live.busy)),
    "the run to be in flight",
  );
  assert(
    "the run is in flight when the process is signalled",
    busy === true,
    `session=${created.id} busy=${busy}`,
  );

  yield* Effect.promise(() => writeFile(STATE, created.id));
  console.log(`armed ${created.id}: busy — SIGTERM is safe now`);

  yield* Fiber.join(watcher).pipe(Effect.exit);
  console.log("the stream ended: the process under test is gone");
  return created.id;
});

/**
 * Verify: what the interrupted API left behind, read by a fresh one.
 *
 * The fold is the first claim: no process owns the session, so the reader-mode storage has to
 * rebuild the transcript from the log. The second is that the log is *resumable* — the same session
 * accepts another message and answers, with the earlier turn still in its transcript.
 */
const verify = Effect.gen(function* () {
  const client = yield* RpcClient.make(SessionRpc);
  // The id came from the server that minted it; a driver reading it back out of a file has to say
  // so rather than re-parse the pattern.
  const sessionId = (yield* Effect.promise(() =>
    readFile(STATE, "utf8"),
  )).trim() as SessionId;
  observed.sessionId = sessionId;

  const reopened = yield* client.getSession({ sessionId });
  observed.transcript = transcriptOf(reopened.entries);
  assert(
    "the interrupted session reads back from its log",
    reopened.session.mode === "historical" &&
      reopened.session.status === "idle",
    `mode=${reopened.session.mode} status=${reopened.session.status}`,
  );
  assert(
    "the worktree survived the interruption (reused or recreated)",
    existsSync(reopened.workspace.path),
    `path=${reopened.workspace.path} exists=${existsSync(reopened.workspace.path)}`,
  );
  // LOB-268: the shutdown released the harness and nothing else, so the branch and the worktree
  // are the ones the run left — not a fresh branch cut at the base on this read.
  const work = JSON.parse(readFileSync(WORK, "utf8")) as Work;
  assert(
    "the branch still names the commit made before the signal",
    reopened.workspace.branch === work.branch &&
      git(CHECKOUT, "rev-parse", "--verify", "--quiet", work.branch) ===
        work.sha,
    `branch=${reopened.workspace.branch} sha=${git(CHECKOUT, "rev-parse", "--verify", "--quiet", work.branch) ?? "gone"} expected=${work.sha}`,
  );
  assert(
    "the worktree is the same one, on that commit, with the uncommitted edit",
    reopened.workspace.path === work.path &&
      git(work.path, "rev-parse", "HEAD") === work.sha &&
      existsSync(path.join(work.path, UNCOMMITTED)) &&
      readFileSync(path.join(work.path, UNCOMMITTED), "utf8").trim() === NOTES,
    `path=${reopened.workspace.path} head=${git(work.path, "rev-parse", "HEAD") ?? "none"}`,
  );
  assert(
    "the workspace reads as the session's still, not released",
    reopened.workspace.released === undefined,
    `released=${JSON.stringify(reopened.workspace.released ?? null)}`,
  );
  assert(
    "the task the run was given survived the interruption",
    reopened.entries.some(
      (entry) => entry.kind === "user" && entry.text === TASK,
    ),
    `${reopened.entries.length} entries: ${reopened.entries.map((entry) => entry.kind).join(", ")}`,
  );

  const before = reopened.entries.length;
  const sent = yield* client.sendMessage({ sessionId, content: TASK });
  assert(
    "the session accepts a new message after the restart",
    sent.placement === "run",
    `placement=${sent.placement} submission=${sent.submissionId}`,
  );

  yield* waitUntil(
    client
      .getSession({ sessionId })
      .pipe(Effect.map((snapshot) => !snapshot.live.busy)),
    "the resumed turn to settle",
  );

  const continued = yield* client.getSession({ sessionId });
  observed.transcript = transcriptOf(continued.entries);
  assert(
    "the resumed run answers",
    lastAssistant(continued.entries)?.text === ANSWER,
    `last=${JSON.stringify(lastAssistant(continued.entries)?.text)}`,
  );
  assert(
    "the branch still names the commit after the resumed run",
    git(CHECKOUT, "rev-parse", "--verify", "--quiet", work.branch) === work.sha,
    `sha=${git(CHECKOUT, "rev-parse", "--verify", "--quiet", work.branch) ?? "gone"}`,
  );
  assert(
    "the transcript continued rather than restarted",
    continued.entries.length > before &&
      continued.entries.filter((entry) => entry.kind === "user").length >= 2,
    `${before} entries before, ${continued.entries.length} after`,
  );

  // The one way the work goes (LOB-268): a terminal event — here an operator's discard — and only
  // once. The transcript stays readable; the session takes no new run.
  const discarded = yield* client.discardSession({ sessionId });
  assert(
    "a discard tears the worktree and the branch down",
    discarded.first &&
      discarded.release.reason === "discarded" &&
      !existsSync(work.path) &&
      git(CHECKOUT, "rev-parse", "--verify", "--quiet", work.branch) ===
        undefined,
    `first=${discarded.first} worktree=${existsSync(work.path)} branch=${git(CHECKOUT, "rev-parse", "--verify", "--quiet", work.branch) ?? "gone"}`,
  );
  const again = yield* client.discardSession({ sessionId });
  assert(
    "a second discard is a no-op that names the first",
    !again.first && again.release.at === discarded.release.at,
    `first=${again.first} at=${again.release.at}`,
  );
  const afterDiscard = yield* client.getSession({ sessionId });
  const refused = yield* client.sendMessage({ sessionId, content: TASK }).pipe(
    Effect.flip,
    Effect.orElseSucceed(() => undefined),
  );
  assert(
    "the discarded session reads back, cuts no worktree, and refuses a run",
    afterDiscard.workspace.released?.reason === "discarded" &&
      !existsSync(work.path) &&
      refused?._tag === "SessionError" &&
      refused.code === "invalid_input",
    `released=${afterDiscard.workspace.released?.reason ?? "no"} worktree=${existsSync(work.path)} refused=${refused?._tag === "SessionError" ? refused.code : "no"}`,
  );

  return sessionId;
});

const phase = MODE === "arm" ? arm : verify;
let sessionId: SessionId | null = null;
try {
  sessionId = await Effect.runPromise(
    phase.pipe(Effect.provide(ProtocolLive), Effect.scoped),
  );
} catch (error) {
  assert(`${MODE} phase completed`, false, `threw: ${String(error)}`);
}

observed.sessionId = sessionId ?? observed.sessionId;
// One file per phase: the arm phase's evidence (a run in flight, with its transcript) is as much a
// fact as the verify phase's, and a shared name would overwrite it.
await writeFile(
  path.join(EVIDENCE_DIR, `sigterm-${MODE}.json`),
  `${JSON.stringify(observed, null, 2)}\n`,
);
await writeFile(
  path.join(EVIDENCE_DIR, `sigterm-${MODE}-transcript.txt`),
  `${observed.transcript
    .map(
      (entry) =>
        `${entry.kind}: ${entry.text}${entry.toolName ? ` (${entry.toolName})` : ""}`,
    )
    .join("\n")}\n`,
);

const failed = Object.entries(observed.checks).filter(
  ([, check]) => !check.passed,
);
if (failed.length > 0) {
  console.error(`\n${failed.length} required check(s) failed (${MODE})`);
  process.exitCode = 1;
}
