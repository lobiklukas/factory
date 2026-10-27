/**
 * The budget a create may name (LOB-163): a positive, finite number of dollars, or nothing.
 *
 * The refusal is the contract's, not the service's, so a CLI, the dashboard and a trigger all get the
 * same answer for a cap that cannot be one — before a session exists to be capped by it.
 */
import { Exit, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { CreateSessionInput, SessionSnapshot } from "./Session";

const decodeCreate = Schema.decodeUnknownExit(CreateSessionInput);

describe("a create's budget", () => {
  it("accepts a positive amount, and no amount at all", () => {
    expect(Exit.isSuccess(decodeCreate({ budget: 0.25 }))).toBe(true);
    expect(Exit.isSuccess(decodeCreate({}))).toBe(true);
  });

  it.each([
    ["zero", 0],
    ["a negative amount", -1],
    ["infinity", Number.POSITIVE_INFINITY],
    ["not a number", Number.NaN],
    ["a string", "1"],
  ])("refuses %s", (_label, budget) => {
    expect(Exit.isFailure(decodeCreate({ budget }))).toBe(true);
  });
});

describe("a create's actor (LOB-162)", () => {
  it("accepts a name, a trigger's namespaced source, and no actor at all", () => {
    expect(Exit.isSuccess(decodeCreate({ actor: "cli" }))).toBe(true);
    expect(Exit.isSuccess(decodeCreate({ actor: "trigger:linear" }))).toBe(
      true,
    );
    expect(Exit.isSuccess(decodeCreate({ actor: "Ada Lovelace" }))).toBe(true);
    expect(Exit.isSuccess(decodeCreate({ actor: "x".repeat(200) }))).toBe(true);
    expect(Exit.isSuccess(decodeCreate({}))).toBe(true);
  });

  // Two spellings of one actor would be two rows in the spend pane, and a blank one a row nobody
  // can read: the contract refuses both before a session exists to be attributed.
  it.each([
    ["an empty name", ""],
    ["only whitespace", "   "],
    ["a leading space", " cli"],
    ["a trailing newline", "cli\n"],
    ["an embedded newline", "a\nb"],
    ["an embedded tab", "a\tb"],
    ["an embedded NUL", "a\u0000b"],
    ["a lone control character", "\u0007"],
    ["a name over 200 characters", "x".repeat(201)],
    ["a number", 7],
  ])("refuses %s", (_label, actor) => {
    expect(Exit.isFailure(decodeCreate({ actor }))).toBe(true);
  });
});

describe("a snapshot's budget", () => {
  const base = {
    session: {
      id: `ses_${"0".repeat(26)}`,
      title: "",
      status: "idle",
      mode: "live",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    workspace: { path: "/w", commands: {}, commandsSource: "none" },
    entries: [],
    live: { busy: false, tools: [] },
    usage: { models: [], tools: [] },
    queued: [],
    tasks: [],
    approvals: [],
  };

  it("crosses the wire with its stop, and is optional", () => {
    const budget = {
      cap: 0.01,
      spent: 0.01,
      stopped: { at: "2026-01-01T00:00:01.000Z", spent: 0.01, cap: 0.01 },
    };
    const decoded = Schema.decodeUnknownSync(SessionSnapshot)({
      ...base,
      budget,
    });
    expect(decoded.budget).toEqual(budget);
    expect(
      Schema.decodeUnknownSync(SessionSnapshot)(base).budget,
    ).toBeUndefined();
  });
});

describe("a snapshot's replay comparisons", () => {
  const base = {
    session: {
      id: `ses_${"0".repeat(26)}`,
      title: "",
      status: "idle",
      mode: "historical",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    workspace: { path: "/w", commands: {}, commandsSource: "none" },
    entries: [],
    live: { busy: false, tools: [] },
    usage: { models: [], tools: [] },
    queued: [],
    tasks: [],
    approvals: [],
  };
  const run = (id: string, turns: number) => ({
    session: `ses_${id.repeat(26)}`,
    model: "faux/faux-1",
    outcome: "answered",
    turns,
    cost: 0,
  });

  it("crosses the wire on a session that has one, and is absent on one that has none", () => {
    const comparison = {
      role: "source",
      at: "2026-01-01T00:00:01.000Z",
      self: run("0", 3),
      counterpart: {
        ...run("1", 1),
        outcome: "unanswered",
        reason: "aborted",
      },
      delta: { turns: 2, cost: 0 },
    };
    const decoded = Schema.decodeUnknownSync(SessionSnapshot)({
      ...base,
      replayComparisons: [comparison],
    });
    expect(decoded.replayComparisons).toEqual([comparison]);
    expect(
      Schema.decodeUnknownSync(SessionSnapshot)(base).replayComparisons,
    ).toBeUndefined();
  });

  it("refuses a side that is not a session, or an outcome it does not name", () => {
    const decode = Schema.decodeUnknownExit(SessionSnapshot);
    const comparison = {
      role: "replay",
      at: "2026-01-01T00:00:01.000Z",
      self: run("0", 1),
      counterpart: run("1", 3),
      delta: { turns: -2, cost: 0 },
    };
    expect(
      Exit.isSuccess(decode({ ...base, replayComparisons: [comparison] })),
    ).toBe(true);
    expect(
      Exit.isFailure(
        decode({
          ...base,
          replayComparisons: [
            { ...comparison, counterpart: { ...run("1", 3), session: "x" } },
          ],
        }),
      ),
    ).toBe(true);
    expect(
      Exit.isFailure(
        decode({
          ...base,
          replayComparisons: [
            { ...comparison, self: { ...run("0", 1), outcome: "won" } },
          ],
        }),
      ),
    ).toBe(true);
  });
});
