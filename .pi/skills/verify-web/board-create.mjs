// Drive the "New board" form (C5) the way an operator uses it on an empty control plane, against the
// instance `board-create.sh` starts (its own API, dashboard and throwaway database), and capture
// evidence.
//
//   node board-create.mjs      (via ./board-create.sh, which owns the instance)
//
//   empty     /boards on a database with no board says so and offers **New board** ([data-new-board]);
//             `listBoards` agrees it is empty
//   reach     the empty state's action opens the form, and the URL says so (`?new=board`)
//   pickers   the definition select lists exactly `listDefinitions`' ids, defaulting to `default`; the
//             version select leads with "Newest (vN …)" for the newest version `listDefinitions`
//             reports, then every version newest first. With no repository registered the repository
//             is a slug to type
//   refused   a slug outside owner/name is stopped in the form (`[data-board-problem=repo]`): no
//             `createBoard` leaves the page and `listBoards` is still empty
//   created   a typed slug on the newest version creates the board: the page lands on `/boards/brd_…`,
//             its lanes are the definition's columns in order, the board pins the newest version
//             (`getBoard`), `listBoards` and `factory board list` both hold it, and the checkout
//             warning is on its page (the repository has no checkout)
//   exists    the same repository again is `BoardExists`, in the server's words, with a link to the
//             existing board; nothing is written (`listBoards` unchanged) and the link opens it
//   picker    a registered repository is offered in the repository select, and a board made on it
//             with version 1 pins version 1
//   missing   `DefinitionNotFound` is shown verbatim: the page's own `createBoard` is rewritten in
//             flight to name a definition that does not exist (the form's pickers never offer one),
//             and the text shown is the server's message for the same call; nothing is written
//   cancel    Cancel closes the form and takes `new` out of the URL
//
// Env: WEB_URL, API_URL, EVIDENCE_DIR.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const WEB_URL = process.env["WEB_URL"] ?? "http://localhost:3561";
const API_URL = process.env["API_URL"] ?? "http://localhost:9561";
const EVIDENCE_DIR =
  process.env["EVIDENCE_DIR"] ?? ".verify/evidence/latest/board-create";

const TAG = randomBytes(4).toString("hex");
const TYPED = `verify-board-create-${TAG}/typed`;
const REGISTERED = `verify-board-create-${TAG}/registered`;
const MISSING = `verify-board-create-${TAG}/missing`;
const NO_SUCH = `nosuch${TAG}`;

await mkdir(EVIDENCE_DIR, { recursive: true });
await rm(path.join(EVIDENCE_DIR, "board-create-failure.png"), { force: true });

