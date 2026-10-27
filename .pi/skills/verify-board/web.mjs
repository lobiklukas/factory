// The drive's dashboard phase (LOB-84): after the refusals, the board in the browser agrees with
// the server about where the card sits, and offers a person the move the run was refused.
//
//   node web.mjs
//
// Env:
//   WEB_URL       default http://localhost:3400
//   API_URL       default http://localhost:9400
//   BOARD_ID      the board `./up.sh` seeded
//   TASK_ID       the card `drive.sh` created and walked
//   EXPECT_COLUMN the column the refusals must have left the card in (default planning)
//   EXPECT_REVISION the revision the last accepted move returned (required): the server and the
//                 pane must both still hold it, so a refusal that wrote a revision is caught
//   EVIDENCE_DIR  default .verify/evidence/latest/board
//
// Writes `web.json` (the checks, the lanes and the pane as the page rendered them, and the
// server's `getTask` as the oracle) and `web-board.png`, and exits non-zero when a check fails.
// The card pane's own walk — declared moves, a stale refusal in the pane, a move followed without a
// reload — is `.pi/skills/verify-web`'s; this phase only reads what the CLI's refusals left behind.
//
// Uses the locally installed Chrome (channel: "chrome"), as verify-web does.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";

const WEB_URL = process.env["WEB_URL"] ?? "http://localhost:3400";
const API_URL = process.env["API_URL"] ?? "http://localhost:9400";
const BOARD_ID = process.env["BOARD_ID"] ?? "";
const TASK_ID = process.env["TASK_ID"] ?? "";
const EXPECT_COLUMN = process.env["EXPECT_COLUMN"] ?? "planning";
const EXPECT_REVISION = Number(process.env["EXPECT_REVISION"] ?? "");
const EVIDENCE_DIR =
  process.env["EVIDENCE_DIR"] ?? ".verify/evidence/latest/board";

/** One RPC call from the drive process, the oracle the page is compared with (NDJSON envelope). */
const rpc = async (tag, payload) => {
  const requestId = `verify-board-${tag}-${Date.now()}`;
  try {
    const response = await fetch(`${API_URL}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/ndjson" },
      body: `${JSON.stringify({ _tag: "Request", id: requestId, tag, payload, headers: [] })}\n`,
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

const observed = {
  webUrl: WEB_URL,
  apiUrl: API_URL,
  boardId: BOARD_ID,
  taskId: TASK_ID,
  expectColumn: EXPECT_COLUMN,
  expectRevision: EXPECT_REVISION,
  checks: {},
};
const check = (name, condition, detail) => {
  observed.checks[name] = { passed: Boolean(condition), detail };
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}  ${detail}`);
};

await mkdir(EVIDENCE_DIR, { recursive: true });

// Launched inside the try, so a browser that cannot start is a failed check in `web.json`, not a
// crash that leaves no evidence.
let browser;
try {
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

  const truth = await rpc("getTask", { taskId: TASK_ID });
  observed.truth = truth.value;

  // The card named in the URL opens its pane beside the lanes, as a link to it would anywhere.
  await page.goto(`${WEB_URL}/boards/${BOARD_ID}?card=${TASK_ID}`, {
    waitUntil: "domcontentloaded",
  });
  const rendered = await page
    .waitForSelector(`aside[data-card-pane='${TASK_ID}']`, { timeout: 20_000 })
    .then(
      () => true,
      (error) => {
        observed.renderError = String(error).slice(0, 300);
        return false;
      },
    );
  const view = await page.evaluate((id) => {
    const card = document.querySelector(`li[data-card='${id}']`);
    const pane = document.querySelector("aside[data-card-pane]");
    return {
      lanes: Array.from(document.querySelectorAll("section[data-lane]")).map(
        (lane) => lane.getAttribute("data-lane"),
      ),
      cardLane:
        card?.closest("section[data-lane]")?.getAttribute("data-lane") ?? null,
      pane:
        pane === null
          ? null
          : {
              card: pane.getAttribute("data-card-pane"),
              column: pane.getAttribute("data-card-pane-column"),
              revision: Number(pane.getAttribute("data-card-pane-revision")),
              moves: Array.from(pane.querySelectorAll("[data-move-to]")).map(
                (button) => ({
                  to: button.getAttribute("data-move-to"),
                  gate: button.getAttribute("data-human-gate"),
                }),
              ),
            },
    };
  }, TASK_ID);
  observed.view = view;
  await page.screenshot({
    path: path.join(EVIDENCE_DIR, "web-board.png"),
    fullPage: true,
  });

  check(
    "the dashboard shows the card in the lane the refusals left it",
    rendered &&
      truth.exit === "Success" &&
      truth.value?.column === EXPECT_COLUMN &&
      view.cardLane === EXPECT_COLUMN,
    `lane ${String(view.cardLane)}, server ${String(truth.value?.column)} (${String(truth.exit)}), expected ${EXPECT_COLUMN}`,
  );
  check(
    "the card pane and the server hold the last accepted revision: no refusal wrote one",
    Number.isInteger(EXPECT_REVISION) &&
      EXPECT_REVISION > 0 &&
      view.pane !== null &&
      view.pane.card === TASK_ID &&
      view.pane.column === truth.value?.column &&
      truth.value?.revision === EXPECT_REVISION &&
      view.pane.revision === EXPECT_REVISION,
    `pane ${String(view.pane?.column)} r${String(view.pane?.revision)}, server r${String(truth.value?.revision)}, expected r${String(EXPECT_REVISION)}`,
  );
  const toBuilding = (view.pane?.moves ?? []).find(
    (move) => move.to === "building",
  );
  check(
    "a person is offered the move the run was refused, marked as the plan approval gate",
    toBuilding?.gate === "plan approval",
    `moves ${JSON.stringify(view.pane?.moves ?? [])}`,
  );
  observed.consoleErrors = consoleErrors;
} catch (error) {
  check("the dashboard phase ran", false, String(error).slice(0, 300));
} finally {
  await browser?.close();
}

await writeFile(
  path.join(EVIDENCE_DIR, "web.json"),
  `${JSON.stringify(observed, null, 2)}\n`,
);
process.exit(Object.values(observed.checks).every((c) => c.passed) ? 0 : 1);
