// The dashboard sends the control-plane credential (LOB-20), driven in a headless browser against
// an API that requires one (./auth.sh boots both).
//
//   with token   the dashboard built with VITE_FACTORY_API_TOKEN lists a session the API holds, every
//                RPC it sends carries `Authorization: Bearer`, and its **New session** — whose body
//                still declares `actor: "dashboard"` — is recorded as the token's actor, `dashboard-op`
//   without      the dashboard built without it gets `Unauthenticated` back and shows no session
//
// Env: WEB_URL, OPEN_WEB_URL, API_URL, EVIDENCE_DIR, AUTH_TOKEN (set by ./auth.sh).
import { randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";

const WEB_URL = process.env["WEB_URL"] ?? "http://localhost:3445";
const OPEN_WEB_URL = process.env["OPEN_WEB_URL"] ?? "http://localhost:3446";
const API_URL = process.env["API_URL"] ?? "http://localhost:9445";
const EVIDENCE_DIR =
  process.env["EVIDENCE_DIR"] ?? ".verify/evidence/latest/auth";
const TOKEN = process.env["AUTH_TOKEN"];
if (TOKEN === undefined || TOKEN === "") {
  console.error("auth.mjs needs AUTH_TOKEN (run it through ./auth.sh)");
  process.exit(2);
}

await mkdir(EVIDENCE_DIR, { recursive: true });
await rm(path.join(EVIDENCE_DIR, "auth-failure.png"), { force: true });

const observed = { webUrl: WEB_URL, openWebUrl: OPEN_WEB_URL, checks: {} };
const assert = (name, condition, detail) => {
  observed.checks[name] = { passed: Boolean(condition), detail };
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}  ${detail}`);
};

/** One RPC over raw NDJSON with the token: its exit. */
const rpc = async (tag, payload) => {
  const requestId = `auth-${tag}-${Date.now()}`;
  const response = await fetch(`${API_URL}/rpc`, {
    method: "POST",
    headers: {
      "content-type": "application/ndjson",
      authorization: `Bearer ${TOKEN}`,
    },
    body: `${JSON.stringify({ _tag: "Request", id: requestId, tag, payload, headers: [] })}\n`,
  });
  const exit = (await response.text())
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line))
    .find((message) => message.requestId === requestId)?.exit;
  if (exit?._tag !== "Success") {
    throw new Error(`${tag} failed: ${JSON.stringify(exit).slice(0, 300)}`);
  }
  return exit.value;
};

const TITLE = `auth-probe-${randomBytes(4).toString("hex")}`;
const browser = await chromium.launch({ channel: "chrome", headless: true });
const consoleErrors = [];
const watchConsole = (page, label) => {
  page.on("console", (message) => {
    if (message.type() === "error")
      consoleErrors.push(`${label}: ${message.text()}`);
  });
  page.on("pageerror", (error) =>
    consoleErrors.push(`${label}: pageerror: ${String(error)}`),
  );
};
let exitCode = 0;
try {
  const seeded = await rpc("createSession", { title: TITLE });
  observed.seeded = { id: seeded.id };

  // ── with the token ─────────────────────────────────────────────────────────────────────────
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
  });
  watchConsole(page, "with-token");
  const sent = [];
  page.on("request", (request) => {
    if (request.url().startsWith(`${API_URL}/rpc`)) {
      const authorization = request.headers()["authorization"];
      sent.push(
        authorization === undefined
          ? "none"
          : authorization === `Bearer ${TOKEN}`
            ? "bearer"
            : "other",
      );
    }
  });
  await page.goto(`${WEB_URL}/sessions`, { waitUntil: "domcontentloaded" });
  const listed = await page
    .getByText(TITLE)
    .first()
    .waitFor({ timeout: 45_000 })
    .then(() => true)
    .catch(() => false);
  await page.screenshot({
    path: path.join(EVIDENCE_DIR, "auth-with-token.png"),
  });
  assert(
    "with token: the dashboard lists a session the API holds",
    listed,
    `title=${TITLE}`,
  );
  const count = (report, actor) =>
    report.rows
      .filter((row) => row.actor === actor)
      .reduce((total, row) => total + row.sessions, 0);
  const before = await rpc("listSpend", {});
  // New session opens the form (E6); the session exists once it is submitted.
  await page.getByRole("button", { name: /new session/i }).click();
  await page
    .locator("#new-session-prompt")
    .fill("Run the check and report it.");
  await page.locator("[data-session-submit]").click();
  await page.waitForFunction(
    () => /^\/sessions\/ses_/.test(window.location.pathname),
    null,
    { timeout: 20_000 },
  );
  const createdId = new URL(page.url()).pathname.split("/").at(-1);
  const after = await rpc("listSpend", {});
  const delta = {
    "dashboard-op":
      count(after, "dashboard-op") - count(before, "dashboard-op"),
    dashboard: count(after, "dashboard") - count(before, "dashboard"),
  };
  observed.withToken = {
    requests: sent.length,
    headers: [...new Set(sent)],
    created: createdId,
    spendDelta: delta,
  };
  assert(
    "with token: every RPC the dashboard sent carried the bearer credential",
    sent.length > 0 && sent.every((header) => header === "bearer"),
    `${sent.length} request(s): ${[...new Set(sent)].join(", ")}`,
  );
  assert(
    "with token: New session is recorded as the token's actor, not the body's dashboard",
    createdId?.startsWith("ses_") &&
      delta["dashboard-op"] === 1 &&
      delta.dashboard === 0,
    `session=${createdId} listSpend sessions +${delta["dashboard-op"]} dashboard-op, +${delta.dashboard} dashboard`,
  );
  await page.close();

  // ── without it ─────────────────────────────────────────────────────────────────────────────
  const open = await browser.newPage({
    viewport: { width: 1440, height: 900 },
  });
  watchConsole(open, "without-token");
  const answers = [];
  open.on("response", async (response) => {
    if (response.url().startsWith(`${API_URL}/rpc`)) {
      answers.push(await response.text().catch(() => ""));
    }
  });
  await open.goto(`${OPEN_WEB_URL}/sessions`, {
    waitUntil: "domcontentloaded",
  });
  await open
    .waitForFunction(() => document.body.innerText.length > 0, null, {
      timeout: 15_000,
    })
    .catch(() => undefined);
  const refused = await (async () => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (answers.some((text) => text.includes('"_tag":"Unauthenticated"'))) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
  })();
  const shown = await open.getByText(TITLE).count();
  await open.screenshot({
    path: path.join(EVIDENCE_DIR, "auth-without-token.png"),
  });
  observed.withoutToken = { answers: answers.length, refused, shown };
  assert(
    "without token: the API answers the dashboard Unauthenticated",
    refused,
    `${answers.length} answer(s)`,
  );
  assert(
    "without token: the dashboard shows no session",
    shown === 0,
    `matches=${shown}`,
  );
} catch (error) {
  exitCode = 1;
  observed.error = String(error);
  console.error(error);
} finally {
  await browser.close();
}

observed.consoleErrors = consoleErrors;
if (Object.values(observed.checks).some((check) => !check.passed)) exitCode = 1;
await writeFile(
  path.join(EVIDENCE_DIR, "observed.json"),
  `${JSON.stringify(observed, null, 2)}\n`,
);
process.exit(exitCode);
