// The start phase's first message (C6): **Start run** on a card puts the run to work, and
// `factory board start` with no `--prompt` sends it the same words.
//
//   node start-prompt.mjs      # started by start-prompt.sh against the instance ./up.sh made
//
// Four cards on the seeded board, each moved into `specifying` (a working column), where a run may
// start. Three share one title and body, so what a run is first told can be compared byte for byte:
//
//   cli      `factory board start --task <card>` with no `--prompt` (a plain subprocess)
//   browser  the card pane's **Start run** opens a field ([data-start-prompt]) holding the card's
//            default prompt; **Send** ([data-start-send]) opens the run and sends the field's text
//   edited   the same, with the field's text replaced first: the run is told exactly that, and
//            Cancel ([data-start-cancel]) before it opened no run at all
//   idle     `factory board start --idle`: the run opens and nothing is sent (the fourth card)
//
// What is read is the server's: `getSession`'s transcript (the first `user` entry is Pi Durable's
// `pi.user`) and status, and `listTaskRuns`. The page is read only for what it shows and sends.
//
// Env:
//   WEB_URL, API_URL  the instance ./up.sh started (defaults :3400 / :9400)
//   BOARD_ID          the board ./up.sh seeded
//   FACTORY_CLI       the CLI entry to run with bun (default apps/cli/src/index.ts from the repo root)
//   EVIDENCE_DIR      default .verify/evidence/latest/board
//
// Writes `start-prompt-web.json` (every check and what was read) and `start-prompt-{form,sent}.png`,
// and exits non-zero when a check fails. Uses the locally installed Chrome (channel: "chrome").
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";

const WEB_URL = process.env["WEB_URL"] ?? "http://localhost:3400";
const API_URL = process.env["API_URL"] ?? "http://localhost:9400";
const BOARD_ID = process.env["BOARD_ID"] ?? "";
const ROOT = path.resolve(import.meta.dirname, "../../..");
const FACTORY_CLI =
  process.env["FACTORY_CLI"] ?? path.join(ROOT, "apps/cli/src/index.ts");
const EVIDENCE_DIR =
  process.env["EVIDENCE_DIR"] ??
  path.join(ROOT, ".verify/evidence/latest/board");
const PERSON = "person:start-prompt";
const RPC_TIMEOUT_MS = 10_000;
const OPEN_TIMEOUT_MS = 30_000;
// The faux model on this instance holds a turn open for 8 s (`up.sh`'s FAUX_COMMAND), so a run
// that was sent a message is busy for long enough to be read.
const FIRST_ENTRY_TIMEOUT_MS = 20_000;

const TAG = `${Date.now()}-${process.pid}`;
const TITLE = `Start prompt (${TAG})`;
const BODY =
  "## Goal\n\nCompose names one Postgres major.\n\n- keep port 5442 — it is shared";

const observed = {
  webUrl: WEB_URL,
  apiUrl: API_URL,
  boardId: BOARD_ID,
  tag: TAG,
  checks: {},
};
let failed = false;
const check = (name, condition, detail) => {
  observed.checks[name] = { passed: Boolean(condition), detail };
  if (!condition) failed = true;
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}  ${detail}`);
};

let rpcCalls = 0;
/** One RPC call from this process — the oracle, never the page — as its success value or a throw. */
const rpc = async (tag, payload) => {
  rpcCalls += 1;
  const requestId = `start-prompt-${tag}-${Date.now()}-${rpcCalls}`;
  const response = await fetch(`${API_URL}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/ndjson" },
    body: `${JSON.stringify({ _tag: "Request", id: requestId, tag, payload, headers: [] })}\n`,
    signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
  });
  const envelope = (await response.text())
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
  if (envelope?.exit?._tag !== "Success")
    throw new Error(
      `${tag}: ${JSON.stringify(envelope?.exit ?? null).slice(0, 400)}`,
    );
  return envelope.exit.value;
};

/** A card in `specifying`, where a run may start. */
const seedCard = async (title, body) => {
  const created = await rpc("createTask", {
    boardId: BOARD_ID,
    title,
    ...(body === undefined ? {} : { body }),
    actor: PERSON,
  });
  const moved = await rpc("moveTask", {
    taskId: created.id,
    expectedRevision: created.revision,
    to: "specifying",
    actor: PERSON,
  });
  return moved.id;
};

