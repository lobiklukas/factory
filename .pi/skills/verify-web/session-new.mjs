// Drive the sidebar's New session form (E6) the way an operator delegates a task, against the
// instance `session-new.sh` starts, and capture evidence.
//
//   node session-new.mjs      (via ./session-new.sh, which owns the instance and the checkouts)
//
//   open      pressing **New session** opens the form and creates nothing: no `createSession`
//             request leaves the page, `listSessions` is unchanged, the route stays `/sessions`
//   empty     submitting with no prompt, or one of spaces, marks the prompt and sends no
//             `createSession` (asserted on the page's own network requests)
//   scratch   a typed multi-line prompt on no repo opens the session it created, whose first user
//             entry is the prompt verbatim (`getSession`, the oracle, read over the RPC) and whose
//             `listSessions` row has no repo
//   repo      choosing a registered checkout and a base ref lands a `listSessions` row with that repo
//             and base ref, and a snapshot `workspace.path` that is a git worktree of the checkout
//             on `factory/<session-id>`
//   refuse    a repo whose base ref the checkout does not have is refused by the server, and the form
//             shows the server's own message inline, keeps the prompt, and stays on `/sessions`; the
//             refused create leaves no `sessions` row on that repo (read from the table over TCP)
//   context   (F19) the pane's line of what the run was told: a session on the widgets repo (AGENTS.md,
//             two skills, a nested AGENTS.md) says `told AGENTS.md (<bytes> bytes, <tokens> tokens) and
//             2 repo skills ...` with the bytes the file has and the tokens `getSessionContext` records;
//             a repo that keeps only CLAUDE.md says it read CLAUDE.md; a file far over the cap is
//             called out as truncated; a bare repo and a scratch session say `no repo instructions`
//   openpr    (F17) the form's "Open a PR when done" box is off and disabled with no repo and on-able
//             with one; ticked on a repo whose run commits, the createSession carries
//             `openPrOnSettle`, the session's PR is opened at the settle (the fake GitHub's ledger holds
//             one create for `factory/<id>`, the pane links it); unticked, or ticked on a repo whose run
//             changes nothing, the ledger holds none
//   late      an answer to an opening the person closed is a toast: a refusal says no session was
//             created in the server's words, and a session landing while a later opening is being
//             typed into leaves that form open and its text kept, with a toast whose Open opens it
//             (the page's `createSession` is held for a moment so the close lands first)
//
// Env: WEB_URL, API_URL, EVIDENCE_DIR, RUN_DIR, LEDGER (the fake GitHub's ledger file), DATABASE_URL.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";

const WEB_URL = process.env["WEB_URL"] ?? "http://localhost:3461";
const API_URL = process.env["API_URL"] ?? "http://localhost:9461";
const EVIDENCE_DIR =
  process.env["EVIDENCE_DIR"] ?? ".verify/evidence/latest/session-new";
const RUN_DIR = path.resolve(
  process.env["RUN_DIR"] ?? ".verify/run/session-new",
);
const LEDGER =
  process.env["LEDGER"] ?? path.join(RUN_DIR, "github-ledger.json");
const DATABASE_URL =
  process.env["DATABASE_URL"] ??
  "postgres://factory:factory@localhost:5442/factory";

const TAG = randomBytes(4).toString("hex");
const WIDGETS = `verify-session-new-${TAG}/widgets`;
const BROKEN = `verify-session-new-${TAG}/broken`;
const CLAUDE = `verify-session-new-${TAG}/claude`;
const LONG = `verify-session-new-${TAG}/long`;
const BARE = `verify-session-new-${TAG}/bare`;
const SHIP = `verify-session-new-${TAG}/ship`;
const QUIET = `verify-session-new-${TAG}/quiet`;
const CHECKOUTS = path.join(RUN_DIR, "checkouts", TAG);
const WIDGETS_DIR = path.join(CHECKOUTS, "widgets");
const BROKEN_DIR = path.join(CHECKOUTS, "broken");
const dirOf = (name) => path.join(CHECKOUTS, name);
// What the widgets repo tells a run (F19): the file the pane's byte count is checked against.
const WIDGETS_AGENTS = `# Widgets rules (${TAG})\n\n- Run the repository's check before you finish.\n- Say what it printed.\n`;
// The base ref the drive types: a branch only the widgets checkout has, so a worktree on it can only
// have come from the field.
const BASE = "release/1.2";
// Indented and multi-line on purpose: verbatim means its lines and spaces arrive as typed.
const PROMPT = `Check the build (session-new ${TAG}).\n\n  - run the repository's check\n  - say what it printed`;

