// Drive the notification settings page (F21) the way a person uses it, against the instance
// `notify-settings.sh` starts, and capture evidence.
//
//   node notify-settings.mjs      (via ./notify-settings.sh, which owns the instance and the fakes)
//
// The notifier tells a person about a card they own on their own sinks, through a loopback SMTP
// server and a loopback Web Push service (both `verify-api/notify-fake.ts`); no real mail or push
// provider is ever called. The drive:
//
//   reach     the rail's **Notifications** opens `/notifications`; the four kinds are on (from
//             NOTIFY_TYPES), the person has no sink, the shared channel is none
//   email     the form adds an address: the row appears without a reload and `getNotificationSettings`
//             says the same; a typo is stopped in the form, nothing sent
//   push      "Notify this browser" subscribes (the browser's `PushManager.subscribe` is the one thing
//             stubbed: it answers a subscription whose endpoint is the fake push service and whose keys
//             this script holds, and the page must have asked with the deployment's VAPID key) and the
//             row appears, naming the push service's host and never the endpoint
//   route     a question on a card the person created reaches the mailbox once and the push service
//             once, the push decrypted with the subscription's key (RFC 8291) and signed with the VAPID
//             key's JWT; a question on a card somebody else created reaches neither
//   toggle    unchecking **Approvals** stops an approval's mail and push without a restart (the API's
//             pid is the same), a question seen after it proves the notifier was alive, and checking it
//             again delivers the approval that was waiting
//   pause     pausing the email sink sends the next event to the push service only; removing the push
//             sink takes its row away, and the settings read back agree
//
// Env: WEB_URL, API_URL, EVIDENCE_DIR, RUN_DIR, FAKE_LEDGER, DATABASE_URL, SEED (the seed script's
// command line is `bun notify-settings-seed.ts`), LINK_BASE, VAPID_PUBLIC_KEY, API_PID_FILE, FAKE_URL.
import { spawnSync } from "node:child_process";
import {
  createDecipheriv,
  createECDH,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const WEB_URL = process.env["WEB_URL"] ?? "http://localhost:3560";
const API_URL = process.env["API_URL"] ?? "http://localhost:9560";
const EVIDENCE_DIR =
  process.env["EVIDENCE_DIR"] ?? ".verify/evidence/latest/notify-settings";
const FAKE_LEDGER = process.env["FAKE_LEDGER"] ?? "";
const FAKE_URL = process.env["FAKE_URL"] ?? "";
const LINK_BASE = process.env["LINK_BASE"] ?? WEB_URL;
const VAPID_PUBLIC_KEY = process.env["VAPID_PUBLIC_KEY"] ?? "";
const API_PID_FILE = process.env["API_PID_FILE"] ?? "";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const TAG = randomBytes(3).toString("hex");
const ADDRESS = `drive-${TAG}@example.test`;
const OTHER = `person:somebody-else-${TAG}`;
/** What the page declares as its actor when the control plane has auth off (`DASHBOARD_ACTOR`). */
const ME = "dashboard";

await mkdir(EVIDENCE_DIR, { recursive: true });
await rm(path.join(EVIDENCE_DIR, "notify-settings-failure.png"), {
  force: true,
});

const observed = { webUrl: WEB_URL, apiUrl: API_URL, tag: TAG, checks: {} };
const assert = (name, condition, detail) => {
  observed.checks[name] = { passed: Boolean(condition), detail };
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}  ${detail}`);
  return Boolean(condition);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** One unary RPC call over the NDJSON envelope, from this process: the oracle, never the page. */
const rpc = async (tag, payload) => {
  const requestId = `notify-settings-${tag}-${Date.now()}-${Math.random()}`;
  const response = await fetch(`${API_URL}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/ndjson" },
    body: `${JSON.stringify({ _tag: "Request", id: requestId, tag, payload, headers: [] })}\n`,
  });
  const envelope = (await response.text())
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line))
    .find((message) => message.requestId === requestId);
  if (envelope?.exit?._tag !== "Success") {
    throw new Error(`${tag} failed: ${JSON.stringify(envelope).slice(0, 400)}`);
  }
  return envelope.exit.value;
};
const settings = () => rpc("getNotificationSettings", { actor: ME });

// --- the loopback fakes' ledger -----------------------------------------------------------------

const ledger = () => JSON.parse(readFileSync(FAKE_LEDGER, "utf8"));
const mails = () => ledger().messages.filter((m) => m.sink === "email");
const pushes = () => ledger().messages.filter((m) => m.sink === "push");

