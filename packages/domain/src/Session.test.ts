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
