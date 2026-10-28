import type {
  BoardColumn,
  BoardDefinition,
  ColumnKind,
  ColumnRequirement,
  ColumnTransition,
  DefineBoardInput,
  DefinitionFault,
  RequirementOption,
} from "@repo/domain/Task";
import { columnTransitions, initialColumnOf } from "@repo/domain/Task";
import { NONE } from "./board-settings-view";

/**
 * The definition editor (D6): `/boards/$boardId/settings/edit` turns the board's pinned version into
 * a draft, the person changes columns, kinds, roles, skills, requirements, moves and gates, and Save
 * sends the draft to `defineBoard` as a new version. The pinned version is never edited (B2): the
 * server writes newest + 1, and the board stays on its pin until it is upgraded.
 *
 * What the draft holds is the version's own columns, every field each carried kept, so a field this
 * editor has no control for — a WIP limit, the caps, a field a later change adds to the schema —
 * goes back to the server as it came rather than being dropped. A column the person adds starts
 * with the fields the schema requires and nothing else.
 *
 * Pure, so the rules a person depends on — a rename carries the moves that point at the column, a
 * picker offers nothing the server would refuse, a refusal lands next to the field it names, the
 * diff says what the save will change — are unit cases rather than something only a screenshot shows.
 */

/** One column of the draft: a stable key for the page, the base column it came from, and the column. */
export type DraftColumn = {
  readonly key: string;
  /** The pinned version's name for the column this one came from; absent for a column added here. */
  readonly origin?: string;
  readonly column: BoardColumn;
};

/** What the editor holds: the version's name, where a new card starts (`""` for none), its columns. */
export type DefinitionDraft = {
  readonly name: string;
  readonly initialColumn: string;
  readonly columns: ReadonlyArray<DraftColumn>;
};

/**
 * A version as a card on it behaves, spelled out: every column with the moves `columnTransitions`
 * gives it, and the initial column `initialColumnOf` resolves. Default versions 1–3 declare neither
 * (they are read through the default pipeline's table), and an authored version must declare both,
 * so a draft of one starts from what its cards meet — and the diff does not call that a change.
 */
export const materialize = (definition: BoardDefinition): BoardDefinition => {
  const initial = initialColumnOf(definition);
  return {
    ...definition,
    ...(initial === undefined ? {} : { initialColumn: initial }),
    columns: definition.columns.map((column) => ({
      ...column,
      transitions: columnTransitions(definition, column.name),
    })),
  };
};

/** The draft a pinned version opens as: its own columns, keyed in order, moves and initial spelled out. */
export const draftOf = (definition: BoardDefinition): DefinitionDraft => {
  const base = materialize(definition);
  return {
    name: base.name,
    initialColumn: base.initialColumn ?? "",
    columns: base.columns.map((column, index) => ({
      key: `c${index}`,
      origin: column.name,
      column,
    })),
  };
};

/**
 * The `defineBoard` payload a draft means, under the pinned version's id: every field the pinned
 * version carries but its version number (the server assigns one), with the draft's name, initial
 * column and columns over them. No initial column is sent absent, so the server's refusal names it.
 */
export const defineInputOf = (
  pinned: BoardDefinition,
  draft: DefinitionDraft,
): DefineBoardInput => {
  const { version: _version, initialColumn: _initial, ...kept } = pinned;
  return {
    ...kept,
    name: draft.name,
    columns: draft.columns.map((entry) => entry.column),
    ...(draft.initialColumn === ""
      ? {}
      : { initialColumn: draft.initialColumn }),
  };
};

const replaceColumn = (
  draft: DefinitionDraft,
  key: string,
  change: (column: BoardColumn) => BoardColumn,
): DefinitionDraft => ({
  ...draft,
  columns: draft.columns.map((entry) =>
    entry.key === key ? { ...entry, column: change(entry.column) } : entry,
  ),
});

/** How many of the draft's columns carry `name`: a rename follows a name only while it is unique. */
const named = (draft: DefinitionDraft, name: string): number =>
  draft.columns.filter((entry) => entry.column.name === name).length;

export const setName = (
  draft: DefinitionDraft,
  name: string,
): DefinitionDraft => ({ ...draft, name });

export const setInitialColumn = (
  draft: DefinitionDraft,
  initialColumn: string,
): DefinitionDraft => ({ ...draft, initialColumn });

