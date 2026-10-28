// Cost prediction before a run over the wire (LOB-38).
//
//   bun cost.ts      (via ./cost.sh, which owns the API instance and the database this drives)
//
// The API runs the faux model priced at FAUX_COST (a cent a request) on a database of its own, so
// the history every answer is drawn from is exactly the sessions this drive ran. The first message
// of a session is two requests (the `bash` call and the reply), each later one a reply alone, so a
// session sent k messages costs k + 1 cents. Every check reads through the same RPC client the CLI
// and the dashboard build, and every expected number is worked out by hand beside it:
//
//   empty     with no completed session, `predictCost` answers no range (`none`, history 0) and
//             `backtestCost` scores nothing
//   history   four fixes on REPO cost 2, 2, 3 and 4 cents, a feature on REPO 2, a fix on OTHER 5
//   predict   a fix on REPO is predicted from the four fixes: 0.02 to 0.037, median 0.025; a feature
//             on REPO from all five REPO sessions; a model the server does not serve is refused
//   backtest  REPO's walk-forward: two scored, median error 37.5%, the range held one of two; the
//             whole history: three scored, median error 50%; neither is meaningful (fewer than 20)
//
// MODE=cap reads one session instead (CAPPED, the one `factory run --cap-at-prediction` created): its
// budget is the predicted high the CLI printed (CAP), and its run answered under it.
//
// Env: API_URL, EVIDENCE_DIR, FAUX_COST, REPO, OTHER, MODE, CAPPED, CAP.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { SessionRpc } from "@repo/domain/Rpc";
import { RepoSlug, SessionId } from "@repo/domain/Session";
import { Effect } from "effect";
import { RpcClient } from "effect/rpc";
import { makeChecker, protocolFor, waitUntil } from "./harness.ts";
import type { CheckRecord } from "./harness.ts";

const API_URL = process.env["API_URL"] ?? "http://localhost:9432";
const EVIDENCE_DIR =
  process.env["EVIDENCE_DIR"] ?? ".verify/evidence/latest/api";
const COST = Number(process.env["FAUX_COST"] ?? "0.01");
const REPO = RepoSlug.make(process.env["REPO"] ?? "verify-cost/web");
const OTHER = RepoSlug.make(process.env["OTHER"] ?? "verify-cost/api");

await mkdir(EVIDENCE_DIR, { recursive: true });

const observed: {
  apiUrl: string;
  fauxCost: number;
  repo: string;
  other: string;
  sessions: Record<string, { id: SessionId; costTotal: number }>;
  answers: Record<string, unknown>;
  checks: Record<string, CheckRecord>;
} = {
  apiUrl: API_URL,
  fauxCost: COST,
  repo: REPO,
  other: OTHER,
  sessions: {},
  answers: {},
  checks: {},
};
const assert = makeChecker(observed);
const close = (left: number | undefined, right: number) =>
  left !== undefined && Math.abs(left - right) < 1e-9;

const MODE = process.env["MODE"] ?? "drive";

/** The session `factory run --cap-at-prediction` created: capped at the high it printed. */
const capProgram = Effect.gen(function* () {
  const client = yield* RpcClient.make(SessionRpc);
  const sessionId = SessionId.make(process.env["CAPPED"] ?? "");
  const cap = Number(process.env["CAP"] ?? "NaN");
  const snapshot = yield* client.getSession({ sessionId });
  observed.answers["capped"] = { budget: snapshot.budget };
  assert(
    "the capped session's budget is the predicted high, as the server holds it",
    close(snapshot.budget?.cap, cap) && snapshot.budget?.stopped === undefined,
    `budget=${JSON.stringify(snapshot.budget)} printed=${cap}`,
  );
  assert(
    "and its run, cheaper than the cap, answered",
    snapshot.entries.some(
      (entry) => entry.kind === "assistant" && entry.text.includes("faux-ok"),
    ),
    `kinds=${snapshot.entries.map((entry) => entry.kind).join(",")}`,
  );
});

