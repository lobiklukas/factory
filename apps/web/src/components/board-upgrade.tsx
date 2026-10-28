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
  mappingChoices,
  mappingSources,
  type MappingRow,
  type UpgradingCard,
  upgradedSummary,
  upgradeInputOf,
  upgradeRefusal,
  upgradeTargets,
} from "@/lib/board-upgrade-view";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

const SELECT_CLASS =
  "h-7 min-w-0 rounded-none border border-input bg-transparent px-1.5 text-xs outline-none focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50 dark:bg-input/30";

/** The "unmapped" choice of a mapping row: its cards refuse the migration until a column is picked. */
const UNMAPPED = "";

/**
 * Where each column's cards go under the target version (D5): one row per column a card to migrate
 * may sit in (`mappingSources`: the pin's, and any an older version's card is left in), preset to the
 * target's column of the same name when there is one. A column the target still declares is offered
 * only itself (`mappingChoices`); a renamed or dropped one, every column of the target. Read from
 * `getDefinition` for the version the form names, so the choices are that version's columns.
 */
const MappingRows = ({
  sources,
  targetKey,
  rows,
  onChange,
}: {
  readonly sources: ReadonlyArray<string>;
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
  const shown = rows ?? defaultMapping(sources, target);
  return (
    <table className="self-start text-xs" data-upgrade-mapping>
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
                        ? {
                            from: entry.from,
                            to: to === UNMAPPED ? undefined : to,
                          }
                        : entry,
                    ),
                  );
                }}
                className={SELECT_CLASS}
              >
                <option value={UNMAPPED}>— not mapped</option>
                {mappingChoices(row.from, target).map((name) => (
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
 * when the person asks, migrate its cards with the mapping on screen. Offered when a newer version
 * exists, or while some card still pins an older version than the board — then the pin itself is
 * offered too, as a migration only, which re-pins the cards an earlier upgrade left behind. Without
 * the migration, new cards pin the new version and existing cards keep theirs; with it, every card is
 * re-pinned or — when one has an unfinished run or a column the mapping leaves out — none is, and the
 * page lists the cards the server named.
 */
export const BoardUpgrade = ({
  boardId,
  definition,
  newer,
  cards,
}: {
  readonly boardId: BoardInstanceId;
  readonly definition: DefinitionConfig;
  readonly newer: ReadonlyArray<number>;
  readonly cards: ReadonlyArray<UpgradingCard>;
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

  const targets = upgradeTargets(definition.version, newer, cards);
  const target =
    toVersion !== undefined && targets.includes(toVersion)
      ? toVersion
      : targets.at(-1);
  // Nothing to offer, but an upgrade this page just made still says what it did.
  if (target === undefined)
    return done === null ? null : <UpgradeDone upgraded={done} />;
  const targetKey = `${definition.id}@${target}`;
  // At the pin there is nothing to upgrade, only cards to re-pin: the migration is the action.
  const atPin = target === definition.version;
  const migrating = migrate || atPin;
  const sources = mappingSources({
    pin: definition.version,
    pinnedColumns: definition.columns.map((column) => column.name),
    target,
    cards,
  });

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
        migrate: migrating,
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
          {targets.map((version) => (
            <option key={version} value={version}>
              {version === definition.version
                ? `v${version} (the board's: re-pin the cards left behind)`
                : `v${version}`}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1.5 text-[11px]">
          <input
            type="checkbox"
            data-upgrade-migrate
            checked={migrating}
            disabled={atPin}
            onChange={(event) => setMigrate(event.currentTarget.checked)}
          />
          Also migrate the board&apos;s cards
        </label>
      </div>
      <p className="text-[11px] text-muted-foreground">
        {atPin
          ? `Every card still on an older version is re-pinned to v${target} in the column picked for its own, or — if one has an unfinished run or sits in a column left unmapped — none is.`
          : migrating
            ? `Every card is re-pinned to v${target} in the column picked for its own, or — if one has an unfinished run or sits in a column left unmapped — none is.`
            : `New cards will pin v${target}; the cards already here keep the version they pin and move by it.`}
      </p>
      {migrating ? (
        <MappingRows
          sources={sources}
          targetKey={targetKey}
          rows={rows}
          onChange={setRows}
        />
      ) : null}
      {migrating ? (
        <MigrateButton
          pending={pending}
          target={target}
          atPin={atPin}
          sources={sources}
          targetKey={targetKey}
          rows={rows}
          onSubmit={submit}
        />
      ) : (
        <Button
          size="sm"
          data-upgrade-submit
          disabled={pending}
          onClick={() => submit([])}
          className="self-start"
        >
          {pending ? "Upgrading…" : `Upgrade to v${target}`}
        </Button>
      )}
      {done === null ? null : <UpgradeDone upgraded={done} />}
      {refused === null ? null : (
        <div
          role="alert"
          data-upgrade-refused
          className="text-[11px] text-destructive"
        >
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

/** What an upgrade this page made did, from its answer (`upgradedSummary`). */
const UpgradeDone = ({ upgraded }: { readonly upgraded: UpgradedBoard }) => (
  <p role="status" data-upgrade-done className="max-w-3xl text-[11px]">
    {upgradedSummary(upgraded)}
  </p>
);

/**
 * The submit button of a migration: the rows it sends are the ones on screen — the preset when the
 * person changed none, which needs the target's columns, so it reads the same atom the rows do. Only
 * mounted once the person asks to migrate, so a page nobody touches sends no read for the target.
 */
const MigrateButton = ({
  pending,
  target,
  atPin,
  sources,
  targetKey,
  rows,
  onSubmit,
}: {
  readonly pending: boolean;
  readonly target: number;
  readonly atPin: boolean;
  readonly sources: ReadonlyArray<string>;
  readonly targetKey: string;
  readonly rows: ReadonlyArray<MappingRow> | undefined;
  readonly onSubmit: (rows: ReadonlyArray<MappingRow>) => void;
}) => {
  const result = useAtomValue(definitionVersionAtom(targetKey));
  const preset = AsyncResult.isSuccess(result)
    ? defaultMapping(
        sources,
        result.value.columns.map((column) => column.name),
      )
    : undefined;
  const shown = rows ?? preset;
  return (
    <Button
      size="sm"
      data-upgrade-submit
      disabled={pending || shown === undefined}
      onClick={() => {
        if (shown !== undefined) onSubmit(shown);
      }}
      className="self-start"
    >
      {pending
        ? "Upgrading…"
        : atPin
          ? `Migrate the cards left behind to v${target}`
          : `Upgrade to v${target} and migrate cards`}
    </Button>
  );
};
