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

// Feature: streaming RPC card. KNOWN FAILING as of this writing — over HTTP the
// browser makes no request at all when the button is clicked. Do not gate the run
// on it, but record exactly what was observed so the feature map stays honest.
// See features/rpc-stream.md.
await page.getByRole("button", { name: /call rpc api/i }).click();
let rpcWorked = false;
try {
  await page.waitForFunction(
    () => document.body.innerText.includes("Event: end"),
    null,
    {
      timeout: 40_000,
    },
  );
  rpcWorked = true;
} catch {
  rpcWorked = false;
}
const cardText = (
  await page
    .locator("pre")
    .first()
    .innerText()
    .catch(() => "")
).trim();
observed.rpcStream = { worked: rpcWorked, cardText };
console.log(
  `${rpcWorked ? "PASS" : "KNOWN-FAILURE"}  streaming RPC card  ${
    rpcWorked
      ? "stream reached its end event"
      : "no stream observed (see features/rpc-stream.md)"
  }`,
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
