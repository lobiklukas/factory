// The drive's PR phase in the browser. Two modes:
//
//   PR_MODE=recorded node pr-browser.mjs   (what `drive.sh` runs since C18)
//     The build run's PR was opened when its run settled, by nobody. The card pane must show it
//     without a press: the run's row and the run pane's header carry PR_URL, and neither offers
//     "Open pull request" any more. Prints `pr       <url>` on success.
//
//   node pr-browser.mjs                    (C7's press, for a run whose PR nobody opened yet)
//     The build run's pull request is opened in the browser, from the card pane's run row, and
//     never with `factory pr`.
//
// Env:
//   WEB_URL       default http://localhost:3400
//   BOARD_ID      the board `./up.sh` seeded
//   TASK_ID       the card `drive.sh` walked to `building`
//   SESSION_ID    the card's build run (a repo-bound session on `factory/<run>`, idle)
//   EVIDENCE_DIR  default .verify/evidence/latest/board
//
// It opens `/boards/<board>?card=<card>&run=<run>`, waits for the run's row to offer "Open pull
// request", presses it, and waits for the answer. A link must appear on the row *and* in the run
// pane's header, and agree, without the page reloading. It prints what `factory pr` printed, so the
// phases after it read the link the same way:
//
//   pr       <url>            on success, exit 0
//   error: <reason>           when the control is refused or never offered, exit 1
//
// The refusal is the server's words as the page shows them: with no GitHub path (`./up.sh` with
// BOARD_GITHUB=off) the reason is the missing credential's message, and the drive prints it and
// fails, rather than a link the drive made up. Writes `pr-browser.json` and `pr-browser.png`.
//
// Uses the locally installed Chrome (channel: "chrome"), as web.mjs does.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";

const WEB_URL = process.env["WEB_URL"] ?? "http://localhost:3400";
const BOARD_ID = process.env["BOARD_ID"] ?? "";
const TASK_ID = process.env["TASK_ID"] ?? "";
const SESSION_ID = process.env["SESSION_ID"] ?? "";
const PR_MODE = process.env["PR_MODE"] ?? "press";
const PR_URL = process.env["PR_URL"] ?? "";
const EVIDENCE_DIR =
  process.env["EVIDENCE_DIR"] ?? ".verify/evidence/latest/board";

const observed = { webUrl: WEB_URL, session: SESSION_ID, checks: {} };
const check = (name, condition, detail) => {
  observed.checks[name] = { passed: Boolean(condition), detail };
  console.error(`${condition ? "PASS" : "FAIL"}  ${name}  ${detail}`);
};

await mkdir(EVIDENCE_DIR, { recursive: true });

