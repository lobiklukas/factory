// The drive's both-ways phase (LOB-87): the CLI and the browser are one board. One page, opened
// once and never reloaded, holds the drive's card while the terminal moves it, and then makes the
// next move itself for the terminal to read back.
//
//   node both-ways.mjs      # started in the background by drive.sh, which answers its signals
//
// The two halves run in two processes — the browser here, the terminal in drive.sh's tmux pane — so
// they take turns through files in SIGNAL_DIR, each written whole (a rename) before it is read:
//
//   opened          this page shows the card where the terminal left it (`<column> <revision>`,
//                   `none` when it does not)
//   cli-moved       drive.sh: `factory board move` put the card at `<column> <revision>`
//   cli-followed    this page followed that move without a reload (`pass` | `fail`)
//   browser-move    drive.sh: make the plan approval now, from `planning` at `<revision>`
//   browser-moved   this page's move landed at `<column> <revision>` (`none` when it did not)
//
// Between `cli-followed` and `browser-move` the terminal makes the run's refused move across the
// plan approval gate and `web.mjs` reads the card in a page of its own; this page stays open
// through both, so its last check before the click is that the refusal changed nothing here either.
//
// Env:
//   WEB_URL         default http://localhost:3400
//   API_URL         default http://localhost:9400
//   BOARD_ID        the board `./up.sh` seeded
//   TASK_ID         the card `drive.sh` created and walked
//   OPEN_COLUMN     the column the card is in when the page opens (default specifying)
//   OPEN_REVISION   its revision then (required)
//   SIGNAL_DIR      where the two halves leave their signals (required)
//   SIGNAL_TIMEOUT_MS how long to wait for drive.sh's next signal (default 300000)
//   EVIDENCE_DIR    default .verify/evidence/latest/board
//
// Writes `both-ways.json` (every check, what the page rendered at each step, the page's own
// `moveTask` requests and the server's `getTask` as the oracle), `both-ways-cli.png` and
// `both-ways-browser.png`, and exits non-zero when a check fails. The card pane's own walk — the
// stale refusal in the pane, a fresh context, the run start — is `.pi/skills/verify-web`'s; this is
// the drive's card, moved by the drive's terminal.
//
// Uses the locally installed Chrome (channel: "chrome"), as web.mjs does.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";

const WEB_URL = process.env["WEB_URL"] ?? "http://localhost:3400";
const API_URL = process.env["API_URL"] ?? "http://localhost:9400";
const BOARD_ID = process.env["BOARD_ID"] ?? "";
const TASK_ID = process.env["TASK_ID"] ?? "";
const OPEN_COLUMN = process.env["OPEN_COLUMN"] ?? "specifying";
const OPEN_REVISION = Number(process.env["OPEN_REVISION"] ?? "");
const SIGNAL_DIR = process.env["SIGNAL_DIR"] ?? "";
const SIGNAL_TIMEOUT_MS = Number(process.env["SIGNAL_TIMEOUT_MS"] ?? "300000");
const EVIDENCE_DIR =
  process.env["EVIDENCE_DIR"] ?? ".verify/evidence/latest/board";
// The board re-reads every 2 s (apps/web `BOARD_POLL`); a move made elsewhere must land within a few.
const FOLLOW_TIMEOUT_MS = 15_000;
// A cold dev server's first page load and board read take longer than a poll; the first read gets more.
const OPEN_TIMEOUT_MS = 30_000;
// The person the dashboard moves as (apps/web `DASHBOARD_ACTOR`), B5: a person may cross a gate.
const DASHBOARD_ACTOR = "dashboard";
// One oracle read; the API answers in milliseconds, so this only bounds an API that went away.
const RPC_TIMEOUT_MS = 10_000;

