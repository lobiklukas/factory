// Drive the inbound trigger seam (LOB-188) over real HTTP against a running API.
//
//   bun webhook.ts
//
// Env:
//   API_URL       default http://localhost:9400
//   EVIDENCE_DIR  default .verify/evidence/latest
//   TRIGGER_REPO  the repo the rules map to (webhook.sh sets it and passes the same value to the
//                 API as part of TRIGGER_RULES, so the two cannot disagree)
//   TRIGGER_SECRET  the shared secret webhook.sh booted the API with
//   DATABASE_URL  the database the API serves (default `DatabaseConfig`'s), where the stale-claim
//                 check writes the row a killed process would have left (LOB-216)
//
// Why HTTP and not the service: what this adds over `packages/core`'s `TriggerService.test.ts` is
// the whole path — signature, cap, payload normalization, the seam, a *real* `SessionService`, and
// a real session whose transcript carries the prompt. The posts are signed exactly the way Linear
// signs a delivery (`hmac-sha256` over the raw body, hex), so the route cannot be passing by
// accident.
import { SQL } from "bun";
import { createHmac } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { SessionRpc } from "@repo/domain/Rpc";
import { RepoSlug } from "@repo/domain/Session";
import { TriggerOutcome } from "@repo/domain/Trigger";
import { Effect, Option, Schema } from "effect";
import { RpcClient } from "effect/rpc";
import { makeChecker, protocolFor, type CheckRecord } from "./harness.ts";

const API_URL = process.env["API_URL"] ?? "http://localhost:9400";
/** The API's own database — `DatabaseConfig`'s default when the run names none. */
const DATABASE_URL =
  process.env["DATABASE_URL"] ??
  "postgres://factory:factory@localhost:5442/factory";
const EVIDENCE_DIR = process.env["EVIDENCE_DIR"] ?? ".verify/evidence/latest";
const REPO = RepoSlug.make(
  process.env["TRIGGER_REPO"] ?? "acme/verify-api-trigger",
);
const SECRET = process.env["TRIGGER_SECRET"] ?? "";
const SIGNATURE_HEADER = "x-trigger-signature";

await mkdir(EVIDENCE_DIR, { recursive: true });

const observed: {
  apiUrl: string;
  repo: RepoSlug;
  checks: Record<string, CheckRecord>;
  deliveries: Array<{ route: string; status: number; answer: unknown }>;
  reclaimedSessionId?: string | null;
} = {
  apiUrl: API_URL,
  repo: REPO,
  checks: {},
  deliveries: [],
};

/** The refusal a route answers before the seam (`apps/api/src/Api/Webhook.ts`): a typed code. */
const Refusal = Schema.Struct({ code: Schema.String });
const assert = makeChecker(observed);

const sign = (body: string): string =>
  createHmac("sha256", SECRET).update(body).digest("hex");

/**
 * One signed POST to a trigger route, as a sender would write it. `body` is the answer as it
 * arrived, for the evidence; `outcome` and `refusal` are that answer decoded as the seam's
 * `TriggerOutcome` or a route's refusal, `null` when it is not one — so a wrong shape fails the
 * check that reads it.
 */
