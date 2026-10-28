// Drive the card face (C10) the way an operator reads a board, against the instance `card-face.sh`
// starts (`FAUX_SLEEP_MS`: the scripted model naps before `bash` and again before it answers, so a
// run is busy for about twice the nap), and capture evidence.
//
//   node card-face.mjs      (via ./card-face.sh, which owns the instance this drives)
//
//   bare     a card no run was started against renders no run row
//   busy     a run started on a card shows `busy` on its face within one poll interval (plus slack)
//   cost     two runs on one card show their summed spend, equal to the sum the drive reads off
//            `listTaskRuns` and `listSessions` (the oracle, asked from this process, never the page)
//   pr       a PR recorded on a run's session shows as a link on the card, `href` verbatim, within
//            one poll interval; the face never nests it in the card's own link
//   idle     the busy card's face goes idle when its run settles
//   fan-out  the page's RPC tags carry no per-card read (`getTask`, `listTaskRuns`, `getSession`,
//            `listSessions`, `listTasks`), the board is read by `listBoardCards`, and six more cards
//            cost no more calls per window than before
//
// The runs are started over the RPC, as the card pane's **Start run** does (`createSession` with the
// card named, then `sendMessage`): what is driven here is the board, and the pane is another
// feature's. The PR and the cost are written onto the run's index rows by `seed-card-face.ts`.
//
// Env: WEB_URL, API_URL, EVIDENCE_DIR, FAUX_SLEEP_MS (the nap the instance was booted with).
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const WEB_URL = process.env["WEB_URL"] ?? "http://localhost:3581";
const API_URL = process.env["API_URL"] ?? "http://localhost:9581";
const EVIDENCE_DIR =
  process.env["EVIDENCE_DIR"] ?? ".verify/evidence/latest/card-face";
const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const SEED = path.join(ROOT, ".pi/skills/verify-web/seed-card-face.ts");
/** The board's poll interval (`BOARD_POLL`, 2 s) and the slack one read plus a render may add. */
const POLL_MS = 2_000;
const WINDOW_MS = POLL_MS + 1_000;
/** A run is busy for about two naps; allow that and a margin before calling it stuck. */
const RUN_MS = Number(process.env["FAUX_SLEEP_MS"] ?? "5000") * 2 + 20_000;

await mkdir(EVIDENCE_DIR, { recursive: true });
await rm(path.join(EVIDENCE_DIR, "card-face-failure.png"), { force: true });

const observed = { webUrl: WEB_URL, apiUrl: API_URL, checks: {} };
const assert = (name, condition, detail) => {
  observed.checks[name] = { passed: Boolean(condition), detail };
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}  ${detail}`);
  return Boolean(condition);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** One unary RPC call over the NDJSON envelope, from this process: the oracle, never the page. */
const rpc = async (tag, payload) => {
  const requestId = `card-face-${tag}-${Date.now()}-${Math.random()}`;
  const response = await fetch(`${API_URL}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/ndjson" },
    body: `${JSON.stringify({ _tag: "Request", id: requestId, tag, payload, headers: [] })}\n`,
  });
  const text = await response.text();
  const exit = text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .find((message) => message?.requestId === requestId)?.exit;
  if (exit?._tag !== "Success") {
    throw new Error(`${tag} failed: ${text.slice(0, 400)}`);
  }
  return exit.value;
};

const until = async (label, check, timeoutMs = 30_000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline)
      throw new Error(`timed out waiting for ${label}`);
    await sleep(100);
  }
};

const seed = (env) => {
  const result = spawnSync("bun", ["run", SEED], {
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, ...env },
  });
  if (result.status !== 0) {
    throw new Error(
      `seed-card-face ${result.status}: ${(result.stderr ?? "").slice(0, 300)}`,
    );
  }
  return JSON.parse(result.stdout.trim());
};

const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const consoleErrors = [];
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});
page.on("pageerror", (error) =>
  consoleErrors.push(`pageerror: ${String(error)}`),
);

/** The RPC tags one request carries: the NDJSON envelope may hold several. */
const rpcTags = (request) =>
  (request.postData() ?? "").split("\n").flatMap((line) => {
    try {
      const message = JSON.parse(line);
      return message?._tag === "Request" ? [message.tag] : [];
    } catch {
      return [];
    }
  });
