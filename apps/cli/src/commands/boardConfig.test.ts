/**
 * The lines `factory board list|definitions|definition show|config` print (LOB-270). The commands
 * themselves are proven against a real control plane by `.pi/skills/verify-board/definitions.sh`;
 * these cases pin the layout a pane capture would not localize: a column with no role prints `—`, a
 * requirement says `checked` or `unchecked`, a gated exit names its gate, and a second requirement
 * lines up under the first.
 */
import { Schema } from "effect";
import {
  BoardInstance,
  ColumnConfig,
  DefinitionConfig,
  DefinitionSummary,
  InvalidDefinition,
  LIST_BOARDS_LIMIT,
} from "@repo/domain/Task";
import { describe, expect, it } from "vitest";
import {
  boardLine,
  boardListLines,
  columnLines,
  decodeDefinitionFile,
  definedLines,
  definitionLines,
  definitionsLines,
  invalidDefinitionLines,
} from "./boardConfig";

const planning = Schema.decodeSync(ColumnConfig)({
  name: "planning",
  kind: "working",
  role: "planner",
  model: { model: "anthropic/claude-haiku-4-5", source: "role" },
  skills: ["plan", "estimate"],
  requires: [
    { key: "plan_doc", description: "a plan doc", checked: false },
    { key: "pr_link", description: "a PR link", checked: true },
  ],
  exits: [{ to: "building", humanGate: "plan approval" }, { to: "canceled" }],
});

const done = Schema.decodeSync(ColumnConfig)({
  name: "done",
  kind: "terminal",
  model: { model: "faux/faux-1", source: "deployment" },
  skills: [],
  requires: [],
  exits: [],
});

describe("columnLines (LOB-270)", () => {
  it("prints the role, its model and source, skills, each requirement's status and the gated exit", () => {
    expect(columnLines(planning)).toEqual([
      "planning  working",
      "  role      planner",
      "  model     anthropic/claude-haiku-4-5 (role)",
      "  skills    plan, estimate",
      "  requires  plan_doc (unchecked): a plan doc",
      "            pr_link (checked): a PR link",
      "  exits     building [human gate: plan approval], canceled",
    ]);
  });

  it("prints — for a column with no role, no skills, no requirements and no exits", () => {
    expect(columnLines(done)).toEqual([
      "done  terminal",
      "  role      —",
      "  model     faux/faux-1 (deployment)",
      "  skills    —",
      "  requires  —",
      "  exits     —",
    ]);
  });
});

describe("definitionLines (LOB-270)", () => {
  it("names the definition and version, its initial column (LOB-267), then every column in order", () => {
    const definition = Schema.decodeSync(DefinitionConfig)({
      id: "default",
      version: 3,
      name: "Default pipeline",
      initialColumn: "planning",
      columns: [
        Schema.encodeSync(ColumnConfig)(planning),
        Schema.encodeSync(ColumnConfig)(done),
      ],
    });
    const lines = definitionLines(definition);
    expect(lines[0]).toBe("definition  default v3  Default pipeline");
    expect(lines[1]).toBe("initial     planning");
    expect(lines.filter((line) => !line.startsWith(" "))).toEqual([
      "definition  default v3  Default pipeline",
      "initial     planning",
      "planning  working",
      "done  terminal",
    ]);
  });

  it("prints — for a definition with no initial column (one that declares no columns)", () => {
    const definition = Schema.decodeSync(DefinitionConfig)({
      id: "empty",
      version: 1,
      name: "Empty",
      columns: [],
    });
    expect(definitionLines(definition)).toEqual([
      "definition  empty v1  Empty",
      "initial     —",
    ]);
  });
});

describe("caps and WIP limits (LOB-71)", () => {
  /**
   * Mutation: drop `capsLines` from `definitionLines` — the `caps` line is missing. Mutation: print
   * a kind the version does not cap — the line carries `repo`.
   */
  it("prints a version's caps after its initial column, only the kinds it caps, and a column's WIP limit", () => {
    const building = Schema.decodeSync(ColumnConfig)({
      ...Schema.encodeSync(ColumnConfig)(planning),
      name: "building",
      wipLimit: 1,
    });
    const definition = Schema.decodeSync(DefinitionConfig)({
      id: "default",
      version: 5,
      name: "Default pipeline",
      initialColumn: "building",
      caps: { board: 2, task: 1 },
      columns: [Schema.encodeSync(ColumnConfig)(building)],
    });
    const lines = definitionLines(definition);
    expect(lines.slice(0, 3)).toEqual([
      "definition  default v5  Default pipeline",
      "initial     building",
      "caps        board 2 · task 1 runs in flight",
    ]);
    expect(lines.at(-1)).toBe("  wip       at most 1 run in flight");
  });

  it("prints no caps line and no wip field for a version that declares none", () => {
    const lines = definitionLines(
      Schema.decodeSync(DefinitionConfig)({
        id: "default",
        version: 4,
        name: "Default pipeline",
        initialColumn: "planning",
        columns: [Schema.encodeSync(ColumnConfig)(planning)],
      }),
    );
    expect(lines.some((line) => line.startsWith("caps"))).toBe(false);
    expect(lines.some((line) => line.includes("wip"))).toBe(false);
  });
});

