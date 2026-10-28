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
  addGate,
  addRequirement,
  addSkill,
  addTransition,
  columnSlot,
  defineInputOf,
  defineRefusal,
  definitionDiff,
  draftOf,
  gatesOf,
  moveColumn,
  limitFaults,
  parseLimit,
  placeFaults,
  removeColumn,
  removeGate,
  removeRequirement,
  removeSkill,
  removeTransition,
  renameColumn,
  requirementOptions,
  roleOptions,
  savedNotice,
  setCap,
  setGate,
  setInitialColumn,
  setKind,
  setName,
  setPushScope,
  setRequirementDescription,
  setRole,
  setTransitionGate,
  setTransitionTarget,
  setWipLimit,
  setWriteScope,
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
    });
    expect("version" in input).toBe(false);
  });

  /**
   * A later change adds definition fields this editor has no control for: the draft carries the
   * column objects themselves, so such a field reaches the server as it came.
   * Mutation: copy only the fields the editor knows into the draft.
   */
  it("round-trips a column field and a definition field the editor does not know", () => {
    const future = {
      ...column("todo", "resting", [{ to: "done" }]),
      lane: "fast",
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
    expect(
      roleOptions(
        { roles: ["reviewer", "specifier"], rolesOpen: false },
        doing,
      ),
    ).toEqual({ names: ["builder", "reviewer", "specifier"], typed: false });
  });

  /**
   * F4. With a role table the picker is closed: the table's roles and the column's own, and no typed
   * name. With none every role is accepted, so a name may be typed beside the suggestions.
   * Mutation: offer a typed name under a table (the server refuses a typo), or never offer one (a
   * brand-new role could only be authored with `factory board define`).
   */
  it("takes a typed role name exactly when the vocabulary says roles are open", () => {
    const doing = columnOf(draftOf(PINNED), "doing");
    const closed = roleOptions(
      { roles: ["builder", "reviewer"], rolesOpen: false },
      doing,
    );
    expect(closed.typed).toBe(false);
    expect(closed.names).toEqual(["builder", "reviewer"]);
    const open = roleOptions(
      { roles: ["reviewer", "specifier"], rolesOpen: true },
      doing,
    );
    expect(open.typed).toBe(true);
    expect(open.names).toEqual(["builder", "reviewer", "specifier"]);
    // A role typed into a column is that column's own, so the suggestions still list it.
    const typed = columnOf(setRole(draftOf(PINNED), "c1", "triager"), "doing");
    expect(
      roleOptions({ roles: ["reviewer"], rolesOpen: true }, typed).names,
    ).toEqual(["reviewer", "triager"]);
    // A column with no role offers the vocabulary alone.
    expect(
      roleOptions(
        { roles: ["reviewer"], rolesOpen: true },
        columnOf(draftOf(PINNED), "todo"),
      ).names,
    ).toEqual(["reviewer"]);
  });
});

/** What `defineInputOf` sends for the column named `name`. */
const sentColumn = (
  pinned: BoardDefinition,
  draft: DefinitionDraft,
  name: string,
) => defineInputOf(pinned, draft).columns.find((entry) => entry.name === name);

