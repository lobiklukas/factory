/**
 * Scheduled automations (S-general-automations, `./AutomationService`): a 1-minute cron files one
 * card with one run per tick and a restart does not fire the same tick twice; a tick whose base has
 * not moved is recorded `skipped` with the reason; `run` starts one at once and `pause` stops the
 * ticks. Also what `add` refuses, a one-off, a skill's text on the card, and the history's join to
 * `session_activity`.
 *
 * Real Postgres, a real git checkout (its `main` is the base each tick reads), the real session,
 * task and skill services; the model is faux. The clock is the ticks' own argument: each tick is
 * fired at an instant the case names, a minute apart, so the case does not wait for a wall-clock
 * minute. A "restart" is the first runtime disposed and a second one built over the same database.
 *
 * Postgres only, not mocked: `docker compose up -d --wait postgres`.
 */
import { BunServices } from "@effect/platform-bun";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AutomationId } from "@repo/domain/Automation";
import { RepoSlug } from "@repo/domain/Session";
import { DEFAULT_DEFINITION_ID, DefinitionId } from "@repo/domain/Task";
import { createFauxModelAccess } from "@repo/harness";
import { DatabaseLive } from "@repo/storage-postgres";
import { Clock, DateTime, Effect, Layer, ManagedRuntime } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  automationCardRef,
  AutomationService,
  AutomationServiceLive,
} from "./AutomationService";
import { SessionService, SessionServiceLive } from "./SessionService";
import { SkillService, SkillServiceLive } from "./SkillService";
import { TaskService, TaskServiceLive } from "./TaskService";

const runId = randomBytes(4).toString("hex");

/** An instant as the service answers it: ISO 8601 in UTC. */
const isoAt = (millis: number): string =>
  DateTime.formatIso(DateTime.makeUnsafe(millis));

const git = (cwd: string, ...args: ReadonlyArray<string>): string =>
  execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "automation",
      GIT_AUTHOR_EMAIL: "automation@localhost",
      GIT_COMMITTER_NAME: "automation",
      GIT_COMMITTER_EMAIL: "automation@localhost",
    },
  }).trim();

/** The registered checkout: its `main` is the base every tick reads, and the case commits to it. */
const checkout = mkdtempSync(join(tmpdir(), "factory-automation-repo-"));
git(checkout, "init", "-q", "-b", "main");
writeFileSync(join(checkout, "README.md"), "automation\n");
git(checkout, "add", "-A");
git(checkout, "commit", "-q", "-m", "init");

let commits = 0;
/** A new commit on the checkout's `main`: the base moves. */
const commitToMain = (): string => {
  commits += 1;
  writeFileSync(join(checkout, `change-${commits}.txt`), `${commits}\n`);
  git(checkout, "add", "-A");
  git(checkout, "commit", "-q", "-m", `change ${commits}`);
  return git(checkout, "rev-parse", "HEAD");
};

const sessionRoot = mkdtempSync(join(tmpdir(), "factory-automation-sessions-"));

const layer = () =>
  AutomationServiceLive.pipe(
    Layer.provideMerge(Layer.mergeAll(TaskServiceLive, SkillServiceLive)),
    Layer.provideMerge(
      SessionServiceLive({
        model: createFauxModelAccess({ fauxCommand: "echo automation-ran" })
          .access,
        sessionRoot,
      }),
    ),
    Layer.provideMerge(Layer.mergeAll(DatabaseLive, BunServices.layer)),
  );

let runtime = ManagedRuntime.make(layer());

/**
 * Each case's automations stop with it, and the cards they filed are finished: `pass` reads every
 * enabled automation in the database, so one left enabled would be fired by a later case's pass —
 * extra cards and runs holding slots of the board's run cap (B9) — and hidden by its filter.
 */
afterEach(async () => {
  await runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      yield* sql`
        UPDATE automations SET enabled = false
        WHERE repo LIKE ${`automation-${runId}/%`}
      `;
      yield* sql`
        UPDATE tasks SET "column" = 'canceled'
        WHERE "column" <> 'canceled'
          AND split_part(external_ref, '@', 1) IN (
            SELECT 'automation:' || id FROM automations
            WHERE repo LIKE ${`automation-${runId}/%`}
          )
      `;
    }),
  );
});

