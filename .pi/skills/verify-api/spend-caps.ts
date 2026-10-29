// Aggregate spend caps (S-aggregate-spend-caps), driven with the real Effect RPC client against an
// API started with `SPEND_CAPS` over a priced faux model (a run of "go" costs two cents) and an ntfy
// sink that is the loopback fake (`notify-fake.ts`).
//
//   bun spend-caps.ts      (via ./spend-caps.sh, which owns the API, the fake and the database)
//
// The caps: the web repo $0.025 a day, and the actor carol $0.015 a day.
//
//   warn       one run on web is $0.02 of $0.025: 80% — exactly one attention item (`spend`, 80), and
//              one notification on the sink, linked to the spend page
//   reach      a second run on web is let through (under the cap when it starts) and takes it past
//              the limit: the item becomes the 100% one, still a single item, told once more
//   refuse     a new run on web — createSession, sendMessage to an existing web session — is refused
//              SessionError{code: budget_exceeded} naming the repo, the window, the limit and
//              `SPEND_CAPS repos["…"].daily`; a run on the docs repo is not
//   actor      carol's one run is over her cap: she is refused on a repo with no cap (docs), and
//              another actor is not
//   webhook    a signed generic delivery that would open a session on web is answered 503
//              at-capacity ("budget exceeded"), not 500
//   once       a refused request raises no second alert and no second message, however many follow
//
// Env: API_URL, EVIDENCE_DIR, NOTIFY_FAKE_LEDGER, LINK_BASE, TRIGGER_SECRET, SPEND_REPO_WEB,
// SPEND_REPO_DOCS, SPEND_ACTOR_CAROL, SPEND_ACTOR_AMY, SPEND_ACTOR_BOB.
import { createHmac, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { RpcApi } from "@repo/domain/Rpc";
import { RepoSlug, type SessionId } from "@repo/domain/Session";
import { Effect, Exit } from "effect";
import { RpcClient } from "effect/rpc";
import { makeChecker, protocolFor, waitUntil } from "./harness.ts";
import type { CheckRecord } from "./harness.ts";

const API_URL = process.env["API_URL"] ?? "http://127.0.0.1:9456";
const EVIDENCE_DIR =
  process.env["EVIDENCE_DIR"] ?? ".verify/evidence/latest/api";
const LEDGER = process.env["NOTIFY_FAKE_LEDGER"] ?? "";
const LINK_BASE = process.env["LINK_BASE"] ?? "http://127.0.0.1:3100";
const TRIGGER_SECRET = process.env["TRIGGER_SECRET"] ?? "";
const WEB = RepoSlug.make(process.env["SPEND_REPO_WEB"] ?? "verify/spend-web");
const DOCS = RepoSlug.make(
  process.env["SPEND_REPO_DOCS"] ?? "verify/spend-docs",
);
const CAROL = process.env["SPEND_ACTOR_CAROL"] ?? "carol";
const AMY = process.env["SPEND_ACTOR_AMY"] ?? "amy";
const BOB = process.env["SPEND_ACTOR_BOB"] ?? "bob";
/** What a run of "go" costs on the priced faux model: two requests of a cent. */
const RUN_COST = 0.02;

await mkdir(EVIDENCE_DIR, { recursive: true });

type Received = {
  readonly sink: "slack" | "ntfy";
  readonly body: Record<string, unknown> | null;
};

const messages = async (): Promise<ReadonlyArray<Received>> =>
  (JSON.parse(await readFile(LEDGER, "utf8")) as { messages: Received[] })
    .messages;
const titlesOf = (all: ReadonlyArray<Received>): ReadonlyArray<string> =>
  all.flatMap((message) => {
    const title = message.body?.["title"];
    return typeof title === "string" && title.includes(WEB) ? [title] : [];
  });

const observed: {
  apiUrl: string;
  refusals: Array<Record<string, unknown>>;
  attention: Array<unknown>;
  titles: ReadonlyArray<string>;
  webhook: Array<{ status: number; retryAfter: string | null; body: unknown }>;
  checks: Record<string, CheckRecord>;
} = {
  apiUrl: API_URL,
  refusals: [],
  attention: [],
  titles: [],
  webhook: [],
  checks: {},
};
const assert = makeChecker(observed);

type Refusal = {
  readonly tag?: string | undefined;
  readonly code?: string | undefined;
  readonly message?: string | undefined;
  readonly spendCap?:
    | {
        readonly scope: string;
        readonly subject: string;
        readonly window: string;
        readonly limit: number;
        readonly spent: number;
        readonly source: string;
        readonly resetsAt: string;
      }
    | undefined;
};

const refusalOf = (exit: Exit.Exit<unknown, unknown>): Refusal | undefined => {
  if (Exit.isSuccess(exit)) return undefined;
  const failure = Exit.findErrorOption(exit);
  if (failure._tag !== "Some") return { tag: "defect" };
  const error = failure.value as Refusal & { readonly _tag?: string };
  return {
    tag: error._tag,
    code: error.code,
    message: error.message,
    spendCap: error.spendCap,
  };
};

const deliver = async (requestId: string) => {
  const raw = JSON.stringify({
    requestId,
    label: "factory",
    title: "a delivery that would run on web",
    body: "refused while web is over its cap",
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
  const client = yield* RpcClient.make(RpcApi);

  const spendItems = (subject: string) =>
    Effect.map(client.listAttention({}), (items) =>
      items.flatMap((item) =>
        item.reason._tag === "spend" && item.reason.subject === subject
          ? [item.reason]
          : [],
      ),
    );

  /** A run on `repo` by `actor`, awaited until it has answered; `spentOn` waits for its cost. */
  const run = (repo: RepoSlug, actor: string) =>
    Effect.gen(function* () {
      const created = yield* client.createSession({
        repo,
        actor,
        title: `spend caps ${actor}`,
      });
      yield* client.sendMessage({ sessionId: created.id, content: "go" });
      yield* settled(created.id);
      return created.id;
    });
  const settled = (sessionId: SessionId) =>
    waitUntil(
      Effect.map(client.getSession({ sessionId }), (snapshot) =>
        snapshot.session.status === "idle" &&
        snapshot.entries.some(
          (entry) => entry.kind === "assistant" && entry.text !== "",
        )
          ? true
          : undefined,
      ),
      `session ${sessionId} to answer`,
    );
  /** The spend the index holds for a repo, once the projection has it. */
  const spentOn = (repo: RepoSlug, atLeast: number) =>
    waitUntil(
      Effect.map(client.listSpend({}), (report) => {
        const total = report.rows
          .filter((row) => row.repo === repo)
          .reduce((sum, row) => sum + row.costTotal, 0);
        return total >= atLeast - 1e-6 ? total : undefined;
      }),
      `${repo} to have spent ${atLeast}`,
    );

  // --- warn: one run is 80% of web's daily cap -----------------------------------------------------
  const first = yield* run(WEB, AMY);
  yield* spentOn(WEB, RUN_COST);
  const warned = yield* waitUntil(
    Effect.map(spendItems(WEB), (items) =>
      items.length > 0 ? items : undefined,
    ),
    "web's 80% attention item",
  );
  observed.attention.push(...warned);
  assert(
    "crossing 80% of the repo's daily cap creates one attention item",
    warned.length === 1 &&
      warned[0]?.threshold === 80 &&
      warned[0].scope === "repo" &&
      warned[0].window === "day" &&
      warned[0].limit === 0.025,
    `items=${JSON.stringify(warned)}`,
  );
  const afterWarn = yield* waitUntil(
    Effect.promise(async () => {
      const titles = titlesOf(await messages());
      return titles.length > 0 ? titles : undefined;
    }),
    "the 80% notification",
  );
  assert(
    "the 80% crossing is one notification on the sink",
    afterWarn.length === 1 && afterWarn[0]?.includes("80%") === true,
    `titles=${JSON.stringify(afterWarn)}`,
  );
  const warnMessage = (yield* Effect.promise(messages)).find(
    (message) => titlesOf([message]).length > 0,
  );
  assert(
    "and it links to the spend page",
    warnMessage?.body?.["click"] === `${LINK_BASE}/spend`,
    `click=${String(warnMessage?.body?.["click"])}`,
  );

  // --- reach: the second run is let through and reaches the cap -------------------------------------
  const second = yield* run(WEB, AMY);
  yield* spentOn(WEB, 2 * RUN_COST);
  const reached = yield* waitUntil(
    Effect.map(spendItems(WEB), (items) =>
      items.some((item) => item.threshold === 100) ? items : undefined,
    ),
    "web's 100% attention item",
  );
  observed.attention.push(...reached);
  assert(
    "reaching the cap replaces it with one 100% item, still a single row",
    reached.length === 1 && reached[0]?.threshold === 100,
    `items=${JSON.stringify(reached)}`,
  );
  assert(
    "a run that starts under the cap is let through, though it ends over it",
    second !== first,
    `second=${second}`,
  );

  // --- refuse: web is over; docs and other actors are not ------------------------------------------
  const refusedCreate = refusalOf(
    yield* Effect.exit(client.createSession({ repo: WEB, actor: BOB })),
  );
  observed.refusals.push({ create: refusedCreate });
  assert(
    "a new run on the capped repo is refused budget_exceeded, typed and naming the cap",
    refusedCreate?.tag === "SessionError" &&
      refusedCreate.code === "budget_exceeded" &&
      refusedCreate.spendCap?.scope === "repo" &&
      refusedCreate.spendCap.subject === WEB &&
      refusedCreate.spendCap.window === "day" &&
      refusedCreate.spendCap.limit === 0.025 &&
      refusedCreate.spendCap.spent >= 0.025 &&
      refusedCreate.spendCap.source ===
        `SPEND_CAPS repos[${JSON.stringify(WEB)}].daily` &&
      Date.parse(refusedCreate.spendCap.resetsAt) > Date.now(),
    `refusal=${JSON.stringify(refusedCreate)}`,
  );
  const refusedSend = refusalOf(
    yield* Effect.exit(
      client.sendMessage({ sessionId: first, content: "once more" }),
    ),
  );
  observed.refusals.push({ send: refusedSend });
  assert(
    "a sendMessage to a session on that repo is refused the same way",
    refusedSend?.code === "budget_exceeded" &&
      refusedSend.spendCap?.subject === WEB,
    `code=${refusedSend?.code}`,
  );
  const docs = yield* Effect.exit(
    client.createSession({ repo: DOCS, actor: BOB }),
  );
  assert(
    "a run on another repository is unaffected",
    Exit.isSuccess(docs),
    Exit.isSuccess(docs) ? `session=${docs.value.id}` : "refused",
  );

  // --- actor: carol's own cap, across repos ----------------------------------------------------------
  yield* run(DOCS, CAROL);
  yield* waitUntil(
    Effect.map(client.listSpend({}), (report) =>
      report.rows.some(
        (row) => row.actor === CAROL && row.costTotal >= RUN_COST - 1e-6,
      )
        ? true
        : undefined,
    ),
    "carol's spend to be indexed",
  );
  const carol = refusalOf(
    yield* Effect.exit(client.createSession({ repo: DOCS, actor: CAROL })),
  );
  observed.refusals.push({ actor: carol });
  assert(
    "an actor over their own cap is refused on a repository with no cap",
    carol?.code === "budget_exceeded" &&
      carol.spendCap?.scope === "actor" &&
      carol.spendCap.subject === CAROL &&
      carol.spendCap.source ===
        `SPEND_CAPS actors[${JSON.stringify(CAROL)}].daily`,
    `refusal=${JSON.stringify(carol)}`,
  );
  const otherActor = yield* Effect.exit(
    client.createSession({ repo: DOCS, actor: AMY }),
  );
  assert(
    "and another actor on that repository is not",
    Exit.isSuccess(otherActor),
    Exit.isSuccess(otherActor) ? "admitted" : "refused",
  );

  // --- webhook: a delivery on the capped repo is a not-now ------------------------------------------
  const answer = yield* Effect.promise(() =>
    deliver(`verify-spend-${randomBytes(4).toString("hex")}`),
  );
  assert(
    "a signed delivery that would run on the capped repo is 503 at-capacity, not 500",
    answer.status === 503 &&
      answer.body?.["code"] === "at-capacity" &&
      String(answer.body["error"]).includes("budget exceeded") &&
      Number(answer.retryAfter) > 0,
    `status=${answer.status} body=${JSON.stringify(answer.body)}`,
  );

  // --- once: no refusal raised a second alert or message ---------------------------------------------
  yield* Effect.sleep(2_500);
  const finalItems = yield* spendItems(WEB);
  const finalTitles = titlesOf(yield* Effect.promise(messages));
  observed.titles = finalTitles;
  assert(
    "however many requests were refused, web has one attention item and two messages (80%, then the cap)",
    finalItems.length === 1 &&
      finalTitles.length === 2 &&
      finalTitles[0]?.includes("80%") === true &&
      finalTitles[1]?.includes("reached") === true,
    `items=${finalItems.length} titles=${JSON.stringify(finalTitles)}`,
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
  path.join(EVIDENCE_DIR, "spend-caps.json"),
  `${JSON.stringify(observed, null, 2)}\n`,
);

const failed = Object.entries(observed.checks).filter(
  ([, check]) => !check.passed,
);
if (failed.length > 0) {
  console.error(`\n${failed.length} required check(s) failed`);
  process.exitCode = 1;
}
