/**
 * The card pane's Start run prompt and send (C6). That a started run then holds the prompt as its
 * first `pi.user` entry, and that `factory board start` with no `--prompt` holds the same one, is
 * proven by verify-board's `start-prompt.sh` against a real session; these are the cases a drive
 * does not reach cheaply: a card with no body, a column the definition lost, a field emptied, and
 * the session the send opens.
 */
import type { BoardDefinition, Task } from "@repo/domain/Task";
import { BoardInstanceId, DefinitionId, TaskId } from "@repo/domain/Task";
import { RepoSlug } from "@repo/domain/Session";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  startBudget,
  startPrompt,
  startRunSession,
  startSendable,
} from "./run-start-view";

const definition: BoardDefinition = {
  id: Schema.decodeSync(DefinitionId)("default"),
  version: 1,
  name: "Default",
  columns: [
    { name: "intake", kind: "resting", skills: [], requires: [] },
    {
      name: "building",
      kind: "working",
      skills: [],
      requires: [
        { key: "non_empty_diff", description: "the run left a change" },
      ],
    },
  ],
};

const card = (over: Partial<Task> = {}): Task => ({
  id: Schema.decodeSync(TaskId)("tsk_00000000000000000000000001"),
  boardId: Schema.decodeSync(BoardInstanceId)("brd_0000000000000000000000000a"),
  title: "Pin the Postgres major",
  column: "building",
  definitionVersion: 1,
  revision: 1,
  priority: "normal",
  createdAt: "2026-10-28T00:00:00.000Z",
  updatedAt: "2026-10-28T00:00:00.000Z",
  ...over,
});

describe("startPrompt", () => {
  /** Mutation: drop the title, the body or the column's instruction from what the field opens with. */
  it("opens with the title, the body and the column's instruction", () => {
    const prompt = startPrompt(
      card({ body: "Compose names one major." }),
      definition,
    );
    expect(prompt).toContain("Pin the Postgres major");
    expect(prompt).toContain("Compose names one major.");
    expect(prompt).toContain("building column");
    expect(prompt).toContain("non_empty_diff: the run left a change");
    expect(prompt.indexOf("Pin the")).toBeLessThan(prompt.indexOf("Compose"));
    expect(prompt.indexOf("Compose")).toBeLessThan(
      prompt.indexOf("building column"),
    );
  });

  it("has no body line for a card with none, and names no column the definition lacks", () => {
    expect(startPrompt(card(), definition)).not.toContain("undefined");
    expect(startPrompt(card({ column: "gone", body: "B" }), definition)).toBe(
      "Pin the Postgres major\n\nB",
    );
  });
});

describe("startSendable", () => {
  it("refuses an empty field and one of only whitespace, and nothing else", () => {
    for (const draft of ["", "  ", "\n\t "]) {
      expect(startSendable(draft).ok, JSON.stringify(draft)).toBe(false);
    }
    expect(startSendable("go")).toEqual({ ok: true });
  });
});

describe("startRunSession", () => {
  /** The run `factory board start` opens for this card: same card, column and repo; the dashboard's actor. */
  it("names the card and its column, as the dashboard, with the card's repo when it has one", () => {
    expect(startRunSession(card())).toStrictEqual({
      title: "Pin the Postgres major",
      taskId: "tsk_00000000000000000000000001",
      taskColumn: "building",
      actor: "dashboard",
    });
    expect(
      startRunSession(
        card({ repo: Schema.decodeSync(RepoSlug)("acme/widgets") }),
      ),
    ).toMatchObject({ repo: "acme/widgets" });
  });
});

describe("the run's budget (C23)", () => {
  /** The field's blank is the server's default cap; mutation: reading it as zero or NaN. */
  it("reads a blank field as no budget of the run's own", () => {
    for (const typed of ["", "   "]) {
      expect(startBudget(typed)).toEqual({ ok: true, budget: undefined });
    }
  });

  it("reads an amount of dollars, trimmed", () => {
    expect(startBudget(" 2.5 ")).toEqual({ ok: true, budget: 2.5 });
    expect(startBudget("0.01")).toEqual({ ok: true, budget: 0.01 });
  });

  /** The schema `createSession` holds a budget to refuses these; the pane says so before opening a run. */
  it("refuses what is not a positive amount, naming what was typed", () => {
    for (const typed of ["0", "-1", "abc", "1e400", "Infinity", "2,5"]) {
      const result = startBudget(typed);
      expect(result.ok, typed).toBe(false);
      expect(!result.ok && result.reason).toContain(`"${typed}"`);
    }
  });

  it("puts the budget on the session the run opens, only when there is one", () => {
    expect(startRunSession(card(), 2.5)).toMatchObject({ budget: 2.5 });
    expect(startRunSession(card())).not.toHaveProperty("budget");
  });
});
