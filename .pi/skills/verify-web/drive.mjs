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
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

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

// Feature: the root redirects to the sessions section. See features/routing.md.
await page.goto(WEB_URL, { waitUntil: "domcontentloaded" });
await page.waitForSelector("nav[aria-label='Sections']", { timeout: 15_000 });
const redirected = new URL(page.url()).pathname;
observed.redirected = redirected;
assert(
  "root redirects to sessions",
  redirected === "/sessions",
  `after goto ${WEB_URL} the path is ${JSON.stringify(redirected)}`,
);

// The sidebar's honest empty state, before any session exists in this browser.
const emptyState = (await page.locator("aside").first().innerText()).trim();
observed.emptyState = emptyState;
assert(
  "sidebar says what is missing",
  emptyState.includes("No sessions in this browser yet"),
  `aside: ${JSON.stringify(emptyState.slice(0, 120))}`,
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
await page.getByRole("button", { name: /new session/i }).click();

// The route moves to the created session's own URL, which is what a user would
// then share or reload.
await page.waitForFunction(
  () => /^\/sessions\/ses_/.test(window.location.pathname),
  null,
  { timeout: 20_000 },
);
const sessionPath = new URL(page.url()).pathname;
observed.sessionPath = sessionPath;

let sessionWorked = false;
try {
  // Require the end of the story, not the beginning: the answer is rendered only
  // after the tool call, the transcript commit, and the stream all worked, and it
  // is text the faux model derives from the bash tool's own output. Waiting for the
  // earlier `toolResult` row reads the pane while the run is still finishing —
  // which is exactly the race this check caught on 2026-10-06.
  await page.waitForFunction(
    () => document.body.innerText.includes("faux-ok (re:"),
    null,
    { timeout: 40_000 },
  );
  // And the run must settle: a live read that never leaves `busy` is a stuck session.
  await page.waitForFunction(
    () => document.body.innerText.includes("IDLE"),
    null,
    { timeout: 20_000 },
  );
  sessionWorked = true;
} catch {
  sessionWorked = false;
}
const paneText = (await page.locator("main, body").first().innerText()).trim();
observed.session = { worked: sessionWorked, paneText };
assert(
  "session stream",
  sessionWorked,
  sessionWorked
    ? `transcript rendered: ${JSON.stringify(paneText.slice(0, 200))}`
    : `no tool result within 40s; pane: ${JSON.stringify(paneText.slice(0, 200))}`,
);

// The header must label the read path (docs/design.md D8): a fold and a live
// stream are not the same thing, and the user is the one who has to know which
// they are looking at.
const headerText = (await page.locator("header").first().innerText()).trim();
observed.header = headerText;
assert(
  "the dashboard labels the read path",
  headerText.includes("LIVE STREAM"),
  `header: ${JSON.stringify(headerText)}`,
);
assert(
  "the header shows the session id",
  sessionPath.replace("/sessions/", "") !== "" &&
    headerText.includes(sessionPath.replace("/sessions/", "")),
  `header: ${JSON.stringify(headerText)}`,
);

// The created session is in the sidebar: the registry records what the stream
// reported, so the list is not a separate fiction.
await page.waitForFunction(
  () => document.querySelectorAll("aside a[href^='/sessions/']").length > 0,
  null,
  { timeout: 10_000 },
);
const sidebarAfter = (await page.locator("aside").first().innerText()).trim();
observed.sidebarAfter = sidebarAfter;
assert(
  "the new session is in the sidebar",
  sidebarAfter.includes(sessionPath.replace("/sessions/", "")),
  `aside: ${JSON.stringify(sidebarAfter.slice(0, 200))}`,
);

await page.screenshot({
  path: path.join(EVIDENCE_DIR, "dashboard.png"),
  fullPage: true,
});

// Feature: the tool-call disclosure. Collapsed by default (a coding run emits
// dozens), and it opens. See features/transcript.md.
await page.goto(`${WEB_URL}/sandboxes`, { waitUntil: "domcontentloaded" });
const sandboxCopy = (await page.locator("body").innerText()).trim();
observed.sandboxes = sandboxCopy;
assert(
  "sandboxes says what is missing",
  sandboxCopy.includes("No sandboxes yet") && sandboxCopy.includes("M4"),
  `body: ${JSON.stringify(sandboxCopy.slice(0, 200))}`,
);
await page.screenshot({ path: path.join(EVIDENCE_DIR, "sandboxes.png") });

await page.goto(`${WEB_URL}/approvals`, { waitUntil: "domcontentloaded" });
const approvalsCopy = (await page.locator("body").innerText()).trim();
observed.approvals = approvalsCopy;
assert(
  "approvals says what is missing",
  approvalsCopy.includes("No approvals pending") &&
    approvalsCopy.includes("M3"),
  `body: ${JSON.stringify(approvalsCopy.slice(0, 200))}`,
);
await page.screenshot({ path: path.join(EVIDENCE_DIR, "approvals.png") });

// A bad session id is refused by the route's decode, not sent to the RPC surface
// as a `not_found` the user cannot act on. See features/routing.md.
await page.goto(`${WEB_URL}/sessions/not-a-real-id`, {
  waitUntil: "domcontentloaded",
});
const badIdCopy = (await page.locator("body").innerText()).trim();
observed.badId = badIdCopy;
assert(
  "a bad session id is refused locally",
  badIdCopy.includes("Not a session id this control plane mints"),
  `body: ${JSON.stringify(badIdCopy.slice(0, 200))}`,
);
await page.screenshot({ path: path.join(EVIDENCE_DIR, "bad-session-id.png") });

// Back to the session for the transcript screenshot, with a tool result expanded.
await page.goto(`${WEB_URL}/sessions`, { waitUntil: "domcontentloaded" });
const sessionLink = page.locator("aside a[href^='/sessions/']").first();
if ((await sessionLink.count()) > 0) {
  await sessionLink.click();
  await page.waitForTimeout(1_500);
  const toolToggle = page.getByRole("button", { name: /bash/i }).first();
  if ((await toolToggle.count()) > 0) await toolToggle.click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(EVIDENCE_DIR, "transcript.png") });
}

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
