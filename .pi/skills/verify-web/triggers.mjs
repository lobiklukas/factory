// Drive the Triggers page (T4) the way an operator uses it, against the instance `triggers.sh`
// starts, and capture evidence.
//
//   node triggers.mjs      (via ./triggers.sh, which owns the instance and the secret this signs with)
//
// The drive delivers webhooks the API's seam records, then requires the page to say what happened:
//
//   seed      a registered repo (a throwaway git checkout); a generic webhook that starts a session,
//             one whose label no rule claims, one whose rule names a repo nobody registered, 55 more
//             unmapped ones (so a second page exists), and one with a wrong signature (401)
//   reach     the rail's **Triggers** opens `/triggers` and is marked `aria-current`
//   list      the rows are `listTriggerDeliveries`' first page, in its order, each with its outcome,
//             source and delivery id; the unmapped and unregistered skips show the seam's reason
//             character for character; the processed one links its session, and the link opens it;
//             the forged delivery is nowhere on the page or in the RPC's answer
//   filter    **Skipped** keeps only skips (and drops the processed delivery); the source select
//             narrows to the generic webhook; a combination the server answers with nothing says what
//             emptied the list; **All** brings everything back
//   older     "Show older" appends the next page (the RPC's own cursor walk is the oracle), shows each
//             delivery once, and goes away when the last page is in
//             a delivery arriving after "Show older" joins the top and drops none of the rows held
//   poll      with the page open, a new delivery appears at the top without a reload
//
// Env: WEB_URL, API_URL, EVIDENCE_DIR, RUN_DIR, TRIGGER_SECRET, TRIGGERS_REPO, TRIGGERS_GHOST.
import { spawnSync } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "@playwright/test";

const WEB_URL = process.env["WEB_URL"] ?? "http://localhost:3475";
const API_URL = process.env["API_URL"] ?? "http://localhost:9475";
const EVIDENCE_DIR =
  process.env["EVIDENCE_DIR"] ?? ".verify/evidence/latest/triggers";
const SECRET = process.env["TRIGGER_SECRET"] ?? "";
const TAG = randomBytes(4).toString("hex");
const REPO = process.env["TRIGGERS_REPO"] ?? `verify-triggers-${TAG}/widgets`;
const GHOST = process.env["TRIGGERS_GHOST"] ?? `verify-triggers-${TAG}/ghost`;
const PAGE_SIZE = 50;
const FILL = 55;

await mkdir(EVIDENCE_DIR, { recursive: true });
await rm(path.join(EVIDENCE_DIR, "triggers-failure.png"), { force: true });
const CHECKOUT = await mkdtemp(
  path.join(os.tmpdir(), `verify-triggers-${TAG}-`),
);
for (const args of [
  ["init", "-q", "-b", "main", CHECKOUT],
  [
    "-C",
    CHECKOUT,
    "-c",
    "user.email=verify-triggers@localhost",
    "-c",
    "user.name=verify-triggers",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "seed",
  ],
]) {
  const done = spawnSync("git", args, { encoding: "utf8" });
  if (done.status !== 0) throw new Error(`git ${args[0]}: ${done.stderr}`);
}