await mkdir(EVIDENCE_DIR, { recursive: true });
await rm(path.join(EVIDENCE_DIR, "session-new-failure.png"), { force: true });

const git = (args) => {
  const result = spawnSync("git", args, { encoding: "utf8" });
  if (result.status !== 0)
    throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
};
const REPO_DIRS = {
  widgets: WIDGETS_DIR,
  broken: BROKEN_DIR,
  claude: dirOf("claude"),
  long: dirOf("long"),
  bare: dirOf("bare"),
  ship: dirOf("ship"),
  quiet: dirOf("quiet"),
};
for (const dir of Object.values(REPO_DIRS)) {
  git(["init", "-q", "-b", "main", dir]);
  git([
    "-C",
    dir,
    "-c",
    "user.email=verify-session-new@localhost",
    "-c",
    "user.name=verify-session-new",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "seed",
  ]);
}
// What each fixture repo says on its base, as one more commit on main (F17, F19): the widgets repo's
// instruction file, two skills and a nested file; a repo with only CLAUDE.md; one whose AGENTS.md is far
// past the cap; a bare one; and the repo whose run commits (the marker the API's faux command reads).
const commitFiles = (dir, files) => {
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(dir, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  git(["-C", dir, "add", "-A"]);
  git([
    "-C",
    dir,
    "-c",
    "user.email=verify-session-new@localhost",
    "-c",
    "user.name=verify-session-new",
    "commit",
    "-q",
    "-m",
    "context",
  ]);
};
commitFiles(WIDGETS_DIR, {
  "AGENTS.md": WIDGETS_AGENTS,
  ".pi/skills/probe-a/SKILL.md":
    "---\nname: probe-a\ndescription: Probe the first thing.\n---\n\nbody a\n",
  ".agents/skills/probe-b/SKILL.md":
    "---\nname: probe-b\ndescription: Probe the second thing.\n---\n\nbody b\n",
  "packages/web/AGENTS.md": "# Web rules (nested)\n",
});
commitFiles(REPO_DIRS.claude, {
  "CLAUDE.md": "# Claude rules\n\n- Use bun.\n",
});
commitFiles(REPO_DIRS.long, {
  "AGENTS.md": `${Array.from({ length: 3000 }, (_, line) => `- rule ${line}: keep the gate green`).join("\n")}\n`,
});
commitFiles(REPO_DIRS.bare, { "README.md": "nothing for agents\n" });
commitFiles(REPO_DIRS.ship, { ".verify-ship": "1\n", "README.md": "ship\n" });
commitFiles(REPO_DIRS.quiet, { "README.md": "quiet\n" });
// One commit ahead of main, so a worktree cut from it is told apart from one cut from main.
git(["-C", WIDGETS_DIR, "checkout", "-q", "-b", BASE]);
git([
  "-C",
  WIDGETS_DIR,
  "-c",
  "user.email=verify-session-new@localhost",
  "-c",
  "user.name=verify-session-new",
  "commit",
  "-q",
  "--allow-empty",
  "-m",
  "release",
]);
git(["-C", WIDGETS_DIR, "checkout", "-q", "main"]);
const BASE_SHA = git(["-C", WIDGETS_DIR, "rev-parse", BASE]);
const MAIN_SHA = git(["-C", WIDGETS_DIR, "rev-parse", "main"]);

const observed = {
  webUrl: WEB_URL,
  apiUrl: API_URL,
  tag: TAG,
  slugs: { WIDGETS, BROKEN },
  checks: {},
};
const assert = (name, condition, detail) => {
  observed.checks[name] = { passed: Boolean(condition), detail };
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}  ${detail}`);
  return Boolean(condition);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** One unary RPC call over the NDJSON envelope, from this process: the oracle, never the page. */
const rpc = async (tag, payload) => {
  const requestId = `session-new-${tag}-${Date.now()}-${Math.random()}`;
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
const sessionIds = async () =>
  (await rpc("listSessions", { limit: 100 })).sessions.map((row) => row.id);

/**
 * The ids of every `sessions` row bound to `repo`, read from the table over TCP. Not `listSessions`:
 * it pages (a database with 100 sessions hides a 101st) and lists only sessions with activity, which
 * a create that failed before its owner opened never wrote. The repo is this run's own slug, so any
 * row on it is this run's.
 */
const SESSION_ROWS_ON = `
  const sql = new Bun.SQL(process.argv[1]);
  try {
    const rows = await sql\`SELECT id FROM sessions WHERE repo = \${process.argv[2]}\`;
    console.log(JSON.stringify(rows.map((row) => row.id)));
  } finally {
    await sql.close();
  }
`;
const sessionRowsOn = (repo) => {
  const result = spawnSync("bun", ["-e", SESSION_ROWS_ON, DATABASE_URL, repo], {
    encoding: "utf8",
  });
  if (result.status !== 0)
    throw new Error(`reading the sessions on ${repo}: ${result.stderr}`);
  return JSON.parse(result.stdout.trim());
};

/** The `message` of a refused `createSession`'s answer, as the server worded it. */
const answerMessage = (create) => {
  const quoted = /"message":"((?:[^"\\]|\\.)*)"/.exec(
    create?.answer ?? "",
  )?.[1];
  return quoted === undefined ? undefined : JSON.parse(`"${quoted}"`);
};