describe("a column's autonomy (F2)", () => {
  /**
   * Mutation: drop `autonomy` while rebuilding the column — a narrowed column would be widened by an
   * unrelated edit. A column the person never touched sends exactly what the pinned one holds.
   */
  it("round-trips an untouched column's autonomy and reports no change", () => {
    const autonomy = {
      approvalRequired: ["git push", "rm -rf"],
      write: "docs",
      push: "none",
    } as const;
    const pinned: BoardDefinition = {
      ...PINNED,
      columns: PINNED.columns.map((entry) =>
        entry.name === "doing" ? { ...entry, autonomy } : entry,
      ),
    };
    const draft = draftOf(pinned);
    expect(sentColumn(pinned, draft, "doing")?.autonomy).toEqual(autonomy);
    expect(definitionDiff(pinned, draft)).toEqual([]);
    // Editing another field of the column keeps the autonomy beside it.
    const renamed = setRole(draft, keyOf(draft, "doing"), "reviewer");
    expect(sentColumn(pinned, renamed, "doing")?.autonomy).toEqual(autonomy);
  });

  /** Mutation: write the scope to the wrong field, or keep a gate list after removing its last row. */
  it("edits the gates, the write scope and the push scope, and names each in the diff", () => {
    let draft = draftOf(PINNED);
    const doing = keyOf(draft, "doing");
    draft = addGate(draft, doing);
    draft = setGate(draft, doing, 0, "git push");
    draft = addGate(draft, doing);
    draft = setGate(draft, doing, 1, "npm publish");
    draft = setWriteScope(draft, doing, "docs");
    draft = setPushScope(draft, doing, "none");
    expect(columnOf(draft, "doing").autonomy).toEqual({
      approvalRequired: ["git push", "npm publish"],
      write: "docs",
      push: "none",
    });
    expect(definitionDiff(PINNED, draft)).toEqual([
      { sign: "+", text: '"doing" approval gate "git push"' },
      { sign: "+", text: '"doing" approval gate "npm publish"' },
      { sign: "~", text: '"doing" write scope: — → docs' },
      { sign: "~", text: '"doing" push scope: — → none' },
    ]);
    draft = removeGate(draft, doing, 0);
    expect(gatesOf(columnOf(draft, "doing"))).toEqual(["npm publish"]);
    expect(
      sentColumn(PINNED, draft, "doing")?.autonomy?.approvalRequired,
    ).toEqual(["npm publish"]);
  });

  /**
   * Mutation: leave `autonomy: {}` behind — the version would differ from one that never set it, so
   * `defineBoard` writes a new version for no change (and the diff would never go quiet).
   */
  it("drops the autonomy field once nothing is left in it, so a reverted edit is no change", () => {
    let draft = draftOf(PINNED);
    const doing = keyOf(draft, "doing");
    draft = setWriteScope(draft, doing, "none");
    draft = addGate(draft, doing);
    expect(definitionDiff(PINNED, draft)).not.toEqual([]);
    draft = setWriteScope(draft, doing, undefined);
    draft = removeGate(draft, doing, 0);
    expect("autonomy" in columnOf(draft, "doing")).toBe(false);
    expect(definitionDiff(PINNED, draft)).toEqual([]);
  });

  /** A blank gate is sent as typed: the server refuses it, beside the row (`columns[i].autonomy…`). */
  it("sends a blank gate to the server rather than dropping it", () => {
    const draft = addGate(draftOf(PINNED), keyOf(draftOf(PINNED), "doing"));
    expect(sentColumn(PINNED, draft, "doing")?.autonomy).toEqual({
      approvalRequired: [""],
    });
  });

  /** Mutation: merge a changed scope into the diff of a gate, or compare scopes by reference. */
  it("diffs a changed scope and a removed gate against what was pinned", () => {
    const pinned: BoardDefinition = {
      ...PINNED,
      columns: PINNED.columns.map((entry) =>
        entry.name === "doing"
          ? {
              ...entry,
              autonomy: {
                approvalRequired: ["git push"],
                write: "docs" as const,
              },
            }
          : entry,
      ),
    };
    let draft = draftOf(pinned);
    const doing = keyOf(draft, "doing");
    draft = removeGate(draft, doing, 0);
    draft = setWriteScope(draft, doing, "none");
    expect(definitionDiff(pinned, draft)).toEqual([
      { sign: "-", text: '"doing" approval gate "git push"' },
      { sign: "~", text: '"doing" write scope: docs → none' },
    ]);
  });
});

describe("limits and caps (F3)", () => {
  /** Mutation: read `""` as 0 — clearing a field would send a limit the server refuses. */
  it("reads a number field's text as a limit, empty as none and anything else as the number", () => {
    expect(parseLimit("")).toBeUndefined();
    expect(parseLimit("  ")).toBeUndefined();
    expect(parseLimit("3")).toBe(3);
    expect(parseLimit("0")).toBe(0);
    expect(parseLimit("-2")).toBe(-2);
    expect(parseLimit("1.5")).toBe(1.5);
    expect(parseLimit("abc")).toBeUndefined();
  });

  /** Mutation: write the limit to the draft's caps, or keep `wipLimit: undefined` as a key. */
  it("sets and clears a column's WIP limit, and diffs it", () => {
    const draft = draftOf(PINNED);
    const todo = keyOf(draft, "todo");
    const set = setWipLimit(draft, todo, 4);
    expect(columnOf(set, "todo").wipLimit).toBe(4);
    expect(definitionDiff(PINNED, set)).toEqual([
      { sign: "~", text: '"todo" wipLimit: — → 4' },
    ]);
    const cleared = setWipLimit(set, keyOf(set, "doing"), undefined);
    expect("wipLimit" in columnOf(cleared, "doing")).toBe(false);
    expect(definitionDiff(PINNED, cleared)).toEqual([
      { sign: "~", text: '"todo" wipLimit: — → 4' },
      { sign: "~", text: '"doing" wipLimit: 2 → —' },
    ]);
    // A limit the server will refuse is still the person's to send.
    expect(columnOf(setWipLimit(draft, todo, 0), "todo").wipLimit).toBe(0);
  });

  /** Mutation: send the pinned caps after the draft changed them, or `caps: {}` once all are cleared. */
  it("sets and clears each cap, sends the draft's caps and none when none is left", () => {
    let draft = draftOf(PINNED);
    expect(draft.caps).toEqual({ board: 2 });
    draft = setCap(draft, "task", 1);
    draft = setCap(draft, "repo", 5);
    draft = setCap(draft, "board", 3);
    expect(defineInputOf(PINNED, draft).caps).toEqual({
      board: 3,
      task: 1,
      repo: 5,
    });
    expect(definitionDiff(PINNED, draft)).toEqual([
      { sign: "~", text: "caps.board: 2 → 3" },
      { sign: "~", text: "caps.task: — → 1" },
      { sign: "~", text: "caps.repo: — → 5" },
    ]);
    draft = setCap(
      setCap(setCap(draft, "task", undefined), "repo", undefined),
      "board",
      undefined,
    );
    expect(draft.caps).toBeUndefined();
    expect("caps" in defineInputOf(PINNED, draft)).toBe(false);
    expect(definitionDiff(PINNED, draft)).toEqual([
      { sign: "~", text: "caps.board: 2 → —" },
    ]);
  });

  it("sends a version that had no caps with none until one is set", () => {
    const pinned: BoardDefinition = { ...PINNED, caps: undefined };
    const draft = draftOf(pinned);
    expect(draft.caps).toBeUndefined();
    expect("caps" in defineInputOf(pinned, draft)).toBe(false);
    expect(defineInputOf(pinned, setCap(draft, "task", 2)).caps).toEqual({
      task: 2,
    });
  });
});

