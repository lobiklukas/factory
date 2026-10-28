/**
 * `factory spend`'s table and its filters (C15). The command runs against a real control plane in
 * `.pi/skills/verify-cli/session.sh`; these cases pin the arithmetic a filter does, because a total
 * that ignored the filter would print the server's number under a narrower table.
 */
import type { SpendReport } from "@repo/domain/Session";
import { RepoSlug } from "@repo/domain/Session";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { SPEND_HEADER, filterSpend, spendLines, spendRow } from "./spend";

const slug = Schema.decodeSync(RepoSlug);

const report: SpendReport = {
  rows: [
    { repo: slug("acme/web"), actor: "alice", sessions: 3, costTotal: 0.3 },
    { repo: slug("acme/web"), actor: "bob", sessions: 1, costTotal: 0.1 },
    { repo: slug("acme/api"), actor: "alice", sessions: 2, costTotal: 0.05 },
    { sessions: 4, costTotal: 0 },
  ],
  sessions: 10,
  costTotal: 0.45,
};

describe("spendRow", () => {
  it("prints repo, actor, sessions and the dollars, with - for an absent repo or actor", () => {
    expect(
      spendRow({
        repo: slug("acme/web"),
        actor: "alice",
        sessions: 3,
        costTotal: 0.3,
      }),
    ).toBe("acme/web  alice  3  $0.3000");
    expect(spendRow({ sessions: 4, costTotal: 0 })).toBe("-  -  4  $0.0000");
  });
});

describe("filterSpend", () => {
  it("is the server's report untouched when nothing is filtered", () => {
    expect(filterSpend(report, {})).toBe(report);
  });

  it("keeps one repo's rows and adds up only those", () => {
    const filtered = filterSpend(report, { repo: slug("acme/web") });
    expect(filtered.rows.map((row) => row.actor)).toEqual(["alice", "bob"]);
    expect(filtered.sessions).toBe(4);
    expect(filtered.costTotal).toBeCloseTo(0.4);
  });

  it("keeps one actor's rows across repos", () => {
    const filtered = filterSpend(report, { actor: "alice" });
    expect(filtered.rows.map((row) => row.repo)).toEqual([
      "acme/web",
      "acme/api",
    ]);
    expect(filtered.sessions).toBe(5);
  });

  it("requires both filters to match when both are given", () => {
    const filtered = filterSpend(report, { repo: "acme/web", actor: "bob" });
    expect(filtered.rows).toHaveLength(1);
    expect(filtered.costTotal).toBeCloseTo(0.1);
  });

  it("is an empty table with zero totals when nothing matches", () => {
    expect(filterSpend(report, { repo: "acme/none" })).toEqual({
      rows: [],
      sessions: 0,
      costTotal: 0,
    });
  });
});

describe("spendLines", () => {
  it("is the header, a row per pair, and the totals", () => {
    expect(spendLines(report)).toEqual([
      SPEND_HEADER,
      "acme/web  alice  3  $0.3000",
      "acme/web  bob  1  $0.1000",
      "acme/api  alice  2  $0.0500",
      "-  -  4  $0.0000",
      "total  10 sessions  $0.4500",
    ]);
  });

  it("says one session in the singular", () => {
    expect(spendLines({ rows: [], sessions: 1, costTotal: 0.01 }).at(-1)).toBe(
      "total  1 session  $0.0100",
    );
  });
});
