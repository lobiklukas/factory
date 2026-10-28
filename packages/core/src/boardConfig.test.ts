/**
 * `describeDefinition` (LOB-270): a definition row, joined with the three facts the row does not
 * carry — the declared exits and their human gates, whether each requirement is checked, and each
 * role's model. Pure, so the cases are tables; the wire is `apps/api/src/Rpc/Task.test.ts`'s.
 */
import { describe, expect, it } from "vitest";
import {
  type BoardDefinition,
  DefinitionId,
  NON_EMPTY_DIFF_REQUIREMENT,
  type ResolvedModel,
  VERIFIED_REQUIREMENT,
} from "@repo/domain/Task";
import { describeDefinition } from "./boardConfig";

const definition: BoardDefinition = {
  id: DefinitionId.make("custom"),
  version: 7,
  name: "Custom",
  columns: [
    {
      name: "planning",
      kind: "working",
      role: "planner",
      skills: ["plan", "estimate"],
      requires: [
        { key: "plan_doc", description: "a plan doc" },
        { key: NON_EMPTY_DIFF_REQUIREMENT, description: "a change" },
      ],
    },
    // A column the declared-transition table does not name: nothing may leave it.
    {
      name: "triage",
      kind: "resting",
      skills: [],
      requires: [{ key: VERIFIED_REQUIREMENT, description: "verified" }],
    },
    {
      name: "review",
      kind: "working",
      role: "reviewer",
      skills: [],
      requires: [],
    },
  ],
};

/** A role table of one row: `planner` has a model of its own, everything else the deployment's. */
const asked: Array<string | undefined> = [];
const modelOf = (role: string | undefined): ResolvedModel => {
  asked.push(role);
  return role === "planner"
    ? { model: "anthropic/claude-haiku-4-5", source: "role" }
    : { model: "faux/faux-1", source: "deployment" };
};

describe("describeDefinition (LOB-270)", () => {
  const described = describeDefinition(definition, modelOf);

  it("keeps the row's identity and its columns in declaration order", () => {
    expect(described.id).toBe("custom");
    expect(described.version).toBe(7);
    expect(described.name).toBe("Custom");
    expect(described.columns.map((column) => column.name)).toEqual([
      "planning",
      "triage",
      "review",
    ]);
    expect(described.columns[0]?.skills).toEqual(["plan", "estimate"]);
  });

  /** Mutation: read the model once for the definition — every column answers the same one. */
  it("asks the role table for each column's role, and passes no role for a column without one", () => {
    expect(asked).toEqual(["planner", undefined, "reviewer"]);
    expect(described.columns.map((column) => column.model)).toEqual([
      { model: "anthropic/claude-haiku-4-5", source: "role" },
      { model: "faux/faux-1", source: "deployment" },
      { model: "faux/faux-1", source: "deployment" },
    ]);
    expect(described.columns[1]).not.toHaveProperty("role");
  });

  /** Mutation: mark a declared key checked because it is declared — `plan_doc` reads checked. */
  it("marks a requirement checked only when the board refuses a move over it", () => {
    expect(described.columns[0]?.requires).toEqual([
      { key: "plan_doc", description: "a plan doc", checked: false },
      {
        key: NON_EMPTY_DIFF_REQUIREMENT,
        description: "a change",
        checked: true,
      },
    ]);
    expect(described.columns[1]?.requires).toEqual([
      { key: VERIFIED_REQUIREMENT, description: "verified", checked: true },
    ]);
  });

  /**
   * The exits are the declared-transition table's, by column name: a column it does not name has
   * none, exactly as `TaskService.move` refuses every move out of it. Mutation: give every column
   * `canceled` — `triage` gains an exit the service would refuse.
   */
  it("lists the declared exits by column name, gates marked, and none for a column the table lacks", () => {
    expect(described.columns.map((column) => column.exits)).toEqual([
      [{ to: "building", humanGate: "plan approval" }, { to: "canceled" }],
      [],
      [{ to: "done", humanGate: "merge" }, { to: "canceled" }],
    ]);
  });
});

/**
 * A definition that declares its own moves (LOB-267): the exits are its columns' `transitions`, not
 * the default pipeline's table, and the initial column is the one it names.
 */
describe("describeDefinition over a definition's own transitions (LOB-267)", () => {
  /** Not `modelOf`: the case above counts the roles that table was asked for. */
  const deploymentModel = (): ResolvedModel => ({
    model: "faux/faux-1",
    source: "deployment",
  });
  const declared: BoardDefinition = {
    id: DefinitionId.make("todo"),
    version: 1,
    name: "Todo",
    initialColumn: "todo",
    columns: [
      {
        name: "todo",
        kind: "resting",
        skills: [],
        requires: [],
        transitions: [{ to: "doing" }],
      },
      {
        name: "doing",
        kind: "working",
        skills: [],
        requires: [],
        transitions: [{ to: "done", gate: "sign-off" }],
      },
      // Named like a default column, but this definition declares its moves: none out of here.
      { name: "review", kind: "working", skills: [], requires: [] },
      {
        name: "done",
        kind: "terminal",
        skills: [],
        requires: [],
        transitions: [],
      },
    ],
  };
  const described = describeDefinition(declared, deploymentModel);

  /** Mutation: describe exits from the default table — `todo` and `doing` read none, `review` two. */
  it("lists each column's declared transitions, gates marked, and none where it declares none", () => {
    expect(described.columns.map((column) => column.exits)).toEqual([
      [{ to: "doing" }],
      [{ to: "done", humanGate: "sign-off" }],
      [],
      [],
    ]);
  });

  /** Mutation: describe the first column, or `intake`, as the initial one — this reads `todo` only by its name. */
  it("names the initial column the definition declares, and the first column for one that declares none", () => {
    expect(described.initialColumn).toBe("todo");
    expect(
      describeDefinition(
        { ...declared, initialColumn: "doing" },
        deploymentModel,
      ).initialColumn,
    ).toBe("doing");
    expect(describeDefinition(definition, deploymentModel).initialColumn).toBe(
      "planning",
    );
  });
});