/** One RPC call from the drive process, the oracle the page is compared with (NDJSON envelope). */
const rpc = async (tag, payload) => {
  const requestId = `verify-board-${tag}-${Date.now()}`;
  try {
    const response = await fetch(`${API_URL}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/ndjson" },
      body: `${JSON.stringify({ _tag: "Request", id: requestId, tag, payload, headers: [] })}\n`,
      // An API that stops answering is a failed read, not a page process drive.sh waits on forever.
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    });
    const envelope = (await response.text())
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
    return {
      exit: envelope?.exit?._tag ?? null,
      value: envelope?.exit?.value ?? null,
    };
  } catch (error) {
    return { exit: null, value: null, error: String(error) };
  }
};

/** Leave a signal for drive.sh: written beside, then renamed, so it is never read half-written. */
const signal = async (name, body) => {
  const target = path.join(SIGNAL_DIR, name);
  await writeFile(`${target}.tmp`, `${body}\n`);
  await rename(`${target}.tmp`, target);
};

/** Wait for drive.sh's signal, or `null` once SIGNAL_TIMEOUT_MS has passed without one. */
const awaitSignal = async (name) => {
  const deadline = Date.now() + SIGNAL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      return (await readFile(path.join(SIGNAL_DIR, name), "utf8")).trim();
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  return null;
};

/** `<column> <revision>`, as both halves write a card's place. */
const place = (body) => {
  const [column, revision] = (body ?? "").split(" ");
  return { column: column ?? null, revision: Number(revision) };
};

const observed = {
  webUrl: WEB_URL,
  apiUrl: API_URL,
  boardId: BOARD_ID,
  taskId: TASK_ID,
  open: { column: OPEN_COLUMN, revision: OPEN_REVISION },
  checks: {},
};
const check = (name, condition, detail) => {
  observed.checks[name] = { passed: Boolean(condition), detail };
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}  ${detail}`);
};

await mkdir(EVIDENCE_DIR, { recursive: true });

/** The card as the page renders it: its lane, and the pane's column, revision and offered moves. */
const readCard = (page) =>
  page.evaluate((id) => {
    const card = document.querySelector(`li[data-card='${id}']`);
    const pane = document.querySelector(`aside[data-card-pane='${id}']`);
    return {
      lane:
        card?.closest("section[data-lane]")?.getAttribute("data-lane") ?? null,
      pane:
        pane === null
          ? null
          : {
              column: pane.getAttribute("data-card-pane-column"),
              revision: Number(pane.getAttribute("data-card-pane-revision")),
              moves: Array.from(pane.querySelectorAll("[data-move-to]")).map(
                (button) => ({
                  to: button.getAttribute("data-move-to"),
                  gate: button.getAttribute("data-human-gate"),
                  disabled: button.hasAttribute("disabled"),
                }),
              ),
            },
      // Lost on any navigation or reload, so its survival is the proof that none happened.
      noReload: window.__bothWaysNoReload === "kept",
    };
  }, TASK_ID);

/** Wait until the lane and the pane both show the card at `column`, `revision`. */
const waitForCardAt = (page, column, revision, timeout = FOLLOW_TIMEOUT_MS) =>
  page
    .waitForFunction(
      ({ id, column, revision }) => {
        const lane = document
          .querySelector(`li[data-card='${id}']`)
          ?.closest("section[data-lane]")
          ?.getAttribute("data-lane");
        const pane = document.querySelector(`aside[data-card-pane='${id}']`);
        return (
          lane === column &&
          pane?.getAttribute("data-card-pane-column") === column &&
          pane?.getAttribute("data-card-pane-revision") === String(revision)
        );
      },
      { id: TASK_ID, column, revision },
      { timeout },
    )
    .then(
      () => true,
      () => false,
    );

// Launched inside the try, so a browser that cannot start is a failed check in `both-ways.json`,
// not a crash that leaves no evidence; drive.sh sees the process gone and stops waiting for it.
let browser;
let browserMoved = "none";
try {
  if (SIGNAL_DIR === "") throw new Error("SIGNAL_DIR is not set");
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
  });
  const consoleErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) =>
    consoleErrors.push(`pageerror: ${String(error)}`),
  );
  // The page's own writes, read off its requests: the browser's move must be this page's
  // `moveTask`, as the person the dashboard is, not one the drive made for it.
  const moveRequests = [];
  page.on("request", (request) => {
    if (!/\/rpc\/?$/.test(request.url()) || request.method() !== "POST") return;
    for (const line of (request.postData() ?? "").split("\n")) {
      try {
        const message = JSON.parse(line);
        if (message?._tag === "Request" && message.tag === "moveTask")
          moveRequests.push(message.payload);
      } catch {
        // not an RPC envelope line
      }
    }
  });
  let navigations = 0;
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) navigations += 1;
  });

  // --- opened: the card where the terminal left it ----------------------------------------------
  await page.goto(`${WEB_URL}/boards/${BOARD_ID}?card=${TASK_ID}`, {
    waitUntil: "domcontentloaded",
  });
  const opened = await waitForCardAt(
    page,
    OPEN_COLUMN,
    OPEN_REVISION,
    OPEN_TIMEOUT_MS,
  );
  await page.evaluate(() => {
    window.__bothWaysNoReload = "kept";
  });
  const navigationsAtOpen = navigations;
  observed.opened = await readCard(page);
  check(
    "the open page shows the card where the terminal left it",
    opened &&
      Number.isInteger(OPEN_REVISION) &&
      OPEN_REVISION > 0 &&
      observed.opened.pane?.column === OPEN_COLUMN,
    `lane ${String(observed.opened.lane)}, pane ${String(observed.opened.pane?.column)} r${String(observed.opened.pane?.revision)}, expected ${OPEN_COLUMN} r${String(OPEN_REVISION)}`,
  );
  await signal(
    "opened",
    opened ? `${OPEN_COLUMN} ${String(OPEN_REVISION)}` : "none",
  );

  // --- cli → browser: `factory board move` reaches this page without a reload --------------------
  const cliBody = await awaitSignal("cli-moved");
  const cliPlace = place(cliBody);
  const truthAfterCli = await rpc("getTask", { taskId: TASK_ID });
  const followed =
    cliBody !== null &&
    (await waitForCardAt(page, cliPlace.column, cliPlace.revision));
  observed.cliToBrowser = {
    signal: cliBody,
    truth: truthAfterCli.value,
    page: await readCard(page),
    navigations: navigations - navigationsAtOpen,
  };
  await page.screenshot({
    path: path.join(EVIDENCE_DIR, "both-ways-cli.png"),
    fullPage: true,
  });
  const cliFollowed =
    followed &&
    truthAfterCli.exit === "Success" &&
    truthAfterCli.value?.column === cliPlace.column &&
    truthAfterCli.value?.revision === cliPlace.revision &&
    observed.cliToBrowser.page.noReload &&
    observed.cliToBrowser.navigations === 0;
  check(
    "factory board move is visible in the browser without a reload",
    cliFollowed,
    `terminal ${String(cliBody)}, server ${String(truthAfterCli.value?.column)} r${String(truthAfterCli.value?.revision)}, page ${String(observed.cliToBrowser.page.pane?.column)} r${String(observed.cliToBrowser.page.pane?.revision)}, no reload: ${String(observed.cliToBrowser.page.noReload)}, navigations ${String(observed.cliToBrowser.navigations)}`,
  );
  await signal("cli-followed", cliFollowed ? "pass" : "fail");

  // --- browser → cli: a person's move in this page, for `factory board show` -------------------
  const moveBody = await awaitSignal("browser-move");
  const expectRevision = Number(moveBody);
  // The run's refused move happened since `cli-followed`: this page, polling all along, must still
  // hold the card where the server does — the refusal wrote nothing anywhere.
  const held =
    moveBody !== null &&
    (await waitForCardAt(page, cliPlace.column, expectRevision));
  const beforeClick = await readCard(page);
  observed.beforeBrowserMove = beforeClick;
  const toBuilding = (beforeClick.pane?.moves ?? []).find(
    (move) => move.to === "building",
  );
  check(
    "after the run's refused move the open page still holds the card where the server does",
    held && beforeClick.noReload && navigations === navigationsAtOpen,
    `signal ${String(moveBody)}, pane ${String(beforeClick.pane?.column)} r${String(beforeClick.pane?.revision)}, no reload: ${String(beforeClick.noReload)}`,
  );
  check(
    "the page offers the plan approval as a person's move",
    toBuilding?.gate === "plan approval" && toBuilding.disabled === false,
    `moves ${JSON.stringify(beforeClick.pane?.moves ?? [])}`,
  );

  let landed = false;
  try {
    await page
      .locator(`aside[data-card-pane='${TASK_ID}'] [data-move-to='building']`)
      .click({ timeout: 10_000 });
    landed = await waitForCardAt(page, "building", expectRevision + 1);
  } catch (error) {
    observed.browserMoveError = String(error).slice(0, 300);
  }
  const afterClick = await readCard(page);
  const truthAfterBrowser = await rpc("getTask", { taskId: TASK_ID });
  observed.browserToCli = {
    page: afterClick,
    truth: truthAfterBrowser.value,
    moveRequests,
  };
  await page.screenshot({
    path: path.join(EVIDENCE_DIR, "both-ways-browser.png"),
    fullPage: true,
  });
  const sent = moveRequests.at(-1);
  check(
    "the browser's move is the page's own moveTask, as the dashboard's person",
    moveRequests.length === 1 &&
      sent?.taskId === TASK_ID &&
      sent?.to === "building" &&
      sent?.expectedRevision === expectRevision &&
      sent?.actor === DASHBOARD_ACTOR,
    `sent ${JSON.stringify(moveRequests)}`,
  );
  check(
    "the move lands: the page and the server put the card in building, one revision on",
    landed &&
      afterClick.noReload &&
      truthAfterBrowser.exit === "Success" &&
      truthAfterBrowser.value?.column === "building" &&
      truthAfterBrowser.value?.revision === expectRevision + 1,
    `page ${String(afterClick.pane?.column)} r${String(afterClick.pane?.revision)}, server ${String(truthAfterBrowser.value?.column)} r${String(truthAfterBrowser.value?.revision)}`,
  );
  if (truthAfterBrowser.value?.column === "building")
    browserMoved = `building ${String(truthAfterBrowser.value.revision)}`;
  observed.consoleErrors = consoleErrors;
} catch (error) {
  check("the both-ways phase ran", false, String(error).slice(0, 300));
} finally {
  await browser?.close();
  // Always answered, so drive.sh never waits out its timeout on a browser that already gave up.
  if (SIGNAL_DIR !== "") await signal("browser-moved", browserMoved);
}

await writeFile(
  path.join(EVIDENCE_DIR, "both-ways.json"),
  `${JSON.stringify(observed, null, 2)}\n`,
);
process.exit(Object.values(observed.checks).every((c) => c.passed) ? 0 : 1);
