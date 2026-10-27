// Drive the web dashboard the way a user does and capture evidence.
//
//   node drive.mjs
//
// Env:
//   WEB_URL       default http://localhost:3100
//   API_URL       default http://localhost:9100
//   EVIDENCE_DIR  default .verify/evidence/latest
//   DATABASE_URL  the API's database, inherited: the board block seeds its own board into it, and
//                 the PR-link check seeds a session through it (LOB-65, `.pi/skills/lib/seed-pr.ts`)
//
// Uses the locally installed Chrome (channel: "chrome") instead of a downloaded
// Playwright browser, so this runs without a browser download.
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const WEB_URL = process.env["WEB_URL"] ?? "http://localhost:3100";
const API_URL = process.env["API_URL"] ?? "http://localhost:9100";
const EVIDENCE_DIR = process.env["EVIDENCE_DIR"] ?? ".verify/evidence/latest";
const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

/**
 * One RPC call from the drive process itself, not the page (LOB-75): the board checks need the
 * server's own answer as their oracle, and a call made here can never be mistaken for one the
 * dashboard sent. Same NDJSON envelope as the in-page calls below.
 */
const rpcFromDrive = async (tag, payload) => {
  const requestId = `drive-node-${tag}-${Date.now()}`;
  try {
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
    return {
      status: response.status,
      exit: envelope?.exit?._tag ?? null,
      value: envelope?.exit?.value ?? null,
      cause: envelope?.exit?.cause ?? null,
      raw: envelope === undefined ? text.slice(0, 400) : null,
    };
  } catch (error) {
    return {
      status: 0,
      exit: null,
      value: null,
      cause: null,
      raw: String(error),
    };
  }
};

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

// The sidebar is the server's list (LOB-75 deleted the browser-local registry): once it has
// loaded, its rows are `listSessions`' first page in the server's order, or its empty state when the
// server has none. A fresh browser has no storage, so a row here can only have come from the API.
await page
  .waitForFunction(
    () =>
      document.querySelectorAll("aside a[href^='/sessions/']").length > 0 ||
      document.querySelector("aside")?.innerText.includes("No sessions on") ===
        true,
    null,
    { timeout: 15_000 },
  )
  .catch(() => undefined);
