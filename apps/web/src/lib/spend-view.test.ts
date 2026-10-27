/**
 * The spend pane's roll-ups and wording (LOB-162). Which sessions cost what is the server's answer
 * (`SessionService.spend`, proven against Postgres in `packages/core`); the browser drive proves the
 * rendered page. These are the cases a drive does not reach cheaply: an actor that appears on two
 * repos, the absent repo and actor, ties, and a zero.
 */
import type { SpendReport, SpendRow } from "@repo/domain/Session";
import { RepoSlug } from "@repo/domain/Session";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  actorLabel,
  formatSpendDollars,
  pairKey,
  repoLabel,
  sessionCount,
  spendByActor,
  spendByRepo,
} from "./spend-view";

const repo = Schema.decodeSync(RepoSlug);
const WEB = repo("acme/web");
const API = repo("acme/api");

const report = (rows: ReadonlyArray<SpendRow>): SpendReport => ({
  rows,
  sessions: rows.reduce((total, row) => total + row.sessions, 0),
  costTotal: rows.reduce((total, row) => total + row.costTotal, 0),
});

const rows: ReadonlyArray<SpendRow> = [
  { repo: WEB, actor: "cli", sessions: 2, costTotal: 0.04 },
  { repo: API, actor: "cli", sessions: 1, costTotal: 0.02 },
  { repo: WEB, actor: "dashboard", sessions: 1, costTotal: 0.01 },
  { actor: "trigger:linear", sessions: 1, costTotal: 0.005 },
  { repo: API, sessions: 3, costTotal: 0 },
];

describe("spend by repo", () => {
  it("adds every actor's pairs on a repo, costliest first, scratch named", () => {
    expect(spendByRepo(report(rows))).toEqual([
      { key: WEB, label: "acme/web", sessions: 3, costTotal: 0.05 },
      { key: API, label: "acme/api", sessions: 4, costTotal: 0.02 },
      { key: undefined, label: "scratch", sessions: 1, costTotal: 0.005 },
    ]);
  });

  it("is empty for an empty report", () => {
    expect(spendByRepo(report([]))).toEqual([]);
  });
});

describe("spend by actor", () => {
  it("adds one actor's spend across repos, and names nobody as unattributed", () => {
    const lines = spendByActor(report(rows));
    expect(lines.map((line) => [line.label, line.sessions])).toEqual([
      ["cli", 3],
      ["dashboard", 1],
      ["trigger:linear", 1],
      ["unattributed", 3],
    ]);
    expect(lines[0]?.costTotal).toBeCloseTo(0.06, 10);
  });

  it("breaks a tie by name, with the absent actor last", () => {
    const tied = spendByActor(
      report([
        { repo: WEB, sessions: 1, costTotal: 0.01 },
        { repo: WEB, actor: "zed", sessions: 1, costTotal: 0.01 },
        { repo: WEB, actor: "amy", sessions: 1, costTotal: 0.01 },
      ]),
    );
    expect(tied.map((line) => line.label)).toEqual([
      "amy",
      "zed",
      "unattributed",
    ]);
  });

  it("keeps an actor named `unattributed` apart from the absent one", () => {
    const lines = spendByActor(
      report([
        { repo: WEB, actor: "unattributed", sessions: 1, costTotal: 0.02 },
        { repo: WEB, sessions: 1, costTotal: 0.01 },
      ]),
    );
    expect(lines.map((line) => line.key)).toEqual(["unattributed", undefined]);
    expect(
      pairKey({ repo: WEB, actor: "unattributed", sessions: 1, costTotal: 0 }),
    ).not.toBe(pairKey({ repo: WEB, sessions: 1, costTotal: 0 }));
  });
});

describe("the pane's words", () => {
  it("labels the absent repo and actor", () => {
    expect(repoLabel(undefined)).toBe("scratch");
    expect(repoLabel(WEB)).toBe("acme/web");
    expect(actorLabel(undefined)).toBe("unattributed");
    expect(actorLabel("cli")).toBe("cli");
  });

  it("prints dollars to four places, and a zero as no cost reported", () => {
    expect(formatSpendDollars(0.03)).toBe("$0.0300");
    expect(formatSpendDollars(12.5)).toBe("$12.5000");
    expect(formatSpendDollars(0.00004)).toBe("<$0.0001");
    expect(formatSpendDollars(0)).toBe("no cost reported");
  });

  it("counts sessions", () => {
    expect(sessionCount(1)).toBe("1 session");
    expect(sessionCount(3)).toBe("3 sessions");
  });
});
