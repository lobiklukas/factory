/**
 * The rules an authored definition version is held to (D4, `./boardDefine`), one fault per case, each
 * against a definition that is otherwise valid — so a rule that is dropped reddens its own case, and a
 * rule that over-reaches reddens the first. That nothing is written for any of them is
 * `TaskService.define.test.ts`, against Postgres.
 */
import type { BoardColumn } from "@repo/domain/Task";
import { DefinitionId } from "@repo/domain/Task";
import { describe, expect, it } from "vitest";
import {
  type AuthoredDefinition,
  authoredDefinitionFaults,
  type DefinitionLibrary,
} from "./boardDefine";

const DOING: BoardColumn = {
  name: "doing",
  kind: "working",
  role: "builder",
  skills: ["implement"],
  requires: [{ key: "non_empty_diff", description: "a change" }],
  transitions: [{ to: "done", gate: "sign-off" }, { to: "canceled" }],
};

const COLUMNS: ReadonlyArray<BoardColumn> = [
  {
    name: "todo",
    kind: "resting",
    skills: [],
    requires: [],
    transitions: [{ to: "doing" }, { to: "canceled" }],
  },
  DOING,
  { name: "done", kind: "terminal", skills: [], requires: [], transitions: [] },
  { name: "canceled", kind: "terminal", skills: [], requires: [] },
];

const VALID: AuthoredDefinition = {
  id: DefinitionId.make("authored"),
  name: "Authored",
  columns: COLUMNS,
  initialColumn: "todo",
};

const LIBRARY: DefinitionLibrary = {
  skills: new Set(["implement", "review"]),
  roles: new Set(["builder", "reviewer"]),
};

/** `VALID` with column `index` replaced by `change` applied to it. */
const withColumn = (
  index: number,
  change: (column: BoardColumn) => BoardColumn,
): AuthoredDefinition => ({
  ...VALID,
  columns: VALID.columns.map((column, at) =>
    at === index ? change(column) : column,
  ),
});

const fields = (
  definition: AuthoredDefinition,
  library: DefinitionLibrary = LIBRARY,
) => authoredDefinitionFaults(definition, library).map((fault) => fault.field);