/** The name a new column gets: `new_column`, then `new_column_2`, … — never one the draft holds. */
export const newColumnName = (draft: DefinitionDraft): string => {
  const taken = new Set(draft.columns.map((entry) => entry.column.name));
  if (!taken.has("new_column")) return "new_column";
  let n = 2;
  while (taken.has(`new_column_${n}`)) n += 1;
  return `new_column_${n}`;
};

/**
 * A new working column with no role, skills, requirements or moves, before the first terminal column
 * (the end, when there is none), so it lands in the pipeline rather than after `done`. Its moves are
 * the person's to declare: the server refuses a working column with none, next to the field.
 */
export const addColumn = (draft: DefinitionDraft): DefinitionDraft => {
  const used = draft.columns.map((entry) => Number(entry.key.slice(1)));
  const key = `c${Math.max(-1, ...used.filter(Number.isFinite)) + 1}`;
  const added: DraftColumn = {
    key,
    column: {
      name: newColumnName(draft),
      kind: "working",
      skills: [],
      requires: [],
      transitions: [],
    },
  };
  const at = draft.columns.findIndex(
    (entry) => entry.column.kind === "terminal",
  );
  const columns = [...draft.columns];
  columns.splice(at === -1 ? columns.length : at, 0, added);
  return { ...draft, columns };
};

/**
 * Removes a column, and every move into it with it — a move to a column the version no longer
 * declares is one the server would refuse. The initial column, when it was this one, becomes none:
 * the person picks another rather than this page picking one for them.
 */
export const removeColumn = (
  draft: DefinitionDraft,
  key: string,
): DefinitionDraft => {
  const removed = draft.columns.find((entry) => entry.key === key);
  if (removed === undefined) return draft;
  const name = removed.column.name;
  const unique = named(draft, name) === 1;
  return {
    ...draft,
    initialColumn:
      unique && draft.initialColumn === name ? "" : draft.initialColumn,
    columns: draft.columns
      .filter((entry) => entry.key !== key)
      .map((entry) =>
        unique
          ? {
              ...entry,
              column: {
                ...entry.column,
                transitions: (entry.column.transitions ?? []).filter(
                  (move) => move.to !== name,
                ),
              },
            }
          : entry,
      ),
  };
};

/** Moves a column one place up (`-1`) or down (`1`); at either end, nothing moves. */
export const moveColumn = (
  draft: DefinitionDraft,
  key: string,
  by: -1 | 1,
): DefinitionDraft => {
  const from = draft.columns.findIndex((entry) => entry.key === key);
  const to = from + by;
  if (from === -1 || to < 0 || to >= draft.columns.length) return draft;
  const columns = [...draft.columns];
  const [moved] = columns.splice(from, 1);
  if (moved === undefined) return draft;
  columns.splice(to, 0, moved);
  return { ...draft, columns };
};

/**
 * Renames a column. Every move into it, and the initial column when it was this one, follow the new
 * name while the old one is the column's alone; a name two columns share (a duplicate the person is
 * typing their way out of) is left where it points, since which column it meant is not known.
 */
export const renameColumn = (
  draft: DefinitionDraft,
  key: string,
  name: string,
): DefinitionDraft => {
  const entry = draft.columns.find((candidate) => candidate.key === key);
  if (entry === undefined) return draft;
  const old = entry.column.name;
  const follow = named(draft, old) === 1;
  return {
    ...draft,
    initialColumn:
      follow && draft.initialColumn === old ? name : draft.initialColumn,
    columns: draft.columns.map((candidate) => {
      const column =
        candidate.key === key
          ? { ...candidate.column, name }
          : candidate.column;
      return {
        ...candidate,
        column:
          follow && column.transitions !== undefined
            ? {
                ...column,
                transitions: column.transitions.map((move) =>
                  move.to === old ? { ...move, to: name } : move,
                ),
              }
            : column,
      };
    }),
  };
};

export const setKind = (
  draft: DefinitionDraft,
  key: string,
  kind: ColumnKind,
): DefinitionDraft =>
  replaceColumn(draft, key, (column) => ({ ...column, kind }));

/** Sets a column's role, or takes it away (`undefined`: the column runs on the deployment's model). */
export const setRole = (
  draft: DefinitionDraft,
  key: string,
  role: string | undefined,
): DefinitionDraft =>
  replaceColumn(draft, key, ({ role: _role, ...column }) =>
    role === undefined ? column : { ...column, role },
  );

export const addSkill = (
  draft: DefinitionDraft,
  key: string,
  skill: string,
): DefinitionDraft =>
  replaceColumn(draft, key, (column) =>
    column.skills.includes(skill)
      ? column
      : { ...column, skills: [...column.skills, skill] },
  );

