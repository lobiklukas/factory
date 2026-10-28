// Drive the session pane's Interrupt button (C8) the way an operator uses it, against the instance
// `interrupt.sh` starts (`FAUX_SLEEP_MS`: the scripted model naps before `bash` and again before it
// answers, so a run is busy for about twice the nap), and capture evidence.
//
//   node interrupt.mjs      (via ./interrupt.sh, which owns the instance this drives)
//
//   stop       a press on a busy run sends exactly one `interruptSession`; the header goes idle
//              within the poll window; two naps later the run has still not printed `faux-ok`, in
//              the page or in the log (read over the RPC, never the page)
//   marker     the transcript ends the turn with its `interrupted` row, and the log agrees
//   follow-up  a message sent after it runs normally: `faux-ok`, an answer, and the header idle
//   refused    an interrupt held in the browser until the run it was pressed for has settled is
//              answered `not_running`, and the pane says so in a toast carrying the server's sentence
//
// The session is created and its first message sent over the RPC, not through the sidebar's form:
// what is driven here is the pane, and the form is another feature's.
//
// Env: WEB_URL, API_URL, EVIDENCE_DIR, FAUX_SLEEP_MS (the nap the instance was booted with).
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";

const WEB_URL = process.env["WEB_URL"] ?? "http://localhost:3461";
const API_URL = process.env["API_URL"] ?? "http://localhost:9461";
const EVIDENCE_DIR =
  process.env["EVIDENCE_DIR"] ?? ".verify/evidence/latest/interrupt";
const SLEEP_MS = Number(process.env["FAUX_SLEEP_MS"] ?? "4000");
/** How long the header may take to go idle after the press: the stream, not a poll, carries it. */
const POLL_WINDOW_MS = 5_000;

await mkdir(EVIDENCE_DIR, { recursive: true });
// A failure shot from an earlier run must not sit beside this run's passing evidence.
await rm(path.join(EVIDENCE_DIR, "interrupt-failure.png"), { force: true });

