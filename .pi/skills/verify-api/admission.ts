// Admission control over the wire (LOB-70): a concurrency cap with a typed refusal.
//
//   bun admission.ts      (via ./admission.sh, which owns the API instance this drives)
//
// The API this talks to runs with SESSION_MAX_CONCURRENT=$CAP, a short SESSION_IDLE_TIMEOUT_MS, and a
// signed generic trigger route whose rule maps the `factory` label to a repo this drive registers.
// Every RPC check reads through the same client the CLI and the dashboard build:
//
//   fill       $CAP concurrent createSession calls all succeed: the N-th concurrent create is admitted
//   refuse     the N+1th createSession fails as SessionError{code: "at_capacity"}, its message naming
//              the cap and SESSION_MAX_CONCURRENT — a code a client branches on, not prose
//   webhook    a signed generic delivery that would open a session is answered 503 at-capacity with
//              Retry-After, never a 500
//   release    nothing touches the sessions, so the idle sweep releases their owners; the refused
//              create, retried with the same requestId, then succeeds live (its refusal left no row to
//              dedupe on), at least one retry before that was refused and every one was the same
//              typed refusal, and the sessions that filled the cap are historical (the sweep freed it)
//   redeliver  the same generic delivery, sent again, is processed and opens its session
//
// CAP is at least 2: the retried create takes one slot, and the redelivery needs another.
//
// Env: API_URL, EVIDENCE_DIR, CAP, IDLE_TIMEOUT_MS, TRIGGER_SECRET, ADMISSION_REPO, ADMISSION_CHECKOUT.
import { createHmac, randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { SessionRpc } from "@repo/domain/Rpc";
import { RepoSlug, SessionId, type SessionSummary } from "@repo/domain/Session";
import { Effect, Exit } from "effect";
import { RpcClient } from "effect/rpc";
import { makeChecker, protocolFor } from "./harness.ts";
import type { CheckRecord } from "./harness.ts";

const API_URL = process.env["API_URL"] ?? "http://localhost:9432";
const EVIDENCE_DIR =
  process.env["EVIDENCE_DIR"] ?? ".verify/evidence/latest/api";
const CAP = Number(process.env["CAP"] ?? "2");
const IDLE_TIMEOUT_MS = Number(process.env["IDLE_TIMEOUT_MS"] ?? "3000");
const TRIGGER_SECRET = process.env["TRIGGER_SECRET"] ?? "";
const REPO = RepoSlug.make(
  process.env["ADMISSION_REPO"] ?? "acme/verify-admission",
);
const CHECKOUT = process.env["ADMISSION_CHECKOUT"] ?? "";
/** Per run, so a database an earlier run wrote to cannot answer this run's requests as replays. */
const RUN = randomBytes(4).toString("hex");

await mkdir(EVIDENCE_DIR, { recursive: true });

const observed: {
  apiUrl: string;
  cap: number;
  admitted: Array<string>;
  refusal: {
    code?: string | undefined;
    message?: string | undefined;
    tag?: string | undefined;
  };
  webhook: Array<{ status: number; retryAfter: string | null; body: unknown }>;
  retries: Array<string>;
  afterRelease?: string | undefined;
  filledModes?: Array<string> | undefined;
  checks: Record<string, CheckRecord>;
} = {
  apiUrl: API_URL,
  cap: CAP,
  admitted: [],
  refusal: {},
  webhook: [],
  retries: [],
  checks: {},
};
const assert = makeChecker(observed);

/** The typed refusal a failed call crossed the wire with, or `undefined` when it succeeded. */
const refusalOf = (
  exit: Exit.Exit<unknown, unknown>,
):
  | {
      tag?: string | undefined;
      code?: string | undefined;
      message?: string | undefined;
    }
  | undefined => {
  if (Exit.isSuccess(exit)) return undefined;
  const failure = Exit.findErrorOption(exit);
  if (failure._tag !== "Some") return { tag: "defect" };
  const error = failure.value as {
    readonly _tag?: string;
    readonly code?: string;
    readonly message?: string;
  };
  return { tag: error._tag, code: error.code, message: error.message };
};

/** One signed generic delivery: the body, its HMAC, and the route's answer. */
const deliver = async (requestId: string) => {
  const raw = JSON.stringify({
    requestId,
    label: "factory",
    title: "a delivery that needs a session",
    body: "opened once the server has room",
  });
  const response = await fetch(`${API_URL}/webhooks/generic`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-trigger-signature": createHmac("sha256", TRIGGER_SECRET)
        .update(raw)
        .digest("hex"),
    },
    body: raw,
  });
  const answer = {
    status: response.status,
    retryAfter: response.headers.get("retry-after"),
    body: (await response.json().catch(() => null)) as Record<
      string,
      unknown
    > | null,
  };
  observed.webhook.push(answer);
  return answer;
};

