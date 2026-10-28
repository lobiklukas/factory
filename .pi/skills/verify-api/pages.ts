// The pages surface (LOB-220), driven with the real Effect RPC client: `curateSession` writes a
// session's cited pages, `listPages` reads them back, and a rebuild refills them from the log.
//
//   bun pages.ts      (via ./pages.sh, which owns the priced API instance this drives)
//
// `drive.ts` already curates once and repeats once (LOB-206), on the shared instance `./up.sh`
// starts. What it cannot say is *how much* a curation cost — its faux is free, so a repeat that made
// no call and a repeat that made two both read as "tokens grew" — and it never reaches the database,
// so it cannot show that `listPages` is a read of rows a rebuild can refill. This driver is a client
// of an API whose faux charges a flat `FAUX_COST` per call, and it also holds a `DATABASE_URL`:
//
//   none       a settled session holds no pages; an unknown one is refused as `not_found`
//   curate     `curateSession` writes one page citing the session and costs exactly one call
//   list       `listPages` answers that page, field for field, and the log holds one page entry
//   repeat     the same pass again writes no page and still costs exactly one call
//   rebuild    the session's `session_pages` rows deleted: `listPages` answers nothing; then
//              `rebuildIndexes` refolds the log and `listPages` answers the same page again
//   after      a third pass, reading the rebuilt rows, still writes nothing: the dedupe it relies on
//              is answered by the refilled rows exactly as by the written ones
//
// Env: API_URL, EVIDENCE_DIR, FAUX_COST (the price the shell started the API with), DATABASE_URL.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { rebuildIndexes } from "@repo/core";
import type { Page } from "@repo/domain/Page";
import { SessionRpc } from "@repo/domain/Rpc";
import {
  SessionId,
  type SessionError,
  type SessionSnapshot,
} from "@repo/domain/Session";
import { PAGE_ENTRY_KIND } from "@repo/harness";
import { DatabaseLive } from "@repo/storage-postgres";
import { Effect, Layer } from "effect";
import { RpcClient } from "effect/rpc";
import type { RpcClientError } from "effect/rpc/RpcClientError";
import type { Unauthenticated } from "@repo/domain/Auth";
import { SqlClient } from "effect/sql/SqlClient";
import { makeChecker, protocolFor, waitUntil } from "./harness.ts";
import type { CheckRecord } from "./harness.ts";

const API_URL = process.env["API_URL"] ?? "http://localhost:9422";
const EVIDENCE_DIR =
  process.env["EVIDENCE_DIR"] ?? ".verify/evidence/latest/api";
/** What one model call costs on the instance this drives: the unit "one call's worth" is in. */
const CALL_COST = Number(process.env["FAUX_COST"] ?? "0.01");
/** Distinctive, so the transcript the curator reads can only be this session's. */
const PROMPT = "verify-api pages probe";

await mkdir(EVIDENCE_DIR, { recursive: true });

type Spend = { readonly cost: number; readonly tokens: number };

const observed: {
  apiUrl: string;
  callCost: number;
  sessionId: SessionId | null;
  spend: Record<string, Spend>;
  curations: Record<string, unknown>;
  pages: Record<string, ReadonlyArray<Page>>;
  pageEntries: Record<string, number>;
  rebuild: unknown;
  refusals: Record<string, unknown>;
  checks: Record<string, CheckRecord>;
} = {
  apiUrl: API_URL,
  callCost: CALL_COST,
  sessionId: null,
  spend: {},
  curations: {},
  pages: {},
  pageEntries: {},
  rebuild: null,
  refusals: {},
  checks: {},
};
const assert = makeChecker(observed);

/** Both `pi.usage` buckets, as the list's `costTotal` adds them, and their tokens. */
const spendOf = (snapshot: SessionSnapshot): Spend =>
  [...snapshot.usage.models, ...snapshot.usage.tools].reduce(
    (total, bucket) => ({
      cost: total.cost + bucket.usage.costTotal,
      tokens: total.tokens + bucket.usage.totalTokens,
    }),
    { cost: 0, tokens: 0 },
  );

/**
 * Whether `delta` is `calls` calls' worth of spend. The costs are binary fractions summed by two
 * processes, so equality is to a micro-dollar rather than to the last bit — far below one call.
 */
const callsWorth = (delta: number, calls: number) =>
  Math.abs(delta - calls * CALL_COST) < 1e-6;

const samePages = (left: ReadonlyArray<Page>, right: ReadonlyArray<Page>) =>
  JSON.stringify(left) === JSON.stringify(right);

