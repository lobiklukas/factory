import type {
  BoardCaps,
  BoardColumn,
  BoardDefinition,
  ColumnAutonomy,
  ColumnKind,
  ColumnPushScope,
  ColumnRequirement,
  ColumnTransition,
  ColumnWriteScope,
  DefineBoardInput,
  DefinitionFault,
  DefinitionVocabulary,
  RequirementOption,
} from "@repo/domain/Task";
import { RunCap, columnTransitions, initialColumnOf } from "@repo/domain/Task";
import { Result, Schema } from "effect";
import { NONE } from "./board-settings-view";

/**
 * The definition editor (D6): `/boards/$boardId/settings/edit` turns the board's pinned version into
 * a draft, the person changes columns, kinds, roles, skills, requirements, moves and gates, each
 * column's autonomy and WIP limit and the version's run caps, and Save sends the draft to
 * `defineBoard` as a new version. The pinned version is never edited (B2): the
 * server writes newest + 1, and the board stays on its pin until it is upgraded.
 *
 * What the draft holds is the version's own columns, every field each carried kept, so a field this
 * editor has no control for — a field a later change adds to the schema — goes back to the server as
 * it came rather than being dropped. A column the person adds starts
 * with the fields the schema requires and nothing else.
 *
 * Pure, so the rules a person depends on — a rename carries the moves that point at the column, a
 * picker offers nothing the server would refuse, a refusal lands next to the field it names, the
 * diff says what the save will change — are unit cases rather than something only a screenshot shows.
 */

/**
 * One column of the draft: a stable key for the page, the base column it came from, the column, and
 * the column each of its moves points at, by key.
 */
export type DraftColumn = {
  readonly key: string;
  /** The pinned version's name for the column this one came from; absent for a column added here. */
  readonly origin?: string;
  readonly column: BoardColumn;
  /**
   * The draft key of the column each of `column.transitions` points at, in the same order, or
   * `undefined` for a move to a name no column of the draft held. A move follows its column by key,
   * never by name, so a rename typed through another column's name (`review` → `review_2` passing
   * `review`) leaves every move pointing where it pointed; the move's `to` is that column's name.
   */
  readonly targets: ReadonlyArray<string | undefined>;
};

/**
 * What the editor holds: the version's name, where a new card starts (`""` for none) and the key of
 * that column (`undefined` for none, or a name no column holds), its columns, and the version's run
 * caps (`undefined` for a version that declares none).
 */