export const removeSkill = (
  draft: DefinitionDraft,
  key: string,
  index: number,
): DefinitionDraft =>
  replaceColumn(draft, key, (column) => ({
    ...column,
    skills: column.skills.filter((_skill, at) => at !== index),
  }));

/** Requires a known key, with the vocabulary's description for it as the starting description. */
export const addRequirement = (
  draft: DefinitionDraft,
  key: string,
  option: RequirementOption,
): DefinitionDraft =>
  replaceColumn(draft, key, (column) =>
    column.requires.some((requirement) => requirement.key === option.key)
      ? column
      : {
          ...column,
          requires: [
            ...column.requires,
            { key: option.key, description: option.description },
          ],
        },
  );

export const removeRequirement = (
  draft: DefinitionDraft,
  key: string,
  index: number,
): DefinitionDraft =>
  replaceColumn(draft, key, (column) => ({
    ...column,
    requires: column.requires.filter((_requirement, at) => at !== index),
  }));

export const setRequirementDescription = (
  draft: DefinitionDraft,
  key: string,
  index: number,
  description: string,
): DefinitionDraft =>
  replaceColumn(draft, key, (column) => ({
    ...column,
    requires: column.requires.map((requirement, at) =>
      at === index ? { ...requirement, description } : requirement,
    ),
  }));

const replaceMoves = (
  draft: DefinitionDraft,
  key: string,
  change: (moves: ReadonlyArray<ColumnTransition>) => Array<ColumnTransition>,
): DefinitionDraft =>
  replaceColumn(draft, key, (column) => ({
    ...column,
    transitions: change(column.transitions ?? []),
  }));

/**
 * The columns a column's move `index` may point at: every other column of the draft that none of
 * its other moves already points at, in column order, and the move's own target whatever it is —
 * so the select always shows what the move holds. `index` past the moves is a new move's choices.
 */
export const targetOptions = (
  draft: DefinitionDraft,
  key: string,
  index: number,
): ReadonlyArray<string> => {
  const entry = draft.columns.find((candidate) => candidate.key === key);
  if (entry === undefined) return [];
  const moves = entry.column.transitions ?? [];
  const current = moves[index]?.to;
  const others = new Set(
    moves.filter((_move, at) => at !== index).map((move) => move.to),
  );
  const names = [
    ...new Set(draft.columns.map((candidate) => candidate.column.name)),
  ].filter(
    (name) =>
      name === current || (name !== entry.column.name && !others.has(name)),
  );
  return current === undefined || names.includes(current)
    ? names
    : [current, ...names];
};

/** Adds a move to the first column the column can still move to; with none left, nothing. */
export const addTransition = (
  draft: DefinitionDraft,
  key: string,
): DefinitionDraft => {
  const entry = draft.columns.find((candidate) => candidate.key === key);
  const to = targetOptions(
    draft,
    key,
    entry?.column.transitions?.length ?? 0,
  )[0];
  return to === undefined
    ? draft
    : replaceMoves(draft, key, (moves) => [...moves, { to }]);
};

export const removeTransition = (
  draft: DefinitionDraft,
  key: string,
  index: number,
): DefinitionDraft =>
  replaceMoves(draft, key, (moves) =>
    moves.filter((_move, at) => at !== index),
  );

export const setTransitionTarget = (
  draft: DefinitionDraft,
  key: string,
  index: number,
  to: string,
): DefinitionDraft =>
  replaceMoves(draft, key, (moves) =>
    moves.map((move, at) => (at === index ? { ...move, to } : move)),
  );

/**
 * Names the human gate a move crosses, or takes it away: a blank name is no gate, so the move is
 * one a run may make too (B5). A gate is a name a person reads on the card, so it is typed.
 */
export const setTransitionGate = (
  draft: DefinitionDraft,
  key: string,
  index: number,
  gate: string,
): DefinitionDraft =>
  replaceMoves(draft, key, (moves) =>
    moves.map((move, at) => {
      if (at !== index) return move;
      const { gate: _gate, ...rest } = move;
      return gate.trim() === "" ? rest : { ...rest, gate };
    }),
  );

/** The skills a column may still bind: every name `listSkills` answers that it does not, sorted. */
export const skillOptions = (
  library: ReadonlyArray<string>,
  column: BoardColumn,
): ReadonlyArray<string> =>
  [...new Set(library)]
    .filter((skill) => !column.skills.includes(skill))
    .toSorted();

