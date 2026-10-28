// Drive the definition editor (D6) the way an admin uses it, against the instance
// `definition-edit.sh` starts, and capture evidence.
//
//   node definition-edit.mjs      (via ./definition-edit.sh, which owns the instance this drives)
//
//   seed      a definition `edit<hex>` v1 authored over `defineBoard` (todo → doing → done, `doing`
//             with role builder, a skill, `pr_link`, a WIP limit of 2 and the gate `sign-off`, the
//             version capped at 3 runs a board), and a board pinned to it
//   open      the settings page's **Edit as new version** opens `/boards/$boardId/settings/edit` on
//             v1: no change listed yet, and Save offered only once there is one
//   pickers   every column's skill picker is a <select> whose options are `listSkills`' names less the
//             column's, its requires picker a <select> whose options are `getDefinitionVocabulary`'s
//             keys less the column's, and neither section holds a text field for a skill or a key
//   refused   a column added and renamed `qa`, with no moves out, saved: the server's refusal is shown
//             next to qa's moves (`columns[2].transitions`), and `listDefinitions` still holds v1 only
//   saved     qa given a move to done, a skill and `verified` from the pickers, and doing's move to
//             done pointed at qa: the diff names the column, Save says "v2 created", and over the RPC
//             (the oracle, never the page) `listDefinitions` holds v1 and v2, v2's columns are the
//             draft's — with doing's WIP limit and the version's caps kept though the editor has no
//             control for them — and the board is still pinned to v1
//   newer     once v2 exists the editor, still on the pin v1, says a save writes v3 from v1 without
//             v2's changes
//   again     a second Save of the same draft writes nothing: the page says v2 already holds it
//   typed     doing renamed key by key to `todo_x`, passing `todo`: the diff is the rename alone —
//             todo's move into doing follows doing, never the real todo it shared a name with
//   settings  the board's settings page still reads v1 and says v2 exists
//
// Env: WEB_URL, API_URL, EVIDENCE_DIR.
import { randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";

const WEB_URL = process.env["WEB_URL"] ?? "http://localhost:3475";
const API_URL = process.env["API_URL"] ?? "http://localhost:9475";
const EVIDENCE_DIR =
  process.env["EVIDENCE_DIR"] ?? ".verify/evidence/latest/definition-edit";

const TAG = randomBytes(4).toString("hex");
const DEFINITION_ID = `edit${TAG}`;
const REPO = `verify-definition-edit-${TAG}/board`;

await mkdir(EVIDENCE_DIR, { recursive: true });
await rm(path.join(EVIDENCE_DIR, "definition-edit-failure.png"), {
  force: true,
});

const observed = { webUrl: WEB_URL, apiUrl: API_URL, tag: TAG, checks: {} };
const assert = (name, condition, detail) => {
  observed.checks[name] = { passed: Boolean(condition), detail };
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}  ${detail}`);
  return Boolean(condition);
};

/** One unary RPC call over the NDJSON envelope, from this process: the oracle, never the page. */
const rpc = async (tag, payload) => {
  const requestId = `definition-edit-${tag}-${Date.now()}-${Math.random()}`;
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

const versionsOf = async (id) =>
  (
    (await rpc("listDefinitions", {})).find((entry) => entry.id === id)
      ?.versions ?? []
  ).map((entry) => entry.version);

const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const consoleErrors = [];
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});
page.on("pageerror", (error) =>
  consoleErrors.push(`pageerror: ${String(error)}`),
);

const shot = (name) =>
  page.screenshot({
    path: path.join(EVIDENCE_DIR, `definition-edit-${name}.png`),
    fullPage: true,
  });

const column = (name) => page.locator(`[data-editor-column='${name}']`);

/** A <select>'s option values, the placeholder (value "") left out. */
const optionValues = (locator) =>
  locator.evaluate((select) =>
    [...select.options].map((option) => option.value).filter((v) => v !== ""),
  );

let exitCode = 0;
try {
  // --- seed --------------------------------------------------------------------------------------
  const skills = (await rpc("listSkills", {})).map((skill) => skill.name);
  const vocabulary = await rpc("getDefinitionVocabulary", {});
  const keys = vocabulary.requirements.map((option) => option.key);
  observed.skills = skills;
  observed.keys = keys;
  const bound = skills[0];
  if (bound === undefined || skills.length < 2)
    throw new Error(`the skill library holds fewer than two skills: ${skills}`);
  const seeded = await rpc("defineBoard", {
    id: DEFINITION_ID,
    name: "Edited in the browser",
    initialColumn: "todo",
    caps: { board: 3 },
    columns: [
      {
        name: "todo",
        kind: "resting",
        skills: [],
        requires: [],
        transitions: [{ to: "doing" }, { to: "canceled" }],
      },
      {
        name: "doing",
        kind: "working",
        role: "builder",
        skills: [bound],
        requires: [{ key: "pr_link", description: "a PR link" }],
        transitions: [{ to: "done", gate: "sign-off" }, { to: "canceled" }],
        wipLimit: 2,
      },
      {
        name: "done",
        kind: "terminal",
        skills: [],
        requires: [],
        transitions: [],
      },
      {
        name: "canceled",
        kind: "terminal",
        skills: [],
        requires: [],
        transitions: [],
      },
    ],
  });
  const board = await rpc("createBoard", {
    repo: REPO,
    definitionId: DEFINITION_ID,
  });
  observed.board = board.id;
  assert(
    "the seed is v1 of its own definition, and the board pins it",
    seeded.outcome === "created" &&
      seeded.definition.version === 1 &&
      board.definitionVersion === 1,
    `${DEFINITION_ID} v${seeded.definition.version}, board ${board.id} pins v${board.definitionVersion}`,
  );

  // --- open --------------------------------------------------------------------------------------
  await page.goto(`${WEB_URL}/boards/${board.id}/settings`, {
    waitUntil: "domcontentloaded",
  });
  await page.locator("[data-settings-edit]").click();
  await page.waitForURL(`${WEB_URL}/boards/${board.id}/settings/edit`, {
    timeout: 15_000,
  });
  await page.waitForSelector(`[data-definition-editor='${board.id}']`, {
    timeout: 15_000,
  });
  const order = await page.$$eval("[data-editor-column]", (nodes) =>
    nodes.map((node) => node.getAttribute("data-editor-column")),
  );
  const pinnedVersion = await page
    .locator("[data-definition-editor]")
    .getAttribute("data-editor-pinned-version");
  assert(
    "Edit as new version opens the editor on the board's pinned version",
    pinnedVersion === "1" &&
      JSON.stringify(order) ===
        JSON.stringify(["todo", "doing", "done", "canceled"]),
    `v${pinnedVersion} ${JSON.stringify(order)}`,
  );
  assert(
    "nothing is listed as changed, and Save is not offered, before an edit",
    (await page.locator("[data-definition-diff-empty]").count()) === 1 &&
      (await page.locator("[data-definition-save]").isDisabled()),
    "diff empty, save disabled",
  );
  await shot("open");

  // --- pickers -----------------------------------------------------------------------------------
  const pickerReport = [];
  let pickersOk = true;
  for (const name of order) {
    const scope = column(name);
    const skillPicker = scope.locator("[data-skill-picker]");
    const requiresPicker = scope.locator("[data-requires-picker]");
    const skillTag = await skillPicker.evaluate((node) => node.tagName);
    const requiresTag = await requiresPicker.evaluate((node) => node.tagName);
    const columnSkills = await scope
      .locator("[data-column-skill]")
      .evaluateAll((nodes) =>
        nodes.map((node) => node.getAttribute("data-column-skill")),
      );
    const columnKeys = await scope
      .locator("[data-column-requirement]")
      .evaluateAll((nodes) =>
        nodes.map((node) => node.getAttribute("data-column-requirement")),
      );
    const offeredSkills = await optionValues(skillPicker);
    const offeredKeys = await optionValues(requiresPicker);
    const expectedSkills = [...new Set(skills)]
      .filter((skill) => !columnSkills.includes(skill))
      .sort();
    const expectedKeys = keys.filter((key) => !columnKeys.includes(key));
    // A skill section holds no text field at all; a requires section only the descriptions.
    const skillText = await scope
      .locator(
        "[data-column-skills] :is(input, textarea, [contenteditable='true'])",
      )
      .count();
    const keyText = await scope
      .locator(
        "[data-column-requires] :is(input, textarea, [contenteditable='true']):not([data-requirement-description-input])",
      )
      .count();
    const ok =
      skillTag === "SELECT" &&
      requiresTag === "SELECT" &&
      JSON.stringify(offeredSkills) === JSON.stringify(expectedSkills) &&
      JSON.stringify(offeredKeys) === JSON.stringify(expectedKeys) &&
      skillText === 0 &&
      keyText === 0;
    pickersOk &&= ok;
    pickerReport.push({ name, offeredSkills, offeredKeys, skillText, keyText });
  }
  const datalists = await page
    .locator("[data-definition-editor] datalist")
    .count();
  observed.pickers = pickerReport;
  assert(
    "every skill and requires picker is a select of the server's names, and no field takes a typed skill or key",
    pickersOk && datalists === 0,
    JSON.stringify(
      pickerReport.map((entry) => [
        entry.name,
        entry.offeredSkills.length,
        entry.offeredKeys.length,
      ]),
    ),
  );

  // --- refused -----------------------------------------------------------------------------------
  await page.locator("[data-add-column]").click();
  await column("new_column").locator("[data-column-name-input]").fill("qa");
  await column("qa").waitFor({ timeout: 5_000 });
  const added = await page.$$eval("[data-editor-column]", (nodes) =>
    nodes.map((node) => node.getAttribute("data-editor-column")),
  );
  assert(
    "Add a column puts a working column before the first terminal one",
    JSON.stringify(added) ===
      JSON.stringify(["todo", "doing", "qa", "done", "canceled"]) &&
      (await column("qa").locator("[data-column-kind-select]").inputValue()) ===
        "working",
    JSON.stringify(added),
  );
  await page.locator("[data-definition-save]").click();
  const inline = column("qa").locator(
    "[data-field-fault='columns[2].transitions']",
  );
  await inline.waitFor({ timeout: 15_000 });
  const inlineText = (await inline.textContent())?.trim() ?? "";
  const refusalTag = await page
    .locator("[data-define-refusal]")
    .getAttribute("data-define-refusal");
  assert(
    "the server's refusal is shown next to the offending field, in the server's words",
    refusalTag === "InvalidDefinition" &&
      inlineText.includes(
        'column "qa" is not terminal and declares no moves out',
      ),
    `${refusalTag}: ${inlineText}`,
  );
  assert(
    "a refused save writes nothing",
    JSON.stringify(await versionsOf(DEFINITION_ID)) === JSON.stringify([1]),
    JSON.stringify(await versionsOf(DEFINITION_ID)),
  );
  await shot("refused");

  // --- saved -------------------------------------------------------------------------------------
  const qa = column("qa");
  await qa.locator("[data-add-move]").click();
  await qa.locator("[data-move-to]").first().selectOption("done");
  const qaSkill = (await optionValues(qa.locator("[data-skill-picker]")))[0];
  await qa.locator("[data-skill-picker]").selectOption(qaSkill);
  await qa.locator("[data-requires-picker]").selectOption("verified");
  await column("doing").locator("[data-move-to]").first().selectOption("qa");
  const diff = await page.$$eval("[data-diff-line]", (nodes) =>
    nodes.map((node) => node.textContent?.trim() ?? ""),
  );
  observed.diff = diff;
  assert(
    "the diff against v1 names the added column and the move pointed at it",
    diff.some((line) =>
      line.includes(
        `column "qa" (working; skills ${qaSkill}; requires verified; moves to done)`,
      ),
    ) &&
      diff.some((line) =>
        line.includes('"doing" move to "qa" across the gate "sign-off"'),
      ) &&
      diff.some((line) => line.includes('"doing" move to "done"')),
    JSON.stringify(diff),
  );
  await shot("diff");
  await page.locator("[data-definition-save]").click();
  const saved = page.locator("[data-definition-saved='created']");
  await saved.waitFor({ timeout: 15_000 });
  const savedText = (await saved.textContent())?.trim() ?? "";
  assert(
    'Save says "v2 created", and that the board keeps its pin',
    (await saved.getAttribute("data-saved-version")) === "2" &&
      savedText.startsWith("v2 created.") &&
      savedText.includes("This board stays pinned to v1 until it is upgraded"),
    savedText,
  );
  assert(
    "the refusal is gone once the save is accepted",
    (await page.locator("[data-define-refusal]").count()) === 0 &&
      (await page.locator("[data-field-fault]").count()) === 0,
    "no refusal on the page",
  );
  await shot("saved");

  // --- newer -------------------------------------------------------------------------------------
  const superseding = page.locator("[data-editor-newer-versions]");
  await superseding.waitFor({ timeout: 15_000 });
  const supersedingText = (await superseding.textContent())?.trim() ?? "";
  assert(
    "the editor, still on v1, says v2 exists and a save writes v3 without v2's changes",
    (await superseding.getAttribute("data-editor-newer-versions")) === "2" &&
      supersedingText.includes("this draft starts from v1") &&
      supersedingText.includes("Saving writes v3"),
    supersedingText,
  );

  const versions = await versionsOf(DEFINITION_ID);
  assert(
    "listDefinitions holds version N+1",
    JSON.stringify(versions) === JSON.stringify([1, 2]),
    JSON.stringify(versions),
  );
  const v2 = await rpc("getDefinition", {
    definitionId: DEFINITION_ID,
    version: 2,
  });
  const byName = Object.fromEntries(
    v2.columns.map((entry) => [entry.name, entry]),
  );
  observed.v2 = v2;
  assert(
    "v2 is the draft: qa between doing and done, with the picked skill, requirement and move",
    JSON.stringify(v2.columns.map((entry) => entry.name)) ===
      JSON.stringify(["todo", "doing", "qa", "done", "canceled"]) &&
      byName.qa?.kind === "working" &&
      JSON.stringify(byName.qa?.skills) === JSON.stringify([qaSkill]) &&
      JSON.stringify(byName.qa?.requires.map((entry) => entry.key)) ===
        JSON.stringify(["verified"]) &&
      JSON.stringify(byName.qa?.exits) === JSON.stringify([{ to: "done" }]) &&
      JSON.stringify(byName.doing?.exits) ===
        JSON.stringify([
          { to: "qa", humanGate: "sign-off" },
          { to: "canceled" },
        ]),
    JSON.stringify(v2.columns.map((entry) => [entry.name, entry.exits])),
  );
  assert(
    "fields the editor has no control for come through: doing's WIP limit and the caps",
    byName.doing?.wipLimit === 2 &&
      JSON.stringify(v2.caps) === JSON.stringify({ board: 3 }) &&
      byName.doing?.role === "builder" &&
      JSON.stringify(byName.doing?.skills) === JSON.stringify([bound]),
    JSON.stringify({ wipLimit: byName.doing?.wipLimit, caps: v2.caps }),
  );
  assert(
    "v2 names the dashboard as its author (F7); v1, written over the RPC with no actor, has none",
    v2.author === "dashboard" && seeded.definition?.author === undefined,
    JSON.stringify({ v2: v2.author, v1: seeded.definition?.author }),
  );
  const after = await rpc("getBoard", { boardId: board.id });
  assert(
    "the board keeps its pin: still v1",
    after.instance.definitionVersion === 1 && after.definition.version === 1,
    `v${after.instance.definitionVersion}`,
  );

  // --- again -------------------------------------------------------------------------------------
  await page.locator("[data-definition-save]").click();
  const unchanged = page.locator("[data-definition-saved='unchanged']");
  await unchanged.waitFor({ timeout: 15_000 });
  assert(
    "saving the same draft again writes nothing, and says v2 holds it",
    (await unchanged.getAttribute("data-saved-version")) === "2" &&
      JSON.stringify(await versionsOf(DEFINITION_ID)) ===
        JSON.stringify([1, 2]),
    (await unchanged.textContent())?.trim() ?? "",
  );

  // --- typed -------------------------------------------------------------------------------------
  const doingName = page.locator(
    "[data-editor-column-origin='doing'] [data-column-name-input]",
  );
  await doingName.fill("");
  await doingName.pressSequentially("todo_x");
  const typedDiff = await page.$$eval("[data-diff-line]", (nodes) =>
    nodes.map((node) => node.textContent?.trim() ?? ""),
  );
  const todoMoves = await page.$$eval(
    "[data-editor-column-origin='todo'] [data-column-move]",
    (nodes) => nodes.map((node) => node.getAttribute("data-column-move")),
  );
  observed.typedDiff = typedDiff;
  assert(
    "a rename typed through another column's name keeps the moves on the renamed column",
    JSON.stringify(todoMoves) === JSON.stringify(["todo_x", "canceled"]) &&
      typedDiff.some((line) =>
        line.includes('column "doing" renamed to "todo_x"'),
      ) &&
      !typedDiff.some((line) => line.includes('"todo" move to')),
    JSON.stringify({ todoMoves, typedDiff }),
  );
  await shot("typed");

  // --- settings ----------------------------------------------------------------------------------
  await page.locator("[data-editor-settings-link]").click();
  await page.waitForURL(`${WEB_URL}/boards/${board.id}/settings`, {
    timeout: 15_000,
  });
  const newer = page.locator("[data-newer-versions]");
  await newer.waitFor({ timeout: 15_000 });
  assert(
    "the settings page still reads v1, and says v2 exists",
    (await page
      .locator("[data-settings-definition]")
      .getAttribute("data-settings-version")) === "1" &&
      (await newer.getAttribute("data-newer-versions")) === "2",
    (await newer.textContent())?.trim() ?? "",
  );
  await shot("settings");

  // --- refused ids -------------------------------------------------------------------------------
  await page.goto(
    `${WEB_URL}/boards/brd_00000000000000000000000000/settings/edit`,
    {
      waitUntil: "domcontentloaded",
    },
  );
  assert(
    "the editor of a board the server does not hold says there is no such board",
    await page
      .getByText("No such board")
      .waitFor({ timeout: 15_000 })
      .then(() => true)
      .catch(() => false),
    "brd_00000000000000000000000000",
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
      path: path.join(EVIDENCE_DIR, "definition-edit-failure.png"),
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
