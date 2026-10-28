// The browser half of the upgrade phase (D5): the board page says when its cards pin more than one
// definition version, and the settings page's Upgrade action moves the board and migrates its cards.
//
//   MODE=notice node upgrade.mjs   the board page names each version its cards pin
//                                  ([data-board-pinned-versions] = EXPECT_VERSIONS, the text naming
//                                  each `v<n>` and the board's own) without a reload of anything
//                                  but the page itself
//   MODE=upgrade node upgrade.mjs  the board's settings page offers Upgrade ([data-board-upgrade]);
//                                  the form is set to TO_VERSION with "Also migrate the board's
//                                  cards" checked, the mapping preset to the same names
//                                  ([data-upgrade-to=<column>] = <column>); pressing it sends one
//                                  `upgradeBoard` — the page's own, at EXPECT_VERSION, with the
//                                  preset mapping and the dashboard's actor — the page says what it
//                                  did ([data-upgrade-done]) and names TO_VERSION as the pin; and the
//                                  board page no longer says its cards pin more than one version
//
// Env: WEB_URL, BOARD_ID, MODE, EXPECT_VERSIONS (notice), TO_VERSION and EXPECT_VERSION (upgrade),
// EVIDENCE_DIR (default .verify/evidence/latest/board). Writes `upgrade-web-<mode>.json` and
// `upgrade-<mode>.png`, and exits non-zero when a check fails. Uses the locally installed Chrome, as
// both-ways.mjs does.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";

const WEB_URL = process.env["WEB_URL"] ?? "http://localhost:3400";
const BOARD_ID = process.env["BOARD_ID"] ?? "";
const MODE = process.env["MODE"] ?? "";
const EXPECT_VERSIONS = process.env["EXPECT_VERSIONS"] ?? "";
const TO_VERSION = process.env["TO_VERSION"] ?? "";
const EXPECT_VERSION = process.env["EXPECT_VERSION"] ?? "";
const EVIDENCE_DIR =
  process.env["EVIDENCE_DIR"] ?? ".verify/evidence/latest/board";
// A cold dev server's first page load and board read take longer than a poll.
const OPEN_TIMEOUT_MS = 30_000;
// The person the dashboard acts as (apps/web `DASHBOARD_ACTOR`).
const DASHBOARD_ACTOR = "dashboard";

