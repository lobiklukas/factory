/**
 * The "Raise cap" action's decisions (C23): which stop it sits on, what it opens with, and which
 * caps it will send. The press against a real server is `.pi/skills/verify-board/budget.sh`.
 */
import type { TranscriptEntry } from "@repo/domain/Session";
import { describe, expect, it } from "vitest";
import { raiseCapAttempt, raiseCapOffer, suggestedCap } from "./budget-view";

const entry = (
  id: string,
  kind: TranscriptEntry["kind"],
  text = "x",
): TranscriptEntry => ({ id, kind, text, toolCalls: [] });

const none: ReadonlySet<string> = new Set();

describe("raiseCapOffer", () => {
  it("offers the stop that ends the transcript", () => {
    expect(
      raiseCapOffer(
        [entry("1", "user"), entry("2", "assistant"), entry("3", "budget")],
        none,
      ),
    ).toBe("3");
  });

  /** Mutation: offering on any budget entry, so a stop long past shows a button that does nothing useful. */
  it("offers nothing for a stop a later message has moved past", () => {
    expect(
      raiseCapOffer(
        [entry("1", "budget"), entry("2", "user"), entry("3", "assistant")],
        none,
      ),
    ).toBeUndefined();
  });

  it("offers the newest stop when a later run stopped again", () => {
    expect(
      raiseCapOffer(
        [entry("1", "budget"), entry("2", "user"), entry("3", "budget")],
        none,
      ),
    ).toBe("3");
  });

  it("looks past rows that have no row of their own", () => {
    expect(
      raiseCapOffer([entry("1", "budget"), entry("2", "system", "")], none),
    ).toBe("1");
  });

  it("offers nothing for a stop this pane has raised the cap for, until another stop", () => {
    const entries = [entry("1", "budget")];
    expect(raiseCapOffer(entries, new Set(["1"]))).toBeUndefined();
    expect(
      raiseCapOffer(
        [...entries, entry("2", "user"), entry("3", "budget")],
        new Set(["1"]),
      ),
    ).toBe("3");
  });

  it("offers nothing on an empty transcript or one that is not stopped", () => {
    expect(raiseCapOffer([], none)).toBeUndefined();
    expect(raiseCapOffer([entry("1", "assistant")], none)).toBeUndefined();
  });
});

describe("suggestedCap", () => {
  it("doubles the cap without floating-point noise, and is blank when the cap is unknown", () => {
    expect(suggestedCap(0.01)).toBe("0.02");
    expect(suggestedCap(0.1)).toBe("0.2");
    expect(suggestedCap(2.5)).toBe("5");
    expect(suggestedCap(undefined)).toBe("");
  });
});

describe("raiseCapAttempt", () => {
  it("sends a cap above the spend", () => {
    expect(raiseCapAttempt(" 2.5 ", 0.01)).toEqual({ ok: true, budget: 2.5 });
  });

  it("refuses what is not a positive amount", () => {
    for (const typed of ["", "0", "-1", "abc", "1e400"]) {
      expect(raiseCapAttempt(typed, 0).ok, typed).toBe(false);
    }
  });

  /** Mutation: `<` for `<=` would commit a cap the spend already reaches, and the run stops at once. */
  it("refuses a cap the spend already reaches", () => {
    const same = raiseCapAttempt("0.01", 0.01);
    expect(same.ok).toBe(false);
    expect(!same.ok && same.reason).toContain("already reached");
    expect(raiseCapAttempt("0.0101", 0.01).ok).toBe(true);
  });
});
