// Drive the "Open pull request" control (C7) the way an operator uses it, against the instance
// `pr.sh` starts, and capture evidence.
//
//   node pr.mjs      (via ./pr.sh, which owns the instance, the loopback GitHub fake and the checkouts)
//
// Env: WEB_URL, API_URL, EVIDENCE_DIR, RUN_DIR, LEDGER (the fake's ledger file), PR_GITHUB (`fake`
// or `off`: whether the API was handed a forge and a token).
//
// With a forge (`fake`), three fixture checkouts stand for the three things a branch can be, each
// carrying a marker `main` that the instance's one scripted command reads: `change` (the run commits
// a small file), `big` (the run commits more lines than the diff cap allows) and `empty` (the run
// changes nothing).
//
//   header    a session on `change`, idle, no PR: the session pane's header offers the control; a
//             scratch session offers none. Pressing it shows the PR's link in the header without a
//             reload, the button is gone, the fake holds one create request for the session's branch
//             and the link is the fake's PR and the one `getSession` records; a reload keeps it
//   twice     a second session is pressed twice in quick succession, and then asked again over RPC:
//             the answer is `already-open` and the fake still holds one create request for it, and
//             nothing but that create reached the fake
//   empty     a session on `empty`: the press is refused in the words of the answer, the button stays
//             disabled with the reason beside it and a press on it sends nothing; the fake sees no
//             create request for its branch
//   cap       a session on `big`: refused in the words the numbers the server measured make
//   card      a card's run on `change`: its row in the card pane and the pane's own header both offer
//             the control; pressing the row's shows the link in the row *and* the header without a
//             reload; a card's run on `empty` shows the same reason in both, disabled in both
//
// Without a forge (`off`), the same press on a session on `change` is refused with the missing
// credential's message, verbatim, in the header and on the card's row; nothing reaches a forge.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";

const WEB_URL = process.env["WEB_URL"] ?? "http://localhost:3442";
const API_URL = process.env["API_URL"] ?? "http://localhost:9442";
const EVIDENCE_DIR =
  process.env["EVIDENCE_DIR"] ?? ".verify/evidence/latest/pr";
const RUN_DIR = path.resolve(process.env["RUN_DIR"] ?? ".verify/run/pr");
const LEDGER =
  process.env["LEDGER"] ?? path.join(RUN_DIR, "github-ledger.json");
const MODE = process.env["PR_GITHUB"] ?? "fake";

const TAG = randomBytes(4).toString("hex");
const slugOf = (kind) => `verify-pr-${TAG}/${kind}`;
const CHECKOUTS = path.join(RUN_DIR, "checkouts", TAG);

await mkdir(EVIDENCE_DIR, { recursive: true });

const observed = {
  mode: MODE,
  webUrl: WEB_URL,
  apiUrl: API_URL,
  tag: TAG,
  checks: {},
};
const assert = (name, condition, detail) => {
  observed.checks[name] = { passed: Boolean(condition), detail };
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}  ${detail}`);
  return Boolean(condition);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** One unary RPC call over the NDJSON envelope, from this process: the oracle, never the page. */
const rpcExit = async (tag, payload) => {
  const requestId = `pr-${tag}-${Date.now()}-${Math.random()}`;
  const response = await fetch(`${API_URL}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/ndjson" },
    body: `${JSON.stringify({ _tag: "Request", id: requestId, tag, payload, headers: [] })}\n`,
  });
  const text = await response.text();
  const envelope = text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .find((message) => message?.requestId === requestId);
  return envelope?.exit ?? { _tag: "Missing", text: text.slice(0, 400) };
};
const rpc = async (tag, payload) => {
  const exit = await rpcExit(tag, payload);
  if (exit._tag !== "Success") {
    throw new Error(`${tag} failed: ${JSON.stringify(exit).slice(0, 400)}`);
  }
  return exit.value;
};
/** The typed error of a failed call: the server's own words, as the page is expected to show them. */
const rpcMessage = async (tag, payload) => {
  const failure = JSON.stringify(await rpcExit(tag, payload));
  const message = /"message":"((?:[^"\\]|\\.)*)"/.exec(failure)?.[1];
  return message === undefined ? undefined : JSON.parse(`"${message}"`);
};

