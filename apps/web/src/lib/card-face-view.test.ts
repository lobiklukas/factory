/**
 * A card face's wording (C10). The browser drive in `.pi/skills/verify-web` proves the rendered row
 * against a seeded board; these are the cases a seeded board cannot reach — no run, no PR, a PR URL
 * that must not become an `href`, and a cost too small or too absent to print as a number.
 */
import { Schema } from "effect";
import { RepoSlug, type RepoSummary } from "@repo/domain/Session";
import { BoardCard } from "@repo/domain/Task";
import { describe, expect, it } from "vitest";
import { cardFace, cardReadiness, faceIsBlank } from "./card-face-view";

const card = (extra: Record<string, unknown> = {}): BoardCard =>
  Schema.decodeUnknownSync(BoardCard)({
    task: {
      id: `tsk_${"0".repeat(26)}`,
      boardId: `brd_${"0".repeat(26)}`,
      title: "a card",
      column: "building",
      priority: "normal",
      revision: 1,
      definitionVersion: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      createdBy: "person:lukas",
    },
    runCount: 0,
    costTotal: 0,
    ...extra,
  });

const run = (status: "busy" | "idle") => ({
  sessionId: `ses_${"0".repeat(10)}${"a".repeat(16)}`,
  status,
  startedAt: "2026-01-01T00:00:00.000Z",
});

describe("cardFace", () => {
  it("says nothing for a card no run was started against", () => {
    const face = cardFace(card());
    expect(face).toEqual({
      status: null,
      pr: null,
      cost: null,
      runs: 0,
      readiness: null,
    });
    expect(faceIsBlank(face)).toBe(true);
    expect(faceIsBlank(cardFace(undefined))).toBe(true);
  });

  it("shows a busy run as busy and an idle one as idle", () => {
    expect(cardFace(card({ runCount: 1, run: run("busy") })).status).toBe(
      "busy",
    );
    expect(cardFace(card({ runCount: 1, run: run("idle") })).status).toBe(
      "idle",
    );
  });

  it("links the PR the way the session pane does, and refuses a URL that is not a web link", () => {
    const pr = "https://github.com/acme/widgets/pull/7";
    expect(
      cardFace(card({ runCount: 1, run: run("idle"), prUrl: pr })).pr,
    ).toEqual({ href: pr, label: "PR #7" });
    expect(
      cardFace(
        card({ runCount: 1, run: run("idle"), prUrl: "javascript:alert(1)" }),
      ).pr,
    ).toBeNull();
  });

  it("words the summed spend as /spend does, naming a cost that was not reported", () => {
    expect(cardFace(card({ runCount: 2, costTotal: 1.625 })).cost).toBe(
      "$1.6250",
    );
    expect(cardFace(card({ runCount: 1, costTotal: 0 })).cost).toBe(
      "no cost reported",
    );
    expect(cardFace(card({ runCount: 1, costTotal: 0.00001 })).cost).toBe(
      "<$0.0001",
    );
    expect(faceIsBlank(cardFace(card({ runCount: 1, costTotal: 0 })))).toBe(
      false,
    );
  });
});

const repoRow = (over: Partial<RepoSummary> = {}): RepoSummary => ({
  repo: Schema.decodeSync(RepoSlug)("acme/widgets"),
  url: "",
  defaultBaseRef: "main",
  registeredAt: "2026-10-28T00:00:00.000Z",
  localPathIsGit: true,
  hasFactoryConfig: false,
  ...over,
});

const scored = (passed: ReadonlyArray<boolean>): RepoSummary =>
  repoRow({
    readiness: {
      score: passed.filter(Boolean).length,
      max: passed.length,
      checks: passed.map((ok, index) => ({
        name: `check-${index}`,
        passed: ok,
        reason: ok ? `check ${index} passes` : `check ${index} fails`,
      })),
    },
  });

/**
 * The readiness on a card face (F25): the board's repository's score, the Repositories page's own
 * wording, and no score at all (never a zero) for a repo with nothing to score.
 */
describe("a card face's readiness", () => {
  /** Mutation: word a missing score as `0/0`, or drop the failing checks from the title. */
  it("shows the score, with the failing checks in its title", () => {
    expect(cardReadiness(scored([true, false, true, false]))).toEqual({
      score: "2/4",
      ready: false,
      title: "Agent-readiness 2/4. Missing: check 1 fails; check 3 fails",
    });
    expect(cardReadiness(scored([true, true]))).toEqual({
      score: "2/2",
      ready: true,
      title: "Agent-readiness 2/2: every check passes",
    });
  });

  it("is absent for a repo with no checkout to score, and while the repo is unread", () => {
    expect(cardReadiness(repoRow({ localPathIsGit: false }))).toBeNull();
    expect(cardReadiness(undefined)).toBeNull();
    expect(cardFace(card({ runCount: 1 }), repoRow()).readiness).toBeNull();
    expect(cardFace(card()).readiness).toBeNull();
  });

  /** Mutation: let the repo's score stand in for the run row, drawing one under every bare card. */
  it("is on every card of the board, run or none, and does not make a bare card's run row appear", () => {
    const repo = scored([true, false]);
    for (const entry of [
      card(),
      card({ runCount: 1, costTotal: 0.5 }),
      undefined,
    ]) {
      expect(cardFace(entry, repo).readiness?.score).toBe("1/2");
    }
    expect(faceIsBlank(cardFace(card(), repo))).toBe(true);
    expect(faceIsBlank(cardFace(undefined, repo))).toBe(true);
  });
});
