/**
 * The card pane's state controls' wording and send rules (C11). Whether a block, unblock or edit
 * lands, and the stale revision the server refuses, are proven against Postgres in
 * `packages/core/src/TaskService.test.ts` and in a browser by `.pi/skills/verify-web/card-edit.sh`.
 * These are the cases one drive cannot reach.
 */
import { MAX_TASK_TITLE_CHARS } from "@repo/domain/Task";
import { describe, expect, it } from "vitest";
import {
  BLOCK_REASONS,
  blockNote,
  cardEditRefusal,
  otherPriority,
  titleDraft,
} from "./card-edit-view";
import { refusalIsCurrent } from "./board-view";

describe("BLOCK_REASONS", () => {
  it("offers the reasons a person declares, and not a run's question or a failed setup", () => {
    expect(BLOCK_REASONS.map((r) => r.reason)).toEqual([
      "dependency",
      "capability",
      "transient",
    ]);
  });
});

describe("blockNote", () => {
  it("trims a note, and sends none for a blank one", () => {
    expect(blockNote("  waiting on the schema PR \n")).toBe(
      "waiting on the schema PR",
    );
    expect(blockNote(" \n\t")).toBeUndefined();
    expect(blockNote("")).toBeUndefined();
  });
});

describe("titleDraft", () => {
  const card = { title: "typo in titel" };

  it("saves a changed title trimmed", () => {
    expect(titleDraft("  typo in title ", card)).toEqual({
      ok: true,
      title: "typo in title",
    });
  });

  it("says why a blank, over-long or unchanged title is not sent", () => {
    expect(titleDraft("   ", card)).toMatchObject({ ok: false });
    expect(titleDraft("x".repeat(MAX_TASK_TITLE_CHARS), card).ok).toBe(true);
    expect(titleDraft("x".repeat(MAX_TASK_TITLE_CHARS + 1), card)).toEqual({
      ok: false,
      reason: `A title is at most ${MAX_TASK_TITLE_CHARS} characters; this one is ${MAX_TASK_TITLE_CHARS + 1}`,
    });
    expect(titleDraft(" typo in titel ", card)).toEqual({
      ok: false,
      reason: "That is the card's title already",
    });
  });
});

describe("otherPriority", () => {
  it("flips urgent and normal", () => {
    expect(otherPriority("normal")).toBe("urgent");
    expect(otherPriority("urgent")).toBe("normal");
  });
});

describe("cardEditRefusal", () => {
  it("words the typed refusals with the server's own message", () => {
    expect(
      cardEditRefusal(
        {
          _tag: "AlreadyBlocked",
          message: "task tsk_1 is already blocked (dependency)",
        },
        "x",
        3,
      ),
    ).toEqual({
      tag: "AlreadyBlocked",
      title: "This card is already blocked",
      message: "task tsk_1 is already blocked (dependency)",
      atRevision: 3,
    });
  });

  it("dates a stale refusal at the revision the server found, so it goes once the card is read again", () => {
    const refused = cardEditRefusal(
      {
        _tag: "StaleRevision",
        message: "task tsk_1 is at revision 5, not 3",
        actual: 5,
      },
      "x",
      3,
    );
    expect(refused.title).toBe("Someone changed this card first");
    expect(refused.atRevision).toBe(5);
    expect(refusalIsCurrent(refused, { revision: 5 })).toBe(true);
    expect(refusalIsCurrent(refused, { revision: 6 })).toBe(false);
  });

  it("keeps an untyped failure's text rather than dressing it as a refusal", () => {
    expect(cardEditRefusal(undefined, "socket closed", 3)).toEqual({
      tag: "Unknown",
      title: "The change did not go through",
      message: "socket closed",
      atRevision: 3,
    });
  });
});
