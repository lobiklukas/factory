/**
 * The live-tasks panel's arithmetic (LOB-184): when a task is first seen, how long it has been
 * watched, and how a waiting task is named.
 *
 * Pure on purpose. The panel renders these through `TaskPanel`, which the browser drive in
 * `.pi/skills/verify-web` proves; the cases here are the ones a screenshot cannot settle — a task
 * that appears, a task that settles and is replaced, and a duration that crosses a minute.
 */
import type { SessionTask } from "@repo/domain/Session";
import { describe, expect, it } from "vitest";
import { formatAge, stampTasks, taskDepth, waitingLabel } from "./task-view";

const task = (id: string, extra: Partial<SessionTask> = {}): SessionTask => ({
  id,
  kind: "pi.tool",
  status: "running",
  phase: "execute",
  waitingOn: [],
  conversations: [],
  ...extra,
});

describe("stampTasks", () => {
  it("stamps a task the first time it is seen and keeps that stamp", () => {
    const first = stampTasks(new Map(), [task("7")], 1_000);
    expect(first.get("7")).toBe(1_000);
    const later = stampTasks(first, [task("7")], 9_000);
    expect(later.get("7")).toBe(1_000);
    // Nothing changed, so the caller's ref keeps its identity.
    expect(later).toBe(first);
  });

  it("forgets a settled task, so a later one does not inherit its age", () => {
    const running = stampTasks(new Map(), [task("7")], 1_000);
    const settled = stampTasks(running, [], 5_000);
    expect(settled.size).toBe(0);
    const again = stampTasks(settled, [task("7")], 7_000);
    expect(again.get("7")).toBe(7_000);
  });

  it("stamps two tasks that appear together in one graph revision", () => {
    const seen = stampTasks(
      new Map(),
      [task("7"), task("8", { status: "waiting", waitingOn: ["7"] })],
      2_000,
    );
    expect([...seen.keys()]).toEqual(["7", "8"]);
    expect([...seen.values()]).toEqual([2_000, 2_000]);
  });
});

describe("formatAge", () => {
  it("prints seconds below a minute and never a fraction", () => {
    expect(formatAge(0)).toBe("0s");
    expect(formatAge(3_400)).toBe("3s");
    expect(formatAge(59_999)).toBe("59s");
  });

  it("prints minutes with seconds, and hours with minutes, zero-padded", () => {
    expect(formatAge(60_000)).toBe("1m 00s");
    expect(formatAge(124_000)).toBe("2m 04s");
    expect(formatAge(3_600_000)).toBe("1h 00m");
    expect(formatAge(3_720_000)).toBe("1h 02m");
  });

  it("never counts backwards when a clock jumps", () => {
    expect(formatAge(-5_000)).toBe("0s");
  });
});

describe("waitingLabel", () => {
  it("names two ids on the row and counts past that", () => {
    expect(waitingLabel(["7"])).toBe("waiting on 7");
    expect(waitingLabel(["7", "8"])).toBe("waiting on 7, 8");
    expect(waitingLabel(["7", "8", "9"])).toBe("waiting on 3 tasks");
  });
});

describe("taskDepth", () => {
  const byId = (tasks: readonly SessionTask[]) =>
    new Map(tasks.map((task) => [task.id, task]));

  it("indents a task under a live owner and stops at two levels", () => {
    const tasks = [
      task("10"),
      task("11", { owner: "10" }),
      task("12", { owner: "11" }),
      task("13", { owner: "12" }),
    ];
    const map = byId(tasks);
    expect(tasks.map((each) => taskDepth(each, map))).toEqual([0, 1, 2, 2]);
  });

  it("stays flat when the owner already settled or is not a task", () => {
    const map = byId([task("13", { owner: "99" })]);
    expect(taskDepth(map.get("13")!, map)).toBe(0);
    expect(taskDepth(task("14"), map)).toBe(0);
  });

  it("terminates on an owner cycle", () => {
    const map = byId([
      task("20", { owner: "21" }),
      task("21", { owner: "20" }),
    ]);
    expect(taskDepth(map.get("20")!, map)).toBe(1);
  });
});