const post = async (
  route: string,
  body: unknown,
  options: {
    readonly signature?: string;
    readonly signatureHeader?: string;
  } = {},
) => {
  const raw = typeof body === "string" ? body : `${JSON.stringify(body)}`;
  const signature = options.signature ?? sign(raw);
  const response = await fetch(`${API_URL}${route}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [options.signatureHeader ?? SIGNATURE_HEADER]: signature,
    },
    body: raw,
  });
  const answer: unknown = await response.json().catch(() => null);
  observed.deliveries.push({ route, status: response.status, answer });
  return {
    status: response.status,
    retryAfter: response.headers.get("retry-after"),
    body: answer,
    outcome: Option.getOrNull(
      Schema.decodeUnknownOption(TriggerOutcome)(answer),
    ),
    refusal: Option.getOrNull(Schema.decodeUnknownOption(Refusal)(answer)),
  };
};

const generic = (
  requestId: string,
  over: Record<string, unknown> = {},
): Record<string, unknown> => ({
  requestId,
  key: `verify-api-${requestId}`,
  action: "create",
  label: "factory",
  title: `trigger ${requestId}`,
  body: "opened by verify-api",
  ...over,
});

const ProtocolLive = protocolFor(API_URL);

const runId = Date.now();
const requestId = `lob188-${runId}`;

const program = Effect.gen(function* () {
  const client = yield* RpcClient.make(SessionRpc);

  // The mapping rule names a registered repo, so register it first: `unregistered-repo` is a
  // separate refusal and the rules are not what this drive is testing.
  yield* client.registerRepo({ repo: REPO, defaultBaseRef: "main" });

  /** How many sessions this drive's own repo has, newest-first page (it is nobody else's repo). */
  const countForRepo = Effect.gen(function* () {
    const listed = yield* client.listSessions({ limit: 100 });
    return listed.sessions.filter((entry) => entry.repo === REPO).length;
  });

  const before = yield* countForRepo;

  // Feature: one session per delivery. The same signed body posted twice must create one session,
  // and the second answer must say `replayed` rather than looking like a fresh success.
  const first = yield* Effect.promise(() =>
    post("/webhooks/generic", generic(requestId)),
  );
  assert(
    "a signed delivery starts a session",
    first.status === 200 &&
      first.outcome?.status === "processed" &&
      first.outcome?.replayed === false &&
      first.outcome?.sessionId !== undefined,
    `status=${first.status} body=${JSON.stringify(first.body)}`,
  );
  const sessionId = first.outcome?.sessionId;

  const second = yield* Effect.promise(() =>
    post("/webhooks/generic", generic(requestId)),
  );
  assert(
    "the same delivery again is a replay",
    second.status === 200 &&
      second.outcome?.replayed === true &&
      second.outcome?.status === "processed",
    `status=${second.status} body=${JSON.stringify(second.body)}`,
  );

  const afterFirst = yield* countForRepo;
  assert(
    "exactly one session exists for two deliveries",
    afterFirst === before + 1,
    `before=${before} after=${afterFirst}`,
  );

  // The prompt is the session's first message, rendered from the rule's template.
  if (sessionId !== undefined) {
    const snapshot = yield* client.getSession({ sessionId });
    const firstUser = snapshot.entries.find((entry) => entry.kind === "user");
    assert(
      "the rendered rule prompt is the session's first message",
      firstUser !== undefined &&
        firstUser.text.includes(`trigger ${requestId}`) &&
        firstUser.text.includes("opened by verify-api"),
      `prompt=${JSON.stringify(firstUser?.text ?? null)}`,
    );
  }

  // Feature: the filter. An action that is not a create is recorded as skipped with its reason and
  // starts nothing — and a replay of that refusal answers the same way rather than retrying it.
  const filteredId = `lob188-filtered-${runId}`;
  const filtered = yield* Effect.promise(() =>
    post("/webhooks/generic", generic(filteredId, { action: "update" })),
  );
  assert(
    "an action that is not a create is skipped with its reason",
    filtered.status === 200 &&
      filtered.outcome?.status === "skipped" &&
      // Exactly what the `factory` rule admits: naming `"push", "schedule"` here would tell a
      // generic caller those are open to it, and they are `400` (LOB-235).
      filtered.outcome?.reason === 'action "update" is not "create"',
    `status=${filtered.status} body=${JSON.stringify(filtered.body)}`,
  );

  const filteredReplay = yield* Effect.promise(() =>
    post("/webhooks/generic", generic(filteredId, { action: "update" })),
  );
  assert(
    "a replay of a skipped delivery stays skipped",
    filteredReplay.outcome?.replayed === true &&
      filteredReplay.outcome?.status === "skipped",
    `body=${JSON.stringify(filteredReplay.body)}`,
  );

  // Feature: mapping. A label no rule names is unmappable, and the answer says which labels.
  const unmapped = yield* Effect.promise(() =>
    post(
      "/webhooks/generic",
      generic(`lob188-unmapped-${runId}`, { label: "nobody" }),
    ),
  );
  assert(
    "an unmappable delivery is skipped, naming the labels",
    unmapped.status === 200 &&
      unmapped.outcome?.status === "skipped" &&
      unmapped.outcome?.reason === "no rule matches labels [nobody]",
    `status=${unmapped.status} body=${JSON.stringify(unmapped.body)}`,
  );

  const afterSkips = yield* countForRepo;
  assert(
    "a skipped delivery creates no session",
    afterSkips === afterFirst,
    `before=${afterFirst} after=${afterSkips}`,
  );

  // Feature: authentication. A body that does not match its signature is refused before anything
  // is parsed, and a wrong header name is a wrong signature.
  const wrongSignature = yield* Effect.promise(() =>
    post("/webhooks/generic", generic(`lob188-badsig-${runId}`), {
      signature: "0".repeat(64),
    }),
  );
  assert(
    "a wrong signature is 401",
    wrongSignature.status === 401,
    `status=${wrongSignature.status} body=${JSON.stringify(wrongSignature.body)}`,
  );

  // Feature: the cap. webhook.sh boots the API with TRIGGER_MAX_BODY_BYTES=2048, so a 4 KiB body
  // is refused with a typed code and creates nothing — it never reaches the delivery store.
  const oversized = yield* Effect.promise(() =>
    post(
      "/webhooks/generic",
      generic(`lob188-big-${runId}`, { body: "x".repeat(4096) }),
    ),
  );
  assert(
    "a body over the cap is refused before any session exists",
    oversized.status === 413 && oversized.refusal?.code === "body-too-large",
    `status=${oversized.status} body=${JSON.stringify(oversized.body)}`,
  );

  // A Linear-shaped delivery through the other adapter, on the same seam: its issue labels select
  // the rule and its `data.issue` becomes the prompt's words.
  const linearBody = {
    action: "create",
    // No `Linear-Delivery` header: the Linear adapter keys a create on its issue (LOB-164), so a
    // replay of this delivery would dedupe without one. `linear.sh` drives that adapter in full.
    webhookId: `linear-delivery-${runId}`,
    type: "Issue",
    data: {
      id: `linear-issue-${runId}`,
      title: `linear ${runId}`,
      description: "from the linear adapter",
      labels: [{ name: "factory" }],
    },
  };
  const linear = yield* Effect.promise(() =>
    post("/webhooks/linear", linearBody, {
      signature: createHmac(
        "sha256",
        process.env["LINEAR_WEBHOOK_SECRET"] ?? "",
      )
        .update(JSON.stringify(linearBody))
        .digest("hex"),
      signatureHeader: "linear-signature",
    }),
  );
  assert(
    "the linear adapter delegates to the same seam",
    linear.status === 200 && linear.outcome?.status === "processed",
    `status=${linear.status} body=${JSON.stringify(linear.body)}`,
  );

  const afterAll = yield* countForRepo;
  assert(
    "only the two mapped deliveries created sessions",
    afterAll === before + 2,
    `before=${before} after=${afterAll}`,
  );

  // Feature: a claim whose process died is reclaimed (LOB-216). A `SIGKILL` between the claim and
  // the outcome runs no release, so it leaves a `received` row nothing will finish. The drive
  // writes that row the way the killed process left it — claimed an hour ago, far past the seam's
  // window — into the database the API serves, then delivers the same id: the retry must start the
  // work, not answer `replayed: true` to work that never started.
  const orphanId = `${requestId}-orphaned`;
  yield* Effect.promise(async () => {
    const db = new SQL(DATABASE_URL);
    try {
      await db`
        INSERT INTO webhook_deliveries (request_id, status, received_at, claimed_at)
        VALUES (${orphanId}, 'received', now() - interval '1 hour', now() - interval '1 hour')
      `;
    } finally {
      await db.close();
    }
  });
  const reclaimed = yield* Effect.promise(() =>
    post("/webhooks/generic", generic(orphanId)),
  );
  observed.reclaimedSessionId = reclaimed.outcome?.sessionId ?? null;
  const afterReclaim = yield* countForRepo;
  assert(
    "a delivery a killed process left claimed is reclaimed and starts its session",
    reclaimed.status === 200 &&
      reclaimed.outcome?.status === "processed" &&
      reclaimed.outcome?.replayed === false &&
      reclaimed.outcome?.sessionId !== undefined &&
      afterReclaim === afterAll + 1,
    `status=${reclaimed.status} body=${JSON.stringify(reclaimed.body)} sessions ${afterAll}→${afterReclaim}`,
  );

  // Feature: a retry inside the window is told to retry, not that it is done (LOB-216). A claim
  // taken a moment ago may be a process still working or one just killed; either way the sender
  // must not stop on this answer, and a `200` is where Linear stops. So the replay is `503
  // in-progress` with `Retry-After`, and it starts nothing.
  const inFlightId = `${requestId}-in-flight`;
  yield* Effect.promise(async () => {
    const db = new SQL(DATABASE_URL);
    try {
      await db`
        INSERT INTO webhook_deliveries (request_id, status)
        VALUES (${inFlightId}, 'received')
      `;
    } finally {
      await db.close();
    }
  });
  const inFlight = yield* Effect.promise(() =>
    post("/webhooks/generic", generic(inFlightId)),
  );
  const afterInFlight = yield* countForRepo;
  assert(
    "a retry of a delivery claimed inside the window is 503 in-progress, so the sender retries",
    inFlight.status === 503 &&
      inFlight.refusal?.code === "in-progress" &&
      inFlight.retryAfter !== null &&
      inFlight.outcome?.status === "received" &&
      inFlight.outcome?.replayed === true &&
      afterInFlight === afterReclaim,
    `status=${inFlight.status} retry-after=${inFlight.retryAfter} body=${JSON.stringify(inFlight.body)} sessions ${afterReclaim}→${afterInFlight}`,
  );

  // Feature: the generic caller cannot name a lifecycle action (LOB-235). webhook.sh's `docs` rule
  // admits `push` and `schedule`, as `docsTriggerRules` does, so before the adapter refused it a
  // signed `{action: "push", label: "docs"}` reached the seam and was recorded `processed` with
  // `rule "docs" mapped it to …` — a push nobody pushed. It is now `400 lifecycle-action`, names
  // why, starts nothing, and leaves no `webhook_deliveries` row whose outcome could claim a push.
  const pushId = `${requestId}-push`;
  const pushed = yield* Effect.promise(() =>
    post(
      "/webhooks/generic",
      generic(pushId, { action: "push", label: "docs" }),
    ),
  );
  const pushRows = yield* Effect.promise(async () => {
    const db = new SQL(DATABASE_URL);
    try {
      const rows: Array<{ status: string; skip_reason: string | null }> =
        await db`
        SELECT status, skip_reason FROM webhook_deliveries WHERE request_id = ${pushId}
      `;
      return rows;
    } finally {
      await db.close();
    }
  });
  const afterPush = yield* countForRepo;
  const pushError =
    typeof pushed.body === "object" && pushed.body !== null
      ? String((pushed.body as { error?: unknown }).error ?? "")
      : "";
  assert(
    "a generic delivery naming push is 400 lifecycle-action, names why, and records nothing",
    pushed.status === 400 &&
      pushed.refusal?.code === "lifecycle-action" &&
      pushError.includes('lifecycle action "push"') &&
      pushed.outcome === null &&
      pushRows.length === 0 &&
      afterPush === afterInFlight,
    `status=${pushed.status} body=${JSON.stringify(pushed.body)} rows=${JSON.stringify(pushRows)} sessions ${afterInFlight}→${afterPush}`,
  );

  // Not only `push` and `schedule`: a rule's `startsWorkFor` is any string, and webhook.sh's
  // `release` rule admits `release`. The generic caller cannot name that either (LOB-235 review).
  const releaseId = `${requestId}-release`;
  const released = yield* Effect.promise(() =>
    post(
      "/webhooks/generic",
      generic(releaseId, { action: "release", label: "release" }),
    ),
  );
  const releaseRows = yield* Effect.promise(async () => {
    const db = new SQL(DATABASE_URL);
    try {
      const rows: Array<{ status: string }> = await db`
        SELECT status FROM webhook_deliveries WHERE request_id = ${releaseId}
      `;
      return rows;
    } finally {
      await db.close();
    }
  });
  const afterRelease = yield* countForRepo;
  assert(
    "a generic delivery naming an action a rule admits is 400 lifecycle-action, and records nothing",
    released.status === 400 &&
      released.refusal?.code === "lifecycle-action" &&
      releaseRows.length === 0 &&
      afterRelease === afterPush,
    `status=${released.status} body=${JSON.stringify(released.body)} rows=${JSON.stringify(releaseRows)} sessions ${afterPush}→${afterRelease}`,
  );

  // The same caller saying `create` on the same label still starts a docs session: the refusal
  // removed a false claim, not a capability.
  const docs = yield* Effect.promise(() =>
    post(
      "/webhooks/generic",
      generic(`${requestId}-docs`, { action: "create", label: "docs" }),
    ),
  );
  const afterDocs = yield* countForRepo;
  const docsPrompt =
    docs.outcome?.sessionId === undefined
      ? undefined
      : (yield* client.getSession({
          sessionId: docs.outcome.sessionId,
        })).entries.find((entry) => entry.kind === "user")?.text;
  assert(
    "a generic create on the docs label still starts a docs session",
    docs.status === 200 &&
      docs.outcome?.status === "processed" &&
      docs.outcome?.reason ===
        `rule "docs" (env:TRIGGER_RULES[1]) mapped it to ${REPO}` &&
      afterDocs === afterPush + 1 &&
      (docsPrompt ?? "").startsWith(`Document trigger ${requestId}-docs`),
    `status=${docs.status} body=${JSON.stringify(docs.body)} prompt=${JSON.stringify(docsPrompt ?? null)} sessions ${afterPush}→${afterDocs}`,
  );
});

try {
  await Effect.runPromise(
    program.pipe(Effect.provide(ProtocolLive), Effect.scoped),
  );
} catch (error) {
  assert("drive completed", false, `threw: ${String(error)}`);
}

await writeFile(
  path.join(EVIDENCE_DIR, "observed.json"),
  `${JSON.stringify(observed, null, 2)}\n`,
);

console.log(`\nevidence: ${path.resolve(EVIDENCE_DIR)}`);
const failed = Object.entries(observed.checks).filter(
  ([, check]) => !check.passed,
);
if (failed.length > 0) {
  console.error(`\n${failed.length} required check(s) failed`);
  process.exitCode = 1;
}
