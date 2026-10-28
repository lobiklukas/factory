// Drive the definition editor's role field (F4) against an instance with NO role table (no
// `ROLE_MODELS`), which `definition-edit.sh` starts beside the main one: `defineBoard` then accepts any
// role name, so the editor takes a typed one.
//
//   node definition-edit-roles.mjs      (via ./definition-edit.sh, which owns the instance this drives)
//
//   vocab    `getDefinitionVocabulary` says roles are open, and still lists the harness's roles
//   field    every column's role is a text field with a datalist of exactly the vocabulary's roles
//            (and the column's own), and none is a <select>
//   typed    doing's role typed as a name no list holds: the diff names it, Save says "v2 created",
//            over the RPC (the oracle) v2's doing column holds it, and the settings page of a board
//            made on v2 shows it as doing's role
//   cleared  an emptied role field is no role
//
// Env: WEB_URL, API_URL, EVIDENCE_DIR.
import { randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";

const WEB_URL = process.env["WEB_URL"] ?? "http://localhost:3476";
const API_URL = process.env["API_URL"] ?? "http://localhost:9476";
const EVIDENCE_DIR =
  process.env["EVIDENCE_DIR"] ?? ".verify/evidence/latest/definition-edit";

const TAG = randomBytes(4).toString("hex");
const DEFINITION_ID = `roles${TAG}`;
const REPO = `verify-definition-roles-${TAG}/board`;
const NEW_ROLE = `triager-${TAG}`;

await mkdir(EVIDENCE_DIR, { recursive: true });
await rm(path.join(EVIDENCE_DIR, "definition-edit-roles-failure.png"), {
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
  const requestId = `definition-roles-${tag}-${Date.now()}-${Math.random()}`;
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
    path: path.join(EVIDENCE_DIR, `definition-edit-roles-${name}.png`),
    fullPage: true,
  });
const column = (name) => page.locator(`[data-editor-column='${name}']`);

let exitCode = 0;
try {
  const vocabulary = await rpc("getDefinitionVocabulary", {});
  observed.vocabulary = vocabulary;
  assert(
    "with no role table the vocabulary says roles are open, and still lists the harness's",
    vocabulary.rolesOpen === true &&
      ["planner", "reviewer", "specifier"].every((role) =>
        vocabulary.roles.includes(role),
      ) &&
      !vocabulary.roles.includes(NEW_ROLE),
    JSON.stringify(vocabulary.roles),
  );

  await rpc("defineBoard", {
    id: DEFINITION_ID,
    name: "Typed roles",
    initialColumn: "todo",
    columns: [
      {
        name: "todo",
        kind: "resting",
        skills: [],
        requires: [],
        transitions: [{ to: "doing" }],
      },
      {
        name: "doing",
        kind: "working",
        role: "reviewer",
        skills: [],
        requires: [],
        transitions: [{ to: "done" }],
      },
      {
        name: "done",
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
  await page.goto(`${WEB_URL}/boards/${board.id}/settings/edit`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForSelector(`[data-definition-editor='${board.id}']`, {
    timeout: 15_000,
  });

  const fields = await page.$$eval("[data-editor-column]", (nodes) =>
    nodes.map((node) => {
      const input = node.querySelector("[data-column-role-input]");
      const list = input?.getAttribute("list");
      return {
        name: node.getAttribute("data-editor-column"),
        input: input !== null,
        select: node.querySelector("[data-column-role-select]") !== null,
        value: input?.value ?? null,
        suggestions: list
          ? [...document.querySelectorAll(`#${CSS.escape(list)} option`)].map(
              (option) => option.value,
            )
          : [],
      };
    }),
  );
  observed.fields = fields;
  assert(
    "every column's role is a text field with the vocabulary's roles as suggestions, never a select",
    fields.length === 3 &&
      fields.every(
        (field) =>
          field.input &&
          !field.select &&
          JSON.stringify(field.suggestions) ===
            JSON.stringify([...vocabulary.roles].sort()),
      ) &&
      fields.find((field) => field.name === "doing")?.value === "reviewer",
    JSON.stringify(
      fields.map((field) => [
        field.name,
        field.value,
        field.suggestions.length,
      ]),
    ),
  );
  await shot("open");

  const role = column("doing").locator("[data-column-role-input]");
  await role.fill(NEW_ROLE);
  const diff = await page.$$eval("[data-diff-line]", (nodes) =>
    nodes.map((node) => node.textContent?.trim() ?? ""),
  );
  assert(
    "typing a role no list holds is a change the diff names",
    diff.length === 1 &&
      diff[0].endsWith(`"doing" role: reviewer → ${NEW_ROLE}`),
    JSON.stringify(diff),
  );
  await page.locator("[data-definition-save]").click();
  const saved = page.locator("[data-definition-saved='created']");
  await saved.waitFor({ timeout: 15_000 });
  assert(
    "the typed role saves as v2",
    (await saved.getAttribute("data-saved-version")) === "2",
    (await saved.textContent())?.trim() ?? "",
  );
  await shot("saved");

  const onV2 = await rpc("createBoard", {
    repo: `${REPO}-v2`,
    definitionId: DEFINITION_ID,
    definitionVersion: 2,
  });
  const stored = await rpc("getBoard", { boardId: onV2.id });
  const doing = stored.definition.columns.find(
    (entry) => entry.name === "doing",
  );
  await page.goto(`${WEB_URL}/boards/${onV2.id}/settings`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForSelector(
    "[data-column-settings='doing'] [data-column-role]",
    {
      timeout: 15_000,
    },
  );
  const shown = (
    await page
      .locator("[data-column-settings='doing'] [data-column-role]")
      .textContent()
  )?.trim();
  assert(
    "v2 holds the typed role, and the settings page of a board on it shows it",
    doing?.role === NEW_ROLE && shown === NEW_ROLE,
    JSON.stringify({ stored: doing?.role, shown }),
  );
  await shot("settings");

  // An emptied field is no role at all.
  await page.goto(`${WEB_URL}/boards/${onV2.id}/settings/edit`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForSelector(`[data-definition-editor='${onV2.id}']`, {
    timeout: 15_000,
  });
  await column("doing").locator("[data-column-role-input]").fill("");
  const cleared = await page.$$eval("[data-diff-line]", (nodes) =>
    nodes.map((node) => node.textContent?.trim() ?? ""),
  );
  assert(
    "emptying the role field removes the role",
    cleared.length === 1 &&
      cleared[0].endsWith(`"doing" role: ${NEW_ROLE} → —`),
    JSON.stringify(cleared),
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
      path: path.join(EVIDENCE_DIR, "definition-edit-roles-failure.png"),
      fullPage: true,
    })
    .catch(() => {});
} finally {
  observed.consoleErrors = consoleErrors;
  await writeFile(
    path.join(EVIDENCE_DIR, "observed-roles.json"),
    `${JSON.stringify(observed, null, 2)}\n`,
  );
  await browser.close();
  exitCode = Object.values(observed.checks).every((check) => check.passed)
    ? 0
    : 1;
}
process.exit(exitCode);