/** The subscription this drive's "browser" holds: keys the page is handed and a push endpoint. */
const browserKey = createECDH("prime256v1");
browserKey.generateKeys();
const authSecret = randomBytes(16);
const SUBSCRIPTION = {
  endpoint: `${FAKE_URL}/push/drive-${TAG}-capability`,
  keys: {
    p256dh: browserKey.getPublicKey().toString("base64url"),
    auth: authSecret.toString("base64url"),
  },
};

/** What a browser does with a push body (RFC 8291 §4, one record); throws on any tampering. */
const decryptPush = (base64) => {
  const body = Buffer.from(base64, "base64");
  const salt = body.subarray(0, 16);
  const idLength = body.readUInt8(20);
  const asPublic = body.subarray(21, 21 + idLength);
  const record = body.subarray(21 + idLength);
  const ikm = Buffer.from(
    hkdfSync(
      "sha256",
      browserKey.computeSecret(asPublic),
      authSecret,
      Buffer.concat([
        Buffer.from("WebPush: info\0"),
        browserKey.getPublicKey(),
        asPublic,
      ]),
      32,
    ),
  );
  const derive = (info, length) =>
    Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from(info), length));
  const decipher = createDecipheriv(
    "aes-128-gcm",
    derive("Content-Encoding: aes128gcm\0", 16),
    derive("Content-Encoding: nonce\0", 12),
  );
  decipher.setAuthTag(record.subarray(record.length - 16));
  const padded = Buffer.concat([
    decipher.update(record.subarray(0, record.length - 16)),
    decipher.final(),
  ]);
  return JSON.parse(padded.subarray(0, padded.lastIndexOf(2)).toString("utf8"));
};

const pushesTo = (link) =>
  pushes().filter((m) => decryptPush(m.body.base64).link === link);
const mailsTo = (link) => mails().filter((m) => m.body.text.includes(link));