/** The run's first user entry and its status, polled until the entry is in the log. */
const firstUserEntry = async (sessionId) => {
  const deadline = Date.now() + FIRST_ENTRY_TIMEOUT_MS;
  for (;;) {
    const snapshot = await rpc("getSession", { sessionId });
    const entry = snapshot.entries.find(
      (candidate) => candidate.kind === "user",
    );
    if (entry !== undefined || Date.now() >= deadline)
      return {
        text: entry?.text ?? null,
        status: snapshot.session.status,
        entries: snapshot.entries.length,
      };
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
};

const cli = (args) => {
  const result = spawnSync(
    "bun",
    ["run", FACTORY_CLI, ...args, "--api", API_URL],
    {
      encoding: "utf8",
      timeout: 120_000,
    },
  );
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    session: /^session (ses_\S+)$/m.exec(result.stdout ?? "")?.[1] ?? null,
  };
};

await mkdir(EVIDENCE_DIR, { recursive: true });

let browser;
try {
  if (BOARD_ID === "") throw new Error("BOARD_ID must be set");
  const cliCard = await seedCard(TITLE, BODY);
  const browserCard = await seedCard(TITLE, BODY);
  const editedCard = await seedCard(`${TITLE} edited`, BODY);
  const idleCard = await seedCard(`${TITLE} idle`, undefined);
  observed.cards = {
    cli: cliCard,
    browser: browserCard,
    edited: editedCard,
    idle: idleCard,
  };

  // --- terminal: no --prompt ---------------------------------------------------------------------
  const started = cli(["board", "start", "--task", cliCard]);
  observed.cli = {
    status: started.status,
    stdout: started.stdout.slice(0, 600),
  };
  const cliFirst =
    started.session === null ? null : await firstUserEntry(started.session);
  observed.cli.first = cliFirst;
  check(
    "factory board start with no --prompt opens a run and sends the card's prompt",
    started.status === 0 &&
      cliFirst?.text?.startsWith(TITLE) === true &&
      cliFirst.text.includes("Compose names one Postgres major.") &&
      cliFirst.text.includes("specifying column") &&
      started.stdout.includes(`sent    ${TITLE} (the card's default prompt)`),
    `exit=${started.status} session=${started.session ?? "none"} first=${JSON.stringify((cliFirst?.text ?? "").slice(0, 100))}`,
  );
  check(
    "that run is busy: the prompt put it to work",
    cliFirst?.status === "busy",
    `status=${cliFirst?.status ?? "none"}`,
  );

  // --- browser: Start run, then Send -------------------------------------------------------------
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
  });
  const consoleErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) =>
    consoleErrors.push(`pageerror: ${String(error)}`),
  );
  // The page's own writes, read off its requests: the run it opens is `createSession` as the
  // dashboard, then one `sendMessage` carrying exactly the field's text.
  const writes = [];
  page.on("request", (request) => {
    if (!/\/rpc\/?$/.test(request.url()) || request.method() !== "POST") return;
    for (const line of (request.postData() ?? "").split("\n")) {
      try {
        const message = JSON.parse(line);
        if (
          message?._tag === "Request" &&
          ["createSession", "sendMessage"].includes(message.tag)
        )
          writes.push({ tag: message.tag, payload: message.payload });
      } catch {
        // not an RPC envelope line
      }
    }
  });

  const pane = (card) => `aside[data-card-pane='${card}']`;
  const openStartForm = async (card) => {
    await page.goto(`${WEB_URL}/boards/${BOARD_ID}?card=${card}`, {
      waitUntil: "domcontentloaded",
    });
    await page
      .locator(`${pane(card)} [data-start-run]:not([disabled])`)
      .waitFor({ timeout: OPEN_TIMEOUT_MS });
    await page.locator(`${pane(card)} [data-start-run]`).click();
    await page
      .locator(`${pane(card)} textarea[data-start-prompt]`)
      .waitFor({ timeout: 10_000 });
  };
  const sentRun = async () => {
    await page
      .waitForFunction(
        () =>
          (
            new URL(window.location.href).searchParams.get("run") ?? ""
          ).startsWith("ses_"),
        null,
        { timeout: 20_000 },
      )
      .catch(() => undefined);
    return new URL(page.url()).searchParams.get("run");
  };

  await openStartForm(browserCard);
  const fieldText = await page
    .locator(`${pane(browserCard)} textarea[data-start-prompt]`)
    .inputValue();
  const runsBefore = await rpc("listTaskRuns", { taskId: browserCard });
  await page.screenshot({
    path: path.join(EVIDENCE_DIR, "start-prompt-form.png"),
  });
  observed.browser = { fieldText, runsBeforeSend: runsBefore.length };
  check(
    "Start run opens a field holding the card's title, body and the column's instruction, and opens no run yet",
    fieldText.startsWith(TITLE) &&
      fieldText.includes("Compose names one Postgres major.") &&
      fieldText.includes("specifying column") &&
      runsBefore.length === 0 &&
      writes.length === 0,
    `field=${JSON.stringify(fieldText.slice(0, 100))} runs=${runsBefore.length} writes=${writes.length}`,
  );

  await page.locator(`${pane(browserCard)} [data-start-send]`).click();
  const browserSession = await sentRun();
  const browserFirst =
    browserSession === null ? null : await firstUserEntry(browserSession);
  await page.screenshot({
    path: path.join(EVIDENCE_DIR, "start-prompt-sent.png"),
  });
  observed.browser = {
    ...observed.browser,
    session: browserSession,
    first: browserFirst,
    writes: [...writes],
  };
  check(
    "Send opens the run and its first user entry is the card's prompt, with the card's title",
    browserSession !== null &&
      browserFirst?.text === fieldText &&
      browserFirst.text.includes(TITLE) &&
      writes.map((write) => write.tag).join() === "createSession,sendMessage" &&
      writes[0]?.payload?.actor === "dashboard" &&
      writes[0]?.payload?.taskId === browserCard &&
      writes[1]?.payload?.content === fieldText,
    `session=${browserSession ?? "none"} writes=${writes.map((write) => write.tag).join()}`,
  );
  check(
    "that run is busy: Send put it to work",
    browserFirst?.status === "busy",
    `status=${browserFirst?.status ?? "none"}`,
  );

  // --- equivalence: both doors, one card, one first message --------------------------------------
  check(
    "the browser's first entry equals factory board start's, for the same card",
    cliFirst?.text !== null && cliFirst?.text === browserFirst?.text,
    `cli ${JSON.stringify((cliFirst?.text ?? "").slice(0, 60))} / browser ${JSON.stringify((browserFirst?.text ?? "").slice(0, 60))}`,
  );

  // --- edited: the field is what is sent, and Cancel opens nothing -------------------------------
  writes.length = 0;
  await openStartForm(editedCard);
  await page.locator(`${pane(editedCard)} [data-start-cancel]`).click();
  const closed = await page
    .locator(`${pane(editedCard)} textarea[data-start-prompt]`)
    .count();
  const runsAfterCancel = await rpc("listTaskRuns", { taskId: editedCard });
  check(
    "Cancel closes the field and opens no run",
    closed === 0 && runsAfterCancel.length === 0 && writes.length === 0,
    `field=${closed} runs=${runsAfterCancel.length} writes=${writes.length}`,
  );
  await page.locator(`${pane(editedCard)} [data-start-run]`).click();
  const edited = "Read the card, then only say which Postgres major it needs.";
  const field = page.locator(`${pane(editedCard)} textarea[data-start-prompt]`);
  await field.fill("   ");
  const blocked = await page
    .locator(`${pane(editedCard)} [data-start-send]`)
    .isDisabled();
  await field.fill(edited);
  await page.locator(`${pane(editedCard)} [data-start-send]`).click();
  const editedSession = await sentRun();
  const editedFirst =
    editedSession === null ? null : await firstUserEntry(editedSession);
  check(
    "an empty field cannot be sent, and an edited one is sent exactly as typed",
    blocked && editedFirst?.text === edited,
    `blocked=${blocked} first=${JSON.stringify(editedFirst?.text ?? null)}`,
  );

  // --- idle: opt out, the run opens and waits ----------------------------------------------------
  const idled = cli(["board", "start", "--task", idleCard, "--idle"]);
  const idleSnapshot =
    idled.session === null
      ? null
      : await rpc("getSession", { sessionId: idled.session });
  check(
    "factory board start --idle opens the run and sends nothing",
    idled.status === 0 &&
      idleSnapshot !== null &&
      idleSnapshot.session.status === "idle" &&
      !idleSnapshot.entries.some((entry) => entry.kind === "user") &&
      !idled.stdout.includes("sent "),
    `exit=${idled.status} status=${idleSnapshot?.session.status ?? "none"} entries=${idleSnapshot?.entries.length ?? "none"}`,
  );
  check(
    "the page raised no console errors",
    consoleErrors.length === 0,
    JSON.stringify(consoleErrors.slice(0, 3)),
  );
} catch (error) {
  failed = true;
  observed.error = String(error);
  console.log(`FAIL  start-prompt threw  ${String(error)}`);
} finally {
  await browser?.close();
  observed.passed = !failed;
  await writeFile(
    path.join(EVIDENCE_DIR, "start-prompt-web.json"),
    `${JSON.stringify(observed, null, 2)}\n`,
  );
}
process.exit(failed ? 1 : 0);
