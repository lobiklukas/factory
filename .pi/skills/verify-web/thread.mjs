// Drive the card pane's thread (LOB-239) the way a person answers a parked card, against the
// instance `thread.sh` starts (its faux run asks `FAUX_ASK`), and capture evidence.
//
//   node thread.mjs      (via ./thread.sh, which owns the instance this drives)
//
// The story, in the order a person meets it:
//
//   seed      a board and a card of this run's own, moved `intake → specifying` through the API as a
//             person — the specifier's column, where a run asks rather than builds
//   empty     the card pane's Thread section says the card has no comment, and its composer is a
//             note's (**Comment**), since nothing is blocked
//   parked    **Start run** then **Send** in the pane (the first message is the card's default prompt): the faux run
//             reads, then asks, and ends parked. The pane — without a reload — shows the card blocked
//             `needs_input`, the question in its thread verbatim with kind, actor (the run's session
//             id) and time, and the composer turned into **Answer**
//   attention the attention view's question row links `?card=<id>#thread`; a click opens the card
//             with the thread in view and the composer focused
//   stale     with the page's board and thread reads held at the network, the run adds a note
//             (revision +1, still blocked); the answer typed and sent from the stale pane is refused
//             `StaleRevision`; the text stays in the composer; once the reads land the pane is at the
//             server's revision and shows the note, the draft still there
//   answer    the second send lands: the pane says the block was lifted, the card's blocked marker
//             goes, and the thread ends with the answer (kind answer, actor `dashboard`), its
//             whitespace kept; the page sent exactly two `commentTask`s
//   show      `factory board show` prints the card unblocked and the answer in its thread
//   told      **Start run** again and a message: `../verify-board/ask.ts MODE=told` reads the run's
//             committed prompt from Postgres and finds the answer verbatim after the question, and
//             the run did not ask again
//
// Env: WEB_URL, API_URL, EVIDENCE_DIR, FAUX_ASK, DATABASE_URL (inherited by the CLI and ask.ts).
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const WEB_URL = process.env["WEB_URL"] ?? "http://localhost:3431";
const API_URL = process.env["API_URL"] ?? "http://localhost:9431";
const EVIDENCE_DIR =
  process.env["EVIDENCE_DIR"] ?? ".verify/evidence/latest/thread";
const QUESTION =
  process.env["FAUX_ASK"] ?? "Which Postgres major does this card target?";
const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
// Two lines, the second indented, and an em dash: an answer trimmed, wrapped, collapsed or
// re-encoded anywhere between the composer and the next run's prompt is not found verbatim. The same
// bytes verify-board's drive types into the terminal.
const ANSWER = "Postgres 16.\n  Keep port 5442 — it is shared.";
const PERSON = "person:verify-web-thread";

const TAG = randomBytes(4).toString("hex");
await mkdir(EVIDENCE_DIR, { recursive: true });

