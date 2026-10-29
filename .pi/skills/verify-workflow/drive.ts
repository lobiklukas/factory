#!/usr/bin/env bun
// The whole loop on one card (LOB-40): a Linear delegation in, a merged PR and Linear write-back out,
// through the instance `./up.sh` started over verify-board's — and every step a person takes, taken
// the way a person takes it: `factory board move|start|comment`, `factory approve`, `factory pr`.
//
//   bun drive.ts            (drive.sh runs it; the faux instance)
//   bun drive.ts --live     (drive.sh --live; the owner's run — Linear, GitHub and anthropic)
//
// The phases, in order, each with its recorded checks (`observed.json`):
//
//   1 delegation   an issue filed with no label starts nothing; the update that adds the mapped label
//                  is a delegation through the real `POST /webhooks/linear` (signed as Linear signs,
//                  with the instance's secret) and the label → repo rule (LOB-14, LOB-164) files
//                  exactly one card, in intake, bound to the rule's repo and `main`, and opens no
//                  session; Linear's redelivery of the same event (a new `Linear-Delivery`, a later
//                  `webhookTimestamp`) is a replay and files none
//   2 specify      a person moves the card to specifying and starts a run; it declares a spec, asks,
//                  and parks the card `needs_input` — the question is also an elicitation in Linear
//                  (T5); a person answers with `board comment` and the next run declares the spec
//   3 plan         a person moves it to planning; the planner run declares the plan; the run's own
//                  `planning → building` is refused at the plan approval gate, and a person crosses it
//   4 build        the builder run starts in its own worktree (`factory/<session-id>`, a linked
//                  worktree of the registered checkout, never this repository's tree); its `git
//                  commit` is refused by policy and an approval is requested (APPROVAL_REQUIRED); the
//                  API is killed (SIGKILL) and restarted with the approval pending; the new process
//                  still holds it, once, and a person's `factory approve` resumes the run, which
//                  commits, verifies and settles
//   5 PR           the settled run's PR step pushes `factory/<session-id>` with the CredentialProvider's
//                  token — a real `git push` to the loopback git forge, which refuses any other
//                  credential — and opens exactly one PR on the GitHub fake, whose body carries the
//                  verification evidence (LOB-16, `../verify-board/build.ts MODE=pr`); `factory pr`
//                  again is `already-open` and opens nothing; Linear has the PR as an attachment and
//                  exactly one comment carrying its link, and the issue is In Review (LOB-15)
//   6 review       the run moves the card to review; GitHub's `pull_request` opened starts a reviewer
//                  run that passes the PR's head (`../verify-board/review.ts`); the PR is merged on
//                  the fake and its signed close delivered twice moves the card to done once
//                  (`../verify-board/merge.ts`); Linear's issue is Done, still with one comment
//   7 list         `listSessions` for the card names each run's status, repo, duration and cost;
//                  `listSpend` for the repo is those costs summed; `factory ls` and `factory spend`
//                  print them
//
// Live mode drives the same phases against the real services, minus what only a fake can be told
// to do: the owner labels the issue in Linear (and relabels it, for the redelivery), the model's
// words are not asserted (only what the control plane records), GitHub's own webhooks start the
// reviewer and report the merge — the owner merges the PR in GitHub — and Linear and GitHub are read
// back over their APIs with the owner's key and token. It has never been run by an agent.
//
// Evidence: `.verify/evidence/latest/workflow/` (EVIDENCE_DIR overrides `.verify/evidence/latest`):
// `observed.json` (every check), `summary.json` (the session ids, the build run's transcript head, its
// branch, the PR URL, the Linear comment's id, the approval before and after the restart, the cost
// rows), each CLI call as `<step>.txt`, the probes' own JSON, and the three ledgers.
//
// Env: DATABASE_URL (the base URL `up.sh` was given), EVIDENCE_DIR; live mode the variables in
// `live-env.sh`, which `drive.sh --live` refuses without.
import { spawnSync } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { SQL } from "bun";
import { Effect } from "effect";
import { RpcClient } from "effect/rpc";
import { RpcApi } from "@repo/domain/Rpc";
import { SessionId } from "@repo/domain/Session";
import type { SessionSnapshot } from "@repo/domain/Session";
import { BoardInstanceId, TaskId } from "@repo/domain/Task";
import type { Task } from "@repo/domain/Task";
import { makeChecker, protocolFor } from "../verify-api/harness.ts";
import type { CheckRecord } from "../verify-api/harness.ts";

const ROOT = path.resolve(import.meta.dir, "../../..");
const RUN_DIR = path.join(ROOT, ".verify/run");
const WF_DIR = path.join(RUN_DIR, "workflow");
const BOARD_SKILL = path.join(ROOT, ".pi/skills/verify-board");
const CLI = path.join(ROOT, "apps/cli/src/index.ts");
const EVIDENCE_DIR = path.join(
  process.env["EVIDENCE_DIR"] ?? path.join(ROOT, ".verify/evidence/latest"),
  "workflow",
);

type Instance = {
  readonly mode: "faux" | "live";
  readonly apiUrl: string;
  readonly webUrl: string;
  readonly githubPort: number;
  readonly gitPort: number;
  readonly database: string;
  readonly repo: string;
  readonly label: string;
  readonly approvalRequired: string;
  readonly stamp: string;
};

if (!existsSync(path.join(WF_DIR, "instance.json"))) {
  console.error(`no workflow instance in ${WF_DIR} — run ./up.sh first`);
  process.exit(1);
}
const instance = JSON.parse(
  readFileSync(path.join(WF_DIR, "instance.json"), "utf8"),
) as Instance;
const LIVE = process.argv.includes("--live");
if (LIVE !== (instance.mode === "live")) {
  console.error(
    `the instance is ${instance.mode}; run ./drive.sh${instance.mode === "live" ? " --live" : ""}, or ./down.sh and ./up.sh${LIVE ? " --live" : ""}`,
  );
  process.exit(1);
}
const API_URL = instance.apiUrl;
const REPO = instance.repo;
const BASE_URL =
  process.env["DATABASE_URL"] ??
  "postgres://factory:factory@localhost:5442/factory_ralph";
