/** The definition editor's rules (D6): the draft, the payload, the pickers, the diff and the refusal. */
import { describe, expect, it } from "vitest";
import type {
  BoardColumn,
  BoardDefinition,
  RequirementOption,
} from "@repo/domain/Task";
import { DefinitionId } from "@repo/domain/Task";
import {
  addColumn,
  addRequirement,
  addSkill,
  addTransition,
  columnSlot,
  defineInputOf,
  defineRefusal,
  definitionDiff,
  draftOf,
  moveColumn,
  placeFaults,
  removeColumn,
  removeRequirement,
  removeSkill,
  removeTransition,
  renameColumn,
  requirementOptions,
  roleOptions,
  savedNotice,
  setInitialColumn,
  setKind,
  setName,
  setRequirementDescription,
  setRole,
  setTransitionGate,
  setTransitionTarget,
  skillOptions,
  supersedeNotice,
  targetOptions,
  type DefinitionDraft,
} from "./definition-edit-view";

const column = (
  name: string,
  kind: BoardColumn["kind"],
  transitions?: BoardColumn["transitions"],
  extra: Partial<BoardColumn> = {},
): BoardColumn => ({
  name,
  kind,
  skills: [],
  requires: [],
  ...(transitions === undefined ? {} : { transitions }),
  ...extra,
});

/** An authored version: todo → doing → done, `doing → done` across `sign-off`, a WIP limit on doing. */
const PINNED: BoardDefinition = {
  id: DefinitionId.make("edited"),
  version: 3,
  name: "Edited",
  initialColumn: "todo",
  caps: { board: 2 },
  columns: [
    column("todo", "resting", [{ to: "doing" }, { to: "canceled" }]),
    column(
      "doing",
      "working",
      [{ to: "done", gate: "sign-off" }, { to: "canceled" }],
      {
        role: "builder",
        skills: ["implement"],
        requires: [{ key: "pr_link", description: "a PR link" }],
        wipLimit: 2,
      },
    ),
    column("done", "terminal", []),
    column("canceled", "terminal", []),
  ],
};

/** Default version 1–3's shape: no column declares moves and there is no initial column. */
const LEGACY: BoardDefinition = {
  id: DefinitionId.make("default"),
  version: 2,
  name: "Default pipeline",
  columns: [
    column("intake", "resting"),
    column("planning", "working"),
    column("building", "working"),
    column("review", "working"),
    column("done", "terminal"),
    column("canceled", "terminal"),
  ],
};

const keyOf = (draft: DefinitionDraft, name: string): string => {
  const entry = draft.columns.find(
    (candidate) => candidate.column.name === name,
  );
  if (entry === undefined) throw new Error(`no column ${name}`);
  return entry.key;
};
const columnOf = (draft: DefinitionDraft, name: string): BoardColumn => {
  const entry = draft.columns.find(
    (candidate) => candidate.column.name === name,
  );
  if (entry === undefined) throw new Error(`no column ${name}`);
  return entry.column;
};

const VERIFIED: RequirementOption = {
  key: "verified",
  description: "a passing verification",
  checked: true,
  humanGate: false,
};
const HUMAN_MOVE: RequirementOption = {
  key: "human_move",
  description: "a human move",
  checked: false,
  humanGate: true,
};

