// The both-ways phase's new-card leg (LOB-275): a card created in the browser is the one the
// terminal lists, and a card created at the terminal is the one an open page shows — and the two,
// made with the same inputs, are the same card to the server.
//
//   node card-create.mjs      # started in the background by card-create.sh, which answers its signals
//
// One page, opened once and never reloaded, does the browser's half:
//
//   reach     the board header's **New card** ([data-new-card]) opens the form, and the URL says so
//             (`?new=card`), so the form is a link any page can make
//   empty     a title of spaces is refused inline ([data-card-problem=title]) and sends nothing
//   refused   a base ref no run can start from is refused by the server: the toast carries
//             `createTask`'s own message, character for character (the oracle makes the same call),
//             the form stays open and keeps what was typed
//   created   the fixed form creates the card: the page's one landed `createTask` is the dashboard's,
//             with exactly the form's inputs and no repo; the dialog closes, the card's pane opens and
//             the card is in the intake lane without a reload
//   followed  the terminal's twin (`factory board add`, same inputs) reaches the same page, in intake,
//             without a reload
//   same      the server holds the two with the same title, body, repo, priority and base ref
//   link      a fresh page opened at `?new=card` shows the form, its title focused; Escape closes it
//             and takes `new` out of the URL
//
// The halves take turns through files in SIGNAL_DIR, each written whole (a rename) before it is read:
//
//   browser-created   this page's card, `<task id>` (`none` when it made none)
//   cli-created       card-create.sh: the terminal's twin, `<task id>` (`none` when it made none)
//   browser-followed  this page showed the twin without a reload (`pass` | `fail`)
//
// Env:
//   WEB_URL, API_URL  the instance ./up.sh started (defaults :3400 / :9400)
//   BOARD_ID          the board ./up.sh seeded
//   CARD_TITLE, CARD_BODY, CARD_BASE_REF, CARD_BAD_REF   the inputs both halves type (required)
//   SIGNAL_DIR        where the halves leave their signals (required)
//   SIGNAL_TIMEOUT_MS how long to wait for card-create.sh's next signal (default 120000)
//   EVIDENCE_DIR      default .verify/evidence/latest/board
//
// Writes `card-create-web.json` (every check, what the page sent and rendered, and the server's
// reads as the oracle) and `card-create-{form,refused,created,followed,link}.png`, and exits non-zero
// when a check fails. Uses the locally installed Chrome (channel: "chrome"), as both-ways.mjs does.
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";

const WEB_URL = process.env["WEB_URL"] ?? "http://localhost:3400";
const API_URL = process.env["API_URL"] ?? "http://localhost:9400";
const BOARD_ID = process.env["BOARD_ID"] ?? "";
const TITLE = process.env["CARD_TITLE"] ?? "";
const BODY = process.env["CARD_BODY"] ?? "";
const BASE_REF = process.env["CARD_BASE_REF"] ?? "";
const BAD_REF = process.env["CARD_BAD_REF"] ?? "";
const SIGNAL_DIR = process.env["SIGNAL_DIR"] ?? "";
const SIGNAL_TIMEOUT_MS = Number(process.env["SIGNAL_TIMEOUT_MS"] ?? "120000");
const EVIDENCE_DIR =
  process.env["EVIDENCE_DIR"] ?? ".verify/evidence/latest/board";
// The board re-reads every 2 s (apps/web `BOARD_POLL`); a change made elsewhere lands within a few.
const FOLLOW_TIMEOUT_MS = 15_000;
// A cold dev server's first page load and board read take longer than a poll.
const OPEN_TIMEOUT_MS = 30_000;
// The person the dashboard acts as (apps/web `DASHBOARD_ACTOR`).
const DASHBOARD_ACTOR = "dashboard";
const RPC_TIMEOUT_MS = 10_000;
// The board's first column: the default definition's initial one (0007, LOB-267).
const INTAKE = "intake";