const observed = {
  webUrl: WEB_URL,
  apiUrl: API_URL,
  tag: TAG,
  question: QUESTION,
  answer: ANSWER,
  facts: {},
  checks: {},
};
const assert = (name, condition, detail) => {
  observed.checks[name] = { passed: Boolean(condition), detail };
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}  ${detail}`);
  return Boolean(condition);
};

/** One unary RPC call over the NDJSON envelope, from this process: the oracle, never the page. */
const rpc = async (tag, payload) => {
  const requestId = `thread-${tag}-${Date.now()}-${Math.random()}`;
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
    exit: envelope?.exit?._tag ?? null,
    value: envelope?.exit?.value ?? null,
    cause: envelope?.exit?.cause ?? null,
  };
};
const must = async (tag, payload) => {
  const out = await rpc(tag, payload);
  if (out.exit !== "Success") {
    throw new Error(`${tag} failed: ${JSON.stringify(out.cause)}`);
  }
  return out.value;
};

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
    stdout: run.stdout ?? "",
    stderr: (run.stderr ?? "").trim().slice(0, 600),
  };
};

/** The card pane's thread as the page shows it: what a person reads, and what the composer holds. */
const readThread = (target) =>
  target.evaluate(() => {
    const pane = document.querySelector("aside[data-card-pane]");
    if (pane === null) return null;
    const section = pane.querySelector("section[data-thread]");
    const form = section?.querySelector("form[data-thread-intent]") ?? null;
    const composer = section?.querySelector("[data-thread-composer]") ?? null;
    const send = section?.querySelector("[data-thread-send]") ?? null;
    const refusal = section?.querySelector("[data-comment-refusal]") ?? null;
    const lifted = section?.querySelector("[data-thread-lifted]") ?? null;
    return {
      card: pane.getAttribute("data-card-pane"),
      revision: Number(pane.getAttribute("data-card-pane-revision")),
      blocked: pane.getAttribute("data-card-pane-blocked"),
      headerText: (pane.querySelector("header")?.textContent ?? "")
        .replace(/\s+/g, " ")
        .trim(),
      sectionId: section?.id ?? null,
      empty: section?.querySelector("[data-thread-empty]") !== null,
      comments: Array.from(
        section?.querySelectorAll("li[data-comment-kind]") ?? [],
      ).map((row) => {
        const body = row.querySelector("[data-comment-body]");
        return {
          kind: row.getAttribute("data-comment-kind"),
          label: (
            row.querySelector("[data-comment-kind-label]")?.textContent ?? ""
          ).trim(),
          actor: row.getAttribute("data-comment-actor"),
          by: (
            row.querySelector("[data-comment-by]")?.textContent ?? ""
          ).trim(),
          revision: Number(row.getAttribute("data-comment-revision")),
          at: row
            .querySelector("time[data-comment-at]")
            ?.getAttribute("datetime"),
          atText: (
            row.querySelector("time[data-comment-at]")?.textContent ?? ""
          ).trim(),
          body: body?.textContent ?? null,
          whiteSpace: body === null ? null : getComputedStyle(body).whiteSpace,
          rendered: body instanceof HTMLElement ? body.innerText : null,
        };
      }),
      intent: form?.getAttribute("data-thread-intent") ?? null,
      draft: composer instanceof HTMLTextAreaElement ? composer.value : null,
      focused:
        composer !== null && document.activeElement === composer
          ? "composer"
          : (document.activeElement?.tagName ?? null),
      sendText: (send?.textContent ?? "").trim(),
      sendDisabled: send?.hasAttribute("disabled") ?? null,
      refusal:
        refusal === null
          ? null
          : {
              tag: refusal.getAttribute("data-comment-refusal"),
              text: (refusal.textContent ?? "").replace(/\s+/g, " ").trim(),
            },
      lifted:
        lifted === null
          ? null
          : {
              reason: lifted.getAttribute("data-thread-lifted"),
              text: (lifted.textContent ?? "").replace(/\s+/g, " ").trim(),
            },
      runs: Array.from(pane.querySelectorAll("li[data-run]")).map((row) =>
        row.getAttribute("data-run"),
      ),
    };
  });

const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const consoleErrors = [];
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});
page.on("pageerror", (error) =>
  consoleErrors.push(`pageerror: ${String(error)}`),
);
// Every `commentTask` the page sends, with the revision it expected: the page's writes are the claim.
const pageComments = [];
const pageTags = new Set();
// When the page issued each card read and each comment, so a re-read the refusal asked for can be told
// apart from the board's poll (`BOARD_POLL`, 2 s): the refusal's lands within milliseconds of it.
const READ_TAGS = ["getBoard", "listTaskComments"];
const POLL_MS = 2_000;
const pageReads = [];
page.on("request", (request) => {
  if (!/\/rpc\/?$/.test(request.url())) return;
  const body = request.postData() ?? "";
  for (const line of body.split("\n")) {
    try {
      const message = JSON.parse(line);
      if (typeof message?.tag === "string") {
        pageTags.add(message.tag);
        if ([...READ_TAGS, "commentTask"].includes(message.tag)) {
          pageReads.push({ tag: message.tag, at: Date.now() });
        }
      }
      if (message?.tag === "commentTask") pageComments.push(message.payload);
    } catch {
      // Not an envelope line.
    }
  }
});

const waitFor = (predicate, arg, timeout) =>
  page.waitForFunction(predicate, arg, { timeout, polling: 100 }).then(
    () => true,
    () => false,
  );
/** Polls `check` (sync or async) every 100 ms until it holds or `ms` pass. */
const until = async (check, ms) => {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value || Date.now() >= deadline) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};
const lastRead = (tag) => pageReads.findLast((read) => read.tag === tag);
const shot = (name) =>
  page.screenshot({ path: path.join(EVIDENCE_DIR, `${name}.png`) });

/**
 * **Start run** in the pane, then **Send**: the first message is the card's default prompt (C6), so
 * the run's first turn is the one that asks — nothing is typed into the run's composer.
 */
const startRun = async (previous) => {
  await page.locator("aside[data-card-pane] [data-start-run]").click();
  // Start run opens the prompt field (C6); Send opens the run and sends its text.
  await page.locator("aside[data-card-pane] [data-start-send]").click();
  const started = await waitFor(
    (before) => {
      const run = new URLSearchParams(window.location.search).get("run");
      return run !== null && run !== before;
    },
    previous ?? null,
    20_000,
  );
  const run = new URL(page.url()).searchParams.get("run");
  return { started, run };
};

// --- seed -----------------------------------------------------------------------------------------
const board = await must("createBoard", {
  repo: `verify-thread-${TAG}/app`,
  definitionId: "default",
});
const created = await must("createTask", {
  boardId: board.id,
  title: `thread: a run asks (${TAG})`,
  actor: PERSON,
});
const specifying = await must("moveTask", {
  taskId: created.id,
  expectedRevision: created.revision,
  to: "specifying",
  actor: PERSON,
});
const CARD = created.id;
const BOARD = board.id;
observed.facts.seed = {
  board: BOARD,
  card: CARD,
  column: specifying.column,
  revision: specifying.revision,
};

// --- empty ----------------------------------------------------------------------------------------
await page.goto(`${WEB_URL}/boards/${BOARD}?card=${CARD}`, {
  waitUntil: "domcontentloaded",
});
await waitFor(
  () => document.querySelector("section[data-thread] [data-thread-empty]"),
  null,
  20_000,
);
const empty = await readThread(page);
observed.facts.empty = empty;
assert(
  "a card with no comment says so, and its composer adds a note",
  empty?.card === CARD &&
    empty.empty &&
    empty.comments.length === 0 &&
    empty.intent === "note" &&
    empty.sendText === "Comment" &&
    empty.sendDisabled === true &&
    empty.blocked === null,
  `card ${String(empty?.card)}; empty ${String(empty?.empty)}; intent ${String(empty?.intent)}; send ${JSON.stringify(empty?.sendText)} disabled ${String(empty?.sendDisabled)}`,
);

// --- parked ---------------------------------------------------------------------------------------
await page.evaluate(() => {
  window.__threadNoReload = "parked";
});
const first = await startRun(null);
const parkedShown = await waitFor(
  (card) =>
    document
      .querySelector(`aside[data-card-pane='${card}']`)
      ?.getAttribute("data-card-pane-blocked") === "needs_input" &&
    document.querySelector(
      "section[data-thread] li[data-comment-kind='question']",
    ) !== null &&
    document
      .querySelector("section[data-thread] form[data-thread-intent]")
      ?.getAttribute("data-thread-intent") === "answer",
  CARD,
  60_000,
);
const parked = await readThread(page);
const parkedTask = await rpc("getTask", { taskId: CARD });
const parkedThread = await rpc("listTaskComments", { taskId: CARD });
// The question and the block are written inside the ask tool, before the turn ends: the session goes
// idle a moment after the pane shows them, so it is polled (as verify-board's ask.ts does), not read once.
const parkedSession = await until(async () => {
  const read = await rpc("getSession", { sessionId: first.run });
  return read.value?.live?.busy === false ? read : null;
}, 5_000).then((idle) => idle ?? rpc("getSession", { sessionId: first.run }));
const keptParked = await page.evaluate(
  () => window.__threadNoReload === "parked",
);
observed.facts.parked = {
  run: first.run,
  view: parked,
  server: parkedThread.value,
  blocked: parkedTask.value?.blocked ?? null,
  busy: parkedSession.value?.live?.busy ?? null,
};
await shot("thread-question");
const question = parked?.comments[0];
assert(
  "the run started from the pane asks, and the card is parked on its question",
  first.started &&
    parkedTask.value?.blocked?.reason === "needs_input" &&
    parkedTask.value?.blocked?.column === "specifying" &&
    parkedSession.value?.live?.busy === false &&
    (parkedThread.value ?? []).length === 1 &&
    parkedThread.value?.[0]?.kind === "question" &&
    parkedThread.value?.[0]?.actor === first.run,
  `run ${String(first.run)}; blocked ${JSON.stringify(parkedTask.value?.blocked ?? null)}; busy ${String(parkedSession.value?.live?.busy)}; thread ${JSON.stringify((parkedThread.value ?? []).map((c) => [c.kind, c.actor]))}`,
);
assert(
  "the pane shows the question verbatim, with its kind, the run as actor, and its time, without a reload",
  parkedShown &&
    keptParked &&
    parked?.comments.length === 1 &&
    question?.kind === "question" &&
    question.label === "Question" &&
    question.actor === first.run &&
    question.by === first.run &&
    question.body === QUESTION &&
    question.at === parkedThread.value?.[0]?.createdAt &&
    question.atText ===
      String(parkedThread.value?.[0]?.createdAt ?? "")
        .slice(0, 19)
        .replace("T", " "),
  `shown ${parkedShown}; no reload ${keptParked}; comment ${JSON.stringify(question ?? null)}`,
);
assert(
  "a parked card's composer answers, and the pane marks the card blocked",
  parked?.intent === "answer" &&
    parked.sendText === "Answer" &&
    parked.blocked === "needs_input" &&
    parked.headerText.includes("needs input"),
  `intent ${String(parked?.intent)}; send ${JSON.stringify(parked?.sendText)}; blocked ${String(parked?.blocked)}`,
);

// --- attention ------------------------------------------------------------------------------------
await page.goto(`${WEB_URL}/attention?board=${BOARD}`, {
  waitUntil: "domcontentloaded",
});
const rowShown = await waitFor(
  (card) =>
    document.querySelector(
      `li[data-attention='${card}'][data-attention-reason='question'] a`,
    ) !== null,
  CARD,
  20_000,
);
const rowHref = rowShown
  ? await page
      .locator(
        `li[data-attention='${CARD}'][data-attention-reason='question'] a`,
      )
      .getAttribute("href")
  : null;
let landed = false;
if (rowShown) {
  await page
    .locator(`li[data-attention='${CARD}'][data-attention-reason='question'] a`)
    .click();
  landed = await waitFor(
    () =>
      document.querySelector("section[data-thread] li[data-comment-kind]") !==
        null &&
      document.activeElement?.hasAttribute("data-thread-composer") === true,
    null,
    20_000,
  );
}
const atThread = await readThread(page);
const landedUrl = new URL(page.url());
const inView = await page.evaluate(() => {
  const section = document.querySelector("section[data-thread]");
  if (section === null) return false;
  const box = section.getBoundingClientRect();
  return box.top >= 0 && box.top < window.innerHeight;
});
observed.facts.attention = {
  href: rowHref,
  url: `${landedUrl.pathname}${landedUrl.search}${landedUrl.hash}`,
  focused: atThread?.focused ?? null,
  inView,
};
await shot("thread-from-attention");
assert(
  "the attention view's question row links straight to the card's thread, composer focused",
  rowHref === `/boards/${BOARD}?card=${CARD}#thread` &&
    landed &&
    landedUrl.pathname === `/boards/${BOARD}` &&
    landedUrl.searchParams.get("card") === CARD &&
    landedUrl.hash === "#thread" &&
    atThread?.sectionId === "thread" &&
    atThread.focused === "composer" &&
    inView,
  `href ${String(rowHref)}; landed ${landed} at ${observed.facts.attention.url}; focus ${String(atThread?.focused)}; in view ${inView}`,
);