describe("draftOf and defineInputOf", () => {
  /** Mutation: send the version number, or rebuild columns from the editor's fields alone. */
  it("sends the pinned version back unchanged, but its version, every field kept", () => {
    const input = defineInputOf(PINNED, draftOf(PINNED));
    expect(input).toEqual({
      id: "edited",
      name: "Edited",
      initialColumn: "todo",
      caps: { board: 2 },
      columns: PINNED.columns,
      actor: "dashboard",
    });
    expect("version" in input).toBe(false);
  });

  /**
   * F7: the version the editor writes is the dashboard's, as a dashboard card write is, and the
   * pinned version's own author is not carried over as the new version's.
   * Mutation: drop the actor, or spread the pinned `author` into the payload.
   */
  it("names the dashboard as the author and never the pinned version's", () => {
    const input = defineInputOf(
      { ...PINNED, author: "someone" },
      draftOf(PINNED),
    );
    expect(input.actor).toBe("dashboard");
    expect("author" in input).toBe(false);
  });

  /**
   * C22 (and any later change) adds definition fields this editor has no control for: the draft
   * carries the column objects themselves, so such a field reaches the server as it came.
   * Mutation: copy only the fields the editor knows into the draft.
   */
  it("round-trips a column field and a definition field the editor does not know", () => {
    const future = {
      ...column("todo", "resting", [{ to: "done" }]),
      autonomy: { approvalRequired: ["git push"] },
    };
    const pinned = {
      ...PINNED,
      policy: { approvals: ["merge"] },
      columns: [future, column("done", "terminal", [])],
    };
    const draft = renameColumn(draftOf(pinned), "c0", "backlog");
    const input = defineInputOf(pinned, draft);
    expect(input.columns[0]).toEqual({ ...future, name: "backlog" });
    expect(input).toMatchObject({ policy: { approvals: ["merge"] } });
  });

  /** Mutation: draft a legacy version as stored — every column would send no moves and be refused. */
  it("spells a legacy version's moves and initial column out, and calls that no change", () => {
    const draft = draftOf(LEGACY);
    expect(draft.initialColumn).toBe("intake");
    expect(columnOf(draft, "planning").transitions).toEqual([
      { to: "building", gate: "plan approval" },
      { to: "canceled" },
    ]);
    expect(columnOf(draft, "done").transitions).toEqual([]);
    expect(definitionDiff(LEGACY, draft)).toEqual([]);
  });

  /** Mutation: send `initialColumn: ""` — a schema-valid payload the server reads as a column name. */
  it("sends no initial column when the draft names none", () => {
    const input = defineInputOf(PINNED, setInitialColumn(draftOf(PINNED), ""));
    expect("initialColumn" in input).toBe(false);
  });
});

