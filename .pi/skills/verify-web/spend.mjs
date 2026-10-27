// Drive the spend pane (LOB-162) the way an operator reaches it, against the priced instance
// `spend.sh` starts, and capture evidence.
//
//   node spend.mjs      (via ./spend.sh, which owns the instance this drives)
//
// The drive makes spend with known owners, then requires the page to show it:
//
//   seed      runs on two repos of this run's own (`verify-spend-<tag>/web`, `…/api`) by two actors of
//             its own (`person:amy-<tag>`, `person:bob-<tag>`), through `createSession({ actor })`;
//             one `factory run --repo` from the real CLI (its default actor, `cli`); and one session
//             from the dashboard's own **New session** button (actor `dashboard`, no repo)
//   page      the rail's **Spend** opens `/spend`; its repo × actor table is `listSpend`'s rows, in
//             order, with the same counts and costs; the pairs this run made carry exactly the
//             sessions it put there, at the sum of `listSessions`' `costTotal` for those sessions
//             (the second oracle: the list's own numbers added up), and every one of them cost
//             something; the By repo and By actor lines are those pairs added; the button's session
//             moved the (scratch, dashboard) pair by one session and some cost; the header's total
//             is the report's
//   poll      with the page left open, a run by a third pair appears on it without a reload
//
// Env: WEB_URL, API_URL, EVIDENCE_DIR, FAUX_COST.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const WEB_URL = process.env["WEB_URL"] ?? "http://localhost:3421";
const API_URL = process.env["API_URL"] ?? "http://localhost:9421";
const EVIDENCE_DIR =
  process.env["EVIDENCE_DIR"] ?? ".verify/evidence/latest/spend";
const COST = Number(process.env["FAUX_COST"] ?? "0.01");
const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

const TAG = randomBytes(4).toString("hex");
const WEB = `verify-spend-${TAG}/web`;
const API = `verify-spend-${TAG}/api`;
const AMY = `person:amy-${TAG}`;
const BOB = `person:bob-${TAG}`;

await mkdir(EVIDENCE_DIR, { recursive: true });

