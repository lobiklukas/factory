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
import { randomBytes } from "node:crypto";
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

// Feature: the root opens on boards (C9): the only board's lanes, or the list with none or several.
// See features/routing.md and features/first-run.md. The checks here do not assume how many boards
// the instance's database holds; `first-run.sh` proves the 0, 1 and several cases on its own database.
await page.goto(WEB_URL, { waitUntil: "domcontentloaded" });
await page.waitForSelector("nav[aria-label='Sections']", { timeout: 15_000 });
await page.waitForFunction(() => window.location.pathname !== "/", null, {
  timeout: 15_000,
});
const redirected = new URL(page.url()).pathname;
observed.redirected = redirected;
const boardsAtRoot = await rpcFromDrive("listBoards", {});
const expectedRoot =
  boardsAtRoot.value?.length === 1
    ? `/boards/${boardsAtRoot.value[0].id}`
    : "/boards";
assert(
  "root opens the only board, or the boards list",
  boardsAtRoot.exit === "Success" && redirected === expectedRoot,
  `after goto ${WEB_URL} the path is ${JSON.stringify(redirected)}; ${boardsAtRoot.value?.length ?? "?"} board(s) so ${JSON.stringify(expectedRoot)}`,
);
await page.goto(`${WEB_URL}/sessions`, { waitUntil: "domcontentloaded" });
await page.waitForSelector("nav[aria-label='Sections']", { timeout: 15_000 });

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
// features/session-stream.md. New session opens a form (E6, features/session-new.md): the drive
// types its own prompt, which is the transcript's first user entry below. The faux model runs
// `FAUX_COMMAND` whatever the prompt says, so the answer is still `faux-ok (re: ...)`.
const promptText = `Run the repository's check and tell me what it printed (drive ${Date.now()}).`;
await page.getByRole("button", { name: /new session/i }).click();
await page.locator("#new-session-prompt").fill(promptText);
await page.locator("[data-session-submit]").click();

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

// Feature: a transcript shows each message once, under its real author (LOB-273). The session's
// title entry carries the first prompt, and with no branch for it the row used to fall through to
// assistant prose: the prompt appeared as a plain paragraph, then again as the user's bubble, then
// an empty SYSTEM divider. The scroller's items are the transcript alone (the header also names the
// session by that prompt, which is why this reads the scroller and not the page).
const transcriptItems = await page
  .locator("[data-slot='message-scroller-item']")
  .evaluateAll((items) =>
    items.map((item) => ({
      text: item.innerText.trim(),
      bubble: item.querySelector("[data-slot='bubble']") !== null,
    })),
  );
