// Drive a long session's earlier history in the dashboard (LOB-243) the way a person reads one,
// against the instance `history.sh` starts, and capture evidence.
//
//   node history.mjs      (via ./history.sh, which grows and releases the session first)
//
//   window    the session's pane reads `historical fold`, shows the newest entries only — not the
//             first message — and a **Show earlier entries** control
//   earlier   each press reads one page (`readSessionHistory`, one call per press) and puts it on
//             top; once the first entry is in, the control is gone
//   whole     every turn's message is on screen exactly once and in order, the first one first,
//             and the page logged no console error
//
// Env: WEB_URL, API_URL, EVIDENCE_DIR, SESSION, TURNS.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";

const WEB_URL = process.env["WEB_URL"] ?? "http://localhost:3437";
const EVIDENCE_DIR =
  process.env["EVIDENCE_DIR"] ?? ".verify/evidence/latest/history";
const SESSION = process.env["SESSION"] ?? "";
const TURNS = Number(process.env["TURNS"] ?? "0");

await mkdir(EVIDENCE_DIR, { recursive: true });

const observed = {
  webUrl: WEB_URL,
  session: SESSION,
  turns: TURNS,
  checks: {},
};
const assert = (name, condition, detail) => {
  observed.checks[name] = { passed: Boolean(condition), detail };
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}  ${detail}`);
  return Boolean(condition);
};
const turnText = (turn) => `history turn ${turn}`;

const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const consoleErrors = [];
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});
page.on("pageerror", (error) =>
  consoleErrors.push(`pageerror: ${String(error)}`),
);
const historyCalls = [];
page.on("request", (request) => {
  if (!/\/rpc\/?$/.test(request.url())) return;
  for (const line of (request.postData() ?? "").split("\n")) {
    try {
      const message = JSON.parse(line);
      if (message?.tag === "readSessionHistory")
        historyCalls.push(message.payload);
    } catch {
      // Not an envelope line.
    }
  }
});
const shot = (name) =>
  page.screenshot({ path: path.join(EVIDENCE_DIR, `${name}.png`) });

/** The user messages the transcript shows, in order, and whether the control is there. */
const readPane = () =>
  page.evaluate(() => {
    const items = [
      ...document.querySelectorAll('[data-slot="message-scroller-item"]'),
    ];
    const texts = items.map((item) => item.textContent ?? "");
    const control = document.querySelector("[data-show-earlier]");
    return {
      rows: items.length,
      messages: texts.flatMap((text) => {
        // The user's own message, not the faux reply quoting it (`faux-ok (re: history turn N)`).
        const found = text.match(/(?<!re: )history turn \d+/);
        return found === null ? [] : [found[0]];
      }),
      control: control?.getAttribute("data-show-earlier") ?? null,
      mode: document.body.textContent?.includes("historical fold") ?? false,
    };
  });

try {
  await page.goto(`${WEB_URL}/sessions/${SESSION}`);
  await page
    .waitForSelector("[data-show-earlier]", { timeout: 30_000 })
    .catch(() => undefined);
  const first = await readPane();
  observed.window = first;
  await shot("history-window");
  assert(
    "the pane reads the fold, with a Show earlier entries control",
    first.mode && first.control !== null,
    `mode=${first.mode} control=${first.control}`,
  );
  assert(
    "it shows the newest entries only: not the first message, the last one",
    !first.messages.includes(turnText(0)) &&
      first.messages.at(-1) === turnText(TURNS - 1),
    `messages=${first.messages.length} first=${first.messages[0]} last=${first.messages.at(-1)}`,
  );

  let presses = 0;
  let pane = first;
  while (pane.control !== null && presses < 20) {
    const before = pane.rows;
    await page.locator("[data-show-earlier]").click();
    presses += 1;
    await page
      .waitForFunction(
        (rows) =>
          document.querySelectorAll('[data-slot="message-scroller-item"]')
            .length > rows,
        before,
        { timeout: 15_000, polling: 100 },
      )
      .catch(() => undefined);
    pane = await readPane();
  }
  observed.presses = presses;
  observed.historyCalls = historyCalls;
  observed.after = pane;
  await page
    .locator("[data-slot='message-scroller-viewport']")
    .evaluate((el) => {
      el.scrollTop = 0;
    });
  await shot("history-first-entry");
  assert(
    "each press read one page, before the oldest entry shown",
    presses > 0 &&
      historyCalls.length === presses &&
      historyCalls[0]?.before === first.control &&
      historyCalls.every((call) => call.sessionId === SESSION),
    `presses=${presses} calls=${historyCalls.length} firstBefore=${historyCalls[0]?.before}`,
  );
  assert(
    "the control is gone once the first entry is on screen",
    pane.control === null,
    `control=${pane.control}`,
  );
  assert(
    "every turn's message is on screen exactly once, in order, the first one first",
    JSON.stringify(pane.messages) ===
      JSON.stringify(Array.from({ length: TURNS }, (_, at) => turnText(at))),
    `messages=${pane.messages.length} turns=${TURNS} first=${pane.messages[0]}`,
  );
} catch (error) {
  assert("the drive completed", false, `threw: ${String(error)}`);
}

assert(
  "the page logged no console error",
  consoleErrors.length === 0,
  JSON.stringify(consoleErrors.slice(0, 5)),
);
observed.consoleErrors = consoleErrors;
await writeFile(
  path.join(EVIDENCE_DIR, "observed.json"),
  `${JSON.stringify(observed, null, 2)}\n`,
);
await browser.close();

const failures = Object.values(observed.checks).filter((c) => !c.passed);
console.log(
  `\n${Object.keys(observed.checks).length - failures.length}/${Object.keys(observed.checks).length} checks passed`,
);
process.exit(failures.length === 0 ? 0 : 1);