const program = Effect.gen(function* () {
  const client = yield* RpcClient.make(SessionRpc);

  // --- empty: nothing has run, so there is nothing to predict from -----------------------------
  const empty = yield* client.predictCost({ prompt: "fix the parser bug" });
  observed.answers["empty"] = empty;
  assert(
    "with no completed session there is no range, and the answer says why",
    empty.basis === "none" &&
      empty.range === undefined &&
      empty.history === 0 &&
      empty.comparables === 0 &&
      empty.shape === "fix" &&
      empty.model === "faux/faux-1",
    JSON.stringify(empty),
  );
  const emptyBacktest = yield* client.backtestCost({});
  assert(
    "with no completed session the backtest scores nothing and reports no error",
    emptyBacktest.sessions === 0 &&
      emptyBacktest.scored === 0 &&
      emptyBacktest.medianRelativeError === undefined &&
      emptyBacktest.rows === undefined,
    JSON.stringify(emptyBacktest),
  );

  // --- history: real priced runs, one session at a time -----------------------------------------
  const run = (
    name: string,
    prompt: string,
    messages: number,
    repo: RepoSlug,
  ) =>
    Effect.gen(function* () {
      const created = yield* client.createSession({ repo });
      for (let sent = 1; sent <= messages; sent += 1) {
        yield* client.sendMessage({
          sessionId: created.id,
          content: sent === 1 ? prompt : "and again",
        });
        yield* waitUntil(
          client
            .getSession({ sessionId: created.id })
            .pipe(
              Effect.map(
                (snapshot) =>
                  !snapshot.live.busy &&
                  snapshot.entries.filter(
                    (entry) => entry.kind === "assistant" && entry.text !== "",
                  ).length >= sent,
              ),
            ),
          `${name} to answer message ${sent}`,
        );
      }
      // The index row is what a prediction reads: wait until it holds the run's whole cost.
      const costTotal = yield* waitUntil(
        client.listSessions({ limit: 100 }).pipe(
          Effect.map((page) => {
            const row = page.sessions.find((s) => s.id === created.id);
            return row !== undefined &&
              row.status === "idle" &&
              close(row.costTotal, (messages + 1) * COST)
              ? row.costTotal
              : undefined;
          }),
        ),
        `${name}'s cost in the index`,
      );
      observed.sessions[name] = { id: created.id, costTotal };
    });

  yield* run("fix-1", "fix the parser bug", 1, REPO);
  yield* run("fix-2", "fix the lexer crash", 1, REPO);
  yield* run("fix-3", "fix the failing build", 2, REPO);
  yield* run("fix-4", "fix the broken import", 3, REPO);
  yield* run("feature", "add a cost column to the list", 1, REPO);
  yield* run("other-fix", "fix the api bug", 4, OTHER);
  assert(
    "the runs cost what their requests did: 2, 2, 3, 4, 2 and 5 cents",
    JSON.stringify(
      Object.values(observed.sessions).map((s) =>
        Math.round(s.costTotal * 100),
      ),
    ) === JSON.stringify([2, 2, 3, 4, 2, 5]),
    JSON.stringify(observed.sessions),
  );

  // --- predict ----------------------------------------------------------------------------------
  // A fix on REPO: its four fixes, [0.02, 0.02, 0.03, 0.04] → p10 0.02, median 0.025, p90 at
  // position 2.7 → 0.03 + 0.7 × 0.01 = 0.037. Only the first line of the prompt is read.
  const fix = yield* client.predictCost({
    prompt: "fix the flaky test\n\nit fails one run in ten",
    repo: REPO,
  });
  observed.answers["fix"] = fix;
  assert(
    "a fix on the repo is predicted from the repo's fixes on the server's model",
    fix.shape === "fix" &&
      fix.basis === "repo+model+shape" &&
      fix.comparables === 4 &&
      fix.history === 6 &&
      fix.model === "faux/faux-1" &&
      fix.repo === REPO,
    JSON.stringify(fix),
  );
  assert(
    "its range is the fixes' 10th percentile, median and 90th percentile",
    close(fix.range?.low, 0.02) &&
      close(fix.range?.median, 0.025) &&
      close(fix.range?.high, 0.037),
    JSON.stringify(fix.range),
  );

  // A feature on REPO: one feature there, so every REPO session, [0.02, 0.02, 0.02, 0.03, 0.04] →
  // p10 0.02, median 0.02, p90 at position 3.6 → 0.03 + 0.6 × 0.01 = 0.036.
  const feature = yield* client.predictCost({
    prompt: "add a new flag",
    repo: REPO,
  });
  observed.answers["feature"] = feature;
  assert(
    "a feature with too few like it falls back to the repo's sessions on the model",
    feature.shape === "feature" &&
      feature.basis === "repo+model" &&
      feature.comparables === 5 &&
      close(feature.range?.median, 0.02) &&
      close(feature.range?.high, 0.036),
    JSON.stringify(feature),
  );

  const refused = yield* Effect.flip(
    client.predictCost({ prompt: "fix it", model: "faux/no-such-model" }),
  );
  assert(
    "a model the server does not serve is refused, typed, as createSession refuses it",
    refused._tag === "SessionError" &&
      refused.code === "invalid_input" &&
      refused.message.includes("faux/no-such-model"),
    `${refused._tag}: ${refused.message}`,
  );

  // --- backtest ---------------------------------------------------------------------------------
  // REPO's sessions scored, each from the whole history finished before it was created (OTHER's
  // fix ran last, so it is history to none of them). Oldest first: fix-1..3 have fewer than three
  // before them. fix-4 (0.04) from [0.02, 0.02,
  // 0.03]: median 0.02, off by half, outside [0.02, 0.028]. The feature (0.02) from the four fixes
  // on repo+model: median 0.025, off by a quarter, inside [0.02, 0.037]. Median error (0.5 + 0.25)
  // / 2 = 0.375; median absolute error (0.02 + 0.005) / 2 = 0.0125; coverage one of two.
  const repoBacktest = yield* client.backtestCost({ repo: REPO, rows: true });
  observed.answers["backtest-repo"] = repoBacktest;
  assert(
    "the repo's backtest predicts each session from the ones before it",
    repoBacktest.sessions === 5 &&
      repoBacktest.scored === 2 &&
      repoBacktest.skipped === 3 &&
      (repoBacktest.rows ?? []).map((row) => row.id).join(",") ===
        [observed.sessions["fix-4"]?.id, observed.sessions["feature"]?.id].join(
          ",",
        ),
    `scored=${repoBacktest.scored} skipped=${repoBacktest.skipped} rows=${(repoBacktest.rows ?? []).map((r) => r.title).join(" | ")}`,
  );
  assert(
    "and reports the median error, the median absolute error and the coverage",
    close(repoBacktest.medianRelativeError, 0.375) &&
      close(repoBacktest.medianAbsoluteError, 0.0125) &&
      repoBacktest.coverage === 0.5,
    `median=${repoBacktest.medianRelativeError} abs=${repoBacktest.medianAbsoluteError} coverage=${repoBacktest.coverage}`,
  );
  assert(
    "two scored sessions are too few to mean much, and the answer says so",
    repoBacktest.meaningful === false && repoBacktest.minimumSample === 20,
    `meaningful=${repoBacktest.meaningful} minimumSample=${repoBacktest.minimumSample}`,
  );

  // Everything: OTHER's fix (0.05) is scored too, from the fixes on the model (model+shape, the
  // four REPO fixes): median 0.025, off by half, outside. Errors [0.5, 0.25, 0.5] → median 0.5.
  const all = yield* client.backtestCost({ rows: true });
  observed.answers["backtest-all"] = all;
  assert(
    "the whole history's backtest adds the other repo's fix, predicted across repos",
    all.sessions === 6 &&
      all.scored === 3 &&
      close(all.medianRelativeError, 0.5) &&
      close(all.coverage, 1 / 3) &&
      all.rows?.at(-1)?.basis === "model+shape",
    `scored=${all.scored} median=${all.medianRelativeError} coverage=${all.coverage} last=${all.rows?.at(-1)?.basis}`,
  );
});

try {
  await Effect.runPromise(
    (MODE === "cap" ? capProgram : program).pipe(
      Effect.provide(protocolFor(API_URL)),
      Effect.scoped,
    ),
  );
} catch (error) {
  assert("the drive completed", false, `threw: ${String(error)}`);
}

await writeFile(
  path.join(EVIDENCE_DIR, MODE === "cap" ? "cost-capped.json" : "cost.json"),
  `${JSON.stringify(observed, null, 2)}\n`,
);

const failed = Object.entries(observed.checks).filter(
  ([, check]) => !check.passed,
);
if (failed.length > 0) {
  console.error(`\n${failed.length} required check(s) failed`);
  process.exitCode = 1;
}
