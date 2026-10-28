// Drive a session pinned to a model the server no longer serves (E9), against the two boots
// `model-unavailable.sh` makes. Two modes, one per boot.
//
//   MODE=seed    (boot 1, `DEFAULT_MODEL=faux/faux-cheap`) register a repo, create a session on
//                faux/faux-cheap and let it run once, create a control session on faux/faux-1, and
//                write both ids to `seed.json`
//   MODE=drive   (boot 2, faux-1 alone)
//     oracle     over RPC, never the page: `getSession` and `listSessions` report `modelAvailable:
//                false` for the pinned session and true for the control; `sendMessage` to the pinned
//                session is refused `model_unavailable` naming faux/faux-cheap, and the transcript
//                is the one it had (no run started)
//     pane       the pinned session's pane disables the composer and its Send, says which model it
//                is pinned to and which it would replay on, and offers "Replay on faux/faux-1"; the
//                control session's composer is enabled and shows no notice
//     replay     pressing the Replay action creates a replay on the default model and navigates to
//                it: a new session id, summary model faux/faux-1, its run answers, its composer is
//                enabled, and the source's transcript is still the one it had
//
// Env: WEB_URL, API_URL, EVIDENCE_DIR, RUN_DIR, MODE.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";

const WEB_URL = process.env["WEB_URL"] ?? "http://localhost:3453";
const API_URL = process.env["API_URL"] ?? "http://localhost:9453";
const EVIDENCE_DIR =
  process.env["EVIDENCE_DIR"] ?? ".verify/evidence/latest/model-unavailable";
const RUN_DIR = path.resolve(
  process.env["RUN_DIR"] ?? ".verify/run/model-unavailable",
);
const MODE = process.env["MODE"] ?? "drive";
const PINNED = "faux/faux-cheap";
const DEFAULT = "faux/faux-1";
const REPO = "verify-model-gone/fixture";

await mkdir(EVIDENCE_DIR, { recursive: true });
const seedFile = path.join(RUN_DIR, "seed.json");
const observedFile = path.join(EVIDENCE_DIR, "observed.json");

const observed = { mode: MODE, webUrl: WEB_URL, apiUrl: API_URL, checks: {} };
const assert = (name, condition, detail) => {
  observed.checks[name] = { passed: Boolean(condition), detail };
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}  ${detail}`);
  return Boolean(condition);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** One unary RPC call over the NDJSON envelope: the exit, never thrown on. */
const rpcExit = async (tag, payload) => {
  const requestId = `modelgone-${tag}-${Date.now()}-${Math.random()}`;
  const response = await fetch(`${API_URL}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/ndjson" },
    body: `${JSON.stringify({ _tag: "Request", id: requestId, tag, payload, headers: [] })}\n`,
  });
  const text = await response.text();
  return (
    text
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .find((message) => message?.requestId === requestId)?.exit ?? {
      _tag: "Missing",
      text: text.slice(0, 400),
    }
  );
};
const rpc = async (tag, payload) => {
  const exit = await rpcExit(tag, payload);
  if (exit._tag !== "Success") {
    throw new Error(`${tag} failed: ${JSON.stringify(exit).slice(0, 500)}`);
  }
  return exit.value;
};
/** The typed error of a failed call, as `{ code, message }`. */
const rpcFailure = async (tag, payload) => {
  const exit = await rpcExit(tag, payload);
  if (exit._tag === "Success") return undefined;
  const text = JSON.stringify(exit);
  const code = /"code":"([^"]+)"/.exec(text)?.[1];
  const message = /"message":"((?:[^"\\]|\\.)*)"/.exec(text)?.[1];
  return {
    code,
    message: message === undefined ? undefined : JSON.parse(`"${message}"`),
  };
};

/** A session read until its run answered and it is idle again. */
const settled = async (sessionId) => {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const snapshot = await rpc("getSession", { sessionId });
    const answered = snapshot.entries.some(
      (entry) => entry.kind === "assistant" && entry.text.includes("faux-ok"),
    );
    if (answered && !snapshot.live.busy) return snapshot;
    await sleep(150);
  }
  throw new Error(`session ${sessionId} never settled`);
};