describe("limits the domain schema refuses (F3)", () => {
  /**
   * Mutation: judge only the WIP limits (or only the caps), check `> 0` instead of the schema's
   * whole-number minimum of one, or index the column by key rather than position — the fault would
   * land beside another column's field.
   */
  it("names each refused limit at the path the server would, in the schema's words", () => {
    let draft = draftOf(PINNED);
    expect(limitFaults(draft)).toEqual([]);
    draft = setWipLimit(draft, keyOf(draft, "doing"), 0);
    draft = setWipLimit(draft, keyOf(draft, "canceled"), 1.5);
    draft = setCap(draft, "task", -2);
    draft = setCap(draft, "repo", 4);
    expect(limitFaults(draft)).toEqual([
      {
        field: "columns[1].wipLimit",
        message: "Expected a value greater than or equal to 1",
      },
      { field: "columns[3].wipLimit", message: "Expected an integer" },
      {
        field: "caps.task",
        message: "Expected a value greater than or equal to 1",
      },
    ]);
  });

  it("places them beside the field like any fault", () => {
    const draft = setWipLimit(draftOf(PINNED), "c0", 0);
    const placed = placeFaults(
      limitFaults(draft),
      draft.columns.map((entry) => entry.key),
      draft,
    );
    expect(placed.slots.get(columnSlot("c0", "wipLimit"))).toHaveLength(1);
    expect(placed.unplaced).toEqual([]);
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
    // `doing` holds one gate now, so a fault at row 0 is its row and one at row 7 is a row since removed.
    const now = addGate(
      moveColumn(sentDraft, added, -1),
      keyOf(sentDraft, "doing"),
    );
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
      { field: "columns[1].wipLimit", message: "limit" },
      { field: "columns[1].autonomy.write", message: "write" },
      { field: "columns[1].autonomy.push", message: "push" },
      {
        field: "columns[1].autonomy.approvalRequired[0]",
        message: "blank gate",
      },
      {
        field: "columns[1].autonomy.approvalRequired[7]",
        message: "a gate since removed",
      },
      { field: "columns[1].lane", message: "a field with no control" },
      { field: "columns[9].name", message: "a column the draft never had" },
      { field: "caps.board", message: "cap" },
      { field: "caps", message: "caps as a whole" },
      { field: "caps.nope", message: "a cap that is not one" },
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
    expect(at(columnSlot(doing, "wipLimit"))).toEqual(["limit"]);
    expect(at(columnSlot(doing, "autonomy.write"))).toEqual(["write"]);
    expect(at(columnSlot(doing, "autonomy.push"))).toEqual(["push"]);
    expect(at(columnSlot(doing, "autonomy.approvalRequired[0]"))).toEqual([
      "blank gate",
    ]);
    expect(at(columnSlot(doing, "autonomy.approvalRequired"))).toEqual([
      "a gate since removed",
    ]);
    expect(at(columnSlot(doing))).toEqual(["a field with no control"]);
    expect(at("caps.board")).toEqual(["cap"]);
    expect(at("caps")).toEqual(["caps as a whole"]);
    expect(placed.unplaced.map((fault) => fault.message)).toEqual([
      "a column the draft never had",
      "a cap that is not one",
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
