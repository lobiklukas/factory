/**
 * The card pane thread's wording and send rules (LOB-239). What a comment is — question, answer or
 * note — is the server's to decide (`TaskService.comment`, proven against Postgres in
 * `packages/core`), and the browser drive (`.pi/skills/verify-web/thread.sh`) proves the rendered
 * thread, the answer that lifts a block and the stale send. These are the cases one drive cannot
 * reach: a whitespace-only or over-long draft, a refusal that is not a typed one, a card blocked on
 * something no comment lifts.
 */
import { MAX_COMMENT_CHARS } from "@repo/domain/Task";
import type { BoardDefinition, Task, TaskBlocked } from "@repo/domain/Task";
import { BoardInstanceId, DefinitionId, TaskId } from "@repo/domain/Task";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  commentKindLabel,
  commentRefusal,
  commentTime,
  composerIntent,
  draftAfterSend,
  liftedBlock,
  nextRunOffer,
  sendable,
} from "./thread-view";
import { refusalIsCurrent } from "./board-view";

const AT = "2026-10-27T19:04:05.123Z";
const needsInput: TaskBlocked = {
  reason: "needs_input",
  column: "specifying",
  since: AT,
};
const dependency: TaskBlocked = {
  reason: "dependency",
  column: "planning",
  since: AT,
};

describe("commentKindLabel and commentTime", () => {
  it("heads each kind in words, and times it to the second", () => {
    expect(
      (["question", "answer", "note"] as const).map(commentKindLabel),
    ).toEqual(["Question", "Answer", "Note"]);
    expect(commentTime(AT)).toBe("2026-10-27 19:04:05");
  });
});

describe("composerIntent", () => {
  it("answers on a card blocked needs_input, naming the column it blocked from", () => {
    expect(composerIntent({ blocked: needsInput })).toEqual({
      answers: true,
      verb: "Answer",
      from: "specifying",
    });
  });

  it("is a note on an unblocked card, and on one blocked on something no comment lifts", () => {
    expect(composerIntent({})).toEqual({ answers: false, verb: "Comment" });
    expect(composerIntent({ blocked: dependency })).toEqual({
      answers: false,
      verb: "Comment",
    });
  });
});

describe("sendable", () => {
  it("refuses a draft with nothing in it, as the service does", () => {
    expect(sendable("")).toMatchObject({ ok: false });
    expect(sendable("  \n\t ")).toEqual({
      ok: false,
      reason: "A comment has to say something",
    });
  });

  it("refuses a draft past the schema's limit, and sends one at it", () => {
    expect(sendable("x".repeat(MAX_COMMENT_CHARS))).toEqual({ ok: true });
    const over = sendable("x".repeat(MAX_COMMENT_CHARS + 1));
    expect(over.ok).toBe(false);
    expect(over.ok ? "" : over.reason).toContain("16,001");
  });

  it("sends a body with leading whitespace as it is", () => {
    expect(sendable("  indented\n    more")).toEqual({ ok: true });
  });
});

describe("commentRefusal", () => {
  it("names a stale send and the revision the server holds, keeping the service's words", () => {
    const message = "task tsk_x is at revision 5, not 4: someone changed it";
    expect(
      commentRefusal({ _tag: "StaleRevision", message, actual: 5 }, "", 4),
    ).toEqual({
      tag: "StaleRevision",
      title: "The card changed while you wrote",
      message,
      atRevision: 5,
    });
  });

  it("does not let a stale refusal claim a revision older than the one sent", () => {
    expect(
      commentRefusal({ _tag: "StaleRevision", message: "m", actual: 2 }, "", 4)
        .atRevision,
    ).toBe(4);
    expect(
      commentRefusal({ _tag: "StaleRevision", message: "m" }, "", 4).atRevision,
    ).toBe(4);
  });

  it("heads the other typed refusals, and does not dress up one that is not", () => {
    expect(
      commentRefusal({ _tag: "EmptyComment", message: "empty" }, "", 1),
    ).toMatchObject({
      title: "A comment has to say something",
      message: "empty",
      atRevision: 1,
    });
    expect(commentRefusal(undefined, "connection refused", 3)).toEqual({
      tag: "Unknown",
      title: "The comment did not go through",
      message: "connection refused",
      atRevision: 3,
    });
    expect(
      commentRefusal({ _tag: "RpcClientError", message: "" }, "timed out", 3),
    ).toEqual({
      tag: "RpcClientError",
      title: "The comment did not go through",
      message: "timed out",
      atRevision: 3,
    });
  });
});

describe("liftedBlock", () => {
  it("is the block the send was made under, when the server's card no longer has it", () => {
    expect(liftedBlock({ blocked: needsInput }, {})).toEqual(needsInput);
  });

  it("is nothing for a note, or for a block the comment did not lift", () => {
    expect(liftedBlock({}, {})).toBeUndefined();
    expect(
      liftedBlock({ blocked: dependency }, { blocked: dependency }),
    ).toBeUndefined();
  });
});

describe("draftAfterSend", () => {
  it("clears a draft that is exactly what was sent", () => {
    expect(draftAfterSend("Postgres 16.", "Postgres 16.")).toBe("");
  });

  it("keeps what was typed after the send while it was in flight", () => {
    expect(draftAfterSend("Postgres 16.\nAlso 17.", "Postgres 16.")).toBe(
      "\nAlso 17.",
    );
  });

  it("keeps a draft edited inside the sent text whole", () => {
    expect(draftAfterSend("Postgres 17.", "Postgres 16.")).toBe("Postgres 17.");
  });
});

describe("a comment refusal is current by the move's rule", () => {
  it("lasts until the card passes the revision the server refused at", () => {
    const stale = commentRefusal(
      { _tag: "StaleRevision", message: "at 5, not 4", actual: 5 },
      "",
      4,
    );
    expect(refusalIsCurrent(stale, { revision: 5 })).toBe(true);
    expect(refusalIsCurrent(stale, { revision: 7 })).toBe(false);
  });
});

describe("nextRunOffer", () => {
  const definition: BoardDefinition = {
    id: Schema.decodeSync(DefinitionId)("default"),
    version: 1,
    name: "Default",
    columns: [
      { name: "intake", kind: "resting", skills: [], requires: [] },
      { name: "specifying", kind: "working", skills: [], requires: [] },
    ],
  };
  const card = (column: string): Task => ({
    id: Schema.decodeSync(TaskId)("tsk_00000000000000000000000001"),
    boardId: Schema.decodeSync(BoardInstanceId)(
      "brd_0000000000000000000000000a",
    ),
    title: "Pin the Postgres major",
    column,
    definitionVersion: 1,
    revision: 4,
    priority: "normal",
    createdAt: AT,
    updatedAt: AT,
  });

  it("offers the run in the column the answered card is back in", () => {
    expect(nextRunOffer(needsInput, card("specifying"), definition)).toEqual({
      allowed: true,
      column: "specifying",
    });
  });

  it("offers nothing when no answer landed, and a reason when the column runs nothing", () => {
    expect(nextRunOffer(undefined, card("specifying"), definition)).toBe(
      undefined,
    );
    expect(
      nextRunOffer(dependency, card("specifying"), definition),
    ).toBeUndefined();
    const resting = nextRunOffer(needsInput, card("intake"), definition);
    expect(resting?.allowed).toBe(false);
  });
});
