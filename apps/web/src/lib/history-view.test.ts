import type { TranscriptEntry } from "@repo/domain/Session";
import { describe, expect, it } from "vitest";
import {
  currentHistory,
  nextBefore,
  withEarlierPage,
  type EarlierHistory,
} from "./history-view";

const entry = (id: string): TranscriptEntry => ({
  id,
  kind: "user",
  text: `message ${id}`,
  toolCalls: [],
});

describe("earlier history (LOB-243)", () => {
  it("reads first before the view's oldest entry, then before each page's", () => {
    expect(nextBefore(null, "41")).toBe("41");
    const first = withEarlierPage(null, "ses_a", "41", {
      entries: [entry("21"), entry("40")],
      earlier: "21",
    });
    expect(nextBefore(first, "41")).toBe("21");
    const second = withEarlierPage(first, "ses_a", "41", {
      entries: [entry("1"), entry("20")],
    });
    // Oldest first, the new page on top, and nothing left to read once the first entry is in.
    expect(second.entries.map((e) => e.id)).toEqual(["1", "20", "21", "40"]);
    expect(nextBefore(second, "41")).toBeUndefined();
  });

  it("says there is nothing to read when the view starts the transcript", () => {
    expect(nextBefore(null, undefined)).toBeUndefined();
  });

  it("drops pages read under another snapshot or for another session", () => {
    const pages: EarlierHistory = withEarlierPage(null, "ses_a", "41", {
      entries: [entry("40")],
      earlier: "40",
    });
    expect(currentHistory(pages, "ses_a", "41")).toBe(pages);
    expect(currentHistory(pages, "ses_b", "41")).toBeNull();
    // A re-attach whose window starts elsewhere: the pages no longer sit right above it.
    expect(currentHistory(pages, "ses_a", "61")).toBeNull();
    // A live view carries the whole transcript; nothing loaded belongs above it.
    expect(currentHistory(pages, "ses_a", undefined)).toBeNull();
  });
});
