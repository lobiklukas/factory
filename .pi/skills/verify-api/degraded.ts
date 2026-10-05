// Two phases of the degraded-readiness proof (LOB-21), driven by ./degraded.sh, which stops and
// starts Postgres around them.
//
//   MODE=down  Postgres is stopped. `/livez` must still answer 200 — a liveness probe that failed
//              on a database outage would have Kubernetes restart a healthy pod and turn the
//              outage into a crash loop — `/readyz` must answer 503 naming the failing check, and
//              a session request must fail with a typed `SessionError` rather than a dropped
//              connection or a 500.
//   MODE=up    Postgres is back. `/readyz` must answer 200 *without the process being restarted*,
//              and a session request must work again.
//
// Env: API_URL, MODE, EVIDENCE_DIR.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { SessionRpc } from "@repo/domain/Rpc";
import { Effect, Exit } from "effect";
import { RpcClient } from "effect/rpc";
import { makeChecker, protocolFor } from "./harness.ts";
import type { CheckRecord } from "./harness.ts";

const API_URL = process.env["API_URL"] ?? "http://localhost:9500";
const MODE = process.env["MODE"] ?? "down";
const EVIDENCE_DIR =
  process.env["EVIDENCE_DIR"] ?? ".verify/evidence/latest/api";

await mkdir(EVIDENCE_DIR, { recursive: true });

const observed: {
  apiUrl: string;
  mode: string;
  probes: Record<string, unknown>;
  error: unknown;
  checks: Record<string, CheckRecord>;
} = { apiUrl: API_URL, mode: MODE, probes: {}, error: null, checks: {} };
const assert = makeChecker(observed);

const ProtocolLive = protocolFor(API_URL);

const probe = async (route: string) => {
  const response = await fetch(`${API_URL}${route}`);
  return {
    status: response.status,
    body: await response.json().catch(() => null),
  };
};

/**
 * The failure an `Exit` carries, narrowed by inspection: `SessionError` has a `code`, an
 * `RpcClientError` (a connection that never reached the control plane) does not, and the difference
 * is exactly what these checks are about.
 */
const describeFailure = (exit: Exit.Exit<unknown, unknown>) => {
  const failure = Exit.findErrorOption(exit);
  if (failure._tag === "None") return null;
  const error: unknown = failure.value;
  if (typeof error !== "object" || error === null) {
    return { _tag: "unknown", message: String(error) };
  }
  const tag =
    "_tag" in error && typeof error._tag === "string" ? error._tag : "unknown";
  const message =
    "message" in error && typeof error.message === "string"
      ? error.message
      : String(error);
  return "code" in error && typeof error.code === "string"
    ? { _tag: tag, code: error.code, message }
    : { _tag: tag, message };
};

/** One `createSession`, as an Exit, so a typed failure can be read instead of thrown. */
const attemptCreate = Effect.gen(function* () {
  const client = yield* RpcClient.make(SessionRpc);
  return yield* Effect.exit(
    client.createSession({ title: `degraded ${MODE}` }),
  );
}).pipe(Effect.provide(ProtocolLive), Effect.scoped);

if (MODE === "down") {
  const livez = await probe("/livez");
  assert(
    "livez stays 200 while the database is down",
    livez.status === 200 && livez.body?.status === "ok",
    `status=${livez.status} body=${JSON.stringify(livez.body)}`,
  );

  const readyz = await probe("/readyz");
  const failing = (readyz.body?.checks ?? [])
    .filter((check: { ok: boolean; name: string }) => !check.ok)
    .map((check: { ok: boolean; name: string }) => check.name);
  assert(
    "readyz reports 503 while the database is down",
    readyz.status === 503,
    `status=${readyz.status}`,
  );
  assert(
    "and names the check that failed",
    readyz.body?.status === "unavailable" && failing.includes("postgres"),
    `failing=${JSON.stringify(failing)} body=${JSON.stringify(readyz.body)}`,
  );

  const attempt = await Effect.runPromise(attemptCreate);
  const failure = describeFailure(attempt);
  observed.error = failure;
  assert(
    "a session request fails with a typed SessionError, not a crash",
    Exit.isFailure(attempt) &&
      failure !== null &&
      failure._tag === "SessionError" &&
      failure.code === "storage",
    JSON.stringify(failure),
  );

  observed.probes = { livez: livez.body, readyz: readyz.body };
} else {
  // Postgres was started by the orchestrator a moment ago; the pool has to reconnect on its own.
  let readyz = await probe("/readyz");
  for (let attempt = 0; attempt < 100 && readyz.status !== 200; attempt += 1) {
    await Bun.sleep(500);
    readyz = await probe("/readyz");
  }
  assert(
    "readyz recovers to 200 without a restart",
    readyz.status === 200 && readyz.body?.status === "ok",
    `status=${readyz.status} body=${JSON.stringify(readyz.body)}`,
  );

  const attempt = await Effect.runPromise(attemptCreate);
  const failure = describeFailure(attempt);
  observed.error = failure;
  assert(
    "a session request works again",
    Exit.isSuccess(attempt),
    `exit=${Exit.isSuccess(attempt) ? "success" : JSON.stringify(failure)}`,
  );

  observed.probes = { readyz: readyz.body };
}

await writeFile(
  path.join(EVIDENCE_DIR, `degraded-${MODE}.json`),
  `${JSON.stringify(observed, null, 2)}\n`,
);

const failed = Object.entries(observed.checks).filter(
  ([, check]) => !check.passed,
);
if (failed.length > 0) {
  console.error(`\n${failed.length} required check(s) failed (${MODE})`);
  process.exitCode = 1;
}
