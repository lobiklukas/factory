/**
 * `factory automation`'s rendering (S-general-automations). The commands themselves are proven by
 * `.pi/skills/verify-api/automations.sh` against a real control plane; these cases pin what a row, a
 * tick and the history print, so a script reading them with `cut -f` keeps its columns.
 */
import {
  type Automation,
  AutomationId,
  type AutomationTick,
} from "@repo/domain/Automation";
import { SessionId } from "@repo/domain/Ids";
import { RepoSlug } from "@repo/domain/Session";
import { TaskId } from "@repo/domain/Task";
import { describe, expect, it } from "vitest";
import {
  AUTOMATION_HISTORY_HEADER,
  AUTOMATION_LS_HEADER,
  automationLines,
  automationLsLines,
  historyLines,
  NONE,
  tickLines,
} from "./automation";

const id = AutomationId.make("aut_01m62enbj2z1cycge3zp95jp5k");

const automation = (extra: Partial<Automation> = {}): Automation => ({
  id,
  name: "nightly deps",
  repo: RepoSlug.make("acme/widgets"),
  cron: "0 3 * * *",
  timezone: "UTC",
  prompt: "Update the dependencies.",
  skipIfUnchanged: true,
  enabled: true,
  enabledAt: "2026-10-29T10:00:00.000Z",
  createdBy: "person:ada",
  createdAt: "2026-10-29T10:00:00.000Z",
  nextTickAt: "2026-10-30T03:00:00.000Z",
  ...extra,
});

const started: AutomationTick = {
  automationId: id,
  tickAt: "2026-10-29T03:00:00.000Z",
  trigger: "schedule",
  status: "started",
  reason: "filed card tsk_… and started run ses_… in intake, on main at abc",
  baseRef: "main",
  baseCommit: "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4",
  taskId: TaskId.make("tsk_01m62enc5jvr7hxtm9yfpgzb48"),
  sessionId: SessionId.make("ses_01m62enc5st6fyxwxqaren9jkd"),
  run: {
    status: "idle",
    costTotal: 0.0123,
    lastActivityAt: "2026-10-29T03:01:00.000Z",
  },
  claimedAt: "2026-10-29T03:00:04.000Z",
  finishedAt: "2026-10-29T03:00:05.000Z",
};

const skipped: AutomationTick = {
  automationId: id,
  tickAt: "2026-10-30T03:00:00.000Z",
  trigger: "schedule",
  status: "skipped",
  reason: "no new commits on main since the run at 2026-10-29T03:00:00.000Z",
  baseRef: "main",
  baseCommit: "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4",
  claimedAt: "2026-10-30T03:00:04.000Z",
};

describe("factory automation's lines", () => {
  it("lists id, name, repo, schedule, state, next and last, tab-separated", () => {
    const lines = automationLsLines([
      automation({ lastTick: started }),
      automation({
        cron: undefined,
        runAt: "2026-11-02T09:00:00.000Z",
        enabled: false,
        nextTickAt: undefined,
      }),
    ]);
    expect(lines[0]).toBe(AUTOMATION_LS_HEADER);
    expect(lines[1]?.split("\t")).toEqual([
      id,
      "nightly deps",
      "acme/widgets",
      'cron "0 3 * * *" UTC',
      "enabled",
      "2026-10-30T03:00:00.000Z",
      "started 2026-10-29T03:00:00.000Z",
    ]);
    expect(lines[2]?.split("\t").slice(3)).toEqual([
      "once 2026-11-02T09:00:00.000Z",
      "paused",
      NONE,
      NONE,
    ]);
    expect(automationLsLines([])).toEqual(["no automations"]);
  });

  it("says whether a tick on an unmoved base is skipped", () => {
    expect(automationLines("added", automation())).toContain(
      "skip         a tick on a base that has not moved since the last run",
    );
    expect(
      automationLines("added", automation({ skipIfUnchanged: false })),
    ).toContain("skip         never");
  });

  it("prints a tick's card, run and reason, and the history's run status and spend", () => {
    const lines = tickLines(started);
    expect(lines).toContain("card         tsk_01m62enc5jvr7hxtm9yfpgzb48");
    expect(lines).toContain("run          ses_01m62enc5st6fyxwxqaren9jkd");
    expect(lines).toContain(`reason       ${started.reason}`);
    const history = historyLines([skipped, started]);
    expect(history[0]).toBe(AUTOMATION_HISTORY_HEADER);
    expect(history[1]?.split("\t")).toEqual([
      skipped.tickAt,
      "schedule",
      "skipped",
      NONE,
      NONE,
      NONE,
      NONE,
      skipped.reason,
    ]);
    expect(history[2]?.split("\t").slice(2, 7)).toEqual([
      "started",
      "tsk_01m62enc5jvr7hxtm9yfpgzb48",
      "ses_01m62enc5st6fyxwxqaren9jkd",
      "idle",
      "$0.0123",
    ]);
    expect(historyLines([])).toEqual(["no ticks yet"]);
  });
});
