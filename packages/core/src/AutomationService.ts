/**
 * Scheduled automations (S-general-automations): a repo's cron or one-off schedules, each tick a card
 * on the repo's board with a run on it.
 *
 * **A tick is filed the way any outside item is.** The card goes through `TaskService.file`, the door
 * a card-mode trigger delivery comes through (LOB-254), keyed by `automation:<id>@<instant>`; the run
 * is `SessionService.create` against the card — a run row, the card's base, the column's prompt and
 * autonomy — sent `runPrompt`'s first message, as `factory board start` sends it. So an automation
 * adds a clock and decides nothing a card or a run does not already decide: its run is reviewed,
 * gated and merged like any other card's.
 *
 * **One card per tick, across restarts and processes.** A tick is recorded before anything else
 * (`automation_ticks`, keyed by the automation and the instant) with one `INSERT … ON CONFLICT … DO
 * UPDATE … WHERE … RETURNING`: the caller that gets no row back reached a tick somebody already
 * holds, and answers that tick. The claim is handed over only when it is older than
 * `RECLAIM_AFTER` and still `claimed` — the process that held it died before it recorded an outcome
 * — and taking it over is safe, because the card is filed under its external ref, the run created
 * under its request id and the message sent under it too: a retried tick finds the card, the run and
 * the message the first attempt made, and makes none of them twice. A takeover needs the same
 * instant to be due again, which a one-off's is and a frequent cron's is not: by the time the claim
 * is stale the cron has reached later instants. So each pass also closes every stale claim on an
 * instant its schedule has moved past, as `failed` with the reason — a tick is never left `claimed`
 * in the history. A shutdown does not leave one behind: from filing the card to recording the
 * outcome a tick is uninterruptible, so a card is never filed without the tick saying so.
 *
 * **No card without a run.** When the run cannot be opened (admission control at capacity, the
 * board's run cap), the card this tick filed is moved to `canceled` before the tick is recorded
 * `failed`: a frequent schedule that keeps being refused does not pile run-less cards on the board.
 * A schedule fires at most once a minute (`MIN_AUTOMATION_INTERVAL_MS`); `add` refuses a faster one.
 *
 * **Skip if unchanged.** A scheduled tick reads the base's tip first (`SessionService.baseHead`, the
 * read a session's cut makes: the clone synced, the forge fetched). When it is the commit the last
 * `started` tick ran on, the tick is `skipped` with the reason, and nothing is filed. A tip git cannot
 * read does not skip: an automation that silently never ran would be the worse failure. A manual run
 * never skips — a person asked for one.
 *
 * **History is the ticks, joined to the runs.** A tick keeps what it decided — its status, its
 * reason, the base it read, the card and the run it made; the run's own status and spend are
 * `session_activity`'s and are read from there, so the history never disagrees with the session list.
 */
import {
  Clock,
  Context,
  DateTime,
  Duration,
  Effect,
  Layer,
  Option,
  Schedule,
  Schema,
} from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import {
  type AddAutomationInput,
  type Automation,
  type AutomationError,
  AutomationId,
  AutomationNotFound,
  AutomationStorageError,
  type AutomationTick,
  AutomationTickStatus,
  type AutomationTrigger,
  InvalidAutomation,
  MAX_AUTOMATION_NAME_CHARS,
  MAX_AUTOMATION_PROMPT_CHARS,
} from "@repo/domain/Automation";
import { SessionId } from "@repo/domain/Ids";
import { RepoSlug } from "@repo/domain/Session";
import {
  ABANDON_COLUMN,
  MAX_TASK_TITLE_CHARS,
  runPrompt,
  TaskId,
} from "@repo/domain/Task";
import {
  type AutomationSchedule,
  dueTickAt,
  MIN_AUTOMATION_INTERVAL_MS,
  nextTickAt,
  parseCronSchedule,
  shortestInterval,
} from "./automationSchedule";
import { isSafeBranchName } from "./git";
import { mintAutomationId } from "./ids";
import { SessionService } from "./SessionService";
import { SkillService } from "./SkillService";
import { TaskService } from "./TaskService";
import { cardBodyOf } from "./TriggerService";

/** How long a `claimed` tick is its claimant's before another caller may take it over. */
export const RECLAIM_AFTER = Duration.minutes(10);

/** The external ref a tick's card is filed under: what makes a retried tick find its card. */
export const automationCardRef = (id: AutomationId, tickAt: number): string =>
  `automation:${id}@${isoAt(tickAt)}`;

/** The request id a tick's run is created and sent under. */
export const automationRequestId = (id: AutomationId, tickAt: number): string =>
  `automation:${id}@${tickAt}`;

