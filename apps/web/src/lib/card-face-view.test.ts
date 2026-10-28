/**
 * A card face's wording (C10). The browser drive in `.pi/skills/verify-web` proves the rendered row
 * against a seeded board; these are the cases a seeded board cannot reach — no run, no PR, a PR URL
 * that must not become an `href`, and a cost too small or too absent to print as a number.
 */
import { Schema } from "effect";
import { BoardCard } from "@repo/domain/Task";
import { describe, expect, it } from "vitest";
import { cardFace, faceIsBlank } from "./card-face-view";

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
    expect(face).toEqual({ status: null, pr: null, cost: null, runs: 0 });
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
