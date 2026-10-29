// Scheduled automations over the real API, its real clock and the real CLI (S-general-automations).
//
//   bun automations.ts      (via ./automations.sh, which boots the API twice with AUTOMATIONS_POLL_MS=1000)
//
// One fixture repo — a local git checkout with no remote — registered over RPC, with a board. Two
// phases around a restart of the API, which the shell performs between them:
//
//   before  `factory automation add --cron "* * * * *"`; the API's own clock fires the first minute:
//           one tick `started`, one card on the board under `automation:<id>@<minute>`, one run on it.
//           A few more passes inside the same minute fire nothing more.
//   after   the restarted API's passes reach the same minute and fire nothing: still one tick, one
//           card, one run. The next minute, with no commit on `main`, is recorded `skipped` with the
//           reason (`factory automation history` prints it). `factory automation run` starts one at
//           once (a card and a run, though the base has not moved). `factory automation pause` stops
//           the clock: the next minute passes with no scheduled tick. `factory automation rm` last.
//
// The cards are moved to `canceled` with one SQL update between ticks, as the core suite does, so the
// board's run cap (B9) is never what a check meets.
//
// Env: API_URL, DATABASE_URL (the run's database, to read cards and runs), AUTOMATIONS_PHASE
// (`before` | `after`), AUTOMATIONS_STATE (the file the phases share), AUTOMATIONS_REPOS, EVIDENCE_DIR.
import { execSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { AutomationId, type AutomationTick } from "@repo/domain/Automation";
import { RpcApi } from "@repo/domain/Rpc";
import { RepoSlug } from "@repo/domain/Session";
import { DefinitionId } from "@repo/domain/Task";
import { DatabaseLive } from "@repo/storage-postgres";
import { Effect, Exit, Layer } from "effect";
import { RpcClient } from "effect/rpc";
import { SqlClient } from "effect/sql/SqlClient";
import { makeChecker, protocolFor } from "./harness.ts";
import type { CheckRecord } from "./harness.ts";

const API_URL = process.env["API_URL"] ?? "http://localhost:9200";
const PHASE = process.env["AUTOMATIONS_PHASE"] ?? "before";
const REPOS = path.resolve(
  process.env["AUTOMATIONS_REPOS"] ?? ".verify/run/automations/repos",
);
const STATE = path.resolve(
  process.env["AUTOMATIONS_STATE"] ?? ".verify/run/automations/state.json",
);
const EVIDENCE_DIR = path.resolve(
  process.env["EVIDENCE_DIR"] ?? ".verify/evidence/latest/api",
);
const ROOT = path.resolve(import.meta.dirname, "..", "..", "..");

type State = {
  readonly run: string;
  readonly repo: string;
  readonly checkout: string;
  readonly id: string;
  readonly firstTickAt: string;
};

const observed: {
  apiUrl: string;
  phase: string;
  state?: State;
  cli: Record<string, unknown>;
  ticks?: unknown;
  checks: Record<string, CheckRecord>;
} = { apiUrl: API_URL, phase: PHASE, cli: {}, checks: {} };
const assert = makeChecker(observed);

/** `factory …` as an operator types it: its exit code and both streams. */
const factory = (args: readonly string[]) => {
  const ran = spawnSync(
    "bun",
    [path.join(ROOT, "apps/cli/src/index.ts"), ...args, "--api", API_URL],
    { encoding: "utf8" },
  );
  return {
    code: ran.status,
    out: `${ran.stdout ?? ""}${ran.stderr ?? ""}`,
  };
};

/** A checkout with one commit on `main`, no remote, and an identity a commit can be made as. */
const fixtureRepo = (name: string): string => {
  const root = path.join(REPOS, name);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  const git = (command: string) =>
    execSync(command, { cwd: root, stdio: "ignore" });
  git("git init -q -b main");
  git("git config user.email verify-automations@localhost");
  git("git config user.name verify-automations");
  writeFileSync(path.join(root, "README.md"), "# automations fixture\n");
  git("git add -A");
  git("git commit -q -m base");
  return root;
};

const sleep = (millis: number) => Effect.sleep(millis);

/** Milliseconds until `seconds` past the next whole minute. */
const untilNextMinute = (seconds: number): number => {
  const now = Date.now();
  return (Math.floor(now / 60_000) + 1) * 60_000 + seconds * 1000 - now;
};

/** Poll `read` every 500 ms for up to `forMs` until it answers something. */
const poll = <A, E, R>(
  read: Effect.Effect<A | undefined, E, R>,
  forMs: number,
): Effect.Effect<A | undefined, E, R> =>
  Effect.gen(function* () {
    const until = Date.now() + forMs;
    for (;;) {
      const value = yield* read;
      if (value !== undefined || Date.now() > until) return value;
      yield* sleep(500);
    }
  });

const cardsOf = (id: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    return yield* sql<{ id: string; externalRef: string }>`
      SELECT id, external_ref FROM tasks WHERE external_ref LIKE ${`automation:${id}@%`}
    `;
  });