/** Who a tick's card and run are attributed to: the automation, never the person who added it. */
export const automationActorOf = (id: AutomationId): string =>
  `automation:${id}`;

/** What a tick did: the tick as recorded, and whether this call found it already recorded. */
export type FiredTick = {
  readonly tick: AutomationTick;
  readonly replayed: boolean;
};

export type AutomationServiceShape = {
  /** A new automation, enabled from now (see `AddAutomationInput` for what is refused). */
  readonly add: (
    input: AddAutomationInput,
  ) => Effect.Effect<Automation, AutomationError>;
  /** Every automation, or one repo's, oldest first. */
  readonly list: (
    repo?: RepoSlug,
  ) => Effect.Effect<ReadonlyArray<Automation>, AutomationError>;
  readonly get: (
    id: AutomationId,
  ) => Effect.Effect<Automation, AutomationError>;
  /** No further scheduled tick fires; a manual run still does. */
  readonly pause: (
    id: AutomationId,
  ) => Effect.Effect<Automation, AutomationError>;
  /** Enabled again from now: an instant reached while paused does not fire. */
  readonly resume: (
    id: AutomationId,
  ) => Effect.Effect<Automation, AutomationError>;
  /** Gone, with its ticks; the cards and runs it made stay. */
  readonly remove: (
    id: AutomationId,
  ) => Effect.Effect<Automation, AutomationError>;
  /** One tick now, paused or not, that never skips on an unmoved base. */
  readonly run: (id: AutomationId) => Effect.Effect<FiredTick, AutomationError>;
  /**
   * The scheduled tick the automation owes at `at` (default: now), fired — or answered, when it was
   * already recorded. `undefined` when nothing is due: paused, before its first instant, or a
   * one-off whose instant is ahead.
   */
  readonly tick: (
    id: AutomationId,
    at?: number,
  ) => Effect.Effect<FiredTick | undefined, AutomationError>;
  /**
   * Every enabled automation's due tick at `at` (default: now), one after another. A tick that fails
   * is recorded and logged and does not stop the pass. The answer is the ticks this pass fired.
   */
  readonly pass: (
    at?: number,
  ) => Effect.Effect<ReadonlyArray<AutomationTick>, AutomationError>;
  /** The automation's ticks, newest first, at most `limit`. */
  readonly ticks: (
    id: AutomationId,
    limit?: number,
  ) => Effect.Effect<ReadonlyArray<AutomationTick>, AutomationError>;
};

export class AutomationService extends Context.Service<
  AutomationService,
  AutomationServiceShape
>()("@repo/core/AutomationService") {}

/** One `automations` row as the driver returns it. */
type AutomationRow = {
  readonly id: string;
  readonly name: string;
  readonly repo: string;
  readonly cron: string | null;
  readonly timezone: string;
  readonly runAt: Date | string | null;
  readonly prompt: string;
  readonly skill: string | null;
  readonly budget: number | null;
  readonly taskColumn: string | null;
  readonly baseRef: string | null;
  readonly skipIfUnchanged: boolean;
  readonly enabled: boolean;
  readonly enabledAt: Date | string;
  readonly createdBy: string;
  readonly createdAt: Date | string;
};

/** One `automation_ticks` row, joined to its run's `session_activity` row. */
type TickRow = {
  readonly automationId: string;
  readonly tickAt: Date | string;
  readonly trigger: string;
  readonly status: string;
  readonly reason: string;
  readonly baseRef: string | null;
  readonly baseCommit: string | null;
  readonly taskId: string | null;
  readonly sessionId: string | null;
  readonly claimedAt: Date | string;
  readonly finishedAt: Date | string | null;
  readonly runStatus: string | null;
  readonly runCost: number | null;
  readonly runActivityAt: Date | string | null;
};

/** An instant, as the wire and the SQL carry it: ISO 8601 in UTC, to the millisecond. */
const isoAt = (millis: number): string =>
  DateTime.formatIso(DateTime.makeUnsafe(millis));

/** A `TIMESTAMPTZ` the driver answered (a `Date`, or text), as epoch milliseconds. */
const millisOf = (value: Date | string): number =>
  DateTime.toEpochMillis(DateTime.makeUnsafe(value));

const isoOf = (value: Date | string): string => isoAt(millisOf(value));

const scheduleOf = (row: AutomationRow): AutomationSchedule | undefined => {
  if (row.runAt !== null) return { _tag: "once", at: millisOf(row.runAt) };
  if (row.cron === null) return undefined;
  const parsed = parseCronSchedule(row.cron, row.timezone);
  return parsed._tag === "ok" ? parsed.schedule : undefined;
};