const RPC_PATH = /\/rpc\/?$/;
/** Every RPC tag the page sent, in order, with when. */
const sent = [];
page.on("request", (request) => {
  if (!RPC_PATH.test(request.url()) || request.method() !== "POST") return;
  for (const tag of rpcTags(request)) sent.push({ tag, at: Date.now() });
});
const histogram = (from, to) => {
  const counts = {};
  for (const entry of sent) {
    if (entry.at >= from && entry.at < to)
      counts[entry.tag] = (counts[entry.tag] ?? 0) + 1;
  }
  return counts;
};

const face = (id) => page.locator(`[data-card="${id}"] [data-card-runs]`);
const startRun = async (taskId, title) => {
  const session = await rpc("createSession", {
    requestId: `card-face-${taskId}-${Date.now()}-${Math.random()}`,
    title,
    taskId,
    taskColumn: "specifying",
    actor: "dashboard",
    repo: observed.repo,
  });
  await rpc("sendMessage", {
    sessionId: session.id,
    content: "take your time",
  });
  return session.id;
};
const sessionsOf = async (taskId) => {
  const runs = await rpc("listTaskRuns", { taskId });
  const list = await rpc("listSessions", { limit: 100 });
  return runs.map((run) => ({
    run,
    entry: list.sessions.find((entry) => entry.id === run.sessionId),
  }));
};

