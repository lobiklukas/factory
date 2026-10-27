// The review agent over real HTTP (LOB-36): a signed `pull_request` on `POST /webhooks/github` of a
// booted API starts a read-only reviewer run on the PR's card, which posts one review comment on a
// loopback GitHub as the reviewer's own identity.
//
//   bun review.ts        (review.sh boots the API with the env below first)
//
// Checks:
//   1. the boot names the reviewer's identity (its own token), and a PR the factory opened from a
//      card is answered `review: {status: "processed", sessionId}` beside the Linear mirror
//   2. the reviewer is a run of that card in `review`, cut at the PR's head, on the reviewer role's
//      model, and is offered no `write`, `edit` or `verify`
//   3. GitHub gets exactly one `COMMENT` review on the head commit, as `GITHUB_REVIEWER_TOKEN` — never
//      the worker's `GITHUB_TOKEN` — naming the seeded file and its mechanism, after reading the PR
//      and its reviews
//   4. GitHub's redelivery of the event reviews nothing twice
//   5. a `synchronize` (a push) is reviewed again: a second run, at the new head, a second comment
//      pinned to that commit
//   6. a PR the factory did not open is `skipped`, and an unsigned delivery is `401`
//
// The forge is this process's `Bun.serve` (`GITHUB_API_URL`), with three routes — `GET` the PR, `GET`
// its reviews, `POST` a review — and every request kept in memory for the checks, since it lives as
// long as the drive does. The checkout is a real git repository with a seeded bug on its head.
//
// Env: API_URL, EVIDENCE_DIR, GITHUB_WEBHOOK_SECRET, REVIEW_REPO, REVIEW_CHECKOUT, REVIEW_HEAD,
// REVIEW_PUSHED, FORGE_PORT, DATABASE_URL (via DatabaseLive).
import { createHmac, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { BunServices } from "@effect/platform-bun";
import { RpcApi } from "@repo/domain/Rpc";
import { RepoSlug, type SessionId } from "@repo/domain/Session";
import { DEFAULT_DEFINITION_ID, DefinitionId } from "@repo/domain/Task";
import { DatabaseLive } from "@repo/storage-postgres";
import { Effect, Layer } from "effect";
import { RpcClient } from "effect/rpc";
import { SqlClient } from "effect/sql/SqlClient";
import { makeChecker, protocolFor, waitUntil } from "./harness.ts";

const API_URL = process.env["API_URL"] ?? "http://localhost:9200";
const EVIDENCE_DIR = process.env["EVIDENCE_DIR"] ?? ".verify/evidence/lob-36";
const SECRET = process.env["GITHUB_WEBHOOK_SECRET"] ?? "";
const REPO = RepoSlug.make(process.env["REVIEW_REPO"] ?? "acme/verify-review");
const CHECKOUT = process.env["REVIEW_CHECKOUT"] ?? "";
const HEAD = process.env["REVIEW_HEAD"] ?? "";
const PUSHED = process.env["REVIEW_PUSHED"] ?? "";
const FORGE_PORT = Number(process.env["FORGE_PORT"] ?? "9201");
const NUMBER = 7;
const PAGE = `https://github.com/${REPO}/pull/${NUMBER}`;
const FILE = "src/sum.ts";

await mkdir(EVIDENCE_DIR, { recursive: true });

type ForgeRequest = {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | null;
  readonly body: unknown;
};
const forge = {
  head: HEAD,
  requests: [] as ForgeRequest[],
  reviews: [] as Array<Record<string, unknown>>,
};
const server = Bun.serve({
  port: FORGE_PORT,
  hostname: "127.0.0.1",
  fetch: async (request) => {
    const url = new URL(request.url);
    const body: unknown =
      request.method === "POST"
        ? await request.json().catch(() => null)
        : undefined;
    forge.requests.push({
      method: request.method,
      path: `${url.pathname}${url.search}`,
      authorization: request.headers.get("authorization"),
      body,
    });
    const pull = `/repos/${REPO}/pulls/${NUMBER}`;
    if (request.method === "GET" && url.pathname === pull)
      return Response.json({ number: NUMBER, head: { sha: forge.head } });
    if (request.method === "GET" && url.pathname === `${pull}/reviews`)
      return Response.json(forge.reviews);
    if (request.method === "POST" && url.pathname === `${pull}/reviews`) {
      const review = {
        id: forge.reviews.length + 1,
        ...(body as Record<string, unknown>),
        html_url: `${PAGE}#pullrequestreview-${forge.reviews.length + 1}`,
      };
      forge.reviews.push(review);
      return Response.json(review);
    }
    return new Response("not found", { status: 404 });
  },
});

const observed = {
  apiUrl: API_URL,
  repo: REPO,
  head: HEAD,
  pushed: PUSHED,
  checks: {},
  deliveries: [] as unknown[],
  forge,
  reviewers: [] as unknown[],
};
const assert = makeChecker(observed);

const sign = (raw: string) =>
  `sha256=${createHmac("sha256", SECRET).update(raw).digest("hex")}`;

/** GitHub's `pull_request` body, shaped from its webhook docs: the fields the routes read, and more. */
const pullRequest = (action: string, head: string, number = NUMBER) => ({
  action,
  number,
  pull_request: {
    number,
    html_url: `https://github.com/${REPO}/pull/${number}`,
    url: `https://api.github.com/repos/${REPO}/pulls/${number}`,
    title: "Skip the first element",
    state: "open",
    draft: false,
    merged: false,
    base: { ref: "main", sha: "0".repeat(40) },
    head: { ref: "feature", sha: head },
  },
  repository: { full_name: REPO, default_branch: "main" },
  sender: { login: "verify-api", type: "User" },
});

const deliver = async (label: string, body: unknown, signature?: string) => {
  const raw = JSON.stringify(body);
  const response = await fetch(`${API_URL}/webhooks/github`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": "pull_request",
      "x-github-delivery": randomUUID(),
      "x-hub-signature-256": signature ?? sign(raw),
    },
    body: raw,
  });
  const answer = (await response.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  observed.deliveries.push({ label, status: response.status, answer });
  const review = (answer?.["review"] ?? {}) as Record<string, unknown>;
  return { status: response.status, answer, review };
};