/** Seed one event through the service layer, as the owner `owner`; the answer names its link. */
const seed = (mode, owner, title) => {
  const result = spawnSync(
    "bun",
    [path.join(HERE, "notify-settings-seed.ts")],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        MODE: mode,
        OWNER: owner,
        TITLE: title,
        LINK_BASE,
      },
    },
  );
  if (result.status !== 0) {
    throw new Error(`seed ${mode}: ${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout.trim().split("\n").at(-1));
};

const until = async (what, check, ms = 15_000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await sleep(150);
  }
  return false;
};

/** A few polls with nothing new to send: what a second message, or a wrong one, would need to land. */
const settle = () => sleep(2_500);

const browser = await chromium.launch({ channel: "chrome", headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
});
const page = await context.newPage();
const consoleErrors = [];
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});
page.on("pageerror", (error) =>
  consoleErrors.push(`pageerror: ${String(error)}`),
);
// The one stub: the browser's push subscription. The real page code runs against everything else,
// including the real service worker registration; only `PushManager.subscribe`, which would call the
// browser vendor's push service, and the permission prompt, which headless cannot answer, are replaced.
await page.addInitScript((subscription) => {
  window.__subscribeArgs = [];
  PushManager.prototype.subscribe = async function (options) {
    const key = new Uint8Array(options.applicationServerKey);
    window.__subscribeArgs.push({
      userVisibleOnly: options.userVisibleOnly,
      applicationServerKey: btoa(String.fromCharCode(...key))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, ""),
    });
    return { toJSON: () => subscription };
  };
  Notification.requestPermission = async () => "granted";
}, SUBSCRIPTION);

const shot = (name) =>
  page.screenshot({
    path: path.join(EVIDENCE_DIR, `${name}.png`),
    fullPage: true,
  });

let exitCode = 1;
try {
  // --- reach ------------------------------------------------------------------------------------
  await page.goto(`${WEB_URL}/boards`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("nav[aria-label='Sections']", { timeout: 20_000 });
  await page
    .locator("nav[aria-label='Sections'] a[href='/notifications']")
    .click();
  await page.waitForSelector("[data-notify-kinds]", { timeout: 15_000 });
  const current = await page
    .locator("nav[aria-label='Sections'] a[href='/notifications']")
    .getAttribute("aria-current");
  assert(
    "reach: the rail opens /notifications and marks it current",
    current === "page" && new URL(page.url()).pathname === "/notifications",
    `aria-current=${current} path=${new URL(page.url()).pathname}`,
  );
  const kindStates = await page
    .locator("[data-notify-kind]")
    .evaluateAll((boxes) =>
      boxes.map((box) => [box.getAttribute("data-notify-kind"), box.checked]),
    );
  assert(
    "reach: the four kinds are on, as NOTIFY_TYPES leaves them",
    JSON.stringify(kindStates) ===
      JSON.stringify([
        ["question", true],
        ["approval", true],
        ["gate", true],
        ["failed", true],
      ]),
    JSON.stringify(kindStates),
  );
  assert(
    "reach: the person has no sink and the shared channel is none",
    (await page.locator("[data-notify-sinks-empty]").count()) === 1 &&
      (await page.locator("[data-notify-shared]").innerText()).includes(
        "None is configured",
      ),
    "empty list, no shared channel",
  );
  await shot("notifications-empty");

  // --- email ------------------------------------------------------------------------------------
  await page.locator("#notify-email").fill("not an address");
  await page.locator("[data-notify-email-add]").click();
  const typo = await page.locator("[data-notify-problem]").first().innerText();
  assert(
    "email: a typo is stopped in the form, nothing is stored",
    typo.includes("name@example.com") && (await settings()).sinks.length === 0,
    typo,
  );
  await page.locator("#notify-email").fill(ADDRESS);
  await page.locator("[data-notify-email-add]").click();
  await page.waitForSelector("[data-notify-sink-type='email']", {
    timeout: 10_000,
  });
  const emailRow = await page
    .locator("[data-notify-sink-type='email']")
    .innerText();
  const afterEmail = await settings();
  assert(
    "email: the row appears without a reload and the server stored the same address",
    emailRow.includes(ADDRESS) &&
      afterEmail.sinks.length === 1 &&
      afterEmail.sinks[0].label === ADDRESS &&
      afterEmail.sinks[0].enabled === true,
    `${emailRow.trim()} / ${JSON.stringify(afterEmail.sinks)}`,
  );
  const emailId = afterEmail.sinks[0].id;

  // --- push -------------------------------------------------------------------------------------
  await page.locator("[data-notify-push-add]").click();
  await page.waitForSelector("[data-notify-sink-type='web_push']", {
    timeout: 15_000,
  });
  const pushRow = await page
    .locator("[data-notify-sink-type='web_push']")
    .innerText();
  const subscribeArgs = await page.evaluate(() => window.__subscribeArgs);
  const afterPush = await settings();
  const pushHost = new URL(FAKE_URL).host;
  assert(
    "push: the page subscribed with the deployment's VAPID key, and the row names the push service's host",
    subscribeArgs.length === 1 &&
      subscribeArgs[0].applicationServerKey === VAPID_PUBLIC_KEY &&
      subscribeArgs[0].userVisibleOnly === true &&
      pushRow.includes(pushHost) &&
      afterPush.sinks.length === 2,
    `${JSON.stringify(subscribeArgs)} / ${pushRow.trim()}`,
  );
  const pageText = await page.locator("body").innerText();
  const pageHtml = await page.content();
  assert(
    "push: neither the page nor the settings answer holds the endpoint or the keys",
    ![pageText, pageHtml, JSON.stringify(afterPush)].some(
      (text) =>
        text.includes("capability") ||
        text.includes(SUBSCRIPTION.keys.p256dh) ||
        text.includes(SUBSCRIPTION.keys.auth),
    ),
    "no endpoint or key in the DOM or the RPC answer",
  );
  const worker = await page.evaluate(async () => {
    const registration =
      await navigator.serviceWorker.getRegistration("/sw.js");
    return registration?.active?.scriptURL ?? registration?.scope ?? null;
  });
  assert(
    "push: the dashboard's service worker is registered",
    typeof worker === "string" && worker.includes("/"),
    String(worker),
  );
  await shot("notifications-sinks");

  // --- routing ----------------------------------------------------------------------------------
  const apiPid = readFileSync(API_PID_FILE, "utf8").trim();
  const mine = seed("question", ME, `notify-settings ${TAG}: mine`);
  await until(
    "the question's mail and push",
    () => mailsTo(mine.link).length > 0 && pushesTo(mine.link).length > 0,
  );
  await settle();
  const sentMail = mailsTo(mine.link);
  const sentPush = pushesTo(mine.link);
  assert(
    "route: a card the person created reaches their mailbox once, addressed to them, with the link",
    sentMail.length === 1 &&
      sentMail[0].body.to.length === 1 &&
      sentMail[0].body.to[0] === ADDRESS &&
      sentMail[0].body.subject?.includes(mine.title) === true &&
      sentMail[0].body.text.includes("Which locale is the default?"),
    JSON.stringify(
      sentMail.map((m) => ({ to: m.body.to, subject: m.body.subject })),
    ),
  );
  const payload =
    sentPush[0] === undefined ? {} : decryptPush(sentPush[0].body.base64);
  const jwt = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(
    sentPush[0]?.authorization ?? "",
  );
  const claims =
    jwt === null ? {} : JSON.parse(Buffer.from(jwt[2], "base64url").toString());
  assert(
    "route: and the push service once, readable only with the subscription's key, signed as this deployment",
    sentPush.length === 1 &&
      sentPush[0].path.startsWith("/push/drive-") &&
      sentPush[0].body.encoding === "aes128gcm" &&
      payload.kind === "question" &&
      payload.title === `Question on "${mine.title}"` &&
      jwt !== null &&
      jwt[4] === VAPID_PUBLIC_KEY &&
      claims.aud === new URL(FAKE_URL).origin,
    JSON.stringify({ payload, claims }),
  );
  const theirs = seed("question", OTHER, `notify-settings ${TAG}: theirs`);
  await settle();
  assert(
    "route: a card somebody else created reaches neither of this person's sinks",
    mailsTo(theirs.link).length === 0 && pushesTo(theirs.link).length === 0,
    `mails=${mailsTo(theirs.link).length} pushes=${pushesTo(theirs.link).length}`,
  );

  // --- toggle -----------------------------------------------------------------------------------
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-notify-kinds]");
  await page.locator("[data-notify-kind='approval']").uncheck();
  await until(
    "the toggle to be stored",
    async () =>
      (await settings()).kinds.find((k) => k.kind === "approval")?.enabled ===
      false,
  );
  const approval = seed("approval", ME, `notify-settings ${TAG}: approval`);
  const control = seed("question", ME, `notify-settings ${TAG}: control`);
  await until(
    "the control question",
    () => mailsTo(control.link).length > 0 && pushesTo(control.link).length > 0,
  );
  await settle();
  assert(
    "toggle: with Approvals off the approval is not sent, and a question after it is (the notifier is alive)",
    mailsTo(approval.link).length === 0 &&
      pushesTo(approval.link).length === 0 &&
      mailsTo(control.link).length === 1 &&
      pushesTo(control.link).length === 1,
    `approval mails=${mailsTo(approval.link).length} control mails=${mailsTo(control.link).length}`,
  );
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-notify-kinds]");
  const offState = await page
    .locator("[data-notify-kind='approval']")
    .evaluate((box) => box.checked);
  await shot("notifications-approval-off");
  await page.locator("[data-notify-kind='approval']").check();
  await until(
    "the approval's mail and push",
    () =>
      mailsTo(approval.link).length > 0 && pushesTo(approval.link).length > 0,
  );
  await settle();
  assert(
    "toggle: switched on again, the waiting approval is sent once, and the API never restarted",
    offState === false &&
      mailsTo(approval.link).length === 1 &&
      pushesTo(approval.link).length === 1 &&
      readFileSync(API_PID_FILE, "utf8").trim() === apiPid &&
      spawnSync("kill", ["-0", apiPid]).status === 0,
    `mails=${mailsTo(approval.link).length} pushes=${pushesTo(approval.link).length} pid=${apiPid}`,
  );

  // --- pause and remove -------------------------------------------------------------------------
  await page.locator(`[data-notify-sink-enabled='${emailId}']`).uncheck();
  await until(
    "the pause to be stored",
    async () =>
      (await settings()).sinks.find((s) => s.id === emailId)?.enabled === false,
  );
  const paused = seed("question", ME, `notify-settings ${TAG}: paused`);
  await until(
    "the push for the paused-email event",
    () => pushesTo(paused.link).length > 0,
  );
  await settle();
  assert(
    "pause: with the email sink paused the next event reaches the push service only",
    pushesTo(paused.link).length === 1 && mailsTo(paused.link).length === 0,
    `pushes=${pushesTo(paused.link).length} mails=${mailsTo(paused.link).length}`,
  );
  await page.locator("[data-notify-sink-type='web_push'] button").click();
  await page.waitForSelector("[data-notify-sink-type='web_push']", {
    state: "detached",
    timeout: 10_000,
  });
  const afterRemove = await settings();
  assert(
    "pause: removing the push sink takes its row away, and the server agrees",
    afterRemove.sinks.length === 1 &&
      afterRemove.sinks[0].type === "email" &&
      afterRemove.sinks[0].enabled === false,
    JSON.stringify(afterRemove.sinks),
  );
  await shot("notifications-paused");

  assert(
    "the page logged no console error",
    consoleErrors.length === 0,
    JSON.stringify(consoleErrors.slice(0, 5)),
  );
} catch (error) {
  assert("the drive ran to the end", false, String(error));
  await shot("notify-settings-failure").catch(() => {});
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