/** Wait for `create`'s answer to have been read. */
const answered = async (create) => {
  for (let attempt = 0; attempt < 100 && create?.answer == null; attempt += 1)
    await sleep(100);
  return create;
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
// Every `createSession` the page sends, with the answer's body: the network half of "nothing is
// created", and the server's own words the refusal is compared against.
const creates = [];
page.on("request", (request) => {
  const body = request.postDataBuffer()?.toString("utf8") ?? "";
  // The client posts to `<api>/rpc/`; the body is NDJSON, one envelope per line.
  if (
    new URL(request.url()).pathname.startsWith("/rpc") &&
    body.includes('"tag":"createSession"')
  ) {
    const sent = { body, answer: null };
    creates.push(sent);
    void request
      .response()
      .then((response) => response?.text())
      .then((text) => {
        sent.answer = text ?? null;
      })
      .catch(() => {});
  }
});

const dialog = () => page.locator("[data-new-session-dialog]");
const prompt = () => page.locator("#new-session-prompt");
const submit = () => page.locator("[data-session-submit]");

/** `/sessions`, freshly loaded, with the New session form open. */
const openForm = async () => {
  await page.goto(`${WEB_URL}/sessions`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("nav[aria-label='Sections']", { timeout: 15_000 });
  await page.getByRole("button", { name: "New session" }).click();
  await dialog().waitFor({ timeout: 10_000 });
};

/** Submit the form and answer the id of the session the page navigated to. */
const submitAndFollow = async () => {
  await submit().click();
  await page.waitForURL(/\/sessions\/ses_[0-9a-z]{26}$/, { timeout: 20_000 });
  return /\/sessions\/(ses_[0-9a-z]{26})$/.exec(page.url())?.[1];
};

/** The session's snapshot once its first message is in the transcript. */
const withFirstEntry = async (sessionId) => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const snapshot = await rpc("getSession", { sessionId });
    if (snapshot.entries.some((entry) => entry.kind === "user"))
      return snapshot;
    await sleep(100);
  }
  throw new Error(`session ${sessionId} never had a user entry`);
};