const observed = { mode: MODE, boardId: BOARD_ID, checks: {} };
let failed = false;
const check = (name, condition, detail) => {
  observed.checks[name] = { passed: Boolean(condition), detail };
  if (!condition) failed = true;
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}  ${detail}`);
};

await mkdir(EVIDENCE_DIR, { recursive: true });

let browser;
try {
  if (BOARD_ID === "" || (MODE !== "notice" && MODE !== "upgrade"))
    throw new Error("BOARD_ID and MODE=notice|upgrade must be set");
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
  });
  const consoleErrors = [];
  page.on("pageerror", (error) =>
    consoleErrors.push(`pageerror: ${String(error)}`),
  );
  const upgrades = [];
  page.on("request", (request) => {
    if (!/\/rpc\/?$/.test(request.url()) || request.method() !== "POST") return;
    for (const line of (request.postData() ?? "").split("\n")) {
      try {
        const message = JSON.parse(line);
        if (message?._tag === "Request" && message.tag === "upgradeBoard")
          upgrades.push(message.payload);
      } catch {
        // not an RPC envelope line
      }
    }
  });

  const openBoard = async () => {
    await page.goto(`${WEB_URL}/boards/${BOARD_ID}`, {
      waitUntil: "domcontentloaded",
    });
    await page
      .locator("section[data-lane]")
      .first()
      .waitFor({ timeout: OPEN_TIMEOUT_MS });
  };
  const notice = () =>
    page.evaluate(() => {
      const node = document.querySelector("[data-board-pinned-versions]");
      return node === null
        ? null
        : {
            versions: node.getAttribute("data-board-pinned-versions"),
            text: node.textContent ?? "",
          };
    });

  if (MODE === "notice") {
    await openBoard();
    await page
      .locator("[data-board-pinned-versions]")
      .waitFor({ timeout: OPEN_TIMEOUT_MS })
      .catch(() => undefined);
    const shown = await notice();
    observed.notice = shown;
    const versions = EXPECT_VERSIONS.split(",");
    check(
      `the board page says its cards pin ${versions.map((v) => `v${v}`).join(" and ")}`,
      shown !== null &&
        shown.versions === EXPECT_VERSIONS &&
        versions.every((version) => shown.text.includes(`on v${version}`)) &&
        shown.text.includes("(the board's)"),
      JSON.stringify(shown),
    );
    await page.screenshot({
      path: path.join(EVIDENCE_DIR, "upgrade-notice.png"),
      fullPage: true,
    });
  } else {
    await page.goto(`${WEB_URL}/boards/${BOARD_ID}/settings`, {
      waitUntil: "domcontentloaded",
    });
    const section = page.locator("[data-board-upgrade]");
    const offered = await section
      .waitFor({ timeout: OPEN_TIMEOUT_MS })
      .then(
        () => true,
        () => false,
      );
    check(
      "the settings page offers Upgrade for a board with a newer version",
      offered,
      `offered=${offered}`,
    );
    await page.locator("[data-upgrade-version]").selectOption(TO_VERSION);
    await page.locator("[data-upgrade-migrate]").check();
    await page
      .locator("[data-upgrade-mapping]")
      .waitFor({ timeout: OPEN_TIMEOUT_MS });
    const preset = await page.$$eval("[data-upgrade-to]", (nodes) =>
      nodes.map((node) => [node.getAttribute("data-upgrade-to"), node.value]),
    );
    observed.preset = preset;
    check(
      "the mapping is preset column for column, by name",
      preset.length > 0 && preset.every(([from, to]) => from === to),
      JSON.stringify(preset),
    );
    await page.screenshot({
      path: path.join(EVIDENCE_DIR, "upgrade-form.png"),
      fullPage: true,
    });
    await page.locator("[data-upgrade-submit]").click();
    const done = await page
      .locator("[data-upgrade-done]")
      .waitFor({ timeout: OPEN_TIMEOUT_MS })
      .then(
        async () => (await page.locator("[data-upgrade-done]").textContent()) ?? "",
        async () =>
          `refused: ${(await page.locator("[data-upgrade-refused]").textContent().catch(() => "")) ?? ""}`,
      );
    observed.done = done;
    check(
      `the page says the board moved to v${TO_VERSION} and every card pins it`,
      done.includes(`to v${TO_VERSION}`) &&
        done.includes(`Every card pins v${TO_VERSION}.`),
      done,
    );
    observed.upgrades = upgrades;
    const sent = upgrades[0];
    check(
      "the page sent one upgradeBoard, at the version it read, with the preset mapping, as the dashboard",
      upgrades.length === 1 &&
        sent.boardId === BOARD_ID &&
        String(sent.toVersion) === TO_VERSION &&
        String(sent.expectedVersion) === EXPECT_VERSION &&
        sent.actor === DASHBOARD_ACTOR &&
        preset.every(([from]) => sent.migrateCards?.[from] === from),
      JSON.stringify(sent),
    );
    const pinned = await page
      .waitForFunction(
        (version) =>
          document
            .querySelector("[data-settings-version]")
            ?.getAttribute("data-settings-version") === version,
        TO_VERSION,
        { timeout: OPEN_TIMEOUT_MS },
      )
      .then(
        () => true,
        () => false,
      );
    check(
      `the settings page re-reads the board: it pins v${TO_VERSION}`,
      pinned,
      `pinned=${pinned}`,
    );
    await page.screenshot({
      path: path.join(EVIDENCE_DIR, "upgrade-done.png"),
      fullPage: true,
    });
    await openBoard();
    // Give the board's first read a poll to land before reading what it says.
    await page.waitForTimeout(2_500);
    const after = await notice();
    observed.noticeAfter = after;
    check(
      "the board page no longer says its cards pin more than one version",
      after === null,
      JSON.stringify(after),
    );
  }
  check(
    "the page threw no error",
    consoleErrors.length === 0,
    JSON.stringify(consoleErrors),
  );
} catch (error) {
  check("the drive ran to its end", false, String(error));
} finally {
  await browser?.close();
  await writeFile(
    path.join(EVIDENCE_DIR, `upgrade-web-${MODE || "unknown"}.json`),
    `${JSON.stringify(observed, null, 2)}\n`,
  );
}
process.exit(failed ? 1 : 0);