const sidebarRows = await page.evaluate(() =>
  Array.from(document.querySelectorAll("aside a[href^='/sessions/']")).map(
    (anchor) => (anchor.getAttribute("href") ?? "").replace("/sessions/", ""),
  ),
);
const serverList = await rpcFromDrive("listSessions", { limit: 50 });
const serverIds = (serverList.value?.sessions ?? []).map((entry) => entry.id);
const emptyState = (await page.locator("aside").first().innerText()).trim();
observed.sidebarBefore = { sidebarRows, serverIds, emptyState };
assert(
  "the sidebar is the server's session list",
  serverList.exit === "Success" &&
    JSON.stringify(sidebarRows) === JSON.stringify(serverIds) &&
    (serverIds.length > 0 ||
      emptyState.includes("No sessions on this control plane yet")),
  `sidebar ${sidebarRows.length} row(s), listSessions ${serverIds.length} (${String(serverList.exit)}); first ${JSON.stringify(sidebarRows[0] ?? null)} vs ${JSON.stringify(serverIds[0] ?? null)}`,
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

// Feature: the live-tasks panel (LOB-184). Pi Durable's task graph is what the run is doing right
// now, and `up.sh` scripts a faux command that sleeps, so the bash tool's own task stays on screen
// long enough to read twice. This block runs before the answer wait on purpose: the task exists only
// while the tool call is in flight.
const taskPanel = page.locator("section[aria-label='Live tasks']");
const taskRows = taskPanel.locator("ul[aria-label='Live task rows'] > li");
const toolRow = taskRows.filter({ hasText: "pi.tool" }).first();
const tasksObserved = {};
let tasksWorked = false;
try {
  // A reload would drop this marker, which is how the settle check below stays honest about
  // "without a reload" rather than inferring it from a screenshot.
  await page.evaluate(() => {
    window.__liveTasksNoReload = true;
  });

  await toolRow.waitFor({ timeout: 20_000 });
  tasksObserved.row = (await toolRow.innerText()).replaceAll("\n", " ").trim();
  tasksObserved.count = await taskRows.count();

  // Keyboard: the header's last control tabs into the task list, and the list carries a name. Fork
  // is the last control since LOB-75 removed Forget, which only ever edited a browser-local list.
  await page.getByRole("button", { name: "Fork from here" }).focus();
  await page.keyboard.press("Tab");
  tasksObserved.focus = await page.evaluate(() => ({
    label: document.activeElement?.getAttribute("aria-label") ?? null,
    tag: document.activeElement?.tagName ?? null,
  }));

  // 1280x800: neither the document nor the panel may overflow sideways, and no row may run its
  // cells into each other (a row whose middle column cannot shrink overlaps instead of scrolling,
  // so scrollWidth alone cannot see it).
  await page.setViewportSize({ width: 1280, height: 800 });
  tasksObserved.overflow = await page.evaluate(() => {
    const panel = document.querySelector("section[aria-label='Live tasks']");
    const rows = [
      ...document.querySelectorAll("ul[aria-label='Live task rows'] > li"),
    ];
    const overlapping = rows.filter((row) => {
      const [badge, middle, age] = [...row.children].map((child) =>
        child.getBoundingClientRect(),
      );
      if (badge === undefined || middle === undefined || age === undefined)
        return false;
      return badge.right > middle.left + 0.5 || middle.right > age.left + 0.5;
    }).length;
    return {
      document:
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
      panel: panel === null ? -1 : panel.scrollWidth - panel.clientWidth,
      overlapping,
    };
  });
  await page.screenshot({
    path: path.join(EVIDENCE_DIR, "live-tasks-1280x800.png"),
  });
  await page.setViewportSize({ width: 1440, height: 900 });

  // An age that grows: the row's own clock advances while the task runs.
  const ageCell = toolRow.locator("[data-task-age]");
  tasksObserved.ageFirst = Number(await ageCell.getAttribute("data-task-age"));
  tasksObserved.ageText = (await ageCell.innerText()).trim();
  await page.waitForTimeout(3_000);
  tasksObserved.ageSecond = Number(await ageCell.getAttribute("data-task-age"));
  tasksWorked = true;
} catch (error) {
  tasksObserved.error = String(error).slice(0, 300);
}

assert(
  "the live task tree shows a running task",
  tasksWorked && (tasksObserved.row ?? "").toLowerCase().includes("running"),
  tasksWorked
    ? `row: ${JSON.stringify(tasksObserved.row)}`
    : `no pi.tool row within 20s (${tasksObserved.error ?? ""}); panel: ${JSON.stringify((await taskPanel.innerText()).slice(0, 200))}`,
);
assert(
  "the task's age grows",
  tasksWorked && tasksObserved.ageSecond > tasksObserved.ageFirst,
  `age ${tasksObserved.ageFirst}s -> ${tasksObserved.ageSecond}s (row said ${JSON.stringify(tasksObserved.ageText)})`,
);
assert(
  "the task list is reachable by keyboard",
  tasksObserved.focus?.label === "Live task rows",
  `Tab from the header landed on ${JSON.stringify(tasksObserved.focus)}`,
);
assert(
  "the panel does not overflow at 1280x800",
  tasksObserved.overflow !== undefined &&
    tasksObserved.overflow.document <= 0 &&
    tasksObserved.overflow.panel <= 0 &&
    tasksObserved.overflow.overlapping === 0,
  `overflow ${JSON.stringify(tasksObserved.overflow)}`,
);
observed.tasks = tasksObserved;

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

// A task that settles leaves the panel: the graph no longer carries it, the stream says so, and the
// strip goes back to its empty state in the same document the run started in.
await page
  .waitForFunction(
    () =>
      document.querySelectorAll("ul[aria-label='Live task rows'] > li")
        .length === 0,
    null,
    { timeout: 5_000 },
  )
  .catch(() => undefined);
const settledRows = await taskRows.count();
const settledPanel = (await taskPanel.innerText()).trim();
const noReload = await page.evaluate(() => window.__liveTasksNoReload === true);
observed.tasksSettled = { settledRows, settledPanel, noReload };
assert(
  "a settled task leaves the panel without a reload",
  sessionWorked && settledRows === 0 && noReload,
  `${settledRows} row(s) after the run settled; same document: ${noReload}; panel: ${JSON.stringify(settledPanel.slice(0, 160))}`,
);
assert(
  "an idle session says there are no tasks",
  settledPanel.includes("No tasks"),
  `panel: ${JSON.stringify(settledPanel.slice(0, 160))}`,
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
// A session with no PR has no PR anchor (LOB-65): the link is the recorded `prUrl`, and this session
// never opened one. The seeded case below is the other half.
const noPrAnchors = await page.locator("[data-pr-link]").count();
assert(
  "a session with no PR shows no PR link",
  noPrAnchors === 0,
  `${noPrAnchors} PR anchor(s) in the pane`,
);

// The created session is in the sidebar: the create invalidates the server's list
// (`SESSIONS_KEY`), so the row is the API's, not something this browser recorded.
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

// Feature: fork lineage and the fork action (LOB-182). The action has to be reachable with the
// keyboard alone, so the fork below is taken with Tab and Enter, not a mouse click. See
// features/fork-lineage.md.
const parentId = sessionPath.replace("/sessions/", "");
const focusedName = () =>
  page.evaluate(() => {
    const element = document.activeElement;
    if (!(element instanceof HTMLElement)) return "";
    return (
      element.getAttribute("aria-label") ??
      (element.textContent ?? "").trim().slice(0, 40)
    );
  });
// Start the keyboard walk from the document, so the order recorded below is the tab order a
// reader gets after a reload rather than whatever the previous check left focused.
await page.evaluate(() => {
  if (document.activeElement instanceof HTMLElement)
    document.activeElement.blur();
});
// The sidebar is the server's session list (LOB-75), so every session on the database sits in the
// tab order before the pane: the walk's budget grows with the links the sidebar renders, or a
// database that has seen a few drive runs pushes the fork action past a fixed cap.
const sidebarLinks = await page.locator("a[href^='/sessions/']").count();
const tabOrder = [];
for (let step = 0; step < 30 + sidebarLinks; step += 1) {
  await page.keyboard.press("Tab");
  const name = await focusedName();
  tabOrder.push(name);
  if (tabOrder.includes("Fork from here")) break;
}
const forkIndex = tabOrder.indexOf("Fork from here");
observed.tabOrder = tabOrder;
assert(
  "the fork action is reachable by keyboard",
  forkIndex !== -1,
  `tab order: ${JSON.stringify(tabOrder)}`,
);
// Forget only ever dropped a row from the browser-local registry; with the list on the server it
// would be a control that does nothing a reload does not undo (LOB-75).
const forgetControls = await page
  .getByRole("button", { name: "Forget this session" })
  .count();
assert(
  "no Forget control remains",
  forgetControls === 0,
  `${forgetControls} Forget control(s) in the pane`,
);
// Walk back to the Fork control and activate it with Enter, so the fork below is taken with the
// keyboard alone rather than by a click the reader could not repeat.
let onFork = false;
for (let step = 0; step < 30; step += 1) {
  if ((await focusedName()) === "Fork from here") {
    onFork = true;
    break;
  }
  await page.keyboard.press("Shift+Tab");
}
assert(
  "focus returns to the fork action",
  onFork,
  `focus is ${await focusedName()}`,
);

let forkedPath = null;
try {
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    (previous) => {
      const match = window.location.pathname.match(/^\/sessions\/(ses_[^/]+)$/);
      return match !== null && match[1] !== previous;
    },
    parentId,
    { timeout: 30_000 },
  );
  forkedPath = new URL(page.url()).pathname;
} catch {
  forkedPath = null;
}
const childId = forkedPath === null ? "" : forkedPath.replace("/sessions/", "");
observed.fork = { parentId, forkedPath, childId };
assert(
  "the fork action opens the new session",
  childId !== "" && childId !== parentId,
  `parent ${parentId}, after Enter ${JSON.stringify(forkedPath ?? page.url())}`,
);

// Both sessions are listed, and only the child carries the lineage. A row that renders `forked
// from` for the parent would mean the field is being read off the wrong row.
let rows = [];
if (childId !== "") {
  try {
    await page.waitForFunction(
      () =>
        document.querySelectorAll("aside a[href^='/sessions/']").length >= 2,
      null,
      { timeout: 15_000 },
    );
  } catch {
    // The assertion below reports the rows it did get.
  }
  rows = await page.evaluate(() =>
    Array.from(document.querySelectorAll("aside a[href^='/sessions/']")).map(
      (anchor) => ({
        href: anchor.getAttribute("href") ?? "",
        text: (anchor.textContent ?? "").replace(/\s+/g, " ").trim(),
      }),
    ),
  );
  observed.sidebarRows = rows;
  const parentRow = rows.find((row) => row.href === `/sessions/${parentId}`);
  const childRow = rows.find((row) => row.href === `/sessions/${childId}`);
  assert(
    "the sidebar lists both the parent and the fork",
    parentRow !== undefined && childRow !== undefined,
    `rows: ${JSON.stringify(rows.map((row) => row.href))}`,
  );
  assert(
    "the fork's row shows its lineage",
    childRow !== undefined && childRow.text.includes(`forked from ${parentId}`),
    `child row: ${JSON.stringify(childRow?.text ?? null)}`,
  );
  assert(
    "the parent's row shows no lineage",
    parentRow !== undefined && !parentRow.text.includes("forked from"),
    `parent row: ${JSON.stringify(parentRow?.text ?? null)}`,
  );
  await page.screenshot({
    path: path.join(EVIDENCE_DIR, "fork-lineage.png"),
    fullPage: true,
  });

  // The sidebar reads `listSessions` (LOB-75), so the rows above already are the index's. This asks
  // the same list from inside the page, so `SessionListEntry.forkedFrom` — the index fold's half of
  // the contract (LOB-182) — is asserted on the wire too, and the assertion covers the
  // RPC, the schema, and the CORS path the dashboard uses. `_tag: "Request"` + a trailing newline
  // is the NDJSON envelope `RpcClient.layerProtocolHttp` writes — the same bytes
  // `apps/web/src/lib/rpc-client.ts` would send for `listSessions`.
  const listRpc = `drive-list-${Date.now()}`;
  observed.listSessions = await page.evaluate(
    async ({ apiUrl, requestId }) => {
      const response = await fetch(`${apiUrl}/rpc`, {
        method: "POST",
        headers: { "content-type": "application/ndjson" },
        body: `${JSON.stringify({
          _tag: "Request",
          id: requestId,
          tag: "listSessions",
          payload: { limit: 100 },
          headers: [],
        })}\n`,
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
      return {
        status: response.status,
        exit: envelope?.exit?._tag ?? null,
        sessions: envelope?.exit?.value?.sessions ?? null,
        raw: envelope === undefined ? text.slice(0, 400) : null,
      };
    },
    { apiUrl: API_URL, requestId: listRpc },
  );
  const indexSessions = observed.listSessions.sessions ?? [];
  const indexParent = indexSessions.find((entry) => entry.id === parentId);
  const indexChild = indexSessions.find((entry) => entry.id === childId);
  assert(
    "the list RPC serves the fork's lineage on the child only",
    indexChild?.forkedFrom === parentId &&
      indexParent !== undefined &&
      indexParent.forkedFrom === undefined,
    `exit ${String(observed.listSessions.exit)}, child forkedFrom ` +
      `${JSON.stringify(indexChild?.forkedFrom ?? null)}, parent forkedFrom ` +
      `${JSON.stringify(indexParent?.forkedFrom ?? null)}`,
  );

  // Narrow width: the lineage line must not widen the page. The sidebar is a fixed 16rem, so what
  // this proves is that the new third line truncates inside the row instead of pushing the document
  // wider. The header's own clipping at 390 px is pre-existing (the header's last button is cut
  // off too, because the shell has no breakpoint); its numbers are recorded, not asserted — see
  // `.ralph/polish.md` and the ticket filed for it.
  await page.setViewportSize({ width: 390, height: 844 });
  observed.narrowWidth = await page.evaluate((child) => {
    const fork = Array.from(document.querySelectorAll("header button")).find(
      (button) => button.getAttribute("aria-label") === "Fork from here",
    );
    const box = fork?.getBoundingClientRect();
    // Readability, not just layout: the lineage line has to sit inside its own row (a `truncate`d
    // span that broke out of the row would be the same defect as widening the page, one level
    // down) and still have a box tall enough to be read.
    const row = document.querySelector(`aside a[href='/sessions/${child}']`);
    const lineage = Array.from(row?.querySelectorAll("span") ?? []).find(
      (span) => (span.textContent ?? "").startsWith("forked from "),
    );
    const rowBox = row?.getBoundingClientRect();
    const lineageBox = lineage?.getBoundingClientRect();
    return {
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      forkBox:
        box === undefined
          ? null
          : { left: box.left, right: box.right, width: box.width },
      lineageBox:
        lineageBox === undefined || rowBox === undefined
          ? null
          : {
              left: lineageBox.left,
              right: lineageBox.right,
              width: lineageBox.width,
              height: lineageBox.height,
              rowRight: rowBox.right,
            },
    };
  }, childId);
  assert(
    "the lineage line does not widen the page at 390px",
    observed.narrowWidth.scrollWidth <= observed.narrowWidth.clientWidth,
    `scrollWidth ${observed.narrowWidth.scrollWidth} vs clientWidth ${observed.narrowWidth.clientWidth}`,
  );
  const lineageBox = observed.narrowWidth.lineageBox;
  assert(
    "the lineage line stays readable inside its row at 390px",
    lineageBox !== null &&
      lineageBox.width > 0 &&
      lineageBox.height > 0 &&
      lineageBox.right <= lineageBox.rowRight + 1,
    `lineage ${JSON.stringify(lineageBox)}`,
  );
  await page.screenshot({
    path: path.join(EVIDENCE_DIR, "fork-lineage-narrow.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 900 });
}

// Feature: compact now from the pane (LOB-223). A compaction is a task in the session's log, so its
// summary arrives as a transcript entry — and the operator has to see it with what it cost. Part 1
// (LOB-222) added the spend arithmetic and the atom; what this block proves is the button, the row
// that renders the summary, and the header reading before and after it. See features/compaction.md.
//
// The session is created through the control plane's own RPC rather than the sidebar's New session
// button (whose first message is fixed) because the message has to be ~90k characters *first*: Pi
// Durable summarizes an old prefix and keeps the newest `keepRecentTokens` verbatim, so a short
// session has no cut and the task would settle without writing a summary. The compaction itself is
// pressed on the real button.
const longMessage = "y".repeat(90_000);
const callRpcOnce = async (tag, payload) => {
  const requestId = `drive-${tag}-${Date.now()}`;
  return page.evaluate(
    async ({ apiUrl, requestId, tag, payload }) => {
      const response = await fetch(`${apiUrl}/rpc`, {
        method: "POST",
        headers: { "content-type": "application/ndjson" },
        body: `${JSON.stringify({
          _tag: "Request",
          id: requestId,
          tag,
          payload,
          headers: [],
        })}\n`,
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
      return {
        status: response.status,
        exit: envelope?.exit?._tag ?? null,
        value: envelope?.exit?.value ?? null,
        raw: envelope === undefined ? text.slice(0, 400) : null,
      };
    },
    { apiUrl: API_URL, requestId, tag, payload },
  );
};

// Targeted by its own attribute, not its accessible name: the name changes with the state
// (`Compact session` / `Compacting session`, LOB-224), and a locator must survive both.
const compactButton = page.locator("button[data-compaction-state]");
const usageChip = page.locator("[data-session-usage]");
const spendLine = page.locator("[data-compaction-spend]");

/**
 * Record every render of the pane's compaction status until asked to stop (LOB-224).
 *
 * A compaction task can settle in a few hundred milliseconds, and a poll would miss the pending
 * state it is there to prove. The observer sees each mount, so the sequence it records is evidence
 * that the pending state really replaced, and was replaced by, the verdict — and each sample keeps
 * whether the "Nothing to compact" text was on screen at that moment and how tall the status box
 * was, which is what the premature-verdict and layout checks need.
 */
const watchCompactionStatus = () =>
  page.evaluate(() => {
    window.__compactionSamples = [];
    const snap = () => {
      const element = document.querySelector("[data-compaction-status]");
      const sample = {
        state: element?.getAttribute("data-compaction-status") ?? null,
        verdictVisible: document.body.innerText.includes("Nothing to compact"),
        // Whether a run is in flight: the header chip is the pane's own word for it.
        busy: document.body.innerText.includes("BUSY"),
        height:
          element === null
            ? null
            : Math.round(element.getBoundingClientRect().height),
      };
      const last = window.__compactionSamples.at(-1);
      if (
        last === undefined ||
        last.state !== sample.state ||
        last.verdictVisible !== sample.verdictVisible ||
        last.busy !== sample.busy ||
        last.height !== sample.height
      )
        window.__compactionSamples.push(sample);
    };
    window.__compactionObserver = new MutationObserver(snap);
    window.__compactionObserver.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    snap();
  });

/** Stop recording and return the samples, in order. */
const readCompactionStatus = () =>
  page.evaluate(() => {
    window.__compactionObserver?.disconnect();
    return window.__compactionSamples ?? [];
  });
const SUMMARY = "Summary: the session ran its tools and kept working.";
const tokenCount = (text) => {
  const match = /([\d,]+) tokens/.exec(text);
  return match === null ? null : Number(match[1].replaceAll(",", ""));
};

const longCreated = await callRpcOnce("createSession", {});
const longSessionId = longCreated.value?.id ?? "";
if (longSessionId !== "") {
  const sent = await callRpcOnce("sendMessage", {
    sessionId: longSessionId,
    content: longMessage,
  });
  observed.compactionSession = {
    created: longCreated.exit,
    sent: sent.exit,
    sessionId: longSessionId,
  };
  assert(
    "the long session was created with a 90k-character first message",
    longSessionId.startsWith("ses_") && sent.exit === "Success",
    `create ${String(longCreated.exit)}, send ${String(sent.exit)} (${sent.raw ?? ""})`,
  );
  await page.goto(`${WEB_URL}/sessions/${longSessionId}`, {
    waitUntil: "domcontentloaded",
  });
} else {
  assert(
    "the long session was created with a 90k-character first message",
    false,
    `createSession answered ${JSON.stringify(longCreated).slice(0, 300)}`,
  );
}

// A busy session cannot be compacted on demand: the run is using the same context. The state has to
// say why, in the DOM, or a disabled button is a dead control. The faux script's command sleeps, so
// the run stays busy long enough to read the reason twice.
const busyCompact = {};
try {
  // Wait for the *busy* reason rather than for "disabled": the pane is disabled while it attaches
  // too, and attaching is not the state this check is about.
  await page.waitForFunction(
    () => {
      const button = document.querySelector("button[data-compaction-state]");
      return (
        button !== null &&
        button.disabled &&
        (button.getAttribute("title") ?? "").includes(
          "Wait for this run to finish",
        )
      );
    },
    null,
    { timeout: 20_000 },
  );
  busyCompact.disabled = await compactButton.isDisabled();
  busyCompact.title = await compactButton.getAttribute("title");
  busyCompact.describedBy = await page.evaluate(() => {
    const button = document.querySelector("button[data-compaction-state]");
    const id = button?.getAttribute("aria-describedby") ?? "";
    return {
      id,
      text: id === "" ? "" : (document.getElementById(id)?.textContent ?? ""),
    };
  });
} catch (error) {
  busyCompact.error = String(error).slice(0, 300);
}
observed.compactBusy = busyCompact;
assert(
  "Compact is disabled while the session is busy, with the reason in the DOM",
  busyCompact.disabled === true &&
    (busyCompact.title ?? "").includes("Wait for this run to finish") &&
    (busyCompact.describedBy?.text ?? "").includes(
      "Wait for this run to finish",
    ),
  `disabled=${String(busyCompact.disabled)} title=${JSON.stringify(busyCompact.title ?? null)} describedby=${JSON.stringify(busyCompact.describedBy ?? null)}`,
);

// The run has to settle before the compaction: a summary admitted while the turn was still writing
// its entries would have nothing to cut.
let longSessionIdle = false;
try {
  await page.waitForFunction(
    () => {
      const button = document.querySelector("button[data-compaction-state]");
      return button !== null && !button.disabled;
    },
    null,
    { timeout: 90_000 },
  );
  await page.waitForFunction(
    () => document.body.innerText.includes("IDLE"),
    null,
    { timeout: 30_000 },
  );
  longSessionIdle = true;
} catch {
  longSessionIdle = false;
}

const usageBefore = tokenCount(await usageChip.innerText().catch(() => ""));
observed.compactSpend = { idle: longSessionIdle, usageBefore };
assert(
  "the pane header reads the session's own usage before the compaction",
  longSessionIdle &&
    usageBefore !== null &&
    usageBefore > 0 &&
    !(await usageChip.innerText()).includes("$"),
  `header said ${JSON.stringify(observed.compactSpend.usageBefore)}, text ${JSON.stringify(await usageChip.innerText().catch(() => ""))}`,
);

let compacted = false;
await watchCompactionStatus();
try {
  await compactButton.click();
  await page.waitForFunction(
    (summary) => document.body.innerText.includes(summary),
    SUMMARY,
    { timeout: 90_000 },
  );
  compacted = true;
} catch (error) {
  observed.compactError = String(error).slice(0, 300);
  compacted = false;
}

// The spend line under the summary is measured from two readings of the same session, so it can
// arrive one stream event after the entry: wait for a number rather than reading once.
let spendText = "";
try {
  await page.waitForFunction(
    () => {
      const line = document.querySelector("[data-compaction-spend]");
      return line !== null && /[\d,]+ tokens/.test(line.textContent ?? "");
    },
    null,
    { timeout: 30_000 },
  );
  spendText = (await spendLine.first().innerText()).trim();
} catch {
  spendText = (
    await spendLine
      .first()
      .innerText()
      .catch(() => "")
  ).trim();
}
const usageAfterText = await usageChip.innerText().catch(() => "");
const usageAfter = tokenCount(usageAfterText);
observed.compactSpend = {
  ...observed.compactSpend,
  usageAfterText,
  usageAfter,
  spendText,
  compacted,
  transcript: (await page.locator("main, body").first().innerText()).slice(
    0,
    400,
  ),
};
assert(
  "the compaction's summary lands in the transcript with its spend",
  compacted &&
    // A number, not just the word: a delta of zero would mean the summarizer's own spend was never
    // measured, which is the one thing this line exists to show.
    /[1-9][\d,]* tokens/.test(spendText) &&
    // Faux reports no cost, so there is no dollar figure to invent (LOB-222's rule).
    !spendText.includes("$"),
  `summary on screen=${compacted}, spend line ${JSON.stringify(spendText)}`,
);
assert(
  "the header shows a non-zero token count after the compaction too",
  usageAfter !== null && usageAfter > 0 && usageAfter >= (usageBefore ?? 0),
  `header ${JSON.stringify(usageBefore)} tokens before, ${JSON.stringify(usageAfter)} after (${JSON.stringify(usageAfterText)})`,
);

// The pending state, then the verdict it settles into (LOB-224). A summary landed, so the press is
// `settled-compacted`: the status box is gone and its own row is the answer. The pending state is
// recorded rather than awaited, because a compaction with a cut settles as soon as the model
// answers its summary — but it must have been on screen, and it must never have said "nothing to
// compact" while the task was live.
const longStates = await readCompactionStatus();
const longState = await page
  .locator("[data-compaction-status]")
  .first()
  .getAttribute("data-compaction-status");
observed.compactSettle = { longSession: longStates, longState };
assert(
  "a compaction that writes a summary shows the pending state first, and never a verdict",
  longStates.some((sample) => sample.state === "requested") &&
    longStates.every(
      (sample) =>
        sample.state !== "settled-nothing" &&
        !(sample.state === "requested" && sample.verdictVisible),
    ) &&
    // The row that landed is the answer, so the status box has nothing left to say.
    longState === "settled-compacted",
  `states ${JSON.stringify(longStates)} final ${JSON.stringify(longState)}`,
);
await page.screenshot({
  path: path.join(EVIDENCE_DIR, "compaction.png"),
  fullPage: true,
});

// A refused call must say so and leave the button usable. The refusal is injected at the network
// layer — the dashboard's own `compactSession` request gets a 500 — because there is no way to make
// the control plane refuse one for a session this pane is allowed to compact, and a swallowed error
// with a dead button is exactly the failure worth catching.
const failureToast = page.locator("[data-sonner-toast]", {
  hasText: "No compaction was started",
});
// The client posts to `/rpc/` (Effect's Http protocol normalizes the trailing slash), so the route
// matches on the path rather than on a glob that would miss it.
const RPC_PATH = /\/rpc\/?$/;
await page.route(RPC_PATH, async (route) => {
  const body = route.request().postData() ?? "";
  if (body.includes('"compactSession"')) {
    return route.fulfill({
      status: 500,
      contentType: "text/plain",
      body: "drive: injected compaction failure",
    });
  }
  return route.continue();
});
let failedCompact = {};
try {
  await compactButton.click();
  await failureToast.first().waitFor({ timeout: 20_000 });
  failedCompact = {
    toast: (await failureToast.first().innerText()).replaceAll("\n", " "),
    disabled: await compactButton.isDisabled(),
    ariaBusy: await compactButton.getAttribute("aria-busy"),
    title: await compactButton.getAttribute("title"),
  };
} catch (error) {
  failedCompact = { error: String(error).slice(0, 300) };
}
await page.unroute(RPC_PATH);
observed.compactFailure = failedCompact;
assert(
  "a failed compaction shows a toast and leaves the button usable",
  (failedCompact.toast ?? "").includes("No compaction was started") &&
    failedCompact.disabled === false &&
    failedCompact.ariaBusy === "false",
  `toast=${JSON.stringify(failedCompact.toast ?? null)} disabled=${String(failedCompact.disabled)} aria-busy=${JSON.stringify(failedCompact.ariaBusy ?? null)} error=${failedCompact.error ?? "none"}`,
);

// Usable means it can be pressed again: the next attempt is admitted, and the button comes back
// rather than staying busy or eating the click.
let retried = false;
try {
  await failureToast.first().waitFor({ state: "hidden", timeout: 20_000 });
  await compactButton.click();
  await page.waitForFunction(
    () => {
      const button = document.querySelector("button[data-compaction-state]");
      return (
        button !== null &&
        !button.disabled &&
        button.getAttribute("aria-busy") === "false"
      );
    },
    null,
    { timeout: 30_000 },
  );
  retried = (await failureToast.first().count()) === 0;
} catch (error) {
  observed.compactRetryError = String(error).slice(0, 300);
  retried = false;
}
observed.compactRetry = { retried };
assert(
  "the button can be pressed again after a failure",
  retried,
  `retried=${retried}${observed.compactRetryError === undefined ? "" : ` (${observed.compactRetryError})`}`,
);

// Feature: a short session's Compact ends in a verdict, not a spinner that never stops (LOB-224).
//
// "Nothing to compact" is the one outcome `compactSession` cannot answer: pi-durable keeps the
// newest `keepRecentTokens` verbatim, so a transcript with no cut settles the task and writes no
// `compaction` entry at all. The pane therefore watches the session's live-task list for the task
// it admitted, and only then reads the transcript. This block proves both halves on a second,
// short session: the pending state appears and says nothing has been decided, then the verdict —
// with no spinner left behind — and the operator's next turn clears it. See
// features/compaction.md.
const shortCreated = await callRpcOnce("createSession", {});
const shortSessionId = shortCreated.value?.id ?? "";
if (shortSessionId !== "") {
  const sent = await callRpcOnce("sendMessage", {
    sessionId: shortSessionId,
    content:
      "Keep this turn short: run the command and tell me what it printed.",
  });
  observed.shortSession = {
    created: shortCreated.exit,
    sent: sent.exit,
    sessionId: shortSessionId,
  };
  assert(
    "a second, short session was created",
    shortSessionId.startsWith("ses_") && sent.exit === "Success",
    `create ${String(shortCreated.exit)}, send ${String(sent.exit)} (${shortCreated.raw ?? ""})`,
  );
  await page.goto(`${WEB_URL}/sessions/${shortSessionId}`, {
    waitUntil: "domcontentloaded",
  });
} else {
  assert(
    "a second, short session was created",
    false,
    `createSession answered ${JSON.stringify(shortCreated).slice(0, 300)}`,
  );
}

// The run has to be over before the button is pressable at all (`view.live.busy`).
let shortIdle = false;
try {
  await page.waitForFunction(
    () => {
      const button = document.querySelector("button[data-compaction-state]");
      return (
        button !== null &&
        !button.disabled &&
        document.body.innerText.includes("IDLE")
      );
    },
    null,
    { timeout: 90_000 },
  );
  shortIdle = true;
} catch {
  shortIdle = false;
}
assert(
  "the short session settles so Compact can be pressed",
  shortIdle,
  `idle=${shortIdle}`,
);

let shortSettled = false;
await watchCompactionStatus();
try {
  await compactButton.click();
  await page
    .locator("[data-compaction-status='settled-nothing']")
    .first()
    .waitFor({ timeout: 30_000 });
  shortSettled = true;
} catch (error) {
  observed.shortSettleError = String(error).slice(0, 300);
  shortSettled = false;
}

const shortStatus = page.locator("[data-compaction-status='settled-nothing']");
const shortStatusText = shortSettled
  ? (await shortStatus.first().innerText()).replaceAll("\n", " ").trim()
  : "";
const shortSamples = await readCompactionStatus();
const shortButton = {
  disabled: await compactButton.isDisabled(),
  ariaBusy: await compactButton.getAttribute("aria-busy"),
  state: await compactButton.getAttribute("data-compaction-state"),
};
const shortSpinners = await page
  .locator("[data-slot='compaction-status'] [data-slot='spinner']")
  .count();
// The button's own spinner covers the call, not the task: once the verdict is in, it must be gone
// too, or a second "still working" signal would survive the answer.
const shortButtonSpinners = await compactButton
  .locator("[data-slot='spinner']")
  .count();
observed.compactSettle = {
  ...observed.compactSettle,
  shortSession: shortSamples,
  shortStatusText,
  shortButton,
  shortSpinners,
  shortButtonSpinners,
};
assert(
  "compacting a short session ends in a visible verdict, not a spinner",
  shortSettled &&
    shortStatusText.includes("Nothing to compact") &&
    shortStatusText.includes("too short to cut") &&
    shortSpinners === 0 &&
    shortButtonSpinners === 0 &&
    shortButton.disabled === false &&
    shortButton.ariaBusy === "false" &&
    shortButton.state === "settled",
  `settled=${shortSettled} text=${JSON.stringify(shortStatusText)} spinners=${shortSpinners}/${shortButtonSpinners} button=${JSON.stringify(shortButton)}`,
);
assert(
  "the pending state was on screen first, and never beside a verdict",
  shortSamples.some((sample) => sample.state === "requested") &&
    shortSamples.every(
      (sample) => !(sample.state === "requested" && sample.verdictVisible),
    ) &&
    shortSamples.at(-1)?.state === "settled-nothing",
  `states ${JSON.stringify(shortSamples)}`,
);
await page.screenshot({
  path: path.join(EVIDENCE_DIR, "compaction-nothing-to-compact.png"),
  fullPage: true,
});

// The two states share one reserved box, so the verdict replaces the spinner without moving the
// rows above it. The samples carry each state's height as it was rendered.
const pendingHeight = shortSamples.find(
  (sample) => sample.state === "requested",
)?.height;
const verdictHeight = shortSamples.find(
  (sample) => sample.state === "settled-nothing",
)?.height;
assert(
  "the pending state and the verdict occupy the same height",
  typeof pendingHeight === "number" && pendingHeight === verdictHeight,
  `pending ${JSON.stringify(pendingHeight)}px, verdict ${JSON.stringify(verdictHeight)}px`,
);

// No horizontal overflow with the verdict on screen at a phone width. The *height* is deliberately
// not asserted here: at 390px the dashboard's own three-column shell leaves the transcript a ~60px
// column (measured, see `compaction-nothing-to-compact-narrow.png`), so the verdict's copy stacks one
// word per line and no reserved height on this box could keep the tail from growing. That squeeze is
// the shell's, not this control's; the reservation is proven above, at the drive's own widths.
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(300);
const narrow = await page.evaluate(() => {
  const element = document.querySelector("[data-compaction-status]");
  return {
    height:
      element === null
        ? null
        : Math.round(element.getBoundingClientRect().height),
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  };
});
observed.shortNarrow = narrow;
assert(
  "the pane does not overflow horizontally at 390px",
  narrow.scrollWidth <= narrow.clientWidth + 1,
  JSON.stringify(narrow),
);
await page.screenshot({
  path: path.join(EVIDENCE_DIR, "compaction-nothing-to-compact-narrow.png"),
  fullPage: true,
});
await page.setViewportSize({ width: 1440, height: 900 });

// A verdict describes the transcript at the press; the operator's next turn makes it stale, so the
// line goes rather than sitting above a log it no longer describes.
await page.locator("textarea").first().fill("One more turn.");
await page.locator("textarea").first().press("Enter");
let verdictCleared = false;
try {
  await page.waitForFunction(
    () =>
      document
        .querySelector("[data-compaction-status]")
        ?.getAttribute("data-compaction-status") === "idle",
    null,
    { timeout: 15_000 },
  );
  verdictCleared = true;
} catch {
  verdictCleared = false;
}
observed.verdictCleared = verdictCleared;
assert(
  "the operator's next turn clears the verdict",
  verdictCleared,
  `cleared=${verdictCleared}`,
);

// The third acceptance criterion (LOB-224): a busy session still shows the pending state, not the
// verdict. A press can only be admitted on an idle session — Compact is disabled while a run is in
// flight (`view.live.busy`) — but the session can start a turn *while its compaction task is still
// summarizing*, and then both are true at once. What must not happen is the verdict appearing under
// work that is still going on, so the observer samples the pane while the run is busier than the
// compaction: the recorded sample has to say `requested` with `busy: true` and no verdict text.
const busyCreated = await callRpcOnce("createSession", {});
const busySessionId = busyCreated.value?.id ?? "";
if (busySessionId !== "") {
  const sent = await callRpcOnce("sendMessage", {
    sessionId: busySessionId,
    content: longMessage,
  });
  observed.busySession = { sent: sent.exit, sessionId: busySessionId };
  assert(
    "a third, long session was created for the busy case",
    busySessionId.startsWith("ses_") && sent.exit === "Success",
    `send ${String(sent.exit)}`,
  );
  await page.goto(`${WEB_URL}/sessions/${busySessionId}`, {
    waitUntil: "domcontentloaded",
  });
} else {
  assert(
    "a third, long session was created for the busy case",
    false,
    `createSession answered ${JSON.stringify(busyCreated).slice(0, 300)}`,
  );
}

let busyIdle = false;
try {
  await page.waitForFunction(
    () => {
      const button = document.querySelector("button[data-compaction-state]");
      return (
        button !== null &&
        !button.disabled &&
        document.body.innerText.includes("IDLE")
      );
    },
    null,
    { timeout: 90_000 },
  );
  busyIdle = true;
} catch {
  busyIdle = false;
}
assert(
  "the third session settles so Compact can be pressed",
  busyIdle,
  `idle=${busyIdle}`,
);

await watchCompactionStatus();
// Press Compact, then send a turn, both in the *same* task so the run starts while the compaction is
// being admitted — the one way a session can be busy and pending a compaction the pane admitted,
// since Compact is disabled while a run is in flight.
//
// The click comes first for a reason: `requestSubmit` dispatches a submit event, React flushes that
// event's state before the next dispatch, and the button is `disabled` by then, so a click after the
// send is a no-op on a disabled element and the drive records no press at all. Measured, not assumed.
await page
  .locator("textarea")
  .first()
  .fill("Keep going while that summarizes.");
await page.evaluate(() => {
  document.querySelector("button[data-compaction-state]")?.click();
  document.querySelector("textarea")?.form?.requestSubmit();
});
/**
 * Wait for a predicate in the page, bounded, reporting whether it held.
 *
 * The busy case is a race in both directions: the run appears a beat after the send, and the
 * compaction settles a beat after the press. Waiting in one direction only is how the first version
 * of this check read "BUSY is false" before the run had started, stopped observing, and asserted on
 * a single idle sample.
 */
const waitInPage = async (predicate, timeout) => {
  try {
    await page.waitForFunction(predicate, null, { timeout, polling: "raf" });
    return true;
  } catch {
    return false;
  }
};
const compactionState = () =>
  page.evaluate(() =>
    document
      .querySelector("[data-compaction-status]")
      ?.getAttribute("data-compaction-status"),
  );
const busyStarted = await waitInPage(
  () => document.body.innerText.includes("BUSY"),
  30_000,
);
const busySettled = await waitInPage(
  () => !document.body.innerText.includes("BUSY"),
  90_000,
);
// The summariser can outlive the run, so the last sample can still be `requested` when the run ends.
// That is the check's own subject, not a failure: wait for the press to settle before reading.
const busyCompactionSettled = await waitInPage(
  () =>
    document
      .querySelector("[data-compaction-status]")
      ?.getAttribute("data-compaction-status") !== "requested",
  30_000,
);
const busySamples = await readCompactionStatus();
observed.compactSettle = {
  ...observed.compactSettle,
  busySession: busySamples,
  busyStarted,
  busySettled,
  busyCompactionSettled,
  busyFinalState: await compactionState(),
};
assert(
  "a busy session shows the pending state, never the verdict",
  busyStarted &&
    busySettled &&
    busyCompactionSettled &&
    busySamples.some(
      (sample) =>
        sample.state === "requested" &&
        sample.busy === true &&
        sample.verdictVisible === false,
    ) &&
    // The verdict is held, not discarded: it appears once the run is over, and never before.
    busySamples.every(
      (sample) => !(sample.busy === true && sample.verdictVisible === true),
    ),
  `started=${busyStarted} settled=${busySettled} compactionSettled=${busyCompactionSettled} states ${JSON.stringify(busySamples)}`,
);
await page.screenshot({
  path: path.join(EVIDENCE_DIR, "compaction-pending-while-busy.png"),
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
// The list is a server read now (LOB-75), so it arrives a beat after the route does.
await sessionLink.waitFor({ timeout: 10_000 }).catch(() => undefined);
if ((await sessionLink.count()) > 0) {
  await sessionLink.click();
  await page.waitForTimeout(1_500);
  const toolToggle = page.getByRole("button", { name: /bash/i }).first();
  if ((await toolToggle.count()) > 0) await toolToggle.click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(EVIDENCE_DIR, "transcript.png") });
}

// Feature: the board's lanes (LOB-75). See features/board.md.
//
// Lanes come from the definition, cards from the server, and the browser holds nothing between
// them. Each run seeds its **own** board and one card in `intake` through the real `TaskService`
// (`.pi/skills/verify-board/seed.ts`), so the drive can be rerun against the same `./up.sh`
// instance: the move below changes only this run's card. The oracle for the lane order is
// `getBoard` asked from this process, so a definition that reorders its columns changes the
// expectation rather than breaking the check. The lanes themselves never change a card: every move
// below is made in the card pane (LOB-76) or by `factory board move`, and every request the board
// pages send is recorded and checked against what the walk clicked.
//
// The seed is evaluated from `apps/api` rather than run by path: bun's isolated linker (bun.lock
// `configVersion: 1`) links `@repo/core` and `@repo/storage-postgres` only into the workspaces that
// depend on them, and a file under `.pi/` resolves bare imports from its own directory upwards,
// where the root `node_modules` holds neither. The seed has no relative imports, so its text runs
// as-is. It writes to this process's `DATABASE_URL`, which must be the one the API was started
// with; a mismatch is caught below, because the API then does not hold the board.
const boardObserved = {};
let boardSeed = null;
const seed = spawnSync(
  "bun",
  [
    "-e",
    await readFile(path.join(ROOT, ".pi/skills/verify-board/seed.ts"), "utf8"),
  ],
  { cwd: path.join(ROOT, "apps/api"), encoding: "utf8", timeout: 60_000 },
);
boardObserved.seed = {
  status: seed.status,
  stdout: (seed.stdout ?? "").trim().slice(0, 300),
  stderr: (seed.stderr ?? "").trim().slice(0, 300),
};
try {
  boardSeed = JSON.parse(boardObserved.seed.stdout);
} catch (error) {
  boardObserved.seedError = String(error).slice(0, 200);
}
const boardId = typeof boardSeed?.boardId === "string" ? boardSeed.boardId : "";
const cardId = typeof boardSeed?.taskId === "string" ? boardSeed.taskId : "";
const truth = await rpcFromDrive("getBoard", { boardId });
assert(
  "a board and a card were seeded",
  seed.status === 0 &&
    boardId.startsWith("brd_") &&
    cardId.startsWith("tsk_") &&
    boardSeed?.revision === 1 &&
    truth.exit === "Success",
  seed.status !== 0 || boardSeed === null
    ? `seed exit ${String(seed.status)}: ${boardObserved.seed.stderr || boardObserved.seed.stdout || boardObserved.seedError}`
    : truth.exit === "Success"
      ? JSON.stringify(boardSeed)
      : `seeded ${boardId}, but the API's getBoard says ${String(truth.exit)} — is DATABASE_URL the one ./up.sh started the API with?`,
);

const definitionOrder = (truth.value?.definition?.columns ?? []).map(
  (column) => column.name,
);
boardObserved.definitionOrder = definitionOrder;

// Every RPC tag the board pages send, read off the requests themselves. These are the reads; the
// card pane's writes (LOB-76) are counted against what the walk clicks, at the end of the block.
// `listSessions` is the sidebar of the sessions page the walk starts from, and the session reads are
// the run pane the walk opens.
const BOARD_READS = new Set([
  "listBoards",
  "getBoard",
  "listTasks",
  "listSessions",
  "listTaskRuns",
  "getSession",
  "watchSession",
  "listApprovals",
]);
const boardRpcTags = [];
const recordRpcTags = (request) => {
  if (!/\/rpc\/?$/.test(request.url()) || request.method() !== "POST") return;
  for (const line of (request.postData() ?? "").split("\n")) {
    try {
      const message = JSON.parse(line);
      if (message?._tag === "Request") boardRpcTags.push(message.tag);
    } catch {
      // Not an envelope line.
    }
  }
};
page.on("request", recordRpcTags);

/** The lanes as the page renders them, left to right, and where the seeded card sits. */
const readLanes = (target) =>
  target.evaluate((id) => {
    const lanes = Array.from(document.querySelectorAll("section[data-lane]"));
    const cards = Array.from(
      document.querySelectorAll(`li[data-card='${id}']`),
    );
    return {
      lanes: lanes.map((lane) => lane.getAttribute("data-lane")),
      cardLanes: cards.map(
        (card) =>
          card.closest("section[data-lane]")?.getAttribute("data-lane") ?? null,
      ),
      cardText: cards.map((card) =>
        (card.textContent ?? "").replace(/\s+/g, " ").trim(),
      ),
      controls: document.querySelectorAll(
        "[aria-label='Lanes'] button, [aria-label='Lanes'] [role='button'], [aria-label='Lanes'] [draggable='true']",
      ).length,
    };
  }, cardId);

/** Every storage key the page holds; the theme toggle's own preference is the only one allowed. */
const readStorage = (target) =>
  target.evaluate(() => ({
    local: Object.keys(localStorage),
    session: Object.keys(sessionStorage),
  }));
const ALLOWED_STORAGE = new Set(["factory.theme"]);
const storageIsClean = (storage) =>
  storage.session.length === 0 &&
  storage.local.every((key) => ALLOWED_STORAGE.has(key));

const waitForLanes = (target) =>
  target
    .waitForFunction(
      (id) => document.querySelector(`li[data-card='${id}']`) !== null,
      cardId,
      { timeout: 20_000 },
    )
    .then(
      () => true,
      () => false,
    );

// The rail's Boards section, then the board's own link: the route a person takes.
await page.goto(`${WEB_URL}/sessions`, { waitUntil: "domcontentloaded" });
let boardLinkWorked = false;
try {
  await page.getByRole("link", { name: "Boards" }).first().click();
  await page.waitForFunction(
    () => window.location.pathname === "/boards",
    null,
    {
      timeout: 10_000,
    },
  );
  const boardLink = page.locator(`a[href='/boards/${boardId}']`);
  await boardLink.waitFor({ timeout: 15_000 });
  boardObserved.boardsList = (
    await page.locator("ul[aria-label='Boards']").innerText()
  ).slice(0, 300);
  await page.screenshot({ path: path.join(EVIDENCE_DIR, "boards.png") });
  await boardLink.click();
  await page.waitForFunction(
    (id) => window.location.pathname === `/boards/${id}`,
    boardId,
    { timeout: 10_000 },
  );
  boardLinkWorked = true;
} catch (error) {
  boardObserved.navigationError = String(error).slice(0, 300);
}
assert(
  "the rail reaches the board through the boards list",
  boardLinkWorked,
  boardLinkWorked
    ? `listed and opened /boards/${boardId}`
    : `${boardObserved.navigationError ?? ""} (at ${page.url()})`,
);

const cardShown = await waitForLanes(page);
const before = await readLanes(page);
boardObserved.before = before;
assert(
  "one lane per column, in definition order",
  truth.exit === "Success" &&
    definitionOrder.length > 0 &&
    JSON.stringify(before.lanes) === JSON.stringify(definitionOrder),
  `lanes ${JSON.stringify(before.lanes)} vs getBoard ${JSON.stringify(definitionOrder)} (${String(truth.exit)})`,
);
assert(
  "the seeded card is visible in intake",
  cardShown &&
    JSON.stringify(before.cardLanes) === JSON.stringify(["intake"]) &&
    (before.cardText[0] ?? "").includes(boardSeed?.title ?? "\u0000"),
  `card ${cardId} in ${JSON.stringify(before.cardLanes)}: ${JSON.stringify(before.cardText)}`,
);
await page.screenshot({
  path: path.join(EVIDENCE_DIR, "board.png"),
  fullPage: true,
});

const storageBefore = await readStorage(page);
boardObserved.storageBefore = storageBefore;
assert(
  "no client-side persistence key holds board or session state",
  storageIsClean(storageBefore),
  `localStorage ${JSON.stringify(storageBefore.local)}, sessionStorage ${JSON.stringify(storageBefore.session)}`,
);

// Feature: the card pane's write path (LOB-76). See features/card-pane.md.
//
// The card pane is where a person acts: it offers only the moves the card's column declares, marks
// the ones that cross a human gate, surfaces the service's own refusal for a stale move without
// moving the card, follows a move made in the CLI without a reload, and starts a run from the card.
// Every move the walk needs outside the browser is made the way a person makes it there —
// `factory board move` — and the oracle for each state is the API's `getTask`, asked from here.

/** `factory <args>` — the real CLI over the API, run from the drive process. */
const factory = (args) => {
  const run = spawnSync(
    "bun",
    [
      "run",
      path.join(ROOT, "apps/cli/src/index.ts"),
      ...args,
      "--api",
      API_URL,
    ],
    { cwd: ROOT, encoding: "utf8", timeout: 60_000 },
  );
  return {
    status: run.status,
    stdout: (run.stdout ?? "").trim().slice(0, 600),
    stderr: (run.stderr ?? "").trim().slice(0, 600),
  };
};

/**
 * The transitions the shared table declares out of `column` (`@repo/domain/Task`), which is what
 * `TaskService` refuses against. Read through bun because the table is TypeScript; the server half
 * of the claim — a move the table does not list is refused — is asserted against the API below.
 */
const declaredOutOf = (column) => {
  const run = spawnSync(
    "bun",
    [
      "-e",
      `import { declaredTransitions } from "@repo/domain/Task"; console.log(JSON.stringify(declaredTransitions(${JSON.stringify(column)})));`,
    ],
    { cwd: ROOT, encoding: "utf8", timeout: 60_000 },
  );
  try {
    return JSON.parse((run.stdout ?? "").trim());
  } catch {
    return null;
  }
};

/** The open card pane as the page renders it: which card, its column and revision, its moves. */
const readPane = (target) =>
  target.evaluate(() => {
    const pane = document.querySelector("aside[data-card-pane]");
    if (pane === null) return null;
    const start = pane.querySelector("[data-start-run]");
    return {
      card: pane.getAttribute("data-card-pane"),
      column: pane.getAttribute("data-card-pane-column"),
      revision: Number(pane.getAttribute("data-card-pane-revision")),
      moves: Array.from(pane.querySelectorAll("[data-move-to]")).map(
        (button) => ({
          to: button.getAttribute("data-move-to"),
          gate: button.getAttribute("data-human-gate"),
          label: button.getAttribute("aria-label"),
          text: (button.textContent ?? "").replace(/\s+/g, " ").trim(),
        }),
      ),
      refusal: (() => {
        const alert = pane.querySelector("[data-move-refusal]");
        return alert === null
          ? null
          : {
              tag: alert.getAttribute("data-move-refusal"),
              text: (alert.textContent ?? "").replace(/\s+/g, " ").trim(),
            };
      })(),
      startRun:
        start === null
          ? null
          : {
              disabled: start.hasAttribute("disabled"),
              title: start.getAttribute("title"),
            },
      runs: Array.from(pane.querySelectorAll("li[data-run]")).map((row) =>
        row.getAttribute("data-run"),
      ),
    };
  });

/** Wait until the seeded card sits in `lane`; `true` when it does within the timeout. */
const waitForCardIn = (target, lane, timeout = 15_000) =>
  target
    .waitForFunction(
      ({ id, lane }) =>
        document
          .querySelector(`li[data-card='${id}']`)
          ?.closest("section[data-lane]")
          ?.getAttribute("data-lane") === lane,
      { id: cardId, lane },
      { timeout },
    )
    .then(
      () => true,
      () => false,
    );

const paneObserved = {};

// Open the card: the card in its lane is a link, and the pane opens beside the lanes with the URL
// naming the card, so a link to it opens the same pane anywhere.
let paneOpened = false;
try {
  await page.locator(`li[data-card='${cardId}'] a`).click();
  await page.waitForSelector(`aside[data-card-pane='${cardId}']`, {
    timeout: 10_000,
  });
  paneOpened = new URL(page.url()).searchParams.get("card") === cardId;
} catch (error) {
  paneObserved.openError = String(error).slice(0, 300);
}
assert(
  "the card opens in the card pane, named in the URL",
  paneOpened,
  paneOpened
    ? `opened ${cardId} at ${new URL(page.url()).search}`
    : `${paneObserved.openError ?? ""} (at ${page.url()})`,
);

// Declared transitions only: the intake card is offered exactly what the column declares, and
// never `done`. The API is asked the same question from here — a direct move to `done` — and must
// refuse it as undeclared, without changing the card.
const declaredIntake = declaredOutOf("intake");
const inIntake = await readPane(page);
paneObserved.intake = inIntake;
paneObserved.declaredIntake = declaredIntake;
const offeredIntake = (inIntake?.moves ?? []).map((move) => move.to);
assert(
  "a card in intake is offered exactly its column's declared transitions",
  Array.isArray(declaredIntake) &&
    declaredIntake.length > 0 &&
    JSON.stringify(offeredIntake) === JSON.stringify(declaredIntake),
  `offered ${JSON.stringify(offeredIntake)} vs declared ${JSON.stringify(declaredIntake)}`,
);
const directToDone = await rpcFromDrive("moveTask", {
  taskId: cardId,
  expectedRevision: 1,
  to: "done",
  actor: "drive",
});
const afterDone = await rpcFromDrive("getTask", { taskId: cardId });
paneObserved.directToDone = { exit: directToDone, after: afterDone.value };
assert(
  "intake is not offered done, and the API refuses that move",
  !offeredIntake.includes("done") &&
    directToDone.exit === "Failure" &&
    JSON.stringify(directToDone.cause).includes("UndeclaredTransition") &&
    afterDone.value?.column === "intake" &&
    afterDone.value?.revision === 1,
  `offered done: ${offeredIntake.includes("done")}; API ${String(directToDone.exit)} ${JSON.stringify(directToDone.cause).slice(0, 160)}; card ${String(afterDone.value?.column)} r${String(afterDone.value?.revision)}`,
);
assert(
  "intake offers no gated move and no run start, and says why",
  (inIntake?.moves ?? []).every((move) => move.gate === null) &&
    inIntake?.startRun?.disabled === true &&
    (inIntake?.startRun?.title ?? "").includes("resting"),
  `gates ${JSON.stringify((inIntake?.moves ?? []).map((move) => move.gate))}; start ${JSON.stringify(inIntake?.startRun)}`,
);
await page.screenshot({
  path: path.join(EVIDENCE_DIR, "card-pane-intake.png"),
});

// A stale-revision move. The page's board reads are held at the network while the card changes
// underneath it — a block and an unblock through the API, which bump the revision without moving
// the card — so the pane still shows revision 1 when the person clicks. The move is sent at r1 and
// the service refuses it; the pane must print the service's own words and leave the card where it
// is, before and after the held reads are let through.
const held = [];
let freezeReads = true;
const holdBoardReads = async (route) => {
  const body = route.request().postData() ?? "";
  if (
    freezeReads &&
    (body.includes('"tag":"getBoard"') || body.includes('"tag":"listTasks"'))
  ) {
    held.push(route);
    return;
  }
  await route.continue().catch(() => undefined);
};
await page.route(/\/rpc\/?$/, holdBoardReads);
const blockedOut = await rpcFromDrive("blockTask", {
  taskId: cardId,
  expectedRevision: 1,
  reason: "transient",
  actor: "drive",
});
const unblockedOut = await rpcFromDrive("unblockTask", {
  taskId: cardId,
  expectedRevision: 2,
  actor: "drive",
});
const beforeClick = await readPane(page);
let refusalShown = false;
try {
  await page
    .locator("aside[data-card-pane] [data-move-to='specifying']")
    .click();
  await page.waitForSelector("aside[data-card-pane] [data-move-refusal]", {
    timeout: 10_000,
  });
  refusalShown = true;
} catch (error) {
  paneObserved.staleError = String(error).slice(0, 300);
}
const staleLanes = await readLanes(page);
const stalePane = await readPane(page);
const staleTruth = await rpcFromDrive("getTask", { taskId: cardId });
paneObserved.stale = {
  block: blockedOut.exit,
  unblock: unblockedOut.exit,
  beforeClick: beforeClick?.revision,
  pane: stalePane,
  lanes: staleLanes.cardLanes,
  truth: staleTruth.value,
};
assert(
  "a stale-revision move surfaces the service's refusal in the pane",
  blockedOut.exit === "Success" &&
    unblockedOut.exit === "Success" &&
    beforeClick?.revision === 1 &&
    refusalShown &&
    stalePane?.refusal?.tag === "StaleRevision" &&
    (stalePane?.refusal?.text ?? "").includes("is at revision 3, not 1"),
  `block ${String(blockedOut.exit)}, unblock ${String(unblockedOut.exit)}, clicked at r${String(beforeClick?.revision)}; refusal ${JSON.stringify(stalePane?.refusal ?? paneObserved.staleError ?? null)}`,
);
assert(
  "and the refused card does not visually move",
  JSON.stringify(staleLanes.cardLanes) === JSON.stringify(["intake"]) &&
    stalePane?.column === "intake" &&
    staleTruth.value?.column === "intake" &&
    staleTruth.value?.revision === 3,
  `lane ${JSON.stringify(staleLanes.cardLanes)}, pane ${String(stalePane?.column)}, server ${String(staleTruth.value?.column)} r${String(staleTruth.value?.revision)}`,
);
await page.screenshot({ path: path.join(EVIDENCE_DIR, "card-pane-stale.png") });
freezeReads = false;
for (const route of held.splice(0))
  await route.continue().catch(() => undefined);
await page.unroute(/\/rpc\/?$/, holdBoardReads);
const caughtUp = await page
  .waitForSelector(
    `aside[data-card-pane='${cardId}'][data-card-pane-revision='3']`,
    { timeout: 10_000 },
  )
  .then(
    () => true,
    () => false,
  );
const afterRelease = await readLanes(page);
paneObserved.afterRelease = { caughtUp, lanes: afterRelease.cardLanes };
assert(
  "once the reads land the pane holds the server's revision, and the card is still in intake",
  caughtUp &&
    JSON.stringify(afterRelease.cardLanes) === JSON.stringify(["intake"]),
  `pane at r3: ${caughtUp}; lane ${JSON.stringify(afterRelease.cardLanes)}`,
);

// A move made in `factory board move` appears in the browser without a reload. The marker on
// `window` is lost on any navigation or reload, so its survival is the proof that none happened.
await page.evaluate(() => {
  window.__driveNoReload = "kept";
});
const cliMove = factory([
  "board",
  "move",
  "--task",
  cardId,
  "--to",
  "specifying",
  "--expect-revision",
  "3",
]);
const cliMoved = await rpcFromDrive("getTask", { taskId: cardId });
const followed = await waitForCardIn(page, "specifying");
const stayedPut = await page.evaluate(() => window.__driveNoReload === "kept");
const followedPane = await readPane(page);
paneObserved.cliToBrowser = {
  cli: cliMove,
  truth: cliMoved.value,
  followed,
  noReload: stayedPut,
  pane: followedPane,
};
assert(
  "factory board move moved the card on the server",
  cliMove.status === 0 &&
    cliMoved.value?.column === "specifying" &&
    cliMoved.value?.revision === 4,
  `exit ${String(cliMove.status)}, server says ${JSON.stringify(cliMoved.value?.column ?? null)} r${String(cliMoved.value?.revision ?? null)}; ${cliMove.stderr || cliMove.stdout}`,
);
assert(
  "the CLI's move appears in the browser without a reload",
  followed &&
    stayedPut &&
    followedPane?.column === "specifying" &&
    followedPane?.revision === 4,
  `card in specifying: ${followed}, no reload: ${stayedPut}, pane ${String(followedPane?.column)} r${String(followedPane?.revision)}`,
);
// The pane re-offers from the new column, still exactly what that column declares.
const declaredSpecifying = declaredOutOf("specifying");
assert(
  "the pane re-offers the new column's declared transitions",
  Array.isArray(declaredSpecifying) &&
    JSON.stringify((followedPane?.moves ?? []).map((move) => move.to)) ===
      JSON.stringify(declaredSpecifying),
  `offered ${JSON.stringify((followedPane?.moves ?? []).map((move) => move.to))} vs declared ${JSON.stringify(declaredSpecifying)}`,
);

// A reload is a fresh read of both halves: the card is in `specifying` and nowhere else.
await page.reload({ waitUntil: "domcontentloaded" });
await waitForLanes(page);
const afterReload = await readLanes(page);
boardObserved.afterReload = afterReload;
assert(
  "the server-side move is visible on reload",
  JSON.stringify(afterReload.cardLanes) === JSON.stringify(["specifying"]) &&
    JSON.stringify(afterReload.lanes) === JSON.stringify(definitionOrder),
  `after reload the card is in ${JSON.stringify(afterReload.cardLanes)}`,
);

// And no client state is involved: a second browser context starts with no storage and no cache,
// so what it shows can only be the server's answer — the same lane the reload showed.
const freshContext = await browser.newContext({
  viewport: { width: 1440, height: 900 },
});
const freshPage = await freshContext.newPage();
freshPage.on("request", recordRpcTags);
await freshPage.goto(`${WEB_URL}/boards/${boardId}`, {
  waitUntil: "domcontentloaded",
});
await waitForLanes(freshPage);
const fresh = await readLanes(freshPage);
const freshStorage = await readStorage(freshPage);
boardObserved.freshContext = { ...fresh, storage: freshStorage };
assert(
  "a browser with no client state shows the same board",
  JSON.stringify(fresh.cardLanes) === JSON.stringify(["specifying"]) &&
    JSON.stringify(fresh.lanes) === JSON.stringify(definitionOrder) &&
    storageIsClean(freshStorage),
  `fresh context: card in ${JSON.stringify(fresh.cardLanes)}, storage ${JSON.stringify(freshStorage)}`,
);
await freshPage.screenshot({
  path: path.join(EVIDENCE_DIR, "board-after-move.png"),
  fullPage: true,
});
await freshContext.close();

// And the reverse: a move made in the browser is what `factory board show` prints.
await page.waitForSelector(`aside[data-card-pane='${cardId}']`, {
  timeout: 10_000,
});
let browserMoved = false;
try {
  await page.locator("aside[data-card-pane] [data-move-to='planning']").click();
  browserMoved = await waitForCardIn(page, "planning");
} catch (error) {
  paneObserved.browserMoveError = String(error).slice(0, 300);
}
const cliShow = factory(["board", "show", "--task", cardId]);
paneObserved.browserToCli = { browserMoved, show: cliShow };
assert(
  "a move made in the browser is what factory board show prints",
  browserMoved &&
    cliShow.status === 0 &&
    /^column\s+planning$/m.test(cliShow.stdout) &&
    /^revision\s+5$/m.test(cliShow.stdout),
  `browser moved: ${browserMoved}; show exit ${String(cliShow.status)}: ${JSON.stringify(cliShow.stdout.split("\n").slice(0, 4))}`,
);

// Human gates are marked. Out of `planning` the move to `building` is the plan approval (B5): it is
// offered to a person, and marked as a person's move; `canceled` beside it is not marked.
const inPlanning = await readPane(page);
paneObserved.planning = inPlanning;
const toBuilding = (inPlanning?.moves ?? []).find(
  (move) => move.to === "building",
);
const toCanceled = (inPlanning?.moves ?? []).find(
  (move) => move.to === "canceled",
);
assert(
  "the human-required move is visibly marked, and only it",
  toBuilding?.gate === "plan approval" &&
    (toBuilding?.text ?? "").includes("person · plan approval") &&
    (toBuilding?.label ?? "").includes("a person's move") &&
    toCanceled !== undefined &&
    toCanceled.gate === null,
  `building ${JSON.stringify(toBuilding ?? null)}; canceled ${JSON.stringify(toCanceled ?? null)}`,
);

// Run start: `planning` is a working column, so the pane offers a run; the click is
// `createSession` with the card named, and the run is listed on the card and opened beside it.
let runId = null;
try {
  await page.locator("aside[data-card-pane] [data-start-run]").click();
  await page.waitForFunction(
    () => new URL(window.location.href).searchParams.get("run") !== null,
    null,
    { timeout: 20_000 },
  );
  runId = new URL(page.url()).searchParams.get("run");
  await page.waitForSelector(`aside[data-card-pane] li[data-run='${runId}']`, {
    timeout: 15_000,
  });
  await page.waitForSelector(`[data-run-pane='${runId}']`, { timeout: 15_000 });
} catch (error) {
  paneObserved.runError = String(error).slice(0, 300);
}
const runs = await rpcFromDrive("listTaskRuns", { taskId: cardId });
const runPaneText =
  runId === null
    ? ""
    : (
        (await page
          .locator(`[data-run-pane='${runId}']`)
          .innerText()
          .catch(() => "")) ?? ""
      ).slice(0, 300);
paneObserved.run = { runId, runs: runs.value, runPaneText };
assert(
  "a run is started from the card, listed on it, and opened beside it",
  typeof runId === "string" &&
    runId.startsWith("ses_") &&
    runs.exit === "Success" &&
    (runs.value ?? []).some(
      (run) => run.sessionId === runId && run.column === "planning",
    ) &&
    runPaneText.includes(runId),
  `run ${String(runId)}; listTaskRuns ${JSON.stringify((runs.value ?? []).map((run) => [run.sessionId, run.column]))}; pane ${JSON.stringify(runPaneText.slice(0, 80))}`,
);
await page.screenshot({ path: path.join(EVIDENCE_DIR, "card-pane-run.png") });

// `/sandboxes` and `/approvals` left the rail: they are panes of a card's run now.
const rail = await page.evaluate(() =>
  Array.from(document.querySelectorAll("nav[aria-label='Sections'] a")).map(
    (anchor) => anchor.getAttribute("href"),
  ),
);
const runTabs = await page.evaluate(() =>
  Array.from(
    document.querySelectorAll("aside[data-card-pane] [role='tab']"),
  ).map((tab) => (tab.textContent ?? "").trim()),
);
paneObserved.rail = rail;
paneObserved.runTabs = runTabs;
assert(
  "sandboxes and approvals left the rail for panes inside the card",
  !rail.includes("/sandboxes") &&
    !rail.includes("/approvals") &&
    rail.includes("/boards") &&
    JSON.stringify(runTabs) ===
      JSON.stringify(["Transcript", "Approvals", "Sandbox"]),
  `rail ${JSON.stringify(rail)}; run tabs ${JSON.stringify(runTabs)}`,
);

// The lanes still hold no control that can change a card, and the only writes the board pages sent
// are the two moves the walk clicked (the refused one and the accepted one) and the run start. The
// tags are the requests' own, so a write wired to any other element would be caught here.
page.off("request", recordRpcTags);
const BOARD_WRITES = new Set(["moveTask", "createSession"]);
const boardWrites = boardRpcTags.filter((tag) => !BOARD_READS.has(tag));
boardObserved.rpcTags = boardRpcTags;
assert(
  "the lanes hold no move control, and the pages wrote only what was clicked",
  before.controls === 0 &&
    afterReload.controls === 0 &&
    boardWrites.every((tag) => BOARD_WRITES.has(tag)) &&
    boardWrites.filter((tag) => tag === "moveTask").length === 2 &&
    boardWrites.filter((tag) => tag === "createSession").length === 1,
  `controls ${before.controls}/${afterReload.controls}; writes ${JSON.stringify(boardWrites)}`,
);
observed.cardPane = paneObserved;

// A bad board id is refused by the route's decode, as a bad session id is.
await page.goto(`${WEB_URL}/boards/not-a-board`, {
  waitUntil: "domcontentloaded",
});
const badBoardCopy = (await page.locator("body").innerText()).trim();
boardObserved.badId = badBoardCopy.slice(0, 200);
assert(
  "a bad board id is refused locally",
  badBoardCopy.includes("Not a board id this control plane mints"),
  `body: ${JSON.stringify(badBoardCopy.slice(0, 200))}`,
);
observed.board = boardObserved;

// Feature: the session's PR link (LOB-65). No RPC opens a PR, so `seed-pr.ts` is the in-process
// caller of the real PR step — against a loopback GitHub fake, on this API's database and session
// root — and it exits before the page attaches, so the anchor below is the API's read of the session.
// The href is compared with the link the session *recorded*, read back through the API from the page.
// See features/pr-link.md.
// This runs after the transcript screenshot on purpose: opening the seeded session records it at
// the top of the newest-first sidebar, and the transcript step above clicks the first sidebar link.
const seedOut = path.join(ROOT, ".verify/run/web-pr-seed.json");
const seedRun = spawnSync(
  "bun",
  [path.join(ROOT, ".pi/skills/lib/seed-pr.ts")],
  {
    env: {
      ...process.env,
      PR_SEED_OUT: seedOut,
      SESSION_ROOT: path.join(ROOT, ".verify/run/sessions"),
      PR_SEED_TITLE: "verify-web pr probe",
    },
    encoding: "utf8",
    timeout: 120_000,
  },
);
await writeFile(
  path.join(EVIDENCE_DIR, "pr-seed.txt"),
  `${seedRun.stdout ?? ""}${seedRun.stderr ?? ""}`,
);
const seeded = await readFile(seedOut, "utf8")
  .then((text) => JSON.parse(text))
  .catch(() => ({ sessionId: "", prUrl: null }));
assert(
  "a session with a recorded PR was seeded",
  seedRun.status === 0 && seeded.sessionId !== "" && seeded.prUrl !== null,
  `exit=${seedRun.status} id=${seeded.sessionId} prUrl=${seeded.prUrl}`,
);
const prRead =
  seeded.sessionId === ""
    ? { value: null }
    : await callRpcOnce("getSession", { sessionId: seeded.sessionId });
const recordedPrUrl = prRead.value?.session?.prUrl ?? null;
assert(
  "the API reads the PR link the session recorded",
  recordedPrUrl !== null && recordedPrUrl === seeded.prUrl,
  `getSession prUrl=${recordedPrUrl} seeded=${seeded.prUrl}`,
);
const prAnchor = page.locator("header [data-pr-link]");
let prHref = null;
let prAnchorText = "";
let prTarget = null;
if (seeded.sessionId !== "") {
  await page.goto(`${WEB_URL}/sessions/${seeded.sessionId}`, {
    waitUntil: "domcontentloaded",
  });
  await prAnchor
    .first()
    .waitFor({ timeout: 20_000 })
    .catch(() => undefined);
  if ((await prAnchor.count()) > 0) {
    prHref = await prAnchor.first().getAttribute("href");
    prTarget = await prAnchor.first().getAttribute("target");
    prAnchorText = (await prAnchor.first().innerText()).trim();
  }
  await page.screenshot({ path: path.join(EVIDENCE_DIR, "pr-link.png") });
}
observed.prLink = {
  sessionId: seeded.sessionId,
  seededPrUrl: seeded.prUrl,
  recordedPrUrl,
  href: prHref,
  target: prTarget,
  text: prAnchorText,
};
assert(
  "the pane header links the recorded PR",
  recordedPrUrl !== null && prHref === recordedPrUrl,
  `href=${prHref} recorded=${recordedPrUrl} text=${JSON.stringify(prAnchorText)}`,
);
assert(
  "and the link opens beside the live pane, not over it",
  prTarget === "_blank",
  `target=${prTarget}`,
);

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
