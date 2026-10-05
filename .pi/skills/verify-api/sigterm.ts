// Two phases of one driver, so a single file owns both halves of the SIGTERM story (LOB-21).
//
//   MODE=arm     create a session, hand it a task whose faux tool call sleeps, wait until the
//                session is genuinely busy, write its id to SIGTERM_STATE, and hold the stream open.
//                ./sigterm.sh kills that API while the run is in flight.
//   MODE=verify  read the session the interrupted API left behind: the log must fold, the task must
//                still be there, and a new message must continue the session rather than restart it.
//
// Env: API_URL, MODE, SIGTERM_STATE, EVIDENCE_DIR.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { SessionRpc } from "@repo/domain/Rpc";
import type { SessionId } from "@repo/domain/Session";
import { Effect, Fiber, Stream } from "effect";
import { RpcClient } from "effect/rpc";
import { makeChecker, protocolFor, waitUntil } from "./harness.ts";
import type { CheckRecord } from "./harness.ts";

const API_URL = process.env["API_URL"] ?? "http://localhost:9400";
const MODE = process.env["MODE"] ?? "arm";
const STATE = process.env["SIGTERM_STATE"] ?? ".verify/run/sigterm/session-id";
const EVIDENCE_DIR =
  process.env["EVIDENCE_DIR"] ?? ".verify/evidence/latest/api";

const TASK = "sigterm probe";
const ANSWER = `faux-ok (re: ${TASK})`;

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
  const created = yield* client.createSession({ title: TASK });
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
    "the transcript continued rather than restarted",
    continued.entries.length > before &&
      continued.entries.filter((entry) => entry.kind === "user").length >= 2,
    `${before} entries before, ${continued.entries.length} after`,
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