/** The instance's own database: the probes read the logs from it. */
const SCRATCH_URL = `${BASE_URL.slice(0, BASE_URL.lastIndexOf("/"))}/${instance.database}`;
const BOARD = JSON.parse(
  readFileSync(path.join(RUN_DIR, "board.json"), "utf8"),
) as { readonly boardId: string };
const BOARD_REPO = path.join(RUN_DIR, "board-repo");
const FORGE_REPO = path.join(WF_DIR, "forge", `${REPO}.git`);
const GITHUB_LEDGER = path.join(RUN_DIR, "github-ledger.json");
const LINEAR_LEDGER = path.join(WF_DIR, "linear-ledger.json");
const GIT_LEDGER = path.join(WF_DIR, "git-ledger.json");
const PERSON = "person:verify-workflow";
/** The faux builder's one file (verify-board's `up.sh` BUILD_CHANGE). */
const CHANGED = "apps/web/src/card.ts";
const ISSUE = `WF-${instance.stamp}`;
const ISSUE_URL = `https://linear.app/acme/issue/${ISSUE}/whole-loop`;
const ISSUE_TITLE = "Export the card from the web app";
const ISSUE_DESCRIPTION =
  "Delegated from Linear by verify-workflow: the whole loop on one card.";
const ANSWER = "Postgres 16. Keep port 5442 — it is shared.";
const MINUTE = 60_000;
/** When the run began: `cycle.sh` sets it just before `up.sh`, so the report's time includes the launch. */
const STARTED_AT =
  Number(process.env["WORKFLOW_STARTED_AT"] ?? "") || Date.now();

rmSync(EVIDENCE_DIR, { recursive: true, force: true });
mkdirSync(EVIDENCE_DIR, { recursive: true });

const observed: {
  mode: string;
  instance: Instance;
  checks: Record<string, CheckRecord>;
} = { mode: instance.mode, instance, checks: {} };
const check = makeChecker(observed);
/** Evidence written without holding the drive up; awaited before the process exits. */
const pendingWrites: Array<Promise<void>> = [];
const writeLater = (name: string, text: string): void => {
  pendingWrites.push(writeFile(path.join(EVIDENCE_DIR, name), text));
};
const summary: Record<string, unknown> = { mode: instance.mode, repo: REPO };

// --- plumbing -----------------------------------------------------------------------------------

/** One `factory` command, as a person types it; its output and exit code kept as `<step>.txt`. */
const factory = (step: string, args: ReadonlyArray<string>) => {
  const run = spawnSync("bun", ["run", CLI, ...args, "--api", API_URL], {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
  const out = `${run.stdout ?? ""}${run.stderr ?? ""}`;
  const code = run.status ?? -1;
  writeLater(
    `${step}.txt`,
    `$ factory ${args.join(" ")}\n${out}\n(exit ${code})\n`,
  );
  return { code, out };
};

/** One of verify-board's probes, with the instance's database and this drive's evidence directory. */
const probe = (
  script: string,
  env: Record<string, string>,
): { code: number; out: string } => {
  const run = spawnSync("bun", [path.join(BOARD_SKILL, script)], {
    encoding: "utf8",
    env: {
      ...process.env,
      ...env,
      API_URL,
      DATABASE_URL: SCRATCH_URL,
      EVIDENCE_DIR,
    },
  });
  const out = `${run.stdout ?? ""}${run.stderr ?? ""}`;
  console.log(out.trimEnd());
  return { code: run.status ?? -1, out };
};

const git = (...args: ReadonlyArray<string>): string => {
  const run = spawnSync("git", [...args], { encoding: "utf8" });
  return run.status === 0 ? run.stdout.trim() : "";
};

const readJson = <A>(file: string): A | undefined => {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as A;
  } catch {
    return undefined;
  }
};

const sessionIdIn = (text: string): SessionId | undefined => {
  const found = /ses_[0-9a-z]{26}/.exec(text)?.[0];
  return found === undefined ? undefined : SessionId.make(found);
};

/** Poll `read` until `done` holds of what it read, or `ms` pass; return the last read either way. */
const poll = <A, E, R>(
  read: Effect.Effect<A, E, R>,
  done: (value: A) => boolean,
  ms: number,
): Effect.Effect<{ readonly value: A; readonly met: boolean }, E, R> =>
  Effect.gen(function* () {
    const deadline = Date.now() + ms;
    let value = yield* read;
    while (!done(value) && Date.now() < deadline) {
      yield* Effect.sleep(250);
      value = yield* read;
    }
    return { value, met: done(value) };
  });

// --- the third parties, read back -----------------------------------------------------------------

type LinearIssue = {
  readonly state: string;
  readonly comments: ReadonlyArray<{
    readonly id: string;
    readonly body: string;
  }>;
  readonly attachments: ReadonlyArray<string>;
};

type FakeLinearLedger = {
  readonly issues: Record<
    string,
    {
      readonly id: string;
      readonly identifier: string;
      readonly state: { readonly name: string };
      readonly comments: ReadonlyArray<string>;
      readonly attachments: ReadonlyArray<{ readonly url: string }>;
    }
  >;
  readonly agentSessions: ReadonlyArray<{
    readonly id: string;
    readonly issueId: string;
  }>;
  readonly activities: ReadonlyArray<{
    readonly agentSessionId: string;
    readonly content: Record<string, unknown>;
  }>;
  readonly requests: ReadonlyArray<{ readonly operation: string }>;
};

/**
 * The comment's id: Linear's own in live mode; on the fake, which keeps no ids, the marker line the
 * sync finds its comment by on a retry (`factory:<session>:pr`) — the comment's identity either way.
 */
const markerOf = (body: string): string =>
  /factory:ses_[0-9a-z]{26}:[a-z-]+/.exec(body)?.[0] ?? "";

const linearIssue = async (
  issueId: string,
): Promise<LinearIssue | undefined> => {
  if (!LIVE) {
    const ledger = readJson<FakeLinearLedger>(LINEAR_LEDGER);
    const issue = Object.values(ledger?.issues ?? {}).find(
      (entry) => entry.id === issueId || entry.identifier === issueId,
    );
    return issue === undefined
      ? undefined
      : {
          state: issue.state.name,
          comments: issue.comments.map((body) => ({
            id: markerOf(body),
            body,
          })),
          attachments: issue.attachments.map((attachment) => attachment.url),
        };
  }
  const response = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: process.env["LINEAR_API_KEY"] ?? "",
    },
    body: JSON.stringify({
      query:
        "query WorkflowIssue($id: String!) { issue(id: $id) { state { name } comments(first: 250) { nodes { id body } } attachments(first: 50) { nodes { url } } } }",
      variables: { id: issueId },
    }),
  });
  const body = (await response.json().catch(() => null)) as {
    data?: {
      issue?: {
        state: { name: string };
        comments: { nodes: Array<{ id: string; body: string }> };
        attachments: { nodes: Array<{ url: string }> };
      };
    };
  } | null;
  const issue = body?.data?.issue;
  return issue === undefined
    ? undefined
    : {
        state: issue.state.name,
        comments: issue.comments.nodes,
        attachments: issue.attachments.nodes.map((node) => node.url),
      };
};