/**
 * How many commits in the session's log announce a page. The log is the truth (D7): a repeat that
 * rewrote an unchanged page would be a second commit holding the entry, whatever `listPages` says.
 */
const pageEntries = (sessionId: SessionId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const rows = yield* sql<{ count: number }>`
      SELECT count(*)::int AS count FROM commits
      WHERE log_id = ${sessionId} AND strpos(writes::text, ${PAGE_ENTRY_KIND}) > 0
    `;
    return rows[0]?.count ?? 0;
  });

/** A refusal as the client decoded it: a `SessionError` with its code, or what arrived instead. */
const refusalOf = (
  error: SessionError | Unauthenticated | RpcClientError,
): { readonly _tag: string; readonly code?: string } =>
  error._tag === "SessionError"
    ? { _tag: error._tag, code: error.code }
    : { _tag: error._tag };

const program = Effect.gen(function* () {
  const client = yield* RpcClient.make(SessionRpc);
  const sql = yield* SqlClient;

  /** The session's spend as the snapshot reports it, and as the list's activity row does. */
  const readSpend = (sessionId: SessionId) =>
    Effect.gen(function* () {
      const snapshot = yield* client.getSession({ sessionId });
      const listed = yield* client.listSessions({ limit: 250 });
      const row = listed.sessions.find((entry) => entry.id === sessionId);
      return { ...spendOf(snapshot), listed: row?.costTotal ?? null };
    });

  // --- none: a settled session that was never curated holds nothing --------------------------------
  const created = yield* client.createSession({
    requestId: `verify-api-pages-${Date.now()}`,
  });
  const sessionId = created.id;
  observed.sessionId = sessionId;
  yield* client.sendMessage({ sessionId, content: PROMPT });
  yield* waitUntil(
    client
      .getSession({ sessionId })
      .pipe(
        Effect.map((state) =>
          !state.live.busy &&
          state.entries.some(
            (entry) => entry.kind === "toolResult" && entry.toolName === "bash",
          )
            ? state
            : undefined,
        ),
      ),
    "the session's bash result",
  );
  const before = yield* client.listPages({ sessionId });
  observed.pages["before"] = before.pages;
  assert(
    "a settled session that was never curated lists no pages",
    before.pages.length === 0,
    `pages=${before.pages.length}`,
  );
  const unknown = yield* client
    .listPages({ sessionId: SessionId.make("ses_00000000000000000000000000") })
    .pipe(Effect.flip, Effect.map(refusalOf));
  observed.refusals["listPagesUnknown"] = unknown;
  assert(
    "listPages for an unknown session is refused as SessionError{not_found}",
    unknown._tag === "SessionError" && unknown.code === "not_found",
    JSON.stringify(unknown),
  );
  const spent0 = yield* readSpend(sessionId);
  observed.spend["settled"] = spent0;

  // --- curate: one page, one call ---------------------------------------------------------------------
  const first = yield* client.curateSession({ sessionId, maxPages: 1 });
  observed.curations["first"] = first;
  const written = first.pages[0];
  assert(
    "curateSession writes one page, proposed, citing the curated session",
    first.pages.length === 1 &&
      first.proposed >= 1 &&
      written !== undefined &&
      written.sources.includes(sessionId),
    `pages=${first.pages.map((page) => page.name).join(", ") || "none"} proposed=${first.proposed} sources=${written?.sources.join(", ") ?? "none"}`,
  );
  const spent1 = yield* readSpend(sessionId);
  observed.spend["curated"] = spent1;
  assert(
    "the curation costs the curated session exactly one call",
    callsWorth(spent1.cost - spent0.cost, 1) && spent1.tokens > spent0.tokens,
    `cost=${spent0.cost}->${spent1.cost} (one call=${CALL_COST}) tokens=${spent0.tokens}->${spent1.tokens}`,
  );
  assert(
    "and the list's activity row carries the same spend",
    spent1.listed !== null && Math.abs(spent1.listed - spent1.cost) < 1e-6,
    `listed=${spent1.listed} snapshot=${spent1.cost}`,
  );

  // --- list: the page reads back, and the log holds it once --------------------------------------------
  const listed = yield* client.listPages({ sessionId });
  observed.pages["curated"] = listed.pages;
  assert(
    "listPages answers the page curateSession wrote, field for field",
    samePages(listed.pages, first.pages),
    `listed=${JSON.stringify(listed.pages)}`,
  );
  const entries1 = yield* pageEntries(sessionId);
  observed.pageEntries["curated"] = entries1;
  assert(
    "the session's log holds one page entry",
    entries1 === 1,
    `${PAGE_ENTRY_KIND} commits=${entries1}`,
  );

  // --- repeat: nothing new, one call's worth -------------------------------------------------------------
  const repeat = yield* client.curateSession({ sessionId, maxPages: 1 });
  observed.curations["repeat"] = repeat;
  const relisted = yield* client.listPages({ sessionId });
  observed.pages["repeat"] = relisted.pages;
  const entries2 = yield* pageEntries(sessionId);
  observed.pageEntries["repeat"] = entries2;
  assert(
    "a second curation writes no page: pages: [], the list and the log unchanged",
    repeat.pages.length === 0 &&
      repeat.proposed >= 1 &&
      samePages(relisted.pages, listed.pages) &&
      entries2 === entries1,
    `pages=${repeat.pages.length} proposed=${repeat.proposed} listed=${relisted.pages.length} ${PAGE_ENTRY_KIND} commits=${entries1}->${entries2}`,
  );
  const spent2 = yield* readSpend(sessionId);
  observed.spend["repeat"] = spent2;
  assert(
    "and it still costs exactly one call: learning nothing is cheap, not free",
    callsWorth(spent2.cost - spent1.cost, 1) &&
      spent2.tokens > spent1.tokens &&
      spent2.listed !== null &&
      Math.abs(spent2.listed - spent2.cost) < 1e-6,
    `cost=${spent1.cost}->${spent2.cost} (one call=${CALL_COST}) tokens=${spent1.tokens}->${spent2.tokens} listed=${spent2.listed}`,
  );

  // --- rebuild: the rows are a cache of the log ------------------------------------------------------------
  // The session's rows only, because what this proves is that *these* rows come back. The rebuild
  // itself is not scoped: it rewrites every session's index rows in the database. That is safe only
  // because pages.sh points this driver at a database it minted for the run and drops afterwards.
  yield* sql`DELETE FROM session_pages WHERE session_id = ${sessionId}`;
  const blanked = yield* client.listPages({ sessionId });
  observed.pages["blanked"] = blanked.pages;
  assert(
    "with the session's rows deleted, listPages answers nothing — it reads the rows, not the log",
    blanked.pages.length === 0,
    `pages=${blanked.pages.length}`,
  );
  const report = yield* rebuildIndexes;
  observed.rebuild = report;
  const refolded = yield* client.listPages({ sessionId });
  observed.pages["rebuilt"] = refolded.pages;
  const entries3 = yield* pageEntries(sessionId);
  observed.pageEntries["rebuilt"] = entries3;
  assert(
    "rebuildIndexes refills the same page from the log, and writes no log entry doing it",
    report.sessions > 0 &&
      samePages(refolded.pages, listed.pages) &&
      entries3 === entries1,
    `sessions=${report.sessions} rebuilt=${JSON.stringify(refolded.pages)} ${PAGE_ENTRY_KIND} commits=${entries3}`,
  );

  // --- after: the rebuilt rows answer the dedupe -------------------------------------------------------------
  const after = yield* client.curateSession({ sessionId, maxPages: 1 });
  observed.curations["afterRebuild"] = after;
  const entries4 = yield* pageEntries(sessionId);
  observed.pageEntries["afterRebuild"] = entries4;
  const spent3 = yield* readSpend(sessionId);
  observed.spend["afterRebuild"] = spent3;
  assert(
    "a curation over the rebuilt rows still writes nothing, for one call",
    after.pages.length === 0 &&
      after.proposed >= 1 &&
      entries4 === entries1 &&
      callsWorth(spent3.cost - spent2.cost, 1),
    `pages=${after.pages.length} proposed=${after.proposed} ${PAGE_ENTRY_KIND} commits=${entries4} cost=${spent2.cost}->${spent3.cost}`,
  );
});

try {
  await Effect.runPromise(
    program.pipe(
      Effect.provide(Layer.mergeAll(protocolFor(API_URL), DatabaseLive)),
      Effect.scoped,
    ),
  );
} catch (error) {
  assert("the drive completed", false, `threw: ${String(error)}`);
}

await writeFile(
  path.join(EVIDENCE_DIR, "pages.json"),
  `${JSON.stringify(observed, null, 2)}\n`,
);

const failed = Object.entries(observed.checks).filter(
  ([, check]) => !check.passed,
);
if (failed.length > 0) {
  console.error(`\n${failed.length} required check(s) failed`);
  process.exitCode = 1;
}