// Equal to, not containing: the agent's answer quotes the prompt ("faux-ok (re: ...)").
const promptRows = transcriptItems.filter((item) => item.text === promptText);
const bareMarkers = transcriptItems.filter((item) =>
  /^system$/i.test(item.text),
);
observed.transcriptAttribution = { transcriptItems, promptRows, bareMarkers };
assert(
  "the first prompt appears once in the transcript, as the user's bubble",
  sessionWorked && promptRows.length === 1 && promptRows[0].bubble,
  `${promptRows.length} transcript row(s) hold the prompt; rows: ${JSON.stringify(transcriptItems.map((item) => item.text.slice(0, 40)))}`,
);
assert(
  "the transcript shows no bare SYSTEM divider",
  sessionWorked && bareMarkers.length === 0,
  `${bareMarkers.length} bare system marker(s)`,
);
await page.screenshot({
  path: path.join(EVIDENCE_DIR, "transcript-attribution.png"),
});

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

  // Narrow width (LOB-210). At 390 px the session list and the pane take turns instead of sharing
  // the width: a fixed 16rem list beside the rail once left the pane 86 px, so the header's actions
  // were cut off past the viewport and the composer's placeholder wrapped one character per line.
  // These checks are the shell's, measured on the fork's own route: the pane spans everything right
  // of the rail, every header action's box ends inside the viewport, and the composer is a line
  // wide enough to type in. Each of them failed on the build before LOB-210 (fork right edge 657 px,
  // composer 22 px wide), which is what makes them a regression test rather than a description.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  const narrowBoxes = () =>
    page.evaluate(() => {
      const rect = (element) => {
        if (!(element instanceof Element)) return null;
        const box = element.getBoundingClientRect();
        return {
          left: Math.round(box.left),
          right: Math.round(box.right),
          width: Math.round(box.width),
          height: Math.round(box.height),
        };
      };
      const action = (label) =>
        Array.from(document.querySelectorAll("header button")).find(
          (button) => button.getAttribute("aria-label") === label,
        );
      // The pane's own overflow, not the document's: the root frame is `h-dvh overflow-hidden`,
      // so a pane whose content runs past its box is clipped there and never widens the document.
      // The pane is the header's parent (SessionPane's root column).
      const pane = document.querySelector("header")?.parentElement ?? null;
      return {
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        paneScrollWidth: pane === null ? null : pane.scrollWidth,
        paneClientWidth: pane === null ? null : pane.clientWidth,
        headerScrollWidth:
          document.querySelector("header")?.scrollWidth ?? null,
        headerClientWidth:
          document.querySelector("header")?.clientWidth ?? null,
        rail: rect(document.querySelector("nav[aria-label='Sections']")),
        header: rect(document.querySelector("header")),
        aside: rect(document.querySelector("aside")),
        forkBox: rect(action("Fork from here")),
        compactBox: rect(
          action("Compact session") ?? action("Compacting session"),
        ),
        composer: rect(document.querySelector("textarea")),
      };
    });
  observed.narrowWidth = await narrowBoxes();
  const narrowBox = observed.narrowWidth;
  assert(
    "the session pane spans the width beside the rail at 390px",
    narrowBox.rail !== null &&
      narrowBox.header !== null &&
      narrowBox.header.left <= narrowBox.rail.right + 1 &&
      narrowBox.header.right >= narrowBox.clientWidth - 1 &&
      (narrowBox.aside === null || narrowBox.aside.width === 0),
    `rail ${JSON.stringify(narrowBox.rail)}, header ${JSON.stringify(narrowBox.header)}, ` +
      `list ${JSON.stringify(narrowBox.aside)}, viewport ${narrowBox.clientWidth}`,
  );
  const insideViewport = (box) =>
    box !== null &&
    box.width > 0 &&
    box.left >= 0 &&
    box.right <= narrowBox.clientWidth;
  assert(
    "the header's actions stay inside the viewport at 390px",
    insideViewport(narrowBox.forkBox) && insideViewport(narrowBox.compactBox),
    `Fork ${JSON.stringify(narrowBox.forkBox)}, Compact ${JSON.stringify(narrowBox.compactBox)}, ` +
      `viewport ${narrowBox.clientWidth}`,
  );
  // "Not one character per line", measured: half the viewport is a placeholder's line, and a
  // composer that grew past two lines of its own height is one that is wrapping its placeholder.
  assert(
    "the composer is a line wide enough to type in at 390px",
    narrowBox.composer !== null &&
      narrowBox.composer.width >= narrowBox.clientWidth / 2 &&
      narrowBox.composer.height <= 64,
    `composer ${JSON.stringify(narrowBox.composer)}, viewport ${narrowBox.clientWidth}`,
  );
  // Measured on the pane and its header rather than the document (review of LOB-210): the frame
  // clips, so the document's scrollWidth stayed 390 on the build before LOB-210 while the header's
  // actions ran ~570 px past its 86 px box. A box with `overflow: visible` still reports the width
  // its content needs as scrollWidth, which is what this compares.
  assert(
    "the pane's content fits its own width at 390px",
    narrowBox.paneScrollWidth !== null &&
      narrowBox.paneScrollWidth <= narrowBox.paneClientWidth + 1 &&
      narrowBox.headerScrollWidth !== null &&
      narrowBox.headerScrollWidth <= narrowBox.headerClientWidth + 1,
    `pane scrollWidth ${narrowBox.paneScrollWidth} vs clientWidth ${narrowBox.paneClientWidth}, ` +
      `header scrollWidth ${narrowBox.headerScrollWidth} vs clientWidth ${narrowBox.headerClientWidth}`,
  );
  await page.screenshot({
    path: path.join(EVIDENCE_DIR, "session-pane-narrow.png"),
    fullPage: true,
  });

  // The list is one link away: the header's back link opens `/sessions`, where the list is the
  // whole width. The lineage line is read there, so the fork's third line is proven to truncate
  // inside its row (a `truncate`d span that broke out of the row would be the same defect as
  // widening the page, one level down) and still have a box tall enough to be read.
  let listOpened = false;
  try {
    await page
      .locator("header a[aria-label='Show sessions']")
      .click({ timeout: 10_000 });
    await page.waitForFunction(
      (child) =>
        window.location.pathname === "/sessions" &&
        document.querySelector(`aside a[href='/sessions/${child}']`) !== null,
      childId,
      { timeout: 10_000 },
    );
    listOpened = true;
  } catch {
    listOpened = false;
  }
  const listNarrow = await page.evaluate((child) => {
    const aside = document.querySelector("aside")?.getBoundingClientRect();
    const rail = document
      .querySelector("nav[aria-label='Sections']")
      ?.getBoundingClientRect();
    const row = document.querySelector(`aside a[href='/sessions/${child}']`);
    const lineage = Array.from(row?.querySelectorAll("span") ?? []).find(
      (span) => (span.textContent ?? "").startsWith("forked from "),
    );
    const rowBox = row?.getBoundingClientRect();
    const lineageBox = lineage?.getBoundingClientRect();
    return {
      path: window.location.pathname,
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      list:
        aside === undefined || rail === undefined
          ? null
          : { left: aside.left, right: aside.right, railRight: rail.right },
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
  observed.narrowWidth.list = listNarrow;
  assert(
    "the header's back link opens the full-width session list at 390px",
    listOpened &&
      listNarrow.list !== null &&
      listNarrow.list.left <= listNarrow.list.railRight + 1 &&
      listNarrow.list.right >= listNarrow.clientWidth - 1,
    `opened ${listOpened} at ${JSON.stringify(listNarrow.path)}, list ${JSON.stringify(listNarrow.list)}`,
  );
  assert(
    "the lineage line does not widen the page at 390px",
    listNarrow.scrollWidth <= listNarrow.clientWidth,
    `scrollWidth ${listNarrow.scrollWidth} vs clientWidth ${listNarrow.clientWidth}`,
  );
  const lineageBox = listNarrow.lineageBox;
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
 * What a screen reader is handed for an element, from Chrome's own accessibility tree (LOB-232):
 * its computed name, description, and whether it is disabled and focusable. The DOM says which
 * attributes are set; this says what they add up to, which is what "announced" means.
 */
const announcedAt = async (locator) => {
  // CDP finds nodes by selector, not by Playwright handle, so the element is marked for the lookup.
  await locator.evaluate((element) =>
    element.setAttribute("data-announced-probe", ""),
  );
  const cdp = await page.context().newCDPSession(page);
  try {
    const { root } = await cdp.send("DOM.getDocument", { depth: 0 });
    const { nodeId } = await cdp.send("DOM.querySelector", {
      nodeId: root.nodeId,
      selector: "[data-announced-probe]",
    });
    const { nodes } = await cdp.send("Accessibility.getPartialAXTree", {
      nodeId,
      fetchRelatives: false,
    });
    const node = nodes[0];
    const property = (name) =>
      node?.properties?.find((candidate) => candidate.name === name)?.value
        ?.value ?? null;
    return {
      role: node?.role?.value ?? null,
      name: node?.name?.value ?? null,
      description: node?.description?.value ?? null,
      disabled: property("disabled") === true,
      focusable: property("focusable") === true,
    };
  } catch (error) {
    return { error: String(error).slice(0, 300) };
  } finally {
    await cdp.detach();
    await locator
      .evaluate((element) => element.removeAttribute("data-announced-probe"))
      .catch(() => {});
  }
};

/**
 * Record every render of the pane's compaction status until asked to stop (LOB-224).
 *
 * A compaction task can settle in a few hundred milliseconds, and a poll would miss the pending
 * state it is there to prove. The observer sees each mount, so the sequence it records is evidence
 * that the pending state really replaced, and was replaced by, the verdict — and each sample keeps
 * whether the "Nothing to compact" text was on screen at that moment and how tall the status box
 * was, which is what the premature-verdict and layout checks need.
 *
 * Each sample also keeps where keyboard focus was (LOB-232) and whether the button said it was busy.
 * A focus move is not a DOM mutation, so the observer alone would never see focus fall to `body`;
 * a per-frame sample beside it does.
 */
const watchCompactionStatus = () =>
  page.evaluate(() => {
    window.__compactionSamples = [];
    const snap = () => {
      const element = document.querySelector("[data-compaction-status]");
      const button = document.querySelector("button[data-compaction-state]");
      const active = document.activeElement;
      const sample = {
        state: element?.getAttribute("data-compaction-status") ?? null,
        // `compact`, `status`, or the tag focus fell to (`BODY` is the defect).
        focus:
          active !== null && active === button
            ? "compact"
            : active !== null && active === element
              ? "status"
              : (active?.tagName ?? null),
        pending: button?.getAttribute("aria-busy") === "true",
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
        last.height !== sample.height ||
        last.focus !== sample.focus ||
        last.pending !== sample.pending
      )
        window.__compactionSamples.push(sample);
    };
    const everyFrame = () => {
      snap();
      window.__compactionFrame = requestAnimationFrame(everyFrame);
    };
    window.__compactionFrame = requestAnimationFrame(everyFrame);
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
    if (window.__compactionFrame !== undefined)
      cancelAnimationFrame(window.__compactionFrame);
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
//
// Unavailable is `aria-disabled`, never the native `disabled` (LOB-232): a focused button that turns
// `disabled` drops focus to `body`, and a natively disabled one is skipped by Tab, so its reason was
// never heard. So the check also takes focus to the button and asks Chrome's accessibility tree
// what it would announce there: the name, that it is disabled, and the reason as its description.
const busyCompact = {};
try {
  // Wait for the *busy* reason rather than for "unavailable": the pane is unavailable while it
  // attaches too, and attaching is not the state this check is about.
  await page.waitForFunction(
    () => {
      const button = document.querySelector("button[data-compaction-state]");
      return (
        button !== null &&
        button.getAttribute("aria-disabled") === "true" &&
        (button.getAttribute("title") ?? "").includes(
          "Wait for this run to finish",
        )
      );
    },
    null,
    { timeout: 20_000 },
  );
  busyCompact.disabled = await compactButton.isDisabled();
  busyCompact.nativeDisabled = await compactButton.evaluate(
    (button) => button.disabled,
  );
  await compactButton.focus();
  busyCompact.focused = await compactButton.evaluate(
    (button) => document.activeElement === button,
  );
  busyCompact.announced = await announcedAt(compactButton);
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
assert(
  "the busy Compact stays focusable and announces its reason (LOB-232)",
  busyCompact.nativeDisabled === false &&
    busyCompact.focused === true &&
    busyCompact.announced?.focusable === true &&
    busyCompact.announced?.disabled === true &&
    (busyCompact.announced?.description ?? "").includes(
      "Wait for this run to finish before compacting",
    ),
  `nativeDisabled=${String(busyCompact.nativeDisabled)} focused=${String(busyCompact.focused)} announced=${JSON.stringify(busyCompact.announced ?? null)}`,
);

// The run has to settle before the compaction: a summary admitted while the turn was still writing
// its entries would have nothing to cut.
let longSessionIdle = false;
try {
  await page.waitForFunction(
    () => {
      const button = document.querySelector("button[data-compaction-state]");
      return (
        button !== null &&
        !button.disabled &&
        button.getAttribute("aria-disabled") !== "true"
      );
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

// Pressed from the keyboard (LOB-232): focus is taken to the button and Enter admits the press, so
// the samples below can say where focus was for as long as the press was pending.
let compacted = false;
await compactButton.focus();
await watchCompactionStatus();
try {
  await page.keyboard.press("Enter");
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

// Where the keyboard press left focus (LOB-232). The press makes the button unavailable in the same
// tick, and a focused `<button>` that turns `disabled` drops focus to `body` — measured on the
// old pane: `BODY` for every frame of a `requested` state. Every sample taken while the press was
// pending must have focus on the button or the status region, and once it settles the button —
// available again — must still hold it, so the operator can press again without hunting for it.
const pendingFocus = longStates.filter(
  (sample) => sample.pending || sample.state === "requested",
);
const focusAfter = await compactButton.evaluate(
  (button) => document.activeElement === button,
);
observed.compactFocus = { pending: pendingFocus, after: focusAfter };
assert(
  "a keyboard press of Compact keeps focus on the button while it is pending (LOB-232)",
  compacted &&
    pendingFocus.length > 0 &&
    pendingFocus.every(
      (sample) => sample.focus === "compact" || sample.focus === "status",
    ) &&
    focusAfter,
  `pending samples ${JSON.stringify(pendingFocus)}, focused after settle=${String(focusAfter)}`,
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
        button.getAttribute("aria-disabled") !== "true" &&
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
        button.getAttribute("aria-disabled") !== "true" &&
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
// not asserted here: the verdict's copy reflows at 390px (the pane is the width beside the rail
// since LOB-210, ~340px, where it was a ~60px column before), and the reservation is a claim about
// two states sharing one box, which is proven above, at the drive's own widths, where both are
// sampled. The narrow height is recorded in `observed.shortNarrow`.
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
        button.getAttribute("aria-disabled") !== "true" &&
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
// event's state before the next dispatch, and the button is unavailable by then (`aria-disabled`
// since LOB-232), so a click after the send is swallowed and the drive records no press at all.
// Measured, not assumed.
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

// Feature: the approvals inbox (LOB-53). See features/routing.md.
//
// `/approvals` used to say what was missing ("No approvals pending" + M3); that assertion is flipped,
// not deleted: the route now lists every run's pending approvals from `listPendingApprovals` and
// decides them. The request is made from the drive through the API's own `requestApproval` — what a
// gated call does — on a fresh session, so the oracle is this run's request and not whatever an
// earlier run left pending. The session pane shows it first, `/approvals` decides it, and the
// oracle for "decided, gone, and the session resumed" is the API asked from here, not the page.
const inbox = {};
const inboxSession = await rpcFromDrive("createSession", {
  title: "verify-web approvals inbox",
});
const inboxSessionId = inboxSession.value?.id ?? "";
const inboxRequestId = `verify-web-inbox-${Date.now()}`;
const INBOX_ACTION = "verify-web: publish the package";
const inboxAsked =
  inboxSessionId === ""
    ? { exit: null }
    : await rpcFromDrive("requestApproval", {
        sessionId: inboxSessionId,
        requestId: inboxRequestId,
        action: INBOX_ACTION,
        detail: "npm publish --tag next",
      });
const inboxDecides = [];
const recordInboxDecide = (request) => {
  if (!/\/rpc\/?$/.test(request.url()) || request.method() !== "POST") return;
  for (const line of (request.postData() ?? "").split("\n")) {
    try {
      const message = JSON.parse(line);
      if (message?._tag === "Request" && message.tag === "decideApproval")
        inboxDecides.push(message.payload);
    } catch {
      // Not an envelope line.
    }
  }
};
const inboxRow = `[data-approvals-inbox] [data-approval='${inboxRequestId}'][data-approval-session='${inboxSessionId}']`;
const sessionStrip = `[data-session-approvals='${inboxSessionId}'] [data-approval='${inboxRequestId}']`;

// The session pane says its run is waiting, with the decision in reach.
await page.goto(`${WEB_URL}/sessions/${inboxSessionId}`, {
  waitUntil: "domcontentloaded",
});
inbox.sessionShown = await page
  .waitForSelector(sessionStrip, { timeout: 15_000 })
  .then(
    () => true,
    () => false,
  );
await page.screenshot({
  path: path.join(EVIDENCE_DIR, "session-approval.png"),
});
assert(
  "the session pane shows its pending approval",
  inboxAsked.exit === "Success" && inbox.sessionShown,
  `session ${inboxSessionId || "none"}; requested ${String(inboxAsked.exit)}; strip shown ${inbox.sessionShown}`,
);

// `/approvals` lists it beside every other run's, and Approve decides it in place.
await page.goto(`${WEB_URL}/approvals`, { waitUntil: "domcontentloaded" });
inbox.listed = await page.waitForSelector(inboxRow, { timeout: 15_000 }).then(
  () => true,
  () => false,
);
const approvalsCopy = (await page.locator("body").innerText()).trim();
observed.approvals = approvalsCopy.slice(0, 400);
await page.screenshot({ path: path.join(EVIDENCE_DIR, "approvals.png") });
const pendingBeforeInbox = await rpcFromDrive("listPendingApprovals", {});
page.on("request", recordInboxDecide);
inbox.cleared = false;
if (inbox.listed) {
  try {
    await page.locator(`${inboxRow} [data-decide='approved']`).click();
    await page.waitForSelector(inboxRow, {
      state: "detached",
      timeout: 15_000,
    });
    inbox.cleared = true;
  } catch (error) {
    inbox.error = String(error).slice(0, 300);
  }
}
page.off("request", recordInboxDecide);
await page.screenshot({
  path: path.join(EVIDENCE_DIR, "approvals-decided.png"),
});
const pendingAfterInbox = await rpcFromDrive("listPendingApprovals", {});
const inPending = (result) =>
  (result.value?.approvals ?? []).some(
    (request) =>
      request.sessionId === inboxSessionId &&
      request.requestId === inboxRequestId,
  );
inbox.decides = inboxDecides;
inbox.pendingBefore = inPending(pendingBeforeInbox);
inbox.pendingAfter = inPending(pendingAfterInbox);
assert(
  "approvals shows the pending approval and decides it",
  inbox.listed &&
    approvalsCopy.includes(INBOX_ACTION) &&
    approvalsCopy.includes(inboxSessionId) &&
    !approvalsCopy.includes("Policy enforcement is M3") &&
    inbox.pendingBefore &&
    inbox.cleared &&
    inboxDecides.length === 1 &&
    inboxDecides[0]?.sessionId === inboxSessionId &&
    inboxDecides[0]?.requestId === inboxRequestId &&
    inboxDecides[0]?.decision === "approved" &&
    inboxDecides[0]?.actor === "dashboard" &&
    inboxDecides[0]?.resume === true &&
    pendingAfterInbox.exit === "Success" &&
    !inbox.pendingAfter,
  `listed ${inbox.listed}, cleared ${inbox.cleared}; API pending before ${inbox.pendingBefore}, after ${inbox.pendingAfter}; sent ${JSON.stringify(inboxDecides)}`,
);

// The decision resumed the session: its log holds the follow-up naming the decision, and a run
// answered it. Read from the API, and polled, because the run lands after the click's answer — and
// up.sh's faux turn sleeps (`FAUX_COMMAND`, 12 s by default), so the wait is up to 40 s.
let resumedEntries = [];
for (let attempt = 0; attempt < 160; attempt += 1) {
  const read = await rpcFromDrive("getSession", { sessionId: inboxSessionId });
  resumedEntries = read.value?.entries ?? [];
  const resumedAt = resumedEntries.findIndex(
    (entry) =>
      entry.kind === "user" &&
      String(entry.text).startsWith(`Approved: \`${INBOX_ACTION}\``),
  );
  if (
    resumedAt >= 0 &&
    read.value?.live?.busy === false &&
    resumedEntries
      .slice(resumedAt)
      .some((entry) => entry.kind === "assistant" && entry.text !== "")
  )
    break;
  await new Promise((resolve) => setTimeout(resolve, 250));
}
const resumedUser = resumedEntries.find(
  (entry) =>
    entry.kind === "user" &&
    String(entry.text).startsWith(`Approved: \`${INBOX_ACTION}\``),
);
inbox.resumedWith = resumedUser?.text ?? null;
assert(
  "the decided approval resumed its session",
  resumedUser !== undefined &&
    String(resumedUser.text).includes("approved by dashboard") &&
    resumedEntries.some(
      (entry) =>
        entry.kind === "assistant" &&
        String(entry.text).includes(String(resumedUser.text)),
    ),
  `follow-up ${JSON.stringify(inbox.resumedWith)}; ${resumedEntries.length} entries`,
);

// And the session pane no longer says it is waiting: the decided approval left both lists.
await page.goto(`${WEB_URL}/sessions/${inboxSessionId}`, {
  waitUntil: "domcontentloaded",
});
// The strip renders nothing while its read loads or fails, so "no strip" alone proves nothing: the
// pane's hidden loaded-and-empty marker is waited for first, and only then is the strip counted.
inbox.sessionLoadedEmpty = await page
  .waitForSelector(`[data-session-approvals-empty='${inboxSessionId}']`, {
    state: "attached",
    timeout: 15_000,
  })
  .then(
    () => true,
    () => false,
  );
inbox.sessionStripAfter = await page
  .locator(`[data-session-approvals='${inboxSessionId}']`)
  .count();
assert(
  "the session pane drops the decided approval",
  inbox.sessionLoadedEmpty && inbox.sessionStripAfter === 0,
  `loaded and empty ${inbox.sessionLoadedEmpty}; strip elements after the decision: ${inbox.sessionStripAfter}`,
);
observed.approvalsInbox = inbox;

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

// Below `md` a session's route hides the list whatever its id decodes to (LOB-210), so the refused
// pane carries the same `Show sessions` link as a session's header: without it a phone's only way
// back is the rail. At 390 px the link is visible and opens `/sessions`; from `md` up it is hidden.
const badIdBack = { wideVisible: null, narrowVisible: null, path: null };
badIdBack.wideVisible = await page
  .locator("a[aria-label='Show sessions']")
  .isVisible();
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(300);
const badIdBackLink = page.locator("a[aria-label='Show sessions']");
badIdBack.narrowVisible = await badIdBackLink.isVisible();
if (badIdBack.narrowVisible) {
  await badIdBackLink.click({ timeout: 10_000 }).catch(() => undefined);
  await page
    .waitForFunction(() => window.location.pathname === "/sessions", null, {
      timeout: 10_000,
    })
    .catch(() => undefined);
}
badIdBack.path = await page.evaluate(() => window.location.pathname);
await page.setViewportSize({ width: 1440, height: 900 });
observed.badIdBack = badIdBack;
assert(
  "a bad session id's pane links back to the list at 390px",
  badIdBack.wideVisible === false &&
    badIdBack.narrowVisible === true &&
    badIdBack.path === "/sessions",
  JSON.stringify(badIdBack),
);

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
// them. Each run makes its **own** board through the New board form (below) and seeds one card in
// `intake` onto it through the real `TaskService` (`.pi/skills/verify-board/seed.ts`, given the
// form's board as `SEED_BOARD_ID`), so the drive can be rerun against the same `./up.sh`
// instance: the move below changes only this run's card. The oracle for the lane order is
// `getBoard` asked from this process, so a definition that reorders its columns changes the
// expectation rather than breaking the check. The lanes themselves never change a card: every move
// below is made in the card pane (LOB-76) or by `factory board move`, and every request the board
// pages send is recorded and checked against what the walk clicked.
//
// The seed runs by path, as `verify-board/up.sh` runs it: the root declares the workspace packages
// it imports (`@repo/core`, `@repo/storage-postgres`), so they resolve from `.pi/`. It writes to
// this process's `DATABASE_URL`, which must be the one the API was started with; a mismatch is
// caught below, because the API then does not hold the board.
const boardObserved = {};
let boardSeed = null;

// The board is made the way an operator makes one (C5): the **New board** form on `/boards`, on a
// repository slug of this run's own and version 1 of the default definition (the version the seed
// has always pinned, so the card-pane checks below read the same pipeline). Only the card is seeded
// through `TaskService`, onto the board the form made. A form that did not land on a board leaves
// `formBoardId` empty, and the seed check below fails with the reason.
const BOARD_REPO = `verify-web/${randomBytes(6).toString("hex")}`;
let formBoardId = "";
try {
  await page.goto(`${WEB_URL}/boards`, { waitUntil: "domcontentloaded" });
  await page.locator("[data-new-board]").first().click({ timeout: 20_000 });
  await page.waitForSelector("[data-board-form]", { timeout: 20_000 });
  // With repositories registered (the session checks above register some) the repository is a
  // select with "Another repository…" last; with none it is the slug's own input.
  const picker = page.locator("select#new-board-repo");
  if ((await picker.count()) > 0) {
    await picker.selectOption("");
    await page.locator("#new-board-repo-text").fill(BOARD_REPO);
  } else {
    await page.locator("input#new-board-repo").fill(BOARD_REPO);
  }
  await page.locator("#new-board-version").selectOption("1");
  await page.locator("[data-board-submit]").click();
  await page.waitForFunction(
    () => /^\/boards\/brd_[0-9a-z]{26}$/.test(window.location.pathname),
    null,
    { timeout: 20_000 },
  );
  formBoardId = new URL(page.url()).pathname.split("/").pop() ?? "";
} catch (error) {
  boardObserved.formError = String(error).slice(0, 300);
}
const seed = spawnSync(
  "bun",
  ["run", path.join(ROOT, ".pi/skills/verify-board/seed.ts")],
  {
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, SEED_BOARD_ID: formBoardId },
  },
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

assert(
  "the board was made through the New board form",
  formBoardId.startsWith("brd_") &&
    boardId === formBoardId &&
    truth.value?.instance?.repo === BOARD_REPO &&
    truth.value?.instance?.definitionVersion === 1,
  formBoardId === ""
    ? `the form did not land on a board: ${boardObserved.formError ?? "no error"}`
    : `${formBoardId} for ${BOARD_REPO}, seeded ${boardId}, getBoard repo ${String(truth.value?.instance?.repo)} v${String(truth.value?.instance?.definitionVersion)}`,
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
  // A lane's settings disclosure (LOB-245) reads the board's configuration when it is opened.
  "getBoardConfig",
  "listTasks",
  // The board page reads its cards with `listBoardCards` (C10): the face's run status, PR and spend.
  "listBoardCards",
  "listSessions",
  "listTaskRuns",
  // The card pane's thread (LOB-239): a read. Its write, `commentTask`, is not one of the clicks
  // this block makes, so a comment sent from here would show as an unexpected write below.
  "listTaskComments",
  // The card pane's spec document (LOB-238): a read the pane makes on opening a card, so the
  // write check below would otherwise count it as a write nobody clicked.
  "getTaskSpec",
  // The card pane's plan (D10): read beside the spec on opening a card and on every board poll.
  "getTaskPlan",
  // The card pane's exit checklist (D9): a read it makes on opening a card and on every poll.
  "getTaskExit",
  "getSession",
  "watchSession",
  "listApprovals",
  // The rail's "Needs a person" count (LOB-271) polls it from every page.
  "listAttention",
  // The shell's faux banner (LOB-272) reads it on every page.
  "getServerInfo",
  // The New session form's cost estimate (LOB-38) is a read: it spends nothing and opens nothing.
  "predictCost",
  // The getting-started checklist (C9) reads the registry beside the boards, cards and runs.
  "listRepos",
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
      // A lane header's settings disclosure (LOB-245) is the one button a lane holds: it opens what the
      // column does, read-only, and writes nothing — the write check below would catch it if it did.
      controls: document.querySelectorAll(
        "[aria-label='Lanes'] button:not([data-lane-settings-toggle]), [aria-label='Lanes'] [role='button']:not([data-lane-settings-toggle]), [aria-label='Lanes'] [draggable='true']",
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
 * The transitions the card's own pinned definition version declares out of `column`, as the server
 * describes it (LOB-267): `getTask` names the board and the version the card pinned, and that
 * version's `exits` (via `getBoardConfig` when it is the board's, `getDefinition` otherwise) are what
 * `TaskService` refuses against. The server half of the claim — a move the definition does not list
 * is refused — is asserted against the API below. `null` when any read fails.
 */
const declaredOutOf = async (taskId, column) => {
  const task = (await rpcFromDrive("getTask", { taskId })).value;
  if (task === null) return null;
  const config = (
    await rpcFromDrive("getBoardConfig", { boardId: task.boardId })
  ).value;
  if (config === null) return null;
  const definition =
    config.definition?.version === task.definitionVersion
      ? config.definition
      : (
          await rpcFromDrive("getDefinition", {
            definitionId: config.instance?.definitionId,
            version: task.definitionVersion,
          })
        ).value;
  const exits = definition?.columns?.find(
    (candidate) => candidate.name === column,
  )?.exits;
  return Array.isArray(exits) ? exits.map((exit) => exit.to) : null;
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
const declaredIntake = await declaredOutOf(cardId, "intake");
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
    (body.includes('"tag":"getBoard"') ||
      body.includes('"tag":"listBoardCards"') ||
      body.includes('"tag":"listTasks"'))
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
// The stale refusal described revision 3; the card is at 4 now, so the pane no longer shows it
// over the new column's moves.
assert(
  "the stale refusal is dropped once the card moves on",
  followedPane !== null && followedPane.refusal === null,
  `refusal after the CLI move ${JSON.stringify(followedPane?.refusal ?? null)}`,
);
// The pane re-offers from the new column, still exactly what that column declares.
const declaredSpecifying = await declaredOutOf(cardId, "specifying");
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

// And the reverse: a move made in the browser is what `factory board show` prints. Leaving
// `specifying` needs the card's spec (D9); this block is about the move, so the spec a specifying
// run's `spec` tool would post is declared in-process (`lib/seed-spec.ts`), one revision on, and the
// pane is let catch up to it before the click. The checklist and the refusal are
// `exit-checklist.sh`'s.
const specSeed = spawnSync(
  "bun",
  ["run", path.join(ROOT, ".pi/skills/lib/seed-spec.ts")],
  {
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, TASK_ID: cardId },
  },
);
paneObserved.specSeed = {
  status: specSeed.status,
  stdout: (specSeed.stdout ?? "").trim().slice(0, 200),
  stderr: (specSeed.stderr ?? "").trim().slice(0, 200),
};
await page
  .waitForSelector(
    `aside[data-card-pane='${cardId}'][data-card-pane-revision='5']`,
    { timeout: 15_000 },
  )
  .catch(() => undefined);
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
    /^revision\s+6$/m.test(cliShow.stdout),
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

// Run start: `planning` is a working column, so the pane offers a run; Start run then Send is
// `createSession` with the card named, and the run is listed on the card and opened beside it.
let runId = null;
try {
  await page.locator("aside[data-card-pane] [data-start-run]").click();
  // Start run opens the prompt field (C6); Send opens the run and sends its text.
  await page.locator("aside[data-card-pane] [data-start-send]").click();
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

// The run's Approvals pane is a write path: a pending approval is listed with Approve/Deny, and the
// click is `decideApproval` as a person (`dashboard`). The request is made from the drive through
// the API's own `requestApproval` — what a gated action does — and the oracle for the decision is
// the API's `listApprovals`, asked from here, not the page.
const approvalRequestId = `verify-web-approval-${Date.now()}`;
const decidePayloads = [];
const recordDecide = (request) => {
  if (!/\/rpc\/?$/.test(request.url()) || request.method() !== "POST") return;
  for (const line of (request.postData() ?? "").split("\n")) {
    try {
      const message = JSON.parse(line);
      if (message?._tag === "Request" && message.tag === "decideApproval")
        decidePayloads.push(message.payload);
    } catch {
      // Not an envelope line.
    }
  }
};
page.on("request", recordDecide);
const asked =
  runId === null
    ? { exit: null }
    : await rpcFromDrive("requestApproval", {
        sessionId: runId,
        requestId: approvalRequestId,
        action: "verify-web: push the branch",
        detail: "seeded by the drive",
      });
let approvalListed = false;
let approvalCleared = false;
try {
  await page
    .locator("aside[data-card-pane] [role='tab']", { hasText: "Approvals" })
    .click();
  await page.waitForSelector(
    `aside[data-card-pane] [data-approval='${approvalRequestId}']`,
    { timeout: 15_000 },
  );
  approvalListed = true;
  await page
    .locator(
      `aside[data-card-pane] [data-approval='${approvalRequestId}'] [data-decide='approved']`,
    )
    .click();
  await page.waitForSelector("aside[data-card-pane] [data-no-approvals]", {
    timeout: 15_000,
  });
  approvalCleared = true;
} catch (error) {
  paneObserved.approvalError = String(error).slice(0, 300);
}
page.off("request", recordDecide);
const pendingAfter =
  runId === null
    ? { exit: null, value: null }
    : await rpcFromDrive("listApprovals", { sessionId: runId });
paneObserved.approvals = {
  asked: asked.exit,
  listed: approvalListed,
  cleared: approvalCleared,
  decide: decidePayloads,
  pendingAfter: pendingAfter.value,
};
assert(
  "a run's pending approval is decided from the card's Approvals pane",
  asked.exit === "Success" &&
    approvalListed &&
    approvalCleared &&
    decidePayloads.length === 1 &&
    decidePayloads[0]?.requestId === approvalRequestId &&
    decidePayloads[0]?.decision === "approved" &&
    decidePayloads[0]?.actor === "dashboard" &&
    pendingAfter.exit === "Success" &&
    (pendingAfter.value?.approvals ?? []).length === 0,
  `requested ${String(asked.exit)}; listed ${approvalListed}, cleared ${approvalCleared}; sent ${JSON.stringify(decidePayloads)}; API pending ${JSON.stringify(pendingAfter.value?.approvals ?? null)}`,
);
await page.screenshot({
  path: path.join(EVIDENCE_DIR, "card-pane-approvals.png"),
});

// The lanes still hold no control that can change a card, and the only writes the board pages sent
// are the two moves the walk clicked (the refused one and the accepted one) and the run start —
// `createSession` then the first message Send puts in the run (C6). The tags are the requests' own, so a write wired to any other element would be caught here.
page.off("request", recordRpcTags);
const BOARD_WRITES = new Set([
  "moveTask",
  "createSession",
  "sendMessage",
  "decideApproval",
]);
const boardWrites = boardRpcTags.filter((tag) => !BOARD_READS.has(tag));
boardObserved.rpcTags = boardRpcTags;
assert(
  "the lanes hold no move control, and the pages wrote only what was clicked",
  before.controls === 0 &&
    afterReload.controls === 0 &&
    boardWrites.every((tag) => BOARD_WRITES.has(tag)) &&
    boardWrites.filter((tag) => tag === "moveTask").length === 2 &&
    boardWrites.filter((tag) => tag === "createSession").length === 1 &&
    boardWrites.filter((tag) => tag === "sendMessage").length === 1 &&
    boardWrites.filter((tag) => tag === "decideApproval").length === 1,
  `controls ${before.controls}/${afterReload.controls}; writes ${JSON.stringify(boardWrites)}`,
);

// `?run=` opens only a run of the selected card: a well-formed session id that is not one of its
// runs is named as such, and no transcript, composer or approvals are opened under the card.
const foreignRun = "ses_0123456789abcdefghjkmnpqrs";
await page.goto(
  `${WEB_URL}/boards/${boardId}?card=${cardId}&run=${foreignRun}`,
  { waitUntil: "domcontentloaded" },
);
const foreignShown = await page
  .waitForSelector(`aside[data-card-pane] [data-run-foreign='${foreignRun}']`, {
    timeout: 15_000,
  })
  .then(
    () => true,
    () => false,
  );
const foreignPanes = await page.evaluate(
  () => document.querySelectorAll("aside[data-card-pane] [role='tab']").length,
);
paneObserved.foreignRun = { shown: foreignShown, tabs: foreignPanes };
assert(
  "a run that is not the card's is not opened in its pane",
  foreignShown && foreignPanes === 0,
  `foreign note shown: ${foreignShown}; run tabs ${foreignPanes}`,
);

// The card pane links the issue a card was filed from (LOB-254). The seeded card was filed from
// nowhere, so its pane shows no external ref at all; a card filed as a Linear delivery files one —
// `createTask` with the ref and the issue's link, the fields `TriggerCardsFromTaskService` sets —
// shows the ref as a link to the issue, opening in a new tab. A `javascript:` link is refused by the
// API, so the page is never handed one to render.
const seededExternal = await page.evaluate(
  () =>
    document.querySelectorAll("aside[data-card-pane] [data-card-external]")
      .length,
);
const ISSUE_URL = `https://linear.app/acme/issue/VER-${Date.now()}/filed-from-linear`;
const filedFromLinear = await rpcFromDrive("createTask", {
  boardId,
  title: "filed from Linear",
  body: "The issue's description, as the card's body.",
  externalRef: "linear:iss-verify-web",
  externalUrl: ISSUE_URL,
  actor: "trigger:linear",
});
const refusedLink = await rpcFromDrive("createTask", {
  boardId,
  title: "a link that is not one",
  externalUrl: "javascript:alert(1)",
  actor: "trigger:linear",
});
const linkedId = filedFromLinear.value?.id;
let externalLinkShown = null;
if (typeof linkedId === "string") {
  await page.goto(`${WEB_URL}/boards/${boardId}?card=${linkedId}`, {
    waitUntil: "domcontentloaded",
  });
  externalLinkShown = await page
    .waitForSelector(
      `aside[data-card-pane='${linkedId}'] a[data-card-external-link]`,
      { timeout: 15_000 },
    )
    .then(
      (link) =>
        link.evaluate((anchor) => ({
          href: anchor.getAttribute("href"),
          target: anchor.getAttribute("target"),
          rel: anchor.getAttribute("rel"),
          label: anchor.getAttribute("data-card-external"),
          text: anchor.textContent?.trim() ?? "",
        })),
      () => null,
    );
  await page.screenshot({
    path: path.join(EVIDENCE_DIR, "card-pane-external-link.png"),
  });
}
paneObserved.externalLink = {
  seededExternal,
  created: filedFromLinear.exit,
  refused: {
    exit: refusedLink.exit,
    cause: JSON.stringify(refusedLink.cause).slice(0, 200),
  },
  shown: externalLinkShown,
};
assert(
  "the card pane links the Linear issue a card was filed from, and a card from nowhere shows none",
  seededExternal === 0 &&
    filedFromLinear.exit === "Success" &&
    externalLinkShown?.href === ISSUE_URL &&
    externalLinkShown.label === "linear:iss-verify-web" &&
    externalLinkShown.text === "linear:iss-verify-web" &&
    externalLinkShown.target === "_blank" &&
    (externalLinkShown.rel ?? "").includes("noopener") &&
    refusedLink.exit === "Failure" &&
    JSON.stringify(refusedLink.cause).includes("externalUrl"),
  `seeded card externals ${seededExternal}; link ${JSON.stringify(externalLinkShown)}; javascript: link ${String(refusedLink.exit)}`,
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

// Feature: the card pane under a definition's own transitions (LOB-267). See features/card-pane.md.
//
// A board over a definition whose columns are not the default pipeline's — todo → doing → done, a
// `sign-off` gate on doing → done, `todo` its initial column, and a `review` column that declares no
// moves — seeded by `seed-definition.ts` (the row as a migration writes one, the board and card
// through `TaskService`). The pane must offer what *this* definition declares and nothing else: the
// default pipeline's table, read by column name, would offer `todo` nothing and `review` two moves.
// The API is asked the same questions from here, so the pane and the service are held to one answer.
const syntheticObserved = {};
const syntheticSeed = spawnSync(
  "bun",
  ["run", path.join(ROOT, ".pi/skills/verify-web/seed-definition.ts")],
  { encoding: "utf8", timeout: 60_000 },
);
let synthetic = null;
try {
  synthetic = JSON.parse((syntheticSeed.stdout ?? "").trim());
} catch (error) {
  syntheticObserved.seedError = String(error).slice(0, 200);
}
syntheticObserved.seed = {
  status: syntheticSeed.status,
  stdout: (syntheticSeed.stdout ?? "").trim().slice(0, 300),
  stderr: (syntheticSeed.stderr ?? "").trim().slice(0, 300),
};
const synBoard =
  typeof synthetic?.boardId === "string" ? synthetic.boardId : "";
const synCard = typeof synthetic?.taskId === "string" ? synthetic.taskId : "";
const synConfig = await rpcFromDrive("getBoardConfig", { boardId: synBoard });
syntheticObserved.config = synConfig.value?.definition ?? null;
assert(
  "a board over a synthetic definition starts its card in the definition's initial column",
  syntheticSeed.status === 0 &&
    synthetic?.column === "todo" &&
    synthetic?.revision === 1 &&
    synConfig.exit === "Success" &&
    synConfig.value?.definition?.initialColumn === "todo",
  syntheticSeed.status !== 0 || synthetic === null
    ? `seed exit ${String(syntheticSeed.status)}: ${syntheticObserved.seed.stderr || syntheticObserved.seedError}`
    : `card in ${String(synthetic.column)} r${String(synthetic.revision)}; config ${String(synConfig.exit)} initial ${String(synConfig.value?.definition?.initialColumn)}`,
);

/** The open pane's moves once it shows the synthetic card at `revision`, or `null` when it does not. */
const synPaneAt = async (revision) => {
  const shown = await page
    .waitForFunction(
      ({ id, revision }) => {
        const pane = document.querySelector(`aside[data-card-pane='${id}']`);
        return (
          pane !== null &&
          pane.getAttribute("data-card-pane-revision") === String(revision)
        );
      },
      { id: synCard, revision },
      { timeout: 15_000 },
    )
    .then(
      () => true,
      () => false,
    );
  return shown ? readPane(page) : null;
};

await page.goto(`${WEB_URL}/boards/${synBoard}?card=${synCard}`, {
  waitUntil: "domcontentloaded",
});
const synTodo = await synPaneAt(1);
syntheticObserved.todo = synTodo;
const synLanes = await page.evaluate(() =>
  Array.from(document.querySelectorAll("section[data-lane]")).map((lane) =>
    lane.getAttribute("data-lane"),
  ),
);
syntheticObserved.lanes = synLanes;
assert(
  "a card in todo is offered exactly doing, ungated — what its own definition declares",
  synTodo?.column === "todo" &&
    JSON.stringify(synLanes) ===
      JSON.stringify(["todo", "doing", "review", "done"]) &&
    JSON.stringify(
      (synTodo?.moves ?? []).map((move) => [move.to, move.gate]),
    ) === JSON.stringify([["doing", null]]),
  `lanes ${JSON.stringify(synLanes)}; pane ${String(synTodo?.column)}; moves ${JSON.stringify((synTodo?.moves ?? []).map((move) => [move.to, move.gate]))}`,
);
const synSkip = await rpcFromDrive("moveTask", {
  taskId: synCard,
  expectedRevision: 1,
  to: "done",
  actor: "drive",
});
const synAfterSkip = await rpcFromDrive("getTask", { taskId: synCard });
syntheticObserved.skip = { exit: synSkip, after: synAfterSkip.value };
assert(
  "the API refuses todo → done as an undeclared transition, and the card stays",
  synSkip.exit === "Failure" &&
    JSON.stringify(synSkip.cause).includes("UndeclaredTransition") &&
    JSON.stringify(synSkip.cause).includes(
      'column \\"todo\\" declares no transition to \\"done\\"',
    ) &&
    synAfterSkip.value?.column === "todo" &&
    synAfterSkip.value?.revision === 1,
  `API ${String(synSkip.exit)} ${JSON.stringify(synSkip.cause).slice(0, 200)}; card ${String(synAfterSkip.value?.column)} r${String(synAfterSkip.value?.revision)}`,
);
await page.screenshot({
  path: path.join(EVIDENCE_DIR, "card-pane-synthetic-todo.png"),
});

// The click is the person's move along the definition; the pane then offers `doing`'s one exit,
// marked with its gate, and the API refuses a run that tries to cross it.
await page
  .locator(`aside[data-card-pane='${synCard}'] [data-move-to='doing']`)
  .click()
  .catch((error) => {
    syntheticObserved.clickError = String(error).slice(0, 200);
  });
const synDoing = await synPaneAt(2);
syntheticObserved.doing = synDoing;
assert(
  "the pane moves the card to doing, then offers done marked with the sign-off gate",
  synDoing?.column === "doing" &&
    JSON.stringify(
      (synDoing?.moves ?? []).map((move) => [move.to, move.gate]),
    ) === JSON.stringify([["done", "sign-off"]]) &&
    (synDoing?.moves?.[0]?.label ?? "").endsWith("a person's move"),
  `pane ${String(synDoing?.column)} r${String(synDoing?.revision)}; moves ${JSON.stringify(synDoing?.moves ?? null)}; ${syntheticObserved.clickError ?? ""}`,
);
const synRunGate = await rpcFromDrive("moveTask", {
  taskId: synCard,
  expectedRevision: 2,
  to: "done",
  actor: "ses_0123456789abcdefghjkmnpqrs",
});
const synAfterGate = await rpcFromDrive("getTask", { taskId: synCard });
syntheticObserved.runGate = { exit: synRunGate, after: synAfterGate.value };
assert(
  "the API refuses a run crossing the sign-off gate, and the card stays in doing",
  synRunGate.exit === "Failure" &&
    JSON.stringify(synRunGate.cause).includes("HumanGateRequired") &&
    JSON.stringify(synRunGate.cause).includes("sign-off") &&
    synAfterGate.value?.column === "doing" &&
    synAfterGate.value?.revision === 2,
  `API ${String(synRunGate.exit)} ${JSON.stringify(synRunGate.cause).slice(0, 200)}; card ${String(synAfterGate.value?.column)} r${String(synAfterGate.value?.revision)}`,
);
await page.screenshot({
  path: path.join(EVIDENCE_DIR, "card-pane-synthetic-doing.png"),
});
observed.cardPaneSynthetic = syntheticObserved;

// Feature: what needs a person (LOB-77). See features/attention.md.
//
// The attention view lists the cards a person has to act on — a run's pending approval, a run's
// unanswered question, a done run at a human gate — each with the reason and a link to its card.
// The drive seeds its own board (`seed-attention.ts`) so the checks are about this run's cards only:
// first with nothing that needs a person (a resting card, and a card blocked on a dependency whose
// run is idle at the plan approval), which must read as an explicit empty state; then a run that asks
// a question, a run that asks for an approval, and a run that works and then stops at the plan
// approval. The oracle for every row is the API's `listAttention`, asked from here.
const attentionObserved = {};
const seedAttention = (env) => {
  const run = spawnSync(
    "bun",
    [path.join(ROOT, ".pi/skills/verify-web/seed-attention.ts")],
    {
      cwd: ROOT,
      env: { ...process.env, ...env },
      encoding: "utf8",
      timeout: 60_000,
    },
  );
  try {
    return { status: run.status, value: JSON.parse((run.stdout ?? "").trim()) };
  } catch {
    return {
      status: run.status,
      value: null,
      stderr: (run.stderr ?? "").trim().slice(0, 300),
    };
  }
};
const attentionSeed = seedAttention({ MODE: "board" });
attentionObserved.seed = attentionSeed;
const att = attentionSeed.value ?? {};
const attBoard = typeof att.boardId === "string" ? att.boardId : "";
const attCards = await rpcFromDrive("listTasks", { boardId: attBoard });
assert(
  "an attention board with five cards was seeded",
  attentionSeed.status === 0 &&
    attBoard.startsWith("brd_") &&
    attCards.exit === "Success" &&
    (attCards.value ?? []).length === 5 &&
    (attCards.value ?? []).some(
      (task) =>
        task.id === att.waiting && task.blocked?.reason === "dependency",
    ),
  attentionSeed.status === 0
    ? `board ${attBoard}: ${JSON.stringify((attCards.value ?? []).map((task) => [task.column, task.blocked?.reason ?? null]))}`
    : `seed exit ${String(attentionSeed.status)}: ${attentionSeed.stderr ?? ""}`,
);

/** An idle run on the card (`createSession` with the card named, nothing sent), as `factory board start --idle` opens. */
const startRunOn = async (taskId, column) => {
  const created = await rpcFromDrive("createSession", {
    title: `attention run ${column}`,
    taskId,
    taskColumn: column,
  });
  return typeof created.value?.id === "string" ? created.value.id : "";
};

/** The attention rows as the page renders them, in page order. */
const readAttention = (target) =>
  target.evaluate(() => ({
    empty: document.querySelector("[data-attention-empty]") !== null,
    emptyText: (
      document.querySelector("[data-attention-empty]")?.textContent ?? ""
    )
      .replace(/\s+/g, " ")
      .trim(),
    groups: Array.from(document.querySelectorAll("[data-attention-group]")).map(
      (group) => group.getAttribute("data-attention-group"),
    ),
    rows: Array.from(document.querySelectorAll("li[data-attention]")).map(
      (row) => ({
        card: row.getAttribute("data-attention"),
        reason: row.getAttribute("data-attention-reason"),
        group:
          row
            .closest("[data-attention-group]")
            ?.getAttribute("data-attention-group") ?? null,
        text: (
          row.querySelector("[data-attention-text]")?.textContent ?? ""
        ).trim(),
        href: row.querySelector("a")?.getAttribute("href") ?? null,
        all: (row.textContent ?? "").replace(/\s+/g, " ").trim(),
      }),
    ),
  }));
const rowFor = (view, card, reason) =>
  view.rows.find((row) => row.card === card && row.reason === reason);
const waitForAttention = (predicate, arg, timeout) =>
  page.waitForFunction(predicate, arg, { timeout }).then(
    () => true,
    () => false,
  );

// 1. Nothing needs a person yet. The dependency-blocked card gets its idle run in `planning` first,
// so it would be at the plan approval if the block were ignored: its absence is the claim that a
// card blocked on something other than a person is not listed.
const waitingRun = await startRunOn(att.waiting, "planning");
await page.goto(`${WEB_URL}/attention?board=${attBoard}`, {
  waitUntil: "domcontentloaded",
});
const emptyShown = await waitForAttention(
  () => document.querySelector("[data-attention-empty]") !== null,
  null,
  20_000,
);
const cleanView = await readAttention(page);
const cleanTruth = await rpcFromDrive("listAttention", { boardId: attBoard });
attentionObserved.clean = {
  waitingRun,
  view: cleanView,
  server: cleanTruth.value,
};
await page.screenshot({ path: path.join(EVIDENCE_DIR, "attention-empty.png") });
assert(
  "a board where nothing needs a person shows an explicit empty state",
  emptyShown &&
    waitingRun.startsWith("ses_") &&
    cleanView.rows.length === 0 &&
    cleanView.emptyText.includes("Nothing needs a person") &&
    cleanTruth.exit === "Success" &&
    (cleanTruth.value ?? []).length === 0,
  `empty ${emptyShown}; rows ${cleanView.rows.length}; text ${JSON.stringify(cleanView.emptyText.slice(0, 80))}; listAttention ${JSON.stringify(cleanTruth.value)}`,
);

// 2. Three runs. The gated card's run is given a turn — the faux command sleeps, so it is busy for
// the next ~12 s — and the asked and approval cards' runs ask a person for something.
const QUESTION = "Which Postgres major does this card target?";
const APPROVAL_ACTION = "push refs/heads/attention";
const gatedRun = await startRunOn(att.gated, "planning");
const gatedSent = await rpcFromDrive("sendMessage", {
  sessionId: gatedRun,
  content: "Write the plan.",
});
const askedRun = await startRunOn(att.asked, "specifying");
const askOut = seedAttention({
  MODE: "ask",
  TASK_ID: att.asked,
  SESSION_ID: askedRun,
  QUESTION,
});
const approvalRun = await startRunOn(att.approval, "building");
const approvalAsked = await rpcFromDrive("requestApproval", {
  sessionId: approvalRun,
  requestId: `verify-web-attention-${Date.now()}`,
  action: APPROVAL_ACTION,
  detail: "one commit, fast-forward",
});
attentionObserved.runs = {
  gatedRun,
  gatedSent: gatedSent.exit,
  askedRun,
  ask: askOut,
  approvalRun,
  approvalAsked: approvalAsked.exit,
};

// While the gated card's run is busy it is not at the gate: the run is still working.
const rowsReady = await waitForAttention(
  ({ asked, approval }) =>
    document.querySelector(
      `li[data-attention='${asked}'][data-attention-reason='question']`,
    ) !== null &&
    document.querySelector(
      `li[data-attention='${approval}'][data-attention-reason='approval']`,
    ) !== null,
  { asked: att.asked, approval: att.approval },
  20_000,
);
const whileBusy = await readAttention(page);
const busySnapshot = await rpcFromDrive("getSession", { sessionId: gatedRun });
const busyTruth = await rpcFromDrive("listAttention", { boardId: attBoard });
attentionObserved.whileBusy = {
  view: whileBusy,
  busy: busySnapshot.value?.live?.busy ?? null,
};
assert(
  "a card whose run is still working is not at the gate",
  rowsReady &&
    busySnapshot.value?.live?.busy === true &&
    whileBusy.rows.every((row) => row.card !== att.gated) &&
    (busyTruth.value ?? []).every((item) => item.task.id !== att.gated),
  `rows ready ${rowsReady}; gated run busy ${String(busySnapshot.value?.live?.busy)}; page rows ${JSON.stringify(whileBusy.rows.map((row) => [row.card, row.reason]))}`,
);

// The run finishes, and the card is at the plan approval — without a reload.
await page.evaluate(() => {
  window.__attentionNoReload = "kept";
});
const gateShown = await waitForAttention(
  (gated) =>
    document.querySelector(
      `li[data-attention='${gated}'][data-attention-reason='gate']`,
    ) !== null,
  att.gated,
  60_000,
);
const attSeeded = await readAttention(page);
const seededTruth = await rpcFromDrive("listAttention", { boardId: attBoard });
const idleSnapshot = await rpcFromDrive("getSession", { sessionId: gatedRun });
const keptPage = await page.evaluate(
  () => window.__attentionNoReload === "kept",
);
attentionObserved.seeded = {
  view: attSeeded,
  server: (seededTruth.value ?? []).map((item) => [
    item.task.id,
    item.reason._tag,
  ]),
  gatedIdle: idleSnapshot.value?.live?.busy === false,
  keptPage,
};
await page.screenshot({ path: path.join(EVIDENCE_DIR, "attention.png") });

const gateRow = rowFor(attSeeded, att.gated, "gate");
const askRow = rowFor(attSeeded, att.asked, "question");
const approvalRow = rowFor(attSeeded, att.approval, "approval");
assert(
  "a done run at the plan approval is listed, with the gate as its reason",
  gateShown &&
    keptPage &&
    idleSnapshot.value?.live?.busy === false &&
    gateRow !== undefined &&
    gateRow.group === "gate" &&
    gateRow.text.includes("plan approval") &&
    gateRow.text.includes("planning → building"),
  `shown ${gateShown}; no reload ${keptPage}; row ${JSON.stringify(gateRow ?? null)}`,
);
assert(
  "a run's unanswered question is listed with the question as its reason",
  askOut.status === 0 &&
    askOut.value?.blocked === "needs_input" &&
    askRow !== undefined &&
    askRow.group === "question" &&
    askRow.text === `Asked: ${QUESTION}`,
  `ask ${JSON.stringify(askOut.value ?? askOut.stderr ?? null)}; row ${JSON.stringify(askRow ?? null)}`,
);
assert(
  "a run's pending approval is listed with the action it asks for",
  approvalAsked.exit === "Success" &&
    approvalRow !== undefined &&
    approvalRow.group === "approval" &&
    approvalRow.text.includes(APPROVAL_ACTION) &&
    approvalRow.text.includes("one commit, fast-forward"),
  `requestApproval ${String(approvalAsked.exit)}; row ${JSON.stringify(approvalRow ?? null)}`,
);
const pageRows = attSeeded.rows.map((row) => `${row.card}:${row.reason}`);
const serverRows = (seededTruth.value ?? []).map(
  (item) => `${item.task.id}:${item.reason._tag}`,
);
assert(
  "a card blocked on a dependency and a resting card are not listed, and the page is the server's list",
  attSeeded.rows.every(
    (row) => row.card !== att.waiting && row.card !== att.resting,
  ) &&
    pageRows.length === 3 &&
    JSON.stringify(pageRows) === JSON.stringify(serverRows) &&
    JSON.stringify(attSeeded.groups) ===
      JSON.stringify(["approval", "question", "gate"]),
  `page ${JSON.stringify(pageRows)}; listAttention ${JSON.stringify(serverRows)}; groups ${JSON.stringify(attSeeded.groups)}`,
);
assert(
  "each row links to its card, an approval's to the run that asked, a question's to the thread",
  gateRow?.href === `/boards/${attBoard}?card=${att.gated}` &&
    askRow?.href === `/boards/${attBoard}?card=${att.asked}#thread` &&
    approvalRow?.href ===
      `/boards/${attBoard}?card=${att.approval}&run=${approvalRun}`,
  `hrefs ${JSON.stringify([gateRow?.href, askRow?.href, approvalRow?.href])}`,
);

// The link works: a click opens the card in its board's pane, and the approval's opens its run.
let gateLinkOpened = false;
try {
  await page
    .locator(
      `li[data-attention='${att.gated}'][data-attention-reason='gate'] a`,
    )
    .click();
  await page.waitForSelector(`aside[data-card-pane='${att.gated}']`, {
    timeout: 15_000,
  });
  gateLinkOpened = true;
} catch {
  // Recorded below.
}
const gateLanded = new URL(page.url());
const gatePane = await readPane(page);
await page.screenshot({
  path: path.join(EVIDENCE_DIR, "attention-card.png"),
});
assert(
  "the gate row's link opens the card's pane on its board",
  gateLinkOpened &&
    gateLanded.pathname === `/boards/${attBoard}` &&
    gateLanded.searchParams.get("card") === att.gated &&
    gatePane?.card === att.gated &&
    gatePane?.column === "planning" &&
    (gatePane?.moves ?? []).some(
      (move) => move.to === "building" && move.gate === "plan approval",
    ),
  `opened ${gateLinkOpened}; at ${gateLanded.pathname}${gateLanded.search}; pane ${JSON.stringify(gatePane === null ? null : { card: gatePane.card, column: gatePane.column, moves: gatePane.moves.map((move) => [move.to, move.gate]) })}`,
);

// The board's own header leads back to its attention view.
let boardBack = false;
try {
  await page.locator("[data-board-attention]").click();
  await page.waitForFunction(
    (board) =>
      window.location.pathname === "/attention" &&
      new URLSearchParams(window.location.search).get("board") === board &&
      document.querySelector("li[data-attention]") !== null,
    attBoard,
    { timeout: 15_000 },
  );
  boardBack = true;
} catch {
  // Recorded below.
}
let approvalLinkOpened = false;
try {
  await page
    .locator(
      `li[data-attention='${att.approval}'][data-attention-reason='approval'] a`,
    )
    .click();
  await page.waitForSelector(
    `aside[data-card-pane='${att.approval}'] [role='tab']`,
    { timeout: 15_000 },
  );
  approvalLinkOpened =
    new URL(page.url()).searchParams.get("run") === approvalRun;
} catch {
  // Recorded below.
}
assert(
  "the board links its attention view, and the approval row opens the run that asked",
  boardBack && approvalLinkOpened,
  `board → attention ${boardBack}; approval → ${new URL(page.url()).pathname}${new URL(page.url()).search}`,
);

// An answer is a person's comment on the card (B7); once it lands the card no longer needs anyone,
// and the open view drops it without a reload.
await page.goto(`${WEB_URL}/attention?board=${attBoard}`, {
  waitUntil: "domcontentloaded",
});
await waitForAttention(
  () => document.querySelector("li[data-attention]") !== null,
  null,
  15_000,
);
await page.evaluate(() => {
  window.__attentionNoReload = "answer";
});
const askedNow = await rpcFromDrive("getTask", { taskId: att.asked });
const answered = await rpcFromDrive("commentTask", {
  taskId: att.asked,
  expectedRevision: askedNow.value?.revision ?? -1,
  body: "Postgres 16.",
  actor: "person:verify-web",
});
const answerDropped = await waitForAttention(
  (asked) =>
    document.querySelector(`li[data-attention='${asked}']`) === null &&
    document.querySelector("li[data-attention]") !== null,
  att.asked,
  15_000,
);
const afterAnswer = await readAttention(page);
const answerKept = await page.evaluate(
  () => window.__attentionNoReload === "answer",
);
attentionObserved.afterAnswer = afterAnswer;
assert(
  "an answered question leaves the view without a reload",
  answered.exit === "Success" &&
    answered.value?.blocked === undefined &&
    answerDropped &&
    answerKept &&
    afterAnswer.rows.length === 2,
  `commentTask ${String(answered.exit)}; dropped ${answerDropped}; no reload ${answerKept}; rows ${JSON.stringify(afterAnswer.rows.map((row) => [row.card, row.reason]))}`,
);

// Every board: the rail's own section, where the rows name their board's repository.
let railOpened = false;
try {
  await page.getByRole("link", { name: "Needs a person" }).first().click();
  await page.waitForFunction(
    (gated) =>
      window.location.pathname === "/attention" &&
      window.location.search === "" &&
      document.querySelector(
        `li[data-attention='${gated}'][data-attention-reason='gate']`,
      ) !== null,
    att.gated,
    { timeout: 15_000 },
  );
  railOpened = true;
} catch {
  // Recorded below.
}
const everywhere = await readAttention(page);
const everywhereGate = rowFor(everywhere, att.gated, "gate");
attentionObserved.everywhere = {
  rows: everywhere.rows.length,
  gate: everywhereGate ?? null,
};
await page.screenshot({
  path: path.join(EVIDENCE_DIR, "attention-all.png"),
});
assert(
  "the rail opens every board's attention view, and its rows name their repository",
  railOpened &&
    everywhereGate !== undefined &&
    everywhereGate.all.includes(att.repo) &&
    everywhere.rows.every((row) => row.card !== att.waiting),
  `rail ${railOpened}; ${everywhere.rows.length} row(s); gate row ${JSON.stringify(everywhereGate?.all ?? null)}`,
);

// A session no card owns that waits on an approval (LOB-271). The API is ungated, so
// `requestApproval` is what a gated command would write; `createSession` names no card, so this is a
// scratch session. The every-board view lists it as one row linking to the session, the rail's count
// is the page's own count, a board's view leaves it out, and the card-bound rows are as before.
const scratchTitle = `attention scratch ${Date.now()}`;
const scratchCreated = await rpcFromDrive("createSession", {
  title: scratchTitle,
});
const scratchId =
  typeof scratchCreated.value?.id === "string" ? scratchCreated.value.id : "";
const SCRATCH_ACTION = "git push origin scratch";
const scratchRequestId = `verify-web-scratch-${Date.now()}`;
const scratchAsked = await rpcFromDrive("requestApproval", {
  sessionId: scratchId,
  requestId: scratchRequestId,
  action: SCRATCH_ACTION,
  detail: "no card owns this session",
});
const scratchShown = await waitForAttention(
  (session) =>
    document.querySelector(
      `li[data-attention='${session}'][data-attention-session]`,
    ) !== null,
  scratchId,
  20_000,
);
const badgeMatches = await waitForAttention(
  () => {
    const rows = document.querySelectorAll("li[data-attention]").length;
    const badge = document
      .querySelector("[data-attention-badge]")
      ?.getAttribute("data-attention-badge");
    const count = document
      .querySelector("[data-attention-count]")
      ?.getAttribute("data-attention-count");
    return rows > 0 && badge === String(rows) && count === String(rows);
  },
  null,
  20_000,
);
const withScratch = await readAttention(page);
const scratchRow = rowFor(withScratch, scratchId, "approval");
const railBadge = await page
  .locator("[data-attention-badge]")
  .first()
  .getAttribute("data-attention-badge")
  .catch(() => null);
const scratchTruth = await rpcFromDrive("listAttention", {});
const scratchItems = (scratchTruth.value ?? []).filter(
  (item) => item.task === undefined,
);
await page.screenshot({
  path: path.join(EVIDENCE_DIR, "attention-scratch.png"),
});
attentionObserved.scratch = {
  sessionId: scratchId,
  row: scratchRow ?? null,
  rows: withScratch.rows.length,
  railBadge,
  server: (scratchTruth.value ?? []).length,
};
assert(
  "a card-less session with a pending approval is one row on the every-board view, linking to the session",
  scratchCreated.exit === "Success" &&
    scratchAsked.exit === "Success" &&
    scratchShown &&
    scratchRow !== undefined &&
    scratchRow.group === "approval" &&
    scratchRow.href === `/sessions/${scratchId}` &&
    scratchRow.text ===
      `A session asks to ${SCRATCH_ACTION}: no card owns this session` &&
    scratchRow.all.includes(scratchTitle) &&
    withScratch.rows.filter((row) => row.card === scratchId).length === 1 &&
    withScratch.empty === false &&
    scratchItems.some(
      (item) =>
        item.reason.sessionId === scratchId &&
        item.sessionTitle === scratchTitle,
    ),
  `row ${JSON.stringify(scratchRow ?? null)}; empty ${withScratch.empty}`,
);
assert(
  "the rail's count is the number of rows, and the card-bound rows are still there",
  badgeMatches &&
    railBadge === String(withScratch.rows.length) &&
    withScratch.rows.length === (scratchTruth.value ?? []).length &&
    rowFor(withScratch, att.gated, "gate") !== undefined &&
    rowFor(withScratch, att.approval, "approval") !== undefined,
  `badge ${String(railBadge)}; rows ${withScratch.rows.length}; listAttention ${(scratchTruth.value ?? []).length}`,
);
await page.goto(`${WEB_URL}/attention?board=${attBoard}`, {
  waitUntil: "domcontentloaded",
});
await waitForAttention(
  () => document.querySelector("li[data-attention]") !== null,
  null,
  15_000,
);
const scopedView = await readAttention(page);
assert(
  "a board's own view leaves the card-less session out",
  scopedView.rows.length > 0 &&
    scopedView.rows.every((row) => row.card !== scratchId),
  `rows ${JSON.stringify(scopedView.rows.map((row) => row.card))}`,
);
let scratchLinkOpened = false;
try {
  await page.getByRole("link", { name: "Needs a person" }).first().click();
  await page
    .locator(`li[data-attention='${scratchId}'][data-attention-session] a`)
    .click();
  await page.waitForFunction(
    (session) => window.location.pathname === `/sessions/${session}`,
    scratchId,
    { timeout: 15_000 },
  );
  scratchLinkOpened = true;
} catch {
  // Recorded below.
}
assert(
  "the scratch row's link opens the session",
  scratchLinkOpened,
  `at ${new URL(page.url()).pathname}`,
);
// Decide it, so a rerun against the same instance starts from the same every-board state.
const scratchDecided = await rpcFromDrive("decideApproval", {
  sessionId: scratchId,
  requestId: scratchRequestId,
  decision: "denied",
  actor: "verify-web",
});
const afterDecide = await rpcFromDrive("listAttention", {});
assert(
  "the scratch approval is decided and leaves the every-board view",
  scratchDecided.exit === "Success" &&
    (afterDecide.value ?? []).every(
      (item) => item.reason.sessionId !== scratchId,
    ),
  `decide ${scratchDecided.exit}; rows ${(afterDecide.value ?? []).length}`,
);

// A board the server does not hold is named as missing, not shown as "nothing needs a person".
await page.goto(`${WEB_URL}/attention?board=brd_0123456789abcdefghjkmnpqrs`, {
  waitUntil: "domcontentloaded",
});
const missingShown = await waitForAttention(
  () => document.body.innerText.includes("No such board"),
  null,
  15_000,
);
assert(
  "an attention view of a board that does not exist says so",
  missingShown && (await page.locator("[data-attention-empty]").count()) === 0,
  `missing shown ${missingShown}`,
);
observed.attention = attentionObserved;

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

// Feature: the model backend and each session's model are on screen (LOB-272). This instance runs
// `MODEL_BACKEND=faux`, so every route carries the `role="alert"` banner and the session the PR block
// opened shows its `provider/model` in the pane header and its list row. The oracle for the model is
// the server's own `getSession`/`getServerInfo`, read from this process. The anthropic half (no
// banner, `anthropic/claude-sonnet-5-5`) is `backend.sh`'s own instance. See features/backend-badge.md.
const info = await callRpcOnce("getServerInfo", {});
const banner = page.locator("[data-backend-banner]");
const bannerState = async (route) => {
  await page.goto(`${WEB_URL}${route}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("nav[aria-label='Sections']", { timeout: 15_000 });
  await banner
    .first()
    .waitFor({ timeout: 15_000 })
    .catch(() => undefined);
  const present = (await banner.count()) > 0;
  return {
    route,
    present,
    role: present ? await banner.first().getAttribute("role") : null,
    text: present ? (await banner.first().innerText()).trim() : "",
  };
};
const fauxBanner =
  "Scripted model (faux): sessions do not reach a real model. Set ANTHROPIC_API_KEY in the repo-root .env and restart.";
const onSessions = await bannerState("/sessions");
await page.screenshot({ path: path.join(EVIDENCE_DIR, "backend-banner.png") });
const onBoard = await bannerState(`/boards/${boardId}`);
const onSpend = await bannerState("/spend");
observed.backendBanner = { info: info.value, onSessions, onBoard, onSpend };
assert(
  "the server reports the faux backend",
  info.value?.backend === "faux",
  `getServerInfo backend=${info.value?.backend}`,
);
assert(
  "/sessions carries the faux banner as an alert, in the issue's words",
  onSessions.present &&
    onSessions.role === "alert" &&
    onSessions.text.startsWith(fauxBanner),
  JSON.stringify(onSessions).slice(0, 220),
);
assert(
  "a board carries the same banner",
  boardId !== "" &&
    onBoard.present &&
    onBoard.role === "alert" &&
    onBoard.text.startsWith(fauxBanner),
  JSON.stringify(onBoard).slice(0, 220),
);
assert(
  "so does a page that is not about sessions (/spend)",
  onSpend.present && onSpend.text.startsWith(fauxBanner),
  JSON.stringify(onSpend).slice(0, 160),
);

const modelRead =
  seeded.sessionId === ""
    ? { value: null }
    : await callRpcOnce("getSession", { sessionId: seeded.sessionId });
const recordedModel = modelRead.value?.session?.model ?? null;
await page.goto(`${WEB_URL}/sessions/${seeded.sessionId}`, {
  waitUntil: "domcontentloaded",
});
const paneModel = page.locator("header [data-session-model]");
await paneModel
  .first()
  .waitFor({ timeout: 20_000 })
  .catch(() => undefined);
const paneModelText =
  (await paneModel.count()) > 0
    ? (await paneModel.first().innerText()).trim()
    : null;
const rowModel = page.locator(
  `aside a[href='/sessions/${seeded.sessionId}'] [data-session-model]`,
);
await rowModel
  .first()
  .waitFor({ timeout: 20_000 })
  .catch(() => undefined);
const rowModelText =
  (await rowModel.count()) > 0
    ? (await rowModel.first().innerText()).trim()
    : null;
await page.screenshot({ path: path.join(EVIDENCE_DIR, "session-model.png") });
observed.sessionModel = { recordedModel, paneModelText, rowModelText };
assert(
  "the server records the session's model, faux/faux-1 under faux",
  recordedModel === "faux/faux-1",
  `getSession model=${recordedModel}`,
);
assert(
  "the pane header shows the session's provider/model",
  recordedModel !== null && paneModelText === recordedModel,
  `pane=${paneModelText} recorded=${recordedModel}`,
);
assert(
  "its row in the session list shows the same model",
  recordedModel !== null && rowModelText === recordedModel,
  `row=${rowModelText} recorded=${recordedModel}`,
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