export type DefinitionDraft = {
  readonly name: string;
  readonly initialColumn: string;
  readonly initialKey: string | undefined;
  readonly columns: ReadonlyArray<DraftColumn>;
  readonly caps: BoardCaps | undefined;
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

/** The key of the first column of the draft named `name`, or `undefined` when none is. */
const keyNamed = (
  columns: ReadonlyArray<{
    readonly key: string;
    readonly column: BoardColumn;
  }>,
  name: string,
): string | undefined =>
  columns.find((entry) => entry.column.name === name)?.key;

/** The draft a pinned version opens as: its own columns, keyed in order, moves and initial spelled out. */
export const draftOf = (definition: BoardDefinition): DefinitionDraft => {
  const base = materialize(definition);
  const keyed = base.columns.map((column, index) => ({
    key: `c${index}`,
    origin: column.name,
    column,
  }));
  const initialColumn = base.initialColumn ?? "";
  return {
    name: base.name,
    initialColumn,
    initialKey:
      initialColumn === "" ? undefined : keyNamed(keyed, initialColumn),
    caps: base.caps,
    columns: keyed.map((entry) => ({
      ...entry,
      targets: (entry.column.transitions ?? []).map((move) =>
        keyNamed(keyed, move.to),
      ),
    })),
  };
};

/**
 * The `defineBoard` payload a draft means, under the pinned version's id: every field the pinned
 * version carries but its version number (the server assigns one), with the draft's name, initial
 * column, columns and caps over them. No initial column is sent absent, so the server's refusal names it.
 */
export const defineInputOf = (
  pinned: BoardDefinition,
  draft: DefinitionDraft,
): DefineBoardInput => {
  const {
    version: _version,
    initialColumn: _initial,
    caps: _caps,
    ...kept
  } = pinned;
  return {
    ...kept,
    name: draft.name,
    columns: draft.columns.map((entry) => entry.column),
    ...(draft.initialColumn === ""
      ? {}
      : { initialColumn: draft.initialColumn }),
    ...(draft.caps === undefined ? {} : { caps: draft.caps }),
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

export const setName = (
  draft: DefinitionDraft,
  name: string,
): DefinitionDraft => ({ ...draft, name });

/** Picks where a new card starts, by name (`""` for none); the pick follows that column's renames. */
export const setInitialColumn = (
  draft: DefinitionDraft,
  initialColumn: string,
): DefinitionDraft => ({
  ...draft,
  initialColumn,
  initialKey:
    initialColumn === ""
      ? undefined
      : draft.initialColumn === initialColumn && draft.initialKey !== undefined
        ? draft.initialKey
        : keyNamed(draft.columns, initialColumn),
});

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
    targets: [],
  };
  const at = draft.columns.findIndex(
    (entry) => entry.column.kind === "terminal",
  );
  const columns = [...draft.columns];
  columns.splice(at === -1 ? columns.length : at, 0, added);
  return { ...draft, columns };
};

/** One move of a column with the key of the column it points at: what every move edit works on. */
type KeyedMove = {
  readonly move: ColumnTransition;
  readonly target: string | undefined;
};

const keyedMoves = (entry: DraftColumn): Array<KeyedMove> =>
  (entry.column.transitions ?? []).map((move, at) => ({
    move,
    target: entry.targets[at],
  }));

/** The column with its moves replaced, `to` and `targets` written together so they never drift. */
const withMoves = (
  entry: DraftColumn,
  moves: ReadonlyArray<KeyedMove>,
): DraftColumn => ({
  ...entry,
  column: { ...entry.column, transitions: moves.map(({ move }) => move) },
  targets: moves.map(({ target }) => target),
});

/**
 * Removes a column, and every move into it with it — a move to a column the version no longer
 * declares is one the server would refuse. The initial column, when it was this one, becomes none:
 * the person picks another rather than this page picking one for them. Moves and the initial column
 * are matched by key, so a column that shares the removed one's name keeps the moves into it.
 */
export const removeColumn = (
  draft: DefinitionDraft,
  key: string,
): DefinitionDraft => {
  if (!draft.columns.some((entry) => entry.key === key)) return draft;
  const wasInitial = draft.initialKey === key;
  return {
    ...draft,
    initialColumn: wasInitial ? "" : draft.initialColumn,
    initialKey: wasInitial ? undefined : draft.initialKey,
    columns: draft.columns
      .filter((entry) => entry.key !== key)
      .map((entry) =>
        entry.targets.includes(key)
          ? withMoves(
              entry,
              keyedMoves(entry).filter(({ target }) => target !== key),
            )
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
 * name — matched by the column's key, not its old name, so a name typed on the way that another
 * column holds (`review` → `done_review` passes `done`) never re-points a move at that other column.
 */
export const renameColumn = (
  draft: DefinitionDraft,
  key: string,
  name: string,
): DefinitionDraft => {
  if (!draft.columns.some((candidate) => candidate.key === key)) return draft;
  return {
    ...draft,
    initialColumn: draft.initialKey === key ? name : draft.initialColumn,
    columns: draft.columns.map((candidate) => {
      const renamed =
        candidate.key === key
          ? { ...candidate, column: { ...candidate.column, name } }
          : candidate;
      return renamed.targets.includes(key)
        ? withMoves(
            renamed,
            keyedMoves(renamed).map((keyed) =>
              keyed.target === key
                ? { ...keyed, move: { ...keyed.move, to: name } }
                : keyed,
            ),
          )
        : renamed;
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

/** The one cap kinds `BoardCaps` defines, in the order the page lists them. */
export const CAP_KINDS = ["board", "task", "repo"] as const;
export type CapKind = (typeof CAP_KINDS)[number];

/**
 * A number field's text as a limit: empty is no limit (`undefined`), anything else the number it
 * reads as — whatever it is, so a `0`, a negative or a fraction reaches the server, which refuses it
 * beside the field rather than this page guessing what a limit may be. Text that is no number at all
 * (a browser's number field answers `""` for one) is no limit.
 */
export const parseLimit = (text: string): number | undefined => {
  if (text.trim() === "") return undefined;
  const value = Number(text);
  return Number.isFinite(value) ? value : undefined;
};

/** Sets a column's WIP limit, or takes it away (`undefined`: no limit). */
export const setWipLimit = (
  draft: DefinitionDraft,
  key: string,
  limit: number | undefined,
): DefinitionDraft =>
  replaceColumn(draft, key, ({ wipLimit: _limit, ...column }) =>
    limit === undefined ? column : { ...column, wipLimit: limit },
  );

/**
 * Sets one of the version's run caps, or takes it away. With no cap left the version has none: `caps`
 * is absent, not `{}`, as a version written before caps existed holds it.
 */
export const setCap = (
  draft: DefinitionDraft,
  kind: CapKind,
  limit: number | undefined,
): DefinitionDraft => {
  const { [kind]: _was, ...others } = draft.caps ?? {};
  const caps: BoardCaps =
    limit === undefined ? others : { ...others, [kind]: limit };
  return { ...draft, caps: Object.keys(caps).length === 0 ? undefined : caps };
};

/**
 * A column's autonomy after a change (C22): with no gate, scope or push left it is absent, so a
 * column put back to the deployment's policy is the column of a version written before the field
 * existed. Anything else in it (a field a later change adds) is kept as it came.
 */
const withAutonomy = (
  column: BoardColumn,
  change: (autonomy: ColumnAutonomy) => ColumnAutonomy,
): BoardColumn => {
  const { autonomy: _was, ...rest } = column;
  const next = change(column.autonomy ?? {});
  return Object.keys(next).length === 0 ? rest : { ...rest, autonomy: next };
};

/** Sets where a column's runs may write, or takes it away (`undefined`: the deployment's policy). */
export const setWriteScope = (
  draft: DefinitionDraft,
  key: string,
  write: ColumnWriteScope | undefined,
): DefinitionDraft =>
  replaceColumn(draft, key, (column) =>
    withAutonomy(column, ({ write: _write, ...rest }) =>
      write === undefined ? rest : { ...rest, write },
    ),
  );

/** Sets which refs a column's runs may push, or takes it away (`undefined`: the deployment's policy). */
export const setPushScope = (
  draft: DefinitionDraft,
  key: string,
  push: ColumnPushScope | undefined,
): DefinitionDraft =>
  replaceColumn(draft, key, (column) =>
    withAutonomy(column, ({ push: _push, ...rest }) =>
      push === undefined ? rest : { ...rest, push },
    ),
  );

/** The approval gates a column declares: command prefixes a run asks a person before running. */
export const gatesOf = (column: BoardColumn): ReadonlyArray<string> =>
  column.autonomy?.approvalRequired ?? [];

const withGates = (
  column: BoardColumn,
  change: (gates: ReadonlyArray<string>) => ReadonlyArray<string>,
): BoardColumn =>
  withAutonomy(column, ({ approvalRequired, ...rest }) => {
    const gates = change(approvalRequired ?? []);
    return gates.length === 0 ? rest : { ...rest, approvalRequired: gates };
  });

/**
 * Adds an approval gate, blank: the person types it next to the row. A blank one is the server's to
 * refuse (it would be a gate the author believes in and nothing holds), shown by its field.
 */
export const addGate = (draft: DefinitionDraft, key: string): DefinitionDraft =>
  replaceColumn(draft, key, (column) =>
    withGates(column, (gates) => [...gates, ""]),
  );

export const setGate = (
  draft: DefinitionDraft,
  key: string,
  index: number,
  gate: string,
): DefinitionDraft =>
  replaceColumn(draft, key, (column) =>
    withGates(column, (gates) =>
      gates.map((was, at) => (at === index ? gate : was)),
    ),
  );

export const removeGate = (
  draft: DefinitionDraft,
  key: string,
  index: number,
): DefinitionDraft =>
  replaceColumn(draft, key, (column) =>
    withGates(column, (gates) => gates.filter((_gate, at) => at !== index)),
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
  change: (moves: Array<KeyedMove>) => Array<KeyedMove>,
): DefinitionDraft => ({
  ...draft,
  columns: draft.columns.map((entry) =>
    entry.key === key ? withMoves(entry, change(keyedMoves(entry))) : entry,
  ),
});

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
    : replaceMoves(draft, key, (moves) => [
        ...moves,
        { move: { to }, target: keyNamed(draft.columns, to) },
      ]);
};

export const removeTransition = (
  draft: DefinitionDraft,
  key: string,
  index: number,
): DefinitionDraft =>
  replaceMoves(draft, key, (moves) =>
    moves.filter((_keyed, at) => at !== index),
  );

/**
 * Points a move at the column named `to`. The move keeps the column it held when that one still
 * carries the name; otherwise it points at the first column so named (a name two columns share is
 * one the server refuses, so the person renames one of them before the save goes through).
 */
export const setTransitionTarget = (
  draft: DefinitionDraft,
  key: string,
  index: number,
  to: string,
): DefinitionDraft => {
  const holds = (target: string | undefined) =>
    target !== undefined &&
    draft.columns.some(
      (entry) => entry.key === target && entry.column.name === to,
    );
  return replaceMoves(draft, key, (moves) =>
    moves.map((keyed, at) =>
      at === index
        ? {
            move: { ...keyed.move, to },
            target: holds(keyed.target)
              ? keyed.target
              : keyNamed(draft.columns, to),
          }
        : keyed,
    ),
  );
};

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
    moves.map((keyed, at) => {
      if (at !== index) return keyed;
      const { gate: _gate, ...rest } = keyed.move;
      return {
        ...keyed,
        move: gate.trim() === "" ? rest : { ...rest, gate },
      };
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

/**
 * The roles a column may name: the vocabulary's and the column's own whatever it is, sorted, and
 * whether a role may also be typed (F4). A typed name is offered only when the deployment has no role
 * table (`rolesOpen`) — `defineBoard` then accepts any role — and never beside a table, where a role
 * outside the list is the typo the server refuses.
 */
export const roleOptions = (
  vocabulary: Pick<DefinitionVocabulary, "roles" | "rolesOpen">,
  column: BoardColumn,
): { readonly names: ReadonlyArray<string>; readonly typed: boolean } => ({
  names: [
    ...new Set(
      column.role === undefined
        ? vocabulary.roles
        : [...vocabulary.roles, column.role],
    ),
  ].toSorted(),
  typed: vocabulary.rolesOpen,
});

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
  "wipLimit",
  "autonomy",
]);

/**
 * A move in the diff: the column it points at as an identity (`id`) and the move as shown. The id is
 * the target's draft key — for a base move, the key of the draft column that came from its target —
 * so two moves are the same move only when they point at the same column, whatever it is named now.
 */
type DiffMove = { readonly id: string; readonly move: ColumnTransition };

/** The changes to a column's autonomy: its gates one by one, its write and push scope. */
const autonomyDiff = (
  at: string,
  before: ColumnAutonomy | undefined,
  after: ColumnAutonomy | undefined,
): Array<DiffLine> => {
  const lines: Array<DiffLine> = [];
  const was = before?.approvalRequired ?? [];
  const now = after?.approvalRequired ?? [];
  for (const gate of was)
    if (!now.includes(gate))
      lines.push({ sign: "-", text: `${at} approval gate ${shown(gate)}` });
  for (const gate of now)
    if (!was.includes(gate))
      lines.push({ sign: "+", text: `${at} approval gate ${shown(gate)}` });
  if (before?.write !== after?.write)
    lines.push({
      sign: "~",
      text: `${at} write scope: ${before?.write ?? NONE} → ${after?.write ?? NONE}`,
    });
  if (before?.push !== after?.push)
    lines.push({
      sign: "~",
      text: `${at} push scope: ${before?.push ?? NONE} → ${after?.push ?? NONE}`,
    });
  // A field of the autonomy a later change adds: compared as declared, as a column's own are.
  const known = new Set(["approvalRequired", "write", "push"]);
  const others = [
    ...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]),
  ].filter((field) => !known.has(field));
  for (const field of others.toSorted()) {
    const a = (before as Record<string, unknown> | undefined)?.[field];
    const b = (after as Record<string, unknown> | undefined)?.[field];
    if (!sameValue(a, b))
      lines.push({
        sign: "~",
        text: `${at} autonomy ${field}: ${shown(a)} → ${shown(b)}`,
      });
  }
  return lines;
};

/** The changes inside one column the draft kept, its base and draft moves given by target identity. */
const columnDiff = (
  before: BoardColumn,
  after: BoardColumn,
  beforeMoves: ReadonlyArray<DiffMove>,
  afterMoves: ReadonlyArray<DiffMove>,
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
  for (const { id, move } of beforeMoves) {
    const kept = afterMoves.find((candidate) => candidate.id === id)?.move;
    if (kept === undefined)
      lines.push({ sign: "-", text: `${at} ${moveText(move)}` });
    else if (kept.gate !== move.gate)
      lines.push({
        sign: "~",
        text: `${at} move to "${kept.to}": gate ${shown(move.gate)} → ${shown(kept.gate)}`,
      });
  }
  for (const { id, move } of afterMoves)
    if (!beforeMoves.some((candidate) => candidate.id === id))
      lines.push({ sign: "+", text: `${at} ${moveText(move)}` });
  const keptMoves = afterMoves.filter(({ id }) =>
    beforeMoves.some((move) => move.id === id),
  );
  const wasMoves = beforeMoves.filter(({ id }) =>
    keptMoves.some((move) => move.id === id),
  );
  if (
    !sameValue(
      wasMoves.map(({ id }) => id),
      keptMoves.map(({ id }) => id),
    )
  ) {
    const now = (id: string) =>
      keptMoves.find((move) => move.id === id)?.move.to ?? id;
    lines.push({
      sign: "~",
      text: `${at} moves reordered: ${wasMoves.map(({ id }) => now(id)).join(", ")} → ${keptMoves.map(({ move }) => move.to).join(", ")}`,
    });
  }
  if (before.wipLimit !== after.wipLimit)
    lines.push({
      sign: "~",
      text: `${at} wipLimit: ${shown(before.wipLimit)} → ${shown(after.wipLimit)}`,
    });
  lines.push(...autonomyDiff(at, before.autonomy, after.autonomy));
  // Every other field — a field this editor has no control for — compared as declared.
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
 * where they came from, not by name, so a rename is one line rather than a removal and an addition;
 * moves and the initial column are matched by the column they point at, so a removed column's name
 * taken by a rename reads as the move removed, not as the move kept.
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
  for (const kind of CAP_KINDS) {
    const was = base.caps?.[kind];
    const now = draft.caps?.[kind];
    if (was !== now)
      lines.push({
        sign: "~",
        text: `caps.${kind}: ${shown(was)} → ${shown(now)}`,
      });
  }
  // A column's identity: the draft key of what it became, `removed:` for a base column the draft
  // dropped, and `name:` for a name no column holds (a move a version read without checks points at).
  const fromBase = new Map(
    draft.columns.flatMap((entry) =>
      entry.origin === undefined ? [] : [[entry.origin, entry.key] as const],
    ),
  );
  const baseId = (name: string): string =>
    fromBase.get(name) ??
    (base.columns.some((column) => column.name === name)
      ? `removed:${name}`
      : `name:${name}`);
  const draftId = (target: string | undefined, name: string): string =>
    target ?? `name:${name}`;
  const wasInitial = base.initialColumn ?? "";
  const initialChanged =
    wasInitial === "" || draft.initialColumn === ""
      ? wasInitial !== draft.initialColumn
      : baseId(wasInitial) !== draftId(draft.initialKey, draft.initialColumn);
  if (initialChanged) {
    // The same name for another column (a rename took a removed column's name) says which it is.
    const nowOrigin = draft.columns.find(
      (entry) => entry.key === draft.initialKey,
    )?.origin;
    const which =
      draft.initialColumn === wasInitial &&
      nowOrigin !== undefined &&
      nowOrigin !== draft.initialColumn
        ? ` (the column renamed from "${nowOrigin}")`
        : draft.initialColumn === wasInitial && nowOrigin === undefined
          ? " (a column added here)"
          : "";
    lines.push({
      sign: "~",
      text: `new cards start in: ${wasInitial === "" ? NONE : wasInitial} → ${draft.initialColumn === "" ? NONE : draft.initialColumn}${which}`,
    });
  }
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
    lines.push(
      ...columnDiff(
        before,
        entry.column,
        (before.transitions ?? []).map((move) => ({
          id: baseId(move.to),
          move: {
            ...move,
            to:
              draft.columns.find(
                (candidate) => candidate.key === fromBase.get(move.to),
              )?.column.name ?? move.to,
          },
        })),
        keyedMoves(entry).map(({ move, target }) => ({
          id: draftId(target, move.to),
          move,
        })),
      ),
    );
  }
  const keptOrder = draft.columns
    .filter((entry) => entry.origin !== undefined)
    .map((entry) => entry.column.name);
  const wasOrder = base.columns.flatMap((column) => {
    const kept = draft.columns.find((entry) => entry.origin === column.name);
    return kept === undefined ? [] : [kept.column.name];
  });
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
const GATE_FAULT = /^autonomy\.approvalRequired\[(\d+)\]$/;
const AUTONOMY_FIELDS: ReadonlySet<string> = new Set([
  "autonomy.write",
  "autonomy.push",
  "autonomy.approvalRequired",
]);
const CAP_SLOTS: ReadonlySet<string> = new Set([
  "caps",
  ...CAP_KINDS.map((kind) => `caps.${kind}`),
]);

/**
 * Places the server's faults next to the field each names. A fault's path is into the version as it
 * was sent, so its column index is read against the keys the draft held then (`sent`): a column the
 * person moved since keeps its fault, and one they removed has its fault shown above the editor.
 *
 * - `name`, `initialColumn`, `columns` and `caps` / `caps.<kind>` are the definition's fields;
 * - `columns[i].name` / `.kind` / `.role` / `.transitions` / `.requires` / `.skills` / `.wipLimit` /
 *   `.autonomy.write` / `.autonomy.push` / `.autonomy.approvalRequired` are the column's;
 * - a row — `transitions[j].to`, `requires[j].key`, `skills[j]`, `autonomy.approvalRequired[j]` — is
 *   its row while the column still has one at `j`, else the list it was in;
 * - anything else of a column (a field this editor has no control for) is the column's.
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
      fault.field === "columns" ||
      CAP_SLOTS.has(fault.field)
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
    if (COLUMN_FIELDS.has(path) || AUTONOMY_FIELDS.has(path)) {
      put(columnSlot(entry.key, path), fault);
      continue;
    }
    const gate = GATE_FAULT.exec(path);
    if (gate !== null) {
      const index = Number(gate[1]);
      put(
        columnSlot(
          entry.key,
          index < gatesOf(entry.column).length
            ? path
            : "autonomy.approvalRequired",
        ),
        fault,
      );
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
 * The limits of the draft that `RunCap` — the domain schema the server decodes a `defineBoard` body
 * with — refuses: a WIP limit or a cap that is not a whole number of at least one. The RPC client
 * encodes a payload with that same schema before it sends one, so such a body never leaves the page;
 * rather than a stack of schema text, each one is a fault at the path the server would name
 * (`columns[1].wipLimit`, `caps.task`), in the schema's own words, shown beside its field like any
 * other fault. Nothing else is judged here: what a version may declare is the server's call.
 */
export const limitFaults = (
  draft: DefinitionDraft,
): ReadonlyArray<DefinitionFault> => {
  const refusal = (value: number | undefined): string | undefined => {
    if (value === undefined) return undefined;
    const decoded = Schema.decodeUnknownResult(RunCap)(value);
    return Result.isFailure(decoded) ? decoded.failure.message : undefined;
  };
  return [
    ...draft.columns.flatMap((entry, index) => {
      const message = refusal(entry.column.wipLimit);
      return message === undefined
        ? []
        : [{ field: `columns[${index}].wipLimit`, message }];
    }),
    ...CAP_KINDS.flatMap((kind) => {
      const message = refusal(draft.caps?.[kind]);
      return message === undefined ? [] : [{ field: `caps.${kind}`, message }];
    }),
  ];
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

/**
 * What the editor says when the definition has versions newer than the board's pin, or `null` when
 * the pin is the newest. The draft starts from the pin and `defineBoard` writes newest + 1, so a save
 * supersedes the newer versions without what they changed — said before the person edits, not after.
 */
export const supersedeNotice = (
  definitionId: string,
  pinned: number,
  newer: ReadonlyArray<number>,
): string | null => {
  const newest = newer.at(-1);
  if (newest === undefined) return null;
  const exists =
    newer.length === 1
      ? `v${newest} of ${definitionId} already exists`
      : `v${newer[0]}–v${newest} of ${definitionId} already exist`;
  const their = newer.length === 1 ? "its changes" : "their changes";
  return `${exists}, and this draft starts from v${pinned}, the board's pin. Saving writes v${newest + 1} as v${pinned} plus these edits, without ${their}.`;
};
