// Drive the card pane's state controls (C11) the way an operator uses them, against the instance
// `card-edit.sh` starts, and capture evidence.
//
//   node card-edit.mjs      (via ./card-edit.sh, which owns the instance this drives)
//
//   block     Block with reason `dependency` and a note: the lane's card shows the blocked label, the
//             pane says what it waits on, and `factory board show` prints the block and its note
//   unblock   Unblock clears the label on the lane, and `board show` prints no block
//   urgent    the priority toggle marks the card urgent: the lane shows the urgent marker and lists
//             the card first; `board show` prints priority urgent. Pressing it again clears it
//   title     the pencil turns the title into an input; Enter saves; the lane and `board show` read
//             the new title; a blank title is not sent (the save is disabled, no request made)
//   stale     a write made elsewhere (the oracle, over the RPC) while the pane still shows the old
//             revision: the pane's block is refused with the server's own words, nothing is
//             blocked, and the refusal goes once the board read catches up
//   cli       `factory board update` fixes a title and priority the dashboard then shows
//
// The oracle is `factory board show` and the RPC, asked from this process, never the page.
//
// Env: WEB_URL, API_URL, EVIDENCE_DIR.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const WEB_URL = process.env["WEB_URL"] ?? "http://localhost:3583";
const API_URL = process.env["API_URL"] ?? "http://localhost:9583";
const EVIDENCE_DIR =
  process.env["EVIDENCE_DIR"] ?? ".verify/evidence/latest/card-edit";
const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const ACTOR = "person:verify-card-edit";

await mkdir(EVIDENCE_DIR, { recursive: true });
await rm(path.join(EVIDENCE_DIR, "card-edit-failure.png"), { force: true });