/**
 * This run's automations go with it: an enabled one left behind would be fired by the next run's
 * `pass`, which reads every enabled automation in the database.
 */
afterAll(async () => {
  await runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      yield* sql`DELETE FROM automations WHERE repo LIKE ${`automation-${runId}/%`}`;
    }),
  );
  await runtime.dispose();
});

const run = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    AutomationService | SessionService | TaskService | SkillService | SqlClient
  >,
): Promise<A> => runtime.runPromise(effect);

const repo = RepoSlug.make(`automation-${runId}/widgets`);
/** A registered repo with no board: an automation cannot file a card on it. */
const boardless = RepoSlug.make(`automation-${runId}/no-board`);

/** The repo registered with the checkout and given a board on the default pipeline, once. */
let ready = false;
const setUp = Effect.gen(function* () {
  if (ready) return;
  const sessions = yield* SessionService;
  const tasks = yield* TaskService;
  yield* sessions.registerRepo({ repo, localPath: checkout });
  yield* sessions.registerRepo({ repo: boardless, localPath: checkout });
  yield* tasks.createBoard({
    repo,
    definitionId: DefinitionId.make(DEFAULT_DEFINITION_ID),
  });
  ready = true;
});

/** The cards an automation filed, by the external ref every one of its ticks files under. */
const cardsOf = (id: AutomationId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    return yield* sql<{ id: string; externalRef: string; title: string }>`
      SELECT id, external_ref, title FROM tasks
      WHERE external_ref LIKE ${`automation:${id}@%`}
      ORDER BY created_at
    `;
  });

/** The runs an automation's ticks opened, by the request id each was created under. */
const runsOf = (id: AutomationId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    return yield* sql<{ id: string; taskId: string | null }>`
      SELECT s.id, r.task_id FROM sessions s
      LEFT JOIN task_runs r ON r.session_id = s.id
      WHERE s.request_id LIKE ${`automation:${id}@%`}
      ORDER BY s.created_at
    `;
  });

/**
 * Finish every card the automation filed, so its runs hold no slot of the board's run cap (B9): the
 * cases here start several runs on one board.
 */
const finishCards = (id: AutomationId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql`
      UPDATE tasks SET "column" = 'canceled'
      WHERE external_ref LIKE ${`automation:${id}@%`}
    `;
  });

/** The first whole minute after `millis`, plus `offset`: an instant every-minute cron has reached. */
const minuteAfter = (millis: number, offset = 0): number =>
  (Math.floor(millis / 60_000) + 1) * 60_000 + offset;

