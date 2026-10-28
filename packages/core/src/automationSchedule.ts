/**
 * An automation's clock (S-general-automations): which instant a schedule has reached, and which it
 * reaches next. Pure, so the service, the list and the tests agree on one answer.
 *
 * A schedule is a cron expression read in a time zone (`effect/Cron`: five fields, or six with
 * seconds) or one instant (a one-off). The instant a tick fires for is the **latest** one the
 * schedule has reached at `now` — never a backlog: a control plane that was down across ten
 * instants fires the tenth when it is back, and the nine it slept through are not owed. An instant
 * before `enabledAt` (the automation's creation, or its resume) is not reached at all, so a resume
 * does not fire the instant it was paused across.
 */
import { Cron, Result } from "effect";

export type AutomationSchedule =
  | { readonly _tag: "cron"; readonly cron: Cron.Cron }
  | { readonly _tag: "once"; readonly at: number };

/** A cron expression read in `timezone`, or why `effect/Cron` cannot read it. */
export const parseCronSchedule = (
  expression: string,
  timezone: string,
):
  | { readonly _tag: "ok"; readonly schedule: AutomationSchedule }
  | {
      readonly _tag: "invalid";
      readonly field: "cron" | "timezone";
      readonly message: string;
    } => {
  const parsed = Cron.parse(expression.trim(), timezone);
  if (Result.isFailure(parsed)) {
    const message = parsed.failure.message;
    return {
      _tag: "invalid",
      field: /time ?zone/i.test(message) ? "timezone" : "cron",
      message: /time ?zone/i.test(message)
        ? `"${timezone}" is not a time zone the factory can read cron schedules in (an IANA name, such as Europe/Prague or UTC)`
        : `"${expression}" is not a cron expression: ${message} (five fields, minute hour day month weekday, or six with seconds first)`,
    };
  }
  return { _tag: "ok", schedule: { _tag: "cron", cron: parsed.success } };
};

/** `Cron.next` and `Cron.prev` throw for an expression no date matches (`0 0 31 2 *`). */
const guarded = (read: () => Date): number | undefined => {
  try {
    return read().getTime();
  } catch {
    return undefined;
  }
};

/**
 * The instant the schedule has most recently reached at `now` — at or before it — when that is at or
 * after `enabledAt`; otherwise `undefined`, which is "nothing is due". `Cron.prev` is strict at the
 * second, so it is asked from the start of the next second: an instant equal to `now` is reached.
 */
export const dueTickAt = (
  schedule: AutomationSchedule,
  now: number,
  enabledAt: number,
): number | undefined => {
  const reached =
    schedule._tag === "once"
      ? schedule.at <= now
        ? schedule.at
        : undefined
      : guarded(() =>
          Cron.prev(schedule.cron, Math.floor(now / 1000) * 1000 + 1000),
        );
  return reached !== undefined && reached >= enabledAt ? reached : undefined;
};

/**
 * The next instant after `now` the schedule fires at: a cron's next match, or a one-off's instant
 * while it is still ahead. `undefined` for a one-off whose instant has passed and an expression no
 * date matches.
 */
export const nextTickAt = (
  schedule: AutomationSchedule,
  now: number,
): number | undefined =>
  schedule._tag === "once"
    ? schedule.at > now
      ? schedule.at
      : undefined
    : guarded(() => Cron.next(schedule.cron, now));