/** The requirement keys a column may still declare: the vocabulary's, less the ones it requires. */
export const requirementOptions = (
  vocabulary: ReadonlyArray<RequirementOption>,
  column: BoardColumn,
): ReadonlyArray<RequirementOption> =>
  vocabulary.filter(
    (option) =>
      !column.requires.some((requirement) => requirement.key === option.key),
  );

/** The roles a column may name: the vocabulary's, and the column's own whatever it is, sorted. */
export const roleOptions = (
  roles: ReadonlyArray<string>,
  column: BoardColumn,
): ReadonlyArray<string> =>
  [
    ...new Set(column.role === undefined ? roles : [...roles, column.role]),
  ].toSorted();

/** One line of the diff: added (`+`), removed (`-`) or changed (`~`), and what. */
export type DiffLine = {
  readonly sign: "+" | "-" | "~";
  readonly text: string;
};

/** A value in a diff line: a string quoted, anything else as JSON, absent as "—". */
const shown = (value: unknown): string =>
  value === undefined
    ? NONE
    : typeof value === "string"
      ? `"${value}"`
      : JSON.stringify(value);

/** Equal as declared: key order and absent fields do not count, array order does (as `defineBoard`). */
const sameValue = (a: unknown, b: unknown): boolean =>
  canonical(a) === canonical(b);

const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, field: unknown) =>
    field !== null && typeof field === "object" && !Array.isArray(field)
      ? Object.fromEntries(
          Object.entries(field)
            .filter(([, entry]) => entry !== undefined)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        )
      : field,
  );

const requirementList = (requires: ReadonlyArray<ColumnRequirement>) =>
  requires.map((requirement) => requirement.key).join(", ");

const moveText = (move: ColumnTransition): string =>
  move.gate === undefined
    ? `move to "${move.to}"`
    : `move to "${move.to}" across the gate "${move.gate}"`;

/** What an added column declares, in one line. */
const addedText = (column: BoardColumn): string => {
  const parts = [
    column.kind,
    ...(column.role === undefined ? [] : [`role ${column.role}`]),
    ...(column.skills.length === 0
      ? []
      : [`skills ${column.skills.join(", ")}`]),
    ...(column.requires.length === 0
      ? []
      : [`requires ${requirementList(column.requires)}`]),
    ...((column.transitions ?? []).length === 0
      ? ["no moves out"]
      : [
          `moves to ${(column.transitions ?? []).map((move) => move.to).join(", ")}`,
        ]),
  ];
  return `column "${column.name}" (${parts.join("; ")})`;
};

const COLUMN_FIELDS: ReadonlySet<string> = new Set([
  "name",
  "kind",
  "role",
  "skills",
  "requires",
  "transitions",
]);

/** The changes inside one column the draft kept, `renamed` mapping the base's names to the draft's. */
const columnDiff = (
  before: BoardColumn,
  after: BoardColumn,
  renamed: (name: string) => string,
): Array<DiffLine> => {
  const lines: Array<DiffLine> = [];
  const at = `"${after.name}"`;
  if (before.kind !== after.kind)
    lines.push({
      sign: "~",
      text: `${at} kind: ${before.kind} → ${after.kind}`,
    });
  if (before.role !== after.role)
    lines.push({
      sign: "~",
      text: `${at} role: ${before.role ?? NONE} → ${after.role ?? NONE}`,
    });
  for (const skill of before.skills)
    if (!after.skills.includes(skill))
      lines.push({ sign: "-", text: `${at} skill ${skill}` });
  for (const skill of after.skills)
    if (!before.skills.includes(skill))
      lines.push({ sign: "+", text: `${at} skill ${skill}` });
  for (const requirement of before.requires) {
    const kept = after.requires.find(
      (candidate) => candidate.key === requirement.key,
    );
    if (kept === undefined)
      lines.push({ sign: "-", text: `${at} requires ${requirement.key}` });
    else if (kept.description !== requirement.description)
      lines.push({
        sign: "~",
        text: `${at} requires ${requirement.key}: ${shown(requirement.description)} → ${shown(kept.description)}`,
      });
  }
  for (const requirement of after.requires)
    if (!before.requires.some((candidate) => candidate.key === requirement.key))
      lines.push({ sign: "+", text: `${at} requires ${requirement.key}` });
  const beforeMoves = (before.transitions ?? []).map((move) => ({
    ...move,
    to: renamed(move.to),
  }));
  const afterMoves = after.transitions ?? [];
  for (const move of beforeMoves) {
    const kept = afterMoves.find((candidate) => candidate.to === move.to);
    if (kept === undefined)
      lines.push({ sign: "-", text: `${at} ${moveText(move)}` });
    else if (kept.gate !== move.gate)
      lines.push({
        sign: "~",
        text: `${at} move to "${move.to}": gate ${shown(move.gate)} → ${shown(kept.gate)}`,
      });
  }
  for (const move of afterMoves)
    if (!beforeMoves.some((candidate) => candidate.to === move.to))
      lines.push({ sign: "+", text: `${at} ${moveText(move)}` });
  const keptTargets = afterMoves
    .map((move) => move.to)
    .filter((to) => beforeMoves.some((move) => move.to === to));
  const wasOrder = beforeMoves
    .map((move) => move.to)
    .filter((to) => keptTargets.includes(to));
  if (!sameValue(wasOrder, keptTargets))
    lines.push({
      sign: "~",
      text: `${at} moves reordered: ${wasOrder.join(", ")} → ${keptTargets.join(", ")}`,
    });
  // Every other field — a WIP limit, a field this editor has no control for — compared as declared.
  const others = [
    ...new Set([...Object.keys(before), ...Object.keys(after)]),
  ].filter((field) => !COLUMN_FIELDS.has(field));
  for (const field of others.toSorted()) {
    const was = (before as Record<string, unknown>)[field];
    const now = (after as Record<string, unknown>)[field];
    if (!sameValue(was, now))
      lines.push({
        sign: "~",
        text: `${at} ${field}: ${shown(was)} → ${shown(now)}`,
      });
  }
  return lines;
};

