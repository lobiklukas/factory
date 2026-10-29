/**
 * An automation's clock (S-general-automations, `./automationSchedule`): which instant a schedule has
 * reached at a moment, and which it reaches next. Pure: no database, no wall clock.
 */
import { describe, expect, it } from "vitest";
import {
  type AutomationSchedule,
  dueTickAt,
  nextTickAt,
  parseCronSchedule,
  shortestInterval,
} from "./automationSchedule";

const at = (iso: string): number => Date.parse(iso);

const cron = (expression: string, timezone = "UTC"): AutomationSchedule => {
  const parsed = parseCronSchedule(expression, timezone);
  if (parsed._tag !== "ok") throw new Error(parsed.message);
  return parsed.schedule;
};

describe("an automation's clock", () => {
  /**
   * Mutations this catches: asking `Cron.prev` from `now` itself (strict) — an instant equal to now
   * is not reached; answering `Cron.next` — the tick is one ahead; dropping the `enabledAt` floor — an
   * instant before creation fires.
   */
  it("reaches the latest minute at or before now, and none before it was enabled", () => {
    const everyMinute = cron("* * * * *");
    const enabled = at("2026-10-29T11:58:20.000Z");
    expect(
      dueTickAt(everyMinute, at("2026-10-29T12:00:30.500Z"), enabled),
    ).toBe(at("2026-10-29T12:00:00.000Z"));
    // On the instant itself: reached, not the one before.
    expect(
      dueTickAt(everyMinute, at("2026-10-29T12:00:00.000Z"), enabled),
    ).toBe(at("2026-10-29T12:00:00.000Z"));
    // Created at 11:58:20, so 11:58:00 is not owed — the first instant is 11:59:00.
    expect(
      dueTickAt(everyMinute, at("2026-10-29T11:58:40.000Z"), enabled),
    ).toBe(undefined);
    expect(
      dueTickAt(everyMinute, at("2026-10-29T11:59:00.000Z"), enabled),
    ).toBe(at("2026-10-29T11:59:00.000Z"));
  });

  it("owes one tick after a long outage, not a backlog", () => {
    const hourly = cron("0 * * * *");
    // Down from 03:10 until 09:45: the 04:00 … 09:00 instants collapse into the latest one.
    expect(
      dueTickAt(
        hourly,
        at("2026-10-29T09:45:00.000Z"),
        at("2026-10-29T03:10:00.000Z"),
      ),
    ).toBe(at("2026-10-29T09:00:00.000Z"));
  });

  it("reads the expression in its time zone", () => {
    const nineInPrague = cron("0 9 * * *", "Europe/Prague");
    // January is CET (UTC+1): 09:00 in Prague is 08:00 UTC.
    expect(
      dueTickAt(
        nineInPrague,
        at("2027-01-12T12:00:00.000Z"),
        at("2027-01-01T00:00:00.000Z"),
      ),
    ).toBe(at("2027-01-12T08:00:00.000Z"));
    expect(nextTickAt(nineInPrague, at("2027-01-12T12:00:00.000Z"))).toBe(
      at("2027-01-13T08:00:00.000Z"),
    );
  });

  it("fires a one-off once its instant is reached, and owes nothing after it", () => {
    const once: AutomationSchedule = {
      _tag: "once",
      at: at("2026-11-02T09:00:00.000Z"),
    };
    const enabled = at("2026-10-29T12:00:00.000Z");
    expect(dueTickAt(once, at("2026-11-02T08:59:59.999Z"), enabled)).toBe(
      undefined,
    );
    expect(dueTickAt(once, at("2026-11-02T10:00:00.000Z"), enabled)).toBe(
      at("2026-11-02T09:00:00.000Z"),
    );
    // Enabled again after its instant (a resume): it slept through it, so it is not owed.
    expect(
      dueTickAt(
        once,
        at("2026-11-02T10:00:00.000Z"),
        at("2026-11-02T09:30:00.000Z"),
      ),
    ).toBe(undefined);
    expect(nextTickAt(once, at("2026-11-01T00:00:00.000Z"))).toBe(
      at("2026-11-02T09:00:00.000Z"),
    );
    expect(nextTickAt(once, at("2026-11-02T09:00:00.000Z"))).toBe(undefined);
  });

  it("names the field it cannot read, and answers nothing for an expression no date matches", () => {
    const badCron = parseCronSchedule("every minute", "UTC");
    expect(badCron._tag === "invalid" && badCron.field).toBe("cron");
    const badZone = parseCronSchedule("* * * * *", "Mars/Olympus");
    expect(badZone._tag === "invalid" && badZone.field).toBe("timezone");
    const never = cron("0 0 31 2 *");
    expect(nextTickAt(never, at("2026-10-29T12:00:00.000Z"))).toBe(undefined);
    expect(dueTickAt(never, at("2026-10-29T12:00:00.000Z"), 0)).toBe(undefined);
  });

  it("reads six fields as seconds first", () => {
    const everyTenSeconds = cron("*/10 * * * * *");
    expect(dueTickAt(everyTenSeconds, at("2026-10-29T12:00:27.000Z"), 0)).toBe(
      at("2026-10-29T12:00:20.000Z"),
    );
  });

  /**
   * Mutations this catches: a gap read between `from` and the first instant rather than between two
   * instants — an every-minute cron read at 12:00:59 looks one second apart; a sample of one gap —
   * `0,50 * * * * *` read at 12:00:59 goes 12:01:00, 12:01:50 (50s), 12:02:00 (10s), and the first
   * gap alone misses the 10s one.
   */
  it("reads the shortest gap between a cron's instants", () => {
    const from = at("2026-10-29T12:00:59.000Z");
    expect(shortestInterval(cron("* * * * *"), from)).toBe(60_000);
    expect(shortestInterval(cron("0 9 * * *"), from)).toBe(86_400_000);
    expect(shortestInterval(cron("*/10 * * * * *"), from)).toBe(10_000);
    expect(shortestInterval(cron("0,50 * * * * *"), from)).toBe(10_000);
    expect(
      shortestInterval({ _tag: "once", at: at("2026-11-01T00:00:00Z") }, from),
    ).toBe(undefined);
  });
});