const runsOf = (id: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    return yield* sql<{ id: string }>`
      SELECT id FROM sessions WHERE request_id LIKE ${`automation:${id}@%`}
    `;
  });

const finishCards = (id: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql`
      UPDATE tasks SET "column" = 'canceled' WHERE external_ref LIKE ${`automation:${id}@%`}
    `;
  });

const scheduled = (ticks: ReadonlyArray<AutomationTick>) =>
  ticks.filter((tick) => tick.trigger === "schedule");

const before = Effect.gen(function* () {
  const client = yield* RpcClient.make(RpcApi);
  const run = Date.now().toString(36);
  const repo = RepoSlug.make(`verify-automations-${run}/widgets`);
  const checkout = fixtureRepo("widgets");
  yield* client.registerRepo({
    repo,
    defaultBaseRef: "main",
    localPath: checkout,
  });
  yield* client.createBoard({
    repo,
    definitionId: DefinitionId.make("default"),
  });

  const add = factory([
    "automation",
    "add",
    "--repo",
    repo,
    "--cron",
    "* * * * *",
    "--prompt",
    "Say what the README is for, in one sentence.",
    "--name",
    "readme pass",
  ]);
  observed.cli["add"] = add;
  const id = /^added\s+(aut_[0-9a-z]{26})$/m.exec(add.out)?.[1] ?? "";
  assert(
    "cli: `factory automation add` adds a 1-minute cron automation",
    add.code === 0 && id !== "" && add.out.includes('cron "* * * * *" UTC'),
    add.out.split("\n")[0] ?? "",
  );
  const automationId = AutomationId.make(id);

  // The API's own clock fires the first minute after the add.
  const first = yield* poll(
    client
      .listAutomationTicks({ id: automationId })
      .pipe(
        Effect.map((ticks) => ticks.find((tick) => tick.status === "started")),
      ),
    untilNextMinute(30),
  );
  assert(
    "clock: the first minute is fired by the API with no caller: one tick, started",
    first !== undefined &&
      first.trigger === "schedule" &&
      first.tickAt.endsWith(":00.000Z"),
    first === undefined
      ? "no tick"
      : `${first.tickAt} ${first.status}: ${first.reason}`,
  );
  // More passes inside the same minute (one a second) fire nothing more.
  yield* sleep(3_000);
  const ticks = yield* client.listAutomationTicks({ id: automationId });
  const cards = yield* cardsOf(id);
  const runs = yield* runsOf(id);
  assert(
    "tick: one card on the board and one run on it, filed under automation:<id>@<minute>",
    ticks.length === 1 &&
      cards.length === 1 &&
      runs.length === 1 &&
      cards[0]?.externalRef === `automation:${id}@${first?.tickAt}` &&
      first?.taskId === cards[0]?.id &&
      first?.sessionId === runs[0]?.id,
    `${ticks.length} tick(s), ${cards.length} card(s), ${runs.length} run(s)`,
  );
  const state: State = {
    run,
    repo,
    checkout,
    id,
    firstTickAt: first?.tickAt ?? "",
  };
  observed.state = state;
  writeFileSync(STATE, JSON.stringify(state));
});