const git = (dir, ...args) => {
  const run = spawnSync(
    "git",
    [
      "-C",
      dir,
      "-c",
      "user.email=verify-pr@localhost",
      "-c",
      "user.name=verify-pr",
      ...args,
    ],
    { encoding: "utf8" },
  );
  if (run.status !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr}`);
};

/** A fixture checkout whose `main` carries the marker the instance's scripted command reads. */
const checkout = async (kind) => {
  const dir = path.join(CHECKOUTS, kind);
  await mkdir(dir, { recursive: true });
  spawnSync("git", ["init", "-q", "-b", "main", dir], { encoding: "utf8" });
  await writeFile(path.join(dir, "README.md"), `# ${kind}\n`);
  await writeFile(path.join(dir, ".verify-pr"), `${kind}\n`);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "fixture");
  await rpc("registerRepo", {
    repo: slugOf(kind),
    url: `https://example.invalid/${slugOf(kind)}.git`,
    localPath: dir,
  });
  return dir;
};

/** The fake's ledger, read from disk: what the forge was actually asked, the oracle for "no call". */
const ledger = () => {
  try {
    return JSON.parse(readFileSync(LEDGER, "utf8"));
  } catch {
    return { requests: [], pulls: [] };
  }
};
const createsFor = (sessionId) =>
  ledger().requests.filter(
    (request) =>
      request.method === "POST" &&
      request.body?.head === `factory/${sessionId}`,
  ).length;
const pullFor = (sessionId) =>
  ledger().pulls.find((pull) => pull.head === `factory/${sessionId}`);