const observed = { webUrl: WEB_URL, apiUrl: API_URL, tag: TAG, checks: {} };
const assert = (name, condition, detail) => {
  observed.checks[name] = { passed: Boolean(condition), detail };
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}  ${detail}`);
  return Boolean(condition);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** One unary RPC call over the NDJSON envelope, from this process: the oracle, never the page. */
const rpc = async (tag, payload) => {
  const requestId = `triggers-${tag}-${Date.now()}-${Math.random()}`;
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
  if (envelope?.exit?._tag !== "Success") {
    throw new Error(
      `${tag} failed: ${JSON.stringify(envelope?.exit ?? text.slice(0, 400))}`,
    );
  }
  return envelope.exit.value;
};

/** One generic webhook, signed as the API's secret signs it. */
const deliver = async (requestId, label, title, secret = SECRET) => {
  const raw = JSON.stringify({
    requestId,
    label,
    title,
    body: "from the drive",
  });
  const response = await fetch(`${API_URL}/webhooks/generic`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-trigger-signature": createHmac("sha256", secret)
        .update(raw)
        .digest("hex"),
    },
    body: raw,
  });
  return {
    status: response.status,
    body: await response.json().catch(() => null),
  };
};

const id = (name) => `t4-web-${TAG}-${name}`;
const OK = id("ok");
const NORULE = id("norule");
const GHOST_ID = id("ghost");
const FORGED = id("forged");

const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const consoleErrors = [];
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});
page.on("pageerror", (error) =>
  consoleErrors.push(`pageerror: ${String(error)}`),
);

const rowIds = () =>
  page.$$eval("[data-delivery]", (nodes) =>
    nodes.map((node) => node.getAttribute("data-delivery")),
  );
const rowSel = (deliveryId) => `[data-delivery="${deliveryId}"]`;
const readRow = (deliveryId) =>
  page.$eval(rowSel(deliveryId), (node) => ({
    status: node.getAttribute("data-delivery-status"),
    source: node.getAttribute("data-delivery-source"),
    reason: node.querySelector("[data-delivery-reason]")?.textContent ?? null,
    session:
      node
        .querySelector("[data-delivery-session]")
        ?.getAttribute("data-delivery-session") ?? null,
  }));
/** The list has settled when its row count matches `count` (the server's page, shown). */
const waitCount = (count) =>
  page.waitForFunction(
    (wanted) => document.querySelectorAll("[data-delivery]").length === wanted,
    count,
    { timeout: 15_000 },
  );

let exitCode = 0;
try {
  // --- seed ------------------------------------------------------------------------------------
  await rpc("registerRepo", {
    repo: REPO,
    localPath: CHECKOUT,
    defaultBaseRef: "main",
  });
  const ok = await deliver(OK, "t4-ok", `Fix the wobble ${TAG}`);
  const sessionId = ok.body?.sessionId;
  await sleep(30);
  await deliver(NORULE, "t4-nothing", `Unmapped ${TAG}`);
  await sleep(30);
  await deliver(GHOST_ID, "t4-ghost", `Ghost ${TAG}`);
  const forged = await deliver(FORGED, "t4-ok", "forged", "not-the-secret");
  for (let index = 0; index < FILL; index += 1) {
    await deliver(
      id(`fill-${String(index).padStart(2, "0")}`),
      "t4-nothing",
      `Fill ${index}`,
    );
  }
  assert(
    "seeded: one delivery started a session, and the forged one was refused 401",
    ok.status === 200 &&
      ok.body?.status === "processed" &&
      typeof sessionId === "string" &&
      forged.status === 401,
    `ok=${ok.status}/${ok.body?.status} session=${sessionId} forged=${forged.status}`,
  );

  // --- reach: the rail's Triggers ---------------------------------------------------------------
  await page.goto(`${WEB_URL}/sessions`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("nav[aria-label='Sections']", { timeout: 15_000 });
  await page
    .locator("nav[aria-label='Sections']")
    .getByRole("link", { name: "Triggers", exact: true })
    .click();
  await page.waitForFunction(() => window.location.pathname === "/triggers");
  await waitCount(PAGE_SIZE);
  await page.evaluate(() => {
    window.__triggersNoReload = true;
  });
  const current = await page.$$eval(
    "nav[aria-label='Sections'] [aria-current='page']",
    (nodes) => nodes.map((node) => node.getAttribute("href")),
  );
  assert(
    "the rail marks Triggers as the current section",
    current.length === 1 && current[0] === "/triggers",
    `aria-current on ${JSON.stringify(current)}`,
  );

  // --- list: the server's first page, in its order ----------------------------------------------
  const first = await rpc("listTriggerDeliveries", { limit: PAGE_SIZE });
  const shownIds = await rowIds();
  await page.screenshot({
    path: path.join(EVIDENCE_DIR, "triggers-list.png"),
    fullPage: true,
  });
  assert(
    "the rows are listTriggerDeliveries' first page, in its newest-first order",
    JSON.stringify(shownIds) ===
      JSON.stringify(first.deliveries.map((row) => row.deliveryId)) &&
      first.nextCursor !== undefined,
    `shown=${shownIds.length} rpc=${first.deliveries.length} cursor=${first.nextCursor ?? "none"}`,
  );
  assert(
    "the forged delivery is nowhere: not in the RPC's answer, not on the page",
    !JSON.stringify(first).includes(FORGED) && !shownIds.includes(FORGED),
    `forged=${FORGED}`,
  );

  // The seeded three sit below the fifty-five fillers on the first page? They are older than the
  // fillers, so page them in with Show older until they are shown, then read them.
  const showOlder = page.locator("[data-triggers-older]");
  const loadAll = async () => {
    while ((await showOlder.count()) > 0) {
      const before = (await rowIds()).length;
      await showOlder.click();
      await page.waitForFunction(
        (wanted) =>
          document.querySelectorAll("[data-delivery]").length > wanted ||
          document.querySelector("[data-triggers-older]") === null,
        before,
        { timeout: 15_000 },
      );
    }
  };
  // --- older: the next page, appended, each delivery once ---------------------------------------
  const beforeOlder = (await rowIds()).length;
  await showOlder.click();
  await page.waitForFunction(
    (wanted) => document.querySelectorAll("[data-delivery]").length > wanted,
    beforeOlder,
    { timeout: 15_000 },
  );
  const second = await rpc("listTriggerDeliveries", {
    limit: PAGE_SIZE,
    cursor: first.nextCursor,
  });
  const afterOlder = await rowIds();
  const expectedAfter = [
    ...first.deliveries.map((row) => row.deliveryId),
    ...second.deliveries.map((row) => row.deliveryId),
  ];
  assert(
    "Show older appends the RPC's next page, in order, with no delivery shown twice",
    JSON.stringify(afterOlder) === JSON.stringify(expectedAfter) &&
      new Set(afterOlder).size === afterOlder.length,
    `shown=${afterOlder.length} expected=${expectedAfter.length}`,
  );
  // A delivery that arrives after "Show older" pushes the head's last row out of the polled head and
  // into the gap before the older pages: it must stay listed, between the head and the older rows.
  const PAGED_LATE = id("paged-late");
  await deliver(PAGED_LATE, "t4-nothing", `Paged late ${TAG}`);
  await page.waitForSelector(rowSel(PAGED_LATE), { timeout: 20_000 });
  const afterArrival = await rowIds();
  assert(
    "a delivery arriving after Show older is added at the top and no listed delivery vanishes or repeats",
    afterArrival[0] === PAGED_LATE &&
      JSON.stringify(afterArrival.slice(1)) === JSON.stringify(afterOlder) &&
      new Set(afterArrival).size === afterArrival.length,
    `before=${afterOlder.length} after=${afterArrival.length}`,
  );
  await loadAll();
  const everything = await rowIds();
  assert(
    "after the last page the button is gone and the three seeded deliveries are listed",
    (await showOlder.count()) === 0 &&
      [OK, NORULE, GHOST_ID].every((deliveryId) =>
        everything.includes(deliveryId),
      ),
    `rows=${everything.length}`,
  );

  // --- the seam's words, verbatim ---------------------------------------------------------------
  const okRow = await readRow(OK);
  const noRule = await readRow(NORULE);
  const ghost = await readRow(GHOST_ID);
  observed.rows = { okRow, noRule, ghost };
  await page.locator(rowSel(GHOST_ID)).scrollIntoViewIfNeeded();
  await page.screenshot({
    path: path.join(EVIDENCE_DIR, "triggers-reasons.png"),
    fullPage: true,
  });
  assert(
    "an unmapped label's skip shows the seam's reason verbatim",
    noRule.status === "skipped" &&
      noRule.source === "generic" &&
      noRule.reason === "no rule matches labels [t4-nothing]" &&
      noRule.session === null,
    JSON.stringify(noRule),
  );
  assert(
    "an unregistered repo's skip shows the seam's reason verbatim",
    ghost.status === "skipped" &&
      ghost.reason === `repo ${GHOST} is not registered`,
    JSON.stringify(ghost),
  );
  const recorded = (
    await rpc("listTriggerDeliveries", { limit: 200, source: "generic" })
  ).deliveries;
  const oracleOk = recorded.find((row) => row.deliveryId === OK);
  assert(
    "the processed delivery shows the rule that routed it and names its session, as the RPC does",
    okRow.status === "processed" &&
      okRow.session === sessionId &&
      oracleOk?.sessionId === sessionId &&
      okRow.reason === oracleOk?.reason &&
      (okRow.reason ?? "").includes(`mapped it to ${REPO}`),
    JSON.stringify(okRow),
  );

  // --- filter -----------------------------------------------------------------------------------
  await page.locator("[data-triggers-status='skipped']").click();
  const skippedRpc = await rpc("listTriggerDeliveries", {
    limit: PAGE_SIZE,
    status: "skipped",
  });
  await waitCount(PAGE_SIZE);
  const skippedShown = await rowIds();
  const skippedStatuses = await page.$$eval("[data-delivery]", (nodes) =>
    nodes.map((node) => node.getAttribute("data-delivery-status")),
  );
  assert(
    "Skipped shows only skips, equal to the RPC's first skipped page, and the older pages were dropped",
    skippedStatuses.every((status) => status === "skipped") &&
      JSON.stringify(skippedShown) ===
        JSON.stringify(skippedRpc.deliveries.map((row) => row.deliveryId)) &&
      !skippedShown.includes(OK),
    `rows=${skippedShown.length}`,
  );
  await page.locator("[data-triggers-status='processed']").click();
  const processedRpc = await rpc("listTriggerDeliveries", {
    limit: PAGE_SIZE,
    status: "processed",
  });
  await waitCount(processedRpc.deliveries.length);
  const processedShown = await rowIds();
  assert(
    "Processed shows only what started work, including the drive's session",
    JSON.stringify(processedShown) ===
      JSON.stringify(processedRpc.deliveries.map((row) => row.deliveryId)) &&
      processedShown.includes(OK) &&
      !processedShown.includes(NORULE),
    `rows=${processedShown.length}`,
  );

  // The session link opens the session.
  await page.locator(`${rowSel(OK)} [data-delivery-session]`).click();
  await page.waitForFunction(
    (sid) => window.location.pathname === `/sessions/${sid}`,
    sessionId,
    { timeout: 15_000 },
  );
  assert(
    "the processed delivery's session link opens that session",
    new URL(page.url()).pathname === `/sessions/${sessionId}`,
    `at ${new URL(page.url()).pathname}`,
  );
  await page.goBack();
  await page.waitForFunction(() => window.location.pathname === "/triggers");
  await page.waitForSelector("[data-triggers-status]", { timeout: 15_000 });

  await page.locator("[data-triggers-status='all']").click();
  await page.selectOption("[data-triggers-source]", "generic");
  const genericRpc = await rpc("listTriggerDeliveries", {
    limit: PAGE_SIZE,
    source: "generic",
  });
  await waitCount(Math.min(PAGE_SIZE, genericRpc.deliveries.length));
  const genericSources = await page.$$eval("[data-delivery]", (nodes) =>
    nodes.map((node) => node.getAttribute("data-delivery-source")),
  );
  assert(
    "the source select narrows to the generic webhook, equal to the RPC",
    genericSources.length > 0 &&
      genericSources.every((source) => source === "generic") &&
      JSON.stringify(await rowIds()) ===
        JSON.stringify(genericRpc.deliveries.map((row) => row.deliveryId)),
    `rows=${genericSources.length}`,
  );

  // A combination the server answers with nothing: the page says what emptied the list.
  const sources = await page.$$eval("[data-triggers-source] option", (nodes) =>
    nodes.map((node) => node.value).filter((value) => value !== "all"),
  );
  let emptySource;
  for (const source of sources) {
    const answer = await rpc("listTriggerDeliveries", {
      status: "received",
      source,
      limit: 1,
    });
    if (answer.deliveries.length === 0) {
      emptySource = source;
      break;
    }
  }
  await page.locator("[data-triggers-status='received']").click();
  await page.selectOption("[data-triggers-source]", emptySource ?? "all");
  await page.waitForSelector("[data-triggers-empty]", { timeout: 15_000 });
  const emptyText =
    (await page.locator("[data-triggers-empty]").textContent()) ?? "";
  await page.screenshot({
    path: path.join(EVIDENCE_DIR, "triggers-empty.png"),
    fullPage: true,
  });
  assert(
    "an empty filter says what emptied it",
    emptySource !== undefined &&
      emptyText ===
        `No delivery from ${emptySource} that ended received is recorded.`,
    `source=${emptySource ?? "none"} text=${JSON.stringify(emptyText)}`,
  );

  await page.locator("[data-triggers-status='all']").click();
  await page.selectOption("[data-triggers-source]", "all");
  await waitCount(PAGE_SIZE);

  // --- poll: a delivery that arrives while the page is open -------------------------------------
  const LATE = id("late");
  await deliver(LATE, "t4-nothing", `Late ${TAG}`);
  await page.waitForSelector(rowSel(LATE), { timeout: 20_000 });
  const topRow = (await rowIds())[0];
  const survived = await page.evaluate(
    () => window.__triggersNoReload === true,
  );
  assert(
    "a delivery that arrives with the page open appears at the top without a reload",
    topRow === LATE && survived,
    `top=${topRow} noReload=${survived}`,
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
      path: path.join(EVIDENCE_DIR, "triggers-failure.png"),
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
  await rm(CHECKOUT, { recursive: true, force: true });
  exitCode = Object.values(observed.checks).every((check) => check.passed)
    ? 0
    : 1;
}
process.exit(exitCode);