const program = Effect.gen(function* () {
  const client = yield* RpcClient.make(RpcApi);
  const sql = yield* SqlClient;

  // The card the PR comes from, and the build run whose session recorded the PR's page (as the PR
  // step does, LOB-177).
  yield* client.registerRepo({
    repo: REPO,
    localPath: CHECKOUT,
    defaultBaseRef: "main",
  });
  const board = yield* client.createBoard({
    repo: RepoSlug.make(`${REPO}-board`),
    definitionId: DefinitionId.make(DEFAULT_DEFINITION_ID),
  });
  const card = yield* client.createTask({
    boardId: board.id,
    title: "skip the first element",
    actor: "person:verify",
  });
  const builder = yield* client.createSession({
    title: "build it",
    taskId: card.id,
    taskColumn: "building",
  });
  yield* sql`UPDATE sessions SET pr_url = ${PAGE} WHERE id = ${builder.id}`;

  /** A reviewer run, settled: its snapshot once its review tool call has a result. */
  const settled = (sessionId: SessionId) =>
    waitUntil(
      Effect.map(client.getSession({ sessionId }), (snapshot) =>
        !snapshot.live.busy &&
        snapshot.entries.some(
          (entry) => entry.kind === "toolResult" && entry.toolName === "review",
        )
          ? snapshot
          : undefined,
      ),
      `reviewer ${sessionId} to settle`,
    );

  // 1
  const opened = yield* Effect.promise(() =>
    deliver("opened", pullRequest("opened", HEAD)),
  );
  const firstId = opened.review["sessionId"] as SessionId | undefined;
  assert(
    "a signed pull_request on a PR the factory opened from a card starts a reviewer run",
    opened.status === 200 &&
      opened.review["status"] === "processed" &&
      opened.review["replayed"] === false &&
      firstId !== undefined,
    `status=${opened.status} review=${JSON.stringify(opened.review)}`,
  );
  if (firstId === undefined) return;

  // 2
  const first = yield* settled(firstId);
  const runs = yield* client.listTaskRuns({ taskId: card.id });
  const run = runs.find((entry) => entry.sessionId === firstId);
  observed.reviewers.push({
    id: firstId,
    workspace: first.workspace,
    usage: first.usage.models,
  });
  assert(
    "the reviewer is a run of the PR's card in its review column, cut at the PR's head",
    run?.column === "review" &&
      first.workspace.baseRef === HEAD &&
      first.workspace.branch ===
        `factory/review-${NUMBER}-${HEAD.slice(0, 12)}`,
    `run=${JSON.stringify(run)} baseRef=${first.workspace.baseRef} branch=${first.workspace.branch}`,
  );
  const models = first.usage.models.map((entry) => entry.key);
  assert(
    "the reviewer talks to the reviewer role's model (ROLE_MODELS), not the deployment's",
    models.length === 1 && models[0] === "faux/faux-review",
    `models=${models.join(",")}`,
  );
  const offered = new Set(
    first.entries.flatMap((entry) => entry.toolCalls.map((call) => call.name)),
  );
  const reviewResult = first.entries.find(
    (entry) => entry.kind === "toolResult" && entry.toolName === "review",
  );
  assert(
    "the reviewer only read (bash) and reviewed: no write, edit or verify call",
    !offered.has("write") &&
      !offered.has("edit") &&
      !offered.has("verify") &&
      offered.has("review"),
    `calls=${[...offered].join(",")}; review result: ${reviewResult?.text ?? "none"}`,
  );

  // 3
  const posts = () =>
    forge.requests.filter((request) => request.method === "POST");
  const post = posts()[0];
  const postBody = (post?.body ?? {}) as Record<string, unknown>;
  const comment = String(postBody["body"] ?? "");
  assert(
    "GitHub got one COMMENT review on the head commit, naming the seeded file and its mechanism",
    posts().length === 1 &&
      postBody["event"] === "COMMENT" &&
      postBody["commit_id"] === HEAD &&
      comment.includes(`\`${FILE}:1\``) &&
      comment.includes("drops the first element"),
    `posts=${posts().length} event=${String(postBody["event"])} commit=${String(postBody["commit_id"])}`,
  );
  assert(
    "every forge call was the reviewer's own token, never the worker's",
    forge.requests.length > 0 &&
      forge.requests.every(
        (request) => request.authorization === "Bearer ghs-verify-reviewer",
      ),
    forge.requests
      .map(
        (request) =>
          `${request.method} ${request.path} ${request.authorization}`,
      )
      .join("; "),
  );
  assert(
    "the post read the PR's head and its reviews first",
    forge.requests
      .slice(0, 3)
      .map((request) => request.method)
      .join(",") === "GET,GET,POST",
    forge.requests
      .slice(0, 3)
      .map((request) => `${request.method} ${request.path}`)
      .join("; "),
  );

  // 4
  const again = yield* Effect.promise(() =>
    deliver("redelivered", pullRequest("opened", HEAD)),
  );
  assert(
    "GitHub's redelivery reviews nothing twice",
    again.review["replayed"] === true && posts().length === 1,
    `review=${JSON.stringify(again.review)} posts=${posts().length}`,
  );

  // 5
  forge.head = PUSHED;
  const pushed = yield* Effect.promise(() =>
    deliver("synchronize", pullRequest("synchronize", PUSHED)),
  );
  const secondId = pushed.review["sessionId"] as SessionId | undefined;
  if (secondId !== undefined) yield* settled(secondId);
  const second = posts()[1];
  assert(
    "a push (synchronize) is reviewed again: a new run, and a comment pinned to the new head",
    pushed.review["status"] === "processed" &&
      secondId !== undefined &&
      secondId !== firstId &&
      posts().length === 2 &&
      (second?.body as Record<string, unknown> | undefined)?.["commit_id"] ===
        PUSHED,
    `review=${JSON.stringify(pushed.review)} posts=${posts().length}`,
  );

  // 6
  const foreign = yield* Effect.promise(() =>
    deliver("not ours", pullRequest("opened", HEAD, NUMBER + 1)),
  );
  assert(
    "a PR the factory did not open starts no review",
    foreign.status === 200 && foreign.review["status"] === "skipped",
    `review=${JSON.stringify(foreign.review)}`,
  );
  const unsigned = yield* Effect.promise(() =>
    deliver("unsigned", pullRequest("opened", HEAD), "sha256=00"),
  );
  assert(
    "an unsigned delivery is refused",
    unsigned.status === 401,
    `status=${unsigned.status}`,
  );
}).pipe(
  Effect.provide(
    Layer.mergeAll(protocolFor(API_URL), DatabaseLive, BunServices.layer),
  ),
);

await Effect.runPromise(Effect.scoped(program)).catch((cause: unknown) => {
  assert("the drive ran to the end", false, String(cause));
});
await server.stop(true);
await writeFile(
  path.join(EVIDENCE_DIR, "review.json"),
  `${JSON.stringify(observed, null, 2)}\n`,
);
const failed = Object.values(
  observed.checks as Record<string, { passed: boolean }>,
).filter((check) => !check.passed).length;
console.log(
  failed === 0
    ? "\nreview: all checks passed"
    : `\nreview: ${failed} check(s) failed`,
);
process.exit(failed === 0 ? 0 : 1);