/**
 * What saving the draft would change against the board's pinned version, line by line: the name,
 * the initial column, columns added, removed, renamed and reordered, and inside each column its
 * kind, role, skills, requirements, moves and gates, and any other field. Columns are matched by
 * where they came from, not by name, so a rename is one line rather than a removal and an addition.
 * Empty when the draft declares exactly what the pinned version does — the save would add nothing.
 */
export const definitionDiff = (
  pinned: BoardDefinition,
  draft: DefinitionDraft,
): ReadonlyArray<DiffLine> => {
  const base = materialize(pinned);
  const lines: Array<DiffLine> = [];
  if (base.name !== draft.name)
    lines.push({
      sign: "~",
      text: `name: ${shown(base.name)} → ${shown(draft.name)}`,
    });
  const renames = new Map(
    draft.columns.flatMap((entry) =>
      entry.origin === undefined
        ? []
        : [[entry.origin, entry.column.name] as const],
    ),
  );
  const renamed = (name: string) => renames.get(name) ?? name;
  const wasInitial = base.initialColumn ?? "";
  if (renamed(wasInitial) !== draft.initialColumn)
    lines.push({
      sign: "~",
      text: `new cards start in: ${wasInitial === "" ? NONE : wasInitial} → ${draft.initialColumn === "" ? NONE : draft.initialColumn}`,
    });
  for (const column of base.columns)
    if (!draft.columns.some((entry) => entry.origin === column.name))
      lines.push({ sign: "-", text: `column "${column.name}"` });
  for (const entry of draft.columns) {
    if (entry.origin === undefined) {
      lines.push({ sign: "+", text: addedText(entry.column) });
      continue;
    }
    const before = base.columns.find((column) => column.name === entry.origin);
    if (before === undefined) continue;
    if (before.name !== entry.column.name)
      lines.push({
        sign: "~",
        text: `column "${before.name}" renamed to "${entry.column.name}"`,
      });
    lines.push(...columnDiff(before, entry.column, renamed));
  }
  const keptOrder = draft.columns
    .filter((entry) => entry.origin !== undefined)
    .map((entry) => entry.column.name);
  const wasOrder = base.columns
    .filter((column) =>
      draft.columns.some((entry) => entry.origin === column.name),
    )
    .map((column) => renamed(column.name));
  if (!sameValue(wasOrder, keptOrder))
    lines.push({
      sign: "~",
      text: `column order: ${wasOrder.join(", ")} → ${keptOrder.join(", ")}`,
    });
  return lines;
};

/**
 * The slot a column's fault is shown in: the column itself, or one of its fields or rows. A fault of
 * the definition's own `name`, `initialColumn` or `columns` is shown in the slot of that name.
 */
export const columnSlot = (key: string, path?: string): string =>
  path === undefined ? `column:${key}` : `column:${key}:${path}`;