let exitCode = 0;
try {
  // Registered over the RPC, as `factory repo add` would: this drive is about the session form, and
  // `/repos` has its own (`repos.mjs`). The broken repo's default base ref is one its checkout lacks.
  await rpc("registerRepo", { repo: WIDGETS, localPath: WIDGETS_DIR });
  await rpc("registerRepo", {
    repo: BROKEN,
    localPath: BROKEN_DIR,
    defaultBaseRef: "trunk",
  });
  for (const [slug, name] of [
    [CLAUDE, "claude"],
    [LONG, "long"],
    [BARE, "bare"],
    [SHIP, "ship"],
    [QUIET, "quiet"],
  ]) {
    await rpc("registerRepo", { repo: slug, localPath: REPO_DIRS[name] });
  }

  // --- open: a press opens the form and creates nothing ---------------------------------------
  const before = await sessionIds();
  await openForm();
  await page.waitForTimeout(1_500);
  const afterOpen = await sessionIds();
  observed.open = {
    before: before.length,
    after: afterOpen.length,
    path: new URL(page.url()).pathname,
    creates: creates.length,
  };
  assert(
    "pressing New session opens the form and creates nothing",
    (await dialog().isVisible()) &&
      (await prompt().isVisible()) &&
      creates.length === 0 &&
      JSON.stringify(afterOpen) === JSON.stringify(before) &&
      new URL(page.url()).pathname === "/sessions",
    JSON.stringify(observed.open),
  );
  await page.screenshot({
    path: path.join(EVIDENCE_DIR, "session-new-open.png"),
    fullPage: true,
  });

  // --- empty: no prompt, no request --------------------------------------------------------------
  await submit().click();
  await page.waitForSelector("[data-session-problem='prompt']", {
    timeout: 5_000,
  });
  const problem =
    (await page.locator("[data-session-problem]").textContent()) ?? "";
  await prompt().fill("   \n  ");
  await submit().click();
  await page.waitForTimeout(1_000);
  const afterEmpty = await sessionIds();
  observed.empty = {
    problem,
    invalid: await prompt().getAttribute("aria-invalid"),
    creates: creates.length,
  };
  assert(
    "an empty prompt cannot be submitted, and no createSession request is sent",
    problem === "A session needs a prompt: the task it is delegated." &&
      observed.empty.invalid === "true" &&
      (await page.locator("[data-session-problem='prompt']").isVisible()) &&
      creates.length === 0 &&
      JSON.stringify(afterEmpty) === JSON.stringify(before),
    JSON.stringify(observed.empty),
  );
  await page.screenshot({
    path: path.join(EVIDENCE_DIR, "session-new-empty.png"),
    fullPage: true,
  });

  // --- scratch: the typed prompt, verbatim, on no repo ------------------------------------------
  await prompt().fill(PROMPT);
  const scratchId = await submitAndFollow();
  const scratch = await withFirstEntry(scratchId);
  const firstUser = scratch.entries.find((entry) => entry.kind === "user");
  const scratchRow = (await rpc("listSessions", { limit: 100 })).sessions.find(
    (row) => row.id === scratchId,
  );
  observed.scratch = {
    sessionId: scratchId,
    firstUser: firstUser?.text,
    row: scratchRow,
    createBody: creates.at(-1)?.body,
  };
  assert(
    "one submit sends one createSession",
    creates.length === 1,
    `${creates.length} createSession request(s)`,
  );
  assert(
    "the session's first user entry is the typed prompt verbatim",
    firstUser?.text === PROMPT,
    JSON.stringify({ typed: PROMPT, entry: firstUser?.text ?? null }),
  );
  assert(
    "a session on no repo is listed with no repo",
    scratchRow !== undefined &&
      scratchRow.repo === undefined &&
      scratch.workspace.repo === undefined,
    JSON.stringify(scratchRow ?? null),
  );
  await page
    .getByText("faux-ok (re:", { exact: false })
    .first()
    .waitFor({ timeout: 30_000 })
    .catch(() => {});
  await page.screenshot({
    path: path.join(EVIDENCE_DIR, "session-new-scratch.png"),
    fullPage: true,
  });

  // --- repo: the picked repo and base ref, and a worktree on factory/<id> -----------------------
  await openForm();
  await page.waitForSelector(`#new-session-repo option[value='${WIDGETS}']`, {
    state: "attached",
    timeout: 15_000,
  });
  await prompt().fill(`Fix the widgets (${TAG}).`);
  await page.locator("#new-session-repo").selectOption(WIDGETS);
  await page.locator("#new-session-base").fill(BASE);
  // The form predicts the typed task on the repo picked (LOB-38), once the prompt rests. The oracle
  // is the server's own prediction for the same prompt and repo: the database may hold any history,
  // so the drive compares rather than expecting a fixed answer.
  const oracle = await rpc("predictCost", {
    prompt: `Fix the widgets (${TAG}).`,
    repo: WIDGETS,
  });
  const line = page.locator("p[data-cost-prediction]");
  const predicted = await page
    .waitForFunction(
      (basis) =>
        document
          .querySelector("p[data-cost-prediction]")
          ?.getAttribute("data-cost-prediction") === basis,
      oracle.basis,
      { timeout: 10_000 },
    )
    .then(async () => ({
      basis: await line.getAttribute("data-cost-prediction"),
      high: await line.getAttribute("data-cost-high"),
      text: (await line.textContent())?.trim() ?? "",
    }))
    .catch(async (error) => ({
      basis: null,
      text: `${(await line.textContent())?.trim() ?? ""} (${String(error).slice(0, 120)})`,
    }));
  observed.prediction = { page: predicted, server: oracle };
  assert(
    "the form predicts the typed prompt's cost on the picked repo once it rests",
    predicted.basis === oracle.basis &&
      (oracle.range === undefined
        ? predicted.text.startsWith("No estimate yet:")
        : predicted.text.startsWith("Predicted ") &&
          Number(predicted.high) === oracle.range.high),
    JSON.stringify(observed.prediction),
  );
  const repoId = await submitAndFollow();
  const repoSnapshot = await withFirstEntry(repoId);
  const repoRow = (await rpc("listSessions", { limit: 100 })).sessions.find(
    (row) => row.id === repoId,
  );
  const workspacePath = repoSnapshot.workspace.path;
  const branch = `factory/${repoId}`;
  const head = spawnSync(
    "git",
    ["-C", workspacePath, "rev-parse", "--abbrev-ref", "HEAD"],
    { encoding: "utf8" },
  );
  const commonDir = spawnSync(
    "git",
    [
      "-C",
      workspacePath,
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ],
    { encoding: "utf8" },
  );
  // The worktree starts where the base ref points: the branch the drive typed, one commit ahead of
  // main, so a field the page dropped would show up as main's commit here.
  const started = spawnSync("git", ["-C", workspacePath, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).stdout.trim();
  const worktrees = git(["-C", WIDGETS_DIR, "worktree", "list", "--porcelain"]);
  const realWorkspace = await realpath(workspacePath).catch(
    () => workspacePath,
  );
  observed.repo = {
    sessionId: repoId,
    row: repoRow,
    workspace: repoSnapshot.workspace,
    head: head.stdout.trim(),
    started,
    base: BASE_SHA,
    main: MAIN_SHA,
    commonDir: commonDir.stdout.trim(),
    worktrees,
    createBody: creates.at(-1)?.body,
  };
  assert(
    "the page sent createSession with exactly the form's fields",
    (() => {
      const payload = /"payload":(\{[^}]*\})/.exec(creates.at(-1)?.body ?? "");
      if (payload === null) return false;
      const sent = JSON.parse(payload[1]);
      return (
        JSON.stringify(Object.keys(sent).sort()) ===
          JSON.stringify(["actor", "baseRef", "repo"]) &&
        sent.repo === WIDGETS &&
        sent.baseRef === BASE &&
        sent.actor === "dashboard"
      );
    })(),
    creates.at(-1)?.body ?? "none",
  );
  assert(
    "choosing repo R lists the session with repo R and the base ref typed",
    repoRow?.repo === WIDGETS && repoRow?.baseRef === BASE,
    JSON.stringify(repoRow ?? null),
  );
  assert(
    "its snapshot workspace.path is a git worktree of R on factory/<session-id>",
    repoSnapshot.workspace.repo === WIDGETS &&
      repoSnapshot.workspace.branch === branch &&
      head.status === 0 &&
      head.stdout.trim() === branch &&
      commonDir.stdout.trim() ===
        path.join(await realpath(WIDGETS_DIR), ".git") &&
      worktrees.includes(`worktree ${realWorkspace}`) &&
      worktrees.includes(`branch refs/heads/${branch}`),
    `path=${workspacePath} head=${head.stdout.trim()} commonDir=${commonDir.stdout.trim()}`,
  );
  assert(
    "the worktree was cut from the base ref typed, not the repo's default",
    started === BASE_SHA && started !== MAIN_SHA,
    `started=${started} ${BASE}=${BASE_SHA} main=${MAIN_SHA}`,
  );
  await page.screenshot({
    path: path.join(EVIDENCE_DIR, "session-new-repo.png"),
    fullPage: true,
  });

  // --- context: what the run was told about its repository (F19) -----------------------------------
  const contextLine = async (sessionId) => {
    await page.goto(`${WEB_URL}/sessions/${sessionId}`, {
      waitUntil: "domcontentloaded",
    });
    const line = page.locator("[data-session-context]");
    await line.waitFor({ timeout: 20_000 });
    return {
      text: (await line.textContent())?.trim() ?? "",
      kind: await line.getAttribute("data-session-context"),
      truncated:
        (await line.getAttribute("data-session-context-truncated")) !== null,
    };
  };
  const onRepo = async (repo) => {
    const created = await rpc("createSession", {
      repo,
      baseRef: "main",
      title: `context ${repo}`,
      actor: "dashboard",
    });
    return created.id;
  };
  const widgetsContext = await contextLine(repoId);
  const widgetsRecord = (await rpc("getSessionContext", { sessionId: repoId }))
    .repo;
  const claudeId = await onRepo(CLAUDE);
  const claudeContext = await contextLine(claudeId);
  const longId = await onRepo(LONG);
  const longContext = await contextLine(longId);
  const bareId = await onRepo(BARE);
  const bareContext = await contextLine(bareId);
  const scratchContext = await contextLine(scratchId);
  observed.context = {
    widgets: widgetsContext,
    widgetsRecord,
    claude: claudeContext,
    long: longContext,
    bare: bareContext,
    scratch: scratchContext,
  };
  assert(
    "the pane says the session told AGENTS.md's bytes and tokens, its skills and the nested file",
    widgetsRecord?.instructions?.path === "AGENTS.md" &&
      widgetsRecord.instructions.bytes === Buffer.byteLength(WIDGETS_AGENTS) &&
      widgetsRecord.instructions.tokens > 0 &&
      widgetsContext.text ===
        `told AGENTS.md (${widgetsRecord.instructions.bytes} bytes, ${widgetsRecord.instructions.tokens} tokens) and 2 repo skills and 1 nested AGENTS.md listed` &&
      !widgetsContext.truncated,
    JSON.stringify(observed.context.widgets),
  );
  assert(
    "a repo that keeps only CLAUDE.md is told CLAUDE.md, and the pane names it",
    claudeContext.text.startsWith("told CLAUDE.md (") &&
      !claudeContext.truncated,
    JSON.stringify(claudeContext),
  );
  assert(
    "a file far over the cap is called out as truncated",
    longContext.truncated &&
      longContext.text.startsWith("told AGENTS.md (") &&
      longContext.text.includes("truncated"),
    JSON.stringify(longContext),
  );
  assert(
    "a repo with neither file nor skills, and a scratch session, say no repo instructions",
    bareContext.text === "no repo instructions" &&
      scratchContext.text === "no repo instructions" &&
      scratchContext.kind === "none",
    JSON.stringify({ bare: bareContext, scratch: scratchContext }),
  );
  await contextLine(repoId);
  await page.screenshot({
    path: path.join(EVIDENCE_DIR, "session-new-context.png"),
    fullPage: true,
  });

  // --- openpr: "Open a PR when done" (F17) -------------------------------------------------------
  const ledger = () => JSON.parse(readFileSync(LEDGER, "utf8"));
  const pullsFor = (sessionId) =>
    ledger().pulls.filter((pull) => pull.head === `factory/${sessionId}`);
  /** Wait for the session's run to settle: idle, with an assistant answer in the transcript. */
  const settled = async (sessionId) => {
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const snapshot = await rpc("getSession", { sessionId });
      if (
        !snapshot.live.busy &&
        snapshot.entries.some((entry) => entry.kind === "assistant")
      )
        return snapshot;
      await sleep(100);
    }
    throw new Error(`session ${sessionId}'s run never settled`);
  };
  const startOn = async (repo, { openPr }) => {
    await openForm();
    await page.waitForSelector(`#new-session-repo option[value='${repo}']`, {
      state: "attached",
      timeout: 15_000,
    });
    await prompt().fill(`Ship it on ${repo} (${TAG}).`);
    await page.locator("#new-session-repo").selectOption(repo);
    if (openPr) await page.locator("#new-session-open-pr").check();
    const sentBefore = creates.length;
    const sessionId = await submitAndFollow();
    return { sessionId, body: creates.at(sentBefore)?.body ?? "" };
  };

  await openForm();
  const box = page.locator("#new-session-open-pr");
  const noRepoBox = {
    checked: await box.isChecked(),
    disabled: await box.isDisabled(),
  };
  await page.waitForSelector(`#new-session-repo option[value='${SHIP}']`, {
    state: "attached",
    timeout: 15_000,
  });
  await page.locator("#new-session-repo").selectOption(SHIP);
  const repoBox = {
    checked: await box.isChecked(),
    disabled: await box.isDisabled(),
  };
  await page.screenshot({
    path: path.join(EVIDENCE_DIR, "session-new-open-pr-box.png"),
    fullPage: true,
  });
  assert(
    '"Open a PR when done" is off by default, disabled with no repo and enabled with one',
    !noRepoBox.checked &&
      noRepoBox.disabled &&
      !repoBox.checked &&
      !repoBox.disabled,
    JSON.stringify({ noRepoBox, repoBox }),
  );

  const asked = await startOn(SHIP, { openPr: true });
  await settled(asked.sessionId);
  let askedPr;
  for (let attempt = 0; attempt < 300 && askedPr === undefined; attempt += 1) {
    askedPr = (await rpc("getSession", { sessionId: asked.sessionId })).session
      .prUrl;
    if (askedPr === undefined) await sleep(100);
  }
  const askedPulls = pullsFor(asked.sessionId);
  const linkVisible =
    askedPr === undefined
      ? false
      : await page
          .locator(`a[href="${askedPr}"]`)
          .first()
          .waitFor({ timeout: 15_000 })
          .then(
            () => true,
            () => false,
          );
  observed.openPr = { asked: { ...asked, prUrl: askedPr, pulls: askedPulls } };
  assert(
    "ticked, the createSession carries openPrOnSettle and the run's settle opens exactly one PR on the session's branch",
    asked.body.includes('"openPrOnSettle":true') &&
      askedPr !== undefined &&
      askedPulls.length === 1 &&
      askedPr === askedPulls[0].url,
    JSON.stringify(observed.openPr.asked),
  );
  assert(
    "the session pane links the PR the settle opened",
    linkVisible,
    askedPr ?? "no PR",
  );
  await page.screenshot({
    path: path.join(EVIDENCE_DIR, "session-new-open-pr.png"),
    fullPage: true,
  });

  const unticked = await startOn(SHIP, { openPr: false });
  await settled(unticked.sessionId);
  await sleep(4_000);
  const untickedSnapshot = await rpc("getSession", {
    sessionId: unticked.sessionId,
  });
  assert(
    "unticked, the same repo's run settles with a change and opens no PR: the person's call",
    !unticked.body.includes("openPrOnSettle") &&
      untickedSnapshot.session.prUrl === undefined &&
      pullsFor(unticked.sessionId).length === 0,
    JSON.stringify({
      body: unticked.body,
      prUrl: untickedSnapshot.session.prUrl ?? null,
    }),
  );

  const requestsBefore = ledger().requests.length;
  const quiet = await startOn(QUIET, { openPr: true });
  await settled(quiet.sessionId);
  let quietSnapshot;
  for (let attempt = 0; attempt < 300; attempt += 1) {
    quietSnapshot = await rpc("getSession", { sessionId: quiet.sessionId });
    if (quietSnapshot.entries.some((entry) => entry.text.includes("no change")))
      break;
    await sleep(100);
  }
  assert(
    "ticked on a repo whose run changes nothing, the settle says there is no change and asks the forge for nothing",
    quiet.body.includes('"openPrOnSettle":true') &&
      quietSnapshot?.entries.some((entry) =>
        entry.text.includes("no change"),
      ) === true &&
      quietSnapshot.session.prUrl === undefined &&
      ledger().requests.length === requestsBefore,
    JSON.stringify({
      requests: ledger().requests.length,
      before: requestsBefore,
      prUrl: quietSnapshot?.session.prUrl ?? null,
    }),
  );

  // --- refuse: the server's error, inline ---------------------------------------------------------
  await openForm();
  await page.waitForSelector(`#new-session-repo option[value='${BROKEN}']`, {
    state: "attached",
    timeout: 15_000,
  });
  const brokenPrompt = `Fix the broken repo (${TAG}).`;
  await prompt().fill(brokenPrompt);
  await page.locator("#new-session-repo").selectOption(BROKEN);
  const sentBefore = creates.length;
  await submit().click();
  await page.waitForSelector("[data-session-refusal]", { timeout: 20_000 });
  const serverMessage = answerMessage(await answered(creates.at(-1)));
  const inline =
    (await page.locator("[data-session-refusal]").textContent())?.trim() ?? "";
  observed.refuse = {
    serverMessage,
    inline,
    path: new URL(page.url()).pathname,
    prompt: await prompt().inputValue(),
    // The table itself, not `listSessions`: see `sessionRowsOn`.
    rowsOnBroken: sessionRowsOn(BROKEN),
  };
  assert(
    "an invalid repo shows the server's error inline, and the form keeps the prompt",
    creates.length === sentBefore + 1 &&
      serverMessage !== undefined &&
      serverMessage.includes(BROKEN) &&
      inline === `The server refused the session: ${serverMessage}` &&
      (await dialog().isVisible()) &&
      observed.refuse.prompt === brokenPrompt &&
      observed.refuse.path === "/sessions",
    JSON.stringify(observed.refuse),
  );
  assert(
    "the refused create left no session row behind",
    observed.refuse.rowsOnBroken.length === 0,
    JSON.stringify(observed.refuse.rowsOnBroken),
  );
  await page.screenshot({
    path: path.join(EVIDENCE_DIR, "session-new-refused.png"),
    fullPage: true,
  });

  // --- late: an answer to an opening the person closed ---------------------------------------------
  // The page's next `createSession` is held for HOLD_MS before it goes on to the server, so the close
  // (and the reopen) land while it is pending, as they would on a slow cut.
  const HOLD_MS = 2_500;
  let holdNext = false;
  await page.route("**/rpc**", async (route) => {
    if (
      holdNext &&
      (route.request().postData() ?? "").includes('"tag":"createSession"')
    ) {
      holdNext = false;
      await sleep(HOLD_MS);
    }
    await route.continue();
  });
  const sent = async (count) => {
    for (let attempt = 0; attempt < 100 && creates.length < count; attempt += 1)
      await sleep(50);
    return creates.length >= count;
  };
  const cancel = async () => {
    await dialog().getByRole("button", { name: "Cancel" }).click();
    await dialog().waitFor({ state: "hidden", timeout: 5_000 });
  };
  const toastWith = (text) =>
    page.locator("[data-sonner-toast]", { hasText: text });

  // A refusal for a closed form is a toast in the server's words, not dropped with the form.
  await openForm();
  await page.waitForSelector(`#new-session-repo option[value='${BROKEN}']`, {
    state: "attached",
    timeout: 15_000,
  });
  await prompt().fill(`Fix the broken repo, then walk away (${TAG}).`);
  await page.locator("#new-session-repo").selectOption(BROKEN);
  const beforeLateRefusal = creates.length;
  holdNext = true;
  await submit().click();
  const lateRefusalSent = await sent(beforeLateRefusal + 1);
  await cancel();
  const refusedToast = toastWith("No session was created");
  await refusedToast.waitFor({ timeout: 20_000 });
  const lateMessage = answerMessage(await answered(creates.at(-1)));
  observed.lateRefusal = {
    sent: lateRefusalSent,
    serverMessage: lateMessage,
    toast: (await refusedToast.textContent())?.trim() ?? "",
    path: new URL(page.url()).pathname,
    rowsOnBroken: sessionRowsOn(BROKEN),
  };
  assert(
    "a refusal answered after the form was closed is a toast in the server's words",
    lateRefusalSent &&
      lateMessage !== undefined &&
      lateMessage.includes(BROKEN) &&
      observed.lateRefusal.toast.includes(lateMessage) &&
      observed.lateRefusal.path === "/sessions" &&
      observed.lateRefusal.rowsOnBroken.length === 0,
    JSON.stringify(observed.lateRefusal),
  );
  await page.screenshot({
    path: path.join(EVIDENCE_DIR, "session-new-late-refused.png"),
    fullPage: true,
  });

  // A session landing while a later opening is being typed into neither closes it nor navigates.
  await openForm();
  const latePrompt = `Start, then think better of it (${TAG}).`;
  await prompt().fill(latePrompt);
  const beforeLate = creates.length;
  holdNext = true;
  await submit().click();
  const lateSent = await sent(beforeLate + 1);
  await cancel();
  await page.getByRole("button", { name: "New session" }).click();
  await dialog().waitFor({ timeout: 10_000 });
  const nextTask = `The next task, half typed (${TAG})`;
  await prompt().fill(nextTask);
  const startedToast = toastWith("Session started");
  await startedToast.waitFor({ timeout: 20_000 });
  const toastText = (await startedToast.textContent())?.trim() ?? "";
  const lateId = /ses_[0-9a-z]{26}/.exec(toastText)?.[0];
  observed.lateSession = {
    sent: lateSent,
    toast: toastText,
    path: new URL(page.url()).pathname,
    dialogOpen: await dialog().isVisible(),
    prompt: await prompt().inputValue(),
  };
  assert(
    "a session landing on a later opening leaves that form open with its text, and toasts the session",
    lateSent &&
      lateId !== undefined &&
      observed.lateSession.path === "/sessions" &&
      observed.lateSession.dialogOpen &&
      observed.lateSession.prompt === nextTask,
    JSON.stringify(observed.lateSession),
  );
  await page.screenshot({
    path: path.join(EVIDENCE_DIR, "session-new-late-session.png"),
    fullPage: true,
  });
  // The toast's Open is the way to it: the session it names, whose first entry is the first prompt.
  await startedToast.getByRole("button", { name: "Open" }).click();
  await page.waitForURL(/\/sessions\/ses_[0-9a-z]{26}$/, { timeout: 10_000 });
  const opened = /\/sessions\/(ses_[0-9a-z]{26})$/.exec(page.url())?.[1];
  const lateSnapshot =
    lateId === undefined ? undefined : await withFirstEntry(lateId);
  observed.lateSession.opened = opened;
  observed.lateSession.closedOnOpen = await dialog()
    .waitFor({ state: "hidden", timeout: 5_000 })
    .then(
      () => true,
      () => false,
    );
  observed.lateSession.firstEntry = lateSnapshot?.entries.find(
    (entry) => entry.kind === "user",
  )?.text;
  assert(
    "the toast's Open opens the session it names, which ran the prompt it was sent",
    opened === lateId &&
      observed.lateSession.firstEntry === latePrompt &&
      observed.lateSession.closedOnOpen,
    JSON.stringify({
      opened,
      lateId,
      firstEntry: observed.lateSession.firstEntry,
    }),
  );
  await page.unroute("**/rpc**");

  assert(
    "the page logged no console error",
    consoleErrors.length === 0,
    JSON.stringify(consoleErrors.slice(0, 5)),
  );
} catch (error) {
  assert("the drive ran to the end", false, String(error));
  await page
    .screenshot({
      path: path.join(EVIDENCE_DIR, "session-new-failure.png"),
      fullPage: true,
    })
    .catch(() => {});
} finally {
  observed.consoleErrors = consoleErrors;
  observed.creates = creates.map((create) => create.body);
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
