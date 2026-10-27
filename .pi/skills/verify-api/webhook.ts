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
//
// Why HTTP and not the service: what this adds over `packages/core`'s `TriggerService.test.ts` is
// the whole path — signature, cap, payload normalization, the seam, a *real* `SessionService`, and
// a real session whose transcript carries the prompt. The posts are signed exactly the way Linear
// signs a delivery (`hmac-sha256` over the raw body, hex), so the route cannot be passing by
// accident.
import { createHmac } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { SessionRpc } from "@repo/domain/Rpc";
import { Effect } from "effect";
import { RpcClient } from "effect/rpc";
import { makeChecker, protocolFor } from "./harness.ts";

const API_URL = process.env["API_URL"] ?? "http://localhost:9400";
const EVIDENCE_DIR = process.env["EVIDENCE_DIR"] ?? ".verify/evidence/latest";
const REPO = process.env["TRIGGER_REPO"] ?? "acme/verify-api-trigger";
const SECRET = process.env["TRIGGER_SECRET"] ?? "";
const SIGNATURE_HEADER = "x-trigger-signature";

await mkdir(EVIDENCE_DIR, { recursive: true });

const observed = {
  apiUrl: API_URL,
  repo: REPO,
  checks: {},
  deliveries: [],
};
const assert = makeChecker(observed);

const sign = (body: string): string =>
  createHmac("sha256", SECRET).update(body).digest("hex");

/** One signed POST to a trigger route, as a sender would write it. */
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
  const answer = await response.json().catch(() => null);
  observed.deliveries.push({ route, status: response.status, answer });
  return { status: response.status, body: answer };
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
      first.body?.status === "processed" &&
      first.body?.replayed === false &&
      typeof first.body?.sessionId === "string",
    `status=${first.status} body=${JSON.stringify(first.body)}`,
  );
  const sessionId = first.body?.sessionId;

  const second = yield* Effect.promise(() =>
    post("/webhooks/generic", generic(requestId)),
  );
  assert(
    "the same delivery again is a replay",
    second.status === 200 &&
      second.body?.replayed === true &&
      second.body?.status === "processed",
    `status=${second.status} body=${JSON.stringify(second.body)}`,
  );

  const afterFirst = yield* countForRepo;
  assert(
    "exactly one session exists for two deliveries",
    afterFirst === before + 1,
    `before=${before} after=${afterFirst}`,
  );

  // The prompt is the session's first message, rendered from the rule's template.
  if (typeof sessionId === "string") {
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
      filtered.body?.status === "skipped" &&
      String(filtered.body?.reason ?? "").includes('action "update"'),
    `status=${filtered.status} body=${JSON.stringify(filtered.body)}`,
  );

  const filteredReplay = yield* Effect.promise(() =>
    post("/webhooks/generic", generic(filteredId, { action: "update" })),
  );
  assert(
    "a replay of a skipped delivery stays skipped",
    filteredReplay.body?.replayed === true &&
      filteredReplay.body?.status === "skipped",
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
      unmapped.body?.status === "skipped" &&
      unmapped.body?.reason === "no rule matches labels [nobody]",
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
    oversized.status === 413 && oversized.body?.code === "body-too-large",
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
    linear.status === 200 && linear.body?.status === "processed",
    `status=${linear.status} body=${JSON.stringify(linear.body)}`,
  );

  const afterAll = yield* countForRepo;
  assert(
    "only the two mapped deliveries created sessions",
    afterAll === before + 2,
    `before=${before} after=${afterAll}`,
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
