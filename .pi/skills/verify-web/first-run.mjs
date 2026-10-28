// Drive the first-run path (C9) the way a new operator walks it, against the instance `first-run.sh`
// starts (its own API, dashboard and throwaway database: nothing in it), and capture evidence.
//
//   node first-run.mjs      (via ./first-run.sh, which owns the instance)
//
//   empty      the database holds no repository, board, card or session. `/` opens `/boards`, which
//              shows the checklist with nothing ticked, the first step next, and the steps that wait
//              on an earlier one named rather than linked
//   states     /attention, /approvals, /sandboxes, /spend and /sessions each name a press in the UI
//              (`[data-empty-action]` or the sidebar's New session), and none says to type
//              `factory board create` (or any `factory <command>`)
//   repo       the first step's link opens `/repos`; registering a throwaway checkout there ticks
//              step 1 (and only it) on `/boards`, equal to `listRepos`
//   board      the second step's link opens the New board form; creating a board on the registered
//              repository ticks step 2, and the board's own page (the only board) carries the
//              checklist with its card step now linked
//   card       the card step's link opens the New card form on that board; creating a card ticks
//              step 3, and the board's page drops the checklist (it has a card)
//   run        the run step's link opens the card; moving it out of intake, then Start run and Send, ticks step 4, and with all
//              four ticked `/boards` shows no checklist
//   routing    `/` and the logo open the only board's lanes; with two boards they open the list
//
// Every step is a press in the browser: the drive reads the RPC only as the oracle for what was
// ticked, never to make a repository, board, card or run (only the second board of the routing case
// is made over the RPC, to have several).
//
// Env: WEB_URL, API_URL, EVIDENCE_DIR.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "@playwright/test";

const WEB_URL = process.env["WEB_URL"] ?? "http://localhost:3562";
const API_URL = process.env["API_URL"] ?? "http://localhost:9562";
const EVIDENCE_DIR =
  process.env["EVIDENCE_DIR"] ?? ".verify/evidence/latest/first-run";

const TAG = randomBytes(4).toString("hex");
const REPO = `verify-first-run-${TAG}/app`;
const SECOND = `verify-first-run-${TAG}/second`;
const CARD_TITLE = `First card ${TAG}`;
const CLI_INSTRUCTION =
  /\bfactory (board|repo|run|ls|status|session|approve|reset|fork|compact|spend)\b/;

await mkdir(EVIDENCE_DIR, { recursive: true });
await rm(path.join(EVIDENCE_DIR, "first-run-failure.png"), { force: true });

const CHECKOUT = await mkdtemp(path.join(os.tmpdir(), "first-run-checkout-"));
const init = spawnSync("git", ["init", "-q", "-b", "main", CHECKOUT], {
  encoding: "utf8",
});
if (init.status !== 0) throw new Error(`git init: ${init.stderr}`);
const commit = spawnSync(
  "git",
  [
    "-C",
    CHECKOUT,
    "-c",
    "user.email=verify-first-run@localhost",
    "-c",
    "user.name=verify-first-run",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "seed",
  ],
  { encoding: "utf8" },
);
if (commit.status !== 0) throw new Error(`git commit: ${commit.stderr}`);