// --- stale ----------------------------------------------------------------------------------------
// The page's reads of the card are held while the run adds a note underneath it: the pane still
// shows the revision it rendered when the person sends, so the send is refused as stale.
const held = [];
let freeze = true;
await page.route(/\/rpc\/?$/, async (route) => {
  const body = route.request().postData() ?? "";
  if (
    freeze &&
    (body.includes('"tag":"getBoard"') ||
      body.includes('"tag":"listBoardCards"') ||
      body.includes('"tag":"listTasks"') ||
      body.includes('"tag":"listTaskComments"'))
  ) {
    held.push(route);
    return;
  }
  await route.continue().catch(() => undefined);
});
const shownAt = (await readThread(page))?.revision ?? -1;
const runNote = await rpc("commentTask", {
  taskId: CARD,
  expectedRevision: shownAt,
  body: "Also: the migration runs before the deploy.",
  actor: first.run,
});
const composer = page.locator("section[data-thread] [data-thread-composer]");
await composer.fill(ANSWER);
// Send at a moment no poll of the board or the thread is due for at least a second (each polls every
// 2 s, so one such moment comes within a period): a read that follows the refusal within half a
// second is then the refusal's own re-read, not the poll's.
const QUIET_MS = 1_000;
const REREAD_MS = 500;
const pollDue = () =>
  Object.fromEntries(
    READ_TAGS.map((tag) => {
      const last = lastRead(tag);
      return [tag, last === undefined ? 0 : last.at + POLL_MS - Date.now()];
    }),
  );
