// Drive the New session form's model picker (LOB-274) the way an operator uses it, against the
// instance `model.sh` starts (`DEFAULT_MODEL=faux/faux-cheap`, `ROLE_MODELS=specifier=faux/faux-spec`),
// and capture evidence.
//
//   node model.mjs      (via ./model.sh, which owns the instance this drives)
//
//   offer     the picker's options are the server's default, then exactly `getServerInfo.models`,
//             in its order; the first names the deployment's default, the role's model names its role
//   pick      picking `faux/faux-spec` and pressing **New session** opens a session whose summary
//             names faux/faux-spec, whose every request went to it (`usage.models`, the oracle read
//             over the RPC, never the page), and whose transcript reaches the faux answer
//   default   the server's default creates a session on the deployment's `DEFAULT_MODEL`, not on the
//             model picked before and not on the backend's own `faux/faux-1`
//
// Env: WEB_URL, API_URL, EVIDENCE_DIR.
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";

const WEB_URL = process.env["WEB_URL"] ?? "http://localhost:3451";
const API_URL = process.env["API_URL"] ?? "http://localhost:9451";
const EVIDENCE_DIR =
  process.env["EVIDENCE_DIR"] ?? ".verify/evidence/latest/model";
const DEFAULT_MODEL = "faux/faux-cheap";
const PICKED = "faux/faux-spec";

await mkdir(EVIDENCE_DIR, { recursive: true });
// A failure shot from an earlier run must not sit beside this run's passing evidence.
await rm(path.join(EVIDENCE_DIR, "model-failure.png"), { force: true });

const observed = { webUrl: WEB_URL, apiUrl: API_URL, checks: {} };
const assert = (name, condition, detail) => {
  observed.checks[name] = { passed: Boolean(condition), detail };
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}  ${detail}`);
  return Boolean(condition);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** One unary RPC call over the NDJSON envelope, from this process: the oracle, never the page. */
const rpc = async (tag, payload) => {
  const requestId = `model-${tag}-${Date.now()}-${Math.random()}`;
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

/** A session read until its run has settled and answered: its summary model and request models. */
const settled = async (sessionId) => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const snapshot = await rpc("getSession", { sessionId });
    const answered = snapshot.entries.some(
      (entry) => entry.kind === "assistant" && entry.text.includes("faux-ok"),
    );
    if (answered && !snapshot.live.busy) {
      return {
        model: snapshot.session.model,
        usage: snapshot.usage.models.map((entry) => entry.key),
      };
    }
    await sleep(100);
  }
  throw new Error(`session ${sessionId} never settled`);
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

const picker = () => page.locator("select#new-session-model");
const options = () =>
  picker()
    .locator("option")
    .evaluateAll((nodes) =>
      nodes.map((node) => ({
        value: node.getAttribute("value"),
        label: node.textContent?.trim() ?? "",
      })),
    );

/** Pick `value`, press New session, and answer the id of the session the page navigated to. */
const startOn = async (value) => {
  await page.goto(`${WEB_URL}/sessions`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(
    "select#new-session-model option[value='faux/faux-1']",
    {
      state: "attached",
      timeout: 15_000,
    },
  );
  await picker().selectOption(value);
  await page.getByRole("button", { name: "New session" }).click();
  await page.waitForURL(/\/sessions\/ses_[0-9a-z]{26}$/, { timeout: 15_000 });
  return /\/sessions\/(ses_[0-9a-z]{26})$/.exec(page.url())?.[1];
};

let exitCode = 0;
try {
  const info = await rpc("getServerInfo", {});
  observed.serverInfo = {
    defaultModel: info.defaultModel,
    models: info.models,
    roleModels: info.roleModels,
  };
  assert(
    "the server was booted on DEFAULT_MODEL",
    info.defaultModel === DEFAULT_MODEL && info.models.includes(PICKED),
    JSON.stringify(observed.serverInfo),
  );

  // --- offer: the server's catalog, its default first ------------------------------------------
  await page.goto(`${WEB_URL}/sessions`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(
    "select#new-session-model option[value='faux/faux-1']",
    {
      state: "attached",
      timeout: 15_000,
    },
  );
  const offered = await options();
  observed.offered = offered;
  assert(
    "the picker offers the server's default, then exactly getServerInfo.models",
    JSON.stringify(offered.map((option) => option.value)) ===
      JSON.stringify(["", ...info.models]),
    JSON.stringify(offered.map((option) => option.value)),
  );
  assert(
    "its first choice names the deployment's default model",
    offered[0]?.label === `Server default (${DEFAULT_MODEL})`,
    offered[0]?.label ?? "none",
  );
  assert(
    "a role's model names its role, the default says so",
    offered.find((option) => option.value === PICKED)?.label ===
      `${PICKED} (specifier)` &&
      offered.find((option) => option.value === DEFAULT_MODEL)?.label ===
        `${DEFAULT_MODEL} (default)`,
    JSON.stringify(offered.slice(1).map((option) => option.label)),
  );
  assert(
    "the picker is labelled Model",
    (await page.getByLabel("Model", { exact: true }).count()) === 1,
    "getByLabel('Model')",
  );
  await page.screenshot({
    path: path.join(EVIDENCE_DIR, "model-picker.png"),
    fullPage: true,
  });

  // --- pick: a session on the picked model ------------------------------------------------------
  const pickedId = await startOn(PICKED);
  assert(
    "New session on a picked model opens a session",
    pickedId !== undefined,
    pickedId ?? "none",
  );
  await page
    .getByText("faux-ok", { exact: false })
    .first()
    .waitFor({ timeout: 30_000 });
  const picked = await settled(pickedId);
  observed.picked = { sessionId: pickedId, ...picked };
  assert(
    "the session names the picked model",
    picked.model === PICKED,
    `model=${picked.model}`,
  );
  assert(
    "every request of its run went to the picked model",
    JSON.stringify(picked.usage) === JSON.stringify([PICKED]),
    `usage=${JSON.stringify(picked.usage)}`,
  );
  await page.screenshot({
    path: path.join(EVIDENCE_DIR, "model-picked-session.png"),
    fullPage: true,
  });

  // --- default: the server decides --------------------------------------------------------------
  const defaultId = await startOn("");
  assert(
    "New session on the server's default opens another session",
    defaultId !== undefined && defaultId !== pickedId,
    defaultId ?? "none",
  );
  const unpicked = await settled(defaultId);
  observed.unpicked = { sessionId: defaultId, ...unpicked };
  assert(
    "it runs the deployment's DEFAULT_MODEL, not the backend's own",
    unpicked.model === DEFAULT_MODEL &&
      JSON.stringify(unpicked.usage) === JSON.stringify([DEFAULT_MODEL]),
    `model=${unpicked.model} usage=${JSON.stringify(unpicked.usage)}`,
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
      path: path.join(EVIDENCE_DIR, "model-failure.png"),
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