const observed = { webUrl: WEB_URL, apiUrl: API_URL, tag: TAG, checks: {} };
const assert = (name, condition, detail) => {
  observed.checks[name] = { passed: Boolean(condition), detail };
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}  ${detail}`);
  return Boolean(condition);
};

/** One unary RPC call over the NDJSON envelope, from this process: the oracle, never the page. */
const rpc = async (tag, payload) => {
  const requestId = `first-run-${tag}-${Date.now()}-${Math.random()}`;
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
  const exit = envelope?.exit ?? { _tag: "Missing", text: text.slice(0, 400) };
  if (exit._tag !== "Success") {
    throw new Error(`${tag} failed: ${JSON.stringify(exit).slice(0, 400)}`);
  }
  return exit.value;
};

const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const consoleErrors = [];
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});
page.on("pageerror", (error) =>
  consoleErrors.push(`pageerror: ${String(error)}`),
);

const shot = (name) =>
  page.screenshot({
    path: path.join(EVIDENCE_DIR, `first-run-${name}.png`),
    fullPage: true,
  });

/** The checklist as the page shows it: each step's id, whether it is ticked, and its press. */
const checklist = async () => {
  await page.waitForSelector("[data-getting-started]", { timeout: 20_000 });
  return await page.$$eval("[data-getting-started] li[data-step]", (nodes) =>
    nodes.map((node) => ({
      id: node.getAttribute("data-step"),
      done: node.getAttribute("data-done") === "true",
      next: node.getAttribute("data-next") === "true",
      link:
        node.querySelector("[data-first-run-action]")?.getAttribute("href") ??
        null,
      blocked:
        node.querySelector("[data-first-run-blocked]")?.textContent?.trim() ??
        null,
    })),
  );
};
const ticks = (steps) => steps.map((step) => (step.done ? "x" : "-")).join("");

/** Waits for the checklist to show exactly this ticking, reading the page again as it polls. */
const waitTicks = async (expected) => {
  await page.waitForFunction(
    (want) =>
      Array.from(
        document.querySelectorAll("[data-getting-started] li[data-step]"),
      )
        .map((node) => (node.getAttribute("data-done") === "true" ? "x" : "-"))
        .join("") === want,
    expected,
    { timeout: 20_000 },
  );
  return await checklist();
};

const pathname = () => new URL(page.url()).pathname;
const goBoards = async () => {
  await page
    .locator("nav[aria-label='Sections']")
    .getByRole("link", { name: "Boards", exact: true })
    .click();
  await page.waitForFunction(() => window.location.pathname === "/boards");
};
const bodyText = () => page.evaluate(() => document.body.innerText);

let exitCode = 0;
try {
  // --- empty -----------------------------------------------------------------------------------
  const repos0 = (await rpc("listRepos", {})).repos;
  const boards0 = await rpc("listBoards", {});
  const sessions0 = (await rpc("listSessions", { limit: 50 })).sessions;
  assert(
    "the database starts with no repository, board or session",
    repos0.length === 0 && boards0.length === 0 && sessions0.length === 0,
    `${repos0.length} repo(s), ${boards0.length} board(s), ${sessions0.length} session(s)`,
  );

  await page.goto(WEB_URL, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.location.pathname !== "/", null, {
    timeout: 20_000,
  });
  const steps0 = await checklist();
  observed.empty = { path: pathname(), steps: steps0 };
  await shot("empty");
  assert(
    "with no board, `/` opens /boards",
    pathname() === "/boards",
    pathname(),
  );
  assert(
    "the checklist lists repository, board, card, run, with nothing ticked and the first step next",
    steps0.map((step) => step.id).join(",") === "repo,board,card,run" &&
      ticks(steps0) === "----" &&
      steps0[0].next &&
      !steps0[1].next,
    JSON.stringify(steps0),
  );
  assert(
    "the first two steps link to their forms; the card and run steps name what they wait for",
    steps0[0].link === "/repos" &&
      steps0[1].link === "/boards?new=board" &&
      steps0[2].link === null &&
      steps0[2].blocked === "Once a board exists" &&
      steps0[3].link === null &&
      steps0[3].blocked === "Once a card exists",
    JSON.stringify(steps0.map(({ link, blocked }) => ({ link, blocked }))),
  );
  assert(
    "the empty boards page gives no command to type",
    !CLI_INSTRUCTION.test(await bodyText()),
    "no `factory <command>` in the page text",
  );

  // --- states ----------------------------------------------------------------------------------
  const states = {};
  for (const route of [
    "/attention",
    "/approvals",
    "/sandboxes",
    "/spend",
    "/sessions",
  ]) {
    await page.goto(`${WEB_URL}${route}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("nav[aria-label='Sections']", {
      timeout: 15_000,
    });
    // The empty pane renders after the page's own read lands; the sidebar's button is always there.
    await page
      .waitForSelector("[data-empty-action], button", { timeout: 20_000 })
      .catch(() => undefined);
    await page
      .waitForFunction(
        () =>
          document.querySelector("[data-empty-action]") !== null ||
          document.body.innerText.includes("New session"),
        null,
        { timeout: 20_000 },
      )
      .catch(() => undefined);
    states[route] = {
      actions: await page.$$eval("[data-empty-action]", (nodes) =>
        nodes.map((node) => ({
          to: node.getAttribute("data-empty-action"),
          text: node.textContent?.trim(),
        })),
      ),
      newSession:
        (await page.getByRole("button", { name: /new session/i }).count()) > 0,
      cli: CLI_INSTRUCTION.exec(await bodyText())?.[0] ?? null,
    };
  }
  observed.states = states;
  await page.goto(`${WEB_URL}/spend`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-spend-empty]", { timeout: 20_000 });
  await shot("empty-spend");
  assert(
    "attention, approvals, sandboxes and spend each name a press that leaves them",
    ["/attention", "/approvals", "/sandboxes", "/spend"].every(
      (route) => states[route].actions.length === 1,
    ),
    JSON.stringify(
      Object.fromEntries(
        Object.entries(states).map(([route, state]) => [
          route,
          state.actions.map((action) => `${action.text} -> ${action.to}`),
        ]),
      ),
    ),
  );
  assert(
    "the empty session list offers New session, and its pane a link to the boards",
    states["/sessions"].newSession && states["/sessions"].actions.length === 1,
    JSON.stringify(states["/sessions"]),
  );
  assert(
    "no empty state gives a command to type",
    Object.values(states).every((state) => state.cli === null),
    JSON.stringify(
      Object.fromEntries(Object.entries(states).map(([r, s]) => [r, s.cli])),
    ),
  );

  // --- repo ------------------------------------------------------------------------------------
  await page.goto(`${WEB_URL}/boards`, { waitUntil: "domcontentloaded" });
  await checklist();
  await page.locator("[data-first-run-action='repo']").click();
  await page.waitForFunction(() => window.location.pathname === "/repos");
  await page.locator("[data-repo-form] input[name='repo']").fill(REPO);
  await page.locator("[data-repo-form] input[name='localPath']").fill(CHECKOUT);
  await page
    .locator("[data-repo-form]")
    .getByRole("button", { name: "Add repository" })
    .click();
  await page.waitForSelector(`[data-repo-row='${REPO}']`, { timeout: 20_000 });
  await goBoards();
  const steps1 = await waitTicks("x---");
  observed.afterRepo = steps1;
  await shot("after-repo");
  const repos1 = (await rpc("listRepos", {})).repos;
  assert(
    "registering a repository from the first step ticks step 1 and only it",
    repos1.some((repo) => repo.repo === REPO) &&
      ticks(steps1) === "x---" &&
      steps1[1].next,
    `${ticks(steps1)}; listRepos holds ${repos1.map((repo) => repo.repo).join(",")}`,
  );

  // --- board -----------------------------------------------------------------------------------
  await page.locator("[data-first-run-action='board']").click();
  await page.waitForSelector("[data-board-form]", { timeout: 20_000 });
  await page.locator("select#new-board-repo").selectOption(REPO);
  await page.locator("[data-board-submit]").click();
  await page.waitForFunction(
    () => /^\/boards\/brd_[0-9a-z]{26}$/.test(window.location.pathname),
    null,
    { timeout: 20_000 },
  );
  const boardId = pathname().split("/").pop();
  const steps2 = await waitTicks("xx--");
  observed.afterBoard = { boardId, steps: steps2 };
  await shot("after-board");
  const boards2 = await rpc("listBoards", {});
  assert(
    "creating a board from the second step ticks step 2, and the board's page carries the checklist",
    boards2.length === 1 &&
      boards2[0].id === boardId &&
      ticks(steps2) === "xx--" &&
      steps2[2].link === `/boards/${boardId}?new=card` &&
      steps2[2].next &&
      steps2[3].blocked === "Once a card exists",
    `${ticks(steps2)}; ${JSON.stringify(steps2[2])}`,
  );

  // --- card ------------------------------------------------------------------------------------
  await page.locator("[data-first-run-action='card']").click();
  await page.waitForSelector("form[data-card-form]", { timeout: 20_000 });
  await page.locator("#new-card-title").fill(CARD_TITLE);
  await page.locator("[data-card-submit]").click();
  await page.waitForFunction(
    () => new URL(window.location.href).searchParams.get("card") !== null,
    null,
    { timeout: 20_000 },
  );
  const cardId = new URL(page.url()).searchParams.get("card");
  await page.waitForSelector(`li[data-card='${cardId}']`, { timeout: 20_000 });
  const tasks = await rpc("listTasks", { boardId });
  await page.waitForFunction(
    () => document.querySelector("[data-getting-started]") === null,
    null,
    { timeout: 20_000 },
  );
  await shot("after-card-board");
  assert(
    "adding a card from the third step puts it on the board, and the board's page drops the checklist",
    tasks.length === 1 && tasks[0].id === cardId,
    `${tasks.length} card(s); ${CARD_TITLE}`,
  );
  await goBoards();
  const steps3 = await waitTicks("xxx-");
  observed.afterCard = steps3;
  await shot("after-card");
  assert(
    "on /boards the card step is ticked and the run step links to the card",
    steps3[3].next && steps3[3].link === `/boards/${boardId}?card=${cardId}`,
    `${ticks(steps3)}; ${JSON.stringify(steps3[3])}`,
  );

  // --- run -------------------------------------------------------------------------------------
  await page.locator("[data-first-run-action='run']").click();
  await page.waitForSelector(`aside[data-card-pane='${cardId}']`, {
    timeout: 20_000,
  });
  // A card rests in `intake`: nothing runs there until a person moves it to a working column.
  await page
    .locator("aside[data-card-pane] [data-move-to='specifying']")
    .click();
  await page.waitForFunction(
    () =>
      document
        .querySelector("aside[data-card-pane] [data-start-run]")
        ?.getAttribute("aria-disabled") !== "true" &&
      !document
        .querySelector("aside[data-card-pane] [data-start-run]")
        ?.hasAttribute("data-disabled"),
    null,
    { timeout: 20_000 },
  );
  await page.locator("aside[data-card-pane] [data-start-run]").click();
  await page.locator("aside[data-card-pane] [data-start-send]").click();
  await page.waitForFunction(
    () => new URL(window.location.href).searchParams.get("run") !== null,
    null,
    { timeout: 20_000 },
  );
  const runs = await rpc("listTaskRuns", { taskId: cardId });
  await goBoards();
  await page.waitForSelector("ul[aria-label='Boards']", { timeout: 20_000 });
  await page.waitForFunction(
    () => document.querySelector("[data-getting-started]") === null,
    null,
    { timeout: 20_000 },
  );
  await shot("done");
  assert(
    "starting a run from the fourth step ticks it, and with all four ticked /boards shows no checklist",
    runs.length === 1 &&
      (await page.locator("[data-getting-started]").count()) === 0 &&
      (await page.locator("ul[aria-label='Boards'] li").count()) === 1,
    `${runs.length} run(s) on the card`,
  );

  // --- routing ---------------------------------------------------------------------------------
  await page.goto(WEB_URL, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.location.pathname !== "/", null, {
    timeout: 20_000,
  });
  assert(
    "with exactly one board, `/` opens its lanes",
    pathname() === `/boards/${boardId}`,
    pathname(),
  );
  await page.goto(`${WEB_URL}/spend`, { waitUntil: "domcontentloaded" });
  await page.getByRole("link", { name: "factory" }).click();
  await page.waitForFunction(
    (id) => window.location.pathname === `/boards/${id}`,
    boardId,
    { timeout: 20_000 },
  );
  assert(
    "with exactly one board, the logo opens its lanes",
    pathname() === `/boards/${boardId}`,
    pathname(),
  );

  await rpc("createBoard", { repo: SECOND, definitionId: "default" });
  await page.goto(WEB_URL, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.location.pathname !== "/", null, {
    timeout: 20_000,
  });
  const severalRoot = pathname();
  await page.goto(`${WEB_URL}/spend`, { waitUntil: "domcontentloaded" });
  await page.getByRole("link", { name: "factory" }).click();
  await page.waitForFunction(
    () => window.location.pathname === "/boards",
    null,
    {
      timeout: 20_000,
    },
  );
  await page.waitForSelector("ul[aria-label='Boards']", { timeout: 20_000 });
  await shot("several");
  assert(
    "with several boards, `/` and the logo open the list",
    severalRoot === "/boards" &&
      pathname() === "/boards" &&
      (await page.locator("ul[aria-label='Boards'] li").count()) === 2,
    `root -> ${severalRoot}`,
  );

  assert(
    "the pages logged no console error",
    consoleErrors.length === 0,
    JSON.stringify(consoleErrors.slice(0, 5)),
  );
} catch (error) {
  assert("the drive ran to the end", false, String(error));
  await shot("failure").catch(() => {});
} finally {
  observed.consoleErrors = consoleErrors;
  await writeFile(
    path.join(EVIDENCE_DIR, "observed.json"),
    `${JSON.stringify(observed, null, 2)}\n`,
  );
  await browser.close();
  await rm(CHECKOUT, { recursive: true, force: true });
  exitCode = Object.values(observed.checks).every((check) => check.passed)
    ? 0
    : 1;
}
process.exit(exitCode);
