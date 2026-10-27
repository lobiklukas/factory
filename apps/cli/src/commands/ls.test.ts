/**
 * `factory ls`'s row (LOB-65): the PR link once a session has one, and a placeholder that is still
 * a column when it has none.
 *
 * The command itself is proven by `.pi/skills/verify-cli`, which runs it in a terminal against a
 * real control plane and a session whose log recorded a PR. These cases are the ones a pane capture
 * would not localize: which field the link lands in, and that a session with no PR keeps every
 * column after it where a script expects it.
 */
import { Schema } from "effect";
import { SessionListEntry } from "@repo/domain/Session";
import { describe, expect, it } from "vitest";
import { LS_HEADER, NO_PR, lsRow } from "./ls";

const PR_URL = "https://github.com/lobiklukas/factory/pull/7";

const entry = (
  extra: Partial<typeof SessionListEntry.Encoded> = {},
): SessionListEntry =>
  Schema.decodeSync(SessionListEntry)({
    id: "ses_01m5yvfya2tsyn56ycr5jj3pvs",
    title: "fix the flaky test",
    repo: "lobiklukas/factory",
    status: "idle",
    createdAt: "2026-10-27T10:00:00.000Z",
    lastActivityAt: "2026-10-27T10:05:00.000Z",
    costTotal: 0.25,
    ...extra,
  });

/** The fields before the title, which are one token each: what a script splitting the line reads. */
const fields = (row: string): readonly string[] => row.split(/\s+/);

describe("lsRow", () => {
  it("prints the session's PR link in the pr column", () => {
    const row = lsRow(entry({ prUrl: PR_URL }));
    const header = fields(LS_HEADER);
    expect(fields(row)[header.indexOf("pr")]).toBe(PR_URL);
  });

  it("prints an explicit placeholder, not an empty cell, for a session with no PR", () => {
    const row = lsRow(entry());
    const header = fields(LS_HEADER);
    expect(NO_PR).not.toBe("");
    expect(fields(row)[header.indexOf("pr")]).toBe(NO_PR);
    // No empty cell: two adjacent separators would make the title the sixth field.
    expect(row).not.toContain("    ");
  });

  it("keeps the title last, after the pr column, so a title with spaces cannot shift it", () => {
    const withPr = lsRow(entry({ prUrl: PR_URL }));
    const withoutPr = lsRow(entry());
    const header = fields(LS_HEADER);
    expect(header.at(-1)).toBe("title");
    expect(withPr.endsWith("  fix the flaky test")).toBe(true);
    expect(withoutPr.endsWith("  fix the flaky test")).toBe(true);
    // Every column before the title is present on both rows, with or without a PR.
    const before = [
      "ses_01m5yvfya2tsyn56ycr5jj3pvs",
      "idle",
      "lobiklukas/factory",
      "2026-10-27T10:05:00.000Z",
      "0.25",
    ];
    expect(fields(withPr).slice(0, header.length - 1)).toEqual([
      ...before,
      PR_URL,
    ]);
    expect(fields(withoutPr).slice(0, header.length - 1)).toEqual([
      ...before,
      NO_PR,
    ]);
  });
});