const quiet = await until(
  () => Object.values(pollDue()).every((due) => due > QUIET_MS),
  10_000,
);
const dueAtSend = pollDue();
await page.locator("section[data-thread] [data-thread-send]").click();
const refused = await waitFor(
  () =>
    document.querySelector(
      "section[data-thread] [data-comment-refusal='StaleRevision']",
    ) !== null,
  null,
  15_000,
);
const sentAt =
  pageReads.findLast((read) => read.tag === "commentTask")?.at ?? Infinity;
const rereadsAfter = () =>
  pageReads.filter(
    (read) =>
      READ_TAGS.includes(read.tag) &&
      read.at >= sentAt &&
      read.at <= sentAt + REREAD_MS,
  );
await until(
  () =>
    READ_TAGS.every((tag) => rereadsAfter().some((read) => read.tag === tag)),
  REREAD_MS + 200,
);
const rereads = rereadsAfter().map((read) => ({
  tag: read.tag,
  afterSendMs: read.at - sentAt,
}));
const stale = await readThread(page);
const staleTruth = await rpc("getTask", { taskId: CARD });
await shot("thread-stale");
observed.facts.stale = {
  shownAt,
  runNote: {
    exit: runNote.exit,
    revision: runNote.value?.revision,
    blocked: runNote.value?.blocked ?? null,
  },
  view: stale,
  server: staleTruth.value,
  pollDueAtSendMs: dueAtSend,
  rereads,
};
assert(
  "an answer sent from a stale pane is refused as stale, and the card stays blocked",
  runNote.exit === "Success" &&
    runNote.value?.blocked?.reason === "needs_input" &&
    refused &&
    stale?.refusal?.tag === "StaleRevision" &&
    stale.refusal.text.includes(
      `is at revision ${String(runNote.value?.revision)}, not ${shownAt}`,
    ) &&
    staleTruth.value?.blocked?.reason === "needs_input" &&
    pageComments.length === 1 &&
    pageComments[0]?.expectedRevision === shownAt,
  `run note ${String(runNote.exit)} r${String(runNote.value?.revision)}; refusal ${JSON.stringify(stale?.refusal ?? null)}; server blocked ${String(staleTruth.value?.blocked?.reason)}; page sends ${JSON.stringify(pageComments.map((c) => c.expectedRevision))}`,
);
assert(
  "the refused answer is kept in the composer, not lost",
  stale?.draft === ANSWER,
  `draft ${JSON.stringify(stale?.draft ?? null)}`,
);
assert(
  "the refusal itself re-reads the card and its thread, not the next poll",
  quiet &&
    Object.values(dueAtSend).every((due) => due > QUIET_MS) &&
    READ_TAGS.every((tag) => rereads.some((read) => read.tag === tag)),
  `poll due at send ${JSON.stringify(dueAtSend)} ms; reads within ${REREAD_MS} ms of the send ${JSON.stringify(rereads)}`,
);
freeze = false;
for (const route of held.splice(0)) await route.continue().catch(() => {});
const refetched = await waitFor(
  ([card, revision]) =>
    Number(
      document
        .querySelector(`aside[data-card-pane='${card}']`)
        ?.getAttribute("data-card-pane-revision"),
    ) === revision &&
    document.querySelectorAll("section[data-thread] li[data-comment-kind]")
      .length === 2,
  [CARD, runNote.value?.revision ?? -1],
  15_000,
);
const afterRefetch = await readThread(page);
observed.facts.refetched = afterRefetch;
assert(
  "the stale pane is read again: the server's revision and the run's note, with the draft still there",
  refetched &&
    afterRefetch?.revision === staleTruth.value?.revision &&
    afterRefetch.comments.map((c) => c.kind).join(",") === "question,note" &&
    afterRefetch.comments[1]?.actor === first.run &&
    afterRefetch.draft === ANSWER &&
    afterRefetch.intent === "answer" &&
    afterRefetch.sendDisabled === false,
  `refetched ${refetched}; pane r${String(afterRefetch?.revision)} server r${String(staleTruth.value?.revision)}; kinds ${JSON.stringify(afterRefetch?.comments.map((c) => c.kind))}; draft kept ${afterRefetch?.draft === ANSWER}`,
);