describe("boardLine and definitionsLines (LOB-270)", () => {
  it("prints a board's id, repo, pinned version and creation time", () => {
    const board = Schema.decodeSync(BoardInstance)({
      id: `brd_${"0".repeat(26)}`,
      repo: "acme/widgets",
      definitionId: "default",
      definitionVersion: 2,
      createdAt: "2026-10-28T00:00:00.000Z",
    });
    expect(boardLine(board)).toBe(
      `brd_${"0".repeat(26)}  acme/widgets  default v2  2026-10-28T00:00:00.000Z`,
    );
  });

  it("prints `no boards` for none, and says so when the list hit its cap", () => {
    const boards = Array.from({ length: LIST_BOARDS_LIMIT }, (_, index) =>
      Schema.decodeSync(BoardInstance)({
        id: `brd_${String(index).padStart(26, "0")}`,
        repo: `acme/repo-${index}`,
        definitionId: "default",
        definitionVersion: 1,
        createdAt: "2026-10-28T00:00:00.000Z",
      }),
    );
    expect(boardListLines([])).toEqual(["no boards"]);
    const short = boardListLines(boards.slice(0, 2));
    expect(short).toEqual(boards.slice(0, 2).map(boardLine));
    const full = boardListLines(boards);
    expect(full).toHaveLength(LIST_BOARDS_LIMIT + 1);
    expect(full.slice(0, LIST_BOARDS_LIMIT)).toEqual(boards.map(boardLine));
    expect(full.at(-1)).toBe(
      `(showing the newest ${LIST_BOARDS_LIMIT} boards; older boards may exist)`,
    );
  });

  it("prints one line per version, in the order the server answered", () => {
    const definitions = Schema.decodeSync(Schema.Array(DefinitionSummary))([
      {
        id: "default",
        versions: [
          {
            version: 1,
            name: "Default pipeline",
            createdAt: "2026-10-01T00:00:00.000Z",
          },
          {
            version: 2,
            name: "Default pipeline",
            createdAt: "2026-10-02T00:00:00.000Z",
          },
        ],
      },
      {
        id: "other",
        versions: [
          { version: 1, name: "Other", createdAt: "2026-10-03T00:00:00.000Z" },
        ],
      },
    ]);
    expect(definitionsLines(definitions)).toEqual([
      "default  v1  Default pipeline  2026-10-01T00:00:00.000Z",
      "default  v2  Default pipeline  2026-10-02T00:00:00.000Z",
      "other  v1  Other  2026-10-03T00:00:00.000Z",
    ]);
  });
});

/**
 * `factory board define --file` (D4): what is refused before anything is sent, and what is printed
 * for each answer. The command against a real control plane is `.pi/skills/verify-board/define.sh`.
 */
describe("board define (D4)", () => {
  const FILE = {
    id: "authored",
    name: "Authored",
    initialColumn: "todo",
    columns: [
      {
        name: "todo",
        kind: "resting",
        skills: [],
        requires: [],
        transitions: [{ to: "done" }],
      },
      {
        name: "done",
        kind: "terminal",
        skills: [],
        requires: [],
        transitions: [],
      },
    ],
  };

  it("decodes a definition file into defineBoard's payload, with no dry-run of its own", () => {
    const decoded = decodeDefinitionFile(JSON.stringify(FILE));
    expect(decoded).toEqual({ file: FILE });
  });

  /**
   * Mutation: decode with excess properties ignored — the misspelt `wiplimit` is dropped and the file
   * is sent. Mutation: accept `dryRun` from the file — `--dry-run` is not the only switch.
   */
  it("refuses a file that is not JSON, not a definition, or carries a key the schema does not name", () => {
    expect(decodeDefinitionFile("{ not json")).toHaveProperty("refused");
    const badKind = decodeDefinitionFile(
      JSON.stringify({
        ...FILE,
        columns: [{ ...FILE.columns[0], kind: "waiting" }],
      }),
    );
    expect("refused" in badKind && badKind.refused).toContain("kind");
    const misspelt = decodeDefinitionFile(
      JSON.stringify({
        ...FILE,
        columns: [{ ...FILE.columns[0], wiplimit: 2 }, FILE.columns[1]],
      }),
    );
    expect("refused" in misspelt && misspelt.refused).toContain("wiplimit");
    expect(
      decodeDefinitionFile(JSON.stringify({ ...FILE, dryRun: true })),
    ).toHaveProperty("refused");
    expect(
      decodeDefinitionFile(JSON.stringify({ ...FILE, id: "Not An Id" })),
    ).toHaveProperty("refused");
  });

  const described = Schema.decodeSync(DefinitionConfig)({
    id: "authored",
    version: 2,
    name: "Authored",
    initialColumn: "todo",
    columns: [done],
  });

  it("says what each outcome did, then describes the version", () => {
    const tail = definitionLines(described);
    expect(definedLines({ outcome: "created", definition: described })).toEqual(
      ["defined     authored v2", ...tail],
    );
    expect(
      definedLines({ outcome: "unchanged", definition: described }),
    ).toEqual([
      "unchanged   authored v2 already holds this definition; nothing written",
      ...tail,
    ]);
    expect(
      definedLines({ outcome: "validated", definition: described }),
    ).toEqual([
      "valid       authored would be written as v2; nothing written (--dry-run)",
      ...tail,
    ]);
  });

  it("prints a refusal's line, then every fault by field", () => {
    const refusal = new InvalidDefinition({
      definitionId: "authored",
      field: "initialColumn",
      problems: [
        { field: "initialColumn", message: "no initial column" },
        { field: "columns[1].role", message: "unknown role" },
      ],
      message:
        "definition authored: initialColumn: no initial column (and 1 more)",
    });
    expect(invalidDefinitionLines(refusal)).toEqual([
      "error: invalid_definition: definition authored: initialColumn: no initial column (and 1 more)",
      "  initialColumn: no initial column",
      "  columns[1].role: unknown role",
    ]);
  });
});
