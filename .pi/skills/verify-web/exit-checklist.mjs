// Drive the card pane's exit checklist (D9) the way an operator reads it, against the instance
// `exit-checklist.sh` starts, and capture evidence.
//
//   node exit-checklist.mjs      (via ./exit-checklist.sh, which owns the instance this drives)
//
//   specifying  a card with no spec: the pane lists "Leaves specifying when" with `spec_doc` unmet,
//               and its key, status and reason equal what `getTaskExit` answers (the oracle, asked
//               from this process, never the page); the move to `planning` says why before the
//               click, and `canceled` beside it says nothing
//   refusal     a click on the warned move shows the server's refusal, and it carries the checklist's
//               reason word for word: one verdict, two readers
//   spec        a spec declared in-process (`lib/seed-spec.ts`, what a specifying run's `spec` tool
//               does) flips `spec_doc` to met and drops the warning within one poll interval, and the
//               same click now moves the card
//   planning    `plan_doc` is unmet with the server's reason and warns the move to `building` (D10);
//               the human-gate label is listed `not checked`, never `met`
//   plan        a plan declared in-process (`lib/seed-plan.ts`, what a planning run's `plan` tool
//               does) flips `plan_doc` to met within one poll, drops the warning, and the pane's Plan
//               section shows it as `getTaskPlan` answers it
//   building    with no run, `run_completed`, `non_empty_diff` and `pr_link` are all unmet with the
//               server's reasons, the move to `review` names all three, `canceled` none
//
// The card is walked with the API's own moves (`moveTask`) as a person: what is driven here is the
// pane's reading of the card, and the move controls are the card pane's other feature's.
//
// Env: WEB_URL, API_URL, EVIDENCE_DIR, DATABASE_URL (for `lib/seed-spec.ts` and `lib/seed-plan.ts`,
// the API's database).
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const WEB_URL = process.env["WEB_URL"] ?? "http://localhost:3561";
const API_URL = process.env["API_URL"] ?? "http://localhost:9561";
const EVIDENCE_DIR =
  process.env["EVIDENCE_DIR"] ?? ".verify/evidence/latest/exit-checklist";
const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const SEED_SPEC = path.join(ROOT, ".pi/skills/lib/seed-spec.ts");
const SEED_PLAN = path.join(ROOT, ".pi/skills/lib/seed-plan.ts");
/** The exit view's poll interval (`EXIT_POLL`, 10 s) and the slack one read plus a render may add. */
const POLL_MS = 10_000;
const WINDOW_MS = POLL_MS + 2_000;
const PERSON = "person:verify-exit-checklist";

await mkdir(EVIDENCE_DIR, { recursive: true });
await rm(path.join(EVIDENCE_DIR, "exit-failure.png"), { force: true });