describe("editing columns", () => {
  /** Mutation: rename the column alone — `todo`'s move and the initial column would point at nothing. */
  it("renames a column with the moves into it and the initial column following", () => {
    const draft = draftOf(PINNED);
    const renamed = renameColumn(draft, keyOf(draft, "doing"), "building");
    expect(columnOf(renamed, "todo").transitions).toEqual([
      { to: "building" },
      { to: "canceled" },
    ]);
    const initial = renameColumn(draft, keyOf(draft, "todo"), "backlog");
    expect(initial.initialColumn).toBe("backlog");
  });

  /** Mutation: follow a shared name — both columns' inbound moves would move with one rename. */
  it("leaves the moves where they point while two columns share the old name", () => {
    let draft = draftOf(PINNED);
    draft = renameColumn(draft, keyOf(draft, "todo"), "doing");
    const second = draft.columns[0]?.key ?? "";
    draft = renameColumn(draft, second, "todo");
    expect(columnOf(draft, "todo").transitions).toEqual([
      { to: "doing" },
      { to: "canceled" },
    ]);
  });

  /** Types `name` into column `key` one keystroke at a time, from its current name. */
  const typeName = (
    start: DefinitionDraft,
    key: string,
    steps: ReadonlyArray<string>,
  ): DefinitionDraft =>
    steps.reduce((draft, name) => renameColumn(draft, key, name), start);

  /** Mutation: follow moves by name — passing `review` points `todo`'s move at the real `review`. */
  it("keeps moves on the renamed column while a name typed on the way is another column's", () => {
    const pinned: BoardDefinition = {
      ...PINNED,
      columns: [
        column("todo", "resting", [{ to: "review_2" }, { to: "review" }]),
        column("review", "working", [{ to: "done" }]),
        column("review_2", "working", [{ to: "done" }]),
        column("done", "terminal", []),
      ],
    };
    const start = draftOf(pinned);
    const draft = typeName(start, keyOf(start, "review_2"), [
      "review_",
      "review",
      "review_",
      "review_b",
    ]);
    expect(defineInputOf(pinned, draft).columns[0]?.transitions).toEqual([
      { to: "review_b" },
      { to: "review" },
    ]);
    expect(definitionDiff(pinned, draft)).toEqual([
      { sign: "~", text: 'column "review_2" renamed to "review_b"' },
    ]);
  });

  /** Mutation: as above — the initial column and planning's move back would land on the real planning. */
  it("keeps moves and the initial column on a column renamed through a later column's name", () => {
    const pinned: BoardDefinition = {
      ...PINNED,
      initialColumn: "specifying",
      columns: [
        column("intake", "resting", [{ to: "specifying" }]),
        column("specifying", "working", [{ to: "planning" }]),
        column("planning", "working", [{ to: "specifying" }, { to: "done" }]),
        column("done", "terminal", []),
      ],
    };
    const start = draftOf(pinned);
    const draft = typeName(
      start,
      keyOf(start, "specifying"),
      Array.from({ length: "planning_s".length }, (_letter, at) =>
        "planning_s".slice(0, at + 1),
      ),
    );
    const sent = defineInputOf(pinned, draft);
    expect(sent.initialColumn).toBe("planning_s");
    expect(sent.columns.map((entry) => entry.transitions)).toEqual([
      [{ to: "planning_s" }],
      [{ to: "planning" }],
      [{ to: "planning_s" }, { to: "done" }],
      [],
    ]);
    // Removing the real `planning` now takes only the moves into it, not the renamed column's.
    const removed = removeColumn(draft, keyOf(draft, "planning"));
    expect(columnOf(removed, "intake").transitions).toEqual([
      { to: "planning_s" },
    ]);
    expect(columnOf(removed, "planning_s").transitions).toEqual([]);
    expect(removed.initialColumn).toBe("planning_s");
  });

  /** Mutation: re-point a move at the first column of a shared name though its own still holds it. */
  it("keeps a move's column when its target is re-picked under a name two columns share", () => {
    let draft = draftOf(PINNED);
    const canceled = keyOf(draft, "canceled");
    draft = renameColumn(draft, keyOf(draft, "done"), "canceled");
    // doing's second move pointed at the real `canceled`; picking `canceled` again keeps it there.
    draft = setTransitionTarget(draft, keyOf(draft, "doing"), 1, "canceled");
    draft = renameColumn(draft, canceled, "dropped");
    expect(columnOf(draft, "doing").transitions).toEqual([
      { to: "canceled", gate: "sign-off" },
      { to: "dropped" },
    ]);
  });

  /** Mutation: append after `done`, or reuse a name or key the draft holds. */
  it("adds a working column with a fresh name and key, before the first terminal column", () => {
    const once = addColumn(draftOf(PINNED));
    const twice = addColumn(once);
    expect(twice.columns.map((entry) => entry.column.name)).toEqual([
      "todo",
      "doing",
      "new_column",
      "new_column_2",
      "done",
      "canceled",
    ]);
    expect(new Set(twice.columns.map((entry) => entry.key)).size).toBe(6);
    expect(columnOf(twice, "new_column")).toEqual({
      name: "new_column",
      kind: "working",
      skills: [],
      requires: [],
      transitions: [],
    });
    expect(twice.columns[2]?.origin).toBeUndefined();
  });

  /** Mutation: leave the moves into a removed column, or keep it as the initial column. */
  it("removes a column, the moves into it, and the initial column when it was it", () => {
    const draft = draftOf(PINNED);
    const removed = removeColumn(draft, keyOf(draft, "canceled"));
    expect(columnOf(removed, "todo").transitions).toEqual([{ to: "doing" }]);
    expect(columnOf(removed, "doing").transitions).toEqual([
      { to: "done", gate: "sign-off" },
    ]);
    expect(removeColumn(draft, keyOf(draft, "todo")).initialColumn).toBe("");
  });

  /** Mutation: move past either end. */
  it("reorders a column by one place, and not past either end", () => {
    const draft = draftOf(PINNED);
    const names = (next: DefinitionDraft) =>
      next.columns.map((entry) => entry.column.name);
    expect(names(moveColumn(draft, keyOf(draft, "doing"), -1))).toEqual([
      "doing",
      "todo",
      "done",
      "canceled",
    ]);
    expect(moveColumn(draft, keyOf(draft, "todo"), -1)).toBe(draft);
    expect(moveColumn(draft, keyOf(draft, "canceled"), 1)).toBe(draft);
  });

  /** Mutation: set `role: undefined` — an absent role must be absent, not a key with no value. */
  it("sets a kind and a role, and takes a role away", () => {
    const draft = draftOf(PINNED);
    const key = keyOf(draft, "doing");
    expect(columnOf(setKind(draft, key, "resting"), "doing").kind).toBe(
      "resting",
    );
    expect(columnOf(setRole(draft, key, "reviewer"), "doing").role).toBe(
      "reviewer",
    );
    expect("role" in columnOf(setRole(draft, key, undefined), "doing")).toBe(
      false,
    );
  });

  it("binds and unbinds skills, and requires and drops known keys with a description", () => {
    const draft = draftOf(PINNED);
    const key = keyOf(draft, "doing");
    const skilled = addSkill(addSkill(draft, key, "docs"), key, "docs");
    expect(columnOf(skilled, "doing").skills).toEqual(["implement", "docs"]);
    expect(columnOf(removeSkill(skilled, key, 0), "doing").skills).toEqual([
      "docs",
    ]);
    const required = addRequirement(draft, key, VERIFIED);
    expect(columnOf(required, "doing").requires).toEqual([
      { key: "pr_link", description: "a PR link" },
      { key: "verified", description: "a passing verification" },
    ]);
    expect(addRequirement(required, key, VERIFIED)).toEqual(required);
    const described = setRequirementDescription(required, key, 1, "green");
    expect(columnOf(described, "doing").requires[1]?.description).toBe("green");
    expect(
      columnOf(removeRequirement(required, key, 0), "doing").requires,
    ).toEqual([{ key: "verified", description: "a passing verification" }]);
  });

  /** Mutation: offer the column itself, or a target another move already has. */
  it("offers a move's targets as the other columns not already moved to", () => {
    const draft = draftOf(PINNED);
    const key = keyOf(draft, "todo");
    expect(targetOptions(draft, key, 0)).toEqual(["doing", "done"]);
    expect(targetOptions(draft, key, 2)).toEqual(["done"]);
    const added = addTransition(draft, key);
    expect(columnOf(added, "todo").transitions).toEqual([
      { to: "doing" },
      { to: "canceled" },
      { to: "done" },
    ]);
    expect(addTransition(added, key)).toEqual(added);
  });

  /** Mutation: keep a blank gate — the server refuses a gate with no name. */
  it("edits a move's target and gate, a blank gate being none", () => {
    const draft = draftOf(PINNED);
    const key = keyOf(draft, "doing");
    const gated = setTransitionGate(draft, key, 1, "abandon");
    expect(columnOf(gated, "doing").transitions?.[1]).toEqual({
      to: "canceled",
      gate: "abandon",
    });
    const ungated = setTransitionGate(gated, key, 0, "  ");
    expect(columnOf(ungated, "doing").transitions?.[0]).toEqual({ to: "done" });
    const retargeted = setTransitionTarget(draft, key, 1, "todo");
    expect(columnOf(retargeted, "doing").transitions?.[1]).toEqual({
      to: "todo",
    });
    expect(
      columnOf(removeTransition(draft, key, 0), "doing").transitions,
    ).toEqual([{ to: "canceled" }]);
  });
});

