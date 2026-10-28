import { useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { Cause, Exit, Option } from "effect";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  PlusIcon,
  SaveIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { cn } from "cn";
import type {
  BoardDefinition,
  BoardInstance,
  ColumnKind,
  ColumnPushScope,
  ColumnWriteScope,
  DefinedBoard,
  DefinitionFault,
  DefinitionVocabulary,
} from "@repo/domain/Task";
import { definitionsAtom } from "@/lib/atoms/board-atom";
import { defineBoardAtom } from "@/lib/atoms/definition-edit-atom";
import { NONE, newerVersions } from "@/lib/board-settings-view";
import {
  CAP_KINDS,
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
  limitFaults,
  moveColumn,
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
  type CapKind,
  type DefineRefusal,
  type DefinitionDraft,
  type DraftColumn,
  type PlacedFaults,
} from "@/lib/definition-edit-view";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";

const SELECT_CLASS =
  "h-7 w-full min-w-0 rounded-none border border-input bg-transparent px-1.5 text-xs outline-none focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50 aria-invalid:border-destructive dark:bg-input/30";

const KINDS: ReadonlyArray<ColumnKind> = ["resting", "working", "terminal"];

/** A column's write and push scope, widest first (C22); "default" is no scope: the deployment's. */
const WRITE_SCOPES: ReadonlyArray<ColumnWriteScope> = [
  "worktree",
  "docs",
  "none",
];
const PUSH_SCOPES: ReadonlyArray<ColumnPushScope> = ["branch", "none"];
const DEFAULT_SCOPE = "";

/** What each cap counts, as `BoardCaps` defines it (B9). */
const CAP_LABELS: Readonly<Record<CapKind, string>> = {
  board: "Per board",
  task: "Per task",
  repo: "Per repository",
};

/** A select's value for "no role": the column runs on the deployment's model. */
const NO_ROLE = "";

/** The server's faults for one slot, each next to the field it names, in the server's words. */
const Faults = ({
  placed,
  slot,
}: {
  readonly placed: PlacedFaults | undefined;
  readonly slot: string;
}) => {
  const faults = placed?.slots.get(slot) ?? [];
  if (faults.length === 0) return null;
  return (
    <ul className="flex flex-col gap-0.5">
      {faults.map((fault, index) => (
        <li
          key={`${fault.field}-${index}`}
          data-field-fault={fault.field}
          data-fault-slot={slot}
          className="text-[11px] break-words text-destructive"
        >
          {fault.message}
        </li>
      ))}
    </ul>
  );
};

const has = (placed: PlacedFaults | undefined, slot: string) =>
  (placed?.slots.get(slot)?.length ?? 0) > 0 ? true : undefined;

/** One labelled group of a column's fields. */
const Section = ({
  label,
  children,
  ...data
}: {
  readonly label: string;
  readonly children: ReactNode;
} & Record<`data-${string}`, string | boolean>) => (
  <div className="flex flex-col gap-1" {...data}>
    <span className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
      {label}
    </span>
    {children}
  </div>
);

/**
 * A number field for a limit: empty is no limit. Whatever else is typed reaches the server as the
 * number it reads as, so `0` or `1.5` is refused there, next to the field, in the server's words.
 */
const LimitInput = ({
  id,
  value,
  invalid,
  onChange,
  ...data
}: {
  readonly id: string;
  readonly value: number | undefined;
  readonly invalid: true | undefined;
  readonly onChange: (limit: number | undefined) => void;
} & Record<`data-${string}`, string | boolean>) => (
  <Input
    id={id}
    type="number"
    step="any"
    inputMode="numeric"
    value={value === undefined ? "" : String(value)}
    placeholder="no limit"
    onChange={(event) => onChange(parseLimit(event.currentTarget.value))}
    aria-invalid={invalid}
    className="h-7 text-xs"
    {...data}
  />
);

/**
 * One column of the draft: its name, kind and role (typed only when the deployment has no role
 * table), the skills it binds and the requirements it declares — each picked from the server's lists,
 * never typed — its moves out with their gates, its WIP limit and its autonomy.
 * Every value is the draft's; every fault the last save was refused for sits next to its field.
 */
const ColumnEditor = ({
  draft,
  entry,
  index,
  skills,
  vocabulary,
  placed,
  update,
}: {
  readonly draft: DefinitionDraft;
  readonly entry: DraftColumn;
  readonly index: number;
  readonly skills: ReadonlyArray<string>;
  readonly vocabulary: DefinitionVocabulary;
  readonly placed: PlacedFaults | undefined;
  readonly update: (
    change: (draft: DefinitionDraft) => DefinitionDraft,
  ) => void;
}) => {
  const { key, column } = entry;
  const slot = (path?: string) => columnSlot(key, path);
  const id = (field: string) => `column-${key}-${field}`;
  const moves = column.transitions ?? [];
  const canAddMove = targetOptions(draft, key, moves.length).length > 0;
  const freeSkills = skillOptions(skills, column);
  const freeKeys = requirementOptions(vocabulary.requirements, column);
  const roles = roleOptions(vocabulary, column);
  const gates = gatesOf(column);
  return (
    <li
      data-editor-column={column.name}
      data-editor-column-key={key}
      data-editor-column-origin={entry.origin ?? ""}
      className={cn(
        "flex flex-col gap-2.5 border bg-card px-3 py-2.5",
        has(placed, slot()) ? "border-destructive" : "border-border",
      )}
    >
      <div className="flex items-center gap-1.5">
        <span className="w-4 font-mono text-[10px] text-muted-foreground">
          {index + 1}
        </span>
        <Label htmlFor={id("name")} className="sr-only">
          Column {index + 1} name
        </Label>
        <Input
          id={id("name")}
          data-column-name-input
          value={column.name}
          onChange={(event) => {
            const name = event.currentTarget.value;
            update((previous) => renameColumn(previous, key, name));
          }}
          aria-invalid={has(placed, slot("name"))}
          autoComplete="off"
          spellCheck={false}
          className="h-7 font-mono text-xs"
        />
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          data-move-column-up
          aria-label={`Move ${column.name} up`}
          disabled={index === 0}
          onClick={() => update((previous) => moveColumn(previous, key, -1))}
        >
          <ArrowUpIcon />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          data-move-column-down
          aria-label={`Move ${column.name} down`}
          disabled={index === draft.columns.length - 1}
          onClick={() => update((previous) => moveColumn(previous, key, 1))}
        >
          <ArrowDownIcon />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          data-remove-column
          aria-label={`Remove ${column.name}`}
          onClick={() => update((previous) => removeColumn(previous, key))}
        >
          <Trash2Icon />
        </Button>
      </div>
      <Faults placed={placed} slot={slot("name")} />
      <Faults placed={placed} slot={slot()} />

      <div className="grid grid-cols-2 gap-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor={id("kind")} className="text-[11px]">
            Kind
          </Label>
          <select
            id={id("kind")}
            data-column-kind-select
            value={column.kind}
            onChange={(event) => {
              const kind = KINDS.find(
                (candidate) => candidate === event.currentTarget.value,
              );
              if (kind !== undefined)
                update((previous) => setKind(previous, key, kind));
            }}
            aria-invalid={has(placed, slot("kind"))}
            className={SELECT_CLASS}
          >
            {KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {kind}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={id("role")} className="text-[11px]">
            Role
          </Label>
          {roles.typed ? (
            <>
              <Input
                id={id("role")}
                data-column-role-input
                list={`${id("role")}-suggestions`}
                value={column.role ?? ""}
                placeholder="none: the deployment's model"
                onChange={(event) => {
                  const role = event.currentTarget.value;
                  update((previous) =>
                    setRole(
                      previous,
                      key,
                      role.trim() === "" ? undefined : role,
                    ),
                  );
                }}
                aria-invalid={has(placed, slot("role"))}
                autoComplete="off"
                spellCheck={false}
                className="h-7 font-mono text-xs"
              />
              <datalist id={`${id("role")}-suggestions`}>
                {roles.names.map((role) => (
                  <option key={role} value={role} />
                ))}
              </datalist>
            </>
          ) : (
            <select
              id={id("role")}
              data-column-role-select
              value={column.role ?? NO_ROLE}
              onChange={(event) => {
                const role = event.currentTarget.value;
                update((previous) =>
                  setRole(previous, key, role === NO_ROLE ? undefined : role),
                );
              }}
              aria-invalid={has(placed, slot("role"))}
              className={SELECT_CLASS}
            >
              <option value={NO_ROLE}>{NONE} none</option>
              {roles.names.map((role) => (
                <option key={role} value={role}>
                  {role}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>
      <Faults placed={placed} slot={slot("kind")} />
      <Faults placed={placed} slot={slot("role")} />

      <Section label="Skills" data-column-skills>
        {column.skills.length === 0 ? (
          <span className="text-[11px] text-muted-foreground">{NONE}</span>
        ) : (
          <ul className="flex flex-col gap-1">
            {column.skills.map((skill, position) => (
              <li
                key={skill}
                data-column-skill={skill}
                className="flex flex-col gap-0.5"
              >
                <span className="flex items-center justify-between gap-2 text-[11px]">
                  <span className="font-mono">{skill}</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    data-remove-skill
                    aria-label={`Unbind ${skill}`}
                    onClick={() =>
                      update((previous) => removeSkill(previous, key, position))
                    }
                  >
                    <XIcon />
                  </Button>
                </span>
                <Faults placed={placed} slot={slot(`skills[${position}]`)} />
              </li>
            ))}
          </ul>
        )}
        <select
          aria-label={`Bind a skill to ${column.name}`}
          data-skill-picker
          value=""
          disabled={freeSkills.length === 0}
          onChange={(event) => {
            const skill = event.currentTarget.value;
            if (skill !== "")
              update((previous) => addSkill(previous, key, skill));
          }}
          className={SELECT_CLASS}
        >
          <option value="">
            {freeSkills.length === 0
              ? "No other skill in the library"
              : "Bind a skill…"}
          </option>
          {freeSkills.map((skill) => (
            <option key={skill} value={skill}>
              {skill}
            </option>
          ))}
        </select>
        <Faults placed={placed} slot={slot("skills")} />
      </Section>

      <Section label="Requires on exit" data-column-requires>
        {column.requires.length === 0 ? (
          <span className="text-[11px] text-muted-foreground">{NONE}</span>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {column.requires.map((requirement, position) => (
              <li
                key={requirement.key}
                data-column-requirement={requirement.key}
                className="flex flex-col gap-0.5"
              >
                <span className="flex items-center justify-between gap-2 text-[11px]">
                  <span
                    data-requirement-key
                    className="font-mono"
                    aria-invalid={has(placed, slot(`requires[${position}]`))}
                  >
                    {requirement.key}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    data-remove-requirement
                    aria-label={`Drop ${requirement.key}`}
                    onClick={() =>
                      update((previous) =>
                        removeRequirement(previous, key, position),
                      )
                    }
                  >
                    <XIcon />
                  </Button>
                </span>
                <Input
                  aria-label={`What satisfies ${requirement.key}`}
                  data-requirement-description-input
                  value={requirement.description}
                  onChange={(event) => {
                    const description = event.currentTarget.value;
                    update((previous) =>
                      setRequirementDescription(
                        previous,
                        key,
                        position,
                        description,
                      ),
                    );
                  }}
                  className="h-6 text-[11px]"
                />
                <Faults placed={placed} slot={slot(`requires[${position}]`)} />
              </li>
            ))}
          </ul>
        )}
        <select
          aria-label={`Require a key on leaving ${column.name}`}
          data-requires-picker
          value=""
          disabled={freeKeys.length === 0}
          onChange={(event) => {
            const option = vocabulary.requirements.find(
              (candidate) => candidate.key === event.currentTarget.value,
            );
            if (option !== undefined)
              update((previous) => addRequirement(previous, key, option));
          }}
          className={SELECT_CLASS}
        >
          <option value="">
            {freeKeys.length === 0
              ? "Every known key is required"
              : "Require a key…"}
          </option>
          {freeKeys.map((option) => (
            <option key={option.key} value={option.key}>
              {option.key}
              {option.checked ? " (checked)" : " (not yet checked)"}
              {option.humanGate ? ", needs a gated move" : ""}
            </option>
          ))}
        </select>
        <Faults placed={placed} slot={slot("requires")} />
      </Section>

      <Section label="Moves out" data-column-moves>
        {moves.length === 0 ? (
          <span className="text-[11px] text-muted-foreground">{NONE}</span>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {moves.map((move, position) => (
              <li
                key={`${move.to}-${position}`}
                data-column-move={move.to}
                className="flex flex-col gap-0.5"
              >
                <span className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-1">
                  <select
                    aria-label={`Move ${position + 1} from ${column.name} goes to`}
                    data-move-to
                    value={move.to}
                    onChange={(event) => {
                      const to = event.currentTarget.value;
                      update((previous) =>
                        setTransitionTarget(previous, key, position, to),
                      );
                    }}
                    aria-invalid={has(placed, slot(`transitions[${position}]`))}
                    className={SELECT_CLASS}
                  >
                    {targetOptions(draft, key, position).map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                  </select>
                  <Input
                    aria-label={`The human gate the move to ${move.to} crosses`}
                    data-move-gate
                    value={move.gate ?? ""}
                    placeholder="no gate"
                    onChange={(event) => {
                      const gate = event.currentTarget.value;
                      update((previous) =>
                        setTransitionGate(previous, key, position, gate),
                      );
                    }}
                    className="h-7 text-[11px]"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    data-remove-move
                    aria-label={`Remove the move to ${move.to}`}
                    onClick={() =>
                      update((previous) =>
                        removeTransition(previous, key, position),
                      )
                    }
                  >
                    <XIcon />
                  </Button>
                </span>
                <Faults
                  placed={placed}
                  slot={slot(`transitions[${position}]`)}
                />
              </li>
            ))}
          </ul>
        )}
        <Button
          type="button"
          variant="outline"
          size="xs"
          data-add-move
          disabled={!canAddMove}
          onClick={() => update((previous) => addTransition(previous, key))}
          className="self-start"
        >
          <PlusIcon />
          Add a move
        </Button>
        <p className="text-[10px] text-muted-foreground">
          A move with a gate is one only a person can make; no gate, and a run
          may make it too.
        </p>
        <Faults placed={placed} slot={slot("transitions")} />
      </Section>

      <Section label="Limit" data-column-limit>
        <Label htmlFor={id("wip")} className="text-[11px]">
          WIP limit: runs in flight at once on the board
        </Label>
        <LimitInput
          id={id("wip")}
          data-column-wip-input
          value={column.wipLimit}
          invalid={has(placed, slot("wipLimit"))}
          onChange={(limit) =>
            update((previous) => setWipLimit(previous, key, limit))
          }
        />
        <Faults placed={placed} slot={slot("wipLimit")} />
      </Section>

      <Section label="Autonomy" data-column-autonomy>
        <div className="grid grid-cols-2 gap-2">
          <div className="flex flex-col gap-1">
            <Label htmlFor={id("write")} className="text-[11px]">
              Write scope
            </Label>
            <select
              id={id("write")}
              data-column-write-select
              value={column.autonomy?.write ?? DEFAULT_SCOPE}
              onChange={(event) => {
                const write = WRITE_SCOPES.find(
                  (candidate) => candidate === event.currentTarget.value,
                );
                update((previous) => setWriteScope(previous, key, write));
              }}
              aria-invalid={has(placed, slot("autonomy.write"))}
              className={SELECT_CLASS}
            >
              <option value={DEFAULT_SCOPE}>{NONE} deployment&apos;s</option>
              {WRITE_SCOPES.map((scope) => (
                <option key={scope} value={scope}>
                  {scope}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor={id("push")} className="text-[11px]">
              Push scope
            </Label>
            <select
              id={id("push")}
              data-column-push-select
              value={column.autonomy?.push ?? DEFAULT_SCOPE}
              onChange={(event) => {
                const push = PUSH_SCOPES.find(
                  (candidate) => candidate === event.currentTarget.value,
                );
                update((previous) => setPushScope(previous, key, push));
              }}
              aria-invalid={has(placed, slot("autonomy.push"))}
              className={SELECT_CLASS}
            >
              <option value={DEFAULT_SCOPE}>{NONE} deployment&apos;s</option>
              {PUSH_SCOPES.map((scope) => (
                <option key={scope} value={scope}>
                  {scope}
                </option>
              ))}
            </select>
          </div>
        </div>
        <Faults placed={placed} slot={slot("autonomy.write")} />
        <Faults placed={placed} slot={slot("autonomy.push")} />
        <span className="text-[11px]">
          Commands a run asks a person before running
        </span>
        {gates.length === 0 ? (
          <span className="text-[11px] text-muted-foreground">{NONE}</span>
        ) : (
          <ul className="flex flex-col gap-1">
            {gates.map((gate, position) => (
              <li
                key={position}
                data-column-gate={gate}
                className="flex flex-col gap-0.5"
              >
                <span className="flex items-center gap-1">
                  <Input
                    aria-label={`Approval gate ${position + 1} of ${column.name}`}
                    data-column-gate-input
                    value={gate}
                    placeholder="git push"
                    onChange={(event) => {
                      const next = event.currentTarget.value;
                      update((previous) =>
                        setGate(previous, key, position, next),
                      );
                    }}
                    aria-invalid={has(
                      placed,
                      slot(`autonomy.approvalRequired[${position}]`),
                    )}
                    autoComplete="off"
                    spellCheck={false}
                    className="h-6 font-mono text-[11px]"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    data-remove-gate
                    aria-label={`Remove approval gate ${position + 1} of ${column.name}`}
                    onClick={() =>
                      update((previous) => removeGate(previous, key, position))
                    }
                  >
                    <XIcon />
                  </Button>
                </span>
                <Faults
                  placed={placed}
                  slot={slot(`autonomy.approvalRequired[${position}]`)}
                />
              </li>
            ))}
          </ul>
        )}
        <Button
          type="button"
          variant="outline"
          size="xs"
          data-add-gate
          onClick={() => update((previous) => addGate(previous, key))}
          className="self-start"
        >
          <PlusIcon />
          Add a gate
        </Button>
        <p className="text-[10px] text-muted-foreground">
          A column narrows the deployment&apos;s policy and never widens it: its
          gates are added to the deployment&apos;s.
        </p>
        <Faults placed={placed} slot={slot("autonomy.approvalRequired")} />
      </Section>
    </li>
  );
};

/**
 * Whether the definition has versions newer than the board's pin (B2), from `listDefinitions`: the
 * draft starts from the pin and the save writes newest + 1, so a newer version's changes are not in
 * what the save writes. A failed list says it could not tell rather than claiming the pin is newest.
 */
const NewerThanPin = ({ pinned }: { readonly pinned: BoardDefinition }) => {
  const result = useAtomValue(definitionsAtom);
  if (AsyncResult.isInitial(result)) return null;
  if (AsyncResult.isFailure(result))
    return (
      <p
        data-editor-newer-unknown
        title={Cause.pretty(result.cause)}
        className="max-w-3xl text-[11px] text-destructive"
      >
        Whether a version of {pinned.id} newer than v{pinned.version} exists
        could not be read; saving writes the newest version + 1.
      </p>
    );
  const newer = newerVersions(result.value, pinned.id, pinned.version);
  const notice = supersedeNotice(pinned.id, pinned.version, newer);
  return notice === null ? null : (
    <p
      role="status"
      data-editor-newer-versions={newer.join(",")}
      className="max-w-3xl border border-border bg-muted/40 px-3 py-2 text-xs"
    >
      {notice}
    </p>
  );
};

/** The last refused save: the refusal, the column keys it was sent with, and the draft it was. */
type Refused = {
  readonly refusal: DefineRefusal;
  readonly sent: ReadonlyArray<string>;
  readonly draft: DefinitionDraft;
};

/**
 * "Edit as new version" (D6): the board's pinned version as a draft, and Save as `defineBoard`.
 *
 * The page never edits the pinned version (B2): Save writes the definition's newest version + 1 and
 * says "v<n> created", and the board stays on its pin until it is upgraded. What the save would change
 * against the pinned version is listed beside the columns, line by line, and Save is offered only
 * while there is something to change. A refusal is the server's: each fault sits next to the field it
 * names, and one no field holds is listed above the columns.
 */
export const DefinitionEditor = ({
  instance,
  pinned,
  skills,
  vocabulary,
}: {
  readonly instance: BoardInstance;
  readonly pinned: BoardDefinition;
  readonly skills: ReadonlyArray<string>;
  readonly vocabulary: DefinitionVocabulary;
}) => {
  const define = useAtomSet(defineBoardAtom, { mode: "promiseExit" });
  const [draft, setDraft] = useState<DefinitionDraft>(() => draftOf(pinned));
  const [pending, setPending] = useState(false);
  const [refused, setRefused] = useState<Refused | null>(null);
  const [saved, setSaved] = useState<DefinedBoard | null>(null);

  const update = (change: (previous: DefinitionDraft) => DefinitionDraft) => {
    setDraft(change);
    setSaved(null);
  };

  const diff = definitionDiff(pinned, draft);
  const placed =
    refused === null
      ? undefined
      : placeFaults(refused.refusal.faults, refused.sent, draft);
  const stale = refused !== null && refused.draft !== draft;

  const save = () => {
    if (pending) return;
    const sent = draft.columns.map((entry) => entry.key);
    const sentDraft = draft;
    setSaved(null);
    // A limit the domain schema refuses cannot be encoded into a request: it is shown beside its
    // field as the server would place it, and nothing is sent.
    const limits = limitFaults(sentDraft);
    if (limits.length > 0) {
      setRefused({
        refusal: {
          tag: "InvalidLimit",
          message: limits.map((fault) => fault.message).join("; "),
          faults: limits,
        },
        sent,
        draft: sentDraft,
      });
      return;
    }
    setPending(true);
    void define(defineInputOf(pinned, sentDraft))
      .then((exit) => {
        if (Exit.isSuccess(exit)) {
          setRefused(null);
          setSaved(exit.value);
          return;
        }
        setRefused({
          refusal: defineRefusal(
            Option.getOrUndefined(Cause.findErrorOption(exit.cause)),
            Cause.pretty(exit.cause),
          ),
          sent,
          draft: sentDraft,
        });
      })
      .finally(() => setPending(false));
  };

  return (
    <div
      data-definition-editor={instance.id}
      data-editor-definition={pinned.id}
      data-editor-pinned-version={pinned.version}
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto"
    >
      <header className="flex flex-col gap-2 border-b border-border px-4 py-3">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <Link
            to="/boards/$boardId"
            params={{ boardId: instance.id }}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            {instance.repo}
          </Link>
          <Link
            to="/boards/$boardId/settings"
            params={{ boardId: instance.id }}
            data-editor-settings-link
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            Settings
          </Link>
          <h1 className="text-sm font-medium">Edit as new version</h1>
          <span className="font-mono text-[10px] text-muted-foreground">
            {pinned.id}, from v{pinned.version}
          </span>
        </div>
        <p className="max-w-3xl text-[11px] text-muted-foreground">
          Saving writes a new version of {pinned.id}; v{pinned.version} is never
          edited. This board stays on v{pinned.version} until it is upgraded,
          and a board created after the save pins the new version. Skills and
          requirement keys are picked from what the server holds.
        </p>
        <NewerThanPin pinned={pinned} />
        <div className="grid max-w-3xl gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1">
            <Label htmlFor="definition-name" className="text-[11px]">
              Name
            </Label>
            <Input
              id="definition-name"
              data-editor-name
              value={draft.name}
              onChange={(event) => {
                const name = event.currentTarget.value;
                update((previous) => setName(previous, name));
              }}
              aria-invalid={has(placed, "name")}
              className="h-7 text-xs"
            />
            <Faults placed={placed} slot="name" />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="definition-initial" className="text-[11px]">
              New cards start in
            </Label>
            <select
              id="definition-initial"
              data-editor-initial
              value={draft.initialColumn}
              onChange={(event) => {
                const initial = event.currentTarget.value;
                update((previous) => setInitialColumn(previous, initial));
              }}
              aria-invalid={has(placed, "initialColumn")}
              className={SELECT_CLASS}
            >
              <option value="">{NONE} pick a column</option>
              {[
                ...new Set(draft.columns.map((entry) => entry.column.name)),
              ].map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
            <Faults placed={placed} slot="initialColumn" />
          </div>
        </div>
        <fieldset
          data-editor-caps
          className="flex max-w-3xl flex-col gap-1 border-0 p-0"
        >
          <legend className="mb-1 text-[11px] font-medium">
            Run caps: runs in flight at once, empty for no cap
          </legend>
          <div className="grid gap-3 sm:grid-cols-3">
            {CAP_KINDS.map((kind: CapKind) => (
              <div key={kind} className="flex flex-col gap-1">
                <Label
                  htmlFor={`definition-cap-${kind}`}
                  className="text-[11px]"
                >
                  {CAP_LABELS[kind]}
                </Label>
                <LimitInput
                  id={`definition-cap-${kind}`}
                  data-editor-cap={kind}
                  value={draft.caps?.[kind]}
                  invalid={has(placed, `caps.${kind}`)}
                  onChange={(limit) =>
                    update((previous) => setCap(previous, kind, limit))
                  }
                />
                <Faults placed={placed} slot={`caps.${kind}`} />
              </div>
            ))}
          </div>
          <Faults placed={placed} slot="caps" />
        </fieldset>
      </header>

      <div className="flex flex-col gap-4 p-4 xl:flex-row xl:items-start">
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          {refused === null ? null : (
            <div
              role="alert"
              data-define-refusal={refused.refusal.tag}
              className="flex flex-col gap-1 border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive"
            >
              <p className="font-medium">
                {refused.refusal.faults.length === 0
                  ? "The version was not saved."
                  : `The version was not saved: ${refused.refusal.faults.length} problem${refused.refusal.faults.length === 1 ? "" : "s"}, each shown next to its field. Nothing was written.`}
              </p>
              {refused.refusal.faults.length === 0 ? (
                <p className="break-words">{refused.refusal.message}</p>
              ) : null}
              {(placed?.unplaced ?? []).map((fault: DefinitionFault, index) => (
                <p
                  key={`${fault.field}-${index}`}
                  data-field-fault={fault.field}
                  data-fault-slot="unplaced"
                  className="break-words"
                >
                  <span className="font-mono">{fault.field}</span>:{" "}
                  {fault.message}
                </p>
              ))}
              {stale ? (
                <p data-refusal-stale className="text-muted-foreground">
                  Edited since: Save checks the version again.
                </p>
              ) : null}
            </div>
          )}
          <Faults placed={placed} slot="columns" />
          <ol
            aria-label="Columns"
            className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-3"
          >
            {draft.columns.map((entry, index) => (
              <ColumnEditor
                key={entry.key}
                draft={draft}
                entry={entry}
                index={index}
                skills={skills}
                vocabulary={vocabulary}
                placed={placed}
                update={update}
              />
            ))}
          </ol>
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-add-column
            onClick={() => update(addColumn)}
            className="self-start"
          >
            <PlusIcon />
            Add a column
          </Button>
        </div>

        <aside
          aria-label="Changes against the pinned version"
          className="flex w-full flex-col gap-2 border border-border bg-card px-3 py-2.5 xl:sticky xl:top-0 xl:w-96"
        >
          <h2 className="text-xs font-medium">
            Changes against v{pinned.version}
          </h2>
          {diff.length === 0 ? (
            <p
              data-definition-diff-empty
              className="text-[11px] text-muted-foreground"
            >
              Nothing changed against v{pinned.version} yet.
            </p>
          ) : (
            <ul data-definition-diff className="flex flex-col gap-0.5">
              {diff.map((line, index) => (
                <li
                  key={`${line.text}-${index}`}
                  data-diff-line={line.sign}
                  className={cn(
                    "grid grid-cols-[1rem_minmax(0,1fr)] font-mono text-[11px] break-words",
                    line.sign === "+"
                      ? "text-emerald-700 dark:text-emerald-400"
                      : line.sign === "-"
                        ? "text-destructive"
                        : "text-foreground",
                  )}
                >
                  <span aria-hidden>{line.sign}</span>
                  <span>
                    <span className="sr-only">
                      {line.sign === "+"
                        ? "Added: "
                        : line.sign === "-"
                          ? "Removed: "
                          : "Changed: "}
                    </span>
                    {line.text}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <Button
            type="button"
            data-definition-save
            disabled={pending || diff.length === 0}
            aria-busy={pending}
            onClick={save}
          >
            {pending ? (
              <Spinner className="size-3.5" />
            ) : (
              <SaveIcon className="size-4" strokeWidth={1.75} />
            )}
            Save as a new version
          </Button>
          {saved === null ? null : (
            <div
              role="status"
              data-definition-saved={saved.outcome}
              data-saved-version={saved.definition.version}
              className="flex flex-col gap-1 border border-border bg-muted/40 px-2.5 py-2 text-xs"
            >
              <p>
                {savedNotice(
                  saved.outcome,
                  saved.definition.version,
                  pinned.version,
                )}
              </p>
              <Link
                to="/boards/$boardId/settings"
                params={{ boardId: instance.id }}
                className="text-[11px] underline underline-offset-2"
              >
                Back to the board&apos;s settings
              </Link>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
};