const tickOf = (row: TickRow): AutomationTick => ({
  automationId: AutomationId.make(row.automationId),
  tickAt: isoOf(row.tickAt),
  trigger: row.trigger === "manual" ? "manual" : "schedule",
  status: Schema.is(AutomationTickStatus)(row.status) ? row.status : "failed",
  reason: row.reason,
  ...(row.baseRef === null ? {} : { baseRef: row.baseRef }),
  ...(row.baseCommit === null ? {} : { baseCommit: row.baseCommit }),
  ...(row.taskId === null ? {} : { taskId: TaskId.make(row.taskId) }),
  ...(row.sessionId === null
    ? {}
    : { sessionId: SessionId.make(row.sessionId) }),
  ...(row.runStatus === null || row.runActivityAt === null
    ? {}
    : {
        run: {
          status: row.runStatus === "busy" ? "busy" : "idle",
          costTotal: row.runCost ?? 0,
          lastActivityAt: isoOf(row.runActivityAt),
        },
      }),
  claimedAt: isoOf(row.claimedAt),
  ...(row.finishedAt === null ? {} : { finishedAt: isoOf(row.finishedAt) }),
});

/** A short sha for a reason line. */
const short = (sha: string): string => sha.slice(0, 12);

/** The name an automation gets when it was given none: the prompt's first words, or the skill. */
const defaultName = (prompt: string, skill: string | undefined): string => {
  const firstLine = prompt.split("\n")[0]?.trim() ?? "";
  if (firstLine !== "")
    return firstLine.length > 60 ? `${firstLine.slice(0, 59)}…` : firstLine;
  return `skill ${skill ?? "automation"}`;
};

/** A tick's card title: the automation's name and the instant, fitted to a card title's cap. */
const cardTitle = (
  name: string,
  tickAt: number,
  trigger: AutomationTrigger,
): string => {
  const when = `${isoAt(tickAt).slice(0, 16).replace("T", " ")} UTC`;
  const suffix = trigger === "manual" ? ` (run now, ${when})` : ` (${when})`;
  const room = MAX_TASK_TITLE_CHARS - suffix.length;
  return `${name.length > room ? `${name.slice(0, room - 1)}…` : name}${suffix}`;
};