let exitCode = 0;
try {
  const repo = `verify-card-face/${randomBytes(6).toString("hex")}`;
  const board = seed({ REPO: repo });
  observed.repo = repo;
  observed.board = board;
  const url = `${WEB_URL}/boards/${board.boardId}`;
  const loadedAt = Date.now();
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page
    .locator(`[data-card="${board.live}"]`)
    .waitFor({ timeout: 20_000 });

  // --- bare: no run, no row ---------------------------------------------------------------------
  assert(
    "a card with no run renders no run row, and the board shows all three cards",
    (await page.locator("[data-card-runs]").count()) === 0 &&
      (await page.locator("[data-card]").count()) === 3,
    `${await page.locator("[data-card-runs]").count()} row(s), ${await page.locator("[data-card]").count()} card(s)`,
  );
  await page.screenshot({
    path: path.join(EVIDENCE_DIR, "card-face-bare.png"),
    fullPage: true,
  });

  // --- busy: a started run shows busy within one poll interval ----------------------------------
  const liveSession = await startRun(board.live, "face: live run");
  const startedAt = Date.now();
  await page
    .locator(`[data-card="${board.live}"] [data-card-run-status="busy"]`)
    .waitFor({ timeout: 20_000 });
  const busyAfterMs = Date.now() - startedAt;
  assert(
    "a card with a busy run shows busy within one poll interval",
    busyAfterMs <= WINDOW_MS,
    `${busyAfterMs}ms (poll ${POLL_MS}ms)`,
  );
  await page.screenshot({
    path: path.join(EVIDENCE_DIR, "card-face-busy.png"),
    fullPage: true,
  });
  assert(
    "the bare card still renders no run row while another card's run is busy",
    (await face(board.bare).count()) === 0,
    `${await face(board.bare).count()} row(s)`,
  );

  // --- cost: two runs' spend, summed ------------------------------------------------------------
  const first = await startRun(board.done, "face: done run 1");
  const second = await startRun(board.done, "face: done run 2");
  await until(
    "both of the done card's runs to settle",
    async () => {
      const runs = await sessionsOf(board.done);
      return runs.length === 2 && runs.every((r) => r.entry?.status === "idle");
    },
    RUN_MS,
  );
  seed({ MARK_SESSION: first, MARK_COST: "0.25" });
  seed({ MARK_SESSION: second, MARK_COST: "0.5" });
  const oracle = (await sessionsOf(board.done)).reduce(
    (sum, r) => sum + (r.entry?.costTotal ?? 0),
    0,
  );
  await page
    .locator(`[data-card="${board.done}"] [data-card-cost]`)
    .filter({ hasText: "$0.7500" })
    .waitFor({ timeout: WINDOW_MS });
  const costText = await page
    .locator(`[data-card="${board.done}"] [data-card-cost]`)
    .innerText();
  assert(
    "a card shows its runs' summed spend, equal to the sum of its sessions' costs",
    oracle === 0.75 && costText === "$0.7500",
    `face ${costText}, oracle ${oracle}`,
  );

  // --- pr: a recorded PR links from the card -----------------------------------------------------
  const prUrl = `https://github.com/verify-card-face/widgets/pull/${40 + Math.floor(Math.random() * 50)}`;
  seed({ MARK_SESSION: second, MARK_PR: prUrl, MARK_COST: "0.5" });
  const prAt = Date.now();
  const link = page.locator(`[data-card="${board.done}"] a[data-card-pr]`);
  await link.waitFor({ timeout: WINDOW_MS });
  const prAfterMs = Date.now() - prAt;
  const href = await link.getAttribute("href");
  assert(
    "a card with a PR shows the link within one poll interval",
    href === prUrl && prAfterMs <= WINDOW_MS,
    `${href} after ${prAfterMs}ms`,
  );
  assert(
    "the PR link is not inside the card's own link, and the other cards show none",
    (await page
      .locator(`[data-card="${board.done}"] a[aria-label^="Open card"] a`)
      .count()) === 0 && (await page.locator("a[data-card-pr]").count()) === 1,
    `${await page.locator("a[data-card-pr]").count()} PR link(s) on the board`,
  );
  await page.screenshot({
    path: path.join(EVIDENCE_DIR, "card-face-pr-cost.png"),
    fullPage: true,
  });

  // --- idle: the busy card's run settles ---------------------------------------------------------
  await page
    .locator(`[data-card="${board.live}"] [data-card-run-status="idle"]`)
    .waitFor({ timeout: RUN_MS });
  const liveTruth = (await sessionsOf(board.live)).map((r) => r.entry?.status);
  assert(
    "the card's face goes idle once its run settles, as the session index says",
    liveTruth.length === 1 && liveTruth[0] === "idle" && liveSession !== "",
    JSON.stringify(liveTruth),
  );

  // --- fan-out: the board is one read -----------------------------------------------------------
  const PER_CARD = [
    "getTask",
    "listTaskRuns",
    "getSession",
    "listSessions",
    "listTasks",
    "getTaskSpec",
    "listTaskComments",
  ];
  const w1From = Date.now();
  await sleep(6_000);
  const w1 = histogram(w1From, Date.now());
  seed({ MORE_BOARD: board.boardId, MORE: "6" });
  await until(
    "the six extra cards to appear",
    async () => (await page.locator("[data-card]").count()) === 9,
    WINDOW_MS,
  );
  const w2From = Date.now();
  await sleep(6_000);
  const w2 = histogram(w2From, Date.now());
  observed.rpcSinceLoad = histogram(loadedAt, Date.now());
  observed.window3Cards = w1;
  observed.window9Cards = w2;
  await page.screenshot({
    path: path.join(EVIDENCE_DIR, "card-face-nine.png"),
    fullPage: true,
  });
  const all = histogram(loadedAt, Date.now());
  assert(
    "the page sent no per-card read, and read the board with listBoardCards",
    PER_CARD.every((tag) => all[tag] === undefined) &&
      (all["listBoardCards"] ?? 0) >= 3,
    JSON.stringify(all),
  );
  // The board's own reads only: the shell's slower pollers (`getServerInfo`) land in a 6 s window or
  // miss it, which says nothing about what a card costs.
  const boardReads = (counts) =>
    Object.fromEntries(
      Object.entries(counts).filter(([tag]) =>
        ["getBoard", "listBoardCards"].includes(tag),
      ),
    );
  const [b1, b2] = [boardReads(w1), boardReads(w2)];
  const tags1 = Object.keys(b1).sort().join(",");
  const tags2 = Object.keys(b2).sort().join(",");
  const total = (counts) => Object.values(counts).reduce((a, b) => a + b, 0);
  assert(
    "nine cards cost no more calls per window than three",
    tags1 === tags2 && total(b2) <= total(b1) + 2,
    `3 cards ${JSON.stringify(w1)}; 9 cards ${JSON.stringify(w2)}`,
  );

  assert(
    "the page logged no console error",
    consoleErrors.length === 0,
    JSON.stringify(consoleErrors.slice(0, 5)),
  );
} catch (error) {
  assert("the drive ran to the end", false, String(error));
  await page
    .screenshot({
      path: path.join(EVIDENCE_DIR, "card-face-failure.png"),
      fullPage: true,
    })
    .catch(() => {});
} finally {
  observed.consoleErrors = consoleErrors;
  await writeFile(
    path.join(EVIDENCE_DIR, "observed.json"),
    `${JSON.stringify(observed, null, 2)}\n`,
  );
  await browser.close();
  exitCode = Object.values(observed.checks).every((check) => check.passed)
    ? 0
    : 1;
}
process.exit(exitCode);
