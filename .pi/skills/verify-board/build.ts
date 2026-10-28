#!/usr/bin/env bun
// The facts `drive.sh`'s build phase (LOB-86) cannot read from a terminal: what the build run's log
// recorded, and what the forge was actually sent.
//
//   MODE=built SESSION_ID=… REPO=…
//                             the build run — started by `factory board start` on a card created
//                             with no repo — is bound to the board's repository REPO, on its own
//                             `factory/<session-id>` branch in a real worktree (LOB-255); and it
//                             answered and is idle, and its log holds one `verify`
//                             record over a change: the changed path the builder's script writes,
//                             verified by `verify-web`, exit 0 — the evidence the PR body and the
//                             `review` column's `verified` requirement both read
//   MODE=settled SESSION_ID=… TASK_ID=…
//                             the build run's PR is opened when its run settles (C18), with no
//                             `factory pr` and no press of Open pull request: `getSession` reports a
//                             link within the wait, and the probe prints it as `factory pr` did
//                             (`pr       <url>`). A settled run whose step opened nothing prints
//                             `error: <the run's own line>` — the transcript's `factory.pr.not-opened`
//                             (or no-change) entry — and the same sentence must be on the card's thread
//   MODE=pr SESSION_ID=… PR_URL=… LEDGER=… REPO=…
//                             the link the settled run's PR step recorded is the fake GitHub's: its ledger holds
//                             exactly one create request for the card's repo, publishing the run's
//                             own branch onto `main`, and the PR it answered has that link. The body
//                             that request carried lists the changed path under `## Changed files`
//                             and has a `## Verification` section naming the skill and its exit
//                             code; `getSession` reads the same link back
//
// The ledger is the oracle for "a real PR link": a URL the drive (or a broken command) made up is
// not in it, so the `pr` mode fails on it. An empty PR_URL — the page showed no link — fails
// every check that needs one, naming why; nothing here substitutes a link the forge did not answer.
//
// Env: API_URL, MODE, SESSION_ID, PR_URL, LEDGER, REPO, CHANGED (the path the builder writes),
// DATABASE_URL (for `built`'s log read), EVIDENCE_DIR. Writes `build-<mode>.json` (and, for `pr`,
// `pr-body.md`, the body as sent) and exits non-zero when a check fails.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { RpcApi } from "@repo/domain/Rpc";
import type { SessionId } from "@repo/domain/Session";
import { TaskId } from "@repo/domain/Task";
import { readVerifyRecords } from "@repo/harness";
import { DatabaseLive, PostgresStorage } from "@repo/storage-postgres";
import { Effect, Scope } from "effect";
import { RpcClient } from "effect/rpc";
import { SqlClient } from "effect/sql/SqlClient";
import { makeChecker, protocolFor } from "../verify-api/harness.ts";
import type { CheckRecord } from "../verify-api/harness.ts";

const API_URL = process.env["API_URL"] ?? "http://localhost:9400";
const MODE = process.env["MODE"] ?? "";
const SESSION = (process.env["SESSION_ID"] ?? "") as SessionId;
const PR_URL = process.env["PR_URL"] ?? "";
const TASK_ID = process.env["TASK_ID"] ?? "";
const LEDGER = process.env["LEDGER"] ?? "";
const REPO = process.env["REPO"] ?? "";
const CHANGED = process.env["CHANGED"] ?? "apps/web/src/card.ts";
const EVIDENCE_DIR =
  process.env["EVIDENCE_DIR"] ?? ".verify/evidence/latest/board";

const observed: {
  mode: string;
  sessionId: string;
  facts: Record<string, unknown>;
  checks: Record<string, CheckRecord>;
} = { mode: MODE, sessionId: SESSION, facts: {}, checks: {} };
const check = makeChecker(observed);

