// Drive the Repositories page (LOB-262) the way an operator uses it, against the instance
// `repos.sh` starts, and capture evidence.
//
//   node repos.mjs      (via ./repos.sh, which owns the instance and the checkouts this drives)
//
// The drive seeds what an operator finds on a fresh install, then requires the page to say so:
//
//   seed      a repo a session registered by naming a slug (`createSession({ repo })`): no clone URL,
//             no checkout. A throwaway git repository (one commit on main) to register, and a plain
//             directory that is not one.
//   reach     the rail's **Repositories** opens `/repos` and is marked `aria-current`
//   flag      the seeded repo is listed `not runnable`, cause `no_checkout`, with the reason and the fix
//   refuse    a bad slug is stopped in the form (nothing sent, nothing written); a path that is not a
//             git work tree is refused by the server, and the page shows the server's own message,
//             character for character, inline, with the slug still unregistered and the form kept
//   add       the form registers the throwaway checkout: the row appears without a reload, runnable,
//             and equals `listRepos`' row (base ref, URL, path, work tree); the form is cleared
//   fix       the same form, naming the flagged repo's slug and a path, turns it runnable in place
//   run       a session created on a registered repo, and on the flagged one once fixed, has `factory/<session-id>` as its branch, a real
//             worktree on disk and the branch in the checkout; one opened on the repo while it had no checkout has a directory but no worktree
//   follow    the checkout moved away behind the registry's back: the open page flips the row to
//             `not runnable`, cause `not_a_work_tree`, on its next poll, without a reload
//   park      a card on a registered repo whose install exits 7: its run's first message is refused
//             `setup_failed`, and the card pane shows the block's note (the step, exit 7, stderr)
//
// Env: WEB_URL, API_URL, EVIDENCE_DIR, RUN_DIR.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "@playwright/test";

const WEB_URL = process.env["WEB_URL"] ?? "http://localhost:3441";
const API_URL = process.env["API_URL"] ?? "http://localhost:9441";
const EVIDENCE_DIR =
  process.env["EVIDENCE_DIR"] ?? ".verify/evidence/latest/repos";
const RUN_DIR = path.resolve(process.env["RUN_DIR"] ?? ".verify/run/repos");

const TAG = randomBytes(4).toString("hex");
const NOPATH = `verify-repos-${TAG}/nopath`;
const WIDGETS = `verify-repos-${TAG}/widgets`;
const BAD = `verify-repos-${TAG}/refused`;
const CHECKOUTS = path.join(RUN_DIR, "checkouts", TAG);
const WIDGETS_DIR = path.join(CHECKOUTS, "widgets");
const NOPATH_DIR = path.join(CHECKOUTS, "nopath");
// Outside this repository on purpose: `registerRepo` accepts a directory *inside* a git work tree
// (a monorepo package), so a plain directory under the checkout the drive runs from is not refused.
const PLAIN_DIR = await mkdtemp(path.join(os.tmpdir(), `verify-repos-${TAG}-`));
const WIDGETS_URL = `https://example.invalid/${TAG}/widgets.git`;

await mkdir(EVIDENCE_DIR, { recursive: true });
// A failure shot from an earlier run must not sit beside this run's passing evidence.
await rm(path.join(EVIDENCE_DIR, "repos-failure.png"), { force: true });
for (const dir of [WIDGETS_DIR, NOPATH_DIR]) {
  const init = spawnSync("git", ["init", "-q", "-b", "main", dir], {
    encoding: "utf8",
  });
  if (init.status !== 0) throw new Error(`git init ${dir}: ${init.stderr}`);
  const commit = spawnSync(
    "git",
    [
      "-C",
      dir,
      "-c",
      "user.email=verify-repos@localhost",
      "-c",
      "user.name=verify-repos",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "seed",
    ],
    { encoding: "utf8" },
  );
  if (commit.status !== 0) throw new Error(`git commit: ${commit.stderr}`);
}
// One readiness check the widgets checkout passes (LOB-29, S-env-setup): an AGENTS.md, so the page
// shows `1/4` and names the other three, as the server scored them.
await writeFile(path.join(WIDGETS_DIR, "AGENTS.md"), "# widgets\n");
// The server reports the path it was given; macOS's /var is a link to /private/var, so a checkout
// under a symlinked directory is compared by the path registered, not by its real path.
const WIDGETS_REAL = await realpath(WIDGETS_DIR);

