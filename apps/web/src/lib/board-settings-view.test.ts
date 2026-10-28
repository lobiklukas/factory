/** The board settings view's words (LOB-245): what a reader is told about a definition version. */
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { DefinitionSummary } from "@repo/domain/Task";
import {
  capsLabel,
  gateSource,
  modelSource,
  pushScopeLabel,
  newerVersions,
  newerVersionsNotice,
  requirementState,
  wipLabel,
  writeScopeLabel,
} from "./board-settings-view";

const at = "2026-10-28T00:00:00.000Z";
const summary = (
  id: string,
  versions: ReadonlyArray<number>,
): DefinitionSummary =>
  Schema.decodeSync(DefinitionSummary)({
    id,
    versions: versions.map((version) => ({
      version,
      name: `${id} v${version}`,
      createdAt: at,
    })),
  });

describe("requirementState", () => {
  /** Mutation: invert the flag, or say "unchecked" — the acceptance names "not yet checked". */
  it("says checked only for a requirement a move is refused over, and 'not yet checked' otherwise", () => {
    expect(requirementState({ checked: true })).toBe("checked");
    expect(requirementState({ checked: false })).toBe("not yet checked");
  });
});

describe("modelSource", () => {
  it("names the role's model apart from the deployment's default", () => {
    expect(modelSource({ model: "faux/faux-spec", source: "role" })).toBe(
      "role model",
    );
    expect(modelSource({ model: "faux/faux-1", source: "deployment" })).toBe(
      "deployment default",
    );
  });
});

describe("newerVersions", () => {
  const definitions = [summary("default", [1, 2, 3, 4, 5]), summary("x", [9])];

  /** Mutation: `>=` would list the pinned version as newer than itself. */
  it("lists only the versions of the same definition past the pinned one, oldest first", () => {
    expect(newerVersions(definitions, "default", 2)).toEqual([3, 4, 5]);
    expect(newerVersions(definitions, "default", 5)).toEqual([]);
  });

  /** Mutation: read another definition's versions — `x` holds a v9. */
  it("never reads another definition's versions, and claims none for an unlisted one", () => {
    expect(newerVersions(definitions, "x", 9)).toEqual([]);
    expect(newerVersions(definitions, "missing", 1)).toEqual([]);
  });

  it("does not trust the list's order", () => {
    expect(
      newerVersions([summary("default", [5, 3, 1])], "default", 1),
    ).toEqual([3, 5]);
  });
});

describe("newerVersionsNotice", () => {
  it("says nothing for a board on the newest version", () => {
    expect(newerVersionsNotice("default", 5, [])).toBeNull();
  });

  /** The acceptance: a board pinned to v2 says v3 exists. */
  it("names every newer version, that the board stays pinned, and what a new board pins", () => {
    expect(newerVersionsNotice("default", 2, [3])).toBe(
      "A newer version of default exists: v3. This board stays pinned to v2; a board created now pins v3.",
    );
    expect(newerVersionsNotice("default", 2, [3, 4, 5])).toBe(
      "Newer versions of default exist: v3, v4 and v5. This board stays pinned to v2; a board created now pins v5.",
    );
  });
});

describe("capsLabel and wipLabel", () => {
  it("print only the caps a version declares, and nothing for none", () => {
    expect(capsLabel({ board: 2, task: 1, repo: 2 })).toBe(
      "board 2 · task 1 · repo 2 runs in flight",
    );
    expect(capsLabel({ task: 1 })).toBe("task 1 runs in flight");
    expect(capsLabel({})).toBeNull();
    expect(capsLabel(undefined)).toBeNull();
  });

  it("word a WIP limit with its count, and nothing for a column without one", () => {
    expect(wipLabel(1)).toBe("at most 1 run in flight");
    expect(wipLabel(3)).toBe("at most 3 runs in flight");
    expect(wipLabel(undefined)).toBeNull();
  });
});

describe("a column's autonomy (C22)", () => {
  /** Mutation: read every scope as the worktree, or call a deployment gate the column's. */
  it("words each write and push scope apart, and whose a gate is", () => {
    expect(writeScopeLabel("worktree")).toBe("anywhere in its worktree");
    expect(writeScopeLabel("docs")).toBe("documentation only");
    expect(writeScopeLabel("none")).toBe("nothing — read-only");
    expect(pushScopeLabel("branch")).toBe("its own branch");
    expect(pushScopeLabel("none")).toBe("nothing — the PR step pushes");
    expect(gateSource({ source: "column" })).toBe("this column");
    expect(gateSource({ source: "deployment" })).toBe("deployment");
  });
});
