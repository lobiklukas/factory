import { useState } from "react";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { Cause, Exit, Option } from "effect";
import { ArrowUpCircleIcon } from "lucide-react";
import type {
  BoardInstanceId,
  DefinitionConfig,
  UpgradedBoard,
} from "@repo/domain/Task";
import {
  definitionVersionAtom,
  upgradeBoardAtom,
} from "@/lib/atoms/board-atom";
import { DASHBOARD_ACTOR } from "@/lib/approvals-view";
import {
  defaultMapping,
  type MappingRow,
  upgradedSummary,
  upgradeInputOf,
  upgradeRefusal,
} from "@/lib/board-upgrade-view";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

const SELECT_CLASS =
  "h-7 min-w-0 rounded-none border border-input bg-transparent px-1.5 text-xs outline-none focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50 dark:bg-input/30";

/** The "unmapped" choice of a mapping row: its cards refuse the migration until a column is picked. */
const UNMAPPED = "";

/**
 * Where each pinned column's cards go under the target version (D5): one row per column of the pin,
 * a select of the target's columns, preset to the column of the same name when there is one. Read
 * from `getDefinition` for the version the form names, so the choices are that version's columns.
 */
const MappingRows = ({
  pinned,
  targetKey,
  rows,
  onChange,
}: {
  readonly pinned: DefinitionConfig;
  readonly targetKey: string;
  readonly rows: ReadonlyArray<MappingRow> | undefined;
  readonly onChange: (rows: ReadonlyArray<MappingRow>) => void;
}) => {
  const result = useAtomValue(definitionVersionAtom(targetKey));
  if (AsyncResult.isInitial(result))
    return (
      <p className="text-[11px] text-muted-foreground">
        Reading the version&apos;s columns…
      </p>
    );
  if (AsyncResult.isFailure(result))
    return (
      <p
        data-upgrade-target-unknown
        className="text-[11px] text-destructive"
        title={Cause.pretty(result.cause)}
      >
        The version&apos;s columns could not be read.
      </p>
    );
  const target = result.value.columns.map((column) => column.name);
  const shown =
    rows ??
    defaultMapping(
      pinned.columns.map((column) => column.name),
      target,
    );
  return (
    <table className="text-xs" data-upgrade-mapping>
      <tbody>
        {shown.map((row, index) => (
          <tr key={row.from} data-upgrade-row={row.from}>
            <td className="pr-3 font-mono">{row.from}</td>
            <td className="pr-3 text-muted-foreground">→</td>
            <td>
              <select
                aria-label={`Where ${row.from}'s cards go`}
                data-upgrade-to={row.from}
                value={row.to ?? UNMAPPED}
                onChange={(event) => {
                  const to = event.currentTarget.value;
                  onChange(
                    shown.map((entry, at) =>
                      at === index
                        ? { from: entry.from, to: to === UNMAPPED ? undefined : to }
                        : entry,
                    ),
                  );
                }}
                className={SELECT_CLASS}
              >
                <option value={UNMAPPED}>— not mapped</option>
                {target.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
};

/**
 * The settings page's Upgrade action (D5): move the board to a newer version of its definition, and,
 * when the person asks, migrate its cards with the mapping on screen. Offered only when a newer
 * version exists. Without the migration, new cards pin the new version and existing cards keep
 * theirs; with it, every card is re-pinned or — when one has an unfinished run or a column the
 * mapping leaves out — none is, and the page lists the cards the server named.
 */
export const BoardUpgrade = ({
  boardId,
  definition,
  newer,
}: {
  readonly boardId: BoardInstanceId;
  readonly definition: DefinitionConfig;
  readonly newer: ReadonlyArray<number>;
}) => {
  const upgrade = useAtomSet(upgradeBoardAtom, { mode: "promiseExit" });
  const [toVersion, setToVersion] = useState<number | undefined>(undefined);
  const [migrate, setMigrate] = useState(false);
  const [rows, setRows] = useState<ReadonlyArray<MappingRow> | undefined>(
    undefined,
  );
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState<UpgradedBoard | null>(null);
  const [refused, setRefused] = useState<ReturnType<
    typeof upgradeRefusal
  > | null>(null);

  const target = toVersion ?? newer.at(-1);
  if (target === undefined) return null;
  const targetKey = `${definition.id}@${target}`;

  const submit = (shown: ReadonlyArray<MappingRow>) => {
    if (pending) return;
    setPending(true);
    setRefused(null);
    setDone(null);
    void upgrade(
      upgradeInputOf({
        boardId,
        pinned: definition.version,
        toVersion: target,
        migrate,
        rows: shown,
        actor: DASHBOARD_ACTOR,
      }),
    )
      .then((exit) => {
        if (Exit.isSuccess(exit)) {
          setDone(exit.value);
          setRows(undefined);
          setToVersion(undefined);
          return;
        }
        setRefused(
          upgradeRefusal(
            Option.getOrUndefined(Cause.findErrorOption(exit.cause)),
            Cause.pretty(exit.cause),
          ),
        );
      })
      .finally(() => setPending(false));
  };

  return (
    <section
      data-board-upgrade={boardId}
      className="flex max-w-3xl flex-col gap-2 border border-border px-3 py-2 text-xs"
    >
      <h2 className="flex items-center gap-1.5 font-medium">
        <ArrowUpCircleIcon className="size-3.5" strokeWidth={1.75} />
        Upgrade this board
      </h2>
      <div className="flex flex-wrap items-center gap-2">
        <Label htmlFor="upgrade-version" className="text-[11px]">
          To version
        </Label>
        <select
          id="upgrade-version"
          data-upgrade-version
          value={target}
          onChange={(event) => {
            setToVersion(Number(event.currentTarget.value));
            setRows(undefined);
          }}
          className={SELECT_CLASS}
        >
          {newer.map((version) => (
            <option key={version} value={version}>
              v{version}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1.5 text-[11px]">
          <input
            type="checkbox"
            data-upgrade-migrate
            checked={migrate}
            onChange={(event) => setMigrate(event.currentTarget.checked)}
          />
          Also migrate the board&apos;s cards
        </label>
      </div>
      <p className="text-[11px] text-muted-foreground">
        {migrate
          ? `Every card is re-pinned to v${target} in the column picked for its own, or — if one has an unfinished run or sits in a column left unmapped — none is.`
          : `New cards will pin v${target}; the cards already here keep v${definition.version} and move by it.`}
      </p>
      {migrate ? (
        <MappingRows
          pinned={definition}
          targetKey={targetKey}
          rows={rows}
          onChange={setRows}
        />
      ) : null}
      <MigrateButton
        pending={pending}
        target={target}
        definition={definition}
        targetKey={targetKey}
        migrate={migrate}
        rows={rows}
        onSubmit={submit}
      />
      {done === null ? null : (
        <p role="status" data-upgrade-done className="text-[11px]">
          {upgradedSummary(done)}
        </p>
      )}
      {refused === null ? null : (
        <div role="alert" data-upgrade-refused className="text-[11px] text-destructive">
          <p>{refused.message}</p>
          {refused.cards.length === 0 ? null : (
            <ul className="list-disc pl-4">
              {refused.cards.map((line) => (
                <li key={line} data-upgrade-refused-card>
                  {line}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
};

/**
 * The submit button: with a migration, the rows it sends are the ones on screen — the preset when
 * the person changed none, which needs the target's columns, so it reads the same atom the rows do.
 */
const MigrateButton = ({
  pending,
  target,
  definition,
  targetKey,
  migrate,
  rows,
  onSubmit,
}: {
  readonly pending: boolean;
  readonly target: number;
  readonly definition: DefinitionConfig;
  readonly targetKey: string;
  readonly migrate: boolean;
  readonly rows: ReadonlyArray<MappingRow> | undefined;
  readonly onSubmit: (rows: ReadonlyArray<MappingRow>) => void;
}) => {
  const result = useAtomValue(definitionVersionAtom(targetKey));
  const preset = AsyncResult.isSuccess(result)
    ? defaultMapping(
        definition.columns.map((column) => column.name),
        result.value.columns.map((column) => column.name),
      )
    : undefined;
  const shown = rows ?? preset;
  const ready = !migrate || shown !== undefined;
  return (
    <Button
      size="sm"
      data-upgrade-submit
      disabled={pending || !ready}
      onClick={() => onSubmit(shown ?? [])}
      className="self-start"
    >
      {pending
        ? "Upgrading…"
        : migrate
          ? `Upgrade to v${target} and migrate cards`
          : `Upgrade to v${target}`}
    </Button>
  );
};