const git = (dir, ...args) => {
  const run = spawnSync(
    "git",
    [
      "-C",
      dir,
      "-c",
      "user.email=verify@localhost",
      "-c",
      "user.name=verify",
      ...args,
    ],
    { encoding: "utf8" },
  );
  if (run.status !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr}`);
};

if (MODE === "seed") {
  const dir = path.join(RUN_DIR, "checkout");
  mkdirSync(dir, { recursive: true });
  spawnSync("git", ["init", "-q", "-b", "main", dir], { encoding: "utf8" });
  writeFileSync(path.join(dir, "README.md"), "# fixture\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "fixture");
  await rpc("registerRepo", {
    repo: REPO,
    url: `https://example.invalid/${REPO}.git`,
    localPath: dir,
  });
  const info = await rpc("getServerInfo", {});
  assert(
    "boot 1 serves the model the session will be pinned to",
    info.models.includes(PINNED) && info.defaultModel === PINNED,
    JSON.stringify({ default: info.defaultModel, models: info.models }),
  );
  const pinned = await rpc("createSession", {
    repo: REPO,
    title: "verify-model-gone pinned",
    model: PINNED,
  });
  await rpc("sendMessage", {
    sessionId: pinned.id,
    content: "Run the repository's check and say what it printed.",
  });
  await settled(pinned.id);
  const control = await rpc("createSession", {
    repo: REPO,
    title: "verify-model-gone control",
    model: DEFAULT,
  });
  await rpc("sendMessage", {
    sessionId: control.id,
    content: "Run the repository's check and say what it printed.",
  });
  await settled(control.id);
  writeFileSync(
    seedFile,
    JSON.stringify({ pinned: pinned.id, control: control.id }),
  );
  assert(
    "the pinned session ran under boot 1 on the model it was pinned to",
    pinned.model === PINNED,
    `model=${pinned.model}`,
  );
  await writeFile(
    path.join(EVIDENCE_DIR, "observed-seed.json"),
    `${JSON.stringify(observed, null, 2)}\n`,
  );
  process.exit(Object.values(observed.checks).every((c) => c.passed) ? 0 : 1);
}

// --- drive -----------------------------------------------------------------------------------
const seed = JSON.parse(readFileSync(seedFile, "utf8"));
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const consoleErrors = [];
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});
page.on("pageerror", (error) =>
  consoleErrors.push(`pageerror: ${String(error)}`),
);