type PullRow = {
  readonly url: string;
  readonly head: string;
  readonly base: string;
  readonly body: string;
};

/** The PRs whose head is `branch`, on the fake's ledger or on GitHub itself, and their bodies. */
const pullsFor = async (branch: string): Promise<ReadonlyArray<PullRow>> => {
  if (!LIVE) {
    const ledger = readJson<{
      readonly requests: ReadonlyArray<{
        readonly method: string;
        readonly path: string;
        readonly body?: { readonly head?: string; readonly body?: string };
      }>;
      readonly pulls: ReadonlyArray<{
        readonly url: string;
        readonly head: string;
        readonly base: string;
      }>;
    }>(GITHUB_LEDGER);
    const posted = (ledger?.requests ?? []).find(
      (request) =>
        request.method === "POST" &&
        request.path === `/repos/${REPO}/pulls` &&
        request.body?.head === branch,
    );
    return (ledger?.pulls ?? [])
      .filter((pull) => pull.head === branch)
      .map((pull) => ({ ...pull, body: posted?.body?.body ?? "" }));
  }
  const owner = REPO.split("/")[0] ?? "";
  const response = await fetch(
    `https://api.github.com/repos/${REPO}/pulls?state=all&head=${owner}:${branch}`,
    {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${process.env["GITHUB_TOKEN"] ?? ""}`,
      },
    },
  );
  const pulls = (await response.json().catch(() => [])) as Array<{
    html_url: string;
    head: { ref: string };
    base: { ref: string };
    body: string | null;
  }>;
  return Array.isArray(pulls)
    ? pulls.map((pull) => ({
        url: pull.html_url,
        head: pull.head.ref,
        base: pull.base.ref,
        body: pull.body ?? "",
      }))
    : [];
};

/** The sha the forge holds for `ref`: the loopback bare repository, or GitHub's ref. */
const forgeSha = async (ref: string): Promise<string> => {
  if (!LIVE)
    return git(
      "--git-dir",
      FORGE_REPO,
      "rev-parse",
      "--verify",
      "--quiet",
      ref,
    );
  const response = await fetch(
    `https://api.github.com/repos/${REPO}/git/ref/${ref.replace(/^refs\//, "")}`,
    {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${process.env["GITHUB_TOKEN"] ?? ""}`,
      },
    },
  );
  const body = (await response.json().catch(() => null)) as {
    object?: { sha?: string };
  } | null;
  return body?.object?.sha ?? "";
};

/** A Linear `Issue` webhook body, shaped from Linear's docs as `../verify-api/linear.ts` writes it. */
const issueEvent = (
  action: "create" | "update",
  labels: ReadonlyArray<string>,
  updatedFrom?: Record<string, unknown>,
) => ({
  action,
  type: "Issue",
  createdAt: new Date().toISOString(),
  data: {
    id: ISSUE,
    identifier: ISSUE,
    title: ISSUE_TITLE,
    description: ISSUE_DESCRIPTION,
    url: ISSUE_URL,
    labelIds: labels.map((label) => `label-${label}`),
    labels: labels.map((label) => ({ id: `label-${label}`, name: label })),
    teamId: "team-workflow",
  },
  url: ISSUE_URL,
  ...(updatedFrom === undefined ? {} : { updatedFrom }),
  organizationId: "org-workflow",
  webhookTimestamp: Date.now(),
  webhookId: "verify-workflow-subscription",
});

/** One delivery as Linear sends it: the raw body, its HMAC with the instance's secret, a fresh id. */
const deliverLinear = async (step: string, body: unknown) => {
  const raw = JSON.stringify(body);
  const secret = readFileSync(
    path.join(WF_DIR, "linear-secret"),
    "utf8",
  ).trim();
  const delivery = randomUUID();
  const response = await fetch(`${API_URL}/webhooks/linear`, {
    method: "POST",
    headers: {
      "content-type": "application/json; charset=utf-8",
      "linear-delivery": delivery,
      "linear-event": "Issue",
      "linear-signature": createHmac("sha256", secret)
        .update(raw)
        .digest("hex"),
      "linear-timestamp": String(Date.now()),
      "user-agent": "Linear-Webhook",
    },
    body: raw,
  });
  const answer = (await response.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  await writeFile(
    path.join(EVIDENCE_DIR, `linear-${step}.json`),
    `${JSON.stringify({ delivery, status: response.status, sent: body, answer }, null, 2)}\n`,
  );
  return { status: response.status, body: answer };
};

/** How many log commits of `sessionId` hold `needle` (the log is the truth, D7). */
const commitsHolding = async (
  sessionId: string,
  needle: string,
): Promise<number> => {
  const sql = new SQL(SCRATCH_URL);
  try {
    const rows = (await sql`
      SELECT count(*)::int AS count FROM commits
      WHERE log_id = ${sessionId} AND strpos(writes::text, ${needle}) > 0
    `) as Array<{ count: number }>;
    return rows[0]?.count ?? -1;
  } finally {
    await sql.close();
  }
};

/** The approval's row in the index: the request and, once made, the decision. */
const approvalRow = async (sessionId: string, requestId: string) => {
  const sql = new SQL(SCRATCH_URL);
  try {
    const rows = (await sql`
      SELECT request_id, decision, actor, decided_at::text AS decided_at,
             requested_at::text AS requested_at
      FROM session_approvals
      WHERE session_id = ${sessionId} AND request_id = ${requestId}
    `) as Array<Record<string, unknown>>;
    return rows[0];
  } finally {
    await sql.close();
  }
};

// --- the drive ------------------------------------------------------------------------------------

const program = Effect.gen(function* () {
  const client = yield* RpcClient.make(RpcApi);
  const getTask = (taskId: TaskId) => client.getTask({ taskId });
  const getSession = (sessionId: SessionId) => client.getSession({ sessionId });
  const settled = (snapshot: SessionSnapshot) =>
    !snapshot.live.busy && snapshot.session.status !== "busy";
  /** Wait for a run to settle; a faux run takes seconds, a real one minutes. */
  const settle = (sessionId: SessionId) =>
    poll(getSession(sessionId), settled, LIVE ? 20 * MINUTE : 2 * MINUTE);
  const cards = () =>
    client.listTasks({ boardId: BoardInstanceId.make(BOARD.boardId) });
  /** A person's move, at the revision the card is at now. */
  const move = (step: string, taskId: TaskId, to: string, actor = PERSON) =>
    Effect.gen(function* () {
      const card = yield* getTask(taskId);
      return factory(step, [
        "board",
        "move",
        "--task",
        taskId,
        "--to",
        to,
        "--expect-revision",
        String(card.revision),
        "--actor",
        actor,
      ]);
    });
  const start = (step: string, taskId: TaskId, prompt: string) => {
    const started = factory(step, [
      "board",
      "start",
      "--task",
      taskId,
      "--prompt",
      prompt,
      "--actor",
      PERSON,
    ]);
    return { ...started, sessionId: sessionIdIn(started.out) };
  };

  // --- 1: delegation --------------------------------------------------------------------------
  console.log("\n# 1 delegation: a Linear issue, labelled, becomes one card");
  let taskId: TaskId | undefined;
  if (!LIVE) {
    const filed = yield* Effect.promise(() =>
      deliverLinear("filed", issueEvent("create", [])),
    );
    check(
      "an issue filed with no label is answered and starts nothing",
      filed.status === 200 &&
        filed.body?.["status"] === "skipped" &&
        (yield* cards()).length === 0,
      `status=${filed.status} answer=${JSON.stringify(filed.body)}`,
    );
    const labelled = issueEvent("update", [instance.label], { labelIds: [] });
    const delegated = yield* Effect.promise(() =>
      deliverLinear("delegated", labelled),
    );
    const onBoard = yield* cards();
    const card = onBoard[0];
    taskId = card?.id;
    check(
      "the update that adds the mapped label files exactly one card in intake, and opens no session",
      delegated.status === 200 &&
        delegated.body?.["status"] === "processed" &&
        delegated.body["replayed"] === false &&
        delegated.body["sessionId"] === undefined &&
        delegated.body["taskId"] === card?.id &&
        onBoard.length === 1 &&
        card?.column === "intake",
      `answer=${JSON.stringify(delegated.body)} cards=${onBoard.length} column=${card?.column ?? "none"}`,
    );
    check(
      "the card is the issue's: its ref, title, body and link",
      card?.externalRef === `linear:${ISSUE}` &&
        card.title === ISSUE_TITLE &&
        card.body === ISSUE_DESCRIPTION &&
        card.externalUrl === ISSUE_URL,
      `ref=${card?.externalRef ?? "none"} url=${card?.externalUrl ?? "none"}`,
    );
    const redelivered = yield* Effect.promise(() =>
      deliverLinear("redelivered", {
        ...labelled,
        webhookTimestamp: Date.now() + MINUTE,
      }),
    );
    const afterReplay = yield* cards();
    check(
      "Linear's redelivery of the same event (new delivery id, later timestamp) is a replay and files no second card",
      redelivered.status === 200 &&
        redelivered.body?.["replayed"] === true &&
        afterReplay.length === 1 &&
        afterReplay[0]?.id === card?.id,
      `answer=${JSON.stringify(redelivered.body)} cards=${afterReplay.length}`,
    );
  } else {
    console.log(
      `\n>>> In Linear, add the label "${instance.label}" to an issue now (waiting up to 15 minutes).\n`,
    );
    const filed = yield* poll(cards(), (list) => list.length > 0, 15 * MINUTE);
    taskId = filed.value[0]?.id;
    check(
      "a Linear delegation files exactly one card in intake",
      filed.met &&
        filed.value.length === 1 &&
        filed.value[0]?.column === "intake",
      `cards=${filed.value.length}`,
    );
    console.log(
      `\n>>> Now remove the label "${instance.label}" from that issue and add it again; the drive watches for 3 minutes.\n`,
    );
    // A replay writes no row of its own (the claim is keyed by the issue), so what is observable is
    // the absence of a second card, for long enough that Linear's delivery has arrived.
    const second = yield* poll(cards(), (list) => list.length > 1, 3 * MINUTE);
    check(
      "a second delivery of the delegation files no second card",
      !second.met && second.value.length === 1,
      `cards=${second.value.length}`,
    );
  }
  if (taskId === undefined) {
    return yield* Effect.die(
      new Error("no card: the rest of the loop proves nothing"),
    );
  }
  const TASK = taskId;
  const delegatedCard = yield* getTask(TASK);
  summary["taskId"] = TASK;
  summary["externalRef"] = delegatedCard.externalRef;
  const issueId = (delegatedCard.externalRef ?? "").replace(/^linear:/, "");
  summary["linearIssue"] = issueId;
  check(
    "the card is bound to the mapped repository and base ref",
    delegatedCard.repo === REPO && delegatedCard.baseRef === "main",
    `repo=${delegatedCard.repo ?? "none"} baseRef=${delegatedCard.baseRef ?? "none"}`,
  );
  const sessionsBefore = yield* client.listSessions({ taskId: TASK });
  check(
    "the delegation opened no session: the card waits for a person",
    sessionsBefore.sessions.length === 0,
    `sessions=${sessionsBefore.sessions.length}`,
  );

  // --- 2: specify -------------------------------------------------------------------------------
  console.log(
    "\n# 2 specify: a person starts the card; it asks, a person answers",
  );
  const toSpecifying = yield* move("move-specifying", TASK, "specifying");
  check(
    "a person moves the card to specifying",
    toSpecifying.code === 0,
    toSpecifying.out.trim().split("\n")[0] ?? "",
  );
  const specify = start("start-specify", TASK, "specify this card");
  const runs: Array<SessionId> = [];
  if (specify.sessionId !== undefined) runs.push(specify.sessionId);
  check(
    "board start opens the specifying run",
    specify.code === 0 && specify.sessionId !== undefined,
    `session=${specify.sessionId ?? "none"}`,
  );
  if (specify.sessionId !== undefined) yield* settle(specify.sessionId);
  let card: Task = yield* getTask(TASK);
  if (card.blocked?.reason === "needs_input" || !LIVE) {
    const question = (yield* client.listTaskComments({ taskId: TASK })).find(
      (comment) => comment.kind === "question",
    );
    check(
      "the run asked and parked the card needs_input, with its question on the thread",
      card.blocked?.reason === "needs_input" && question !== undefined,
      `blocked=${card.blocked?.reason ?? "no"} question=${question?.body ?? "none"}`,
    );
    if (!LIVE) {
      const ledger = readJson<FakeLinearLedger>(LINEAR_LEDGER);
      const agentSessions = (ledger?.agentSessions ?? []).filter(
        (session) =>
          session.issueId === ISSUE || session.issueId === `uuid-${ISSUE}`,
      );
      const asked = (ledger?.activities ?? []).filter((activity) =>
        agentSessions.some((session) => session.id === activity.agentSessionId),
      );
      check(
        "the question is asked in Linear too: one agent session on the issue, one elicitation carrying it (T5)",
        agentSessions.length === 1 &&
          asked.length === 1 &&
          asked[0]?.content["type"] === "elicitation" &&
          question !== undefined &&
          JSON.stringify(asked[0]?.content).includes(
            question.body.slice(0, 30),
          ),
        `agentSessions=${agentSessions.length} activities=${JSON.stringify(asked)}`,
      );
    }
    const answered = factory("answer", [
      "board",
      "comment",
      "--task",
      TASK,
      "--expect-revision",
      String(card.revision),
      "--body",
      ANSWER,
      "--actor",
      PERSON,
    ]);
    card = yield* getTask(TASK);
    check(
      "a person's board comment answers it and lifts the block",
      answered.code === 0 && card.blocked === undefined,
      `exit=${answered.code} blocked=${card.blocked?.reason ?? "no"}`,
    );
    const next = start("start-specify-next", TASK, "go on");
    if (next.sessionId !== undefined) {
      runs.push(next.sessionId);
      yield* settle(next.sessionId);
    }
    check(
      "the next specifying run starts and settles",
      next.code === 0 && next.sessionId !== undefined,
      `session=${next.sessionId ?? "none"}`,
    );
  }
  const spec = yield* client.getTaskSpec({ taskId: TASK });
  check(
    "the card carries the run's spec",
    spec !== null,
    spec === null ? "no spec" : JSON.stringify(spec).slice(0, 160),
  );

  // --- 3: plan ---------------------------------------------------------------------------------
  console.log(
    "\n# 3 plan: the planner declares a plan; only a person approves it",
  );
  const toPlanning = yield* move("move-planning", TASK, "planning");
  check(
    "a person moves the card to planning",
    toPlanning.code === 0,
    toPlanning.out.trim().split("\n")[0] ?? "",
  );
  const plan = start("start-plan", TASK, "plan this card");
  if (plan.sessionId !== undefined) {
    runs.push(plan.sessionId);
    yield* settle(plan.sessionId);
  }
  const planned = yield* client.getTaskPlan({ taskId: TASK });
  check(
    "the planner run declares the card's plan",
    plan.code === 0 && planned !== null,
    planned === null ? "no plan" : JSON.stringify(planned).slice(0, 160),
  );
  const atGate = yield* getTask(TASK);
  const byRun = yield* move(
    "move-building-by-run",
    TASK,
    "building",
    plan.sessionId ?? "ses_00000000000000000000000000",
  );
  const afterRefusal = yield* getTask(TASK);
  check(
    "the run's own planning → building is refused at the plan approval gate, and writes nothing",
    byRun.code !== 0 &&
      byRun.out.includes(
        "human_gate_required: the move planning → building crosses the plan approval gate, which only a person can make",
      ) &&
      afterRefusal.column === "planning" &&
      afterRefusal.revision === atGate.revision,
    `exit=${byRun.code} column=${afterRefusal.column} revision=${afterRefusal.revision}`,
  );
  const approvePlan = yield* move("move-building", TASK, "building");
  check(
    "a person crosses plan approval: the card is in building",
    approvePlan.code === 0 && (yield* getTask(TASK)).column === "building",
    approvePlan.out.trim().split("\n")[0] ?? "",
  );

  // --- 4: build, the gate and the restart ---------------------------------------------------------
  console.log(
    "\n# 4 build: a gated call, an approval, the API restarted under it",
  );
  const build = start(
    "start-build",
    TASK,
    LIVE
      ? "Build this card as its plan says. Commit your change with `git commit` on your branch, then verify it."
      : "build this card",
  );
  const BUILD = build.sessionId;
  if (BUILD === undefined) {
    return yield* Effect.die(new Error(`no build run: ${build.out}`));
  }
  runs.push(BUILD);
  summary["buildSessionId"] = BUILD;
  const branch = `factory/${BUILD}`;
  summary["branch"] = branch;
  const pending = yield* poll(
    Effect.all([client.listApprovals({ sessionId: BUILD }), getSession(BUILD)]),
    ([approvals, snapshot]) =>
      approvals.approvals.length > 0 && settled(snapshot),
    LIVE ? 20 * MINUTE : 2 * MINUTE,
  );
  const [pendingApprovals, gated] = pending.value;
  const request = pendingApprovals.approvals[0];
  const worktree = gated.workspace.path;
  const blockedCall = gated.entries.find(
    (entry) =>
      entry.kind === "toolResult" &&
      entry.toolName === "bash" &&
      entry.isError === true,
  );
  check(
    "the builder's gated call is refused by policy and one approval is requested",
    pending.met &&
      pendingApprovals.approvals.length === 1 &&
      (request?.action ?? "").includes(instance.approvalRequired) &&
      blockedCall !== undefined,
    `approvals=${JSON.stringify(pendingApprovals.approvals)} refused=${blockedCall?.text.slice(0, 160) ?? "none"}`,
  );
  check(
    "the run is parked on it: the call did not run and no PR was opened",
    (LIVE ||
      git("-C", worktree, "rev-list", "--count", "main..HEAD") === "0") &&
      gated.session.prUrl === undefined &&
      (yield* Effect.promise(() => pullsFor(branch))).length === 0,
    `commits=${git("-C", worktree, "rev-list", "--count", "main..HEAD")} pr=${gated.session.prUrl ?? "none"}`,
  );
  const commonDir = path.resolve(
    worktree,
    git("-C", worktree, "rev-parse", "--git-common-dir"),
  );
  check(
    "the run works in its own worktree on factory/<session-id>, a checkout of the registered repo, not this tree",
    gated.workspace.branch === branch &&
      git("-C", worktree, "rev-parse", "--abbrev-ref", "HEAD") === branch &&
      git("-C", worktree, "rev-parse", "--show-toplevel") ===
        path.resolve(worktree) &&
      commonDir === path.join(BOARD_REPO, ".git") &&
      path.resolve(worktree) !== ROOT,
    `worktree=${worktree} common=${commonDir}`,
  );
  const requestId = request?.requestId ?? "";
  const before = {
    request,
    row: yield* Effect.promise(() => approvalRow(BUILD, requestId)),
    commits: yield* Effect.promise(() => commitsHolding(BUILD, requestId)),
    apiPid: readFileSync(path.join(RUN_DIR, "api.pid"), "utf8").trim(),
  };
  summary["approvalBeforeRestart"] = before;
  const restart = spawnSync(
    path.join(ROOT, ".pi/skills/verify-workflow/restart-api.sh"),
    ["KILL"],
    {
      encoding: "utf8",
      env: { ...process.env, DATABASE_URL: BASE_URL },
    },
  );
  writeLater(
    "restart-api.txt",
    `${restart.stdout}${restart.stderr}(exit ${restart.status})\n`,
  );
  const afterPid = readFileSync(path.join(RUN_DIR, "api.pid"), "utf8").trim();
  check(
    "the API is killed (SIGKILL) mid-run and a new process serves the instance",
    restart.status === 0 && afterPid !== before.apiPid,
    `${restart.stdout.trim()} ${restart.stderr.trim()}`.trim(),
  );
  const listed = factory("approvals", ["approvals", "--session", BUILD]);
  const survived = yield* client.listApprovals({ sessionId: BUILD });
  const commitsAfter = yield* Effect.promise(() =>
    commitsHolding(BUILD, requestId),
  );
  check(
    "the approval survived the restart: still pending, still one request in the log",
    survived.approvals.length === 1 &&
      survived.approvals[0]?.requestId === requestId &&
      listed.code === 0 &&
      listed.out.includes(requestId) &&
      commitsAfter === before.commits &&
      before.commits >= 1,
    `pending=${survived.approvals.map((a) => a.requestId).join(",")} commits=${before.commits}→${commitsAfter}`,
  );
  const approved = factory("approve", [
    "approve",
    BUILD,
    "--id",
    requestId,
    "--actor",
    PERSON,
  ]);
  const decided = yield* Effect.promise(() => approvalRow(BUILD, requestId));
  summary["approvalAfterRestart"] = { row: decided, cli: approved.out.trim() };
  check(
    "a person approves it in the new process, and the decision is recorded with who made it",
    approved.code === 0 &&
      decided?.["decision"] === "approved" &&
      decided["actor"] === PERSON,
    `exit=${approved.code} row=${JSON.stringify(decided)}`,
  );

  // --- 5: push and PR -------------------------------------------------------------------------
  console.log(
    "\n# 5 PR: the push, one PR with evidence, a retry, the Linear write-back",
  );
  const prSettled = probe("build.ts", {
    MODE: "settled",
    SESSION_ID: BUILD,
    TASK_ID: TASK,
  });
  const prUrl = /^pr +(\S+)$/m.exec(prSettled.out)?.[1] ?? "";
  summary["prUrl"] = prUrl;
  check(
    "the resumed run commits, verifies and settles, and its PR is opened with no operator call",
    prSettled.code === 0 && prUrl !== "",
    prUrl || prSettled.out.trim().split("\n").at(-1) || "no PR",
  );
  const built = yield* getSession(BUILD);
  const tip = git("-C", worktree, "rev-parse", "HEAD");
  check(
    "the change is committed on the run's branch in its worktree, and this repository's tree is untouched",
    (LIVE || existsSync(path.join(worktree, CHANGED))) &&
      git("-C", worktree, "rev-list", "--count", "main..HEAD") !== "0" &&
      !existsSync(path.join(ROOT, CHANGED)),
    `tip=${tip} commits=${git("-C", worktree, "rev-list", "--count", "main..HEAD")}`,
  );
  const pushed = yield* Effect.promise(() => forgeSha(`refs/heads/${branch}`));
  check(
    "exactly the run's branch was pushed: the forge holds factory/<session-id> at the worktree's tip",
    pushed !== "" && pushed === tip,
    `forge=${pushed || "none"} tip=${tip}`,
  );
  if (!LIVE) {
    const gitLedger = readJson<{
      readonly requests: ReadonlyArray<{
        readonly method: string;
        readonly service?: string;
        readonly credential: string;
      }>;
    }>(GIT_LEDGER);
    const sent = (gitLedger?.requests ?? []).filter(
      (row) => row.credential !== "none",
    );
    const pushes = sent.filter(
      (row) => row.method === "POST" && row.service === "git-receive-pack",
    );
    check(
      "the push is a real git push with the CredentialProvider's token, and no other credential reached the forge",
      pushes.length > 0 &&
        pushes.every((row) => row.credential === "token") &&
        sent.every((row) => row.credential === "token"),
      `receive-pack=${pushes.length} authenticated=${sent.length}`,
    );
    const prBody = probe("build.ts", {
      MODE: "pr",
      SESSION_ID: BUILD,
      PR_URL: prUrl,
      LEDGER: GITHUB_LEDGER,
      REPO,
      CHANGED,
    });
    check(
      "one create request, one PR on the forge, its body carrying the verification evidence (build.ts MODE=pr)",
      prBody.code === 0,
      "see build-pr.json",
    );
  }
  const retried = factory("pr-retry", ["pr", BUILD]);
  const pulls = yield* Effect.promise(() => pullsFor(branch));
  check(
    "factory pr again opens nothing: already-open, and the forge still has exactly one PR",
    retried.code === 0 &&
      /^outcome +already-open$/m.test(retried.out) &&
      pulls.length === 1 &&
      pulls[0]?.url === prUrl,
    `retry=${retried.out.trim().replace(/\n/g, " | ")} pulls=${pulls.length}`,
  );
  check(
    "the PR body has the evidence block: the changed files and the verification",
    (pulls[0]?.body ?? "").includes("## Verification") &&
      (pulls[0]?.body ?? "").includes("## Changed files") &&
      (LIVE || (pulls[0]?.body ?? "").includes("### `verify-web`: exit 0")),
    (pulls[0]?.body ?? "")
      .split("\n")
      .filter((line) => line.startsWith("#"))
      .join(" | "),
  );
  const marker = `factory:${BUILD}:pr`;
  const inReview = yield* poll(
    Effect.promise(() => linearIssue(issueId)),
    (issue) => issue?.state === "In Review",
    LIVE ? 2 * MINUTE : 30_000,
  );
  const prComments = (inReview.value?.comments ?? []).filter((comment) =>
    comment.body.includes(prUrl),
  );
  summary["linearCommentId"] = prComments[0]?.id ?? "";
  check(
    "Linear has the PR: the issue moved to In Review, the PR attached, one comment carrying its link",
    inReview.met &&
      prUrl !== "" &&
      (inReview.value?.attachments ?? []).filter((url) => url === prUrl)
        .length === 1 &&
      prComments.length === 1 &&
      (prComments[0]?.body ?? "").includes(marker),
    `state=${inReview.value?.state ?? "none"} attachments=${inReview.value?.attachments.length ?? 0} comments=${inReview.value?.comments.length ?? 0}`,
  );
  check(
    "the retried PR step wrote nothing more to Linear: still one comment on the issue",
    (inReview.value?.comments ?? []).length === 1,
    `comments=${(inReview.value?.comments ?? []).map((comment) => comment.id).join(",")}`,
  );

  // --- 6: review and merge ---------------------------------------------------------------------
  console.log(
    "\n# 6 review: the run hands over, the reviewer passes, the merge completes the card",
  );
  const toReview = yield* move("move-review", TASK, "review", BUILD);
  check(
    "the build run moves its card on to review",
    toReview.code === 0 && (yield* getTask(TASK)).column === "review",
    toReview.out.trim().split("\n")[0] ?? "",
  );
  if (!LIVE) {
    const head = git(
      "--git-dir",
      FORGE_REPO,
      "rev-parse",
      `refs/heads/${branch}`,
    );
    const base = git("--git-dir", FORGE_REPO, "rev-parse", "refs/heads/main");
    const secret = readFileSync(
      path.join(RUN_DIR, "webhook-secret"),
      "utf8",
    ).trim();
    const reviewed = probe("review.ts", {
      MODE: "review",
      GITHUB_WEBHOOK_SECRET: secret,
      REPO,
      PR_URL: prUrl,
      PR_NUMBER: prUrl.split("/").at(-1) ?? "0",
      ACTION: "opened",
      HEAD: head,
      HEAD_REF: branch,
      BASE_SHA: base,
      EXPECT: "pass",
      LABEL: "workflow",
    });
    const reviewer = sessionIdIn(
      /^reviewer (\S+)$/m.exec(reviewed.out)?.[1] ?? "",
    );
    if (reviewer !== undefined) runs.push(reviewer);
    check(
      "GitHub's pull_request opened starts a reviewer run that passes the PR's head (review.ts)",
      reviewed.code === 0 && reviewer !== undefined,
      `reviewer=${reviewer ?? "none"}`,
    );
    const reviewRevision = (yield* getTask(TASK)).revision;
    const merged = probe("merge.ts", {
      MODE: "merge",
      GITHUB_WEBHOOK_SECRET: secret,
      FORGE_URL: `http://127.0.0.1:${instance.githubPort}`,
      REPO,
      PR_URL: prUrl,
      TASK_ID: TASK,
      EXPECT_REVISION: String(reviewRevision),
      LABEL: "workflow",
    });
    check(
      "the PR's merge, delivered twice, moves the card to done once (merge.ts)",
      merged.code === 0,
      "see merge-workflow.json",
    );
  } else {
    console.log(
      `\n>>> GitHub's webhook starts the reviewer. Once it has passed, merge ${prUrl} in GitHub (waiting up to 30 minutes).\n`,
    );
    const done = yield* poll(
      getTask(TASK),
      (task) => task.column === "done",
      30 * MINUTE,
    );
    check(
      "the merge in GitHub moves the card to done",
      done.met,
      `column=${done.value.column}`,
    );
  }
  const shown = factory("show-done", ["board", "show", "--task", TASK]);
  check(
    "board show prints the card done",
    shown.code === 0 && /^column +done$/m.test(shown.out),
    shown.out.split("\n").find((line) => line.startsWith("column")) ?? "",
  );
  const doneIssue = yield* poll(
    Effect.promise(() => linearIssue(issueId)),
    (issue) => issue?.state === "Done",
    LIVE ? 2 * MINUTE : 30_000,
  );
  check(
    "the Linear issue is Done, with still exactly one comment: no duplicate across the whole loop",
    doneIssue.met && (doneIssue.value?.comments ?? []).length === 1,
    `state=${doneIssue.value?.state ?? "none"} comments=${(doneIssue.value?.comments ?? []).length}`,
  );

  // --- 7: the session list and the spend pane ------------------------------------------------------
  console.log(
    "\n# 7 list: status, repo, duration and cost of every run on the card",
  );
  const listedRuns = (yield* client.listSessions({ taskId: TASK, limit: 50 }))
    .sessions;
  const rows = listedRuns.map((row) => ({
    sessionId: row.id,
    status: row.status,
    repo: row.repo ?? null,
    durationMs: Date.parse(row.lastActivityAt) - Date.parse(row.createdAt),
    costTotal: row.costTotal,
    prUrl: row.prUrl ?? null,
  }));
  summary["sessions"] = rows;
  summary["sessionIds"] = runs;
  check(
    "the session list holds every run of the card: settled, on the repo, with a duration and a cost",
    runs.every((id) => rows.some((row) => row.sessionId === id)) &&
      rows.every(
        (row) =>
          row.status === "idle" &&
          row.repo === REPO &&
          row.durationMs > 0 &&
          (LIVE || row.costTotal > 0),
      ),
    rows
      .map(
        (row) =>
          `${row.sessionId} ${row.status} ${row.durationMs}ms $${row.costTotal.toFixed(2)}`,
      )
      .join("; "),
  );
  check(
    "the build run's row carries its PR",
    rows.find((row) => row.sessionId === BUILD)?.prUrl === prUrl,
    `pr=${rows.find((row) => row.sessionId === BUILD)?.prUrl ?? "none"}`,
  );
  const spend = yield* client.listSpend({});
  const repoSpend = spend.rows.filter((row) => row.repo === REPO);
  const spent = repoSpend.reduce((sum, row) => sum + row.costTotal, 0);
  const listedCost = rows.reduce((sum, row) => sum + row.costTotal, 0);
  summary["costRows"] = repoSpend;
  check(
    "the spend pane's rows for the repo add up to the session list's costs",
    repoSpend.length > 0 &&
      Math.abs(spent - listedCost) < 1e-9 &&
      (LIVE || spent > 0),
    `spend=$${spent.toFixed(4)} list=$${listedCost.toFixed(4)} rows=${repoSpend.length}`,
  );
  const ls = factory("ls", ["ls", "--limit", "50"]);
  const spendCli = factory("spend", ["spend", "--repo", REPO]);
  check(
    "factory ls and factory spend print the runs and the repo's spend",
    ls.code === 0 &&
      runs.every((id) => ls.out.includes(id)) &&
      ls.out.includes(prUrl) &&
      spendCli.code === 0 &&
      spendCli.out.includes(REPO),
    `ls rows=${runs.filter((id) => ls.out.includes(id)).length}/${runs.length}`,
  );
  summary["transcriptHead"] = built.entries.slice(0, 12).map((entry) => ({
    kind: entry.kind,
    toolName: entry.toolName ?? null,
    isError: entry.isError ?? null,
    text: entry.text.slice(0, 240),
  }));
});

