import type { TranscriptEntry } from "@repo/domain/Session";
import { describe, expect, it } from "vitest";
import { hasTranscriptRow, visibleEntries } from "./transcript-view";

const entry = (
  id: string,
  kind: TranscriptEntry["kind"],
  text = "",
): TranscriptEntry => ({ id, kind, text, toolCalls: [] });

describe("hasTranscriptRow", () => {
  it("gives the session title no row, however much text it carries", () => {
    expect(hasTranscriptRow(entry("1", "title", "Fix the login bug"))).toBe(
      false,
    );
  });

  it("gives a text-less system entry no row, and a system entry with text its marker", () => {
    expect(hasTranscriptRow(entry("1", "system"))).toBe(false);
    expect(hasTranscriptRow(entry("1", "system", "You are an agent"))).toBe(
      true,
    );
  });

  it("keeps a row for every entry that is something someone said or did", () => {
    for (const kind of [
      "user",
      "assistant",
      "toolResult",
      "reset",
      "compaction",
      "budget",
      "inherited",
      "other",
    ] as const)
      expect(hasTranscriptRow(entry("1", kind, ""))).toBe(true);
  });
});

describe("visibleEntries", () => {
  it("shows one user message once: the title and the system entry around it drop out", () => {
    const rows = visibleEntries([
      entry("1", "title", "Fix the login bug"),
      entry("2", "system"),
      entry("3", "user", "Fix the login bug"),
    ]);
    expect(rows.map((row) => row.entry.text)).toEqual(["Fix the login bug"]);
    expect(rows.map((row) => row.entry.kind)).toEqual(["user"]);
  });

  it("keeps each row's index in the full log", () => {
    const rows = visibleEntries([
      entry("1", "title", "t"),
      entry("2", "user", "a"),
      entry("3", "system"),
      entry("4", "assistant", "b"),
    ]);
    expect(rows.map((row) => row.index)).toEqual([1, 3]);
  });

  it("is empty for a log that holds only the title", () => {
    expect(visibleEntries([entry("1", "title", "Card title")])).toEqual([]);
  });
});
