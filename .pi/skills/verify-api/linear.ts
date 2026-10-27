// Drive the Linear adapter (LOB-164) over real HTTP against a running API.
//
//   bun linear.ts        (linear.sh boots the API with the rule and the secret first)
//
// Env:
//   API_URL                default http://localhost:9415
//   EVIDENCE_DIR           default .verify/evidence/latest
//   LINEAR_TRIGGER_REPO    the rule's repo — linear.sh passes the same value to the API's
//                          TRIGGER_RULES, so the two cannot disagree
//   LINEAR_WEBHOOK_SECRET  the secret linear.sh booted the API with
//   LINEAR_RUN_STAMP       makes this run's issue ids new against a reused database
//
// The checks:
//
//   1. a Linear issue created with the `factory` label starts a session, and the answer names it
//   2. the session is bound to the rule's repo at the rule's base ref, titled with the issue
//   3. its first message is the rule's prompt rendered from the issue's own title and description
//   4. Linear's retry of that delivery — a new `Linear-Delivery` header and a later
//      `webhookTimestamp`, so a new body and a new signature — is a replay
//   5. an update that adds a second label to the same issue is a replay too
//   6. an edit of the issue is skipped, naming Linear's action
//   7. an issue whose labels no rule names is skipped, naming the labels
//   8. an issue filed unlabelled, then labelled `factory`, starts its session on the label
//   9. a comment delivery is answered 200 and skipped, not refused (a 4xx makes Linear retry it and
//      eventually disable the webhook)
//  10. a wrong `Linear-Signature` is 401
//  11. the rule's repo has exactly the two sessions the two labeled issues earned
//
// Why HTTP and not the service: `packages/core/src/Linear.test.ts` proves the key and the seam with
// a counting fake; this adds the route, the signature, the real `SessionService`, and a real session
// whose transcript carries the prompt.
import { createHmac, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { SessionRpc } from "@repo/domain/Rpc";
import { RepoSlug } from "@repo/domain/Session";
import { Effect } from "effect";
import { RpcClient } from "effect/rpc";
import { makeChecker, protocolFor, waitUntil } from "./harness.ts";

const API_URL = process.env["API_URL"] ?? "http://localhost:9415";
const EVIDENCE_DIR = process.env["EVIDENCE_DIR"] ?? ".verify/evidence/latest";
const REPO = RepoSlug.make(
  process.env["LINEAR_TRIGGER_REPO"] ?? "acme/verify-api-linear",
);
const SECRET = process.env["LINEAR_WEBHOOK_SECRET"] ?? "";
const STAMP = process.env["LINEAR_RUN_STAMP"] ?? String(Date.now());

await mkdir(EVIDENCE_DIR, { recursive: true });

const observed = {
  apiUrl: API_URL,
  repo: REPO,
  checks: {},
  deliveries: [] as Array<unknown>,
};
const assert = makeChecker(observed);

const FACTORY = { id: "lbl-factory", name: "factory", color: "#5e6ad2" };
const BUG = { id: "lbl-bug", name: "Bug", color: "#eb5757" };
const FRONTEND = { id: "lbl-frontend", name: "Frontend", color: "#26b5ce" };

/** A Linear `Issue` data-change webhook body, shaped from Linear's webhook docs. */
const issueBody = (over: {
  readonly id: string;
  readonly identifier: string;
  readonly action?: string;
  readonly labels?: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
  }>;
  readonly updatedFrom?: Record<string, unknown>;
  readonly title?: string;
  readonly description?: string;
}) => {
  const labels = over.labels ?? [FACTORY];
  const title = over.title ?? `Linear issue ${over.identifier}`;
  return {
    action: over.action ?? "create",
    type: "Issue",
    actor: { id: "user-verify", type: "user", name: "verify-api" },
    createdAt: new Date().toISOString(),
    data: {
      id: over.id,
      identifier: over.identifier,
      title,
      description:
        over.description ?? "Filed in Linear by the verify-api drive.",
      labelIds: labels.map((label) => label.id),
      labels,
      teamId: "team-verify",
    },
    url: `https://linear.app/acme/issue/${over.identifier}`,
    ...(over.updatedFrom === undefined
      ? {}
      : { updatedFrom: over.updatedFrom }),
    organizationId: "org-verify",
    webhookTimestamp: Date.now(),
    // The subscription's id: the same on every delivery, which the route must not dedupe on.
    webhookId: "verify-api-linear-subscription",
  };
};

