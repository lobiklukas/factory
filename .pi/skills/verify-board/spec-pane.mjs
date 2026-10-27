// The card pane's spec (LOB-238): after the specifying runs, the dashboard's card pane shows the
// spec the card holds — the run that declared it, its goal, and each list, an empty `gaps` said
// rather than hidden — and it agrees with the server's `getTaskSpec`.
//
//   node spec-pane.mjs
//
// Env:
//   WEB_URL       default http://localhost:3400
//   API_URL       default http://localhost:9400
//   BOARD_ID      the board `./up.sh` seeded
//   TASK_ID       the card `drive.sh` specified
//   EXPECT_SESSION the run whose spec the card must hold (the newest specifying run)
//   EVIDENCE_DIR  default .verify/evidence/latest/board
//
// Writes `spec-pane.json` (the checks, the section as the page rendered it, and the server's
// `getTaskSpec` as the oracle) and `spec-pane.png`, and exits non-zero when a check fails.
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

  const truth = await rpc("getTaskSpec", { taskId: TASK_ID });
  observed.truth = truth.value;

  await page.goto(`${WEB_URL}/boards/${BOARD_ID}?card=${TASK_ID}`, {
    waitUntil: "domcontentloaded",
  });
  // The section is rendered once the spec read answers; `[data-spec]` is the loaded spec itself.
  const rendered = await page
    .waitForSelector(`aside[data-card-pane='${TASK_ID}'] [data-spec]`, {
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
      "aside[data-card-pane] section[aria-label='Spec']",
    );
    const spec = section?.querySelector("[data-spec]");
    const list = (key) => {
      const node = section?.querySelector(`[data-spec-list='${key}']`);
      return node === null || node === undefined
        ? null
        : {
            count: Number(node.getAttribute("data-spec-count")),
            items: Array.from(node.querySelectorAll("[data-spec-item]")).map(
              (item) => item.textContent ?? "",
            ),
            text: node.textContent ?? "",
          };
    };
    return {
      section: section !== null,
      sessionId: spec?.getAttribute("data-spec") ?? null,
      revision: Number(spec?.getAttribute("data-spec-revision")),
      goal: section?.querySelector("[data-spec-goal]")?.textContent ?? null,
      acceptance: list("acceptance"),
      gaps: list("gaps"),
      openQuestions: list("openQuestions"),
    };
  });
  observed.view = view;
  await page
    .locator("aside[data-card-pane] section[aria-label='Spec']")
    .screenshot({ path: path.join(EVIDENCE_DIR, "spec-pane.png") })
    .catch(() => undefined);

  const spec = truth.value;
  check(
    "the server's spec is the newest specifying run's",
    truth.exit === "Success" &&
      spec !== null &&
      spec.sessionId === EXPECT_SESSION,
    `getTaskSpec ${String(truth.exit)} by ${String(spec?.sessionId)}, expected ${EXPECT_SESSION}`,
  );
  check(
    "the card pane shows a Spec section with that run's spec",
    rendered && view.section && view.sessionId === EXPECT_SESSION,
    `section=${view.section} by ${String(view.sessionId)} r${String(view.revision)}`,
  );
  check(
    "the pane's goal and acceptance are the server's, verbatim",
    spec !== null &&
      view.goal === spec.goal &&
      view.revision === spec.revision &&
      JSON.stringify(view.acceptance?.items) ===
        JSON.stringify(spec.acceptance),
    `goal "${String(view.goal)}", acceptance ${JSON.stringify(view.acceptance?.items ?? null)}`,
  );
  check(
    "the pane says the spec declares no gaps, rather than hiding the list",
    spec !== null &&
      spec.gaps.length === 0 &&
      view.gaps?.count === 0 &&
      view.gaps.text.includes("declares no gaps"),
    `gaps ${JSON.stringify(view.gaps)}`,
  );
  observed.consoleErrors = consoleErrors;
} catch (error) {
  check("the spec pane phase ran", false, String(error).slice(0, 300));
} finally {
  await browser?.close();
}

await writeFile(
  path.join(EVIDENCE_DIR, "spec-pane.json"),
  `${JSON.stringify(observed, null, 2)}\n`,
);
process.exit(Object.values(observed.checks).every((c) => c.passed) ? 0 : 1);