const observed = {
  webUrl: WEB_URL,
  apiUrl: API_URL,
  tag: TAG,
  slugs: { NOPATH, WIDGETS, BAD },
  checks: {},
};
const assert = (name, condition, detail) => {
  observed.checks[name] = { passed: Boolean(condition), detail };
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}  ${detail}`);
  return Boolean(condition);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** One unary RPC call over the NDJSON envelope, from this process: the oracle, never the page. */
const rpcExit = async (tag, payload) => {
  const requestId = `repos-${tag}-${Date.now()}-${Math.random()}`;
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
  return {
    exit,
    message: message === undefined ? undefined : JSON.parse(`"${message}"`),
  };
};
const listed = async (slug) =>
  (await rpc("listRepos", {})).repos.find((row) => row.repo === slug);

const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const consoleErrors = [];
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});
page.on("pageerror", (error) =>
  consoleErrors.push(`pageerror: ${String(error)}`),
);

const rowSel = (slug) => `[data-repo-row='${slug}']`;
const readRow = (slug) =>
  page.$eval(rowSel(slug), (node) => ({
    runnable: node.getAttribute("data-repo-runnable"),
    cause: node.getAttribute("data-repo-cause"),
    state: node.querySelector("[data-repo-state]")?.textContent?.trim() ?? null,
    path: node.querySelector("[data-repo-path]")?.textContent?.trim() ?? null,
    reason:
      node.querySelector("[data-repo-reason]")?.textContent?.trim() ?? null,
    text: node.innerText.replaceAll("\n", " ").trim(),
  }));
const waitRow = (slug, timeout = 20_000) =>
  page.waitForSelector(rowSel(slug), { timeout });
const fill = async (fields) => {
  for (const [name, value] of Object.entries(fields)) {
    await page.locator(`[data-repo-form] input[name='${name}']`).fill(value);
  }
};
const submit = () =>
  page
    .locator("[data-repo-form]")
    .getByRole("button", { name: "Add repository" })
    .click();

let exitCode = 0;
try {
  // --- seed: a repo a session registered by naming it ------------------------------------------
  const scratch = await rpc("createSession", { repo: NOPATH });
  observed.seed = { noPathSession: scratch.id };
  const seeded = await listed(NOPATH);
  assert(
    "a session that names a new slug registers it with no checkout",
    seeded !== undefined &&
      seeded.localPath === undefined &&
      seeded.url === "" &&
      seeded.localPathIsGit === false,
    JSON.stringify(seeded ?? null),
  );

  // --- reach: the rail's Repositories ----------------------------------------------------------
  await page.goto(`${WEB_URL}/sessions`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("nav[aria-label='Sections']", { timeout: 15_000 });
  await page
    .locator("nav[aria-label='Sections']")
    .getByRole("link", { name: "Repositories", exact: true })
    .click();
  await page.waitForFunction(() => window.location.pathname === "/repos");
  await waitRow(NOPATH);
  await page.evaluate(() => {
    window.__reposNoReload = true;
  });
  const current = await page.$$eval(
    "nav[aria-label='Sections'] [aria-current='page']",
    (nodes) => nodes.map((node) => node.getAttribute("href")),
  );
  assert(
    "the rail marks Repositories as the current section",
    current.length === 1 && current[0] === "/repos",
    `aria-current on ${JSON.stringify(current)}`,
  );

  // --- flag: no checkout means not runnable, with the reason and the fix -----------------------
  const flagged = await readRow(NOPATH);
  observed.flagged = flagged;
  await page.screenshot({
    path: path.join(EVIDENCE_DIR, "repos-flagged.png"),
    fullPage: true,
  });
  assert(
    "an auto-registered repo with no local path is flagged not runnable",
    flagged.runnable === "false" &&
      flagged.cause === "no_checkout" &&
      flagged.state === "not runnable" &&
      flagged.path === "none registered",
    JSON.stringify(flagged),
  );
  assert(
    "the flag carries the reason and the fix",
    (flagged.reason ?? "").includes("No local checkout") &&
      (flagged.reason ?? "").includes("no worktree is cut") &&
      (flagged.reason ?? "").includes("local path"),
    flagged.reason ?? "none",
  );
  const headerCount = await page.$eval("[data-repos-count]", (node) => ({
    total: Number(node.getAttribute("data-repos-count")),
    notRunnable: Number(node.getAttribute("data-repos-not-runnable")),
    text: node.textContent ?? "",
  }));
  const allRepos = (await rpc("listRepos", {})).repos;
  assert(
    "the header counts every repo and the ones that cannot run",
    headerCount.total === allRepos.length &&
      headerCount.notRunnable ===
        allRepos.filter((row) => !row.localPathIsGit).length &&
      headerCount.notRunnable >= 1 &&
      headerCount.text.includes("cannot run"),
    JSON.stringify(headerCount),
  );

  // --- refuse: a bad slug is stopped in the form, nothing is written ---------------------------
  await fill({ repo: "Not A Slug", localPath: WIDGETS_DIR });
  await submit();
  const problem = await page
    .locator("[data-repo-problem]")
    .textContent({ timeout: 10_000 });
  const unknownBad = await rpcFailure("getRepo", { repo: BAD });
  assert(
    "a bad slug is refused inline, quoting the slug and the rule",
    (problem ?? "").includes('"Not A Slug"') &&
      (problem ?? "").includes("owner/name"),
    problem ?? "none",
  );
  assert(
    "a bad slug writes nothing",
    (await listed(BAD)) === undefined &&
      (await page.locator("[data-repo-refusal]").count()) === 0 &&
      unknownBad.message !== undefined,
    `listed=${JSON.stringify((await listed(BAD)) ?? null)}`,
  );

  // --- refuse: the server's refusal of a path that is not a git work tree ---------------------
  await fill({ repo: BAD, localPath: PLAIN_DIR });
  await submit();
  const refusal = page.locator("[data-repo-refusal]");
  await refusal.waitFor({ timeout: 15_000 });
  const shown = await refusal.textContent();
  const tag = await refusal.getAttribute("data-repo-refusal");
  const server = await rpcFailure("registerRepo", {
    repo: BAD,
    localPath: PLAIN_DIR,
  });
  observed.refusal = { shown, tag, server: server.message };
  await page.screenshot({
    path: path.join(EVIDENCE_DIR, "repos-refused.png"),
    fullPage: true,
  });
  assert(
    "a path that is not a git work tree is refused in the server's own words",
    server.message !== undefined &&
      server.message.includes("not a git work tree") &&
      server.message.includes(PLAIN_DIR) &&
      (shown ?? "").includes(server.message),
    `shown=${JSON.stringify(shown)} server=${JSON.stringify(server.message ?? null)}`,
  );
  assert(
    "the refusal registered nothing and the form kept what was typed",
    (await listed(BAD)) === undefined &&
      (await page.locator(rowSel(BAD)).count()) === 0 &&
      (await page.locator("input[name='repo']").inputValue()) === BAD &&
      (await page.locator("input[name='localPath']").inputValue()) ===
        PLAIN_DIR,
    `listed=${JSON.stringify((await listed(BAD)) ?? null)}`,
  );

  // --- add: the form registers the throwaway checkout, and the list shows it without a reload ---
  await fill({
    repo: WIDGETS,
    localPath: WIDGETS_DIR,
    defaultBaseRef: "main",
    url: WIDGETS_URL,
  });
  await submit();
  await waitRow(WIDGETS, 15_000);
  const added = await readRow(WIDGETS);
  const oracle = await listed(WIDGETS);
  observed.added = { row: added, oracle };
  await page.screenshot({
    path: path.join(EVIDENCE_DIR, "repos-added.png"),
    fullPage: true,
  });
  assert(
    "registering a throwaway checkout through the form lists it, runnable, without a reload",
    added.runnable === "true" &&
      added.state === "runnable" &&
      added.path === WIDGETS_DIR &&
      (await page.evaluate(() => window.__reposNoReload === true)),
    JSON.stringify(added),
  );
  assert(
    "the row is what listRepos holds: path, URL, base ref and work tree",
    oracle !== undefined &&
      oracle.localPath === WIDGETS_DIR &&
      oracle.url === WIDGETS_URL &&
      oracle.defaultBaseRef === "main" &&
      oracle.localPathIsGit === true &&
      oracle.workTree === WIDGETS_REAL &&
      added.text.includes(WIDGETS_URL) &&
      added.text.includes("base main"),
    JSON.stringify(oracle ?? null),
  );
  const readiness = await page.$eval(rowSel(WIDGETS), (node) => ({
    score:
      node
        .querySelector("[data-repo-readiness]")
        ?.getAttribute("data-repo-readiness") ?? null,
    missing: [...node.querySelectorAll("[data-repo-readiness-missing]")].map(
      (item) => item.textContent?.trim() ?? "",
    ),
  }));
  observed.readiness = { row: readiness, oracle: oracle?.readiness ?? null };
  assert(
    "the row shows the checkout's readiness score and every failed check, as listRepos scored it",
    oracle?.readiness !== undefined &&
      readiness.score === `${oracle.readiness.score}/${oracle.readiness.max}` &&
      readiness.score === "1/4" &&
      JSON.stringify(readiness.missing) ===
        JSON.stringify(
          oracle.readiness.checks
            .filter((check) => !check.passed)
            .map((check) => check.reason),
        ),
    JSON.stringify(readiness),
  );
  assert(
    "a repo with no checkout is not scored, and the row says none rather than 0",
    (await page
      .locator(`${rowSel(NOPATH)} [data-repo-readiness='none']`)
      .count()) === 1 && (await listed(NOPATH))?.readiness === undefined,
    "nopath readiness none",
  );
  assert(
    "a landed registration clears the form, says so, and drops the refusal",
    (await page.locator("input[name='repo']").inputValue()) === "" &&
      (await page.locator("input[name='localPath']").inputValue()) === "" &&
      (await page.locator(`[data-repo-registered='${WIDGETS}']`).count()) ===
        1 &&
      (await page.locator("[data-repo-refusal]").count()) === 0,
    "form fields empty, status shown",
  );

  // --- fix: register a checkout for the flagged repo and it turns runnable in place -------------
  await fill({ repo: NOPATH, localPath: NOPATH_DIR });
  await submit();
  await page.waitForSelector(`${rowSel(NOPATH)}[data-repo-runnable='true']`, {
    timeout: 15_000,
  });
  const fixed = await readRow(NOPATH);
  const fixedOracle = await listed(NOPATH);
  assert(
    "giving a flagged repo a checkout turns it runnable in place, keeping its other fields",
    fixed.runnable === "true" &&
      fixed.reason === null &&
      fixedOracle?.localPath === NOPATH_DIR &&
      fixedOracle?.defaultBaseRef === "main" &&
      (await page.evaluate(() => window.__reposNoReload === true)),
    JSON.stringify({ fixed, fixedOracle: fixedOracle ?? null }),
  );

  // --- run: a session on a registered checkout is cut a worktree ------------------------------
  const run = await rpc("createSession", { repo: WIDGETS });
  const snapshot = await rpc("getSession", { sessionId: run.id });
  const workspace = snapshot.workspace;
  const branch = `factory/${run.id}`;
  const branchInCheckout = spawnSync(
    "git",
    ["-C", WIDGETS_DIR, "rev-parse", "--verify", "--quiet", branch],
    { encoding: "utf8" },
  );
  observed.run = { session: run.id, workspace };
  assert(
    "a session created on the registered repo gets a factory/<session-id> worktree",
    workspace.repo === WIDGETS &&
      workspace.branch === branch &&
      existsSync(path.join(workspace.path, ".git")) &&
      branchInCheckout.status === 0,
    `branch=${workspace.branch} path=${workspace.path} branchInCheckout=${branchInCheckout.status}`,
  );
  // The first-run path itself: the repo a session registered with no checkout, once it has one, is
  // cut a worktree like any other.
  const healed = await rpc("createSession", { repo: NOPATH });
  const healedWorkspace = (await rpc("getSession", { sessionId: healed.id }))
    .workspace;
  const healedBranch = `factory/${healed.id}`;
  const healedInCheckout = spawnSync(
    "git",
    ["-C", NOPATH_DIR, "rev-parse", "--verify", "--quiet", healedBranch],
    { encoding: "utf8" },
  );
  observed.healed = { session: healed.id, workspace: healedWorkspace };
  assert(
    "a session on the auto-registered repo, once it has a checkout, gets a factory/<session-id> worktree",
    healedWorkspace.repo === NOPATH &&
      healedWorkspace.branch === healedBranch &&
      existsSync(path.join(healedWorkspace.path, ".git")) &&
      healedInCheckout.status === 0,
    `branch=${healedWorkspace.branch} path=${healedWorkspace.path} branchInCheckout=${healedInCheckout.status}`,
  );
  // The contrast: the snapshot names `factory/<id>` as the branch for any repo-bound session, so the
  // name alone proves nothing. What the repo with no checkout lacks is the worktree itself.
  const bare = (await rpc("getSession", { sessionId: scratch.id })).workspace;
  observed.bare = bare;
  assert(
    "a session opened on the repo while it had no checkout was cut no worktree",
    bare.repo === NOPATH && !existsSync(path.join(bare.path, ".git")),
    `path=${bare.path} hasGit=${existsSync(path.join(bare.path, ".git"))}`,
  );

  // --- follow: the checkout moves away; the open page notices on its poll -----------------------
  await rename(WIDGETS_DIR, `${WIDGETS_DIR}.moved`);
  await page.waitForSelector(
    `${rowSel(WIDGETS)}[data-repo-cause='not_a_work_tree']`,
    { timeout: 20_000 },
  );
  const moved = await readRow(WIDGETS);
  const movedOracle = await listed(WIDGETS);
  await page.screenshot({
    path: path.join(EVIDENCE_DIR, "repos-moved.png"),
    fullPage: true,
  });
  assert(
    "a checkout that moved away flips its row to not runnable on the poll, naming the path",
    moved.runnable === "false" &&
      (moved.reason ?? "").includes(WIDGETS_DIR) &&
      movedOracle?.localPathIsGit === false &&
      (await page.evaluate(() => window.__reposNoReload === true)),
    JSON.stringify(moved),
  );

  // A reload shows the server's truth, not what this browser remembers.
  await page.reload({ waitUntil: "domcontentloaded" });
  await waitRow(WIDGETS);
  const reloaded = await readRow(WIDGETS);
  assert(
    "a reload shows the same rows",
    reloaded.runnable === "false" &&
      (await readRow(NOPATH)).runnable === "true" &&
      (await page.locator(rowSel(BAD)).count()) === 0,
    JSON.stringify(reloaded),
  );

  // --- park: a card whose run's worktree setup failed (S-env-setup) ----------------------------
  // Last, because it leaves the Repositories page: `follow` above needs that page open.
  const BROKEN = `verify-repos-${TAG}/broken`;
  const BROKEN_DIR = path.join(CHECKOUTS, "broken");
  await mkdir(path.join(BROKEN_DIR, ".factory"), { recursive: true });
  await writeFile(
    path.join(BROKEN_DIR, ".factory", "config"),
    JSON.stringify({
      install:
        'echo "resolving deps"; echo "error: registry unreachable" >&2; exit 7',
    }),
  );
  for (const args of [
    ["init", "-q", "-b", "main"],
    ["add", "-A"],
    [
      "-c",
      "user.email=verify-repos@localhost",
      "-c",
      "user.name=verify-repos",
      "commit",
      "-q",
      "-m",
      "seed",
    ],
  ]) {
    const ran = spawnSync("git", ["-C", BROKEN_DIR, ...args], {
      encoding: "utf8",
    });
    if (ran.status !== 0) throw new Error(`git ${args[0]}: ${ran.stderr}`);
  }
  await rpc("registerRepo", {
    repo: BROKEN,
    defaultBaseRef: "main",
    localPath: BROKEN_DIR,
  });
  const parkBoard = await rpc("createBoard", {
    repo: BROKEN,
    definitionId: "default",
  });
  const parkCard = await rpc("createTask", {
    boardId: parkBoard.id,
    title: `repos: a card whose repo does not install (${TAG})`,
    actor: "person:verify-repos",
  });
  const parkRun = await rpc("createSession", {
    taskId: parkCard.id,
    taskColumn: parkCard.column,
  });
  const parkRefused = await rpcFailure("sendMessage", {
    sessionId: parkRun.id,
    content: "build it",
  });
  await page.goto(`${WEB_URL}/boards/${parkBoard.id}?card=${parkCard.id}`, {
    waitUntil: "domcontentloaded",
  });
  const noteSel = `aside[data-card-pane='${parkCard.id}'] [data-card-block-note='setup_failed']`;
  await page.waitForSelector(noteSel, { timeout: 20_000 });
  const note = await page.$eval(noteSel, (node) => ({
    heading: node.querySelector("h3")?.textContent?.trim() ?? null,
    text: node.querySelector("pre")?.textContent ?? "",
  }));
  await page.screenshot({
    path: path.join(EVIDENCE_DIR, "repos-setup-failed-card.png"),
    fullPage: true,
  });
  observed.park = {
    board: parkBoard.id,
    card: parkCard.id,
    run: parkRun.id,
    refused: parkRefused.message ?? null,
    note,
  };
  assert(
    "a card parked setup_failed shows its note in the card pane: the step, exit code and output tail",
    (parkRefused.message ?? "").includes("setup failed: install") &&
      note.heading === "Blocked: its worktree setup failing" &&
      note.text.includes("exited 7") &&
      note.text.includes("error: registry unreachable"),
    JSON.stringify(note).slice(0, 200),
  );

  {
  // --- secrets: a repo's secret set from the page, never shown again (S-agent-secrets) ----------
    // Every `/rpc` response body the page receives, as text: the value must be in none of them.
    const rpcBodies = [];
    page.on("response", (response) => {
      if (!response.url().includes("/rpc")) return;
      const read = response.text().then(
        (text) => text,
        () => "",
      );
      rpcBodies.push(read);
    });
    const SECRET_VALUE = `verify-repos-fake-secret-${TAG}`;
    await page.goto(`${WEB_URL}/repos`, { waitUntil: "domcontentloaded" });
    await waitRow(WIDGETS);
    const secretForm = page.locator(`[data-secret-form='${WIDGETS}']`);
    await secretForm.locator("input[name='name']").fill("TEST_API_KEY");
    await secretForm.locator("input[name='value']").fill(SECRET_VALUE);
    const valueType = await secretForm
      .locator("input[name='value']")
      .getAttribute("type");
    await secretForm.getByRole("button", { name: "Save secret" }).click();
    await page.waitForSelector(
      `${rowSel(WIDGETS)} [data-secret-saved='TEST_API_KEY']`,
      { timeout: 20_000 },
    );
    await page.waitForSelector(
      `${rowSel(WIDGETS)} [data-secret-name='TEST_API_KEY']`,
      { timeout: 20_000 },
    );
    const shown = await page.evaluate(() => ({
      html: document.documentElement.outerHTML,
      inputs: [...document.querySelectorAll("input")].map((input) => input.value),
    }));
    await page.screenshot({
      path: path.join(EVIDENCE_DIR, "repos-secret-saved.png"),
      fullPage: true,
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector(
      `${rowSel(WIDGETS)} [data-secret-name='TEST_API_KEY']`,
      { timeout: 20_000 },
    );
    const reloaded = await page.evaluate(
      () => document.documentElement.outerHTML,
    );
    const stored = await rpc("listSecrets", { repo: WIDGETS });
    await page
      .locator(`${rowSel(WIDGETS)} [data-secret-delete='TEST_API_KEY']`)
      .click();
    await page.waitForSelector(`${rowSel(WIDGETS)} [data-secrets-empty]`, {
      timeout: 20_000,
    });
    const afterDelete = await rpc("listSecrets", { repo: WIDGETS });
    const bodies = await Promise.all(rpcBodies);
    observed.secrets = {
      valueType,
      stored: stored.map((secret) => secret.name),
      afterDelete: afterDelete.map((secret) => secret.name),
      rpcResponses: bodies.length,
    };
    assert(
      "secrets: the Secrets form stores the value, its field a password input cleared once saved",
      valueType === "password" &&
        stored.length === 1 &&
        stored[0]?.name === "TEST_API_KEY" &&
        shown.inputs.every((value) => value === "" || value !== SECRET_VALUE),
      JSON.stringify(observed.secrets),
    );
    assert(
      "secrets: neither the page nor any RPC answer it read holds the value, before or after a reload",
      !shown.html.includes(SECRET_VALUE) &&
        !reloaded.includes(SECRET_VALUE) &&
        bodies.length > 0 &&
        bodies.every((text) => !text.includes(SECRET_VALUE)),
      `${bodies.length} rpc responses read`,
    );
    assert(
      "secrets: the row's delete removes it",
      afterDelete.length === 0,
      JSON.stringify(afterDelete),
    );
  }

  assert(
    "the page logged no console error",
    consoleErrors.length === 0,
    JSON.stringify(consoleErrors.slice(0, 5)),
  );
} catch (error) {
  assert("the drive ran to the end", false, String(error));
  await page
    .screenshot({
      path: path.join(EVIDENCE_DIR, "repos-failure.png"),
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
  await rm(PLAIN_DIR, { recursive: true, force: true });
  exitCode = Object.values(observed.checks).every((check) => check.passed)
    ? 0
    : 1;
}
process.exit(exitCode);
