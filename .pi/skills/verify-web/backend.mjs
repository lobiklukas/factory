// Drive the dashboard against an anthropic-backed control plane (LOB-272), the instance
// `backend.sh` starts, and capture evidence.
//
//   node backend.mjs      (via ./backend.sh, which owns the instance)
//
// The faux half of the story is in `drive.mjs`: the banner on /sessions and on a board. This is the
// half it cannot reach, because that instance is scripted:
//
//   info      `getServerInfo` says anthropic, chosen by a credential, and carries no warning
//   banner    no `[data-backend-banner]` on /sessions, on a board, or on /spend: the page waits for
//             the page's own `getServerInfo` read to land first, so "no banner" is not "not loaded yet"
//   header    a session created over the RPC (no message sent, so no model request) opens with
//             `anthropic/claude-sonnet-5-5` in its pane header, equal to what `getSession` records
//   row       the same model on its row in the session list
//   cli       `factory status` names the backend and why, and `factory ls` has a model column that
//             carries the session's model (the faux half of both is `verify-cli/drive.sh`)
//
// Env: WEB_URL, API_URL, EVIDENCE_DIR, BOARD_SEED (the seed's JSON line), FACTORY_CLI.
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";

const WEB_URL = process.env["WEB_URL"] ?? "http://localhost:3451";
const API_URL = process.env["API_URL"] ?? "http://localhost:9451";
const EVIDENCE_DIR =
  process.env["EVIDENCE_DIR"] ?? ".verify/evidence/latest/backend";
const FACTORY_CLI = process.env["FACTORY_CLI"] ?? "apps/cli/src/index.ts";
const MODEL = "anthropic/claude-sonnet-5-5";

await mkdir(EVIDENCE_DIR, { recursive: true });

const boardId = (() => {
  try {
    return String(JSON.parse(process.env["BOARD_SEED"] ?? "{}").boardId ?? "");
  } catch {
    return "";
  }
})();

const rpc = async (tag, payload) => {
  const requestId = `backend-${tag}-${Date.now()}`;
  const response = await fetch(`${API_URL}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/ndjson" },
    body: `${JSON.stringify({ _tag: "Request", id: requestId, tag, payload, headers: [] })}\n`,
  });
  const envelope = (await response.text())
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line))
    .find((message) => message?.requestId === requestId);
  return { exit: envelope?.exit?._tag ?? null, value: envelope?.exit?.value };
};

const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const consoleErrors = [];
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});

const observed = { webUrl: WEB_URL, apiUrl: API_URL, checks: {} };
const assert = (name, condition, detail) => {
  observed.checks[name] = { passed: Boolean(condition), detail };
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}  ${detail}`);
  return Boolean(condition);
};

const info = await rpc("getServerInfo", {});
observed.info = info.value;
assert(
  "the server runs anthropic, chosen by a credential, with no warning",
  info.value?.backend === "anthropic" &&
    info.value?.selectedBy === "credential" &&
    info.value?.warnings?.length === 0,
  `backend=${info.value?.backend} selectedBy=${info.value?.selectedBy} warnings=${JSON.stringify(info.value?.warnings)}`,
);
assert(
  "its default model is the one the pane will show",
  info.value?.defaultModel === MODEL,
  `defaultModel=${info.value?.defaultModel}`,
);

