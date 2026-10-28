/**
 * The queued line `factory watch` prints (LOB-166). It is the only place a terminal user learns the
 * submission id `factory withdraw` takes, so the id is part of the line's contract.
 */
import type { TranscriptEntry } from "@repo/domain/Session";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  formatDollars,
  formatEarlier,
  formatEntry,
  formatQueued,
  readEarlier,
} from "./transcript";

describe("formatQueued", () => {
  it("names the queue and the submission id, then the text", () => {
    expect(formatQueued({ id: "12", mode: "steer", content: "steer me" })).toBe(
      "[queued:steer:12] steer me",
    );
  });

  it("prints structured content as JSON and absent content as nothing", () => {
    expect(
      formatQueued({
        id: "3",
        mode: "followUp",
        content: [{ type: "text", text: "hi" }],
      }),
    ).toBe('[queued:followUp:3] [{"type":"text","text":"hi"}]');
    expect(formatQueued({ id: "4", mode: "write" })).toBe("[queued:write:4]");
  });
});

describe("a budget stop in a terminal (LOB-163)", () => {
  it("prints the stop entry under its own kind, verbatim", () => {
    const text =
      "budget reached: the session has spent $0.0100 of its $0.0100 cap, so the run was stopped before its next model request";
    expect(formatEntry({ id: "9", kind: "budget", text, toolCalls: [] })).toBe(
      `[budget] ${text}`,
    );
  });

  it("prints dollars to the hundredth of a cent", () => {
    expect(formatDollars(0.01)).toBe("$0.0100");
    expect(formatDollars(2)).toBe("$2.0000");
  });
});

describe("an inherited PR line in a terminal (LOB-211)", () => {
  it("prints under its own kind, not as `other`", () => {
    const text =
      "a session this one was forked from opened https://github.com/o/r/pull/9";
    expect(
      formatEntry({ id: "7", kind: "inherited", text, toolCalls: [] }),
    ).toBe(`[inherited] ${text}`);
  });
});

describe("a long historical transcript in a terminal (LOB-243)", () => {
  it("says the entries printed are not the first, and from where", () => {
    expect(formatEarlier("301")).toBe(
      "[earlier] entries before 301 are not shown",
    );
  });
});

describe("reading earlier history from a terminal (LOB-243)", () => {
  const entry = (id: number): TranscriptEntry => ({
    id: String(id),
    kind: "user",
    text: `message ${id}`,
    toolCalls: [],
  });
  /** A transcript of entries 1..10 served in pages of 3, as `readSessionHistory` serves them. */
  const pages = (asked: string[]) => (before: string) =>
    Effect.sync(() => {
      asked.push(before);
      const end = Number(before) - 1;
      const start = Math.max(1, end - 2);
      const entries = Array.from({ length: end - start + 1 }, (_, n) =>
        entry(start + n),
      );
      return start > 1 ? { entries, earlier: String(start) } : { entries };
    });

  it("names the command that prints them when it knows the session", () => {
    expect(formatEarlier("301", "ses_1")).toBe(
      "[earlier] entries before 301 are not shown; factory history ses_1 --before 301 prints them",
    );
  });

  it("reads one page, oldest first, and says where the next one starts", async () => {
    const asked: string[] = [];
    const page = await Effect.runPromise(
      readEarlier(pages(asked), "11", { all: false }),
    );
    expect(page.entries.map((e) => e.id)).toEqual(["8", "9", "10"]);
    expect(page.earlier).toBe("8");
    expect(asked).toEqual(["11"]);
  });

  it("pages back to the first entry with all, every entry once and in order", async () => {
    const asked: string[] = [];
    const page = await Effect.runPromise(
      readEarlier(pages(asked), "11", { all: true }),
    );
    expect(page.entries.map((e) => e.id)).toEqual(
      Array.from({ length: 10 }, (_, n) => String(n + 1)),
    );
    expect(page.earlier).toBeUndefined();
    expect(asked).toEqual(["11", "8", "5", "2"]);
  });
});