// --- answer ---------------------------------------------------------------------------------------
await page.evaluate(() => {
  window.__threadNoReload = "answer";
});
const answeredAt = afterRefetch?.revision ?? -1;
await page.locator("section[data-thread] [data-thread-send]").click();
const liftShown = await waitFor(
  (card) =>
    document.querySelector("section[data-thread] [data-thread-lifted]") !==
      null &&
    !document
      .querySelector(`aside[data-card-pane='${card}']`)
      ?.hasAttribute("data-card-pane-blocked") &&
    document.querySelectorAll("section[data-thread] li[data-comment-kind]")
      .length === 3,
  CARD,
  15_000,
);
const answered = await readThread(page);
const answeredTask = await rpc("getTask", { taskId: CARD });
const answeredThread = await rpc("listTaskComments", { taskId: CARD });
const keptAnswer = await page.evaluate(
  () => window.__threadNoReload === "answer",
);
observed.facts.answered = {
  view: answered,
  server: answeredThread.value,
  task: answeredTask.value,
  pageComments,
};
await shot("thread-answered");
const answerRow = answered?.comments[2];
const answerTruth = answeredThread.value?.[2];
assert(
  "answering in the browser lifts the block, and the pane says so without a reload",
  liftShown &&
    keptAnswer &&
    answeredTask.value?.blocked === undefined &&
    answered?.blocked === null &&
    answered.lifted?.reason === "needs_input" &&
    answered.lifted.text.includes("no longer blocked") &&
    answered.lifted.text.includes("specifying") &&
    answered.intent === "note" &&
    answered.draft === "" &&
    !answered.headerText.includes("needs input"),
  `lifted ${JSON.stringify(answered?.lifted ?? null)}; server blocked ${JSON.stringify(answeredTask.value?.blocked ?? null)}; pane blocked ${String(answered?.blocked)}; intent ${String(answered?.intent)}; no reload ${keptAnswer}`,
);
assert(
  "the thread ends with the answer, by the dashboard, its whitespace kept",
  answerTruth?.kind === "answer" &&
    answerTruth.actor === "dashboard" &&
    answerTruth.body === ANSWER &&
    answerRow?.kind === "answer" &&
    answerRow.label === "Answer" &&
    answerRow.actor === "dashboard" &&
    answerRow.body === ANSWER &&
    answerRow.rendered === ANSWER &&
    answerRow.whiteSpace === "pre-wrap",
  `server ${JSON.stringify(answerTruth ?? null)}; page ${JSON.stringify(answerRow ?? null)}`,
);
assert(
  "the page sent two commentTasks: the stale one and the answer at the server's revision",
  pageComments.length === 2 &&
    pageComments[1]?.expectedRevision === answeredAt &&
    pageComments.every(
      (sent) =>
        sent.taskId === CARD &&
        sent.body === ANSWER &&
        sent.actor === "dashboard",
    ),
  `sends ${JSON.stringify(pageComments.map((c) => [c.expectedRevision, c.actor]))}`,
);

