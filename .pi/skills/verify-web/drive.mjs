// Drive the web dashboard the way a user does and capture evidence.
//
//   node drive.mjs
//
// Env:
//   WEB_URL       default http://localhost:3100
//   API_URL       default http://localhost:9100
//   EVIDENCE_DIR  default .verify/evidence/latest
//
// Uses the locally installed Chrome (channel: "chrome") instead of a downloaded
// Playwright browser, so this runs without a browser download.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";

const WEB_URL = process.env["WEB_URL"] ?? "http://localhost:3100";
const API_URL = process.env["API_URL"] ?? "http://localhost:9100";
const EVIDENCE_DIR = process.env["EVIDENCE_DIR"] ?? ".verify/evidence/latest";

await mkdir(EVIDENCE_DIR, { recursive: true });

const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage();

const consoleErrors = [];
const failedResponses = [];
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});
page.on("pageerror", (error) =>
  consoleErrors.push(`pageerror: ${String(error)}`),
);
page.on("response", (response) => {
  if (response.status() >= 400)
    failedResponses.push(`${response.status()} ${response.url()}`);
});

const observed = { webUrl: WEB_URL, apiUrl: API_URL, checks: {} };
const assert = (name, condition, detail) => {
  observed.checks[name] = { passed: Boolean(condition), detail };
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}  ${detail}`);
  return Boolean(condition);
};

await page.goto(WEB_URL, { waitUntil: "domcontentloaded" });

// Feature: dashboard shell renders.
await page.waitForSelector("h1", { timeout: 15_000 });
const heading = (await page.locator("h1").first().innerText()).trim();
observed.heading = heading;
assert(
  "shell renders",
  heading === "factory",
  `h1 = ${JSON.stringify(heading)}`,
);

// Feature: the dashboard can reach the API from the browser origin. This runs the
// request in the page, so it proves CORS and reachability through the real client
// origin rather than from the test process.
const health = await page.evaluate(async (apiUrl) => {
  try {
    const response = await fetch(`${apiUrl}/`, { method: "GET" });
    return {
      status: response.status,
      body: (await response.text()).slice(0, 120),
    };
  } catch (error) {
    return { status: 0, body: String(error) };
  }
}, API_URL);
observed.health = health;
assert(
  "browser reaches API",
  health.status === 200,
  `GET ${API_URL}/ -> ${health.status} ${JSON.stringify(health.body)}`,
);

// Feature: session stream. Required: it is the dashboard's only end-to-end check of
// creating a session, driving it, and watching the events arrive. See
// features/session-stream.md.
await page.getByRole("button", { name: /start a session/i }).click();
let sessionWorked = false;
try {
  // Require the end of the story, not the beginning: the answer is rendered only
  // after the tool call, the transcript commit, and the stream all worked, and it is
  // text the faux model derives from the bash tool's own output. Waiting for the
  // earlier `toolResult` line reads the panel while the run is still finishing —
  // which is exactly the race this check caught on 2026-10-06.
  await page.waitForFunction(
    () => document.body.innerText.includes("assistant: faux-ok (re:"),
    null,
    { timeout: 40_000 },
  );
  // And the run must settle: a live read that never leaves `busy` is a stuck session.
  await page.waitForFunction(
    () => document.body.innerText.includes("live · idle"),
    null,
    { timeout: 20_000 },
  );
  sessionWorked = true;
} catch {
  sessionWorked = false;
}
const cardText = (
  await page
    .locator("pre")
    .first()
    .innerText()
    .catch(() => "")
).trim();
const modeLine = (
  await page
    .locator("p")
    .filter({ hasText: /live|historical/ })
    .first()
    .innerText()
    .catch(() => "")
).trim();
observed.session = { worked: sessionWorked, modeLine, cardText };
assert(
  "session stream",
  sessionWorked,
  sessionWorked
    ? `transcript rendered: ${JSON.stringify(cardText.slice(0, 200))}`
    : `no tool result within 40s; panel: ${JSON.stringify(cardText.slice(0, 200))}`,
);
assert(
  "the dashboard labels a live read",
  modeLine.startsWith("live"),
  `mode line = ${JSON.stringify(modeLine)}`,
);
assert(
  "the dashboard renders the answer",
  cardText.includes("assistant: faux-ok (re:"),
  `panel: ${JSON.stringify(cardText.slice(0, 200))}`,
);

await page.screenshot({
  path: path.join(EVIDENCE_DIR, "dashboard.png"),
  fullPage: true,
});

observed.consoleErrors = consoleErrors;
observed.failedResponses = failedResponses;
await writeFile(
  path.join(EVIDENCE_DIR, "observed.json"),
  `${JSON.stringify(observed, null, 2)}\n`,
);

await browser.close();

console.log(`\nevidence: ${path.resolve(EVIDENCE_DIR)}`);
if (consoleErrors.length > 0)
  console.log(`console errors: ${consoleErrors.length}`);

const hardFailures = Object.entries(observed.checks).filter(
  ([, c]) => !c.passed,
);
if (hardFailures.length > 0) {
  console.error(`\n${hardFailures.length} required check(s) failed`);
  process.exitCode = 1;
}