const observed = { webUrl: WEB_URL, apiUrl: API_URL, checks: {} };
const assert = (name, condition, detail) => {
  observed.checks[name] = { passed: Boolean(condition), detail };
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}  ${detail}`);
  return Boolean(condition);
};

/** One unary RPC call over the NDJSON envelope, from this process: the oracle, never the page. */
const rpc = async (tag, payload) => {
  const requestId = `card-edit-${tag}-${Date.now()}-${Math.random()}`;
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
/** `factory board show` as fields: `key   value` lines. */
const show = (taskId) => {
  const out = factory(["board", "show", "--task", taskId]);
  const fields = {};
  for (const line of out.stdout.split("\n")) {
    const match = /^(\w+)\s+(.*)$/.exec(line);
    if (match && fields[match[1]] === undefined) fields[match[1]] = match[2];
  }
  return { ...out, fields };
};

const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const consoleErrors = [];
page.on("console", (message) => {
  // The stale case aborts the board read on purpose; the browser logs that as a failed load.
  if (
    message.type() === "error" &&
    !/ERR_FAILED|Failed to load/.test(message.text())
  )
    consoleErrors.push(message.text());
});
page.on("pageerror", (error) =>
  consoleErrors.push(`pageerror: ${String(error)}`),
);

const lane = (id) => page.locator(`[data-card="${id}"]`);
const pane = (id) => page.locator(`aside[data-card-pane="${id}"]`);
const shot = (name) =>
  page.screenshot({
    path: path.join(EVIDENCE_DIR, `card-edit-${name}.png`),
    fullPage: true,
  });
/** The cards of a lane in the order the page lists them. */
const laneOrder = () =>
  page
    .locator("[data-lane='intake'] [data-card]")
    .evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute("data-card")),
    );

let exitCode = 0;
try {
  const repo = `verify-card-edit/${randomBytes(6).toString("hex")}`;
  const board = await rpc("createBoard", { repo, definitionId: "default" });
  const mk = (title) =>
    rpc("createTask", { boardId: board.id, title, actor: ACTOR });
  // The neighbour is older, so it reads first in the lane until the card is flagged urgent (B9).
  const other = await mk("an older neighbour");
  const card = await mk("park me");
  observed.repo = repo;
  observed.board = board.id;
  observed.card = card.id;

  await page.goto(`${WEB_URL}/boards/${board.id}?card=${card.id}`, {
    waitUntil: "domcontentloaded",
  });
  await pane(card.id).waitFor({ timeout: 20_000 });
  await shot("open");

  // --- block ------------------------------------------------------------------------------------
  await pane(card.id).locator("[data-card-block-open]").click();
  await pane(card.id).locator("[data-block-reason='dependency']").check();
  await pane(card.id)
    .locator("[data-card-block-note-input]")
    .fill("waiting on the schema PR");
  await shot("block-form");
  await pane(card.id).locator("[data-card-block-submit]").click();
  await lane(card.id)
    .getByText("blocked · waiting on a dependency")
    .waitFor({ timeout: 15_000 });
  await shot("blocked");
  const blockedShow = show(card.id);
  assert(
    "blocking with reason dependency shows the blocked label on the lane and in the pane",
    (await lane(card.id).count()) === 1 &&
      (await pane(card.id).getAttribute("data-card-pane-blocked")) ===
        "dependency" &&
      (await pane(card.id).locator("[data-card-unblock]").count()) === 1,
    `lane label ${JSON.stringify(await lane(card.id).locator("text=blocked ·").allInnerTexts())}`,
  );
  assert(
    "the block is what factory board show prints, note included, one revision on",
    blockedShow.status === 0 &&
      /^dependency from intake since /.test(blockedShow.fields.blocked ?? "") &&
      blockedShow.stdout.includes("waiting on the schema PR") &&
      blockedShow.fields.revision === "2",
    `show exit ${String(blockedShow.status)}: ${JSON.stringify(blockedShow.stdout.split("\n").slice(0, 8))}`,
  );

  // --- unblock ----------------------------------------------------------------------------------
  await pane(card.id).locator("[data-card-unblock]").click();
  await pane(card.id)
    .locator("[data-card-block-open]")
    .waitFor({ timeout: 15_000 });
  await lane(card.id)
    .getByText("blocked ·")
    .waitFor({ state: "detached", timeout: 15_000 });
  await shot("unblocked");
  const unblockedShow = show(card.id);
  assert(
    "Unblock clears the blocked label on the lane, and factory board show prints no block",
    (await lane(card.id).getByText("blocked ·").count()) === 0 &&
      (await pane(card.id).getAttribute("data-card-pane-blocked")) === null &&
      unblockedShow.fields.blocked === "-" &&
      unblockedShow.fields.revision === "3",
    `show blocked ${JSON.stringify(unblockedShow.fields.blocked)} revision ${JSON.stringify(unblockedShow.fields.revision)}`,
  );

  // --- urgent -----------------------------------------------------------------------------------
  const before = await laneOrder();
  await pane(card.id).locator("[data-card-priority='normal']").click();
  await pane(card.id)
    .locator("[data-card-priority='urgent']")
    .waitFor({ timeout: 15_000 });
  await lane(card.id).getByText("urgent", { exact: true }).waitFor({
    timeout: 15_000,
  });
  const after = await laneOrder();
  await shot("urgent");
  const urgentShow = show(card.id);
  assert(
    "setting priority to urgent shows the urgent marker on the lane, and lists the card first",
    (await lane(card.id).getByText("urgent", { exact: true }).count()) === 1 &&
      JSON.stringify(before) === JSON.stringify([other.id, card.id]) &&
      after[0] === card.id &&
      urgentShow.fields.priority === "urgent" &&
      urgentShow.fields.revision === "4",
    `lane order ${JSON.stringify(before)} → ${JSON.stringify(after)}; show priority ${JSON.stringify(urgentShow.fields.priority)}`,
  );
  await pane(card.id).locator("[data-card-priority='urgent']").click();
  await pane(card.id)
    .locator("[data-card-priority='normal']")
    .waitFor({ timeout: 15_000 });
  await lane(card.id)
    .getByText("urgent", { exact: true })
    .waitFor({ state: "detached", timeout: 15_000 });
  assert(
    "pressing it again clears the flag on the lane and in factory board show",
    show(card.id).fields.priority === "normal",
    `show priority ${JSON.stringify(show(card.id).fields.priority)}`,
  );

  // --- title ------------------------------------------------------------------------------------
  await pane(card.id).locator("[data-card-title-edit]").click();
  const input = pane(card.id).locator("[data-card-title-input]");
  await input.fill("   ");
  const blankDisabled = await pane(card.id)
    .locator("[data-card-title-save]")
    .isDisabled();
  await input.fill("park me (retitled)");
  await shot("title-edit");
  await input.press("Enter");
  await lane(card.id)
    .getByText("park me (retitled)")
    .waitFor({ timeout: 15_000 });
  await pane(card.id)
    .locator("[data-card-title]", { hasText: "park me (retitled)" })
    .waitFor({ timeout: 15_000 });
  const titleShow = show(card.id);
  assert(
    "editing the title in the pane retitles the card on the lane, and a blank title cannot be saved",
    blankDisabled &&
      titleShow.fields.title === "park me (retitled)" &&
      titleShow.fields.revision === "6",
    `blank save disabled ${String(blankDisabled)}; show title ${JSON.stringify(titleShow.fields.title)} revision ${JSON.stringify(titleShow.fields.revision)}`,
  );

  // --- stale ------------------------------------------------------------------------------------
  // Hold the page's board reads so the pane keeps the revision it has while the oracle writes at
  // the server: the click is then made from a stale view, which is exactly what the revision is for.
  const heldReads = [];
  await page.route(/\/rpc\/?$/, (route) => {
    const body = route.request().postData() ?? "";
    if (/"tag":"(getBoard|listBoardCards)"/.test(body)) {
      heldReads.push(Date.now());
      return route.abort();
    }
    return route.continue();
  });
  const paneRevision = Number(
    await pane(card.id).getAttribute("data-card-pane-revision"),
  );
  await rpc("blockTask", {
    taskId: card.id,
    expectedRevision: paneRevision,
    reason: "transient",
    note: "blocked behind the pane's back",
    actor: ACTOR,
  });
  await pane(card.id).locator("[data-card-block-open]").click();
  await pane(card.id).locator("[data-card-block-submit]").click();
  const refusal = pane(card.id).locator("[data-card-edit-refusal]");
  await refusal.waitFor({ timeout: 15_000 });
  const refusalTag = await refusal.getAttribute("data-card-edit-refusal");
  const refusalText = await refusal.innerText();
  await shot("stale");
  const staleShow = show(card.id);
  assert(
    "a stale revision shows the server's refusal, and the card keeps the other write's block",
    refusalTag === "StaleRevision" &&
      refusalText.includes(
        `revision ${paneRevision + 1}, not ${paneRevision}`,
      ) &&
      /^transient from intake/.test(staleShow.fields.blocked ?? "") &&
      staleShow.fields.revision === String(paneRevision + 1),
    `refusal ${refusalTag}: ${JSON.stringify(refusalText.slice(0, 200))}; show blocked ${JSON.stringify(staleShow.fields.blocked)}`,
  );
  // Let the page read the board again: it shows the other write's block, and the refusal still
  // describes the revision the server held when it refused (as a move's does), so the person sees why
  // their block did nothing. The next write of the person's own clears it.
  await page.unroute(/\/rpc\/?$/);
  await page
    .locator(
      `aside[data-card-pane="${card.id}"][data-card-pane-blocked="transient"]`,
    )
    .waitFor({ timeout: 15_000 });
  assert(
    "once the board is read again the pane shows the other write's block beside the refusal",
    (await pane(card.id).getAttribute("data-card-pane-revision")) ===
      String(paneRevision + 1) &&
      (await refusal.count()) === 1 &&
      (await pane(card.id).locator("[data-card-unblock]").count()) === 1,
    `held ${heldReads.length} board read(s); pane revision ${await pane(card.id).getAttribute("data-card-pane-revision")}`,
  );
  await pane(card.id).locator("[data-card-unblock]").click();
  await pane(card.id)
    .locator("[data-card-block-open]")
    .waitFor({ timeout: 15_000 });
  assert(
    "the person's next write at the revision the pane now shows lands and clears the refusal",
    (await refusal.count()) === 0 && show(card.id).fields.blocked === "-",
    `refusals ${await refusal.count()}; show blocked ${JSON.stringify(show(card.id).fields.blocked)}`,
  );

  // --- cli --------------------------------------------------------------------------------------
  const updated = factory([
    "board",
    "update",
    "--task",
    card.id,
    "--title",
    "fixed from the CLI",
    "--priority",
    "urgent",
  ]);
  await lane(card.id)
    .getByText("fixed from the CLI")
    .waitFor({ timeout: 15_000 });
  await lane(card.id).getByText("urgent", { exact: true }).waitFor({
    timeout: 15_000,
  });
  const cliShow = show(card.id);
  assert(
    "factory board update fixes a title and priority that the dashboard shows on the lane",
    updated.status === 0 &&
      /^updated /.test(updated.stdout) &&
      cliShow.fields.title === "fixed from the CLI" &&
      cliShow.fields.priority === "urgent",
    `update exit ${String(updated.status)}: ${JSON.stringify(updated.stdout.split("\n")[0])}`,
  );
  await shot("cli");

  assert(
    "the page logged no console error",
    consoleErrors.length === 0,
    JSON.stringify(consoleErrors.slice(0, 5)),
  );
} catch (error) {
  assert("the drive ran to the end", false, String(error));
  await page
    .screenshot({
      path: path.join(EVIDENCE_DIR, "card-edit-failure.png"),
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
