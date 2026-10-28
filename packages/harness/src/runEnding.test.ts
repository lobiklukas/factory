/**
 * How a log's newest run ended (C18, `runEndingOf`): what a settled run's PR step reads to tell a run
 * that finished from one an operator interrupted, its budget stopped, or whose model answer failed.
 *
 * Offline and database-free: a pure function over entries, newest first, as storage scans them. The
 * real interrupt reaching it is `packages/core/src/SessionService.prOnSettle.test.ts`.
 */
import type { EntryRecord } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import {
  BUDGET_STOPPED_ENTRY_KIND,
  INTERRUPTED_ENTRY_KIND,
  NO_CHANGE_ENTRY_KIND,
  runEndingOf,
} from "./projection";

let nextId = 1;

/** An entry of `kind`; an assistant one carries a message with `stopReason`. */
const entry = (kind: string, stopReason?: string): EntryRecord =>
  ({
    id: nextId++,
    kind,
    ...(stopReason === undefined
      ? {}
      : {
          model: [
            {
              role: "assistant",
              content: [],
              stopReason,
            },
          ],
        }),
  }) as unknown as EntryRecord;

/** Oldest first, as a reader thinks of a transcript; reversed into the scan's order. */
const ending = (...oldestFirst: EntryRecord[]) =>
  runEndingOf([...oldestFirst].reverse());

describe("runEndingOf", () => {
  it("is finished for a run whose last answer stopped on its own", () => {
    expect(
      ending(
        entry("pi.user"),
        entry("pi.assistant", "toolUse"),
        entry("pi.tool-result"),
        entry("pi.assistant", "stop"),
      ),
    ).toBe("finished");
  });

  it("is interrupted when the operator's marker follows the run's input, whatever came after it", () => {
    expect(
      ending(
        entry("pi.user"),
        entry("pi.assistant", "toolUse"),
        entry(INTERRUPTED_ENTRY_KIND),
        entry("pi.tool-result"),
        entry("pi.assistant", "aborted"),
      ),
    ).toBe("interrupted");
  });

  it("is budget when the cap's stop follows the run's input", () => {
    expect(
      ending(
        entry("pi.user"),
        entry("pi.assistant", "toolUse"),
        entry("pi.tool-result"),
        entry(BUDGET_STOPPED_ENTRY_KIND),
      ),
    ).toBe("budget");
  });

  it("is failed when the newest model answer is an error or an abort", () => {
    expect(ending(entry("pi.user"), entry("pi.assistant", "error"))).toBe(
      "failed",
    );
    expect(ending(entry("pi.user"), entry("pi.assistant", "aborted"))).toBe(
      "failed",
    );
  });

  it("reads only the newest run: an earlier run's stop, and the PR step's own lines, say nothing", () => {
    expect(
      ending(
        entry("pi.user"),
        entry(INTERRUPTED_ENTRY_KIND),
        entry("pi.assistant", "aborted"),
        entry("pi.user"),
        entry("pi.assistant", "stop"),
        entry(NO_CHANGE_ENTRY_KIND),
      ),
    ).toBe("finished");
  });

  it("is finished for a log with no run to have stopped", () => {
    expect(ending()).toBe("finished");
  });
});
