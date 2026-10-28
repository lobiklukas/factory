// Drive the Linear adapter (LOB-164) over real HTTP against a running API.
//
//   bun linear.ts        (linear.sh boots the API with the rule and the secret first)
//
// Env:
//   API_URL                default http://localhost:9415
//   EVIDENCE_DIR           default .verify/evidence/latest
//   LINEAR_TRIGGER_REPO    the rule's repo — linear.sh passes the same value to the API's
//                          TRIGGER_RULES, so the two cannot disagree
//   LINEAR_LATER_REPO      the second rule's repo (`factory-later`), registered only mid-drive
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
//   5. an update that adds a second mapped label to the same issue is a replay too
//   6. an edit of the issue is skipped, naming Linear's action
//   7. an issue whose labels no rule names is skipped, naming the labels
//   8. an issue filed unlabelled, then labelled `factory`, starts its session on the label
//   9. a comment delivery — carrying `data.issue`, as Linear's do — is answered 200 and skipped as
//      the comment, not refused (a 4xx makes Linear retry it and eventually disable the webhook)
//  10. a delivery whose `data` names no id (`IssueSLA`) is answered 200 and skipped too
//  11. adding a label no rule names to an issue that already carries a mapped one starts nothing
//  12. an issue skipped because its rule's repo is unregistered starts its session once the repo is
//      registered and the label is added again
//  13. a wrong `Linear-Signature` is 401
//  14. the rule's repo has exactly the two sessions the two labeled issues earned, and the later
//      rule's repo the one its issue earned
//  15. the delivery of check 1 is recorded as routed by `env:TRIGGER_RULES[0]` (LOB-266)
//  16. an issue carrying a label no env rule names is skipped; a stored route for that label, added
//      over RPC while the API runs, routes the same issue's next delivery — no env edit, no restart —
//      and the recorded reason names the route's id; the session lands on the route's repo
//  17. removing the route over RPC sends the next such issue back to "no rule matches"
//
// `linear.sh` also reads the API's boot log after the drive: the rules line and one armed/unarmed
// line per webhook route (LOB-266).
//
// Why HTTP and not the service: `packages/core/src/Linear.test.ts` proves the key and the seam with
// a counting fake; this adds the route, the signature, the real `SessionService`, and a real session
// whose transcript carries the prompt.
import { createHmac, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { SessionRpc, TriggerRoutesRpc } from "@repo/domain/Rpc";
import { RepoSlug, SessionId } from "@repo/domain/Session";
import { Effect, Option, Schema } from "effect";
import { RpcClient } from "effect/rpc";
import { makeChecker, protocolFor, waitUntil } from "./harness.ts";

const API_URL = process.env["API_URL"] ?? "http://localhost:9415";
const EVIDENCE_DIR = process.env["EVIDENCE_DIR"] ?? ".verify/evidence/latest";
const REPO = RepoSlug.make(
  process.env["LINEAR_TRIGGER_REPO"] ?? "acme/verify-api-linear",
);
const LATER_REPO = RepoSlug.make(
  process.env["LINEAR_LATER_REPO"] ?? "acme/verify-api-linear-later",
);
/** The repo a stored route (LOB-266) sends work to: registered mid-drive, so its count is this run's. */
const STORED_REPO = RepoSlug.make(`${REPO}-stored`);
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
const LATER = { id: "lbl-later", name: "factory-later", color: "#f2c94c" };
/** A label no env rule names; only the stored route the drive adds claims it. Per run, like the ids. */
const STORED = {
  id: "lbl-stored",
  name: `factory-stored-${STAMP}`,
  color: "#4cb782",
};

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
  const routes = yield* RpcClient.make(TriggerRoutesRpc);

  // `unregistered-repo` is a separate refusal; the mapping is what this drive is testing.
  yield* client.registerRepo({ repo: REPO, defaultBaseRef: "main" });

  const sessionsOn = (repo: RepoSlug) =>
    Effect.gen(function* () {
      const listed = yield* client.listSessions({ limit: 100 });
      return listed.sessions.filter((entry) => entry.repo === repo);
    });
  const forRepo = sessionsOn(REPO);

  // 1–3: a labeled issue opens one session on the rule's repo, with the issue as its prompt.
  const created = issueBody({
    id: `lin-${STAMP}-created`,
    identifier: `VER-${STAMP}1`,
    labels: [BUG, FACTORY],
    title: `Fix the wobble ${STAMP}`,
    description: "The widget wobbles when it spins.",
  });
  const first = yield* Effect.promise(() => deliver("create", created));
  // Decoded, not trusted: an id the API answered in the wrong shape fails this check, not a later one.
  const sessionId = Option.getOrUndefined(
    Schema.decodeUnknownOption(SessionId)(first.body?.["sessionId"]),
  );
  assert(
    "a labeled Linear issue starts a session",
    first.status === 200 &&
      first.body?.["status"] === "processed" &&
      first.body?.["replayed"] === false &&
      sessionId !== undefined,
    `status=${first.status} body=${JSON.stringify(first.body)}`,
  );

  assert(
    "the delivery is recorded as routed by the first TRIGGER_RULES entry",
    first.body?.["reason"] ===
      `rule "factory" (env:TRIGGER_RULES[0]) mapped it to ${REPO}`,
    `reason=${JSON.stringify(first.body?.["reason"])}`,
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

  // 5: a second mapped label on the same issue.
  const relabel = yield* Effect.promise(() =>
    deliver(
      "relabel",
      issueBody({
        id: `lin-${STAMP}-created`,
        identifier: `VER-${STAMP}1`,
        action: "update",
        labels: [BUG, FACTORY, LATER],
        updatedFrom: { labelIds: [BUG.id, FACTORY.id] },
      }),
    ),
  );
  assert(
    "a mapped label added to the same issue later is a replay, not a second session",
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
        issue: {
          id: `lin-${STAMP}-created`,
          title: `Fix the wobble ${STAMP}`,
        },
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

  // 10: an entity whose `data` names no id.
  const sla = yield* Effect.promise(() =>
    deliver("issue-sla", {
      action: "set",
      type: "IssueSLA",
      issueData: { id: `lin-${STAMP}-created`, title: "SLA" },
      url: `https://linear.app/acme/issue/VER-${STAMP}1`,
      webhookTimestamp: Date.now(),
      webhookId: "verify-api-linear-subscription",
    }),
  );
  assert(
    "a delivery whose data names no id is answered and skipped, not refused",
    sla.status === 200 &&
      sla.body?.["status"] === "skipped" &&
      String(sla.body?.["reason"] ?? "").includes('"IssueSLA:set"'),
    `status=${sla.status} body=${JSON.stringify(sla.body)}`,
  );

  // 11: an unrelated label added to an issue that already carries a mapped one.
  const preLabelled = yield* Effect.promise(() =>
    deliver(
      "unrelated-label",
      issueBody({
        id: `lin-${STAMP}-prelabelled`,
        identifier: `VER-${STAMP}5`,
        action: "update",
        labels: [FACTORY, BUG],
        updatedFrom: { labelIds: [FACTORY.id] },
      }),
    ),
  );
  assert(
    "adding a label no rule names starts nothing, even on an issue carrying a mapped one",
    preLabelled.status === 200 &&
      preLabelled.body?.["status"] === "skipped" &&
      String(preLabelled.body?.["reason"] ?? "").includes('action "update"'),
    `status=${preLabelled.status} body=${JSON.stringify(preLabelled.body)}`,
  );

  // 12: unregistered, then registered — the issue-wide key must not replay the old skip.
  const laterIssue = {
    id: `lin-${STAMP}-later`,
    identifier: `VER-${STAMP}6`,
    title: `Later ${STAMP}`,
  };
  const refused = yield* Effect.promise(() =>
    deliver("unregistered", issueBody({ ...laterIssue, labels: [LATER] })),
  );
  yield* client.registerRepo({ repo: LATER_REPO, defaultBaseRef: "main" });
  const relabelled = yield* Effect.promise(() =>
    deliver(
      "registered-relabel",
      issueBody({
        ...laterIssue,
        action: "update",
        labels: [LATER],
        updatedFrom: { labelIds: [] },
      }),
    ),
  );
  assert(
    "an unregistered-repo skip is reclaimed once the repo is registered",
    refused.body?.["status"] === "skipped" &&
      refused.body?.["reason"] === `repo ${LATER_REPO} is not registered` &&
      relabelled.status === 200 &&
      relabelled.body?.["status"] === "processed" &&
      relabelled.body?.["replayed"] === false,
    `refused=${JSON.stringify(refused.body)} relabelled=${JSON.stringify(relabelled.body)}`,
  );

  // 13: authentication.
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

  // 14: the count.
  const sessions = yield* forRepo;
  const later = yield* sessionsOn(LATER_REPO);
  assert(
    "each rule's repo has exactly one session per labeled issue",
    sessions.length === 2 && later.length === 1,
    `sessions=${JSON.stringify(sessions.map((entry) => ({ id: entry.id, title: entry.title })))} later=${later.length}`,
  );

  // 16–17: a stored route, added and removed while the API runs (LOB-266).
  yield* client.registerRepo({ repo: STORED_REPO, defaultBaseRef: "main" });
  const storedIssue = {
    id: `lin-${STAMP}-stored`,
    identifier: `VER-${STAMP}7`,
    title: `Stored ${STAMP}`,
  };
  const beforeRoute = yield* Effect.promise(() =>
    deliver(
      "stored-before-route",
      issueBody({ ...storedIssue, labels: [STORED] }),
    ),
  );
  const route = yield* routes.addTriggerRoute({
    label: STORED.name,
    repo: STORED_REPO,
    prompt: "Stored route {{key}}",
  });
  const afterRoute = yield* Effect.promise(() =>
    deliver(
      "stored-after-route",
      issueBody({
        ...storedIssue,
        action: "update",
        labels: [STORED],
        updatedFrom: { labelIds: [] },
      }),
    ),
  );
  const storedSessionId = Option.getOrUndefined(
    Schema.decodeUnknownOption(SessionId)(afterRoute.body?.["sessionId"]),
  );
  assert(
    "a stored route added over RPC routes the next delivery, and the reason names the route",
    beforeRoute.body?.["status"] === "skipped" &&
      afterRoute.status === 200 &&
      afterRoute.body?.["status"] === "processed" &&
      afterRoute.body?.["reason"] ===
        `rule "${STORED.name}" (route ${route.id}) mapped it to ${STORED_REPO}` &&
      storedSessionId !== undefined,
    `before=${JSON.stringify(beforeRoute.body)} after=${JSON.stringify(afterRoute.body)}`,
  );
  const onStored = yield* sessionsOn(STORED_REPO);
  assert(
    "the stored route's session is on the route's repo",
    onStored.length === 1 && onStored[0]?.id === storedSessionId,
    `sessions=${JSON.stringify(onStored.map((entry) => entry.id))}`,
  );

  yield* routes.removeTriggerRoute({ id: route.id });
  const afterRemoval = yield* Effect.promise(() =>
    deliver(
      "stored-after-removal",
      issueBody({
        id: `lin-${STAMP}-stored-2`,
        identifier: `VER-${STAMP}8`,
        labels: [STORED],
      }),
    ),
  );
  assert(
    "removing the route sends the next such issue back to no rule matches",
    afterRemoval.body?.["status"] === "skipped" &&
      String(afterRemoval.body?.["reason"] ?? "").startsWith("no rule matches"),
    `body=${JSON.stringify(afterRemoval.body)}`,
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