export const AutomationServiceLive = Layer.effect(
  AutomationService,
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const sessions = yield* SessionService;
    const tasks = yield* TaskService;
    const skills = yield* SkillService;

    const storage = <A>(
      what: string,
      effect: Effect.Effect<A, SqlError>,
    ): Effect.Effect<A, AutomationStorageError> =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new AutomationStorageError({
              message: `${what}: ${cause.message}`,
            }),
        ),
      );

    const invalid = (field: string, message: string) =>
      new InvalidAutomation({ field, message });

    const readRow = (id: AutomationId) =>
      Effect.gen(function* () {
        const rows = yield* storage(
          "read the automation",
          sql<AutomationRow>`SELECT * FROM automations WHERE id = ${id}`,
        );
        const row = rows[0];
        if (row === undefined) {
          return yield* new AutomationNotFound({
            id,
            message: `automation ${id} does not exist`,
          });
        }
        return row;
      });

    const tickRows = (id: string, limit: number) =>
      storage(
        "read the automation's ticks",
        sql<TickRow>`
          SELECT t.*, a.status AS run_status, a.cost_total AS run_cost,
            a.last_activity_at AS run_activity_at
          FROM automation_ticks t
          LEFT JOIN session_activity a ON a.session_id = t.session_id
          WHERE t.automation_id = ${id}
          ORDER BY t.tick_at DESC
          LIMIT ${limit}
        `,
      );

    const readTick = (id: string, tickAt: number) =>
      Effect.gen(function* () {
        const rows = yield* storage(
          "read the tick",
          sql<TickRow>`
            SELECT t.*, a.status AS run_status, a.cost_total AS run_cost,
              a.last_activity_at AS run_activity_at
            FROM automation_ticks t
            LEFT JOIN session_activity a ON a.session_id = t.session_id
            WHERE t.automation_id = ${id}
              AND t.tick_at = ${isoAt(tickAt)}::timestamptz
          `,
        );
        const row = rows[0];
        if (row === undefined) {
          return yield* new AutomationStorageError({
            message: `the tick ${isoAt(tickAt)} of automation ${id} was claimed but cannot be read`,
          });
        }
        return tickOf(row);
      });

    const summarize = (row: AutomationRow) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const last = (yield* tickRows(row.id, 1))[0];
        const schedule = scheduleOf(row);
        // A one-off's instant is next only while it is ahead: once reached, it has fired.
        const next =
          !row.enabled || schedule === undefined
            ? undefined
            : nextTickAt(schedule, Math.max(now, millisOf(row.enabledAt) - 1));
        return {
          id: AutomationId.make(row.id),
          name: row.name,
          repo: RepoSlug.make(row.repo),
          ...(row.cron === null ? {} : { cron: row.cron }),
          timezone: row.timezone,
          ...(row.runAt === null ? {} : { runAt: isoOf(row.runAt) }),
          prompt: row.prompt,
          ...(row.skill === null ? {} : { skill: row.skill }),
          ...(row.budget === null ? {} : { budget: row.budget }),
          ...(row.taskColumn === null ? {} : { column: row.taskColumn }),
          ...(row.baseRef === null ? {} : { baseRef: row.baseRef }),
          skipIfUnchanged: row.skipIfUnchanged,
          enabled: row.enabled,
          enabledAt: isoOf(row.enabledAt),
          createdBy: row.createdBy,
          createdAt: isoOf(row.createdAt),
          ...(next === undefined ? {} : { nextTickAt: isoAt(next) }),
          ...(last === undefined ? {} : { lastTick: tickOf(last) }),
        } satisfies Automation;
      });

    /** The repo's one board, or `undefined` when it has none (`createBoard` keeps it to one). */
    const boardOf = (repo: string) =>
      storage(
        "read the repo's board",
        sql<{ id: string }>`
          SELECT id FROM board_instances WHERE repo = ${repo}
          ORDER BY created_at, id
          LIMIT 1
        `,
      ).pipe(Effect.map((rows) => rows[0]?.id));

    const add = (
      input: AddAutomationInput,
    ): Effect.Effect<Automation, AutomationError> =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const cron = input.cron?.trim();
        const runAt = input.runAt?.trim();
        const hasCron = cron !== undefined && cron !== "";
        const hasRunAt = runAt !== undefined && runAt !== "";
        if (hasCron === hasRunAt) {
          return yield* invalid(
            "schedule",
            "an automation names exactly one schedule: a cron expression (--cron) or one instant (--at)",
          );
        }
        const timezone = input.timezone?.trim() || "UTC";
        let at: number | undefined;
        if (hasCron) {
          const parsed = parseCronSchedule(cron, timezone);
          if (parsed._tag === "invalid") {
            return yield* invalid(parsed.field, parsed.message);
          }
          if (nextTickAt(parsed.schedule, now) === undefined) {
            return yield* invalid(
              "cron",
              `"${cron}" matches no date, so it would never fire`,
            );
          }
          const interval = shortestInterval(parsed.schedule, now);
          if (interval !== undefined && interval < MIN_AUTOMATION_INTERVAL_MS) {
            return yield* invalid(
              "cron",
              `"${cron}" fires ${interval / 1000}s apart; an automation fires at most once every ${MIN_AUTOMATION_INTERVAL_MS / 1000}s, because each tick files a card and starts a run`,
            );
          }
        } else {
          const parsed = DateTime.make(runAt ?? "");
          at = Option.isSome(parsed)
            ? DateTime.toEpochMillis(parsed.value)
            : undefined;
          if (at === undefined) {
            return yield* invalid(
              "runAt",
              `"${runAt}" is not an instant (an ISO 8601 date and time, such as 2026-11-02T09:00:00Z)`,
            );
          }
          if (at <= now) {
            return yield* invalid(
              "runAt",
              `${isoAt(at)} has passed: a one-off runs at an instant still ahead (or use factory automation run for now)`,
            );
          }
        }
        const prompt = (input.prompt ?? "").trim();
        if (prompt === "" && input.skill === undefined) {
          return yield* invalid(
            "prompt",
            "an automation tells its run something: a prompt, a skill, or both",
          );
        }
        if (prompt.length > MAX_AUTOMATION_PROMPT_CHARS) {
          return yield* invalid(
            "prompt",
            `the prompt is ${prompt.length} characters; an automation's prompt is its cards' body, at most ${MAX_AUTOMATION_PROMPT_CHARS}`,
          );
        }
        if (input.skill !== undefined) {
          yield* skills.get(input.skill).pipe(
            Effect.catchTags({
              SkillNotFound: () =>
                Effect.fail(
                  invalid(
                    "skill",
                    `the skill library holds no skill "${input.skill}" (factory skill ls)`,
                  ),
                ),
              SkillStorageError: (cause) =>
                Effect.fail(
                  new AutomationStorageError({ message: cause.message }),
                ),
            }),
          );
        }
        const baseRef = input.baseRef?.trim();
        if (
          baseRef !== undefined &&
          baseRef !== "" &&
          !isSafeBranchName(baseRef)
        ) {
          return yield* invalid(
            "baseRef",
            `"${baseRef}" is not a ref a run can be cut from (a branch, a tag or a sha)`,
          );
        }
        yield* sessions
          .getRepo({ repo: input.repo })
          .pipe(
            Effect.catchTag("SessionError", (cause) =>
              Effect.fail(
                new AutomationStorageError({ message: cause.message }),
              ),
            ),
          );
        const boardId = yield* boardOf(input.repo);
        if (boardId === undefined) {
          return yield* invalid(
            "repo",
            `${input.repo} has no board, so a tick has nowhere to file its card: make one with factory board create --repo ${input.repo}`,
          );
        }
        const column = input.column?.trim();
        if (column !== undefined && column !== "") {
          const view = yield* tasks
            .getBoard(boardId)
            .pipe(
              Effect.mapError(
                (cause) =>
                  new AutomationStorageError({ message: cause.message }),
              ),
            );
          const names = view.definition.columns.map((entry) => entry.name);
          if (!names.includes(column)) {
            return yield* invalid(
              "column",
              `${input.repo}'s board declares no column "${column}" (it declares ${names.join(", ")})`,
            );
          }
        }
        const name =
          (input.name ?? "").trim() || defaultName(prompt, input.skill);
        if (name.length > MAX_AUTOMATION_NAME_CHARS) {
          return yield* invalid(
            "name",
            `the name is ${name.length} characters; at most ${MAX_AUTOMATION_NAME_CHARS}`,
          );
        }
        const id = yield* mintAutomationId;
        const rows = yield* storage(
          "add the automation",
          sql<AutomationRow>`
            INSERT INTO automations (id, name, repo, cron, timezone, run_at, prompt, skill,
              budget, task_column, base_ref, skip_if_unchanged, enabled, enabled_at, created_by)
            VALUES (${id}, ${name}, ${input.repo}, ${hasCron ? cron : null}, ${timezone},
              ${at === undefined ? null : isoAt(at)}::timestamptz,
              ${prompt}, ${input.skill ?? null}, ${input.budget ?? null},
              ${column === undefined || column === "" ? null : column},
              ${baseRef === undefined || baseRef === "" ? null : baseRef},
              ${input.skipIfUnchanged ?? true}, true,
              ${isoAt(now)}::timestamptz, ${input.actor ?? ""})
            RETURNING *
          `,
        );
        const row = rows[0];
        if (row === undefined) {
          return yield* new AutomationStorageError({
            message: `automation ${id} was not written`,
          });
        }
        yield* Effect.logInfo(
          `automation ${id}: added for ${row.repo} (${hasCron ? `cron "${cron}" in ${timezone}` : `once at ${isoAt(at ?? 0)}`})`,
        );
        return yield* summarize(row);
      });

    const list = (repo?: RepoSlug) =>
      Effect.gen(function* () {
        const rows = yield* storage(
          "list the automations",
          repo === undefined
            ? sql<AutomationRow>`SELECT * FROM automations ORDER BY created_at, id`
            : sql<AutomationRow>`
                SELECT * FROM automations WHERE repo = ${repo} ORDER BY created_at, id
              `,
        );
        return yield* Effect.forEach(rows, summarize);
      });

    const get = (id: AutomationId) => Effect.flatMap(readRow(id), summarize);

    const pause = (id: AutomationId) =>
      Effect.gen(function* () {
        yield* readRow(id);
        const rows = yield* storage(
          "pause the automation",
          sql<AutomationRow>`
            UPDATE automations SET enabled = false WHERE id = ${id} RETURNING *
          `,
        );
        const row = rows[0] ?? (yield* readRow(id));
        return yield* summarize(row);
      });

    const resume = (id: AutomationId) =>
      Effect.gen(function* () {
        yield* readRow(id);
        const now = yield* Clock.currentTimeMillis;
        // An enabled one keeps its `enabled_at`: resuming it must not drop an instant it has reached.
        const rows = yield* storage(
          "resume the automation",
          sql<AutomationRow>`
            UPDATE automations
            SET enabled_at = CASE WHEN enabled THEN enabled_at
                  ELSE ${isoAt(now)}::timestamptz END,
                enabled = true
            WHERE id = ${id}
            RETURNING *
          `,
        );
        const row = rows[0] ?? (yield* readRow(id));
        return yield* summarize(row);
      });

    const remove = (id: AutomationId) =>
      Effect.gen(function* () {
        const before = yield* get(id);
        yield* storage(
          "remove the automation",
          sql`DELETE FROM automations WHERE id = ${id}`,
        );
        return before;
      });

    /** Record where a tick ended. */
    const finish = (
      id: string,
      tickAt: number,
      outcome: {
        readonly status: Exclude<AutomationTickStatus, "claimed">;
        readonly reason: string;
        readonly baseRef?: string | undefined;
        readonly baseCommit?: string | undefined;
        readonly taskId?: string | undefined;
        readonly sessionId?: string | undefined;
      },
    ) =>
      storage(
        "record the tick",
        sql`
          UPDATE automation_ticks
          SET status = ${outcome.status}, reason = ${outcome.reason},
            base_ref = ${outcome.baseRef ?? null}, base_commit = ${outcome.baseCommit ?? null},
            task_id = ${outcome.taskId ?? null}, session_id = ${outcome.sessionId ?? null},
            finished_at = now()
          WHERE automation_id = ${id}
            AND tick_at = ${isoAt(tickAt)}::timestamptz
        `,
      );

    /**
     * Claim the tick, or answer that somebody holds it: `true` when this caller holds it now (a new
     * tick, or a claim whose holder died past `RECLAIM_AFTER` without recording an outcome).
     */
    const claim = (id: string, tickAt: number, trigger: AutomationTrigger) =>
      storage(
        "claim the tick",
        sql<{ automationId: string }>`
          INSERT INTO automation_ticks AS t (automation_id, tick_at, trigger)
          VALUES (${id}, ${isoAt(tickAt)}::timestamptz, ${trigger})
          ON CONFLICT (automation_id, tick_at) DO UPDATE SET claimed_at = now()
            WHERE t.status = 'claimed'
              AND t.claimed_at < now() - ${Duration.toSeconds(RECLAIM_AFTER)} * interval '1 second'
          RETURNING automation_id
        `,
      ).pipe(Effect.map((rows) => rows.length > 0));

    /**
     * What a claimed tick does: read the base, skip when it has not moved (a scheduled tick only), file
     * the card, open the run and send it its first message. Every way it can end is recorded on the
     * tick; a failure is an outcome here, not an error, so one automation's broken tick cannot stop
     * the pass that reached it.
     */
    const work = (
      row: AutomationRow,
      tickAt: number,
      trigger: AutomationTrigger,
    ): Effect.Effect<void, AutomationStorageError> =>
      Effect.gen(function* () {
        const id = AutomationId.make(row.id);
        const repo = RepoSlug.make(row.repo);
        const head = yield* sessions
          .baseHead({ repo, baseRef: row.baseRef ?? undefined })
          .pipe(Effect.result);
        if (head._tag === "Failure") {
          return yield* finish(row.id, tickAt, {
            status: "failed",
            reason: `the base could not be read: ${head.failure.message}`,
          });
        }
        const base = head.success;
        const at = { baseRef: base.ref, baseCommit: base.sha };
        if (
          trigger === "schedule" &&
          row.skipIfUnchanged &&
          base.sha !== undefined
        ) {
          const previous = yield* storage(
            "read the last started tick",
            sql<{ tickAt: Date | string; baseCommit: string | null }>`
              SELECT tick_at, base_commit FROM automation_ticks
              WHERE automation_id = ${row.id} AND status = 'started'
                AND tick_at <> ${isoAt(tickAt)}::timestamptz
              ORDER BY tick_at DESC
              LIMIT 1
            `,
          );
          const last = previous[0];
          if (last !== undefined && last.baseCommit === base.sha) {
            return yield* finish(row.id, tickAt, {
              ...at,
              status: "skipped",
              reason: `no new commits on ${base.ref} since the run at ${isoOf(last.tickAt)} (${short(base.sha)}), so nothing was filed`,
            });
          }
        }
        const boardId = yield* boardOf(row.repo);
        if (boardId === undefined) {
          return yield* finish(row.id, tickAt, {
            ...at,
            status: "skipped",
            reason: `${row.repo} has no board, so the card has nowhere to go: make one with factory board create --repo ${row.repo}`,
          });
        }
        const failed = (
          reason: string,
          made: { taskId?: string; sessionId?: string } = {},
        ) =>
          finish(row.id, tickAt, { ...at, ...made, status: "failed", reason });

        // The card's body: the skill's text as the tick reads it (its newest version), then the prompt.
        let skillPart: string | undefined;
        if (row.skill !== null) {
          const skill = yield* skills.get(row.skill).pipe(Effect.result);
          if (skill._tag === "Failure") {
            return yield* failed(
              `the skill "${row.skill}" could not be read: ${skill.failure.message}`,
            );
          }
          skillPart = `Follow the factory skill "${skill.success.name}" (version ${skill.success.version}):\n\n${skill.success.body.trim()}`;
        }
        const footer = `Filed by automation "${row.name}" (${id}) for its ${trigger === "manual" ? "manual run" : "tick"} at ${isoAt(tickAt)}.`;
        const body = cardBodyOf(
          [skillPart, row.prompt === "" ? undefined : row.prompt, footer]
            .filter((part) => part !== undefined)
            .join("\n\n"),
        ).body;
        // From the card to the outcome, a tick is not interrupted: a shutdown waits for it, so it never
        // leaves a card filed (or a run opened) with the tick still `claimed`.
        return yield* Effect.uninterruptible(
          Effect.gen(function* () {
          const filed = yield* tasks
            .file({
              boardId,
              repo: row.repo,
              title: cardTitle(row.name, tickAt, trigger),
              body,
              ...(row.baseRef === null ? {} : { baseRef: row.baseRef }),
              externalRef: automationCardRef(id, tickAt),
              actor: automationActorOf(id),
            })
            .pipe(Effect.result);
          if (filed._tag === "Failure") {
            return yield* failed(
              `the board refused the card: ${filed.failure._tag}: ${filed.failure.message}`,
            );
          }
          const card = filed.success.task;
          const column = row.taskColumn ?? card.column;
          const definition = yield* tasks.getBoard(card.boardId).pipe(
            Effect.flatMap((view) =>
              view.definition.version === card.definitionVersion
                ? Effect.succeed(view.definition)
                : tasks.getDefinition(
                    view.instance.definitionId,
                    card.definitionVersion,
                  ),
            ),
            Effect.result,
          );
          const columnOf =
            definition._tag === "Success"
              ? definition.success.columns.find((entry) => entry.name === column)
              : undefined;
          const requestId = automationRequestId(id, tickAt);
          const created = yield* sessions
            .create({
              title: card.title,
              requestId,
              taskId: card.id,
              taskColumn: column,
              actor: automationActorOf(id),
              ...(row.budget === null ? {} : { budget: row.budget }),
            })
            .pipe(Effect.result);
          if (created._tag === "Failure") {
            const refused = `its run could not be opened: ${created.failure.code}: ${created.failure.message}`;
            // A card this tick filed and no run took is canceled, not left for the next tick to pile
            // another beside. A card an earlier attempt filed (a taken-over claim) is left as it is.
            if (!filed.success.created) {
              return yield* failed(`found card ${card.id}, but ${refused}`, {
                taskId: card.id,
              });
            }
            const canceled = yield* tasks
              .move({
                taskId: card.id,
                expectedRevision: card.revision,
                to: ABANDON_COLUMN,
                actor: automationActorOf(id),
              })
              .pipe(Effect.result);
            return yield* failed(
              canceled._tag === "Success"
                ? `filed card ${card.id}, but ${refused}; the card was moved to ${ABANDON_COLUMN}`
                : `filed card ${card.id}, but ${refused}; the card could not be moved to ${ABANDON_COLUMN} either (${canceled.failure._tag}: ${canceled.failure.message})`,
              { taskId: card.id },
            );
          }
          const sessionId = created.success.id;
          const sent = yield* sessions
            .sendDeferringSetup({
              sessionId,
              content: runPrompt(card, columnOf),
              requestId,
            })
            .pipe(Effect.result);
          if (sent._tag === "Failure") {
            return yield* failed(
              `filed card ${card.id} and opened run ${sessionId}, but its first message was refused: ${sent.failure.code}: ${sent.failure.message}`,
              { taskId: card.id, sessionId },
            );
          }
          return yield* finish(row.id, tickAt, {
            ...at,
            status: "started",
            reason: `${filed.success.created ? "filed" : "found"} card ${card.id} and started run ${sessionId} in ${column}, on ${base.ref}${
              base.sha === undefined
                ? ` (its tip could not be read: ${base.note ?? "no reason given"})`
                : ` at ${short(base.sha)}`
            }${sent.success === "after_setup" ? "; its first message waits for the worktree's setup" : ""}`,
            taskId: card.id,
            sessionId,
          });
          }),
        );
      });

    /** Claim the tick and, when this caller holds it, do it; either way answer the tick. */
    const fire = (
      row: AutomationRow,
      tickAt: number,
      trigger: AutomationTrigger,
    ): Effect.Effect<FiredTick, AutomationError> =>
      Effect.gen(function* () {
        const held = yield* claim(row.id, tickAt, trigger);
        if (held) {
          yield* work(row, tickAt, trigger);
          const tick = yield* readTick(row.id, tickAt);
          yield* Effect.logInfo(
            `automation ${row.id}: ${trigger} tick ${tick.tickAt} ${tick.status}: ${tick.reason}`,
          );
          return { tick, replayed: false };
        }
        return { tick: yield* readTick(row.id, tickAt), replayed: true };
      });

    const run = (id: AutomationId) =>
      Effect.gen(function* () {
        const row = yield* readRow(id);
        return yield* fire(row, yield* Clock.currentTimeMillis, "manual");
      });

    const dueFor = (row: AutomationRow, at: number): number | undefined => {
      if (!row.enabled) return undefined;
      const schedule = scheduleOf(row);
      return schedule === undefined
        ? undefined
        : dueTickAt(schedule, at, millisOf(row.enabledAt));
    };

    const tick = (id: AutomationId, at?: number) =>
      Effect.gen(function* () {
        const row = yield* readRow(id);
        const now = at ?? (yield* Clock.currentTimeMillis);
        const due = dueFor(row, now);
        return due === undefined
          ? undefined
          : yield* fire(row, due, "schedule");
      });

    /**
     * Record as `failed` every claim on the automation older than `RECLAIM_AFTER` whose instant is not
     * `due`: the process that held it stopped before it recorded an outcome, and no caller will take
     * it over, because the schedule has moved past its instant (`claim` takes over only the instant
     * that is due). The due instant's own stale claim is left for `claim` to take over and finish.
     * The card and the run the claim got as far as making are found by the ref and the request id
     * they were made under, so the history still links them.
     */
    const closeStaleClaims = (id: string, due: number | undefined) =>
      storage(
        "close the stale claims",
        sql`
          UPDATE automation_ticks AS t
          SET status = 'failed', finished_at = now(),
            reason = 'the process that claimed this tick stopped before it recorded an outcome, '
              || 'and the schedule has moved past its instant, so it is not retried',
            task_id = COALESCE(t.task_id, (
              SELECT c.id FROM tasks c
              WHERE c.external_ref = 'automation:' || t.automation_id || '@'
                || to_char(t.tick_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
              ORDER BY c.created_at LIMIT 1
            )),
            session_id = COALESCE(t.session_id, (
              SELECT r.id FROM sessions r
              WHERE r.request_id = 'automation:' || t.automation_id || '@'
                || (extract(epoch FROM t.tick_at) * 1000)::bigint::text
              LIMIT 1
            ))
          WHERE automation_id = ${id}
            AND status = 'claimed'
            AND claimed_at < now() - ${Duration.toSeconds(RECLAIM_AFTER)} * interval '1 second'
            ${due === undefined ? sql`` : sql`AND tick_at <> ${isoAt(due)}::timestamptz`}
        `,
      );

    const pass = (at?: number) =>
      Effect.gen(function* () {
        const now = at ?? (yield* Clock.currentTimeMillis);
        const rows = yield* storage(
          "list the enabled automations",
          sql<AutomationRow>`
            SELECT * FROM automations WHERE enabled ORDER BY created_at, id
          `,
        );
        const fired: Array<AutomationTick> = [];
        for (const row of rows) {
          const due = dueFor(row, now);
          yield* closeStaleClaims(row.id, due).pipe(
            Effect.catch((cause) =>
              Effect.logWarning(
                `automation ${row.id}: its stale claims could not be closed: ${cause.message}`,
              ),
            ),
          );
          if (due === undefined) continue;
          const outcome = yield* fire(row, due, "schedule").pipe(
            Effect.catch((cause) =>
              Effect.logWarning(
                `automation ${row.id}: its tick at ${isoAt(due)} could not be fired: ${cause.message}`,
              ).pipe(Effect.as(undefined)),
            ),
          );
          if (outcome !== undefined && !outcome.replayed)
            fired.push(outcome.tick);
        }
        return fired;
      });

    const ticks = (id: AutomationId, limit = 20) =>
      Effect.gen(function* () {
        yield* readRow(id);
        return (yield* tickRows(id, limit)).map(tickOf);
      });

    return AutomationService.of({
      add,
      list,
      get,
      pause,
      resume,
      remove,
      run,
      tick,
      pass,
      ticks,
    });
  }),
);

/**
 * The automations' clock as a deployment runs it: `pass` every `everyMs`, for as long as the caller's
 * scope lives. A pass that fails (the database is down) is logged and the next one tries again; a
 * tick's own failure is already recorded on the tick. `everyMs <= 0` is off and returns at once.
 */
export const runAutomations = (options: {
  readonly everyMs: number;
}): Effect.Effect<void, never, AutomationService> =>
  Effect.gen(function* () {
    if (!Number.isFinite(options.everyMs) || options.everyMs <= 0) return;
    const automations = yield* AutomationService;
    yield* automations.pass().pipe(
      Effect.catch((cause) =>
        Effect.logWarning(`automations: a pass failed: ${cause.message}`),
      ),
      Effect.repeat(Schedule.spaced(Duration.millis(options.everyMs))),
      Effect.asVoid,
    );
  });