/** One delivery as Linear sends it: the raw body, its HMAC, and a fresh `Linear-Delivery`. */
const deliver = async (
  label: string,
  body: unknown,
  options: { readonly signature?: string } = {},
) => {
  const raw = JSON.stringify(body);
  const delivery = randomUUID();
  const response = await fetch(`${API_URL}/webhooks/linear`, {
    method: "POST",
    headers: {
      "content-type": "application/json; charset=utf-8",
      "linear-delivery": delivery,
      "linear-event": "Issue",
      "linear-signature":
        options.signature ??
        createHmac("sha256", SECRET).update(raw).digest("hex"),
      "linear-timestamp": String(Date.now()),
      "user-agent": "Linear-Webhook",
    },
    body: raw,
  });
  const answer = (await response.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  observed.deliveries.push({
    label,
    delivery,
    status: response.status,
    answer,
  });
  return { status: response.status, body: answer };
};

const program = Effect.gen(function* () {
  const client = yield* RpcClient.make(SessionRpc);

  // `unregistered-repo` is a separate refusal; the mapping is what this drive is testing.
  yield* client.registerRepo({ repo: REPO, defaultBaseRef: "main" });

  const forRepo = Effect.gen(function* () {
    const listed = yield* client.listSessions({ limit: 100 });
    return listed.sessions.filter((entry) => entry.repo === REPO);
  });

  // 1–3: a labeled issue opens one session on the rule's repo, with the issue as its prompt.
  const created = issueBody({
    id: `lin-${STAMP}-created`,
    identifier: `VER-${STAMP}1`,
    labels: [BUG, FACTORY],
    title: `Fix the wobble ${STAMP}`,
    description: "The widget wobbles when it spins.",
  });
  const first = yield* Effect.promise(() => deliver("create", created));
  const sessionId =
    typeof first.body?.["sessionId"] === "string"
      ? first.body["sessionId"]
      : undefined;
  assert(
    "a labeled Linear issue starts a session",
    first.status === 200 &&
      first.body?.["status"] === "processed" &&
      first.body?.["replayed"] === false &&
      sessionId !== undefined,
    `status=${first.status} body=${JSON.stringify(first.body)}`,
  );

  if (sessionId !== undefined) {
    const listed = yield* forRepo;
    const summary = listed.find((entry) => entry.id === sessionId);
    assert(
      "the session is bound to the rule's repo and base ref, titled with the issue",
      summary !== undefined &&
        summary.repo === REPO &&
        summary.baseRef === "main" &&
        summary.title.includes(`Fix the wobble ${STAMP}`),
      `summary=${JSON.stringify(summary ?? null)}`,
    );

    const expected = `Linear issue lin-${STAMP}-created: Fix the wobble ${STAMP}\n\nThe widget wobbles when it spins.`;
    const firstUser = yield* waitUntil(
      Effect.map(client.getSession({ sessionId }), (snapshot) =>
        snapshot.entries.find((entry) => entry.kind === "user"),
      ),
      "the session's first message",
    );
    assert(
      "the issue's words, through the rule's template, are the session's first message",
      firstUser.text === expected,
      `prompt=${JSON.stringify(firstUser.text)}`,
    );
  }

  // 4: Linear's retry carries a new header and a new timestamp — a new body, a new signature.
  const retry = yield* Effect.promise(() =>
    deliver("retry", { ...created, webhookTimestamp: Date.now() + 60_000 }),
  );
  assert(
    "Linear's retry of the delivery is a replay",
    retry.status === 200 &&
      retry.body?.["replayed"] === true &&
      retry.body?.["status"] === "processed",
    `status=${retry.status} body=${JSON.stringify(retry.body)}`,
  );

  // 5: a second label on the same issue.
  const relabel = yield* Effect.promise(() =>
    deliver(
      "relabel",
      issueBody({
        id: `lin-${STAMP}-created`,
        identifier: `VER-${STAMP}1`,
        action: "update",
        labels: [BUG, FACTORY, FRONTEND],
        updatedFrom: { labelIds: [BUG.id, FACTORY.id] },
      }),
    ),
  );
  assert(
    "a label added to the same issue later is a replay, not a second session",
    relabel.status === 200 && relabel.body?.["replayed"] === true,
    `status=${relabel.status} body=${JSON.stringify(relabel.body)}`,
  );

  // 6: an edit.
  const edit = yield* Effect.promise(() =>
    deliver(
      "edit",
      issueBody({
        id: `lin-${STAMP}-created`,
        identifier: `VER-${STAMP}1`,
        action: "update",
        labels: [BUG, FACTORY],
        updatedFrom: { title: "Old title" },
      }),
    ),
  );
  assert(
    "an edit is skipped, naming Linear's action",
    edit.status === 200 &&
      edit.body?.["status"] === "skipped" &&
      String(edit.body?.["reason"] ?? "").includes('action "update"'),
    `status=${edit.status} body=${JSON.stringify(edit.body)}`,
  );

  // 7: unmappable.
  const unmapped = yield* Effect.promise(() =>
    deliver(
      "unmapped",
      issueBody({
        id: `lin-${STAMP}-unmapped`,
        identifier: `VER-${STAMP}2`,
        labels: [BUG, FRONTEND],
      }),
    ),
  );
  assert(
    "an issue no rule maps is skipped, naming its labels",
    unmapped.status === 200 &&
      unmapped.body?.["status"] === "skipped" &&
      unmapped.body?.["reason"] === "no rule matches labels [Bug, Frontend]",
    `status=${unmapped.status} body=${JSON.stringify(unmapped.body)}`,
  );

  // 8: filed unlabelled, then triaged into the factory.
  const filed = yield* Effect.promise(() =>
    deliver(
      "filed-unlabelled",
      issueBody({
        id: `lin-${STAMP}-triaged`,
        identifier: `VER-${STAMP}3`,
        labels: [],
      }),
    ),
  );
  const triaged = yield* Effect.promise(() =>
    deliver(
      "labelled-later",
      issueBody({
        id: `lin-${STAMP}-triaged`,
        identifier: `VER-${STAMP}3`,
        action: "update",
        labels: [FACTORY],
        updatedFrom: { labelIds: [] },
      }),
    ),
  );
  assert(
    "an issue filed unlabelled starts its session when it is labelled",
    filed.body?.["status"] === "skipped" &&
      triaged.status === 200 &&
      triaged.body?.["status"] === "processed" &&
      triaged.body?.["replayed"] === false,
    `filed=${JSON.stringify(filed.body)} labelled=${JSON.stringify(triaged.body)}`,
  );

  // 9: another entity type.
  const comment = yield* Effect.promise(() =>
    deliver("comment", {
      action: "create",
      type: "Comment",
      data: {
        id: `lin-${STAMP}-comment`,
        body: "LGTM",
        issueId: `lin-${STAMP}-created`,
      },
      url: `https://linear.app/acme/issue/VER-${STAMP}1#comment`,
      webhookTimestamp: Date.now(),
      webhookId: "verify-api-linear-subscription",
    }),
  );
  assert(
    "a comment delivery is answered and skipped, not refused",
    comment.status === 200 &&
      comment.body?.["status"] === "skipped" &&
      String(comment.body?.["reason"] ?? "").includes('"Comment:create"'),
    `status=${comment.status} body=${JSON.stringify(comment.body)}`,
  );

  // 10: authentication.
  const forged = yield* Effect.promise(() =>
    deliver(
      "forged",
      issueBody({ id: `lin-${STAMP}-forged`, identifier: `VER-${STAMP}4` }),
      { signature: "0".repeat(64) },
    ),
  );
  assert(
    "a wrong Linear-Signature is 401",
    forged.status === 401,
    `status=${forged.status} body=${JSON.stringify(forged.body)}`,
  );

  // 11: the count.
  const sessions = yield* forRepo;
  assert(
    "the rule's repo has exactly one session per labeled issue",
    sessions.length === 2,
    `sessions=${JSON.stringify(sessions.map((entry) => ({ id: entry.id, title: entry.title })))}`,
  );
});

try {
  await Effect.runPromise(
    program.pipe(Effect.provide(protocolFor(API_URL)), Effect.scoped),
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
  ([, check]) => !(check as { passed: boolean }).passed,
);
if (failed.length > 0) {
  console.error(`\n${failed.length} required check(s) failed`);
  process.exitCode = 1;
} else {
  console.log(`${Object.keys(observed.checks).length} checks passed`);
}