const program = Effect.gen(function* () {
  const client = yield* RpcClient.make(SessionRpc);
  yield* client.registerRepo({ repo: REPO, localPath: CHECKOUT });

  // --- fill: N concurrent creates, all admitted ---------------------------------------------------
  const filled = yield* Effect.all(
    Array.from({ length: CAP }, (_, index) =>
      Effect.exit(client.createSession({ title: `admission ${index + 1}` })),
    ),
    { concurrency: "unbounded" },
  );
  for (const exit of filled)
    if (Exit.isSuccess(exit)) observed.admitted.push(exit.value.id);
  assert(
    `${CAP} concurrent createSession calls all succeed (the N-th is admitted)`,
    filled.every(Exit.isSuccess),
    `admitted=${observed.admitted.length} of ${CAP}`,
  );

  // --- refuse: the N+1th is the typed refusal ------------------------------------------------------
  const requestId = `verify-admission-${RUN}`;
  const third = yield* Effect.exit(
    client.createSession({ title: "one too many", requestId }),
  );
  observed.refusal = refusalOf(third) ?? {};
  assert(
    "the N+1th createSession fails as SessionError{code: at_capacity}",
    observed.refusal.tag === "SessionError" &&
      observed.refusal.code === "at_capacity",
    `tag=${observed.refusal.tag} code=${observed.refusal.code}`,
  );
  assert(
    "its message names the cap and its key",
    observed.refusal.message?.includes(`SESSION_MAX_CONCURRENT=${CAP}`) ===
      true,
    `message=${JSON.stringify(observed.refusal.message)}`,
  );

  // --- webhook: a delivery that would open a session is 503 at-capacity ----------------------------
  const deliveryId = `verify-admission-delivery-${RUN}`;
  const refused = yield* Effect.promise(() => deliver(deliveryId));
  assert(
    "a signed generic delivery at capacity is 503 at-capacity with Retry-After, not 500",
    refused.status === 503 &&
      refused.body?.["code"] === "at-capacity" &&
      Number(refused.retryAfter) > 0,
    `status=${refused.status} code=${String(refused.body?.["code"])} retry-after=${refused.retryAfter}`,
  );

  // --- release: the idle sweep frees the slots; the same create then succeeds -----------------------
  // Nothing reads the sessions meanwhile: a read is use, and would keep their owners open.
  let created: SessionSummary | undefined;
  const deadline = Date.now() + IDLE_TIMEOUT_MS * 6 + 10_000;
  while (created === undefined && Date.now() < deadline) {
    yield* Effect.sleep(500);
    const exit = yield* Effect.exit(
      client.createSession({ title: "after the sweep", requestId }),
    );
    if (Exit.isSuccess(exit)) created = exit.value;
    else observed.retries.push(refusalOf(exit)?.code ?? "unknown");
  }
  observed.afterRelease = created?.id;
  assert(
    "after the idle sweep releases the owners, the refused create succeeds with an open owner",
    created !== undefined &&
      !observed.admitted.includes(created.id) &&
      created.mode === "live",
    `session=${created?.id ?? "none"} mode=${created?.mode ?? "none"} after ${observed.retries.length} refused retries`,
  );
  // At least one retry was refused: a refusal that had left a row would be deduped on its request id
  // at once, without a slot, and every check below would pass on a create that never waited.
  assert(
    "the create was refused until the release, every retry the same typed refusal",
    observed.retries.length > 0 &&
      observed.retries.every((code) => code === "at_capacity"),
    `retries=${observed.retries.join(",") || "(none)"}`,
  );
  // The slot came from the sweep: every session that filled the cap has no owner now. Read only once
  // the create is in, so the reads (use) cannot have kept an owner open.
  const filledModes = yield* Effect.forEach(observed.admitted, (sessionId) =>
    Effect.map(
      client.getSession({ sessionId: SessionId.make(sessionId) }),
      (snapshot) => snapshot.session.mode,
    ),
  );
  observed.filledModes = filledModes;
  assert(
    "the idle sweep released every session that filled the cap",
    filledModes.length === CAP &&
      filledModes.every((mode) => mode === "historical"),
    `modes=${filledModes.join(",")}`,
  );
  const again = yield* client.createSession({
    title: "the same request again",
    requestId,
  });
  assert(
    "the refused request left no row: its first success is the session the request id names",
    created !== undefined && again.id === created.id,
    `again=${again.id} created=${created?.id ?? "none"}`,
  );

  // --- redeliver: the delivery is processed now ----------------------------------------------------
  const redelivered = yield* Effect.promise(() => deliver(deliveryId));
  assert(
    "the same delivery, redelivered once a slot is free, is processed with a session",
    redelivered.status === 200 &&
      redelivered.body?.["status"] === "processed" &&
      redelivered.body["replayed"] === false &&
      typeof redelivered.body["sessionId"] === "string",
    `status=${redelivered.status} body=${JSON.stringify(redelivered.body)}`,
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
  path.join(EVIDENCE_DIR, "admission.json"),
  `${JSON.stringify(observed, null, 2)}\n`,
);

const failed = Object.entries(observed.checks).filter(
  ([, check]) => !check.passed,
);
if (failed.length > 0) {
  console.error(`\n${failed.length} required check(s) failed`);
  process.exitCode = 1;
}