/** Where the refusal's faults are shown: by slot, and the ones no field on the page can hold. */
export type PlacedFaults = {
  readonly slots: ReadonlyMap<string, ReadonlyArray<DefinitionFault>>;
  readonly unplaced: ReadonlyArray<DefinitionFault>;
};

const COLUMN_FAULT = /^columns\[(\d+)\](?:\.(.+))?$/;
const ROW_FAULT = /^(transitions|requires|skills)\[(\d+)\]/;

/**
 * Places the server's faults next to the field each names. A fault's path is into the version as it
 * was sent, so its column index is read against the keys the draft held then (`sent`): a column the
 * person moved since keeps its fault, and one they removed has its fault shown above the editor.
 *
 * - `name`, `initialColumn` and `columns` are the definition's fields;
 * - `columns[i].name` / `.kind` / `.role` / `.transitions` / `.requires` / `.skills` are the column's;
 * - a row — `transitions[j].to`, `requires[j].key`, `skills[j]` — is its row while the column still
 *   has one at `j`, else the list it was in;
 * - anything else of a column (a WIP limit, a field this editor has no control for) is the column's.
 */
export const placeFaults = (
  faults: ReadonlyArray<DefinitionFault>,
  sent: ReadonlyArray<string>,
  draft: DefinitionDraft,
): PlacedFaults => {
  const slots = new Map<string, Array<DefinitionFault>>();
  const unplaced: Array<DefinitionFault> = [];
  const put = (slot: string, fault: DefinitionFault) =>
    slots.set(slot, [...(slots.get(slot) ?? []), fault]);
  for (const fault of faults) {
    if (
      fault.field === "name" ||
      fault.field === "initialColumn" ||
      fault.field === "columns"
    ) {
      put(fault.field, fault);
      continue;
    }
    const match = COLUMN_FAULT.exec(fault.field);
    const key = match === null ? undefined : sent[Number(match[1])];
    const entry =
      key === undefined
        ? undefined
        : draft.columns.find((candidate) => candidate.key === key);
    if (match === null || entry === undefined) {
      unplaced.push(fault);
      continue;
    }
    const path = match[2];
    if (path === undefined) {
      put(columnSlot(entry.key), fault);
      continue;
    }
    if (COLUMN_FIELDS.has(path)) {
      put(columnSlot(entry.key, path), fault);
      continue;
    }
    const row = ROW_FAULT.exec(path);
    if (row === null) {
      put(columnSlot(entry.key), fault);
      continue;
    }
    const list = row[1];
    const index = Number(row[2]);
    const length =
      list === "transitions"
        ? (entry.column.transitions ?? []).length
        : list === "requires"
          ? entry.column.requires.length
          : entry.column.skills.length;
    put(
      columnSlot(entry.key, index < length ? `${list}[${index}]` : list),
      fault,
    );
  }
  return { slots, unplaced };
};

/** A refused save: which refusal, the server's message, and the faults it named (`InvalidDefinition`). */
export type DefineRefusal = {
  readonly tag: string;
  readonly message: string;
  readonly faults: ReadonlyArray<DefinitionFault>;
};

/**
 * What a failed `defineBoard` shows. `InvalidDefinition` carries every fault, each placed next to its
 * field; any other typed refusal (a storage error) is the server's words; anything else (a dropped
 * connection) falls back to the cause.
 */
export const defineRefusal = (
  error:
    | {
        readonly _tag: string;
        readonly message: string;
        readonly problems?: ReadonlyArray<DefinitionFault>;
      }
    | undefined,
  fallback: string,
): DefineRefusal =>
  error === undefined || error.message.length === 0
    ? { tag: error?._tag ?? "Unknown", message: fallback, faults: [] }
    : {
        tag: error._tag,
        message: error.message,
        faults:
          error._tag === "InvalidDefinition" ? (error.problems ?? []) : [],
      };

/**
 * What the page says once the save answered: a version written is "v<n> created", and the board
 * stays on its pin (B2) — only a board made now, or an upgrade, reaches the new one. Content the
 * newest version already holds wrote nothing, and the page says which version holds it.
 */
export const savedNotice = (
  outcome: "created" | "unchanged" | "validated",
  version: number,
  pinned: number,
): string =>
  outcome === "unchanged"
    ? `No new version: v${version} already holds exactly this.`
    : outcome === "validated"
      ? `v${version} would be created.`
      : `v${version} created. This board stays pinned to v${pinned} until it is upgraded; a board created now pins v${version}.`;