const observed = {
  webUrl: WEB_URL,
  apiUrl: API_URL,
  fauxCost: COST,
  tag: TAG,
  sessions: {},
  checks: {},
};
const assert = (name, condition, detail) => {
  observed.checks[name] = { passed: Boolean(condition), detail };
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}  ${detail}`);
  return Boolean(condition);
};
const close = (left, right) =>
  typeof left === "number" &&
  typeof right === "number" &&
  Math.abs(left - right) < 1e-9;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** One unary RPC call over the NDJSON envelope, from this process: the oracle, never the page. */
const rpc = async (tag, payload) => {
  const requestId = `spend-${tag}-${Date.now()}-${Math.random()}`;
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
  if (envelope?.exit?._tag !== "Success") {
    throw new Error(
      `${tag} failed: ${JSON.stringify(envelope?.exit ?? text.slice(0, 400))}`,
    );
  }
  return envelope.exit.value;
};

/** The list's own cost for a session, read from `listSessions` (newest activity first). */
const listedCost = async (sessionId) => {
  const page = await rpc("listSessions", { limit: 100 });
  return page.sessions.find((session) => session.id === sessionId)?.costTotal;
};

/**
 * Settled means answered *and* indexed: the reply is in the transcript, and the list's `costTotal`
 * is the spend the snapshot reports. Spend is written as the run goes, so reading it at "idle"
 * alone could catch the index one request behind.
 */
const settled = async (sessionId) => {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const snapshot = await rpc("getSession", { sessionId });
    const spent = [...snapshot.usage.models, ...snapshot.usage.tools].reduce(
      (total, bucket) => total + bucket.usage.costTotal,
      0,
    );
    const answered = snapshot.entries.some(
      (entry) => entry.kind === "assistant" && entry.text !== "",
    );
    const listed = await listedCost(sessionId);
    if (!snapshot.live.busy && answered && close(listed, spent)) return spent;
    await sleep(100);
  }
  throw new Error(`session ${sessionId} did not settle`);
};

const run = async (label, input) => {
  const session = await rpc("createSession", input);
  await rpc("sendMessage", {
    sessionId: session.id,
    content: "spend a little",
  });
  const spent = await settled(session.id);
  observed.sessions[label] = { id: session.id, ...input, spent };
  return session.id;
};

const formatDollars = (amount) =>
  amount === 0
    ? "no cost reported"
    : amount < 0.0001
      ? "<$0.0001"
      : `$${amount.toFixed(4)}`;

const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const consoleErrors = [];
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});
page.on("pageerror", (error) =>
  consoleErrors.push(`pageerror: ${String(error)}`),
);

let exitCode = 0;
try {
  // --- seed: spend with known owners -----------------------------------------------------------
  const amyWeb1 = await run("amyWeb1", { repo: WEB, actor: AMY });
  const amyWeb2 = await run("amyWeb2", { repo: WEB, actor: AMY });
  const amyApi = await run("amyApi", { repo: API, actor: AMY });
  const bobWeb = await run("bobWeb", { repo: WEB, actor: BOB });

  // The terminal's path: `factory run` names no actor flag, so the session is the CLI's.
  const cli = spawnSync(
    "bun",
    [
      "run",
      path.join(ROOT, "apps/cli/src/index.ts"),
      "run",
      "spend from the terminal",
      "--repo",
      API,
      "--api",
      API_URL,
    ],
    { encoding: "utf8", timeout: 120_000 },
  );
  const cliId = /^session (ses_\S+)$/m.exec(cli.stdout ?? "")?.[1];
  observed.cli = {
    status: cli.status,
    stdout: (cli.stdout ?? "").slice(0, 2000),
    stderr: (cli.stderr ?? "").slice(0, 2000),
  };
  assert(
    "factory run creates its session and exits cleanly",
    cli.status === 0 && cliId !== undefined,
    `exit=${cli.status} session=${cliId ?? "none"}`,
  );
  if (cliId !== undefined) {
    observed.sessions.cli = {
      id: cliId,
      repo: API,
      spent: await settled(cliId),
    };
  }

  // The dashboard's own button: its session is the dashboard's, on no repo.
  const before = await rpc("listSpend", {});
  const pairOf = (report, repo, actor) =>
    report.rows.find((row) => row.repo === repo && row.actor === actor);
  const dashboardBefore = pairOf(before, undefined, "dashboard") ?? {
    sessions: 0,
    costTotal: 0,
  };
  await page.goto(`${WEB_URL}/sessions`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("nav[aria-label='Sections']", { timeout: 15_000 });
  await page.getByRole("button", { name: /new session/i }).click();
  await page.waitForFunction(
    () => /^\/sessions\/ses_/.test(window.location.pathname),
    null,
    { timeout: 20_000 },
  );
  const dashboardId = new URL(page.url()).pathname.split("/").at(-1);
  observed.sessions.dashboard = {
    id: dashboardId,
    spent: await settled(dashboardId),
  };

  // --- the page: reached the way an operator reaches it ------------------------------------------
  await page
    .locator("nav[aria-label='Sections']")
    .getByRole("link", { name: "Spend", exact: true })
    .click();
  await page.waitForFunction(() => window.location.pathname === "/spend");
  await page.waitForSelector("[data-spend-group='pair'] tr[data-spend-pair]", {
    timeout: 20_000,
  });
  await page.evaluate(() => {
    window.__spendNoReload = true;
  });
  const current = await page.$$eval(
    "nav[aria-label='Sections'] [aria-current='page']",
    (nodes) => nodes.map((node) => node.getAttribute("href")),
  );
  assert(
    "the rail marks Spend as the current section",
    current.length === 1 && current[0] === "/spend",
    `aria-current on ${JSON.stringify(current)}`,
  );
  const report = await rpc("listSpend", {});
  observed.report = report;

  const readPairs = () =>
    page.$$eval("tr[data-spend-pair]", (rows) =>
      rows.map((row) => ({
        repo: row.getAttribute("data-spend-repo"),
        actor: row.getAttribute("data-spend-actor"),
        sessions: Number(row.getAttribute("data-spend-count")),
        costTotal: Number(row.getAttribute("data-spend-cost")),
        text: row.innerText.replaceAll("\t", " ").trim(),
      })),
    );
  const readLines = (group) =>
    page.$$eval(`[data-spend-group='${group}'] li[data-spend-line]`, (lines) =>
      lines.map((line) => ({
        label: line.getAttribute("data-spend-line"),
        absent: line.hasAttribute("data-spend-absent"),
        sessions: Number(line.getAttribute("data-spend-count")),
        costTotal: Number(line.getAttribute("data-spend-cost")),
        text: line.innerText.replaceAll("\n", " ").trim(),
      })),
    );
  const pairs = await readPairs();
  const byRepo = await readLines("repo");
  const byActor = await readLines("actor");
  observed.page = { pairs, byRepo, byActor };
  await page.screenshot({
    path: path.join(EVIDENCE_DIR, "spend.png"),
    fullPage: true,
  });

  const label = (value, absent) => value ?? absent;
  const serverPairs = report.rows.map((row) => ({
    repo: label(row.repo, "scratch"),
    actor: label(row.actor, "unattributed"),
    sessions: row.sessions,
    costTotal: row.costTotal,
  }));
  assert(
    "the repo × actor table is listSpend's rows, in its order",
    pairs.length === serverPairs.length &&
      pairs.every(
        (row, index) =>
          row.repo === serverPairs[index]?.repo &&
          row.actor === serverPairs[index]?.actor &&
          row.sessions === serverPairs[index]?.sessions &&
          close(row.costTotal, serverPairs[index]?.costTotal),
      ),
    `page ${pairs.length} rows, server ${serverPairs.length}; first ${JSON.stringify(pairs[0] ?? null)} vs ${JSON.stringify(serverPairs[0] ?? null)}`,
  );

  // The pairs this run made: exactly its sessions, at the list's own numbers added up.
  const spentOf = (...labels) =>
    labels.reduce(
      (total, key) => total + (observed.sessions[key]?.spent ?? NaN),
      0,
    );
  const ours = [
    { repo: WEB, actor: AMY, sessions: 2, cost: spentOf("amyWeb1", "amyWeb2") },
    { repo: API, actor: AMY, sessions: 1, cost: spentOf("amyApi") },
    { repo: WEB, actor: BOB, sessions: 1, cost: spentOf("bobWeb") },
    { repo: API, actor: "cli", sessions: 1, cost: spentOf("cli") },
  ];
  for (const want of ours) {
    const row = pairs.find(
      (candidate) =>
        candidate.repo === want.repo && candidate.actor === want.actor,
    );
    assert(
      `the page shows ${want.repo} × ${want.actor} with its sessions and their cost`,
      row !== undefined &&
        row.sessions === want.sessions &&
        want.cost > 0 &&
        close(row.costTotal, want.cost) &&
        row.text.includes(formatDollars(want.cost)),
      `row ${JSON.stringify(row ?? null)}, want ${want.sessions} session(s) at ${want.cost}`,
    );
  }

  // The roll-ups are the pairs added: per repo across actors, per actor across repos.
  const line = (lines, name) => lines.find((entry) => entry.label === name);
  const webLine = line(byRepo, WEB);
  const apiLine = line(byRepo, API);
  assert(
    "By repo adds every actor's sessions on a repo",
    webLine?.sessions === 3 &&
      close(webLine?.costTotal, spentOf("amyWeb1", "amyWeb2", "bobWeb")) &&
      apiLine?.sessions === 2 &&
      close(apiLine?.costTotal, spentOf("amyApi", "cli")) &&
      (webLine?.text.includes(
        formatDollars(spentOf("amyWeb1", "amyWeb2", "bobWeb")),
      ) ??
        false),
    `${WEB} ${JSON.stringify(webLine ?? null)}; ${API} ${JSON.stringify(apiLine ?? null)}`,
  );
  const amyLine = line(byActor, AMY);
  const bobLine = line(byActor, BOB);
  assert(
    "By actor adds one actor's sessions across repos",
    amyLine?.sessions === 3 &&
      close(amyLine?.costTotal, spentOf("amyWeb1", "amyWeb2", "amyApi")) &&
      bobLine?.sessions === 1 &&
      close(bobLine?.costTotal, spentOf("bobWeb")),
    `${AMY} ${JSON.stringify(amyLine ?? null)}; ${BOB} ${JSON.stringify(bobLine ?? null)}`,
  );
  const sum = (lines) =>
    lines.reduce(
      (total, entry) => ({
        sessions: total.sessions + entry.sessions,
        costTotal: total.costTotal + entry.costTotal,
      }),
      { sessions: 0, costTotal: 0 },
    );
  assert(
    "each roll-up adds up to the report's totals",
    sum(byRepo).sessions === report.sessions &&
      close(sum(byRepo).costTotal, report.costTotal) &&
      sum(byActor).sessions === report.sessions &&
      close(sum(byActor).costTotal, report.costTotal),
    `by repo ${JSON.stringify(sum(byRepo))}, by actor ${JSON.stringify(sum(byActor))}, report ${report.sessions} / ${report.costTotal}`,
  );

  // The dashboard's button: one more session under (scratch, dashboard), and it cost something.
  const dashboardAfter = pairOf(report, undefined, "dashboard");
  const dashboardRow = pairs.find(
    (row) => row.repo === "scratch" && row.actor === "dashboard",
  );
  assert(
    "the dashboard's own session is counted under scratch × dashboard",
    dashboardAfter !== undefined &&
      dashboardAfter.sessions === dashboardBefore.sessions + 1 &&
      close(
        dashboardAfter.costTotal - dashboardBefore.costTotal,
        observed.sessions.dashboard.spent,
      ) &&
      observed.sessions.dashboard.spent > 0 &&
      dashboardRow?.sessions === dashboardAfter.sessions,
    `before ${JSON.stringify(dashboardBefore)}, after ${JSON.stringify(dashboardAfter ?? null)}, page ${JSON.stringify(dashboardRow ?? null)}, the session spent ${observed.sessions.dashboard.spent}`,
  );
  const scratchLine = line(byRepo, "scratch");
  const dashboardLine = line(byActor, "dashboard");
  assert(
    "scratch and the dashboard are named lines of their roll-ups",
    scratchLine?.absent === true &&
      dashboardLine !== undefined &&
      dashboardLine.absent === false,
    `scratch ${JSON.stringify(scratchLine ?? null)}; dashboard ${JSON.stringify(dashboardLine ?? null)}`,
  );

  const header = await page
    .locator("[data-spend-total]")
    .first()
    .evaluate((node) => ({
      total: Number(node.getAttribute("data-spend-total")),
      sessions: Number(node.getAttribute("data-spend-sessions")),
      text: node.textContent ?? "",
    }));
  observed.page.header = header;
  assert(
    "the header's total is the report's",
    close(header.total, report.costTotal) &&
      header.sessions === report.sessions &&
      header.text.includes(formatDollars(report.costTotal)),
    `header ${JSON.stringify(header)}, report ${report.costTotal} over ${report.sessions}`,
  );

  // --- the poll: a new pair arrives on the open page -------------------------------------------
  const bobApi = await run("bobApi", { repo: API, actor: BOB });
  let polled;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    polled = (await readPairs()).find(
      (row) => row.repo === API && row.actor === BOB,
    );
    if (polled !== undefined) break;
    await sleep(200);
  }
  const noReload = await page.evaluate(() => window.__spendNoReload === true);
  await page.screenshot({
    path: path.join(EVIDENCE_DIR, "spend-polled.png"),
    fullPage: true,
  });
  assert(
    "a run by a new pair appears on the open page without a reload",
    polled !== undefined &&
      polled.sessions === 1 &&
      close(polled.costTotal, observed.sessions.bobApi.spent) &&
      noReload,
    `${API} × ${BOB} (${bobApi}) row ${JSON.stringify(polled ?? null)}, no reload ${noReload}`,
  );

  assert(
    "the page logged no console error",
    consoleErrors.length === 0,
    JSON.stringify(consoleErrors.slice(0, 5)),
  );
} catch (error) {
  assert("the drive ran to the end", false, String(error));
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