const after = Effect.gen(function* () {
  const client = yield* RpcClient.make(RpcApi);
  const state = JSON.parse(readFileSync(STATE, "utf8")) as State;
  observed.state = state;
  const id = AutomationId.make(state.id);

  // The restarted API has had its passes: the first minute is still the one tick it was.
  yield* sleep(4_000);
  const restarted = yield* client.listAutomationTicks({ id });
  const cards = yield* cardsOf(state.id);
  const runs = yield* runsOf(state.id);
  const sameMinute = Date.now() < Date.parse(state.firstTickAt) + 60_000;
  assert(
    "restart: the restarted API does not fire the minute again — one tick, one card, one run",
    restarted.filter((tick) => tick.tickAt === state.firstTickAt).length ===
      1 &&
      cards.length === 1 &&
      runs.length === 1,
    `${restarted.length} tick(s), ${cards.length} card(s), ${runs.length} run(s); restarted inside the minute: ${sameMinute}`,
  );
  assert(
    "restart: the restart happened while that minute was still the one due",
    sameMinute,
    `first tick ${state.firstTickAt}, now ${new Date().toISOString()}`,
  );

  // The next minute, with no commit on `main`: skipped, with the reason.
  yield* finishCards(state.id);
  const skipped = yield* poll(
    client
      .listAutomationTicks({ id })
      .pipe(
        Effect.map((ticks) =>
          ticks.find(
            (tick) =>
              tick.tickAt !== state.firstTickAt &&
              tick.trigger === "schedule" &&
              tick.status !== "claimed",
          ),
        ),
      ),
    untilNextMinute(30),
  );
  const head = execSync("git rev-parse main", {
    cwd: state.checkout,
    encoding: "utf8",
  }).trim();
  assert(
    "skip: the next minute on an unmoved main is recorded skipped, naming the run and the commit",
    skipped?.status === "skipped" &&
      skipped.reason ===
        `no new commits on main since the run at ${state.firstTickAt} (${head.slice(0, 12)}), so nothing was filed` &&
      skipped.taskId === undefined,
    skipped === undefined
      ? "no tick"
      : `${skipped.tickAt} ${skipped.status}: ${skipped.reason}`,
  );
  const history = factory(["automation", "history", state.id]);
  observed.cli["history"] = history;
  assert(
    "cli: `factory automation history` prints the skipped tick and its reason, and the started one's run",
    history.code === 0 &&
      history.out.includes(
        `\tschedule\tskipped\tnone\tnone\tnone\tnone\tno new commits on main`,
      ) &&
      history.out.includes(`${state.firstTickAt}\tschedule\tstarted\ttsk_`),
    history.out.split("\n").slice(0, 3).join(" | "),
  );
  assert(
    "skip: nothing was filed for it",
    (yield* cardsOf(state.id)).length === 1,
    `${(yield* cardsOf(state.id)).length} card(s)`,
  );

  // `run` starts one at once, though the base has not moved.
  const ran = factory(["automation", "run", state.id]);
  observed.cli["run"] = ran;
  assert(
    "cli: `factory automation run` starts one at once: a card and a run, on the unmoved base",
    ran.code === 0 &&
      /^status\s+started$/m.test(ran.out) &&
      /^card\s+tsk_/m.test(ran.out) &&
      /^run\s+ses_/m.test(ran.out) &&
      ran.out.includes("(manual)"),
    ran.out.split("\n").slice(0, 2).join(" | "),
  );
  assert(
    "run: the manual tick filed a second card and opened a second run",
    (yield* cardsOf(state.id)).length === 2 &&
      (yield* runsOf(state.id)).length === 2,
    `${(yield* cardsOf(state.id)).length} card(s), ${(yield* runsOf(state.id)).length} run(s)`,
  );
  yield* finishCards(state.id);

  // `pause`: the next minute passes and no scheduled tick fires.
  const pause = factory(["automation", "pause", state.id]);
  observed.cli["pause"] = pause;
  assert(
    "cli: `factory automation pause` pauses it: no next tick",
    pause.code === 0 &&
      /^state\s+paused$/m.test(pause.out) &&
      /^next\s+none$/m.test(pause.out),
    pause.out.split("\n").slice(0, 5).join(" | "),
  );
  const pausedAt = Date.now();
  const scheduledBefore = scheduled(
    yield* client.listAutomationTicks({ id }),
  ).length;
  yield* sleep(untilNextMinute(5));
  const afterPause = yield* client.listAutomationTicks({ id });
  observed.ticks = afterPause;
  assert(
    "pause: a minute passed with the clock running and no scheduled tick fired",
    scheduled(afterPause).length === scheduledBefore &&
      !afterPause.some(
        (tick) =>
          tick.trigger === "schedule" && Date.parse(tick.tickAt) > pausedAt,
      ),
    `${scheduledBefore} scheduled tick(s) before, ${scheduled(afterPause).length} after, waited ${Math.round((Date.now() - pausedAt) / 1000)}s`,
  );
  const ls = factory(["automation", "ls", "--repo", state.repo]);
  observed.cli["ls"] = ls;
  assert(
    "cli: `factory automation ls` lists it paused, its last tick the manual one",
    ls.code === 0 &&
      ls.out.includes(
        `${state.id}\treadme pass\t${state.repo}\tcron "* * * * *" UTC\tpaused\tnone\tstarted `,
      ),
    ls.out.split("\n")[1] ?? "",
  );
  const rm = factory(["automation", "rm", state.id]);
  observed.cli["rm"] = rm;
  const gone = factory(["automation", "show", state.id]);
  assert(
    "cli: `factory automation rm` removes it; `show` then answers automation_not_found",
    rm.code === 0 &&
      gone.code !== 0 &&
      gone.out.includes("error: automation_not_found"),
    gone.out.trim().split("\n")[0] ?? "",
  );
});

mkdirSync(REPOS, { recursive: true });
const result = await Effect.runPromiseExit(
  Effect.scoped(PHASE === "after" ? after : before).pipe(
    Effect.provide(Layer.mergeAll(protocolFor(API_URL), DatabaseLive)),
  ),
);
if (Exit.isFailure(result)) {
  assert(`the ${PHASE} phase completed`, false, String(result.cause));
}

await mkdir(EVIDENCE_DIR, { recursive: true });
await writeFile(
  path.join(EVIDENCE_DIR, `automations-${PHASE}.json`),
  `${JSON.stringify(observed, null, 2)}\n`,
);
const failed = Object.entries(observed.checks).filter(
  ([, check]) => !check.passed,
);
console.log(
  `\nautomations (${PHASE}): ${Object.keys(observed.checks).length - failed.length}/${Object.keys(observed.checks).length} checks passed — evidence in ${EVIDENCE_DIR}/automations-${PHASE}.json`,
);
if (failed.length > 0 || (PHASE === "after" && !existsSync(STATE)))
  process.exitCode = 1;