let printed = false;
let browser;
try {
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
  });
  await page.goto(
    `${WEB_URL}/boards/${BOARD_ID}?card=${TASK_ID}&run=${SESSION_ID}`,
    { waitUntil: "domcontentloaded" },
  );
  const row = `li[data-run='${SESSION_ID}']`;
  const pane = "[data-run-pane] header";
  await page.waitForSelector(row, { timeout: 20_000 });
  await page.evaluate(() => {
    window.__prNoReload = true;
  });
  if (PR_MODE === "recorded") {
    const shown = await page
      .waitForSelector(`${row} [data-pr-link]`, { timeout: 20_000 })
      .then(
        () => true,
        () => false,
      );
    await page.screenshot({
      path: path.join(EVIDENCE_DIR, "pr-browser.png"),
      fullPage: true,
    });
    const rowHref = shown
      ? await page.locator(`${row} [data-pr-link]`).first().getAttribute("href")
      : null;
    const paneHref = await page
      .locator(`${pane} [data-pr-link]`)
      .first()
      .getAttribute("href", { timeout: 10_000 })
      .catch(() => null);
    observed.rowHref = rowHref;
    observed.paneHref = paneHref;
    check(
      "the settled run's PR is on its row and in the run pane's header, with nothing pressed",
      rowHref !== null && rowHref === PR_URL && paneHref === PR_URL,
      `row=${rowHref} header=${paneHref} recorded=${PR_URL || "none"}`,
    );
    check(
      "and neither offers Open pull request: the PR is already open",
      (await page.locator(`${row} [data-open-pr]`).count()) === 0 &&
        (await page.locator(`${pane} [data-open-pr]`).count()) === 0,
      "no [data-open-pr] on the row or in the header",
    );
    console.log(
      rowHref === null
        ? "error: the card pane's run row shows no PR link"
        : `pr       ${rowHref}`,
    );
    printed = true;
  }
  const offered =
    PR_MODE === "recorded"
      ? false
      : await page
          .waitForSelector(`${row} [data-open-pr='available']`, {
            timeout: 20_000,
          })
          .then(
            () => true,
            () => false,
          );
  if (PR_MODE !== "recorded") {
    check(
      "the build run's row offers Open pull request",
      offered,
      offered ? "[data-open-pr='available'] on the row" : "never offered",
    );
  }
  if (PR_MODE === "recorded") {
    // Done above: nothing to press.
  } else if (!offered) {
    console.log(
      "error: the card pane's run row never offered Open pull request",
    );
    printed = true;
  } else {
    await page.locator(`${row} [data-open-pr='available']`).click();
    // Either answer ends the wait: the link on the row, or the control disabled with a reason.
    const outcome = await Promise.race([
      page
        .waitForSelector(`${row} [data-pr-link]`, { timeout: 30_000 })
        .then(() => "linked"),
      page
        .waitForSelector(`${row} [data-open-pr='blocked']`, { timeout: 30_000 })
        .then(() => "blocked"),
    ]).catch(() => "none");
    await page.screenshot({
      path: path.join(EVIDENCE_DIR, "pr-browser.png"),
      fullPage: true,
    });
    if (outcome === "linked") {
      const rowHref = await page
        .locator(`${row} [data-pr-link]`)
        .first()
        .getAttribute("href");
      const paneHref = await page
        .locator(`${pane} [data-pr-link]`)
        .first()
        .getAttribute("href", { timeout: 10_000 })
        .catch(() => null);
      observed.rowHref = rowHref;
      observed.paneHref = paneHref;
      check(
        "the link is on the row and in the run pane's header, the same one, without a reload",
        rowHref !== null &&
          rowHref === paneHref &&
          (await page.evaluate(() => window.__prNoReload === true)),
        `row=${rowHref} header=${paneHref}`,
      );
      // The card's other runs (the specifying ones) are idle and repo-bound with no PR, so they
      // still offer their own control: only this run's two faces must have lost theirs.
      check(
        "the control is gone from this run's row and header once its PR is open",
        (await page.locator(`${row} [data-open-pr]`).count()) === 0 &&
          (await page.locator(`${pane} [data-open-pr]`).count()) === 0,
        "no [data-open-pr] on the row or in the header",
      );
      if (rowHref !== null) {
        console.log(`pr       ${rowHref}`);
        printed = true;
      }
    } else if (outcome === "blocked") {
      const reason = (
        await page.locator(`${row} [data-open-pr-reason]`).first().textContent()
      )?.trim();
      observed.reason = reason;
      check(
        "a refusal is shown on the row, disabled",
        reason !== undefined && reason !== "",
        reason ?? "no reason shown",
      );
      console.log(
        `error: ${reason ?? "the control was refused with no reason"}`,
      );
      printed = true;
    } else {
      console.log("error: pressing Open pull request produced no answer");
      printed = true;
    }
  }
} catch (error) {
  check("the PR phase ran", false, String(error).slice(0, 400));
} finally {
  await browser?.close();
}

await writeFile(
  path.join(EVIDENCE_DIR, "pr-browser.json"),
  `${JSON.stringify(observed, null, 2)}\n`,
);
if (!printed) console.log("error: the PR phase did not finish");
process.exit(
  Object.values(observed.checks).length > 0 &&
    Object.values(observed.checks).every((c) => c.passed)
    ? 0
    : 1,
);