// --- show -----------------------------------------------------------------------------------------
const show = factory(["board", "show", "--task", CARD]);
observed.facts.show = show;
await writeFile(path.join(EVIDENCE_DIR, "board-show.txt"), show.stdout);
assert(
  "factory board show agrees: unblocked, and the answer in the thread",
  show.status === 0 &&
    show.stdout.includes("blocked   -") &&
    show.stdout.includes("thread    3") &&
    show.stdout.includes(`[question] ${first.run}`) &&
    show.stdout.includes(`[note] ${first.run}`) &&
    show.stdout.includes("[answer] dashboard") &&
    show.stdout.includes(
      ANSWER.split("\n")
        .map((line) => `    ${line}`)
        .join("\n"),
    ),
  `exit ${String(show.status)}; ${show.stdout.split("\n").slice(-8).join(" | ")}`,
);

// --- told -----------------------------------------------------------------------------------------
const second = await startRun(first.run);
const told = spawnSync(
  "bun",
  [path.join(ROOT, ".pi/skills/verify-board/ask.ts")],
  {
    cwd: ROOT,
    env: {
      ...process.env,
      API_URL,
      MODE: "told",
      SESSION_ID: second.run ?? "",
      TASK_ID: CARD,
      QUESTION,
      ANSWER,
      EVIDENCE_DIR,
      EVIDENCE_PREFIX: "thread",
    },
    encoding: "utf8",
    timeout: 120_000,
  },
);
const toldOut = await readFile(
  path.join(EVIDENCE_DIR, "thread-told.json"),
  "utf8",
)
  .then((text) => JSON.parse(text))
  .catch(() => null);