const observed = {
  webUrl: WEB_URL,
  apiUrl: API_URL,
  sleepMs: SLEEP_MS,
  checks: {},
};
const assert = (name, condition, detail) => {
  observed.checks[name] = { passed: Boolean(condition), detail };
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}  ${detail}`);
  return Boolean(condition);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** One unary RPC call over the NDJSON envelope, from this process: the oracle, never the page. */
const rpc = async (tag, payload) => {
  const requestId = `interrupt-${tag}-${Date.now()}-${Math.random()}`;
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

const until = async (label, check, timeoutMs = 30_000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline)
      throw new Error(`timed out waiting for ${label}`);
    await sleep(100);
  }
};

const printed = (snapshot) =>
  snapshot.entries.some((entry) => entry.text.includes("faux-ok"));

const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const consoleErrors = [];
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});
page.on("pageerror", (error) =>
  consoleErrors.push(`pageerror: ${String(error)}`),
);

/** The RPC tags one request carries: the NDJSON envelope may hold several. */
const rpcTags = (request) =>
  (request.postData() ?? "").split("\n").flatMap((line) => {
    try {
      const message = JSON.parse(line);
      return message?._tag === "Request" ? [message.tag] : [];
    } catch {
      return [];
    }
  });
const RPC_PATH = /\/rpc\/?$/;

/** Every `interruptSession` the page sent: the count the "exactly one call" check reads. */
const interruptCalls = [];
page.on("request", (request) => {
  if (!RPC_PATH.test(request.url()) || request.method() !== "POST") return;
  for (const tag of rpcTags(request)) {
    if (tag === "interruptSession") interruptCalls.push(request.url());
  }
});

const statusChip = () => page.locator("[data-session-status]").first();
const interruptButton = () =>
  page.getByRole("button", { name: "Interrupt this run" });
const composer = () => page.getByPlaceholder("Send a message to this session");

let exitCode = 0;
try {
  const created = await rpc("createSession", {
    requestId: `verify-web-interrupt-${Date.now()}`,
    title: "interrupt drive",
  });
  const sessionId = created.id;
  observed.sessionId = sessionId;
  await page.goto(`${WEB_URL}/sessions/${sessionId}`, {
    waitUntil: "domcontentloaded",
  });
  await statusChip().waitFor({ timeout: 15_000 });
  await rpc("sendMessage", { sessionId, content: "take your time" });

  // --- stop: one press, one call, idle, and no faux-ok -----------------------------------------
  await interruptButton().waitFor({ timeout: 15_000 });
  await page.screenshot({
    path: path.join(EVIDENCE_DIR, "interrupt-busy.png"),
    fullPage: true,
  });
  const pressedAt = Date.now();
  await interruptButton().click();
  await page
    .locator('[data-session-status="idle"]')
    .first()
    .waitFor({ timeout: POLL_WINDOW_MS });
  const idleAfterMs = Date.now() - pressedAt;
  assert(
    "the header goes idle within the poll window after the press",
    idleAfterMs <= POLL_WINDOW_MS,
    `${idleAfterMs}ms`,
  );
  // Long enough for both naps of the turn: a run the press missed would have printed by now.
  await sleep(SLEEP_MS * 2 + 1_000);
  assert(
    "the press sent exactly one interruptSession",
    interruptCalls.length === 1,
    `${interruptCalls.length} call(s)`,
  );
  const stopped = await rpc("getSession", { sessionId });
  const pageText = await page.getByLabel("Transcript").innerText();
  assert(
    "the run never printed faux-ok, in the log or on the page",
    !printed(stopped) && !pageText.includes("faux-ok") && !stopped.live.busy,
    `kinds=${JSON.stringify(stopped.entries.map((entry) => entry.kind))}`,
  );

  // --- marker: the transcript ends the turn ------------------------------------------------------
  const markerRows = page.locator('[data-entry-kind="interrupted"]');
  assert(
    "the transcript shows the interrupted turn as its own row",
    (await markerRows.count()) === 1 &&
      (await markerRows.first().innerText()).includes("interrupted"),
    (await markerRows.count()) === 1
      ? await markerRows.first().innerText()
      : `${await markerRows.count()} row(s)`,
  );
  assert(
    "the log ends the turn with the interrupted entry",
    stopped.entries.at(-1)?.kind === "interrupted",
    JSON.stringify(stopped.entries.at(-1) ?? null),
  );
  await page.screenshot({
    path: path.join(EVIDENCE_DIR, "interrupt-stopped.png"),
    fullPage: true,
  });

  // --- follow-up: the next message runs normally ------------------------------------------------
  await composer().fill("now finish");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page
    .getByText("faux-ok", { exact: false })
    .first()
    .waitFor({ timeout: SLEEP_MS * 3 + 15_000 });
  const followed = await until(
    "the follow-up to settle",
    async () => {
      const snapshot = await rpc("getSession", { sessionId });
      return !snapshot.live.busy &&
        snapshot.entries.at(-1)?.kind === "assistant"
        ? snapshot
        : null;
    },
    SLEEP_MS * 3 + 15_000,
  );
  await page
    .locator('[data-session-status="idle"]')
    .first()
    .waitFor({ timeout: POLL_WINDOW_MS });
  assert(
    "a follow-up message runs normally and answers",
    printed(followed) &&
      (followed.entries.at(-1)?.text ?? "").length > 0 &&
      followed.entries.filter((entry) => entry.kind === "interrupted")
        .length === 1,
    `last=${JSON.stringify(followed.entries.at(-1) ?? null)}`,
  );
  await page.screenshot({
    path: path.join(EVIDENCE_DIR, "interrupt-follow-up.png"),
    fullPage: true,
  });

  // --- refused: the run settles before the interrupt lands --------------------------------------
  // The press is held in the browser until the server says the run is over, so the interrupt
  // reaches an idle session: the race a real operator loses when the answer lands under the click.
  await page.route(RPC_PATH, async (route) => {
    if (!rpcTags(route.request()).includes("interruptSession"))
      return route.fallback();
    await until(
      "the held run to settle",
      async () => !(await rpc("getSession", { sessionId })).live.busy,
      SLEEP_MS * 3 + 15_000,
    );
    return route.continue();
  });
  await composer().fill("one more");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await interruptButton().waitFor({ timeout: 15_000 });
  await interruptButton().click();
  const expected = `session ${sessionId} is not running: there was no run to interrupt`;
  const toast = page.locator("[data-sonner-toast]").filter({
    hasText: "Nothing to interrupt",
  });
  await toast.first().waitFor({ timeout: SLEEP_MS * 3 + 15_000 });
  const toastText = await toast.first().innerText();
  assert(
    "a refused interrupt is a toast in the server's words",
    toastText.includes(expected),
    toastText.replace(/\s+/g, " "),
  );
  await page.screenshot({
    path: path.join(EVIDENCE_DIR, "interrupt-refused.png"),
    fullPage: true,
  });
  const after = await rpc("getSession", { sessionId });
  assert(
    "the refused interrupt wrote nothing: still one interrupted entry",
    after.entries.filter((entry) => entry.kind === "interrupted").length === 1,
    `kinds=${JSON.stringify(after.entries.map((entry) => entry.kind))}`,
  );
  assert(
    "two presses in the drive sent two interruptSession calls",
    interruptCalls.length === 2,
    `${interruptCalls.length} call(s)`,
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
      path: path.join(EVIDENCE_DIR, "interrupt-failure.png"),
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
