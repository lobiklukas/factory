// The card pane's plan (D10): after the planning run, the dashboard's card pane shows the plan the
// card holds — the run that declared it, its summary, its steps in order, its surfaces and its risks —
// and it agrees with the server's `getTaskPlan`. This is what a person reads before the plan approval.
//
//   node plan-pane.mjs
//
// Env:
//   WEB_URL        default http://localhost:3400
//   API_URL        default http://localhost:9400
//   BOARD_ID       the board `./up.sh` seeded
//   TASK_ID        the card `drive.sh` planned
//   EXPECT_SESSION the run whose plan the card must hold (the planning run)
//   EVIDENCE_DIR   default .verify/evidence/latest/board
//
// Writes `plan-pane.json` (the checks, the section as the page rendered it, and the server's
// `getTaskPlan` as the oracle) and `plan-pane.png`, and exits non-zero when a check fails.
//
// Uses the locally installed Chrome (channel: "chrome"), as web.mjs does.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";

const WEB_URL = process.env["WEB_URL"] ?? "http://localhost:3400";
const API_URL = process.env["API_URL"] ?? "http://localhost:9400";
const BOARD_ID = process.env["BOARD_ID"] ?? "";
const TASK_ID = process.env["TASK_ID"] ?? "";
const EXPECT_SESSION = process.env["EXPECT_SESSION"] ?? "";
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
  expectSession: EXPECT_SESSION,
  checks: {},
};
const check = (name, condition, detail) => {
  observed.checks[name] = { passed: Boolean(condition), detail };
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}  ${detail}`);
};

await mkdir(EVIDENCE_DIR, { recursive: true });

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

  const truth = await rpc("getTaskPlan", { taskId: TASK_ID });
  observed.truth = truth.value;

  await page.goto(`${WEB_URL}/boards/${BOARD_ID}?card=${TASK_ID}`, {
    waitUntil: "domcontentloaded",
  });
  // The section is rendered once the plan read answers; `[data-plan]` is the loaded plan itself.
  const rendered = await page
    .waitForSelector(`aside[data-card-pane='${TASK_ID}'] [data-plan]`, {
      timeout: 20_000,
    })
    .then(
      () => true,
      (error) => {
        observed.renderError = String(error).slice(0, 300);
        return false;
      },
    );
  const view = await page.evaluate(() => {
    const section = document.querySelector(
      "aside[data-card-pane] section[aria-label='Plan']",
    );
    const plan = section?.querySelector("[data-plan]");
    const list = (key) => {
      const node = section?.querySelector(`[data-plan-list='${key}']`);
      return node === null || node === undefined
        ? null
        : {
            count: Number(node.getAttribute("data-plan-count")),
            ordered: node.querySelector("ol") !== null,
            items: Array.from(node.querySelectorAll("[data-plan-item]")).map(
              (item) => item.textContent ?? "",
            ),
          };
    };
    return {
      section: section !== null,
      sessionId: plan?.getAttribute("data-plan") ?? null,
      revision: Number(plan?.getAttribute("data-plan-revision")),
      summary: section?.querySelector("[data-plan-summary]")?.textContent ?? null,
      steps: list("steps"),
      surfaces: list("surfaces"),
      risks: list("risks"),
    };
  });
  observed.view = view;
  await page
    .locator("aside[data-card-pane] section[aria-label='Plan']")
    .screenshot({ path: path.join(EVIDENCE_DIR, "plan-pane.png") })
    .catch(() => undefined);

  const plan = truth.value;
  check(
    "the server's plan is the planning run's",
    truth.exit === "Success" &&
      plan !== null &&
      plan.sessionId === EXPECT_SESSION &&
      plan.column === "planning",
    `getTaskPlan ${String(truth.exit)} by ${String(plan?.sessionId)} from ${String(plan?.column)}, expected ${EXPECT_SESSION}`,
  );
  check(
    "the card pane shows a Plan section with that run's plan",
    rendered && view.section && view.sessionId === EXPECT_SESSION,
    `section=${view.section} by ${String(view.sessionId)} r${String(view.revision)}`,
  );
  check(
    "the pane's summary, steps, surfaces and risks are the server's, verbatim",
    plan !== null &&
      view.summary === plan.summary &&
      view.revision === plan.revision &&
      JSON.stringify(view.steps?.items) === JSON.stringify(plan.steps) &&
      JSON.stringify(view.surfaces?.items) === JSON.stringify(plan.surfaces) &&
      JSON.stringify(view.risks?.items) === JSON.stringify(plan.risks),
    `summary "${String(view.summary)}", steps ${JSON.stringify(view.steps?.items ?? null)}, risks ${JSON.stringify(view.risks?.items ?? null)}`,
  );
  check(
    "the steps are numbered, in the order the plan declares them",
    view.steps?.ordered === true && view.surfaces?.ordered === false,
    `steps ordered=${String(view.steps?.ordered)}, surfaces ordered=${String(view.surfaces?.ordered)}`,
  );
  observed.consoleErrors = consoleErrors;
} catch (error) {
  check("the plan pane phase ran", false, String(error).slice(0, 300));
} finally {
  await browser?.close();
}

await writeFile(
  path.join(EVIDENCE_DIR, "plan-pane.json"),
  `${JSON.stringify(observed, null, 2)}\n`,
);
process.exit(Object.values(observed.checks).every((c) => c.passed) ? 0 : 1);