const observed = { webUrl: WEB_URL, apiUrl: API_URL, tag: TAG, checks: {} };
const assert = (name, condition, detail) => {
  observed.checks[name] = { passed: Boolean(condition), detail };
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}  ${detail}`);
  return Boolean(condition);
};

/** One unary RPC call over the NDJSON envelope, from this process: the oracle, never the page. */
const rpcExit = async (tag, payload) => {
  const requestId = `board-create-${tag}-${Date.now()}-${Math.random()}`;
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
  return envelope?.exit ?? { _tag: "Missing", text: text.slice(0, 400) };
};
const rpc = async (tag, payload) => {
  const exit = await rpcExit(tag, payload);
  if (exit._tag !== "Success") {
    throw new Error(`${tag} failed: ${JSON.stringify(exit).slice(0, 400)}`);
  }
  return exit.value;
};
/** The typed error of a failed call: the server's own words, as the page is expected to show them. */
const rpcFailure = async (tag, payload) => {
  const exit = await rpcExit(tag, payload);
  const failure = JSON.stringify(exit);
  const message = /"message":"((?:[^"\\]|\\.)*)"/.exec(failure)?.[1];
  return {
    exit,
    message: message === undefined ? undefined : JSON.parse(`"${message}"`),
  };
};
const boardsOf = async () => await rpc("listBoards", {});
const factory = (...args) =>
  spawnSync(
    "bun",
    [
      "run",
      path.join(ROOT, "apps/cli/src/index.ts"),
      ...args,
      "--api",
      API_URL,
    ],
    { encoding: "utf8", timeout: 60_000 },
  );

const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const consoleErrors = [];
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});
page.on("pageerror", (error) =>
  consoleErrors.push(`pageerror: ${String(error)}`),
);
const sentTags = [];
page.on("request", (request) => {
  if (!/\/rpc\/?$/.test(request.url()) || request.method() !== "POST") return;
  for (const line of (request.postData() ?? "").split("\n")) {
    try {
      const message = JSON.parse(line);
      if (message?._tag === "Request") sentTags.push(message.tag);
    } catch {
      // Not an envelope line.
    }
  }
});
const created = () => sentTags.filter((tag) => tag === "createBoard").length;

const openForm = async () => {
  await page.locator("[data-new-board]").first().click();
  await page.waitForSelector("[data-board-form]", { timeout: 20_000 });
};
const submit = () => page.locator("[data-board-submit]").click();
const landed = () =>
  page.waitForFunction(
    () => /^\/boards\/brd_[0-9a-z]{26}$/.test(window.location.pathname),
    null,
    { timeout: 20_000 },
  );

let exitCode = 0;
try {
  const definitions = await rpc("listDefinitions", {});
  const defaultDefinition = definitions.find(
    (definition) => definition.id === "default",
  );
  const expectedVersions = defaultDefinition.versions
    .map((entry) => entry.version)
    .sort((a, b) => b - a);
  const newest = expectedVersions[0];
  observed.definitions = definitions;

  // --- empty -----------------------------------------------------------------------------------
  assert(
    "the database starts with no board",
    (await boardsOf()).length === 0,
    "listBoards is empty",
  );
  await page.goto(`${WEB_URL}/boards`, { waitUntil: "domcontentloaded" });
  await page.getByText("No boards yet").waitFor({ timeout: 20_000 });
  const emptyAction = await page.locator("[data-new-board]").count();
  await page.screenshot({
    path: path.join(EVIDENCE_DIR, "board-create-empty.png"),
  });
  assert(
    "the empty state offers New board",
    emptyAction === 1,
    `${emptyAction} [data-new-board] link(s)`,
  );

  // --- reach -----------------------------------------------------------------------------------
  await openForm();
  const opened = new URL(page.url());
  assert(
    "New board opens the form and the URL says so",
    opened.pathname === "/boards" && opened.searchParams.get("new") === "board",
    page.url(),
  );

  // --- pickers ---------------------------------------------------------------------------------
  const pickers = await page.evaluate(() => ({
    definitionOptions: Array.from(
      document.querySelectorAll("#new-board-definition option"),
    ).map((option) => option.getAttribute("value")),
    definitionValue: document.querySelector("#new-board-definition")?.value,
    versionLabels: Array.from(
      document.querySelectorAll("#new-board-version option"),
    ).map((option) => option.textContent),
    versionValue: document.querySelector("#new-board-version")?.value,
    repoIsInput: document.querySelector("input#new-board-repo") !== null,
  }));
  observed.pickers = pickers;
  await page.screenshot({
    path: path.join(EVIDENCE_DIR, "board-create-form.png"),
  });
  assert(
    "the definition picker lists listDefinitions' ids and defaults to default",
    JSON.stringify(pickers.definitionOptions) ===
      JSON.stringify(definitions.map((definition) => definition.id)) &&
      pickers.definitionValue === "default",
    JSON.stringify(pickers),
  );
  assert(
    "the version picker leads with the newest, then every version newest first",
    pickers.versionValue === "" &&
      pickers.versionLabels[0]?.startsWith(`Newest (v${newest}`) &&
      JSON.stringify(
        pickers.versionLabels
          .slice(1)
          .map((label) => /^v(\d+)/.exec(label)?.[1]),
      ) === JSON.stringify(expectedVersions.map(String)),
    JSON.stringify(pickers.versionLabels),
  );
  assert(
    "with no repository registered the repository is a slug to type",
    pickers.repoIsInput,
    JSON.stringify({ repoIsInput: pickers.repoIsInput }),
  );

  // --- refused: a slug outside owner/name never leaves the page --------------------------------
  const before = created();
  await page.locator("#new-board-repo").fill("Not A Repo");
  await submit();
  const problem = await page
    .locator("[data-board-problem='repo']")
    .textContent({ timeout: 10_000 });
  assert(
    "a slug outside owner/name is refused in the form and sends nothing",
    (problem ?? "").includes('"Not A Repo"') &&
      created() === before &&
      (await boardsOf()).length === 0,
    `${problem ?? "none"} (createBoard sent ${created() - before}x)`,
  );

  // --- created ---------------------------------------------------------------------------------
  await page.locator("#new-board-repo").fill(TYPED);
  await submit();
  await landed();
  const boardId = new URL(page.url()).pathname.split("/").pop();
  await page.waitForSelector("section[data-lane]", { timeout: 20_000 });
  const lanes = await page.$$eval("section[data-lane]", (nodes) =>
    nodes.map((node) => node.getAttribute("data-lane")),
  );
  const view = await rpc("getBoard", { boardId });
  const boards = await boardsOf();
  observed.created = { boardId, lanes, instance: view.instance, boards };
  await page.waitForSelector("[data-checkout-warning]", { timeout: 20_000 });
  await page.screenshot({
    path: path.join(EVIDENCE_DIR, "board-create-created.png"),
  });
  assert(
    "submitting creates the board and lands on its lanes",
    view.instance.repo === TYPED &&
      boards.length === 1 &&
      boards[0].id === boardId &&
      lanes.length > 0 &&
      JSON.stringify(lanes) ===
        JSON.stringify(view.definition.columns.map((column) => column.name)),
    JSON.stringify({ boardId, lanes, repo: view.instance.repo }),
  );
  assert(
    "the board pins the definition's newest version",
    view.instance.definitionId === "default" &&
      view.instance.definitionVersion === newest,
    `pinned v${view.instance.definitionVersion}, newest v${newest}`,
  );
  const cli = factory("board", "list");
  observed.cli = { status: cli.status, stdout: cli.stdout.slice(0, 500) };
  const cliLine = cli.stdout
    .split("\n")
    .find((line) => line.startsWith(boardId));
  assert(
    "a board made in the browser is the one `factory board list` prints",
    cli.status === 0 &&
      cliLine !== undefined &&
      cliLine.includes(TYPED) &&
      cliLine.includes(`default v${newest}`),
    cliLine ?? `exit ${cli.status}: ${cli.stderr.slice(0, 200)}`,
  );

  // --- exists ----------------------------------------------------------------------------------
  // Opened from the list's header action, the one a person with boards sees (the empty state's
  // action is gone once a board exists): the list now holds the board just made.
  await page.goto(`${WEB_URL}/boards`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-new-board='header']", { timeout: 20_000 });
  assert(
    "with a board made, the header's New board action is the one shown, and the empty state's is not",
    (await page.locator("[data-new-board='empty']").count()) === 0 &&
      (await page.locator("[data-new-board='header']").count()) === 1,
    `${await page.locator("[data-new-board]").count()} [data-new-board] link(s)`,
  );
  await page.locator("[data-new-board='header']").click();
  await page.waitForSelector("[data-board-form]", { timeout: 20_000 });
  assert(
    "the header's action opens the form and the URL says so",
    new URL(page.url()).searchParams.get("new") === "board",
    page.url(),
  );
  await page.locator("#new-board-repo").fill(TYPED);
  const beforeDup = created();
  await submit();
  const refusal = page.locator("[data-board-refusal='BoardExists']");
  await refusal.waitFor({ timeout: 15_000 });
  const shown = await refusal.innerText();
  const server = await rpcFailure("createBoard", {
    repo: TYPED,
    definitionId: "default",
  });
  const link = page.locator(`[data-board-existing='${boardId}']`);
  await page.screenshot({
    path: path.join(EVIDENCE_DIR, "board-create-exists.png"),
  });
  assert(
    "a second create for the repository shows BoardExists in the server's words",
    created() === beforeDup + 1 &&
      server.message !== undefined &&
      shown.includes(server.message) &&
      server.message.includes(boardId),
    `shown=${JSON.stringify(shown)} server=${JSON.stringify(server.message ?? null)}`,
  );
  assert(
    "BoardExists wrote nothing",
    (await boardsOf()).length === 1,
    `${(await boardsOf()).length} board(s)`,
  );
  const linkCount = await link.count();
  if (linkCount === 1) await link.click();
  const opensExisting = await page
    .waitForFunction(
      (id) => window.location.pathname === `/boards/${id}`,
      boardId,
      { timeout: 10_000 },
    )
    .then(
      () => true,
      () => false,
    );
  assert(
    "BoardExists links to the existing board and the link opens it",
    linkCount === 1 && opensExisting,
    page.url(),
  );

  // --- picker: a registered repository, pinned to version 1 ------------------------------------
  await rpc("registerRepo", { repo: REGISTERED });
  await page.goto(`${WEB_URL}/boards?new=board`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForSelector("[data-board-form]", { timeout: 20_000 });
  const repoSelect = await page.evaluate(() => ({
    options: Array.from(
      document.querySelectorAll("select#new-board-repo option"),
    ).map((option) => option.getAttribute("value")),
    value: document.querySelector("select#new-board-repo")?.value,
  }));
  observed.repoSelect = repoSelect;
  assert(
    "the repository picker offers the registered repositories, then Another",
    repoSelect.options.includes(REGISTERED) &&
      repoSelect.options.at(-1) === "" &&
      repoSelect.options.length ===
        (await rpc("listRepos", {})).repos.length + 1,
    JSON.stringify(repoSelect),
  );
  await page.locator("select#new-board-repo").selectOption(REGISTERED);
  await page.locator("#new-board-version").selectOption("1");
  await submit();
  await landed();
  const pinnedId = new URL(page.url()).pathname.split("/").pop();
  const pinned = await rpc("getBoard", { boardId: pinnedId });
  assert(
    "a registered repository and version 1 make a board pinned to version 1",
    pinned.instance.repo === REGISTERED &&
      pinned.instance.definitionVersion === 1,
    JSON.stringify(pinned.instance),
  );

  // --- missing: DefinitionNotFound, verbatim ---------------------------------------------------
  await page.goto(`${WEB_URL}/boards?new=board`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForSelector("[data-board-form]", { timeout: 20_000 });
  await page.route(/\/rpc\/?$/, async (route) => {
    const body = route.request().postData() ?? "";
    if (!body.includes('"createBoard"')) return route.continue();
    const rewritten = body
      .split("\n")
      .map((line) => {
        try {
          const message = JSON.parse(line);
          if (message?._tag === "Request" && message.tag === "createBoard") {
            message.payload.definitionId = NO_SUCH;
            return JSON.stringify(message);
          }
        } catch {
          // Not an envelope line.
        }
        return line;
      })
      .join("\n");
    return route.continue({ postData: rewritten });
  });
  await page.locator("select#new-board-repo").selectOption("");
  await page.locator("#new-board-repo-text").fill(MISSING);
  await submit();
  const missing = page.locator("[data-board-refusal='DefinitionNotFound']");
  await missing.waitFor({ timeout: 15_000 });
  const missingShown = await missing.innerText();
  await page.unroute(/\/rpc\/?$/);
  const missingServer = await rpcFailure("createBoard", {
    repo: MISSING,
    definitionId: NO_SUCH,
  });
  await page.screenshot({
    path: path.join(EVIDENCE_DIR, "board-create-definition-missing.png"),
  });
  assert(
    "DefinitionNotFound is shown verbatim",
    missingServer.message !== undefined &&
      missingServer.message.includes(NO_SUCH) &&
      missingShown === missingServer.message,
    `shown=${JSON.stringify(missingShown)} server=${JSON.stringify(missingServer.message ?? null)}`,
  );
  assert(
    "DefinitionNotFound wrote nothing and kept the form",
    !(await boardsOf()).some((board) => board.repo === MISSING) &&
      (await page.locator("[data-board-form]").count()) === 1 &&
      (await page.locator("#new-board-repo-text").inputValue()) === MISSING,
    `${(await boardsOf()).length} board(s)`,
  );

  // --- cancel ----------------------------------------------------------------------------------
  await page.getByRole("button", { name: "Cancel" }).click();
  await page.waitForFunction(
    () => !window.location.search.includes("new="),
    null,
    { timeout: 10_000 },
  );
  const closed = await page
    .locator("[data-new-board-dialog]")
    .waitFor({ state: "detached", timeout: 5_000 })
    .then(
      () => true,
      () => false,
    );
  assert(
    "Cancel closes the form and takes `new` out of the URL",
    closed && new URL(page.url()).pathname === "/boards",
    page.url(),
  );
  const rows = await page.locator("ul[aria-label='Boards'] li").count();
  assert(
    "the list holds exactly the two boards the drive made",
    rows === 2 && (await boardsOf()).length === 2,
    `${rows} row(s) and ${(await boardsOf()).length} board(s)`,
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
      path: path.join(EVIDENCE_DIR, "board-create-failure.png"),
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