const observed = { webUrl: WEB_URL, apiUrl: API_URL, checks: {} };
const assert = (name, condition, detail) => {
  observed.checks[name] = { passed: Boolean(condition), detail };
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}  ${detail}`);
  return Boolean(condition);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** One unary RPC call over the NDJSON envelope, from this process: the oracle, never the page. */
const rpc = async (tag, payload) => {
  const requestId = `exit-checklist-${tag}-${Date.now()}-${Math.random()}`;
  const response = await fetch(`${API_URL}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/ndjson" },
    body: `${JSON.stringify({ _tag: "Request", id: requestId, tag, payload, headers: [] })}\n`,
  });
  const text = await response.text();
  const exit = text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .find((message) => message?.requestId === requestId)?.exit;
  if (exit?._tag !== "Success") {
    throw new Error(`${tag} failed: ${text.slice(0, 400)}`);
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

/** The pane's checklist as a reader sees it: each item's key, status word and reason. */
const readChecklist = () =>
  page.evaluate(() => {
    const pane = document.querySelector("aside[data-card-pane]");
    const list = pane?.querySelector("[data-exit-checklist]");
    if (pane === null || list === null || list === undefined) return null;
    return {
      column: list.getAttribute("data-exit-checklist"),
      heading: (list.querySelector("h3")?.textContent ?? "").trim(),
      items: Array.from(list.querySelectorAll("li[data-exit-key]")).map(
        (item) => ({
          key: item.getAttribute("data-exit-key"),
          status: item.getAttribute("data-exit-status"),
          word: (item.querySelector("span > span")?.textContent ?? "").trim(),
          reason:
            (
              item.querySelector("[data-exit-reason]")?.textContent ?? ""
            ).trim() || null,
        }),
      ),
    };
  });

/** Each move button's warning: the keys it names and the sentences it shows. */
const readMoves = () =>
  page.evaluate(() => {
    const pane = document.querySelector("aside[data-card-pane]");
    if (pane === null) return null;
    return Array.from(pane.querySelectorAll("[data-move-to]")).map((button) => {
      const to = button.getAttribute("data-move-to");
      const note = pane.querySelector(`[data-move-unmet-note='${to}']`);
      return {
        to,
        unmet: button.getAttribute("data-move-unmet"),
        describedBy: button.getAttribute("aria-describedby"),
        note:
          note === null
            ? null
            : Array.from(note.querySelectorAll("[data-move-unmet-key]")).map(
                (line) => (line.textContent ?? "").replace(/\s+/g, " ").trim(),
              ),
      };
    });
  });

const paneIn = (column) =>
  page.waitForSelector(
    `aside[data-card-pane][data-card-pane-column='${column}'] [data-exit-checklist='${column}']`,
    { timeout: 20_000 },
  );

const WORDS = { met: "met", unmet: "unmet", unchecked: "not checked" };

/** Whether the pane's list is the server's: the same keys, in order, with the same status and reason. */
const sameAsServer = (shown, truth) =>
  shown !== null &&
  JSON.stringify(shown.items.map((item) => [item.key, item.status])) ===
    JSON.stringify(truth.requirements.map((r) => [r.key, r.status])) &&
  shown.items.every(
    (item, index) =>
      item.word === WORDS[item.status] &&
      item.reason === (truth.requirements[index]?.reason ?? null),
  );

let exitCode = 0;
try {
  const repo = `verify-exit/${randomBytes(6).toString("hex")}`;
  const board = await rpc("createBoard", {
    repo,
    definitionId: "default",
  });
  const created = await rpc("createTask", {
    boardId: board.id,
    title: "exit checklist: a card with no spec",
    actor: PERSON,
  });
  const taskId = created.id;
  observed.repo = repo;
  observed.boardId = board.id;
  observed.taskId = taskId;
  let card = await rpc("moveTask", {
    taskId,
    expectedRevision: created.revision,
    to: "specifying",
    actor: PERSON,
  });
  await page.goto(`${WEB_URL}/boards/${board.id}?card=${taskId}`, {
    waitUntil: "domcontentloaded",
  });

  // --- specifying: no spec ----------------------------------------------------------------------
  await paneIn("specifying");
  const truth1 = await rpc("getTaskExit", { taskId });
  const shown1 = await readChecklist();
  observed.specifying = { truth: truth1, shown: shown1 };
  assert(
    "the pane lists what specifying needs, and it is the server's own view",
    shown1?.heading === "Leaves specifying when" &&
      truth1.requirements.length === 1 &&
      truth1.requirements[0].key === "spec_doc" &&
      truth1.requirements[0].status === "unmet" &&
      sameAsServer(shown1, truth1),
    `pane ${JSON.stringify(shown1?.items)}; server ${JSON.stringify(truth1.requirements)}`,
  );
  const moves1 = await readMoves();
  observed.specifying.moves = moves1;
  const toPlanning = moves1?.find((move) => move.to === "planning");
  const toCanceled1 = moves1?.find((move) => move.to === "canceled");
  assert(
    "the move to planning says why before it is clicked; canceled says nothing",
    toPlanning?.unmet === "spec_doc" &&
      toPlanning.note?.length === 1 &&
      toPlanning.note[0].includes("the card has no spec") &&
      toPlanning.describedBy !== null &&
      toCanceled1 !== undefined &&
      toCanceled1.unmet === null &&
      toCanceled1.note === null,
    JSON.stringify(moves1),
  );
  await page.screenshot({
    path: path.join(EVIDENCE_DIR, "exit-specifying-unmet.png"),
    fullPage: true,
  });

  // --- refusal: a click on the warned move shows the server's words -------------------------------
  await page.locator("aside[data-card-pane] [data-move-to='planning']").click();
  await page.waitForSelector("aside[data-card-pane] [data-move-refusal]", {
    timeout: 10_000,
  });
  const refusal = await page.evaluate(() => {
    const alert = document.querySelector(
      "aside[data-card-pane] [data-move-refusal]",
    );
    return {
      tag: alert?.getAttribute("data-move-refusal") ?? null,
      text: (alert?.textContent ?? "").replace(/\s+/g, " ").trim(),
    };
  });
  const reason1 = truth1.requirements[0].reason;
  observed.refusal = { shown: refusal, checklistReason: reason1 };
  assert(
    "the refusal names spec_doc and carries the checklist's reason verbatim",
    refusal.tag === "RequirementUnmet" &&
      refusal.text.includes('"spec_doc"') &&
      refusal.text.includes(reason1),
    `${refusal.tag}: ${refusal.text.slice(0, 200)}`,
  );
  const unmoved = await rpc("getTask", { taskId });
  assert(
    "the refused card did not move",
    unmoved.column === "specifying" && unmoved.revision === card.revision,
    `${unmoved.column} r${unmoved.revision}`,
  );
  await page.screenshot({
    path: path.join(EVIDENCE_DIR, "exit-specifying-refused.png"),
    fullPage: true,
  });

  // --- spec: declared in-process, met within a poll -----------------------------------------------
  const seeded = spawnSync("bun", ["run", SEED_SPEC], {
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, TASK_ID: taskId },
  });
  const declaredAt = Date.now();
  assert(
    "a spec is declared on the card, a revision on",
    seeded.status === 0 && seeded.stdout.includes(`"taskId":"${taskId}"`),
    `${seeded.status} ${(seeded.stdout || seeded.stderr).trim().slice(0, 200)}`,
  );
  await page.waitForSelector(
    "aside[data-card-pane] [data-exit-key='spec_doc'][data-exit-status='met']",
    { timeout: 20_000 },
  );
  const metAfterMs = Date.now() - declaredAt;
  const truth2 = await rpc("getTaskExit", { taskId });
  const shown2 = await readChecklist();
  const moves2 = await readMoves();
  observed.spec = { truth: truth2, shown: shown2, moves: moves2, metAfterMs };
  assert(
    "spec_doc turns met within one poll interval, equal to the server",
    metAfterMs <= WINDOW_MS + 1_000 && sameAsServer(shown2, truth2),
    `${metAfterMs}ms (poll ${POLL_MS}ms); pane ${JSON.stringify(shown2?.items)}`,
  );
  assert(
    "and the move to planning is no longer warned",
    moves2?.find((move) => move.to === "planning")?.unmet === null,
    JSON.stringify(moves2),
  );
  await page.screenshot({
    path: path.join(EVIDENCE_DIR, "exit-specifying-met.png"),
    fullPage: true,
  });
  // The pane must hold the revision the spec left before it is clicked (the move sends it).
  await page.waitForSelector(
    `aside[data-card-pane][data-card-pane-revision='${JSON.parse(seeded.stdout.trim()).revision}']`,
    { timeout: 10_000 },
  );
  await page.locator("aside[data-card-pane] [data-move-to='planning']").click();

  // --- planning: plan_doc judged (D10), the human-gate label listed, never judged -----------------
  await paneIn("planning");
  const truth3 = await rpc("getTaskExit", { taskId });
  const shown3 = await readChecklist();
  const moves3 = await readMoves();
  observed.planning = { truth: truth3, shown: shown3, moves: moves3 };
  assert(
    "with the spec, the same click moved the card on to planning",
    (await rpc("getTask", { taskId })).column === "planning",
    "planning",
  );
  assert(
    "planning's plan_doc reads unmet with the server's reason, its human gate label 'not checked'",
    sameAsServer(shown3, truth3) &&
      JSON.stringify(truth3.requirements.map((r) => [r.key, r.status])) ===
        JSON.stringify([
          ["plan_doc", "unmet"],
          ["human_move", "unchecked"],
        ]) &&
      shown3.items.find((item) => item.key === "human_move")?.word ===
        "not checked",
    `pane ${JSON.stringify(shown3?.items.map((i) => [i.key, i.word]))}`,
  );
  assert(
    "the move to building is warned naming plan_doc; canceled is not",
    moves3?.find((move) => move.to === "building")?.unmet === "plan_doc" &&
      moves3?.find((move) => move.to === "canceled")?.unmet === null,
    JSON.stringify(moves3?.map((m) => [m.to, m.unmet])),
  );
  await page.screenshot({
    path: path.join(EVIDENCE_DIR, "exit-planning-unplanned.png"),
    fullPage: true,
  });

  // --- plan: declared in-process, met within a poll, and shown in the pane's Plan section --------
  const planned = spawnSync("bun", ["run", SEED_PLAN], {
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, TASK_ID: taskId },
  });
  const plannedAt = Date.now();
  assert(
    "a plan is declared on the card, a revision on",
    planned.status === 0 && planned.stdout.includes(`"taskId":"${taskId}"`),
    `${planned.status} ${(planned.stdout || planned.stderr).trim().slice(0, 200)}`,
  );
  await page.waitForSelector(
    "aside[data-card-pane] [data-exit-key='plan_doc'][data-exit-status='met']",
    { timeout: 20_000 },
  );
  const planMetAfterMs = Date.now() - plannedAt;
  const truth3b = await rpc("getTaskExit", { taskId });
  const shown3b = await readChecklist();
  const moves3b = await readMoves();
  await page.waitForSelector("aside[data-card-pane] [data-plan]", {
    timeout: 20_000,
  });
  const planShown = await page.evaluate(() => ({
    summary:
      document.querySelector("aside[data-card-pane] [data-plan-summary]")
        ?.textContent ?? null,
    steps: Array.from(
      document.querySelectorAll(
        "aside[data-card-pane] [data-plan-list='steps'] [data-plan-item]",
      ),
    ).map((item) => item.textContent ?? ""),
  }));
  const planTruth = await rpc("getTaskPlan", { taskId });
  observed.plan = {
    truth: truth3b,
    shown: shown3b,
    moves: moves3b,
    planMetAfterMs,
    planShown,
    planTruth,
  };
  assert(
    "plan_doc turns met within one poll interval, equal to the server, and building is no longer warned",
    planMetAfterMs <= WINDOW_MS + 1_000 &&
      sameAsServer(shown3b, truth3b) &&
      moves3b?.find((move) => move.to === "building")?.unmet === null,
    `${planMetAfterMs}ms (poll ${POLL_MS}ms); pane ${JSON.stringify(shown3b?.items.map((i) => [i.key, i.status]))}`,
  );
  assert(
    "the pane's Plan section shows the card's plan, as getTaskPlan answers it",
    planTruth !== null &&
      planShown.summary === planTruth.summary &&
      JSON.stringify(planShown.steps) === JSON.stringify(planTruth.steps),
    `summary "${String(planShown.summary)}", steps ${JSON.stringify(planShown.steps)}`,
  );
  await page.screenshot({
    path: path.join(EVIDENCE_DIR, "exit-planning-planned.png"),
    fullPage: true,
  });

  // --- building: no run, every checked key unmet ----------------------------------------------------
  card = await rpc("getTask", { taskId });
  await rpc("moveTask", {
    taskId,
    expectedRevision: card.revision,
    to: "building",
    actor: PERSON,
  });
  await paneIn("building");
  const truth4 = await rpc("getTaskExit", { taskId });
  const shown4 = await readChecklist();
  const moves4 = await readMoves();
  observed.building = { truth: truth4, shown: shown4, moves: moves4 };
  assert(
    "building lists run_completed, non_empty_diff and pr_link unmet, as the server does",
    JSON.stringify(truth4.requirements.map((r) => [r.key, r.status])) ===
      JSON.stringify([
        ["run_completed", "unmet"],
        ["non_empty_diff", "unmet"],
        ["pr_link", "unmet"],
      ]) && sameAsServer(shown4, truth4),
    `pane ${JSON.stringify(shown4?.items.map((i) => [i.key, i.status]))}`,
  );
  const toReview = moves4?.find((move) => move.to === "review");
  const toCanceled4 = moves4?.find((move) => move.to === "canceled");
  assert(
    "the move to review names all three unmet keys with the server's reasons; canceled none",
    toReview?.unmet === "run_completed non_empty_diff pr_link" &&
      toReview.note?.length === 3 &&
      truth4.requirements.every((r, index) =>
        toReview.note[index].includes(r.reason),
      ) &&
      toCanceled4?.unmet === null,
    JSON.stringify(moves4),
  );
  await page.screenshot({
    path: path.join(EVIDENCE_DIR, "exit-building-unmet.png"),
    fullPage: true,
  });

  assert(
    "the page logged no console error",
    consoleErrors.length === 0,
    JSON.stringify(consoleErrors.slice(0, 5)),
  );
} catch (error) {
  assert("the drive ran to the end", false, String(error));
  await page
    .screenshot({
      path: path.join(EVIDENCE_DIR, "exit-failure.png"),
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
