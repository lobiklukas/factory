// Drive cost prediction on the dashboard (LOB-38) the way an operator meets it, against the instance
// `cost.sh` starts (a priced faux on a database of its own), and capture evidence.
//
//   node cost.mjs      (via ./cost.sh, which owns the instance this drives)
//
//   empty     with no completed session the New session form, its prompt typed, says there is no
//             estimate yet and why, and its "Cap at predicted high" choice is disabled
//   predict   after three runs costing 2, 3 and 4 cents, the form shows the range `predictCost`
//             answers for its prompt — $0.0220 to $0.0380, median $0.0300 — read over the RPC as
//             the oracle, never off the page
//   cap       ticking the cap and pressing Start session opens a session whose budget is that high
//   publish   `/spend` shows the backtest headline, its numbers the ones `backtestCost` answers, and
//             says three-odd sessions are too few to mean much
//
// Env: WEB_URL, API_URL, EVIDENCE_DIR, FAUX_COST.
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";

const WEB_URL = process.env["WEB_URL"] ?? "http://localhost:3452";
const API_URL = process.env["API_URL"] ?? "http://localhost:9452";
const EVIDENCE_DIR =
  process.env["EVIDENCE_DIR"] ?? ".verify/evidence/latest/cost";
const COST = Number(process.env["FAUX_COST"] ?? "0.01");
// The prompt the drive types into the New session form (E6): what its prediction is for, and the
// first message of every seeded run, so the three are its comparables.
const PROMPT = "Run echo faux-ok and tell me what it printed.";

await mkdir(EVIDENCE_DIR, { recursive: true });
await rm(path.join(EVIDENCE_DIR, "cost-failure.png"), { force: true });