const built = Effect.gen(function* () {
  const client = yield* RpcClient.make(RpcApi);
  const started = Date.now();
  let snapshot = yield* client.getSession({ sessionId: SESSION });
  const answered = () =>
    !snapshot.live.busy &&
    snapshot.entries.some(
      (entry) => entry.kind === "assistant" && entry.text !== "",
    );
  while (!answered() && Date.now() - started < 60_000) {
    yield* Effect.sleep(100);
    snapshot = yield* client.getSession({ sessionId: SESSION });
  }
  // The card named no repo; the run is bound to the board's anyway (LOB-255), so it has a branch.
  const branch = `factory/${SESSION}`;
  const worktreeHead = (() => {
    try {
      return execFileSync(
        "git",
        ["-C", snapshot.workspace.path, "rev-parse", "--abbrev-ref", "HEAD"],
        { encoding: "utf8" },
      ).trim();
    } catch (error) {
      return `no worktree: ${String(error)}`;
    }
  })();
  observed.facts["workspace"] = snapshot.workspace;
  check(
    "the build run is bound to the board's repository, in a factory/<session-id> worktree",
    REPO !== "" &&
      snapshot.session.repo === REPO &&
      snapshot.workspace.branch === branch &&
      worktreeHead === branch,
    `repo=${snapshot.session.repo ?? "none"} (board ${REPO || "unset"}), branch=${snapshot.workspace.branch ?? "none"}, HEAD=${worktreeHead}`,
  );
  check(
    "the build run made its change, verified it and answered",
    answered(),
    `busy=${snapshot.live.busy} after ${Date.now() - started}ms`,
  );
  const records = yield* Effect.gen(function* () {
    const sql = yield* SqlClient;
    return yield* Effect.acquireUseRelease(
      Effect.promise(() => PostgresStorage.reader(sql, SESSION)),
      (storage) => readVerifyRecords(storage),
      (storage) => Effect.promise(() => storage.dispose()),
    );
  }).pipe(Effect.provide(DatabaseLive));
  observed.facts["records"] = records;
  const record = records.length === 1 ? records[0] : undefined;
  const report = record?._tag === "VerifyReport" ? record : undefined;
  check(
    "its log holds one verify record over the change the builder made",
    report !== undefined && report.changed.includes(CHANGED),
    `records=${records.length} changed=${report?.changed.join(" ") ?? "-"}`,
  );
  const results = report?.results ?? [];
  const only = results.length === 1 ? results[0] : undefined;
  check(
    "and the record is the verify-web skill, run over the web surface, exit 0",
    only?._tag === "VerifyRan" &&
      only.surface === "web" &&
      only.source === "skill" &&
      only.directory === ".pi/skills/verify-web" &&
      only.exitCode === 0,
    results
      .map(
        (r) =>
          `${r.surface}:${r._tag}${r._tag === "VerifyRan" ? `:${r.directory}:${r.exitCode}` : ""}`,
      )
      .join(" ") || "no results",
  );
});

/** The sentence a settled run's PR step leaves when it opened nothing (`notOpenedText`, C18). */
const NOT_OPENED = "the run settled and the PR step opened no PR";

const settled = Effect.gen(function* () {
  const client = yield* RpcClient.make(RpcApi);
  const started = Date.now();
  let snapshot = yield* client.getSession({ sessionId: SESSION });
  const reason = () =>
    snapshot.entries.find(
      (entry) =>
        entry.text.startsWith(NOT_OPENED) ||
        entry.text.startsWith("no change: ") ||
        entry.text.startsWith("no documentation change: "),
    )?.text;
  // Nothing asks for the PR: the drive only reads, until the step has answered one way or the other.
  while (
    snapshot.session.prUrl === undefined &&
    reason() === undefined &&
    Date.now() - started < 60_000
  ) {
    yield* Effect.sleep(200);
    snapshot = yield* client.getSession({ sessionId: SESSION });
  }
  const url = snapshot.session.prUrl;
  observed.facts["prUrl"] = url;
  observed.facts["reason"] = reason();
  observed.facts["waitedMs"] = Date.now() - started;
  check(
    "the settled build run's PR is recorded with no operator call",
    url !== undefined,
    url ??
      `no PR after ${Date.now() - started}ms: ${reason() ?? "and no line saying why"}`,
  );
  if (url !== undefined) {
    console.log(`pr       ${url}`);
    return;
  }
  const said = reason();
  console.log(
    `error: ${said ?? "the settled run recorded no PR and said nothing"}`,
  );
  // The card carries the run's sentence too (C18), so a person reading the card sees why.
  const thread =
    TASK_ID === ""
      ? []
      : yield* client.listTaskComments({ taskId: TaskId.make(TASK_ID) });
  const note = thread.find(
    (comment) =>
      comment.actor === SESSION && comment.body.startsWith(NOT_OPENED),
  );
  observed.facts["note"] = note;
  check(
    "a settled run that opened no PR says why in its transcript and on its card",
    said !== undefined &&
      note !== undefined &&
      said.includes(note.body.slice(NOT_OPENED.length)),
    `transcript=${said ?? "none"} card=${note?.body ?? "none"}`,
  );
});

type Ledger = {
  readonly requests: ReadonlyArray<{
    readonly method: string;
    readonly path: string;
    readonly body?: {
      readonly head?: string;
      readonly base?: string;
      readonly body?: string;
    };
  }>;
  readonly pulls: ReadonlyArray<{
    readonly number: number;
    readonly url: string;
    readonly head: string;
    readonly base: string;
  }>;
};