describe("the pickers", () => {
  /** Mutation: offer a skill the column binds, or one the library does not hold. */
  it("offers only skills the library holds and the column does not bind", () => {
    const doing = columnOf(draftOf(PINNED), "doing");
    expect(skillOptions(["review", "implement", "docs"], doing)).toEqual([
      "docs",
      "review",
    ]);
  });

  it("offers only known keys the column does not require", () => {
    const doing = addRequirement(draftOf(PINNED), "c1", VERIFIED);
    expect(
      requirementOptions([VERIFIED, HUMAN_MOVE], columnOf(doing, "doing")),
    ).toEqual([HUMAN_MOVE]);
  });

  /** Mutation: drop the column's own role — the select would show another role than it holds. */
  it("offers the vocabulary's roles and the column's own", () => {
    const doing = columnOf(draftOf(PINNED), "doing");
    expect(roleOptions(["reviewer", "specifier"], doing)).toEqual([
      "builder",
      "reviewer",
      "specifier",
    ]);
  });
});

describe("definitionDiff", () => {
  /** Mutation: match columns by name — a rename reads as a removal and an addition. */
  it("says what a save changes, a rename as one line and its moves as unchanged", () => {
    let draft = draftOf(PINNED);
    draft = setName(draft, "Edited again");
    draft = renameColumn(draft, keyOf(draft, "doing"), "building");
    draft = addColumn(draft);
    const added = keyOf(draft, "new_column");
    draft = renameColumn(draft, added, "qa");
    draft = addTransition(draft, added);
    draft = addSkill(draft, added, "review");
    draft = addRequirement(draft, added, VERIFIED);
    const building = keyOf(draft, "building");
    draft = setKind(draft, building, "resting");
    draft = setRole(draft, building, undefined);
    draft = removeSkill(draft, building, 0);
    draft = addSkill(draft, building, "docs");
    draft = removeRequirement(draft, building, 0);
    draft = setTransitionGate(draft, building, 0, "merge");
    draft = removeColumn(draft, keyOf(draft, "canceled"));
    expect(definitionDiff(PINNED, draft)).toEqual([
      { sign: "~", text: 'name: "Edited" → "Edited again"' },
      { sign: "-", text: 'column "canceled"' },
      { sign: "-", text: '"todo" move to "canceled"' },
      { sign: "~", text: 'column "doing" renamed to "building"' },
      { sign: "~", text: '"building" kind: working → resting' },
      { sign: "~", text: '"building" role: builder → —' },
      { sign: "-", text: '"building" skill implement' },
      { sign: "+", text: '"building" skill docs' },
      { sign: "-", text: '"building" requires pr_link' },
      {
        sign: "~",
        text: '"building" move to "done": gate "sign-off" → "merge"',
      },
      { sign: "-", text: '"building" move to "canceled"' },
      {
        sign: "+",
        text: 'column "qa" (working; skills review; requires verified; moves to todo)',
      },
    ]);
  });

  /** Mutation: compare only the fields the editor has controls for — a WIP limit change is unsaid. */
  it("names a change to a field the editor has no control for, and a reorder", () => {
    const draft = draftOf(PINNED);
    const key = keyOf(draft, "doing");
    const limited: DefinitionDraft = {
      ...draft,
      columns: draft.columns.map((entry) =>
        entry.key === key
          ? { ...entry, column: { ...entry.column, wipLimit: 3 } }
          : entry,
      ),
    };
    expect(definitionDiff(PINNED, moveColumn(limited, key, -1))).toEqual([
      { sign: "~", text: '"doing" wipLimit: 2 → 3' },
      {
        sign: "~",
        text: "column order: todo, doing, done, canceled → doing, todo, done, canceled",
      },
    ]);
  });

  /** Mutation: map base moves through the draft's names — a removed `qa` and a renamed one match. */
  it("says a move into a removed column is removed when a rename takes the column's name", () => {
    const pinned: BoardDefinition = {
      ...PINNED,
      initialColumn: "qa",
      columns: [
        column("todo", "resting", [{ to: "qa" }, { to: "review" }]),
        column("qa", "working", [{ to: "done" }]),
        column("review", "working", [{ to: "done" }]),
        column("done", "terminal", []),
      ],
    };
    let draft = draftOf(pinned);
    draft = removeColumn(draft, keyOf(draft, "qa"));
    draft = renameColumn(draft, keyOf(draft, "review"), "qa");
    draft = setInitialColumn(draft, "qa");
    expect(definitionDiff(pinned, draft)).toEqual([
      {
        sign: "~",
        text: 'new cards start in: qa → qa (the column renamed from "review")',
      },
      { sign: "-", text: 'column "qa"' },
      { sign: "-", text: '"todo" move to "qa"' },
      { sign: "~", text: 'column "review" renamed to "qa"' },
    ]);
  });

  it("names a change of initial column", () => {
    expect(
      definitionDiff(PINNED, setInitialColumn(draftOf(PINNED), "doing")),
    ).toEqual([{ sign: "~", text: "new cards start in: todo → doing" }]);
  });
});

