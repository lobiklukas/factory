// The budget on a board run, and raising a stopped session's cap (C23).
//
//   node budget.mjs      # started by budget.sh against the instance ./up.sh made (FAUX_COST=0.01)
//
// The instance's faux model is priced a cent a request, and a run in `specifying` makes its first
// request (a `bash` call that sleeps 8 s) and a second after it, so a one-cent cap is reached by the
// first answer and the run must stop before the second. What is read is the server's: `getSession`'s
// budget, spend and transcript, and `listTaskRuns`. The page is read only for what it shows and sends.
//
//   cli      `factory board start --budget 0.05 --idle` records the cap on the run's session; `--budget 0`
//            is refused with no run opened; no `--budget` records none (this instance has no default)
//   browser  the card pane's Start run has a Budget field: text that is not an amount is refused on the
//            spot and sends nothing; 0.01 is sent on `createSession` and recorded
//   raise    the run stops at its cap (a `budget` entry, `budget.stopped`); the **Raise cap** action
//            under the stop sends `setSessionBudget`, the stop is cleared, the action goes away, and
//            the session runs again on its next message (spend passes the first cap, no second stop)
//   terminal `factory budget <session> --cap` sets a cap on the same session the same way
//
// Env:
//   WEB_URL, API_URL  the instance ./up.sh started (defaults :3400 / :9400)
//   BOARD_ID          the board ./up.sh seeded
//   FACTORY_CLI       the CLI entry to run with bun (default apps/cli/src/index.ts from the repo root)
//   EVIDENCE_DIR      default .verify/evidence/latest/board
//
// Writes `budget-web.json` (every check and what was read) and `budget-{stopped,raised}.png`, and
// exits non-zero when a check fails. Uses the locally installed Chrome (channel: "chrome").
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
const PERSON = "person:budget";
const RPC_TIMEOUT_MS = 10_000;
const OPEN_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 60_000;
const CAP = 0.01;