describe("authoredDefinitionFaults (D4)", () => {
  it("finds nothing wrong with a definition that declares its moves, known keys, skills and roles", () => {
    expect(authoredDefinitionFaults(VALID, LIBRARY)).toEqual([]);
  });

  /** Mutation: drop the duplicate check — the second `doing` passes. */
  it("refuses a column named twice, naming the second", () => {
    const faults = authoredDefinitionFaults(
      withColumn(0, (column) => ({ ...column, name: "doing" })),
      LIBRARY,
    );
    expect(faults.map((fault) => fault.field)).toContain("columns[1].name");
    expect(faults.find((f) => f.field === "columns[1].name")?.message).toBe(
      'column "doing" is declared more than once',
    );
  });

  /** Mutation: let an authored version fall back to its first column, as versions 1–3 do. */
  it("refuses a definition with no initial column", () => {
    const { initialColumn: _initial, ...none } = VALID;
    expect(authoredDefinitionFaults(none, LIBRARY)).toEqual([
      {
        field: "initialColumn",
        message:
          "the definition names no initial column: say which column a new card starts in",
      },
    ]);
  });

  it("refuses an initial column the definition does not declare, or one that is terminal", () => {
    expect(fields({ ...VALID, initialColumn: "backlog" })).toEqual([
      "initialColumn",
    ]);
    expect(fields({ ...VALID, initialColumn: "done" })).toEqual([
      "initialColumn",
    ]);
  });

  /** Mutation: drop the target check — a card would be offered a lane the board does not render. */
  it("refuses a move to an undeclared column, naming the move", () => {
    const faults = authoredDefinitionFaults(
      withColumn(1, (column) => ({
        ...column,
        transitions: [{ to: "done" }, { to: "shipped" }],
      })),
      LIBRARY,
    );
    expect(faults).toEqual([
      {
        field: "columns[1].transitions[1].to",
        message:
          'column "doing" declares a move to "shipped", which is not a column of the definition',
      },
    ]);
  });

  /** Mutation: let a terminal column declare moves — a finished card could be moved on. */
  it("refuses a terminal column with exits", () => {
    expect(
      fields(
        withColumn(2, (column) => ({
          ...column,
          transitions: [{ to: "todo" }],
        })),
      ),
    ).toEqual(["columns[2].transitions"]);
  });

  /** Mutation: drop the check — a card in `doing` could never leave it. */
  it("refuses a column that is not terminal and declares no moves out", () => {
    const { transitions: _moves, ...bare } = DOING;
    expect(fields(withColumn(1, () => bare))).toEqual([
      "columns[1].transitions",
    ]);
    expect(
      fields(withColumn(0, (column) => ({ ...column, transitions: [] }))),
    ).toEqual(["columns[0].transitions"]);
  });

  /** Mutation: drop the check — a card on the board could never finish. */
  it("refuses a definition with no terminal column", () => {
    const faults = authoredDefinitionFaults(
      {
        ...VALID,
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
            transitions: [{ to: "todo" }],
          },
        ],
      },
      LIBRARY,
    );
    expect(faults).toEqual([
      {
        field: "columns",
        message:
          "the definition declares no terminal column: a card on it could never finish",
      },
    ]);
  });

  /**
   * Mutation: accept any key — `non_empty_dif` would be a gate nothing holds a card to. Every key the
   * default pipeline declares, checked or not, is known.
   */
  it("refuses an unknown requires key, and one declared twice, and knows every default key", () => {
    expect(
      fields(
        withColumn(1, (column) => ({
          ...column,
          requires: [
            { key: "non_empty_diff", description: "a change" },
            { key: "non_empty_dif", description: "a typo" },
          ],
        })),
      ),
    ).toEqual(["columns[1].requires[1].key"]);
    expect(
      fields(
        withColumn(1, (column) => ({
          ...column,
          requires: [
            { key: "pr_link", description: "a PR" },
            { key: "pr_link", description: "a PR again" },
          ],
        })),
      ),
    ).toEqual(["columns[1].requires[1].key"]);
    const everyDefaultKey = [
      "spec_doc",
      "plan_doc",
      "human_move",
      "run_completed",
      "non_empty_diff",
      "pr_link",
      "verified",
      "review_verdict",
      "human_merge",
    ].map((key) => ({ key, description: key }));
    expect(
      fields(
        withColumn(1, (column) => ({ ...column, requires: everyDefaultKey })),
      ),
    ).toEqual([]);
  });

  /** Mutation: skip the library — the run would fail to start on `MissingSkill`. */
  it("refuses a skill the library does not hold, naming its position", () => {
    const faults = authoredDefinitionFaults(
      withColumn(1, (column) => ({
        ...column,
        skills: ["implement", "deploy"],
      })),
      LIBRARY,
    );
    expect(faults.map((fault) => fault.field)).toEqual([
      "columns[1].skills[1]",
    ]);
    expect(faults[0]?.message).toContain('skill "deploy"');
  });

  /**
   * Mutation: check roles with no table set — every role is refused on a deployment with no
   * `ROLE_MODELS`. Mutation: never check — `buidler` silently runs on the deployment's model.
   */
  it("refuses a role outside the role table when one is set, and any role when none is", () => {
    const typo = withColumn(1, (column) => ({ ...column, role: "buidler" }));
    expect(fields(typo)).toEqual(["columns[1].role"]);
    expect(authoredDefinitionFaults(typo, LIBRARY)[0]?.message).toBe(
      'column "doing" names role "buidler", which is not in the deployment\'s role table (ROLE_MODELS: builder, reviewer), not a role the harness knows, and not one any definition declares (reviewer, specifier)',
    );
    expect(fields(typo, { ...LIBRARY, roles: new Set() })).toEqual([]);
  });

  /**
   * `ROLE_MODELS` is a partial override table: a role it does not name runs on the deployment's model.
   * A copy of the default pipeline (specifier, planner, builder, reviewer) is authored under a table
   * that names only `reviewer`, as the API's boot warning recommends. Mutation: check against the
   * table alone — `specifier` and `planner` are refused. Mutation: drop `HARNESS_ROLES` —
   * `specifier`, which carries tool policy with no table row, is refused.
   */
  it("accepts a role the harness gives meaning to, or one a held definition declares, under a partial table", () => {
    const pipeline = (roles: ReadonlyArray<string>): AuthoredDefinition => ({
      ...VALID,
      columns: [
        ...roles.map((role, at): BoardColumn => ({
          name: `stage${at}`,
          kind: "working",
          role,
          skills: [],
          requires: [],
          transitions: [
            { to: at + 1 < roles.length ? `stage${at + 1}` : "done" },
          ],
        })),
        {
          name: "done",
          kind: "terminal",
          skills: [],
          requires: [],
          transitions: [],
        },
      ],
      initialColumn: "stage0",
    });
    const reviewerOnly = {
      skills: LIBRARY.skills,
      roles: new Set(["reviewer"]),
    };
    expect(fields(pipeline(["specifier", "reviewer"]), reviewerOnly)).toEqual(
      [],
    );
    expect(
      fields(pipeline(["specifier", "planner", "builder", "reviewer"]), {
        ...reviewerOnly,
        knownRoles: new Set(["specifier", "planner", "builder", "reviewer"]),
      }),
    ).toEqual([]);
    expect(
      fields(pipeline(["specifier", "planner", "buidler"]), {
        ...reviewerOnly,
        knownRoles: new Set(["specifier", "planner", "builder", "reviewer"]),
      }),
    ).toEqual(["columns[2].role"]);
  });

  /**
   * The workspace release and the caps' in-flight count decide "finished" by the names `done` and
   * `canceled`, not by `kind`. Mutation: drop the check — a terminal `shipped` never releases its
   * cards' worktrees, and a working `done` tears a live card's down on arrival.
   */
  it("refuses a terminal column not named done or canceled, and a non-terminal one so named", () => {
    const renamed = authoredDefinitionFaults(
      {
        ...VALID,
        columns: [
          ...VALID.columns.slice(0, 2),
          { ...VALID.columns[2]!, name: "shipped" },
          VALID.columns[3]!,
        ].map((column) =>
          column.name === "doing"
            ? {
                ...column,
                transitions: [{ to: "shipped" }, { to: "canceled" }],
              }
            : column,
        ),
      },
      LIBRARY,
    );
    expect(renamed.map((fault) => fault.field)).toEqual(["columns[2].name"]);
    expect(renamed[0]?.message).toContain(
      'column "shipped" is terminal but not named done or canceled',
    );
    const workingDone = fields({
      ...VALID,
      columns: [
        VALID.columns[0]!,
        { ...DOING, transitions: [{ to: "done" }] },
        {
          name: "done",
          kind: "working",
          skills: [],
          requires: [],
          transitions: [{ to: "canceled" }],
        },
        VALID.columns[3]!,
      ],
    });
    expect(workingDone).toEqual(["columns[2].kind"]);
  });

  /**
   * Nothing reads `human_move` or `human_merge`: a move is a person's only when its transition names a
   * `gate`. Mutation: accept the key anywhere — `todo`, whose moves name no gate, would show a gate
   * nothing holds a card to.
   */
  it("refuses a human-gate key on a column none of whose moves names a gate", () => {
    const labelled = (key: string) =>
      withColumn(0, (column) => ({
        ...column,
        requires: [{ key, description: "a human gate" }],
      }));
    expect(fields(labelled("human_move"))).toEqual([
      "columns[0].requires[0].key",
    ]);
    expect(fields(labelled("human_merge"))).toEqual([
      "columns[0].requires[0].key",
    ]);
    expect(
      fields(
        withColumn(1, (column) => ({
          ...column,
          requires: [{ key: "human_merge", description: "a human merge" }],
        })),
      ),
    ).toEqual([]);
  });

  it("refuses a blank name for the definition or a column", () => {
    expect(fields({ ...VALID, name: "  " })).toEqual(["name"]);
    expect(
      fields({
        ...VALID,
        columns: [
          ...COLUMNS,
          {
            name: "",
            kind: "terminal",
            skills: [],
            requires: [],
          },
        ],
      }),
    ).toEqual(["columns[4].name"]);
  });

  /** Mutation: drop the blank-gate rule — the column's `"  "` gate passes, and holds nothing (C22). */
  it("refuses a blank approval gate in a column's autonomy, and accepts a named one", () => {
    expect(
      fields(
        withColumn(1, (column) => ({
          ...column,
          autonomy: { approvalRequired: ["git push", "  "], push: "none" },
        })),
      ),
    ).toEqual(["columns[1].autonomy.approvalRequired[1]"]);
    expect(
      fields(
        withColumn(1, (column) => ({
          ...column,
          autonomy: { approvalRequired: ["git push"], write: "docs" },
        })),
      ),
    ).toEqual([]);
  });

  /** Every fault at once, so an author fixes the file in one pass rather than one refusal at a time. */
  it("reports every fault, not only the first", () => {
    const faults = authoredDefinitionFaults(
      {
        ...VALID,
        initialColumn: "backlog",
        columns: VALID.columns.map((column, at) =>
          at === 1
            ? { ...column, role: "buidler", skills: ["deploy"] }
            : column,
        ),
      },
      LIBRARY,
    );
    expect(faults.map((fault) => fault.field)).toEqual([
      "initialColumn",
      "columns[1].skills[0]",
      "columns[1].role",
    ]);
  });
});