/** Open a route and wait for the page's own `getServerInfo` read to land, then let it render. */
const open = async (route) => {
  const read = page.waitForResponse(
    (response) =>
      /\/rpc\/?$/.test(response.url()) &&
      (response.request().postData() ?? "").includes("getServerInfo"),
    { timeout: 20_000 },
  );
  await page.goto(`${WEB_URL}${route}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("nav[aria-label='Sections']", { timeout: 15_000 });
  const answered = await read.then(
    (response) => response.status(),
    () => null,
  );
  await page.waitForTimeout(600);
  return {
    route,
    answered,
    banners: await page.locator("[data-backend-banner]").count(),
    alerts: await page.locator("[role='alert']").allInnerTexts(),
  };
};

const sessions = await open("/sessions");
const board = boardId === "" ? null : await open(`/boards/${boardId}`);
const spend = await open("/spend");
observed.routes = { sessions, board, spend };
assert(
  "no banner on /sessions, after the page's own getServerInfo read",
  sessions.answered === 200 && sessions.banners === 0,
  JSON.stringify(sessions),
);
assert(
  "no banner on a board",
  board !== null && board.answered === 200 && board.banners === 0,
  JSON.stringify(board),
);
assert(
  "no banner on /spend",
  spend.answered === 200 && spend.banners === 0,
  JSON.stringify(spend),
);

const created = await rpc("createSession", { actor: "verify-backend" });
const sessionId = created.value?.id ?? "";
const read = await rpc("getSession", { sessionId });
const recorded = read.value?.session?.model ?? null;
assert(
  "a session created on this server records anthropic/claude-sonnet-5-5",
  sessionId !== "" && recorded === MODEL && created.value?.model === MODEL,
  `createSession model=${created.value?.model} getSession model=${recorded}`,
);

await page.goto(`${WEB_URL}/sessions/${sessionId}`, {
  waitUntil: "domcontentloaded",
});
const pane = page.locator("header [data-session-model]");
await pane
  .first()
  .waitFor({ timeout: 20_000 })
  .catch(() => undefined);
const paneText =
  (await pane.count()) > 0 ? (await pane.first().innerText()).trim() : null;
const row = page.locator(
  `aside a[href='/sessions/${sessionId}'] [data-session-model]`,
);
await row
  .first()
  .waitFor({ timeout: 20_000 })
  .catch(() => undefined);
const rowText =
  (await row.count()) > 0 ? (await row.first().innerText()).trim() : null;
await page.screenshot({ path: path.join(EVIDENCE_DIR, "backend-pane.png") });
observed.session = { sessionId, recorded, paneText, rowText };
assert(
  "the pane header shows anthropic/claude-sonnet-5-5, with no banner above it",
  paneText === MODEL &&
    (await page.locator("[data-backend-banner]").count()) === 0,
  `pane=${paneText}`,
);
assert(
  "its list row shows the same model",
  rowText === MODEL,
  `row=${rowText}`,
);

const factory = (...args) => {
  const run = spawnSync(
    "bun",
    ["run", FACTORY_CLI, ...args, "--api", API_URL],
    {
      encoding: "utf8",
      timeout: 60_000,
    },
  );
  return { status: run.status, out: run.stdout ?? "", err: run.stderr ?? "" };
};
const status = factory("status");
const ls = factory("ls");
await writeFile(
  path.join(EVIDENCE_DIR, "cli.txt"),
  `$ factory status\n${status.out}${status.err}\n$ factory ls\n${ls.out}${ls.err}`,
);
assert(
  "factory status names the backend and the reason it was chosen",
  status.status === 0 &&
    status.out.includes("backend anthropic\n") &&
    status.out.includes("selected-by credential\n") &&
    status.out.includes("reason model backend: anthropic") &&
    !status.out.includes("sk-ant-verify-backend-dummy") &&
    !status.out.includes("warning"),
  status.out.split("\n").slice(0, 3).join(" | "),
);
const lsHeader = ls.out.split("\n")[0] ?? "";
const lsRow =
  ls.out.split("\n").find((line) => line.startsWith(sessionId)) ?? "";
assert(
  "factory ls has a model column carrying the session's model",
  ls.status === 0 &&
    /\smodel\s/.test(lsHeader) &&
    lsRow.split(/\s+/)[lsHeader.split(/\s+/).indexOf("model")] === MODEL,
  `header=${JSON.stringify(lsHeader)} row=${JSON.stringify(lsRow.slice(0, 160))}`,
);

observed.consoleErrors = consoleErrors;
await writeFile(
  path.join(EVIDENCE_DIR, "observed.json"),
  `${JSON.stringify(observed, null, 2)}\n`,
);
await browser.close();

const failures = Object.entries(observed.checks).filter(([, c]) => !c.passed);
if (failures.length > 0) {
  console.error(`\n${failures.length} required check(s) failed`);
  process.exitCode = 1;
}