describe("a scheduled automation (S-general-automations)", () => {
  /**
   * Mutations this catches: a claim that does not dedupe (a plain `INSERT`, or `DO UPDATE` with no
   * `WHERE`) — the restarted runtime's tick and pass fire the minute again, a second card and run;
   * a tick keyed by the moment it woke rather than the instant it is for — the second wake inside
   * the minute files a second card; a card that is not filed under `automationCardRef` — the ref
   * lookup finds none; a tick that files the card but opens no run — `runsOf` is empty.
   */
  it("files one card with one run per tick of a 1-minute cron, and a restart does not fire the tick again", async () => {
    const added = await run(
      Effect.gen(function* () {
        yield* setUp;
        const automations = yield* AutomationService;
        return yield* automations.add({
          repo,
          cron: "* * * * *",
          prompt: "Tidy the README so it says what the widgets do.",
          actor: "person:ada",
        });
      }),
    );
    expect(added.enabled).toBe(true);
    expect(added.timezone).toBe("UTC");
    expect(added.createdBy).toBe("person:ada");
    expect(added.nextTickAt).toBeDefined();
    const first = minuteAfter(Date.parse(added.enabledAt));

    const fired = await run(
      Effect.gen(function* () {
        const automations = yield* AutomationService;
        const tick = yield* automations.tick(added.id, first + 5_000);
        // A second wake inside the same minute: the same tick, answered rather than fired.
        const again = yield* automations.tick(added.id, first + 40_000);
        return { tick, again };
      }),
    );
    expect(fired.tick?.replayed).toBe(false);
    expect(fired.tick?.tick.status).toBe("started");
    expect(fired.tick?.tick.trigger).toBe("schedule");
    expect(fired.tick?.tick.tickAt).toBe(isoAt(first));
    expect(fired.tick?.tick.baseRef).toBe("main");
    expect(fired.tick?.tick.baseCommit).toBe(
      git(checkout, "rev-parse", "main"),
    );
    expect(fired.again?.replayed).toBe(true);
    expect(fired.again?.tick.tickAt).toBe(fired.tick?.tick.tickAt);

    const filed = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const cards = yield* cardsOf(added.id);
        const card = yield* tasks.get(cards[0]?.id ?? "");
        return { cards, card, runs: yield* runsOf(added.id) };
      }),
    );
    expect(filed.cards).toHaveLength(1);
    expect(filed.cards[0]?.externalRef).toBe(
      automationCardRef(added.id, first),
    );
    expect(filed.card.body).toContain(
      "Tidy the README so it says what the widgets do.",
    );
    expect(filed.card.title).toContain("Tidy the README");
    expect(filed.runs).toHaveLength(1);
    expect(filed.runs[0]?.taskId).toBe(filed.card.id);
    expect(fired.tick?.tick.taskId).toBe(filed.card.id);
    expect(fired.tick?.tick.sessionId).toBe(filed.runs[0]?.id);

    // A restart: this process's services are gone, and a new process reads the same database.
    await runtime.dispose();
    runtime = ManagedRuntime.make(layer());

    const restarted = await run(
      Effect.gen(function* () {
        const automations = yield* AutomationService;
        const tick = yield* automations.tick(added.id, first + 50_000);
        const passed = yield* automations.pass(first + 55_000, { repo });
        return {
          tick,
          passed: passed.filter((entry) => entry.automationId === added.id),
          cards: yield* cardsOf(added.id),
          runs: yield* runsOf(added.id),
          ticks: yield* automations.ticks(added.id),
        };
      }),
    );
    expect(restarted.tick?.replayed).toBe(true);
    expect(restarted.passed).toEqual([]);
    expect(restarted.cards).toHaveLength(1);
    expect(restarted.runs).toHaveLength(1);
    expect(restarted.ticks).toHaveLength(1);

    // The next minute, with the base moved: the next card and run.
    commitToMain();
    const next = await run(
      Effect.gen(function* () {
        yield* finishCards(added.id);
        const automations = yield* AutomationService;
        const passed = yield* automations.pass(first + 60_000 + 3_000, {
          repo,
        });
        return {
          passed: passed.filter((entry) => entry.automationId === added.id),
          cards: yield* cardsOf(added.id),
          runs: yield* runsOf(added.id),
        };
      }),
    );
    expect(next.passed.map((entry) => entry.status)).toEqual(["started"]);
    expect(next.passed[0]?.tickAt).toBe(isoAt(first + 60_000));
    expect(next.cards).toHaveLength(2);
    expect(next.runs).toHaveLength(2);

    // `skipped` for a tick whose base has not moved since that run (the next case's claim) …
    const unchanged = await run(
      Effect.gen(function* () {
        yield* finishCards(added.id);
        const automations = yield* AutomationService;
        const tick = yield* automations.tick(added.id, first + 120_000 + 1_000);
        return { tick, cards: yield* cardsOf(added.id) };
      }),
    );
    expect(unchanged.tick?.tick.status).toBe("skipped");
    expect(unchanged.cards).toHaveLength(2);

    // … and the history reads each run's state from `session_activity`, newest first.
    const history = await run(
      Effect.gen(function* () {
        const automations = yield* AutomationService;
        for (let attempt = 0; attempt < 400; attempt += 1) {
          const ticks = yield* automations.ticks(added.id);
          if (ticks.filter((tick) => tick.run !== undefined).length === 2)
            return ticks;
          yield* Effect.sleep(50);
        }
        return yield* automations.ticks(added.id);
      }),
    );
    expect(history.map((tick) => tick.status)).toEqual([
      "skipped",
      "started",
      "started",
    ]);
    expect(history[1]?.run?.costTotal).toBeTypeOf("number");
    expect(history[2]?.run?.lastActivityAt).toBeDefined();
    expect(history[0]?.run).toBeUndefined();
    await run(finishCards(added.id));
  }, 120_000);

  /**
   * Mutations this catches: comparing against the last tick of any status — the skipped tick's own
   * commit, or none; recording no reason; skipping a manual run or an automation that opted out; not
   * reading the base again on each tick — the moved base still skips.
   */
  it("records a tick on an unmoved base as skipped, with the commit and the run it matched", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        yield* setUp;
        const automations = yield* AutomationService;
        const added = yield* automations.add({
          repo,
          name: "nightly tidy",
          cron: "* * * * *",
          prompt: "Tidy up.",
        });
        const first = minuteAfter(Date.parse(added.enabledAt));
        const started = yield* automations.tick(added.id, first + 1_000);
        yield* finishCards(added.id);
        const skipped = yield* automations.tick(
          added.id,
          first + 60_000 + 1_000,
        );
        const alsoSkipped = yield* automations.tick(
          added.id,
          first + 120_000 + 1_000,
        );
        // The base moves: the next tick runs again.
        const moved = commitToMain();
        const resumed = yield* automations.tick(
          added.id,
          first + 180_000 + 1_000,
        );
        yield* finishCards(added.id);
        return {
          added,
          first,
          started,
          skipped,
          alsoSkipped,
          moved,
          resumed,
          cards: yield* cardsOf(added.id),
          automation: yield* automations.get(added.id),
        };
      }),
    );
    const head = outcome.started?.tick.baseCommit ?? "";
    expect(outcome.started?.tick.status).toBe("started");
    expect(outcome.skipped?.tick.status).toBe("skipped");
    expect(outcome.skipped?.tick.reason).toBe(
      `no new commits on main since the run at ${isoAt(outcome.first)} (${head.slice(0, 12)}), so nothing was filed`,
    );
    expect(outcome.skipped?.tick.baseCommit).toBe(head);
    expect(outcome.skipped?.tick.taskId).toBeUndefined();
    expect(outcome.skipped?.tick.sessionId).toBeUndefined();
    // Still the run at the first minute: a skipped tick is not what the next one compares with.
    expect(outcome.alsoSkipped?.tick.reason).toContain(
      `since the run at ${isoAt(outcome.first)}`,
    );
    expect(outcome.resumed?.tick.status).toBe("started");
    expect(outcome.resumed?.tick.baseCommit).toBe(outcome.moved);
    expect(outcome.cards).toHaveLength(2);
    expect(outcome.automation.lastTick?.status).toBe("started");

    // An automation that opted out of the skip runs on the unmoved base every tick.
    const always = await run(
      Effect.gen(function* () {
        const automations = yield* AutomationService;
        const added = yield* automations.add({
          repo,
          cron: "* * * * *",
          prompt: "Run every minute whatever changed.",
          skipIfUnchanged: false,
        });
        const first = minuteAfter(Date.parse(added.enabledAt));
        const one = yield* automations.tick(added.id, first + 1_000);
        yield* finishCards(added.id);
        const two = yield* automations.tick(added.id, first + 60_000 + 1_000);
        yield* finishCards(added.id);
        return [one?.tick.status, two?.tick.status];
      }),
    );
    expect(always).toEqual(["started", "started"]);
  }, 120_000);

  /**
   * Mutations this catches: `run` that goes through the skip — it is `skipped` on the unmoved base;
   * `run` refused on a paused automation; `pause` that leaves `enabled` — the next tick and the pass
   * fire; `resume` that does not re-enable it.
   */
  it("starts one at once on 'run', and fires no further tick once paused", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        yield* setUp;
        const automations = yield* AutomationService;
        const added = yield* automations.add({
          repo,
          cron: "* * * * *",
          prompt: "Check the dependencies.",
        });
        const first = minuteAfter(Date.parse(added.enabledAt));
        const scheduled = yield* automations.tick(added.id, first + 1_000);
        yield* finishCards(added.id);
        // Nothing moved since that run: a scheduled tick would skip, and a manual one does not.
        const manual = yield* automations.run(added.id);
        yield* finishCards(added.id);
        const paused = yield* automations.pause(added.id);
        const whilePaused = yield* automations.tick(
          added.id,
          first + 60_000 + 1_000,
        );
        const passWhilePaused = yield* automations.pass(
          first + 120_000 + 1_000,
          {
            repo,
          },
        );
        // A paused automation still runs when a person asks.
        const manualWhilePaused = yield* automations.run(added.id);
        yield* finishCards(added.id);
        const resumed = yield* automations.resume(added.id);
        const afterResume = yield* automations.tick(
          added.id,
          first + 180_000 + 1_000,
        );
        yield* finishCards(added.id);
        return {
          scheduled,
          manual,
          paused,
          whilePaused,
          passWhilePaused: passWhilePaused.filter(
            (entry) => entry.automationId === added.id,
          ),
          manualWhilePaused,
          resumed,
          afterResume,
          cards: yield* cardsOf(added.id),
          ticks: yield* automations.ticks(added.id),
        };
      }),
    );
    expect(outcome.scheduled?.tick.status).toBe("started");
    expect(outcome.manual.tick.trigger).toBe("manual");
    expect(outcome.manual.tick.status).toBe("started");
    expect(outcome.manual.tick.sessionId).toBeDefined();
    expect(outcome.paused.enabled).toBe(false);
    expect(outcome.paused.nextTickAt).toBeUndefined();
    expect(outcome.whilePaused).toBeUndefined();
    expect(outcome.passWhilePaused).toEqual([]);
    expect(outcome.manualWhilePaused.tick.status).toBe("started");
    expect(outcome.resumed.enabled).toBe(true);
    expect(outcome.resumed.nextTickAt).toBeDefined();
    // Ticking again after the resume; the base has not moved since the manual run, so it skips.
    expect(outcome.afterResume?.tick.status).toBe("skipped");
    expect(outcome.cards).toHaveLength(3);
    // Two scheduled and two manual. Not in instant order here: the case fires its scheduled ticks
    // minutes ahead of the wall clock a manual run is stamped with.
    expect(outcome.ticks.map((tick) => tick.trigger).sort()).toEqual([
      "manual",
      "manual",
      "schedule",
      "schedule",
    ]);
  }, 120_000);

  /**
   * Mutations this catches: a one-off that fires before its instant, or twice; a skill whose text
   * is not on the card; `remove` that leaves the row.
   */
  it("fires a one-off once at its instant, with its skill's text on the card", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        yield* setUp;
        const skills = yield* SkillService;
        const automations = yield* AutomationService;
        const skill = `automation-skill-${runId}`;
        yield* skills.put({
          name: skill,
          description: "What an automation's run follows",
          body: "Read CHANGELOG.md and list what is unreleased.",
        });
        const now = yield* Clock.currentTimeMillis;
        const runAt = isoAt(now + 60_000);
        const added = yield* automations.add({ repo, runAt, skill });
        const early = yield* automations.tick(added.id, now + 30_000);
        const due = yield* automations.tick(added.id, now + 90_000);
        const later = yield* automations.tick(added.id, now + 600_000);
        const done = yield* automations.get(added.id);
        const passedLater = yield* automations.pass(now + 660_000, { repo });
        const tasks = yield* TaskService;
        const card = yield* tasks.get(due?.tick.taskId ?? "");
        yield* finishCards(added.id);
        const ticks = yield* automations.ticks(added.id);
        const removed = yield* automations.remove(added.id);
        const gone = yield* automations.get(added.id).pipe(Effect.flip);
        return {
          added,
          early,
          due,
          later,
          done,
          passedLater: passedLater.filter(
            (entry) => entry.automationId === added.id,
          ),
          ticks,
          card,
          removed,
          gone,
          skill,
        };
      }),
    );
    expect(outcome.added.runAt).toBeDefined();
    expect(outcome.added.cron).toBeUndefined();
    expect(outcome.added.name).toBe(`skill ${outcome.skill}`);
    expect(outcome.early).toBeUndefined();
    expect(outcome.due?.tick.status).toBe("started");
    expect(outcome.due?.tick.tickAt).toBe(outcome.added.runAt);
    // Fired, it is done: disabled, with no next instant, and no later pass reaches it again.
    expect(outcome.later).toBeUndefined();
    expect(outcome.done.enabled).toBe(false);
    expect(outcome.done.nextTickAt).toBeUndefined();
    expect(outcome.passedLater).toEqual([]);
    expect(outcome.ticks).toHaveLength(1);
    expect(outcome.card.body).toContain(
      `Follow the factory skill "${outcome.skill}" (version 1):`,
    );
    expect(outcome.card.body).toContain(
      "Read CHANGELOG.md and list what is unreleased.",
    );
    expect(outcome.removed.id).toBe(outcome.added.id);
    expect(outcome.gone._tag).toBe("AutomationNotFound");
  }, 60_000);

  /**
   * Mutations this catches: a pass that leaves a stale claim on an instant the schedule has moved
   * past — it stays `claimed` in the history for ever; a sweep that also closes the due instant's
   * own stale claim — the takeover never happens and the one-off never runs; a sweep with no age
   * floor — a claim another process holds right now is closed under it.
   */
  it("closes a stale claim the schedule has moved past as failed, and takes over the due one", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        yield* setUp;
        const sql = yield* SqlClient;
        const automations = yield* AutomationService;
        const added = yield* automations.add({
          repo,
          cron: "* * * * *",
          prompt: "Look at the open issues.",
          skipIfUnchanged: false,
        });
        const first = minuteAfter(Date.parse(added.enabledAt));
        // Three claims a process left behind: two stale (11 minutes old), one fresh.
        const claimed = (at: number, age: string) => sql`
          INSERT INTO automation_ticks (automation_id, tick_at, trigger, claimed_at)
          VALUES (${added.id}, ${isoAt(at)}::timestamptz, 'schedule',
            now() - ${age}::interval)
        `;
        yield* claimed(first, "11 minutes");
        yield* claimed(first + 60_000, "30 seconds");
        yield* claimed(first + 120_000, "11 minutes");
        // The pass at the third minute: its due instant is the third claim's, stale — taken over.
        const passed = yield* automations.pass(first + 120_000 + 1_000, {
          repo,
        });
        const ticks = yield* automations.ticks(added.id);
        return { added, first, passed, ticks };
      }),
    );
    const at = (millis: number) =>
      outcome.ticks.find((tick) => tick.tickAt === isoAt(millis));
    expect(at(outcome.first)?.status).toBe("failed");
    expect(at(outcome.first)?.reason).toContain(
      "stopped before it recorded an outcome",
    );
    // Not stale yet: its holder may still be at it.
    expect(at(outcome.first + 60_000)?.status).toBe("claimed");
    expect(
      outcome.passed
        .filter((tick) => tick.automationId === outcome.added.id)
        .map((tick) => [tick.tickAt, tick.status]),
    ).toEqual([[isoAt(outcome.first + 120_000), "started"]]);
  }, 60_000);

  /**
   * Mutations this catches: a tick whose run is refused that leaves its card on the board — the card
   * stays in `intake` with no run, and a frequent schedule piles one up per tick.
   */
  it("cancels the card it filed when the run cannot be opened", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        yield* setUp;
        const sql = yield* SqlClient;
        const automations = yield* AutomationService;
        const tasks = yield* TaskService;
        const added = yield* automations.add({
          repo,
          cron: "* * * * *",
          prompt: "Refused.",
          skipIfUnchanged: false,
        });
        // The board no longer declares the column the automation starts its runs in (say, it was
        // upgraded to a definition that renamed it): the card is filed and the run refused.
        yield* sql`UPDATE automations SET task_column = 'retired' WHERE id = ${added.id}`;
        const first = minuteAfter(Date.parse(added.enabledAt));
        const fired = yield* automations.tick(added.id, first + 1_000);
        const card = yield* tasks.get(fired?.tick.taskId ?? "");
        return { fired, card, runs: yield* runsOf(added.id) };
      }),
    );
    expect(outcome.fired?.tick.status).toBe("failed");
    expect(outcome.fired?.tick.reason).toContain("its run could not be opened");
    expect(outcome.fired?.tick.reason).toContain(
      "the card was moved to canceled",
    );
    expect(outcome.card.column).toBe("canceled");
    expect(outcome.runs).toEqual([]);
  }, 60_000);

  /**
   * Mutations this catches: a one-off left enabled after a failed tick — every pass claims and reads
   * its instant again, for ever; a pass that sweeps only enabled automations — a paused one's stale
   * manual claim stays `claimed` in the history.
   */
  it("retires a one-off whose tick failed, and closes a paused automation's stale claim", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        yield* setUp;
        const sql = yield* SqlClient;
        const automations = yield* AutomationService;
        const now = yield* Clock.currentTimeMillis;
        const once = yield* automations.add({
          repo,
          runAt: isoAt(now + 60_000),
          prompt: "Refused once.",
        });
        yield* sql`UPDATE automations SET task_column = 'retired' WHERE id = ${once.id}`;
        const fired = yield* automations.tick(once.id, now + 90_000);
        const retired = yield* automations.get(once.id);

        const paused = yield* automations.add({
          repo,
          cron: "* * * * *",
          prompt: "Paused.",
        });
        yield* automations.pause(paused.id);
        const stale = now - 3_600_000;
        yield* sql`
          INSERT INTO automation_ticks (automation_id, tick_at, trigger, claimed_at)
          VALUES (${paused.id}, ${isoAt(stale)}::timestamptz, 'manual',
            now() - '11 minutes'::interval)
        `;
        yield* automations.pass(now + 120_000, { repo });
        const ticks = yield* automations.ticks(paused.id);
        return { fired, retired, ticks };
      }),
    );
    expect(outcome.fired?.tick.status).toBe("failed");
    expect(outcome.retired.enabled).toBe(false);
    expect(outcome.retired.nextTickAt).toBeUndefined();
    expect(outcome.ticks.map((tick) => tick.status)).toEqual(["failed"]);
    expect(outcome.ticks[0]?.reason).toContain(
      "stopped before it recorded an outcome",
    );
  }, 60_000);

  /** Each refusal names its field, and nothing is written for any of them. */
  it("refuses an automation it could not run, naming the field", async () => {
    const refusals = await run(
      Effect.gen(function* () {
        yield* setUp;
        const automations = yield* AutomationService;
        const fieldOf = (input: Parameters<typeof automations.add>[0]) =>
          automations.add(input).pipe(
            Effect.flip,
            Effect.map((error) =>
              error._tag === "InvalidAutomation" ? error.field : error._tag,
            ),
          );
        const before = (yield* automations.list(repo)).length;
        const fields = [
          yield* fieldOf({ repo, prompt: "no schedule" }),
          yield* fieldOf({
            repo,
            cron: "* * * * *",
            runAt: "2099-01-01T00:00:00Z",
            prompt: "both",
          }),
          yield* fieldOf({ repo, cron: "every minute", prompt: "x" }),
          yield* fieldOf({
            repo,
            cron: "* * * * *",
            timezone: "Mars/Olympus",
            prompt: "x",
          }),
          yield* fieldOf({ repo, cron: "0 0 31 2 *", prompt: "never" }),
          yield* fieldOf({ repo, cron: "*/10 * * * * *", prompt: "too often" }),
          yield* fieldOf({ repo, runAt: "2020-01-01T00:00:00Z", prompt: "x" }),
          yield* fieldOf({ repo, cron: "* * * * *" }),
          yield* fieldOf({
            repo,
            cron: "* * * * *",
            skill: `missing-${runId}`,
          }),
          yield* fieldOf({
            repo,
            cron: "* * * * *",
            prompt: "x",
            column: "nowhere",
          }),
          yield* fieldOf({
            repo,
            cron: "* * * * *",
            prompt: "x",
            baseRef: "main; rm -rf /",
          }),
          yield* fieldOf({ repo: boardless, cron: "* * * * *", prompt: "x" }),
          yield* fieldOf({
            repo: RepoSlug.make(`automation-${runId}/unregistered`),
            cron: "* * * * *",
            prompt: "x",
          }),
        ];
        const after = (yield* automations.list(repo)).length;
        return { fields, before, after };
      }),
    );
    expect(refusals.fields).toEqual([
      "schedule",
      "schedule",
      "cron",
      "timezone",
      "cron",
      "cron",
      "runAt",
      "prompt",
      "skill",
      "column",
      "baseRef",
      "repo",
      "RepoNotFound",
    ]);
    expect(refusals.after).toBe(refusals.before);
  }, 60_000);
});