const exit = await Effect.runPromiseExit(
  Effect.scoped(program).pipe(Effect.provide(protocolFor(API_URL))),
);
if (exit._tag === "Failure") {
  check("the drive ran to its end", false, String(exit.cause));
}
await Promise.all(pendingWrites);
for (const [from, to] of [
  [LINEAR_LEDGER, "linear-ledger.json"],
  [GIT_LEDGER, "git-ledger.json"],
  [GITHUB_LEDGER, "github-ledger.json"],
  [path.join(RUN_DIR, "api.log"), "api.log"],
] as const) {
  if (existsSync(from)) copyFileSync(from, path.join(EVIDENCE_DIR, to));
}
await writeFile(
  path.join(EVIDENCE_DIR, "summary.json"),
  `${JSON.stringify(summary, null, 2)}\n`,
);
await writeFile(
  path.join(EVIDENCE_DIR, "observed.json"),
  `${JSON.stringify(observed, null, 2)}\n`,
);
const failed = Object.entries(observed.checks).filter(
  ([, record]) => !record.passed,
);
const total = Object.keys(observed.checks).length;
// The run in a few lines: what the owner posts on LOB-40 after the live run (its item d).
const said = (key: string): string => {
  const value = summary[key];
  return typeof value === "string" && value !== "" ? value : "none";
};
const seconds = Math.round((Date.now() - STARTED_AT) / 1000);
const sessions = (summary["sessions"] ?? []) as ReadonlyArray<{
  readonly costTotal: number;
}>;
const cost = sessions.reduce((sum, row) => sum + row.costTotal, 0);
await writeFile(
  path.join(EVIDENCE_DIR, "report.md"),
  [
    `**verify-workflow ${instance.mode} run, ${new Date().toISOString().slice(0, 10)}** (LOB-40)`,
    "",
    `- Result: ${total - failed.length}/${total} checks passed${failed.length === 0 ? "" : ` — failed: ${failed.map(([name]) => name).join("; ")}`}`,
    `- Wall-clock: ${Math.floor(seconds / 60)}m ${seconds % 60}s (${process.env["WORKFLOW_STARTED_AT"] === undefined ? "the drive alone" : "from up.sh to the end of the drive"})`,
    `- Cost: $${cost.toFixed(4)} across ${sessions.length} sessions on ${REPO} (listSessions; listSpend agrees: ${observed.checks["the spend pane's rows for the repo add up to the session list's costs"]?.passed === true ? "yes" : "no"})`,
    `- Model backend: ${LIVE ? "anthropic" : "faux"}`,
    `- PR: ${said("prUrl")}`,
    `- Linear issue: ${said("linearIssue")}, PR comment ${said("linearCommentId")}`,
    `- Card: ${said("taskId")}, build run ${said("buildSessionId")} on ${said("branch")}`,
    "",
  ].join("\n"),
);
console.log(
  failed.length === 0
    ? `\nverify-workflow (${instance.mode}): ${total}/${total} checks passed — evidence in ${EVIDENCE_DIR}`
    : `\nverify-workflow (${instance.mode}): ${failed.length} of ${total} checks FAILED:\n${failed.map(([name]) => `  - ${name}`).join("\n")}`,
);
process.exit(failed.length === 0 ? 0 : 1);