const TAG = `${Date.now()}-${process.pid}`;
const TITLE = `Budget (${TAG})`;

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
  const requestId = `budget-${tag}-${Date.now()}-${rpcCalls}`;
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
const seedCard = async (suffix) => {
  const created = await rpc("createTask", {
    boardId: BOARD_ID,
    title: `${TITLE} ${suffix}`,
    body: "Compose names one Postgres major.",
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

const cli = (args) => {
  const result = spawnSync(
    "bun",
    ["run", FACTORY_CLI, ...args, "--api", API_URL],
    { encoding: "utf8", timeout: 120_000 },
  );
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    session: /^session (ses_\S+)$/m.exec(result.stdout ?? "")?.[1] ?? null,
  };
};

const spentOf = (snapshot) =>
  [...snapshot.usage.models, ...snapshot.usage.tools].reduce(
    (total, bucket) => total + bucket.usage.costTotal,
    0,
  );
const stopsOf = (snapshot) =>
  snapshot.entries.filter((entry) => entry.kind === "budget");
const close = (left, right) => Math.abs(left - right) < 1e-9;

/** Poll `getSession` until `done(snapshot)` holds and the run is idle, or the deadline passes. */
const settled = async (sessionId, done, timeoutMs = STOP_TIMEOUT_MS) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const snapshot = await rpc("getSession", { sessionId });
    if (done(snapshot) && snapshot.session.status === "idle") return snapshot;
    if (Date.now() >= deadline) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
};

await mkdir(EVIDENCE_DIR, { recursive: true });

let browser;
try {
  if (BOARD_ID === "") throw new Error("BOARD_ID must be set");
  const cliCard = await seedCard("cli");
  const plainCard = await seedCard("plain");
  const refusedCard = await seedCard("refused");
  const browserCard = await seedCard("browser");

  // --- terminal: factory board start --budget ----------------------------------------------------
  // Not `--idle`: an idle run never ends a turn, so it would hold one of the board's two run slots
  // (caps.board=2) and starve the browser's run below. These run, answer, and free theirs.
  const capped = cli(["board", "start", "--task", cliCard, "--budget", "0.05"]);
  const cappedSnapshot =
    capped.session === null
      ? null
      : await rpc("getSession", { sessionId: capped.session });
  observed.cli = {
    capped: { status: capped.status, stdout: capped.stdout.slice(0, 400) },
    budget: cappedSnapshot?.budget ?? null,
  };
  check(
    "factory board start --budget records the cap on the run's session",
    capped.status === 0 &&
      cappedSnapshot?.budget?.cap === 0.05 &&
      cappedSnapshot.budget.spent <= 0.02 &&
      capped.stdout.includes("budget  $0.0500"),
    `exit=${capped.status} budget=${JSON.stringify(cappedSnapshot?.budget ?? null)}`,
  );
  const cappedRuns = await rpc("listTaskRuns", { taskId: cliCard });
  check(
    "that session is the card's run",
    cappedRuns.length === 1 && cappedRuns[0].sessionId === capped.session,
    `runs=${cappedRuns.map((run) => run.sessionId).join()}`,
  );

  const plain = cli(["board", "start", "--task", plainCard]);
  const plainSnapshot =
    plain.session === null
      ? null
      : await rpc("getSession", { sessionId: plain.session });
  check(
    "without --budget the run records no cap (this instance has no default)",
    plain.status === 0 &&
      plainSnapshot !== null &&
      plainSnapshot.budget === undefined &&
      !plain.stdout.includes("budget"),
    `exit=${plain.status} budget=${JSON.stringify(plainSnapshot?.budget ?? null)}`,
  );

  const refused = cli([
    "board",
    "start",
    "--task",
    refusedCard,
    "--budget",
    "0",
  ]);
  const refusedRuns = await rpc("listTaskRuns", { taskId: refusedCard });
  check(
    "--budget 0 is refused by the CLI and opens no run",
    refused.status !== 0 && refusedRuns.length === 0,
    `exit=${refused.status} runs=${refusedRuns.length}`,
  );

  // The two runs above answer (a cent a request, well under 0.05) and free their slots.
  for (const run of [capped.session, plain.session]) {
    const done = await settled(run, () => true, 90_000);
    check(
      "a run under its cap answers and frees its slot",
      done.session.status === "idle" && stopsOf(done).length === 0,
      `session=${run} status=${done.session.status} stops=${stopsOf(done).length}`,
    );
  }

  // --- browser: the Start run budget field -------------------------------------------------------
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
  const writes = [];
  page.on("request", (request) => {
    if (!/\/rpc\/?$/.test(request.url()) || request.method() !== "POST") return;
    for (const line of (request.postData() ?? "").split("\n")) {
      try {
        const message = JSON.parse(line);
        if (
          message?._tag === "Request" &&
          ["createSession", "sendMessage", "setSessionBudget"].includes(
            message.tag,
          )
        )
          writes.push({ tag: message.tag, payload: message.payload });
      } catch {
        // not an RPC envelope line
      }
    }
  });

  const pane = `aside[data-card-pane='${browserCard}']`;
  await page.goto(`${WEB_URL}/boards/${BOARD_ID}?card=${browserCard}`, {
    waitUntil: "domcontentloaded",
  });
  await page
    .locator(`${pane} [data-start-run]:not([disabled])`)
    .waitFor({ timeout: OPEN_TIMEOUT_MS });
  await page.locator(`${pane} [data-start-run]`).click();
  await page
    .locator(`${pane} textarea[data-start-prompt]`)
    .waitFor({ timeout: 10_000 });
  const budgetField = page.locator(`${pane} input[data-start-budget]`);
  await budgetField.fill("abc");
  const badShown = await page
    .locator(`${pane} [data-start-budget-invalid]`)
    .count();
  const sendBlocked = await page
    .locator(`${pane} [data-start-send]`)
    .isDisabled();
  check(
    "a Budget that is not an amount is refused on the spot, and Send is unavailable",
    badShown === 1 && sendBlocked && writes.length === 0,
    `invalid-notice=${badShown} send-disabled=${sendBlocked} writes=${writes.length}`,
  );
  await budgetField.fill(String(CAP));
  await page.locator(`${pane} [data-start-send]`).click();
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
  const session = new URL(page.url()).searchParams.get("run");
  const created = writes.find((write) => write.tag === "createSession");
  const opened =
    session === null ? null : await rpc("getSession", { sessionId: session });
  observed.browser = {
    session,
    writes: [...writes],
    budget: opened?.budget ?? null,
  };
  check(
    "Send puts the typed Budget on createSession, and the run's session records it",
    session !== null &&
      created?.payload?.budget === CAP &&
      created.payload.taskId === browserCard &&
      opened?.budget?.cap === CAP,
    `session=${session ?? "none"} sent=${JSON.stringify(created?.payload?.budget)} recorded=${JSON.stringify(opened?.budget ?? null)}`,
  );

  // --- the cap stops the run ----------------------------------------------------------------------
  const stopped = await settled(
    session,
    (snapshot) => stopsOf(snapshot).length > 0,
  );
  observed.stopped = {
    budget: stopped.budget ?? null,
    kinds: stopped.entries.map((entry) => entry.kind),
  };
  check(
    "the one-cent cap stops the run at its limit: a stop entry, budget.stopped, spend equal to the cap",
    stopsOf(stopped).length === 1 &&
      stopped.budget?.stopped?.cap === CAP &&
      close(spentOf(stopped), CAP),
    `stops=${stopsOf(stopped).length} spent=${spentOf(stopped)} budget=${JSON.stringify(stopped.budget ?? null)}`,
  );

  // --- the page offers Raise cap on the stop --------------------------------------------------------
  const raiseForm = page.locator(`${pane} form[data-raise-cap]`);
  await raiseForm.waitFor({ timeout: 20_000 }).catch(() => undefined);
  const offered = await raiseForm.count();
  await page.screenshot({
    path: path.join(EVIDENCE_DIR, "budget-stopped.png"),
  });
  const suggested =
    offered === 1
      ? await raiseForm.locator("input[data-raise-cap-input]").inputValue()
      : null;
  check(
    "the transcript's budget stop carries a Raise cap action, opened at twice the stopping cap",
    offered === 1 && suggested === "0.02",
    `forms=${offered} suggested=${JSON.stringify(suggested)}`,
  );

  // A cap the spend already reaches is refused on the page, and sends nothing.
  writes.length = 0;
  const capInput = raiseForm.locator("input[data-raise-cap-input]");
  await capInput.fill("0.01");
  const refusedCap = await raiseForm
    .locator("[data-raise-cap-invalid]")
    .count();
  const submitBlocked = await raiseForm
    .locator("button[data-raise-cap-submit]")
    .isDisabled();
  check(
    "a cap the spend already reaches is refused on the page, and nothing is sent",
    refusedCap === 1 && submitBlocked && writes.length === 0,
    `notice=${refusedCap} submit-disabled=${submitBlocked} writes=${writes.length}`,
  );

  await capInput.fill("0.05");
  await raiseForm.locator("button[data-raise-cap-submit]").click();
  let raised = await rpc("getSession", { sessionId: session });
  for (let i = 0; i < 40 && raised.budget?.cap !== 0.05; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    raised = await rpc("getSession", { sessionId: session });
  }
  await page
    .locator(`${pane} form[data-raise-cap]`)
    .waitFor({ state: "detached", timeout: 10_000 })
    .catch(() => undefined);
  const goneAfter = await page.locator(`${pane} form[data-raise-cap]`).count();
  await page.screenshot({ path: path.join(EVIDENCE_DIR, "budget-raised.png") });
  const raiseWrite = writes.find((write) => write.tag === "setSessionBudget");
  observed.raise = { writes: [...writes], budget: raised.budget ?? null };
  check(
    "Raise cap sends setSessionBudget for the typed cap, and the session records it with the stop cleared",
    raiseWrite?.payload?.sessionId === session &&
      raiseWrite.payload.budget === 0.05 &&
      raised.budget?.cap === 0.05 &&
      raised.budget.stopped === undefined,
    `sent=${JSON.stringify(raiseWrite?.payload ?? null)} budget=${JSON.stringify(raised.budget ?? null)}`,
  );
  check(
    "the action is gone once the cap is raised (one raise per stop)",
    goneAfter === 0,
    `forms=${goneAfter}`,
  );

  // --- the session runs again ---------------------------------------------------------------------
  await rpc("sendMessage", { sessionId: session, content: "carry on" });
  const resumed = await settled(
    session,
    (snapshot) => spentOf(snapshot) > CAP + 1e-9,
  );
  observed.resumed = {
    budget: resumed.budget ?? null,
    kinds: resumed.entries.map((entry) => entry.kind),
    spent: spentOf(resumed),
  };
  check(
    "the session the cap stopped runs again after its cap is raised: it spends past the old cap and stops no more",
    spentOf(resumed) > CAP + 1e-9 &&
      stopsOf(resumed).length === 1 &&
      resumed.budget?.stopped === undefined,
    `spent=${spentOf(resumed)} stops=${stopsOf(resumed).length} budget=${JSON.stringify(resumed.budget ?? null)}`,
  );

  // --- terminal: factory budget -------------------------------------------------------------------
  const set = cli(["budget", session, "--cap", "0.2"]);
  const after = await rpc("getSession", { sessionId: session });
  observed.cliBudget = { status: set.status, stdout: set.stdout.slice(0, 400) };
  check(
    "factory budget sets the cap on the log and says so",
    set.status === 0 &&
      set.stdout.includes(`capped ${session}: $0.2000 cap`) &&
      after.budget?.cap === 0.2,
    `exit=${set.status} budget=${JSON.stringify(after.budget ?? null)}`,
  );
  const missing = cli([
    "budget",
    "ses_00000000000000000000000000",
    "--cap",
    "1",
  ]);
  check(
    "factory budget on an unknown session is not_found with a non-zero exit",
    missing.status !== 0 && /not_found/.test(missing.stderr + missing.stdout),
    `exit=${missing.status} ${JSON.stringify((missing.stderr + missing.stdout).slice(0, 120))}`,
  );

  check(
    "the page raised no console errors",
    consoleErrors.length === 0,
    JSON.stringify(consoleErrors.slice(0, 3)),
  );
} catch (error) {
  failed = true;
  observed.error = String(error);
  console.log(`FAIL  budget threw  ${String(error)}`);
} finally {
  await browser?.close();
  observed.passed = !failed;
  await writeFile(
    path.join(EVIDENCE_DIR, "budget-web.json"),
    `${JSON.stringify(observed, null, 2)}\n`,
  );
}
process.exit(failed ? 1 : 0);