describe("placeFaults", () => {
  /**
   * Mutation: read a fault's column index against the current draft — after a reorder the fault of
   * `doing` lands on `todo`. Mutation: drop a fault no field holds — it would never be shown.
   */
  it("places each fault next to its field, by the column it was sent as", () => {
    const sentDraft = addColumn(draftOf(PINNED));
    const sent = sentDraft.columns.map((entry) => entry.key);
    const added = keyOf(sentDraft, "new_column");
    const now = moveColumn(sentDraft, added, -1);
    const faults = [
      { field: "name", message: "no name" },
      { field: "initialColumn", message: "no initial column" },
      { field: "columns", message: "no terminal column" },
      { field: "columns[2].transitions", message: "no moves" },
      { field: "columns[1].transitions[0].to", message: "bad target" },
      {
        field: "columns[1].transitions[9].gate",
        message: "a row since removed",
      },
      { field: "columns[1].skills[0]", message: "unknown skill" },
      { field: "columns[1].role", message: "unknown role" },
      { field: "columns[1].wipLimit", message: "a field with no control" },
      { field: "columns[9].name", message: "a column the draft never had" },
      { field: "caps.board", message: "a definition field with no control" },
    ];
    const placed = placeFaults(faults, sent, now);
    const at = (slot: string) =>
      (placed.slots.get(slot) ?? []).map((fault) => fault.message);
    expect(at("name")).toEqual(["no name"]);
    expect(at("initialColumn")).toEqual(["no initial column"]);
    expect(at("columns")).toEqual(["no terminal column"]);
    expect(at(columnSlot(added, "transitions"))).toEqual(["no moves"]);
    const doing = keyOf(now, "doing");
    expect(at(columnSlot(doing, "transitions[0]"))).toEqual(["bad target"]);
    expect(at(columnSlot(doing, "transitions"))).toEqual([
      "a row since removed",
    ]);
    expect(at(columnSlot(doing, "skills[0]"))).toEqual(["unknown skill"]);
    expect(at(columnSlot(doing, "role"))).toEqual(["unknown role"]);
    expect(at(columnSlot(doing))).toEqual(["a field with no control"]);
    expect(placed.unplaced.map((fault) => fault.message)).toEqual([
      "a column the draft never had",
      "a definition field with no control",
    ]);
  });

  it("shows a removed column's fault above the editor", () => {
    const draft = draftOf(PINNED);
    const sent = draft.columns.map((entry) => entry.key);
    const removed = removeColumn(draft, keyOf(draft, "doing"));
    const placed = placeFaults(
      [{ field: "columns[1].role", message: "unknown role" }],
      sent,
      removed,
    );
    expect(placed.slots.size).toBe(0);
    expect(placed.unplaced).toHaveLength(1);
  });
});

