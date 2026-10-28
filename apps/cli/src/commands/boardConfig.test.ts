/**
 * The lines `factory board list|definitions|definition show|config` print (LOB-270). The commands
 * themselves are proven against a real control plane by `.pi/skills/verify-board/definitions.sh`;
 * these cases pin the layout a pane capture would not localize: a column with no role prints `—`, a
 * requirement says `checked` or `unchecked`, a gated exit names its gate, and a second requirement
 * lines up under the first.
 */
import { Schema } from "effect";
import {
  BoardDefinition,
  BoardInstance,
  ColumnConfig,
  DefinitionConfig,
  DefinitionSummary,
  DefinitionVocabulary,
  InvalidDefinition,
  LIST_BOARDS_LIMIT,
  definitionSourceOf,
} from "@repo/domain/Task";
import { describe, expect, it } from "vitest";
import {
  boardLine,
  boardListLines,
  columnLines,
  decodeDefinitionFile,
  definedLines,
  definitionFileText,
  definitionLines,
  definitionsLines,
  invalidDefinitionLines,
  vocabularyLines,
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

  /** Mutation: print only the column's gates, or drop the source — `npm publish` reads as the column's. */
  it("prints a column's effective autonomy: each gate and whose it is, and its write and push scope (C22)", () => {
    const careful = Schema.decodeSync(ColumnConfig)({
      ...Schema.encodeSync(ColumnConfig)(done),
      name: "careful",
      autonomy: {
        approvalRequired: [
          { command: "npm publish", source: "deployment" },
          { command: "git push", source: "column" },
        ],
        write: "docs",
        push: "none",
      },
    });
    expect(columnLines(careful).slice(-3)).toEqual([
      "  asks      npm publish (deployment), git push (column)",
      "  writes    documentation only",
      "  pushes    nothing",
    ]);
    const open = Schema.decodeSync(ColumnConfig)({
      ...Schema.encodeSync(ColumnConfig)(done),
      autonomy: { approvalRequired: [], write: "worktree", push: "branch" },
    });
    expect(columnLines(open).slice(-3)).toEqual([
      "  asks      —",
      "  writes    its worktree",
      "  pushes    its own branch",
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

/** Who wrote a version (F7): named when someone did, absent for a seeded version. */
describe("a definition version's author (F7)", () => {
  /** Mutation: print `by ` with an empty name, or print it for a seeded version — absent must read as absent. */
  it("names the author last on a definitions line, and prints nothing for a seeded version", () => {
    const definitions = Schema.decodeSync(Schema.Array(DefinitionSummary))([
      {
        id: "default",
        versions: [
          {
            version: 1,
            name: "Seeded",
            createdAt: "2026-10-01T00:00:00.000Z",
          },
          {
            version: 2,
            name: "Authored",
            createdAt: "2026-10-02T00:00:00.000Z",
            author: "alice",
          },
        ],
      },
    ]);
    expect(definitionsLines(definitions)).toEqual([
      "default  v1  Seeded  2026-10-01T00:00:00.000Z",
      "default  v2  Authored  2026-10-02T00:00:00.000Z  by alice",
    ]);
  });

  it("prints an author line under the definition header only when the version has one", () => {
    const base = {
      id: "authored",
      version: 2,
      name: "Authored",
      initialColumn: "done",
      columns: [done],
    };
    const authored = definitionLines(
      Schema.decodeSync(DefinitionConfig)({ ...base, author: "alice" }),
    );
    expect(authored.slice(0, 3)).toEqual([
      "definition  authored v2  Authored",
      "author      alice",
      "initial     done",
    ]);
    expect(
      definitionLines(Schema.decodeSync(DefinitionConfig)(base)).some((line) =>
        line.startsWith("author"),
      ),
    ).toBe(false);
  });
});

/** `factory board vocabulary` (F5): every key and role the server answered, marked as the RPC marks them. */
describe("vocabularyLines (F5)", () => {
  const vocabulary = Schema.decodeSync(DefinitionVocabulary)({
    requirements: [
      {
        key: "pr_link",
        description: "a PR link",
        checked: true,
        humanGate: false,
      },
      {
        key: "plan_doc",
        description: "a plan doc",
        checked: false,
        humanGate: false,
      },
      {
        key: "merge",
        description: "a person merges",
        checked: false,
        humanGate: true,
      },
      {
        key: "human_merge",
        description: "the PR merged",
        checked: true,
        humanGate: true,
      },
    ],
    roles: ["planner", "reviewer"],
  });

  /**
   * Mutation: drop the `[human gate]` marker, swap checked and unchecked, or print only the keys
   * and not the roles — each fails a line below.
   */
  it("prints one line per requirement key, marking checked and human-gate keys, then one per role", () => {
    expect(vocabularyLines(vocabulary)).toEqual([
      "requirement  pr_link  checked  a PR link",
      "requirement  plan_doc  unchecked  a plan doc",
      "requirement  merge  unchecked  [human gate]  a person merges",
      "requirement  human_merge  checked  [human gate]  the PR merged",
      "role  planner",
      "role  reviewer",
    ]);
  });

  it("prints nothing for an empty vocabulary", () => {
    expect(vocabularyLines({ requirements: [], roles: [] })).toEqual([]);
  });
});

/**
 * `factory board definition show --json` (F8): the file text for a version, which `board define`
 * decodes — with excess properties refused — back to the same definition.
 */
describe("definitionFileText (F8)", () => {
  const column = (name: string, kind: string, extra: object = {}) => ({
    name,
    kind,
    skills: [],
    requires: [],
    ...extra,
  });

  /** A legacy version: no moves, no initial column, and a field the file must not carry. */
  const legacy = Schema.decodeSync(BoardDefinition)({
    id: "default",
    version: 2,
    name: "Legacy",
    author: "alice",
    columns: [
      column("intake", "resting"),
      column("specifying", "working", { wipLimit: 2 }),
      column("planning", "working", {
        autonomy: { approvalRequired: ["npm publish"], push: "none" },
      }),
      column("building", "working"),
      column("review", "resting"),
      column("done", "terminal"),
      column("canceled", "terminal"),
    ],
  });

  it("is a file `define` decodes, with the moves and the initial column a legacy version leaves implicit spelled out", () => {
    const text = definitionFileText(definitionSourceOf(legacy));
    const decoded = decodeDefinitionFile(text);
    expect(decoded).toHaveProperty("file");
    const file = "file" in decoded ? decoded.file : undefined;
    expect(file?.initialColumn).toBe("intake");
    expect(
      file?.columns.map((entry) => entry.transitions?.map((m) => m.to)),
    ).toEqual([
      ["specifying", "canceled"],
      ["planning", "canceled"],
      ["building", "canceled"],
      ["review", "canceled"],
      ["done", "canceled"],
      [],
      [],
    ]);
    // Fields the column declares come back as declared, not as the deployment resolves them.
    expect(file?.columns[1]?.wipLimit).toBe(2);
    expect(file?.columns[2]?.autonomy).toEqual({
      approvalRequired: ["npm publish"],
      push: "none",
    });
  });

  /** Mutation: emit the described `version` or `author` — `define` refuses unknown keys, so the file would not load. */
  it("names no key `define` would refuse: no version, no author, no actor", () => {
    const parsed: unknown = JSON.parse(
      definitionFileText(definitionSourceOf(legacy)),
    );
    expect(Object.keys(parsed as object).toSorted()).toEqual([
      "columns",
      "id",
      "initialColumn",
      "name",
    ]);
    expect(
      decodeDefinitionFile(
        JSON.stringify({ ...(parsed as object), version: 2 }),
      ),
    ).toHaveProperty("refused");
    expect(
      decodeDefinitionFile(
        JSON.stringify({ ...(parsed as object), author: "alice" }),
      ),
    ).toHaveProperty("refused");
    expect(
      decodeDefinitionFile(
        JSON.stringify({ ...(parsed as object), actor: "alice" }),
      ),
    ).toHaveProperty("refused");
  });

  it("is a fixed point: a version that declares its moves and caps is emitted as it is, and decodes to itself", () => {
    const authored = Schema.decodeSync(BoardDefinition)({
      id: "authored",
      version: 3,
      name: "Authored",
      initialColumn: "todo",
      caps: { board: 2 },
      columns: [
        column("todo", "resting", {
          transitions: [{ to: "done", gate: "merge" }],
        }),
        column("done", "terminal", { transitions: [] }),
      ],
    });
    const source = definitionSourceOf(authored);
    expect(source.columns).toEqual(authored.columns);
    expect(source.caps).toEqual({ board: 2 });
    const decoded = decodeDefinitionFile(definitionFileText(source));
    expect(decoded).toEqual({ file: source });
  });
});
