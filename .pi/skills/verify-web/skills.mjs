// Drive the skill pages (D8) the way an operator uses them, against the instance `skills.sh` starts
// (its own API, dashboard and throwaway database), and capture evidence.
//
//   node skills.mjs      (via ./skills.sh, which owns the instance)
//
//   reach     a board's Settings page links each column's skill to its page: `specifying`'s `specify`
//             opens `/skills/specify`; the rail's **Skills** opens `/skills`
//   list      `/skills` lists exactly `listSkills`: every name once, at its newest version, with the
//             default definition's columns that bind it
//   page      `/skills/specify` shows `getSkill`'s body, version, description and author, the columns
//             `listSkills` names (`specifying`), and the history `listSkillVersions` answers
//   unchanged Publish with nothing edited is stopped in the form: no `putSkill` leaves the page
//   created  an edited body publishes: the page says "v<n+1> created", shows the new body as the
//             newest, lists v<n+1> at the top of the history without a reload, `getSkill` and
//             `factory skill show specify` answer the new body at v<n+1>, and v<n> is untouched
//   refused   a blank body is the server's `InvalidSkill`, shown inline in the server's words (the
//             same call made from this process answers the same message), the form keeps what was
//             typed, and nothing is written (`listSkillVersions` unchanged)
//   older     a history entry opens that version: its body, and a notice naming the newest with a
//             link back to it
//   missing   `/skills/<unknown>` reads "No such skill", `/skills/specify?version=99` "No such
//             version"; no console error over the whole drive
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
const WEB_URL = process.env["WEB_URL"] ?? "http://localhost:3591";
const API_URL = process.env["API_URL"] ?? "http://localhost:9591";
const EVIDENCE_DIR =
  process.env["EVIDENCE_DIR"] ?? ".verify/evidence/latest/skills";

const TAG = randomBytes(4).toString("hex");
const SKILL = "specify";
const REPO = `verify-skills-${TAG}/board`;
const EDITED_LINE = `Ask about the risks first (verify-web skills ${TAG}).`;

await mkdir(EVIDENCE_DIR, { recursive: true });
await rm(path.join(EVIDENCE_DIR, "skills-failure.png"), { force: true });