/** One RPC call from this process — the oracle, never the page — as its exit envelope. */
const rpcExit = async (tag, payload) => {
  const requestId = `card-create-${tag}-${Date.now()}-${Math.random()}`;
  try {
    const response = await fetch(`${API_URL}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/ndjson" },
      body: `${JSON.stringify({ _tag: "Request", id: requestId, tag, payload, headers: [] })}\n`,
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
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
  } catch (error) {
    return { _tag: "Missing", text: String(error) };
  }
};
/** The typed refusal's message, the words the page must show; `undefined` for a success. */
const failureMessage = (exit) => {
  if (exit._tag === "Success") return undefined;
  const match = /"message":"((?:[^"\\]|\\.)*)"/.exec(JSON.stringify(exit));
  return match === null ? undefined : JSON.parse(`"${match[1]}"`);
};

const signal = async (name, body) => {
  const target = path.join(SIGNAL_DIR, name);
  await writeFile(`${target}.tmp`, `${body}\n`);
  await rename(`${target}.tmp`, target);
};
const awaitSignal = async (name) => {
  const deadline = Date.now() + SIGNAL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      return (await readFile(path.join(SIGNAL_DIR, name), "utf8")).trim();
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  return null;
};

const observed = {
  webUrl: WEB_URL,
  apiUrl: API_URL,
  boardId: BOARD_ID,
  inputs: { title: TITLE, body: BODY, baseRef: BASE_REF, badRef: BAD_REF },
  checks: {},
};
const check = (name, condition, detail) => {
  observed.checks[name] = { passed: Boolean(condition), detail };
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}  ${detail}`);
};

await mkdir(EVIDENCE_DIR, { recursive: true });
await rm(path.join(EVIDENCE_DIR, "card-create-failure.png"), { force: true });

/** The lane a card's `li` sits in, and its title as rendered; `null` lane when it is not shown. */
const cardInPage = (page, id) =>
  page.evaluate((id) => {
    const card = document.querySelector(`li[data-card='${id}']`);
    return {
      lane:
        card?.closest("section[data-lane]")?.getAttribute("data-lane") ?? null,
      text: card?.textContent ?? null,
      noReload: window.__cardCreateNoReload === "kept",
    };
  }, id);
const waitForCardIn = (page, id, lane, timeout = FOLLOW_TIMEOUT_MS) =>
  page
    .waitForFunction(
      ({ id, lane }) =>
        document
          .querySelector(`li[data-card='${id}']`)
          ?.closest("section[data-lane]")
          ?.getAttribute("data-lane") === lane,
      { id, lane },
      { timeout },
    )
    .then(
      () => true,
      () => false,
    );
const searchOf = (page) => new URL(page.url()).searchParams;
const form = (page) => page.locator("form[data-card-form]");

let browser;
let page;
let browserCreated = "none";
let followedAnswered = false;
try {
  if (SIGNAL_DIR === "" || BOARD_ID === "" || TITLE === "" || BAD_REF === "")
    throw new Error(
      "SIGNAL_DIR, BOARD_ID, CARD_TITLE and CARD_BAD_REF must be set",
    );
  browser = await chromium.launch({ channel: "chrome", headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const consoleErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) =>
    consoleErrors.push(`pageerror: ${String(error)}`),
  );
  // The page's own writes, read off its requests: every card it makes must be its own `createTask`,
  // as the dashboard's person, with the form's inputs and nothing the page added.
  const createRequests = [];
  page.on("request", (request) => {
    if (!/\/rpc\/?$/.test(request.url()) || request.method() !== "POST") return;
    for (const line of (request.postData() ?? "").split("\n")) {
      try {
        const message = JSON.parse(line);
        if (message?._tag === "Request" && message.tag === "createTask")
          createRequests.push(message.payload);
      } catch {
        // not an RPC envelope line
      }
    }
  });

  // --- reach: the header's action opens the form, and the URL says so -----------------------------
  await page.goto(`${WEB_URL}/boards/${BOARD_ID}`, {
    waitUntil: "domcontentloaded",
  });
  await page
    .locator(`section[data-lane='${INTAKE}']`)
    .waitFor({ timeout: OPEN_TIMEOUT_MS });
  await page.evaluate(() => {
    window.__cardCreateNoReload = "kept";
  });
  const action = page.locator("header [data-new-card]");
  const actionHref = await action.getAttribute("href");
  await action.click({ timeout: 10_000 });
  const opened = await form(page)
    .waitFor({ timeout: 10_000 })
    .then(
      () => true,
      () => false,
    );
  check(
    "the board header's New card opens the form, at a URL any page can link to",
    opened &&
      searchOf(page).get("new") === "card" &&
      (actionHref ?? "").includes("new=card"),
    `form ${String(opened)}, href ${String(actionHref)}, url ${page.url()}`,
  );

  // --- empty: a title of spaces is refused inline, and nothing is sent -----------------------------
  await page.locator("#new-card-title").fill("   ");
  await page.locator("[data-card-submit]").click();
  const problem = page.locator("[data-card-problem='title']");
  const problemShown = await problem.waitFor({ timeout: 5_000 }).then(
    () => true,
    () => false,
  );
  const problemText = problemShown ? await problem.textContent() : null;
  const titleInvalid = await page
    .locator("#new-card-title")
    .getAttribute("aria-invalid");
  check(
    "an empty title is refused inline, on the title, and sends nothing",
    problemShown &&
      problemText === "A card needs a title." &&
      titleInvalid === "true" &&
      createRequests.length === 0,
    `problem ${JSON.stringify(problemText)}, aria-invalid ${String(titleInvalid)}, createTask requests ${createRequests.length}`,
  );

  // --- refused: the server's refusal, in its words, in a toast ------------------------------------
  await page.locator("#new-card-title").fill(TITLE);
  await page.locator("#new-card-body").fill(BODY);
  await page.locator("#new-card-priority").selectOption("urgent");
  await page.locator("#new-card-base").fill(BAD_REF);
  const problemCleared =
    (await page.locator("[data-card-problem]").count()) === 0;
  await page.screenshot({
    path: path.join(EVIDENCE_DIR, "card-create-form.png"),
    fullPage: true,
  });
  await page.locator("[data-card-submit]").click();
  const toast = page
    .locator("[data-sonner-toast]")
    .filter({ hasText: "The card was not created" });
  const toastShown = await toast
    .first()
    .waitFor({ timeout: 10_000 })
    .then(
      () => true,
      () => false,
    );
  const toastText = toastShown
    ? await toast.first().locator("[data-description]").textContent()
    : null;
  // The oracle: the same payload, from this process. It is refused too, so it writes nothing.
  const refusedPayload = createRequests[0];
  const oracle = await rpcExit("createTask", {
    boardId: BOARD_ID,
    title: TITLE,
    priority: "urgent",
    body: BODY,
    baseRef: BAD_REF,
    actor: DASHBOARD_ACTOR,
  });
  const serverWords = failureMessage(oracle);
  const kept = {
    title: await page.locator("#new-card-title").inputValue(),
    body: await page.locator("#new-card-body").inputValue(),
    priority: await page.locator("#new-card-priority").inputValue(),
    baseRef: await page.locator("#new-card-base").inputValue(),
  };
  observed.refused = {
    toast: toastText,
    server: serverWords ?? null,
    oracleExit: oracle._tag,
    sent: refusedPayload ?? null,
    kept,
  };
  await page.screenshot({
    path: path.join(EVIDENCE_DIR, "card-create-refused.png"),
    fullPage: true,
  });
  check(
    "a base ref no run can start from is the server's refusal, in its words, in a toast",
    problemCleared &&
      toastShown &&
      oracle._tag === "Failure" &&
      serverWords !== undefined &&
      serverWords.includes(BAD_REF) &&
      toastText === serverWords &&
      createRequests.length === 1 &&
      refusedPayload?.baseRef === BAD_REF,
    `toast ${JSON.stringify(toastText)}, server ${JSON.stringify(serverWords ?? null)}, requests ${createRequests.length}`,
  );
  check(
    "the refused form stays open and keeps everything typed",
    (await form(page).isVisible()) &&
      kept.title === TITLE &&
      kept.body === BODY &&
      kept.priority === "urgent" &&
      kept.baseRef === BAD_REF,
    `kept ${JSON.stringify(kept)}`,
  );

  // --- created: the fixed form makes the card, which is in intake without a reload -----------------
  await page.locator("#new-card-base").fill(BASE_REF);
  await page.locator("[data-card-submit]").click();
  const closed = await form(page)
    .waitFor({ state: "detached", timeout: 10_000 })
    .then(
      () => true,
      () => false,
    );
  await page
    .waitForFunction(() => new URL(location.href).searchParams.has("card"), {
      timeout: 10_000,
    })
    .catch(() => undefined);
  const createdId = searchOf(page).get("card") ?? "";
  const inIntake =
    createdId !== "" && (await waitForCardIn(page, createdId, INTAKE));
  const paneOpen =
    createdId !== "" &&
    (await page
      .locator(`aside[data-card-pane='${createdId}']`)
      .waitFor({ timeout: FOLLOW_TIMEOUT_MS })
      .then(
        () => true,
        () => false,
      ));
  const created = createdId === "" ? null : await cardInPage(page, createdId);
  const sent = createRequests.at(-1);
  observed.created = {
    id: createdId,
    page: created,
    sent: sent ?? null,
    url: page.url(),
  };
  await page.screenshot({
    path: path.join(EVIDENCE_DIR, "card-create-created.png"),
    fullPage: true,
  });
  check(
    "the page's createTask is the dashboard's, with the form's inputs and no repo",
    createRequests.length === 2 &&
      sent?.boardId === BOARD_ID &&
      sent?.title === TITLE &&
      sent?.body === BODY &&
      sent?.priority === "urgent" &&
      sent?.baseRef === BASE_REF &&
      sent?.actor === DASHBOARD_ACTOR &&
      !("repo" in (sent ?? {})),
    `sent ${JSON.stringify(sent ?? null)}`,
  );
  check(
    "the created card is in intake without a reload, its pane open, the form closed",
    closed &&
      inIntake &&
      paneOpen &&
      created?.noReload === true &&
      (created?.text ?? "").includes(TITLE) &&
      !searchOf(page).has("new"),
    `id ${createdId || "none"}, lane ${String(created?.lane)}, pane ${String(paneOpen)}, form closed ${String(closed)}, no reload ${String(created?.noReload)}`,
  );
  if (inIntake) browserCreated = createdId;
  await signal("browser-created", browserCreated);

  // --- followed: the terminal's twin reaches this page without a reload -----------------------------
  const twinId = await awaitSignal("cli-created");
  const followed =
    twinId !== null &&
    twinId !== "none" &&
    (await waitForCardIn(page, twinId, INTAKE));
  const twin =
    twinId === null || twinId === "none"
      ? null
      : await cardInPage(page, twinId);
  observed.followed = { id: twinId, page: twin };
  await page.screenshot({
    path: path.join(EVIDENCE_DIR, "card-create-followed.png"),
    fullPage: true,
  });
  const twinFollowed =
    followed && twin?.noReload === true && (twin?.text ?? "").includes(TITLE);
  check(
    "the terminal's card is in intake on the open page without a reload",
    twinFollowed,
    `twin ${String(twinId)}, lane ${String(twin?.lane)}, no reload ${String(twin?.noReload)}`,
  );
  await signal("browser-followed", twinFollowed ? "pass" : "fail");
  followedAnswered = true;

  // --- same: the server holds one card twice ---------------------------------------------------------
  const board = await rpcExit("getBoard", { boardId: BOARD_ID });
  const listed = await rpcExit("listTasks", { boardId: BOARD_ID });
  const cards = listed._tag === "Success" ? listed.value : [];
  const mine = cards.find((card) => card.id === createdId);
  const theirs = cards.find((card) => card.id === twinId);
  const fields = (card) =>
    card === undefined
      ? null
      : {
          title: card.title,
          body: card.body,
          repo: card.repo,
          priority: card.priority,
          baseRef: card.baseRef,
          column: card.column,
          revision: card.revision,
        };
  observed.same = {
    boardRepo: board._tag === "Success" ? board.value.instance.repo : null,
    browser: fields(mine),
    cli: fields(theirs),
  };
  check(
    "the two cards have the same title, body, repo, priority and base ref",
    mine !== undefined &&
      theirs !== undefined &&
      mine.id !== theirs.id &&
      JSON.stringify(fields(mine)) === JSON.stringify(fields(theirs)) &&
      mine.title === TITLE &&
      mine.body === BODY &&
      mine.priority === "urgent" &&
      mine.baseRef === BASE_REF &&
      mine.repo === observed.same.boardRepo,
    `browser ${JSON.stringify(fields(mine))}, cli ${JSON.stringify(fields(theirs))}, board repo ${String(observed.same.boardRepo)}`,
  );

  // --- link: the form is a URL --------------------------------------------------------------------
  const linked = await browser.newPage({
    viewport: { width: 1440, height: 900 },
  });
  await linked.goto(`${WEB_URL}/boards/${BOARD_ID}?new=card`, {
    waitUntil: "domcontentloaded",
  });
  const linkedOpen = await form(linked)
    .waitFor({ timeout: OPEN_TIMEOUT_MS })
    .then(
      () => true,
      () => false,
    );
  const focused = linkedOpen
    ? await linked
        .waitForFunction(
          () => document.activeElement?.id === "new-card-title",
          undefined,
          { timeout: 5_000 },
        )
        .then(
          () => true,
          () => false,
        )
    : false;
  await linked.screenshot({
    path: path.join(EVIDENCE_DIR, "card-create-link.png"),
    fullPage: true,
  });
  await linked.keyboard.press("Escape");
  const dismissed = await form(linked)
    .waitFor({ state: "detached", timeout: 5_000 })
    .then(
      () => true,
      () => false,
    );
  await linked
    .waitForFunction(() => !new URL(location.href).searchParams.has("new"), {
      timeout: 5_000,
    })
    .catch(() => undefined);
  check(
    "a page opened at ?new=card shows the form, title focused; Escape closes it and the URL",
    linkedOpen && focused && dismissed && !searchOf(linked).has("new"),
    `open ${String(linkedOpen)}, focused ${String(focused)}, closed ${String(dismissed)}, url ${linked.url()}`,
  );
  await linked.close();

  observed.consoleErrors = consoleErrors;
  check(
    "no console errors on the page",
    consoleErrors.length === 0,
    `${consoleErrors.length} errors`,
  );
} catch (error) {
  check("the new-card leg ran", false, String(error).slice(0, 300));
  await page
    ?.screenshot({
      path: path.join(EVIDENCE_DIR, "card-create-failure.png"),
      fullPage: true,
    })
    .catch(() => undefined);
} finally {
  await browser?.close();
  // Always answered, so card-create.sh never waits out its timeout on a page that already gave up.
  if (SIGNAL_DIR !== "") {
    await signal("browser-created", browserCreated).catch(() => undefined);
    if (!followedAnswered)
      await signal("browser-followed", "fail").catch(() => undefined);
  }
}

await writeFile(
  path.join(EVIDENCE_DIR, "card-create-web.json"),
  `${JSON.stringify(observed, null, 2)}\n`,
);
process.exit(Object.values(observed.checks).every((c) => c.passed) ? 0 : 1);