let exitCode = 0;
try {
  // --- oracle: what the server says, over RPC ---------------------------------------------------
  const info = await rpc("getServerInfo", {});
  assert(
    "boot 2 no longer serves the pinned model, and runs faux-1 by default",
    !info.models.includes(PINNED) && info.defaultModel === DEFAULT,
    JSON.stringify({ default: info.defaultModel, models: info.models }),
  );
  const before = await rpc("getSession", { sessionId: seed.pinned });
  const control = await rpc("getSession", { sessionId: seed.control });
  const listed = (await rpc("listSessions", { limit: 50 })).sessions;
  const listedPinned = listed.find((entry) => entry.id === seed.pinned);
  const listedControl = listed.find((entry) => entry.id === seed.control);
  observed.oracle = {
    pinned: before.session,
    listedPinned,
    control: control.session,
  };
  assert(
    "getSession reports the pinned session unavailable, and the control one available",
    before.session.model === PINNED &&
      before.session.modelAvailable === false &&
      control.session.modelAvailable === true,
    `pinned=${before.session.modelAvailable} control=${control.session.modelAvailable}`,
  );
  assert(
    "listSessions reports the same",
    listedPinned?.modelAvailable === false &&
      listedControl?.modelAvailable === true,
    `pinned=${listedPinned?.modelAvailable} control=${listedControl?.modelAvailable}`,
  );
  const refusal = await rpcFailure("sendMessage", {
    sessionId: seed.pinned,
    content: "are you there?",
  });
  const after = await rpc("getSession", { sessionId: seed.pinned });
  observed.oracle.refusal = refusal;
  assert(
    "sendMessage to it is refused as model_unavailable, naming the model",
    refusal?.code === "model_unavailable" &&
      refusal.message?.includes(PINNED) &&
      refusal.message?.includes(seed.pinned),
    JSON.stringify(refusal),
  );
  assert(
    "and starts no run: the transcript is the one it had, and it is idle",
    JSON.stringify(after.entries) === JSON.stringify(before.entries) &&
      after.live.busy === false,
    `entries ${before.entries.length} -> ${after.entries.length}`,
  );

  // --- pane: the composer is disabled, with the reason and the replay ---------------------------
  await page.goto(`${WEB_URL}/sessions/${seed.pinned}`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForSelector("[data-model-unavailable]", { timeout: 20_000 });
  await page
    .locator("[data-replay-session]")
    .filter({ hasText: `Replay on ${DEFAULT}` })
    .waitFor({ timeout: 20_000 });
  const textarea = page.locator("form textarea");
  const send = page.getByRole("button", { name: "Send", exact: true });
  const explanation = (
    await page.locator("[data-model-unavailable]").textContent()
  )?.trim();
  const composer = {
    textareaDisabled: await textarea.isDisabled(),
    sendDisabled: await send.isDisabled(),
    placeholder: await textarea.getAttribute("placeholder"),
    explanation,
  };
  observed.pane = composer;
  await page.screenshot({
    path: path.join(EVIDENCE_DIR, "model-unavailable-pane.png"),
    fullPage: true,
  });
  assert(
    "the pinned session's composer and Send are disabled",
    composer.textareaDisabled && composer.sendDisabled,
    JSON.stringify({
      textarea: composer.textareaDisabled,
      send: composer.sendDisabled,
    }),
  );
  assert(
    "the pane explains: it names the pinned model and the model the replay runs on",
    explanation?.includes(PINNED) &&
      explanation.includes("does not serve") &&
      explanation.includes(
        `Replay it to run the same task again on ${DEFAULT}`,
      ) &&
      composer.placeholder?.includes(PINNED),
    JSON.stringify(explanation),
  );

  await page.goto(`${WEB_URL}/sessions/${seed.control}`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForSelector("form textarea", { timeout: 20_000 });
  await page.waitForSelector("header h1", { timeout: 20_000 });
  await sleep(1_500);
  assert(
    "a session on a served model keeps an enabled composer and shows no notice",
    !(await textarea.isDisabled()) &&
      (await page.locator("[data-model-unavailable]").count()) === 0 &&
      (await page.locator("[data-replay-session]").count()) === 0,
    "textarea enabled, no [data-model-unavailable]",
  );

  // --- replay: the action creates a replay on the default model and goes to it --------------------
  await page.goto(`${WEB_URL}/sessions/${seed.pinned}`, {
    waitUntil: "domcontentloaded",
  });
  const replay = page
    .locator("[data-replay-session]")
    .filter({ hasText: `Replay on ${DEFAULT}` });
  await replay.waitFor({ timeout: 20_000 });
  const listBefore = (await rpc("listSessions", { limit: 100 })).sessions.map(
    (entry) => entry.id,
  );
  await replay.click();
  await page.waitForURL(
    (url) =>
      /\/sessions\/ses_[0-9a-z]{26}$/.test(url.pathname) &&
      !url.pathname.endsWith(seed.pinned),
    { timeout: 30_000 },
  );
  const replayId = /\/sessions\/(ses_[0-9a-z]{26})$/.exec(page.url())?.[1];
  const listAfter = (await rpc("listSessions", { limit: 100 })).sessions.map(
    (entry) => entry.id,
  );
  const replayed = await settled(replayId);
  await page.waitForSelector("form textarea", { timeout: 20_000 });
  await page.screenshot({
    path: path.join(EVIDENCE_DIR, "model-unavailable-replayed.png"),
    fullPage: true,
  });
  const source = await rpc("getSession", { sessionId: seed.pinned });
  observed.replay = { replayId, summary: replayed.session };
  assert(
    "Replay creates exactly one new session and the page navigates to it",
    replayId !== undefined &&
      replayId !== seed.pinned &&
      !listBefore.includes(replayId) &&
      listAfter.filter((id) => !listBefore.includes(id)).length === 1 &&
      listAfter.includes(replayId),
    `replay=${replayId}`,
  );
  assert(
    "the replay runs on the server's default model, which this process serves, and answered",
    replayed.session.model === DEFAULT &&
      replayed.session.modelAvailable === true,
    `model=${replayed.session.model} available=${replayed.session.modelAvailable}`,
  );
  assert(
    "the replay's composer is enabled, and the source's transcript is untouched",
    !(await page.locator("form textarea").isDisabled()) &&
      (await page.locator("[data-model-unavailable]").count()) === 0 &&
      JSON.stringify(source.entries) === JSON.stringify(before.entries),
    "textarea enabled; source entries unchanged",
  );
  observed.consoleErrors = consoleErrors;
} catch (error) {
  assert("the drive ran", false, String(error).slice(0, 1800));
  await page
    .screenshot({
      path: path.join(EVIDENCE_DIR, "model-unavailable-failure.png"),
      fullPage: true,
    })
    .catch(() => undefined);
} finally {
  await browser.close();
}

await writeFile(observedFile, `${JSON.stringify(observed, null, 2)}\n`);
exitCode = Object.values(observed.checks).every((c) => c.passed) ? 0 : 1;
process.exit(exitCode);