/** A session on a repo whose one scripted command has run, and which is idle again. */
const runSession = async (kind, extra = {}) => {
  const session = await rpc("createSession", {
    repo: slugOf(kind),
    title: `verify-pr ${kind}`,
    ...extra,
  });
  await rpc("sendMessage", {
    sessionId: session.id,
    content: "make the change",
  });
  const deadline = Date.now() + 90_000;
  for (;;) {
    const snapshot = await rpc("getSession", { sessionId: session.id });
    const ran = snapshot.entries.some(
      (entry) => entry.kind === "toolResult" && entry.text.includes("faux-ok"),
    );
    if (ran && snapshot.session.status === "idle") return session;
    if (Date.now() > deadline)
      throw new Error(
        `session ${session.id} did not settle: ${snapshot.session.status}`,
      );
    await sleep(300);
  }
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
/** Every `openPullRequest` the page sent, so "a press on a disabled button sends nothing" is a count. */
let pageOpenCalls = 0;
const pageOpenBodies = [];
page.on("request", (request) => {
  const body = request.postDataBuffer()?.toString("utf8") ?? "";
  if (request.url().includes("/rpc") && body.includes('"openPullRequest"')) {
    pageOpenCalls += 1;
    pageOpenBodies.push(body);
  }
});
const pageOpenCallsFor = (sessionId) =>
  pageOpenBodies.filter((body) => body.includes(sessionId)).length;

const header = "header";
// The header's refusal is a line of its own under it, so it is read off the pane, not the header.
const openButton = (scope, state) =>
  page.locator(`${scope} [data-open-pr${state ? `='${state}'` : ""}]`);
const reasonOf = (scope) =>
  page.locator(`${scope} [data-open-pr-reason]`).first().textContent();
const headerReason = () => reasonOf("body");
const noReload = () => page.evaluate(() => window.__prNoReload === true);
const markPage = () =>
  page.evaluate(() => {
    window.__prNoReload = true;
  });
const openSession = async (id) => {
  await page.goto(`${WEB_URL}/sessions/${id}`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForSelector("header h1", { timeout: 20_000 });
  await markPage();
};
const openCard = async (boardId, taskId, runId) => {
  await page.goto(`${WEB_URL}/boards/${boardId}?card=${taskId}&run=${runId}`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForSelector(`li[data-run='${runId}']`, { timeout: 20_000 });
  await markPage();
};
const hrefOf = (selector) =>
  page.locator(selector).first().getAttribute("href", { timeout: 15_000 });

/** A board on one repo and a card with a run on it, started as the card pane's Start run starts it. */
const boards = new Map();
const cardRun = async (boardRepoKind, kind) => {
  // A card is on its board's repository, so each kind has a board of its own.
  if (!boards.has(boardRepoKind)) {
    boards.set(
      boardRepoKind,
      await rpc("createBoard", {
        repo: slugOf(boardRepoKind),
        definitionId: "default",
      }),
    );
  }
  const board = boards.get(boardRepoKind);
  const task = await rpc("createTask", {
    boardId: board.id,
    title: `verify-pr card ${kind}`,
    repo: slugOf(kind),
    actor: "verify-pr",
  });
  const session = await runSession(kind, {
    title: task.title,
    taskId: task.id,
    taskColumn: task.column,
  });
  return { board, task, session };
};

let exitCode = 0;
try {
  for (const kind of MODE === "fake"
    ? ["change", "empty", "big"]
    : ["change"]) {
    await checkout(kind);
  }

  if (MODE === "fake") {
    // --- header: press in the session pane ---------------------------------------------------
    const scratch = await rpc("createSession", { title: "verify-pr scratch" });
    await openSession(scratch.id);
    await sleep(800);
    assert(
      "a scratch session (no repo) is offered no control",
      (await openButton(header).count()) === 0,
      `buttons=${await openButton(header).count()}`,
    );

    const one = await runSession("change");
    await openSession(one.id);
    await openButton(header, "available").waitFor({ timeout: 15_000 });
    assert(
      "an idle, repo-bound session with no PR offers the control in its header, and no link yet",
      (await page.locator("header [data-pr-link]").count()) === 0,
      "header has [data-open-pr='available'] and no [data-pr-link]",
    );
    await page.screenshot({
      path: path.join(EVIDENCE_DIR, "pr-header-offered.png"),
      fullPage: true,
    });
    await openButton(header, "available").click();
    const href = await hrefOf("header [data-pr-link]");
    const recorded = (await rpc("getSession", { sessionId: one.id })).session
      .prUrl;
    await page.screenshot({
      path: path.join(EVIDENCE_DIR, "pr-header-opened.png"),
      fullPage: true,
    });
    observed.header = {
      session: one.id,
      href,
      recorded,
      pull: pullFor(one.id),
    };
    assert(
      "pressing it shows the PR's link in the header, without a reload",
      href !== null &&
        href === pullFor(one.id)?.url &&
        (await openButton(header).count()) === 0 &&
        (await noReload()),
      `href=${href}`,
    );
    assert(
      "the link is the one the session recorded",
      href === recorded,
      `recorded=${recorded}`,
    );
    assert(
      "the forge was asked once, for the session's own branch onto its base",
      createsFor(one.id) === 1 && pullFor(one.id)?.base === "main",
      `creates=${createsFor(one.id)} pull=${JSON.stringify(pullFor(one.id) ?? null)}`,
    );
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("header [data-pr-link]", { timeout: 15_000 });
    assert(
      "after a reload the link stays and the control does not come back",
      (await hrefOf("header [data-pr-link]")) === href &&
        (await openButton(header).count()) === 0 &&
        createsFor(one.id) === 1,
      `creates=${createsFor(one.id)}`,
    );

    // --- twice: a second press, and a second ask, make no second call ---------------------------
    const two = await runSession("change");
    await openSession(two.id);
    await openButton(header, "available").waitFor({ timeout: 15_000 });
    await openButton(header, "available").dblclick();
    await page.waitForSelector("header [data-pr-link]", { timeout: 15_000 });
    const second = await rpc("openPullRequest", {
      sessionId: two.id,
      title: "asked again",
    });
    const before = ledger().requests.length;
    const again = await rpc("openPullRequest", {
      sessionId: two.id,
      title: "asked a third time",
    });
    observed.twice = { session: two.id, second, again };
    assert(
      "a double press sends one call from the page and opens one PR: one create request for the branch",
      createsFor(two.id) === 1 &&
        ledger().pulls.filter((pull) => pull.head === `factory/${two.id}`)
          .length === 1 &&
        pageOpenCallsFor(two.id) === 1,
      `creates=${createsFor(two.id)}, page calls=${pageOpenCallsFor(two.id)}`,
    );
    assert(
      "asking again over RPC answers the recorded PR, tagged already-open",
      second.outcome === "already-open" &&
        again.outcome === "already-open" &&
        second.url === (await hrefOf("header [data-pr-link]")),
      `${second.outcome}/${again.outcome} ${second.url}`,
    );
    assert(
      "and the repeats made no second request to the forge: no create and no lookup",
      createsFor(two.id) === 1 && ledger().requests.length === before,
      `requests=${ledger().requests.length}, was ${before}`,
    );
    assert(
      "the fake saw only create requests: one per opened session, nothing else",
      ledger().requests.every((request) => request.method === "POST"),
      `requests=${ledger().requests.length}`,
    );

    // --- empty: a refusal is shown in the answer's words, and the button stays disabled -------------
    const none = await runSession("empty");
    await openSession(none.id);
    await openButton(header, "available").waitFor({ timeout: 15_000 });
    const openedBefore = pageOpenCalls;
    await openButton(header, "available").click();
    await openButton(header, "blocked").waitFor({ timeout: 15_000 });
    const noChange = await rpc("openPullRequest", {
      sessionId: none.id,
      title: "oracle",
    });
    const shownEmpty = (await headerReason())?.trim();
    const emptyWords =
      "the run changed no file against its base branch, so there is nothing to open a pull request for";
    const blockedAttrs = await openButton(header, "blocked").evaluate(
      (node) => ({
        ariaDisabled: node.getAttribute("aria-disabled"),
        title: node.getAttribute("title"),
        native: node.hasAttribute("disabled"),
      }),
    );
    await page.screenshot({
      path: path.join(EVIDENCE_DIR, "pr-header-empty.png"),
      fullPage: true,
    });
    const afterRefusal = pageOpenCalls;
    await openButton(header, "blocked").click({ force: true });
    await sleep(500);
    observed.empty = { session: none.id, noChange, shownEmpty, blockedAttrs };
    assert(
      "an empty branch is refused: the server's outcome is no-change",
      noChange.outcome === "no-change",
      JSON.stringify(noChange),
    );
    assert(
      "the header shows the refusal's reason in full, and the button is disabled with it",
      shownEmpty === emptyWords &&
        blockedAttrs.ariaDisabled === "true" &&
        blockedAttrs.title === emptyWords,
      `shown=${JSON.stringify(shownEmpty)} ${JSON.stringify(blockedAttrs)}`,
    );
    assert(
      "a press on the disabled button sends nothing, and the forge saw no create for the branch",
      afterRefusal === openedBefore + 1 &&
        pageOpenCalls === afterRefusal &&
        createsFor(none.id) === 0,
      `page calls ${openedBefore} -> ${afterRefusal} -> ${pageOpenCalls}, creates=${createsFor(none.id)}`,
    );

    // --- cap: a diff over the cap is refused in the words the measured numbers make ------------------
    const big = await runSession("big");
    await openSession(big.id);
    await openButton(header, "available").waitFor({ timeout: 15_000 });
    await openButton(header, "available").click();
    await openButton(header, "blocked").waitFor({ timeout: 15_000 });
    const over = await rpc("openPullRequest", {
      sessionId: big.id,
      title: "oracle",
    });
    const shownCap = (await headerReason())?.trim();
    const capWords = `the branch changes ${over.measured} ${over.limit}, over the cap of ${over.cap}, so no pull request was opened`;
    await page.screenshot({
      path: path.join(EVIDENCE_DIR, "pr-header-cap.png"),
      fullPage: true,
    });
    observed.cap = { session: big.id, over, shownCap };
    assert(
      "a diff over the cap is refused: the server measured it and named the cap",
      over.outcome === "over-cap" && over.measured > over.cap,
      JSON.stringify(over),
    );
    assert(
      "the header shows the measured numbers in full, disabled, and the forge saw no create",
      shownCap === capWords &&
        (await openButton(header, "blocked").getAttribute("aria-disabled")) ===
          "true" &&
        createsFor(big.id) === 0,
      `shown=${JSON.stringify(shownCap)}`,
    );

    // --- card: the run's row and the pane's header are one control's two faces ------------------------
    const open = await cardRun("change", "change");
    const row = `li[data-run='${open.session.id}']`;
    await openCard(open.board.id, open.task.id, open.session.id);
    await openButton(row, "available").waitFor({ timeout: 20_000 });
    await openButton(`[data-run-pane] ${header}`, "available").waitFor({
      timeout: 20_000,
    });
    await page.screenshot({
      path: path.join(EVIDENCE_DIR, "pr-card-offered.png"),
      fullPage: true,
    });
    assert(
      "a card's idle run offers the control on its row and in the run pane's header",
      true,
      "both [data-open-pr='available']",
    );
    await openButton(row, "available").click();
    const rowHref = await hrefOf(`${row} [data-pr-link]`);
    const paneHref = await hrefOf(`[data-run-pane] ${header} [data-pr-link]`);
    await page.screenshot({
      path: path.join(EVIDENCE_DIR, "pr-card-opened.png"),
      fullPage: true,
    });
    observed.card = { session: open.session.id, rowHref, paneHref };
    assert(
      "pressing the row's control shows the link in the row and the header, without a reload",
      rowHref !== null &&
        rowHref === paneHref &&
        rowHref === pullFor(open.session.id)?.url &&
        (await openButton(row).count()) === 0 &&
        (await openButton(`[data-run-pane] ${header}`).count()) === 0 &&
        (await noReload()),
      `row=${rowHref} header=${paneHref}`,
    );
    assert(
      "the card's run opened one PR: one create request for its branch",
      createsFor(open.session.id) === 1,
      `creates=${createsFor(open.session.id)}`,
    );

    const refused = await cardRun("empty", "empty");
    const refusedRow = `li[data-run='${refused.session.id}']`;
    await openCard(refused.board.id, refused.task.id, refused.session.id);
    await openButton(refusedRow, "available").waitFor({ timeout: 20_000 });
    await openButton(`[data-run-pane] ${header}`, "available").waitFor({
      timeout: 20_000,
    });
    await openButton(`[data-run-pane] ${header}`, "available").click();
    await openButton(refusedRow, "blocked").waitFor({ timeout: 15_000 });
    const rowReason = (await reasonOf(refusedRow))?.trim();
    const paneReason = (await reasonOf("[data-run-pane]"))?.trim();
    await page.screenshot({
      path: path.join(EVIDENCE_DIR, "pr-card-refused.png"),
      fullPage: true,
    });
    observed.cardRefused = { rowReason, paneReason };
    assert(
      "a refusal pressed in the header is shown on the row too, disabled in both, in the same words",
      rowReason === emptyWords &&
        paneReason === emptyWords &&
        (await openButton(refusedRow, "blocked").getAttribute(
          "aria-disabled",
        )) === "true" &&
        (await openButton(`[data-run-pane] ${header}`, "blocked").getAttribute(
          "aria-disabled",
        )) === "true" &&
        (await noReload()) &&
        createsFor(refused.session.id) === 0,
      `row=${JSON.stringify(rowReason)} header=${JSON.stringify(paneReason)}`,
    );
  } else {
    // --- no credential: the refusal is the server's, and nothing reaches a forge --------------------
    const one = await runSession("change");
    const oracle = await rpcMessage("openPullRequest", {
      sessionId: one.id,
      title: "oracle",
    });
    await openSession(one.id);
    await openButton(header, "available").waitFor({ timeout: 15_000 });
    await openButton(header, "available").click();
    await openButton(header, "blocked").waitFor({ timeout: 15_000 });
    const shown = (await headerReason())?.trim();
    await page.screenshot({
      path: path.join(EVIDENCE_DIR, "pr-header-credential.png"),
      fullPage: true,
    });
    observed.credential = { session: one.id, oracle, shown };
    assert(
      "the server refuses with a missing credential, naming the token and the repo",
      oracle !== undefined &&
        oracle.includes("no GITHUB_TOKEN configured") &&
        oracle.includes(slugOf("change")),
      JSON.stringify(oracle ?? null),
    );
    assert(
      "the header shows that message verbatim, and the button is disabled with it",
      shown === oracle &&
        (await openButton(header, "blocked").getAttribute("aria-disabled")) ===
          "true" &&
        (await openButton(header, "blocked").getAttribute("title")) === oracle,
      `shown=${JSON.stringify(shown)}`,
    );
    const card = await cardRun("change", "change");
    const row = `li[data-run='${card.session.id}']`;
    await openCard(card.board.id, card.task.id, card.session.id);
    await openButton(row, "available").waitFor({ timeout: 20_000 });
    await openButton(row, "available").click();
    await openButton(`[data-run-pane] ${header}`, "blocked").waitFor({
      timeout: 15_000,
    });
    const rowReason = (await reasonOf(row))?.trim();
    await page.screenshot({
      path: path.join(EVIDENCE_DIR, "pr-card-credential.png"),
      fullPage: true,
    });
    assert(
      "on a card's row the same refusal shows on the row and in the pane header",
      rowReason ===
        (await rpcMessage("openPullRequest", {
          sessionId: card.session.id,
          title: "oracle",
        })) &&
        (await reasonOf("[data-run-pane]"))?.trim() === rowReason &&
        (await noReload()),
      `row=${JSON.stringify(rowReason)}`,
    );
  }
  observed.consoleErrors = consoleErrors;
  observed.pageOpenCalls = pageOpenCalls;
} catch (error) {
  assert("the drive ran", false, String(error).slice(0, 1800));
  await page
    .screenshot({
      path: path.join(EVIDENCE_DIR, "pr-failure.png"),
      fullPage: true,
    })
    .catch(() => undefined);
} finally {
  await browser.close();
}

await writeFile(
  path.join(EVIDENCE_DIR, "observed.json"),
  `${JSON.stringify(observed, null, 2)}\n`,
);
exitCode = Object.values(observed.checks).every((c) => c.passed) ? 0 : 1;
process.exit(exitCode);
