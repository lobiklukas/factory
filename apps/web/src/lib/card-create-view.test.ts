/**
 * The "New card" form's rules (LOB-275). What the server makes of the payload is proven where it is
 * computed (`packages/core`'s `TaskService.create`); the browser drive (verify-board's both-ways
 * phase, `card-create.sh`) proves the page and the CLI agree. These are the cases a drive does not
 * reach cheaply: a title of spaces, a body that must reach the server byte for byte, a blank field
 * that must be left out rather than sent, a payload over the schema's caps, a refusal with no words.
 */
import {
  BoardInstanceId,
  CreateTaskInput,
  MAX_TASK_BODY_CHARS,
  MAX_TASK_REF_CHARS,
} from "@repo/domain/Task";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  createCardInput,
  createRefusal,
  EMPTY_CARD_FORM,
  type CardForm,
} from "./card-create-view";

const boardId = Schema.decodeSync(BoardInstanceId)(
  "brd_0123456789abcdefghjkmnpqrs",
);
const form = (over: Partial<CardForm> = {}): CardForm => ({
  ...EMPTY_CARD_FORM,
  ...over,
});

describe("createCardInput", () => {
  it("refuses an empty title, and one of nothing but whitespace, naming the title", () => {
    for (const title of ["", "   ", "\n\t "]) {
      expect(createCardInput(boardId, form({ title }))).toEqual({
        ok: false,
        problem: { field: "title", message: "A card needs a title." },
      });
    }
  });

  it("sends a bare title as the dashboard, normal, with no body, base ref or repo", () => {
    expect(createCardInput(boardId, form({ title: "Pin Postgres" }))).toEqual({
      ok: true,
      input: {
        boardId,
        title: "Pin Postgres",
        priority: "normal",
        actor: "dashboard",
      },
    });
  });

  it("trims the title and the base ref, and keeps the body exactly as typed", () => {
    const body = "## Goal\n\n  - keep port 5442 — it is shared\n";
    const result = createCardInput(
      boardId,
      form({
        title: "  Pin Postgres \n",
        body,
        priority: "urgent",
        baseRef: " release\n",
      }),
    );
    expect(result).toEqual({
      ok: true,
      input: {
        boardId,
        title: "Pin Postgres",
        priority: "urgent",
        body,
        baseRef: "release",
        actor: "dashboard",
      },
    });
  });

  it("leaves a blank body and a blank base ref out rather than sending them", () => {
    const result = createCardInput(
      boardId,
      form({ title: "T", body: "  \n ", baseRef: "   " }),
    );
    expect(result.ok && "body" in result.input).toBe(false);
    expect(result.ok && "baseRef" in result.input).toBe(false);
  });

  it("does not judge a base ref's shape: a bad one is the server's refusal", () => {
    const result = createCardInput(
      boardId,
      form({ title: "T", baseRef: "bad..ref" }),
    );
    expect(result.ok && result.input.baseRef).toBe("bad..ref");
  });

  it("refuses a body over the card's cap, and one at the cap encodes", () => {
    const over = createCardInput(
      boardId,
      form({ title: "T", body: "x".repeat(MAX_TASK_BODY_CHARS + 1) }),
    );
    expect(over.ok ? undefined : over.problem.field).toBe("body");
    const at = createCardInput(
      boardId,
      form({ title: "T", body: "x".repeat(MAX_TASK_BODY_CHARS) }),
    );
    expect(at.ok).toBe(true);
    if (at.ok) expect(Schema.is(CreateTaskInput)(at.input)).toBe(true);
  });

  it("refuses a base ref over the ref cap, counted after trimming", () => {
    const over = createCardInput(
      boardId,
      form({ title: "T", baseRef: "r".repeat(MAX_TASK_REF_CHARS + 1) }),
    );
    expect(over.ok ? undefined : over.problem.field).toBe("baseRef");
    const padded = createCardInput(
      boardId,
      form({ title: "T", baseRef: ` ${"r".repeat(MAX_TASK_REF_CHARS)} ` }),
    );
    expect(padded.ok).toBe(true);
  });

  it("answers a payload the RPC schema accepts", () => {
    const result = createCardInput(
      boardId,
      form({ title: "T", body: "b", baseRef: "main", priority: "urgent" }),
    );
    expect(result.ok && Schema.is(CreateTaskInput)(result.input)).toBe(true);
  });
});

describe("createRefusal", () => {
  it("shows a typed refusal in the server's own words", () => {
    const message =
      '"bad..ref" is not a base ref a run can start from: name a branch, a tag or a commit';
    expect(
      createRefusal({ _tag: "InvalidTaskInput", message }, "cause text"),
    ).toEqual({ tag: "InvalidTaskInput", message });
  });

  it("falls back to the cause when there is no typed refusal, or it has no words", () => {
    expect(createRefusal(undefined, "fetch failed")).toEqual({
      tag: "Unknown",
      message: "fetch failed",
    });
    expect(
      createRefusal({ _tag: "TaskStorageError", message: "" }, "cause text"),
    ).toEqual({ tag: "TaskStorageError", message: "cause text" });
  });
});