observed.facts.told = {
  run: second.run,
  exit: told.status,
  stdout: (told.stdout ?? "").slice(-1200),
  stderr: (told.stderr ?? "").slice(-1200),
  checks: toldOut?.checks ?? null,
};
const toldChecks = Object.entries(toldOut?.checks ?? {});
assert(
  "the next run's prompt quotes the answer verbatim, after the question, and it does not ask again",
  second.started &&
    second.run !== first.run &&
    told.status === 0 &&
    toldChecks.length > 0 &&
    toldChecks.every(([, entry]) => entry.passed),
  `run ${String(second.run)}; ask.ts told exit ${String(told.status)}; ${toldChecks.map(([name, entry]) => `${entry.passed ? "ok" : "FAILED"}: ${name}`).join("; ")}`,
);
// The pane polls: wait for it to list the second run, rather than for a fixed time.
await waitFor(
  ([one, two]) =>
    document.querySelector(`aside[data-card-pane] li[data-run='${one}']`) !==
      null &&
    document.querySelector(`aside[data-card-pane] li[data-run='${two}']`) !==
      null &&
    document.querySelectorAll(
      "section[data-thread] li[data-comment-kind='question']",
    ).length === 1,
  [first.run, second.run],
  15_000,
);
const settled = await readThread(page);
await shot("thread-next-run");
assert(
  "the pane lists both runs, and the thread has no second question",
  settled?.runs.includes(first.run) &&
    settled.runs.includes(second.run) &&
    settled.comments.filter((c) => c.kind === "question").length === 1 &&
    settled.blocked === null,
  `runs ${JSON.stringify(settled?.runs)}; kinds ${JSON.stringify(settled?.comments.map((c) => c.kind))}`,
);

assert(
  "the page logged no console error",
  consoleErrors.length === 0,
  JSON.stringify(consoleErrors.slice(0, 5)),
);

observed.consoleErrors = consoleErrors;
observed.pageRpcTags = [...pageTags].sort();
await writeFile(
  path.join(EVIDENCE_DIR, "observed.json"),
  `${JSON.stringify(observed, null, 2)}\n`,
);
await browser.close();

const failures = Object.values(observed.checks).filter((c) => !c.passed);
console.log(
  `\n${Object.keys(observed.checks).length - failures.length}/${Object.keys(observed.checks).length} checks passed`,
);
process.exit(failures.length === 0 ? 0 : 1);
