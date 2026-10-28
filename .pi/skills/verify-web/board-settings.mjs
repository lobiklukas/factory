// Drive the board settings view (LOB-245) the way an operator reads it, against the instance
// `board-settings.sh` starts (`ROLE_MODELS=specifier=faux/faux-spec`), and capture evidence.
//
//   node board-settings.mjs      (via ./board-settings.sh, which owns the instance this drives)
//
//   page      the board's **Settings** link opens `/boards/$boardId/settings`, which names the
//             definition id and version the board pins, and whose columns — in order, each with its
//             kind, role, model and its source, skills, requirements with their state, moves out and
//             human gates, WIP limit — read back from the page equal `getDefinition` for that version
//             (the oracle, read over the RPC from this process, never the page)
//   facts     on the default pipeline's newest version: planning → building is the human gate "plan
//             approval", specifying's role is `specifier` on the role's model, an unchecked
//             requirement (human_move where the version declares it) is labelled "not yet checked",
//             and the page says the version is the newest
//   pinned    a board pinned to v2 says v3 exists, and its columns are v2's, not the newest's
//   autonomy  (C22) a definition authored with `defineBoard` whose `careful` column gates `sleep` and
//             pushes nothing: its settings page shows each column's effective autonomy — the
//             deployment's gate (`APPROVAL_REQUIRED=npm publish`) on every column, the column's own
//             only on `careful`, write and push scopes — equal to `getDefinition`; and a run started
//             on a card in `careful` parks on an approval for the same command a run in `building`
//             runs unasked
//   lanes     each lane header's disclosure is closed until pressed, then shows its column's facts,
//             equal to the same `getDefinition` column; its link opens the settings page
//   read-only the page holds no form, input or button outside the Upgrade action (D5), which a board
//             with a newer version is offered and a board on the newest is not; and every RPC it
//             sends while nobody presses Upgrade is a read
//   refused   a malformed board id is refused in the page, and a board that does not exist says so
//
// Env: WEB_URL, API_URL, EVIDENCE_DIR.
import { randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";

const WEB_URL = process.env["WEB_URL"] ?? "http://localhost:3471";
const API_URL = process.env["API_URL"] ?? "http://localhost:9471";
const EVIDENCE_DIR =
  process.env["EVIDENCE_DIR"] ?? ".verify/evidence/latest/board-settings";
const ROLE_MODEL = "faux/faux-spec";
// What `board-settings.sh` boots the API with: the deployment's one gate, and the faux run's one call.
const DEPLOYMENT_GATE = "npm publish";
const FAUX_COMMAND = "sleep 0 && echo faux-ok";
const NONE = "—";

const TAG = randomBytes(4).toString("hex");
const NEWEST_REPO = `verify-board-settings-${TAG}/newest`;
const PINNED_REPO = `verify-board-settings-${TAG}/pinned`;
const AUTONOMY_REPO = `verify-board-settings-${TAG}/autonomy`;
const AUTONOMY_DEFINITION = `autonomy-${TAG}`;

await mkdir(EVIDENCE_DIR, { recursive: true });
// A failure shot from an earlier run must not sit beside this run's passing evidence.
await rm(path.join(EVIDENCE_DIR, "board-settings-failure.png"), {
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
  const requestId = `board-settings-${tag}-${Date.now()}-${Math.random()}`;
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

/**
 * A described column as the page must show it: `getDefinition`'s column, in the page's words. The
 * page's words are the contract — "—" for no role, "not yet checked" for an unchecked requirement —
 * so this is written out here rather than imported from the page's own code.
 */
const expectedColumn = (column) => ({
  name: column.name,
  kind: column.kind,
  role: column.role ?? NONE,
  model: column.model.model,
  modelSource: column.model.source,
  skills: column.skills,
  requires: column.requires.map((requirement) => ({
    key: requirement.key,
    description: requirement.description.trim(),
    state: requirement.checked ? "checked" : "not yet checked",
  })),
  exits: column.exits.map((exit) => ({
    to: exit.to,
    gate: exit.humanGate ?? null,
  })),
  wipLimit:
    column.wipLimit === undefined
      ? null
      : `at most ${column.wipLimit} run${column.wipLimit === 1 ? "" : "s"} in flight`,
  autonomy:
    column.autonomy === undefined
      ? null
      : {
          gates: column.autonomy.approvalRequired.map((gate) => ({
            command: gate.command,
            source: gate.source,
          })),
          write: column.autonomy.write,
          push: column.autonomy.push,
        },
});

const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const consoleErrors = [];
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});
page.on("pageerror", (error) =>
  consoleErrors.push(`pageerror: ${String(error)}`),
);

/**
 * Every RPC tag the browser sends while it is on a settings page, read off the requests themselves:
 * the page is read-only, so each must be one of its two reads or a read the shell around every page
 * makes. A write that a later change puts on the page shows up here as an unexpected tag.
 */
const SETTINGS_READS = new Set(["getBoardConfig", "listDefinitions"]);
// The board's cards (D5, `boardAtom`, once the definitions list has landed, so a capture can end
// before them): the Upgrade action offers the pin itself, and a row per column, for the cards an
// earlier upgrade left on an older version — `getDefinition` when a card pins another version.
const SETTINGS_READS_SOMETIMES = new Set([
  "getBoard",
  "listBoardCards",
  "getDefinition",
]);
const SHELL_READS = new Set([
  // The rail's "Needs a person" count (LOB-271) and the faux banner (LOB-272), on every page.
  "listAttention",
  "getServerInfo",
  // The sidebar's board and session lists.
  "listBoards",
  "listSessions",
  // The board page's getting-started checklist (C9) polls these; a poll in flight when the drive
  // presses Settings lands after the URL changed. Reads all the same.
  "listRepos",
  "listTasks",
  "listTaskRuns",
]);
const settingsRpcTags = [];
page.on("request", (request) => {
  if (!/\/rpc\/?$/.test(request.url()) || request.method() !== "POST") return;
  if (!/\/boards\/[^/]+\/settings/.test(page.url())) return;
  for (const line of (request.postData() ?? "").split("\n")) {
    try {
      const message = JSON.parse(line);
      if (message?._tag === "Request") settingsRpcTags.push(message.tag);
    } catch {
      // Not an envelope line.
    }
  }
});

/**
 * The controls inside a settings page that could change something, outside its Upgrade action (D5):
 * none. The Upgrade action is the page's one write, offered only when a newer version exists, and
 * `.pi/skills/verify-board/upgrade.mjs` drives it.
 */
const writeControls = (boardId) =>
  page.$$eval(
    `[data-board-settings-page='${boardId}'] :is(form, input, textarea, select, button, [contenteditable='true'], [role='button'])`,
    (nodes) =>
      nodes
        .filter((node) => node.closest("[data-board-upgrade]") === null)
        .map((node) => node.outerHTML.slice(0, 120)),
  );

/** Whether the settings page offers the Upgrade action (D5). */
const upgradeOffered = (boardId) =>
  page
    .locator(`[data-board-settings-page='${boardId}'] [data-board-upgrade]`)
    .count();

/** Every column's facts under `scope`, read from what the page renders. */
const readColumns = (scope) =>
  page.$$eval(`${scope} [data-column-settings]`, (nodes) =>
    nodes.map((node) => {
      const text = (element) => element?.textContent?.trim() ?? null;
      const model = node.querySelector("[data-column-model]");
      return {
        name: node.getAttribute("data-column-settings"),
        kind: text(node.querySelector("[data-column-kind]")),
        role: text(node.querySelector("[data-column-role]")),
        model: text(model),
        modelSource: model?.getAttribute("data-column-model-source") ?? null,
        skills: [...node.querySelectorAll("[data-column-skill]")].map(text),
        requires: [...node.querySelectorAll("[data-requirement]")].map(
          (item) => ({
            key: text(item.querySelector("[data-requirement-key]")),
            description: text(
              item.querySelector("[data-requirement-description]"),
            ),
            state: text(item.querySelector("[data-requirement-state]")),
          }),
        ),
        exits: [...node.querySelectorAll("[data-exit]")].map((item) => ({
          to: text(item.querySelector("[data-exit-to]")),
          gate: text(item.querySelector("[data-exit-gate]")),
        })),
        wipLimit: text(node.querySelector("[data-column-wip]")),
        autonomy:
          node.querySelector("[data-column-write]") === null
            ? null
            : {
                gates: [...node.querySelectorAll("[data-gate]")].map(
                  (item) => ({
                    command: text(item.querySelector("[data-gate-command]")),
                    source: item.getAttribute("data-gate-source"),
                  }),
                ),
                write: node
                  .querySelector("[data-column-write]")
                  ?.getAttribute("data-column-write"),
                push: node
                  .querySelector("[data-column-push]")
                  ?.getAttribute("data-column-push"),
              },
      };
    }),
  );

/** The page-level facts of a settings page: which definition version it says the board pins. */
const readHeader = () =>
  page.evaluate(() => {
    const definition = document.querySelector("[data-settings-definition]");
    const newer = document.querySelector("[data-newer-versions]");
    return {
      definitionId: definition?.getAttribute("data-settings-definition"),
      version: Number(definition?.getAttribute("data-settings-version")),
      definitionText: definition?.textContent?.trim() ?? "",
      initial:
        document.querySelector("[data-settings-initial]")?.textContent ?? "",
      caps: document.querySelector("[data-settings-caps]")?.textContent ?? "",
      newer: newer?.getAttribute("data-newer-versions") ?? null,
      newerText: newer?.textContent?.trim() ?? null,
      newest: document.querySelector("[data-newest-version]") !== null,
      order: [...document.querySelectorAll("[data-settings-column]")].map(
        (node) => node.getAttribute("data-settings-column"),
      ),
    };
  });

/** Open a board, press its **Settings** link, and wait for the page to list its columns. */
const openSettings = async (boardId) => {
  await page.goto(`${WEB_URL}/boards/${boardId}`, {
    waitUntil: "domcontentloaded",
  });
  await page.locator("[data-board-settings]").click();
  await page.waitForURL(`${WEB_URL}/boards/${boardId}/settings`, {
    timeout: 15_000,
  });
  await page.waitForSelector("[data-settings-column] [data-column-settings]", {
    timeout: 15_000,
  });
  // The newer-version line reads `listDefinitions` on its own; wait for its answer too.
  await page.waitForSelector(
    "[data-newer-versions], [data-newest-version], [data-newer-versions-unknown]",
    { timeout: 15_000 },
  );
};

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

let exitCode = 0;
try {
  const definitions = await rpc("listDefinitions", {});
  const defaults = definitions.find(
    (definition) => definition.id === "default",
  );
  const versions = defaults?.versions.map((entry) => entry.version) ?? [];
  const newestVersion = Math.max(...versions);
  observed.versions = versions;
  assert(
    "the default definition holds v2, v3 and a newest version",
    versions.includes(2) && versions.includes(3) && newestVersion >= 3,
    JSON.stringify(versions),
  );

  const newestBoard = await rpc("createBoard", {
    repo: NEWEST_REPO,
    definitionId: "default",
  });
  const pinnedBoard = await rpc("createBoard", {
    repo: PINNED_REPO,
    definitionId: "default",
    definitionVersion: 2,
  });
  observed.boards = { newest: newestBoard.id, pinned: pinnedBoard.id };
  const newestDefinition = await rpc("getDefinition", {
    definitionId: "default",
    version: newestBoard.definitionVersion,
  });
  const pinnedDefinition = await rpc("getDefinition", {
    definitionId: "default",
    version: 2,
  });
  observed.oracle = { newest: newestDefinition, pinned: pinnedDefinition };

  // --- page: the newest board's settings equal getDefinition ------------------------------------
  await openSettings(newestBoard.id);
  const header = await readHeader();
  observed.newestHeader = header;
  assert(
    "the board's Settings link opens a page naming the definition id and version it pins",
    header.definitionId === "default" &&
      header.version === newestBoard.definitionVersion &&
      header.definitionText.includes(
        `default v${newestBoard.definitionVersion}`,
      ),
    JSON.stringify(header.definitionText),
  );
  assert(
    "the page lists the version's columns in declaration order",
    same(
      header.order,
      newestDefinition.columns.map((column) => column.name),
    ),
    JSON.stringify(header.order),
  );
  assert(
    "it names the column a new card starts in",
    header.initial === (newestDefinition.initialColumn ?? NONE),
    header.initial,
  );
  const shown = await readColumns("[data-settings-column]");
  const expected = newestDefinition.columns.map(expectedColumn);
  observed.newestShown = shown;
  assert(
    "every column's kind, role, model, skills, requirements, moves and gates equal getDefinition",
    same(shown, expected),
    same(shown, expected)
      ? `${shown.length} columns`
      : `shown=${JSON.stringify(shown)} expected=${JSON.stringify(expected)}`,
  );
  assert(
    "the comparison covers skills and requirements, not only empty lists",
    expected.some((column) => column.skills.length > 0) &&
      expected.some((column) => column.requires.length > 0),
    `skills=${expected.flatMap((column) => column.skills).length} requires=${expected.flatMap((column) => column.requires).length}`,
  );

  // --- facts: the acceptance's named cases, read off the page ------------------------------------
  const gate = await page
    .locator(
      "[data-settings-column='planning'] [data-exit='building'] [data-exit-gate]",
    )
    .textContent();
  assert(
    "planning → building is listed as the human gate 'plan approval'",
    gate?.trim() === "plan approval",
    String(gate),
  );
  const specifying = shown.find((column) => column.name === "specifying");
  assert(
    "specifying's role is specifier, on the role's model",
    specifying?.role === "specifier" &&
      specifying.model === ROLE_MODEL &&
      specifying.modelSource === "role",
    JSON.stringify(specifying),
  );
  assert(
    "a column with no role row runs the deployment's model, and says so",
    shown.some(
      (column) =>
        column.modelSource === "deployment" && column.model !== ROLE_MODEL,
    ),
    JSON.stringify(shown.map((column) => [column.name, column.modelSource])),
  );
  const unchecked = newestDefinition.columns.flatMap((column) =>
    column.requires
      .filter((requirement) => !requirement.checked)
      .map((requirement) => ({ column: column.name, key: requirement.key })),
  );
  const named =
    unchecked.find((entry) => entry.key === "human_move") ?? unchecked[0];
  const namedState =
    named === undefined
      ? null
      : await page
          .locator(
            `[data-settings-column='${named.column}'] [data-requirement='${named.key}'] [data-requirement-state]`,
          )
          .textContent();
  assert(
    "an unchecked requirement (human_move where declared) is labelled 'not yet checked'",
    named !== undefined && namedState?.trim() === "not yet checked",
    `${named?.column}.${named?.key}: ${namedState}`,
  );
  const checked = newestDefinition.columns.flatMap((column) =>
    column.requires
      .filter((requirement) => requirement.checked)
      .map((requirement) => ({ column: column.name, key: requirement.key })),
  );
  const checkedState =
    checked[0] === undefined
      ? null
      : await page
          .locator(
            `[data-settings-column='${checked[0].column}'] [data-requirement='${checked[0].key}'] [data-requirement-state]`,
          )
          .textContent();
  assert(
    "a checked requirement is labelled 'checked'",
    checked[0] !== undefined && checkedState?.trim() === "checked",
    `${checked[0]?.column}.${checked[0]?.key}: ${checkedState}`,
  );
  const newestOffered = await upgradeOffered(newestBoard.id);
  assert(
    "a board on the newest version says it is the newest, claims no newer one, and offers no upgrade",
    header.newest && header.newer === null && newestOffered === 0,
    JSON.stringify({
      newest: header.newest,
      newer: header.newer,
      upgrade: newestOffered,
    }),
  );
  await page.screenshot({
    path: path.join(EVIDENCE_DIR, "board-settings-newest.png"),
    fullPage: true,
  });

  // --- pinned: a board on v2 says v3 exists --------------------------------------------------------
  await openSettings(pinnedBoard.id);
  const pinnedHeader = await readHeader();
  observed.pinnedHeader = pinnedHeader;
  const newerExpected = versions.filter((version) => version > 2);
  assert(
    "a board pinned to v2 says v3 exists",
    pinnedHeader.version === 2 &&
      pinnedHeader.newer === newerExpected.join(",") &&
      (pinnedHeader.newerText ?? "").includes("v3") &&
      (pinnedHeader.newerText ?? "").includes("stays pinned to v2"),
    JSON.stringify({
      newer: pinnedHeader.newer,
      text: pinnedHeader.newerText,
    }),
  );
  const pinnedShown = await readColumns("[data-settings-column]");
  const pinnedExpected = pinnedDefinition.columns.map(expectedColumn);
  assert(
    "its columns equal getDefinition for v2, not the newest version",
    same(pinnedShown, pinnedExpected) && !same(pinnedExpected, expected),
    same(pinnedShown, pinnedExpected)
      ? `${pinnedShown.length} columns`
      : `shown=${JSON.stringify(pinnedShown)} expected=${JSON.stringify(pinnedExpected)}`,
  );
  await page.screenshot({
    path: path.join(EVIDENCE_DIR, "board-settings-pinned.png"),
    fullPage: true,
  });

  // --- read-only: the page offers no control that changes anything, and sends only reads ---------
  const controls = await writeControls(pinnedBoard.id);
  observed.writeControls = controls;
  const pinnedPageShown = await page
    .locator(`[data-board-settings-page='${pinnedBoard.id}']`)
    .count();
  const offered = await upgradeOffered(pinnedBoard.id);
  assert(
    "the settings page holds no form, input or button outside the Upgrade action, which a board on v2 is offered",
    pinnedPageShown === 1 && controls.length === 0 && offered === 1,
    controls.length === 0
      ? `page found=${pinnedPageShown}; upgrade offered=${offered}`
      : JSON.stringify(controls),
  );

  // --- autonomy: a column's gates and scopes, shown and enforced (C22) ---------------------------
  const authored = await rpc("defineBoard", {
    id: AUTONOMY_DEFINITION,
    name: "Autonomy per column",
    initialColumn: "todo",
    columns: [
      {
        name: "todo",
        kind: "resting",
        skills: [],
        requires: [],
        transitions: [
          { to: "building" },
          { to: "careful" },
          { to: "canceled" },
        ],
      },
      {
        name: "building",
        kind: "working",
        skills: [],
        requires: [],
        transitions: [{ to: "done" }, { to: "canceled" }],
      },
      {
        name: "careful",
        kind: "working",
        skills: [],
        requires: [],
        transitions: [{ to: "done" }, { to: "canceled" }],
        autonomy: { approvalRequired: ["sleep"], push: "none" },
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
  const autonomyBoard = await rpc("createBoard", {
    repo: AUTONOMY_REPO,
    definitionId: AUTONOMY_DEFINITION,
  });
  observed.boards.autonomy = autonomyBoard.id;
  const autonomyDefinition = await rpc("getDefinition", {
    definitionId: AUTONOMY_DEFINITION,
    version: autonomyBoard.definitionVersion,
  });
  observed.oracle.autonomy = autonomyDefinition;
  const described = (name) =>
    autonomyDefinition.columns.find((column) => column.name === name)?.autonomy;
  assert(
    "getDefinition describes the gated column with the deployment's gate and its own, and pushes nothing",
    authored.outcome === "created" &&
      same(described("careful"), {
        approvalRequired: [
          { command: DEPLOYMENT_GATE, source: "deployment" },
          { command: "sleep", source: "column" },
        ],
        write: "worktree",
        push: "none",
      }) &&
      same(described("building"), {
        approvalRequired: [{ command: DEPLOYMENT_GATE, source: "deployment" }],
        write: "worktree",
        push: "branch",
      }),
    JSON.stringify({
      careful: described("careful"),
      building: described("building"),
    }),
  );
  await openSettings(autonomyBoard.id);
  const autonomyShown = await readColumns("[data-settings-column]");
  const autonomyExpected = autonomyDefinition.columns.map(expectedColumn);
  observed.autonomyShown = autonomyShown;
  assert(
    "the settings page shows each column's effective autonomy, equal to getDefinition",
    same(autonomyShown, autonomyExpected) &&
      autonomyExpected.every((column) => column.autonomy !== null),
    same(autonomyShown, autonomyExpected)
      ? JSON.stringify(
          autonomyShown.map((column) => [column.name, column.autonomy]),
        )
      : `shown=${JSON.stringify(autonomyShown)} expected=${JSON.stringify(autonomyExpected)}`,
  );
  const carefulText = await page
    .locator("[data-settings-column='careful'] [data-column-settings]")
    .textContent();
  assert(
    "the gated column reads its gate as its own and the deployment's as the deployment's",
    (carefulText ?? "").includes("this column") &&
      (carefulText ?? "").includes("deployment") &&
      (carefulText ?? "").includes("the PR step pushes"),
    JSON.stringify(carefulText),
  );
  await page.locator("[data-settings-column='careful']").screenshot({
    path: path.join(EVIDENCE_DIR, "board-settings-autonomy.png"),
  });
  await page.screenshot({
    path: path.join(EVIDENCE_DIR, "board-settings-autonomy-page.png"),
    fullPage: true,
  });

  /** A card moved into `column`, a run started on it, one message sent, and the run settled. */
  const runIn = async (column) => {
    const task = await rpc("createTask", {
      boardId: autonomyBoard.id,
      title: `a run in ${column}`,
      actor: "verify@local",
    });
    await rpc("moveTask", {
      taskId: task.id,
      expectedRevision: task.revision,
      to: column,
      actor: "verify@local",
    });
    const session = await rpc("createSession", {
      taskId: task.id,
      taskColumn: column,
    });
    await rpc("sendMessage", { sessionId: session.id, content: "go" });
    let snapshot;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      snapshot = await rpc("getSession", { sessionId: session.id });
      const settled =
        !snapshot.live.busy &&
        snapshot.entries.some((entry) => entry.kind === "toolResult");
      if (settled) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const approvals = await rpc("listApprovals", { sessionId: session.id });
    const result = snapshot?.entries.find(
      (entry) => entry.kind === "toolResult",
    );
    return {
      sessionId: session.id,
      status: snapshot?.session.status,
      pending: approvals.approvals.map((approval) => ({
        action: approval.action,
        detail: approval.detail,
      })),
      result: result?.text ?? null,
    };
  };
  const careful = await runIn("careful");
  const building = await runIn("building");
  observed.autonomyRuns = { careful, building };
  assert(
    "a run in the gated column parks on an approval for the column's gate, its command not run",
    careful.status === "idle" &&
      careful.pending.length === 1 &&
      careful.pending[0]?.action === "sleep" &&
      careful.pending[0]?.detail === FAUX_COMMAND &&
      (careful.result ?? "").includes("asked for") &&
      !(careful.result ?? "").includes("faux-ok"),
    JSON.stringify(careful),
  );
  assert(
    "the same command in the other column of the same board runs unasked",
    building.pending.length === 0 &&
      (building.result ?? "").includes("faux-ok"),
    JSON.stringify(building),
  );

  // --- lanes: each header's disclosure says the same as the page ---------------------------------
  await page.goto(`${WEB_URL}/boards/${newestBoard.id}`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForSelector("[data-lane-settings-toggle]", {
    timeout: 15_000,
  });
  const closedBefore = await page
    .locator("[data-lane-settings] [data-column-settings]")
    .count();
  assert(
    "every lane's disclosure is closed until pressed",
    closedBefore === 0,
    `${closedBefore} open`,
  );
  const laneMismatches = [];
  for (const column of newestDefinition.columns) {
    await page.locator(`[data-lane-settings-toggle='${column.name}']`).click();
    await page.waitForSelector(
      `[data-lane-settings='${column.name}'] [data-column-settings]`,
      { timeout: 15_000 },
    );
    const [lane] = await readColumns(`[data-lane-settings='${column.name}']`);
    if (!same(lane, expectedColumn(column))) {
      laneMismatches.push({ shown: lane, expected: expectedColumn(column) });
    }
  }
  assert(
    "each lane's disclosure shows its column's facts, equal to getDefinition",
    laneMismatches.length === 0,
    laneMismatches.length === 0
      ? `${newestDefinition.columns.length} lanes`
      : JSON.stringify(laneMismatches),
  );
  await page.screenshot({
    path: path.join(EVIDENCE_DIR, "board-settings-lanes.png"),
    fullPage: true,
  });
  await page.locator("[data-lane-settings-toggle='planning']").click();
  await page.waitForFunction(
    () =>
      document.querySelector(
        "[data-lane-settings='planning'] [data-column-settings]",
      ) === null,
    undefined,
    { timeout: 5_000 },
  );
  assert(
    "pressing it again closes it",
    (await page
      .locator("[data-lane-settings='planning'] [data-column-settings]")
      .count()) === 0,
    "planning closed",
  );
  await page
    .locator("[data-lane-settings='specifying']")
    .getByRole("link", { name: "Every column's settings" })
    .click();
  await page.waitForURL(`${WEB_URL}/boards/${newestBoard.id}/settings`, {
    timeout: 15_000,
  });
  assert(
    "a disclosure's link opens the board's settings page",
    page.url() === `${WEB_URL}/boards/${newestBoard.id}/settings`,
    page.url(),
  );

  const unexpectedTags = [
    ...new Set(
      settingsRpcTags.filter(
        (tag) =>
          !SETTINGS_READS.has(tag) &&
          !SETTINGS_READS_SOMETIMES.has(tag) &&
          !SHELL_READS.has(tag),
      ),
    ),
  ];
  observed.settingsRpcTags = [...new Set(settingsRpcTags)];
  assert(
    "the settings page sends only reads: getBoardConfig, listDefinitions, the board's cards and the shell's own",
    [...SETTINGS_READS].every((tag) => settingsRpcTags.includes(tag)) &&
      unexpectedTags.length === 0,
    unexpectedTags.length === 0
      ? JSON.stringify(observed.settingsRpcTags)
      : `unexpected=${JSON.stringify(unexpectedTags)}`,
  );

  assert(
    "the page logged no console error",
    consoleErrors.length === 0,
    JSON.stringify(consoleErrors.slice(0, 5)),
  );

  // --- refused: a malformed id, and a board that does not exist ----------------------------------
  await page.goto(`${WEB_URL}/boards/not-a-board/settings`, {
    waitUntil: "domcontentloaded",
  });
  const malformed = await page
    .getByText("Not a board id this control plane mints")
    .waitFor({ timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  assert(
    "a malformed board id is refused in the page",
    malformed,
    "not-a-board",
  );
  await page.goto(`${WEB_URL}/boards/brd_00000000000000000000000000/settings`, {
    waitUntil: "domcontentloaded",
  });
  const missing = await page
    .getByText("No such board")
    .waitFor({ timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  assert(
    "a board the server does not hold says there is no such board",
    missing,
    "brd_00000000000000000000000000",
  );
  await page.screenshot({
    path: path.join(EVIDENCE_DIR, "board-settings-missing.png"),
    fullPage: true,
  });
} catch (error) {
  assert("the drive ran to the end", false, String(error));
  await page
    .screenshot({
      path: path.join(EVIDENCE_DIR, "board-settings-failure.png"),
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
