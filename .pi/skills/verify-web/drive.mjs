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

  // Keyboard: the header's last control tabs into the task list, and the list carries a name.
  await page.getByRole("button", { name: "Forget this session" }).focus();
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
const tabOrder = [];
for (let step = 0; step < 30; step += 1) {
  await page.keyboard.press("Tab");
  const name = await focusedName();
  tabOrder.push(name);
  if (
    tabOrder.includes("Fork from here") &&
    tabOrder.includes("Forget this session")
  )
    break;
}
const forkIndex = tabOrder.indexOf("Fork from here");
const forgetIndex = tabOrder.indexOf("Forget this session");
observed.tabOrder = tabOrder;
assert(
  "the fork action is reachable by keyboard",
  forkIndex !== -1,
  `tab order: ${JSON.stringify(tabOrder)}`,
);
assert(
  "the fork action comes before Forget",
  forgetIndex !== -1 && forkIndex < forgetIndex,
  `fork at ${forkIndex}, Forget at ${forgetIndex}`,
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

  // The sidebar reads the browser-local registry (its summaries), so the checks above prove the
  // summary path only. `SessionListEntry.forkedFrom` is the index fold's half of the contract
  // (LOB-182): ask the control plane's own list from inside the page, so the assertion covers the
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
  // wider. The header's own clipping at 390 px is pre-existing (the unchanged Forget button is cut
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
      const button = document.querySelector(
        "button[data-compaction-state]",
      );
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
    const button = document.querySelector(
      "button[data-compaction-state]",
    );
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
      const button = document.querySelector(
        "button[data-compaction-state]",
      );
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
      const button = document.querySelector(
        "button[data-compaction-state]",
      );
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
      const button = document.querySelector(
        "button[data-compaction-state]",
      );
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

// No horizontal overflow with the verdict on screen at a phone width.
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(300);
const narrow = await page.evaluate(() => ({
  scrollWidth: document.documentElement.scrollWidth,
  clientWidth: document.documentElement.clientWidth,
}));
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
      const button = document.querySelector(
        "button[data-compaction-state]",
      );
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
// Send a turn and press Compact in the *same* task, before the pane can hear that the run started.
// The click and the send are both synchronous dispatches — the button is still the idle session's —
// so the compaction is admitted while the run that follows it is starting, which is the one way a
// running session can be awaiting a compaction the pane admitted.
await page
  .locator("textarea")
  .first()
  .fill("Keep going while that summarizes.");
await page.evaluate(() => {
  document.querySelector("textarea")?.form?.requestSubmit();
  document.querySelector("button[data-compaction-state]")?.click();
});
// The evidence is the observer's samples, not a poll: the pending phase can be shorter than any
// polling interval, and it is a DOM change either way. This only waits for the run to finish, so
// nothing is left in flight when the drive moves on.
const busyDeadline = Date.now() + 90_000;
let busyNow = true;
while (Date.now() < busyDeadline) {
  busyNow = await page.evaluate(() =>
    document.body.innerText.includes("BUSY"),
  );
  if (!busyNow) break;
  await page.waitForTimeout(250);
}
const busySettled = !busyNow;
const busySamples = await readCompactionStatus();
observed.compactSettle = {
  ...observed.compactSettle,
  busySession: busySamples,
  busySettled,
};
assert(
  "a busy session shows the pending state, never the verdict",
  busySettled &&
    busySamples.some(
      (sample) =>
        sample.state === "requested" &&
        sample.busy === true &&
        sample.verdictVisible === false,
    ) &&
    // The verdict is held, not discarded: it appears once the run is over, and never before.
    busySamples.every(
      (sample) => !(sample.busy === true && sample.verdictVisible === true),
    ) &&
    busySamples.at(-1)?.state !== "requested",
  `settled=${busySettled} states ${JSON.stringify(busySamples)}`,
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