const observed = { webUrl: WEB_URL, apiUrl: API_URL, tag: TAG, checks: {} };
const assert = (name, condition, detail) => {
  observed.checks[name] = { passed: Boolean(condition), detail };
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}  ${detail}`);
  return Boolean(condition);
};

/** One unary RPC call over the NDJSON envelope, from this process: the oracle, never the page. */
const rpcExit = async (tag, payload) => {
  const requestId = `skills-${tag}-${Date.now()}-${Math.random()}`;
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
  const errorTag =
    /"_tag":"(InvalidSkill|SkillNotFound|SkillStorageError)"/.exec(
      failure,
    )?.[1];
  return {
    exit,
    tag: errorTag,
    message: message === undefined ? undefined : JSON.parse(`"${message}"`),
  };
};
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
const puts = () => sentTags.filter((tag) => tag === "putSkill").length;

const shot = (name) =>
  page.screenshot({
    path: path.join(EVIDENCE_DIR, `skills-${name}.png`),
    fullPage: true,
  });

/** What the skill page shows, read back from its `data-*` hooks. */
const readPage = async () =>
  await page.evaluate(() => {
    const root = document.querySelector("[data-skill-page]");
    const text = (selector) =>
      root?.querySelector(selector)?.textContent?.trim() ?? null;
    return {
      name: root?.getAttribute("data-skill-page") ?? null,
      shown: Number(root?.getAttribute("data-skill-shown-version")),
      newest: Number(root?.getAttribute("data-skill-newest")),
      // The body as the `pre` holds it: exact text, not trimmed.
      body: root?.querySelector("[data-skill-body]")?.textContent ?? null,
      description: text("[data-skill-description]"),
      author: text("[data-skill-author]"),
      usedBy:
        root
          ?.querySelector("[data-skill-used-by]")
          ?.getAttribute("data-skill-used-by") ?? null,
      history: [
        ...(root?.querySelectorAll("[data-skill-history-version]") ?? []),
      ].map((node) => ({
        version: Number(node.getAttribute("data-skill-history-version")),
        current:
          node.querySelector("a")?.getAttribute("aria-current") === "page",
      })),
      older: text("[data-skill-older]"),
    };
  });

/** Waits until the page shows `version` of the skill, as the newest when `newest` is given. */
const waitShown = async (version, newest = version) =>
  await page.waitForFunction(
    ([v, n]) => {
      const root = document.querySelector("[data-skill-page]");
      return (
        root?.getAttribute("data-skill-shown-version") === String(v) &&
        root?.getAttribute("data-skill-newest") === String(n)
      );
    },
    [version, newest],
    { timeout: 20_000 },
  );

let exitCode = 1;
try {
  // --- reach: the settings page's skill link ----------------------------------------------------
  const board = await rpc("createBoard", {
    repo: REPO,
    definitionId: "default",
  });
  observed.board = board.id;
  await page.goto(`${WEB_URL}/boards/${board.id}/settings`, {
    waitUntil: "domcontentloaded",
  });
  const link = page.locator(
    `[data-settings-column='specifying'] [data-column-skill-link='${SKILL}']`,
  );
  await link.waitFor({ timeout: 20_000 });
  const href = await link.getAttribute("href");
  await link.click();
  await page.waitForSelector(`[data-skill-page='${SKILL}']`, {
    timeout: 20_000,
  });
  assert(
    "the settings page links specifying's specify to its skill page",
    href === `/skills/${SKILL}` &&
      new URL(page.url()).pathname === `/skills/${SKILL}`,
    `${href} → ${page.url()}`,
  );

  // --- list: /skills equals listSkills ----------------------------------------------------------
  await page.goto(`${WEB_URL}/boards`, { waitUntil: "domcontentloaded" });
  await page.locator("nav[aria-label='Sections'] a[href='/skills']").click();
  await page.waitForSelector("[data-skill-row]", { timeout: 20_000 });
  const listed = await rpc("listSkills", {});
  const rows = await page.evaluate(() =>
    [...document.querySelectorAll("[data-skill-row]")].map((node) => ({
      name: node.getAttribute("data-skill-row"),
      version: Number(node.getAttribute("data-skill-version")),
      columns:
        node
          .querySelector("[data-skill-columns]")
          ?.getAttribute("data-skill-columns") ?? null,
    })),
  );
  observed.list = { page: rows, oracle: listed };
  await shot("list");
  assert(
    "the rail's Skills opens /skills, listing exactly listSkills' names, versions and columns",
    new URL(page.url()).pathname === "/skills" &&
      JSON.stringify(rows) ===
        JSON.stringify(
          listed.map((skill) => ({
            name: skill.name,
            version: skill.version,
            columns: skill.columns.join(","),
          })),
        ),
    `${rows.length} row(s); specify=${JSON.stringify(rows.find((row) => row.name === SKILL))}`,
  );

  // --- page: /skills/specify equals getSkill, listSkills and listSkillVersions ------------------
  await page.locator(`[data-skill-row='${SKILL}'] a`).click();
  await page.waitForSelector(
    `[data-skill-page='${SKILL}'] [data-skill-history]`,
    {
      timeout: 20_000,
    },
  );
  await page.waitForSelector("[data-skill-used-by]", { timeout: 20_000 });
  const before = await rpc("getSkill", { name: SKILL });
  const historyBefore = await rpc("listSkillVersions", { name: SKILL });
  const shown = await readPage();
  observed.before = { page: shown, oracle: before, history: historyBefore };
  await shot("page");
  assert(
    "the page shows getSkill's newest body, version and description",
    shown.body === before.body &&
      shown.shown === before.version &&
      shown.newest === before.newest &&
      shown.description === before.description.replace(/\s+/g, " ").trim(),
    `v${shown.shown}, ${shown.body?.length} chars of body`,
  );
  assert(
    "the page names the columns listSkills says bind specify: specifying",
    shown.usedBy ===
      listed.find((skill) => skill.name === SKILL)?.columns.join(",") &&
      shown.usedBy === "specifying",
    String(shown.usedBy),
  );
  assert(
    "the history is listSkillVersions', newest first, the shown version marked",
    JSON.stringify(shown.history.map((entry) => entry.version)) ===
      JSON.stringify(historyBefore.map((entry) => entry.version)) &&
      shown.history
        .filter((entry) => entry.current)
        .map((e) => e.version)
        .join() === String(before.version),
    JSON.stringify(shown.history),
  );

  // --- unchanged: Publish with nothing edited sends nothing --------------------------------------
  await page.locator("[data-skill-edit]").click();
  await page.waitForSelector("[data-skill-form]", { timeout: 10_000 });
  const formBody = await page.locator("#skill-body").inputValue();
  const putsBefore = puts();
  await page.locator("[data-skill-publish]").click();
  await page.waitForSelector("[data-skill-problem='unchanged']", {
    timeout: 10_000,
  });
  await page.waitForTimeout(500);
  assert(
    "the form opens on the newest body, and Publish with nothing changed is stopped with no putSkill",
    formBody === before.body && puts() === putsBefore,
    `${puts() - putsBefore} putSkill sent`,
  );

  // --- refused: a blank body is InvalidSkill, inline --------------------------------------------
  await page.locator("#skill-body").fill("   ");
  await page.locator("[data-skill-publish]").click();
  await page.waitForSelector("[data-skill-refusal]", { timeout: 20_000 });
  const refusal = await page.evaluate(() => {
    const node = document.querySelector("[data-skill-refusal]");
    return {
      tag: node?.getAttribute("data-skill-refusal") ?? null,
      text: node?.textContent ?? "",
      role: node?.getAttribute("role") ?? null,
    };
  });
  const oracleRefusal = await rpcFailure("putSkill", {
    name: SKILL,
    description: before.description,
    body: "   ",
  });
  const historyAfterRefusal = await rpc("listSkillVersions", { name: SKILL });
  const keptBlank = await page.locator("#skill-body").inputValue();
  observed.refusal = { page: refusal, oracle: oracleRefusal };
  await shot("refused");
  assert(
    "a blank body is refused inline as InvalidSkill, in the server's words",
    refusal.tag === "InvalidSkill" &&
      oracleRefusal.tag === "InvalidSkill" &&
      refusal.role === "alert" &&
      oracleRefusal.message !== undefined &&
      refusal.text.includes(oracleRefusal.message),
    `${refusal.tag}: ${oracleRefusal.message}`,
  );
  assert(
    "the refusal writes nothing and the form keeps what was typed",
    historyAfterRefusal.length === historyBefore.length &&
      keptBlank === "   " &&
      (await page.locator("[data-skill-form]").count()) === 1,
    `${historyAfterRefusal.length} version(s) before and after`,
  );

  // --- created: an edit publishes v<n+1> --------------------------------------------------------
  const edited = `${before.body.replace(/\n*$/, "\n")}\n${EDITED_LINE}\n`;
  await page.locator("#skill-body").fill(edited);
  await shot("form");
  const reloadsBefore = sentTags.length;
  await page.locator("[data-skill-publish]").click();
  const created = await page
    .waitForSelector("[data-skill-created]", { timeout: 20_000 })
    .then((node) => node.textContent());
  await waitShown(before.newest + 1);
  await page.waitForFunction(
    (n) =>
      document
        .querySelector("[data-skill-history-version]")
        ?.getAttribute("data-skill-history-version") === String(n),
    before.newest + 1,
    { timeout: 20_000 },
  );
  const after = await readPage();
  observed.after = after;
  await shot("created");
  assert(
    `the page says "v${before.newest + 1} created"`,
    created?.includes(`v${before.newest + 1} created`) &&
      (await page
        .locator(`[data-skill-created='${before.newest + 1}']`)
        .count()) === 1,
    String(created).slice(0, 120),
  );
  assert(
    "the page shows the new body as the newest, and the history lists it first without a reload",
    after.body === edited &&
      after.shown === before.newest + 1 &&
      after.history[0]?.version === before.newest + 1 &&
      after.history[0]?.current === true &&
      after.history.length === historyBefore.length + 1 &&
      (await page.evaluate(
        () => performance.getEntriesByType("navigation").length,
      )) === 1,
    JSON.stringify(after.history.slice(0, 3)),
  );
  assert(
    "the browser sent exactly one putSkill for the publish",
    sentTags.slice(reloadsBefore).filter((tag) => tag === "putSkill").length ===
      1,
    sentTags.slice(reloadsBefore).join(","),
  );
  const newest = await rpc("getSkill", { name: SKILL });
  const old = await rpc("getSkill", { name: SKILL, version: before.version });
  assert(
    "getSkill answers the edit at v<n+1>, the dashboard's, and v<n> is the body it was",
    newest.version === before.newest + 1 &&
      newest.body === edited &&
      newest.author === "dashboard" &&
      newest.attachments.join() === before.attachments.join() &&
      old.body === before.body,
    `v${newest.version} by ${newest.author}; v${old.version} unchanged=${old.body === before.body}`,
  );
  const cli = factory("skill", "show", SKILL);
  observed.cli = { status: cli.status, stdout: cli.stdout.slice(0, 2000) };
  assert(
    "`factory skill show specify` prints the new body at the new version",
    cli.status === 0 &&
      cli.stdout.includes(`version      ${before.newest + 1} (newest)`) &&
      cli.stdout.includes(EDITED_LINE),
    cli.status === 0
      ? cli.stdout.split("\n").slice(0, 2).join(" | ")
      : `exit ${cli.status}: ${cli.stderr.slice(0, 200)}`,
  );

  // --- older: a history entry opens that version ------------------------------------------------
  await page
    .locator(`[data-skill-history-version='${before.version}'] a`)
    .click();
  await waitShown(before.version, before.newest + 1);
  const older = await readPage();
  observed.older = older;
  await shot("older");
  assert(
    "a history entry opens its version's body, says the newest is another, and marks itself",
    older.body === before.body &&
      new URL(page.url()).searchParams.get("version") ===
        String(before.version) &&
      older.older?.includes(`The newest is v${before.newest + 1}`) &&
      older.history.find((entry) => entry.current)?.version === before.version,
    String(older.older).slice(0, 120),
  );
  await page.locator("[data-skill-show-newest]").click();
  await waitShown(before.newest + 1);
  assert(
    "the notice's link opens the newest again",
    (await readPage()).body === edited,
    page.url(),
  );

  // --- missing ----------------------------------------------------------------------------------
  await page.goto(`${WEB_URL}/skills/nosuch-${TAG}`, {
    waitUntil: "domcontentloaded",
  });
  const missingSkill = await page
    .getByText("No such skill")
    .waitFor({ timeout: 20_000 })
    .then(
      () => true,
      () => false,
    );
  await shot("missing");
  await page.goto(`${WEB_URL}/skills/${SKILL}?version=99`, {
    waitUntil: "domcontentloaded",
  });
  const missingVersion = await page
    .getByText("No such version")
    .waitFor({ timeout: 20_000 })
    .then(
      () => true,
      () => false,
    );
  assert(
    "an unknown skill reads No such skill, and an unknown version No such version",
    missingSkill && missingVersion,
    `skill=${missingSkill} version=${missingVersion}`,
  );
  // A not-found read is the server's typed answer, which the browser logs as nothing; anything else
  // logged is a fault of the pages.
  assert(
    "the pages logged no console error",
    consoleErrors.length === 0,
    JSON.stringify(consoleErrors.slice(0, 5)),
  );
} catch (error) {
  assert("the drive ran to the end", false, String(error));
  await page
    .screenshot({
      path: path.join(EVIDENCE_DIR, "skills-failure.png"),
      fullPage: true,
    })
    .catch(() => {});
} finally {
  observed.consoleErrors = consoleErrors;
  observed.sentTags = sentTags;
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