describe("defineRefusal and savedNotice", () => {
  it("keeps every fault of InvalidDefinition, and only the words of anything else", () => {
    const problems = [{ field: "name", message: "no name" }];
    expect(
      defineRefusal(
        { _tag: "InvalidDefinition", message: "definition x: name", problems },
        "fallback",
      ),
    ).toEqual({
      tag: "InvalidDefinition",
      message: "definition x: name",
      faults: problems,
    });
    expect(
      defineRefusal({ _tag: "TaskStorageError", message: "down" }, "fallback"),
    ).toEqual({ tag: "TaskStorageError", message: "down", faults: [] });
    expect(defineRefusal(undefined, "connection reset")).toEqual({
      tag: "Unknown",
      message: "connection reset",
      faults: [],
    });
  });

  /** Mutation: stay silent about newer versions — a save from v1 over v3 would drop v2 and v3. */
  it("says a save from the pin supersedes newer versions without their changes", () => {
    expect(supersedeNotice("edited", 3, [])).toBeNull();
    expect(supersedeNotice("edited", 1, [2])).toBe(
      "v2 of edited already exists, and this draft starts from v1, the board's pin. Saving writes v3 as v1 plus these edits, without its changes.",
    );
    expect(supersedeNotice("edited", 1, [2, 3])).toBe(
      "v2–v3 of edited already exist, and this draft starts from v1, the board's pin. Saving writes v4 as v1 plus these edits, without their changes.",
    );
  });

  /** Mutation: say the board moved to the new version — it stays on its pin until upgraded (B2). */
  it("says v<n> created, and that the board keeps its pin", () => {
    expect(savedNotice("created", 5, 3)).toBe(
      "v5 created. This board stays pinned to v3 until it is upgraded; a board created now pins v5.",
    );
    expect(savedNotice("unchanged", 4, 3)).toBe(
      "No new version: v4 already holds exactly this.",
    );
  });
});