const observed = { webUrl: WEB_URL, apiUrl: API_URL, checks: {} };
const assert = (name, condition, detail) => {
  observed.checks[name] = { passed: Boolean(condition), detail };
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}  ${detail}`);
  return Boolean(condition);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const close = (left, right) =>
  typeof left === "number" && Math.abs(left - right) < 1e-9;

/** One unary RPC call over the NDJSON envelope, from this process: the oracle, never the page. */
const rpc = async (tag, payload) => {
  const requestId = `cost-${tag}-${Date.now()}-${Math.random()}`;
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

/** Wait until the session has answered `answers` messages and the index holds its whole cost. */
const settled = async (sessionId, answers, cost) => {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const snapshot = await rpc("getSession", { sessionId });
    const answered = snapshot.entries.filter(
      (entry) => entry.kind === "assistant" && entry.text !== "",
    ).length;
    if (answered >= answers && !snapshot.live.busy) {
      if (cost === undefined) return snapshot;
      const { sessions } = await rpc("listSessions", { limit: 100 });
      const row = sessions.find((s) => s.id === sessionId);
      if (row?.status === "idle" && close(row.costTotal, cost)) return snapshot;
    }
    await sleep(100);
  }
  throw new Error(`session ${sessionId} never settled`);
};

/** A session in the history: `messages` messages, the first of which is the form's own prompt. */
const seed = async (messages) => {
  const created = await rpc("createSession", {});
  for (let sent = 1; sent <= messages; sent += 1) {
    await rpc("sendMessage", {
      sessionId: created.id,
      content: sent === 1 ? PROMPT : "echo faux-ok again",
    });
    await settled(
      created.id,
      sent,
      sent === messages ? (messages + 1) * COST : undefined,
    );
  }
  return created.id;
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

const line = () => page.locator("[data-cost-prediction]");
const cap = () => page.locator("input#new-session-cap");

/** A fresh load of `/sessions`, with the New session form open and the drive's prompt typed. */
const openForm = async () => {
  await page.goto(`${WEB_URL}/sessions`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "New session" }).click();
  await page.locator("#new-session-prompt").fill(PROMPT);
};

let exitCode = 0;
try {
  // --- empty: nothing has run --------------------------------------------------------------------
  await openForm();
  await page.waitForSelector("[data-cost-prediction='none']", {
    timeout: 15_000,
  });
  const emptyText = (await line().textContent())?.trim() ?? "";
  assert(
    "with no history the form says there is no estimate yet, and why",
    emptyText === "No estimate yet: 0 sessions completed, 3 comparable needed",
    emptyText,
  );
  assert(
    "and the cap choice is disabled: there is nothing to cap at",
    await cap().isDisabled(),
    `disabled=${await cap().isDisabled()}`,
  );
  await page.screenshot({
    path: path.join(EVIDENCE_DIR, "cost-empty.png"),
    fullPage: true,
  });

  // --- predict: three completed runs make a range ------------------------------------------------
  observed.seeded = [await seed(1), await seed(2), await seed(3)];
  const oracle = await rpc("predictCost", { prompt: PROMPT });
  observed.prediction = oracle;
  // [0.02, 0.03, 0.04]: p10 at position 0.2 → 0.022; the median 0.03; p90 at 1.8 → 0.038.
  assert(
    "the server predicts the form's prompt from the three runs",
    oracle.basis === "repo+model+shape" &&
      oracle.comparables === 3 &&
      close(oracle.range?.low, 0.022) &&
      close(oracle.range?.median, 0.03) &&
      close(oracle.range?.high, 0.038),
    JSON.stringify(oracle),
  );
  // A fresh load: the form's read is the one a person opening the page gets.
  await openForm();
  await page.waitForSelector("[data-cost-prediction='repo+model+shape']", {
    timeout: 15_000,
  });
  const predictedText = (await line().textContent())?.trim() ?? "";
  assert(
    "the form shows the server's range, its median, its sample and its basis",
    predictedText ===
      "Predicted $0.0220 to $0.0380 (median $0.0300, 3 sessions, repo+model+shape)",
    predictedText,
  );
  const shownHigh = Number(await line().getAttribute("data-cost-high"));
  assert(
    "the high it shows is the server's",
    close(shownHigh, oracle.range.high),
    `page=${shownHigh} server=${oracle.range.high}`,
  );
  await page.screenshot({
    path: path.join(EVIDENCE_DIR, "cost-predicted.png"),
    fullPage: true,
  });

  // --- cap: the session is created capped at the predicted high ---------------------------------
  assert(
    "the cap choice is offered once there is a range",
    !(await cap().isDisabled()),
    `disabled=${await cap().isDisabled()}`,
  );
  await cap().check();
  await page.locator("[data-session-submit]").click();
  await page.waitForURL(/\/sessions\/ses_[0-9a-z]{26}$/, { timeout: 15_000 });
  const cappedId = /\/sessions\/(ses_[0-9a-z]{26})$/.exec(page.url())?.[1];
  const capped = await settled(cappedId, 1, 2 * COST);
  observed.capped = { sessionId: cappedId, budget: capped.budget };
  assert(
    "Start session with the cap ticked opens a session capped at the predicted high",
    close(capped.budget?.cap, oracle.range.high) &&
      capped.budget?.stopped === undefined,
    `budget=${JSON.stringify(capped.budget)} predicted high=${oracle.range.high}`,
  );
  await page.screenshot({
    path: path.join(EVIDENCE_DIR, "cost-capped.png"),
    fullPage: true,
  });

  // --- publish: /spend carries the backtest -----------------------------------------------------
  const backtest = await rpc("backtestCost", { rows: true });
  observed.backtest = { ...backtest, rows: backtest.rows?.length };
  // The fourth session (the capped one, 2 cents) is the only one with three before it: predicted
  // 0.03, off by half.
  assert(
    "the server's backtest scores the one session with three before it",
    backtest.sessions === 4 &&
      backtest.scored === 1 &&
      close(backtest.medianRelativeError, 0.5) &&
      backtest.meaningful === false,
    JSON.stringify(observed.backtest),
  );
  await page.goto(`${WEB_URL}/spend`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-cost-backtest]", { timeout: 15_000 });
  const section = page.locator("[data-cost-backtest]");
  const sectionText = (await section.textContent())?.trim() ?? "";
  assert(
    "/spend publishes the median error over the sessions scored",
    sectionText.includes("Median error 50.0% over 1 session") &&
      Number(await section.getAttribute("data-cost-backtest-scored")) ===
        backtest.scored &&
      close(
        Number(await section.getAttribute("data-cost-backtest-error")),
        backtest.medianRelativeError,
      ),
    sectionText,
  );
  assert(
    "and says one session is too few to mean much",
    sectionText.includes(
      "Too few to mean much: 20 scored sessions are needed.",
    ) &&
      (await section.getAttribute("data-cost-backtest-meaningful")) === "false",
    sectionText,
  );
  await page.screenshot({
    path: path.join(EVIDENCE_DIR, "cost-spend.png"),
    fullPage: true,
  });

  assert(
    "the page logged no console error",
    consoleErrors.length === 0,
    JSON.stringify(consoleErrors.slice(0, 5)),
  );
} catch (error) {
  assert("the drive ran to the end", false, String(error));
  await page
    .screenshot({
      path: path.join(EVIDENCE_DIR, "cost-failure.png"),
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