/** The section of a PR body under `heading`, up to the next `## ` heading. */
const sectionOf = (body: string, heading: string): string => {
  const start = body.indexOf(`${heading}\n`);
  if (start === -1) return "";
  const rest = body.slice(start + heading.length + 1);
  const next = rest.search(/^## /m);
  return next === -1 ? rest : rest.slice(0, next);
};

const pr = Effect.gen(function* () {
  check(
    "the settled run recorded a link (the PR path exists)",
    PR_URL !== "",
    PR_URL === "" ? "no link: see pr.txt for the reason" : PR_URL,
  );
  const ledger: Ledger | undefined =
    LEDGER !== "" && existsSync(LEDGER)
      ? (JSON.parse(readFileSync(LEDGER, "utf8")) as Ledger)
      : undefined;
  // Every drive against one instance opens a PR on the board's one repository, so this run's are
  // the requests and the PR whose head is its own branch.
  const pullsPath = `/repos/${REPO}/pulls`;
  const head = `factory/${SESSION}`;
  const posts = (ledger?.requests ?? []).filter(
    (request) =>
      request.method === "POST" &&
      request.path === pullsPath &&
      request.body?.head === head,
  );
  const ours = (ledger?.pulls ?? []).filter(
    (pull) =>
      pull.head === head &&
      pull.url.startsWith(`https://github.com/${REPO}/pull/`),
  );
  observed.facts["ledger"] = LEDGER;
  observed.facts["posts"] = posts.map(({ method, path, body }) => ({
    method,
    path,
    head: body?.head,
    base: body?.base,
  }));
  observed.facts["pulls"] = ours;
  check(
    "the fake GitHub received exactly one create request for the build run's branch",
    ledger !== undefined && posts.length === 1,
    ledger === undefined
      ? `no ledger at ${LEDGER || "(none)"}: no GitHub path was wired`
      : `POST ${pullsPath} head=${head} x${posts.length}`,
  );
  const post = posts[0];
  check(
    "publishing the build run's own branch onto main",
    post?.body?.head === head && post.body.base === "main",
    `${post?.body?.head ?? "none"} -> ${post?.body?.base ?? "none"}`,
  );
  check(
    "and the printed link is the PR the forge answered, not one made up",
    PR_URL !== "" && ours.length === 1 && ours[0]?.url === PR_URL,
    `ledger=${ours.map((pull) => pull.url).join(" ") || "none"} printed=${PR_URL || "none"}`,
  );
  const body = post?.body?.body ?? "";
  observed.facts["body"] = body;
  const changed = sectionOf(body, "## Changed files");
  check(
    "the PR body lists the non-empty diff under Changed files",
    changed.includes(CHANGED),
    changed.trim().split("\n").slice(0, 3).join(" | ") || "no section",
  );
  check(
    "and names the builder role's model as the one that made it (ROLE_MODELS)",
    body.includes("\n- Model: faux/builder\n"),
    body.split("\n").find((line) => line.startsWith("- Model:")) ??
      "no model line",
  );
  const verification = sectionOf(body, "## Verification");
  check(
    "the PR body's evidence section names the verify skill and its exit code",
    verification.includes("### `verify-web`: exit 0") &&
      verification.includes("- Exit code: 0") &&
      !verification.includes("No verification evidence"),
    verification
      .split("\n")
      .filter((line) => line.startsWith("### ") || line.startsWith("- Exit"))
      .join(" | ") || "no section",
  );
  const client = yield* RpcClient.make(RpcApi);
  const snapshot = yield* client.getSession({ sessionId: SESSION });
  check(
    "getSession reads the same link back off the build run",
    PR_URL !== "" && snapshot.session.prUrl === PR_URL,
    `prUrl=${String(snapshot.session.prUrl)}`,
  );
});

const failed = () => Object.values(observed.checks).some((c) => !c.passed);

const runScoped = <E>(
  phase: Effect.Effect<void, E, RpcClient.Protocol | Scope.Scope>,
): Promise<void> =>
  Effect.runPromise(
    Effect.scoped(phase).pipe(
      Effect.provide(protocolFor(API_URL)),
      Effect.catch((error) =>
        Effect.sync(() => {
          check(`the ${MODE} probe ran`, false, String(error));
        }),
      ),
    ),
  );

if (MODE !== "built" && MODE !== "settled" && MODE !== "pr") {
  console.error("build.ts: MODE must be one of built, settled, pr");
  process.exit(2);
}
await runScoped(MODE === "built" ? built : MODE === "settled" ? settled : pr);
await mkdir(EVIDENCE_DIR, { recursive: true });
await writeFile(
  path.join(EVIDENCE_DIR, `build-${MODE}.json`),
  `${JSON.stringify(observed, null, 2)}\n`,
);
if (MODE === "pr") {
  await writeFile(
    path.join(EVIDENCE_DIR, "pr-body.md"),
    String(observed.facts["body"] ?? ""),
  );
}
process.exit(failed() ? 1 : 0);
