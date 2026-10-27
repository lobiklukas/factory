import { createFileRoute } from "@tanstack/react-router";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { Cause, Option } from "effect";
import { CoinsIcon } from "lucide-react";
import type { SpendRow } from "@repo/domain/Session";
import { spendAtom } from "@/lib/atoms/spend-atom";
import {
  actorLabel,
  formatSpendDollars,
  pairKey,
  repoLabel,
  sessionCount,
  spendByActor,
  spendByRepo,
  type SpendLine,
} from "@/lib/spend-view";
import { EmptyPane } from "@/components/empty-pane";
import { Skeleton } from "@/components/ui/skeleton";

export const Route = createFileRoute("/spend")({
  component: SpendRoute,
});

/**
 * Spend keyed by repo and actor (LOB-162, part 2 of LOB-17): what the factory's sessions cost, per
 * repository, per actor, and per pair of the two.
 *
 * The page is `listSpend` and nothing else. The server groups the same index the session list
 * reads, so a session's cost here is the cost the sidebar shows. The two roll-ups are its pairs
 * added in the browser, so the three blocks always agree. An actor is who the session's creator
 * said it was (`cli`, `dashboard`, `trigger:<source>`): identity beyond that string is LOB-20's,
 * and a session nobody was attributed to is listed as `unattributed`, never guessed.
 */
function SpendRoute() {
  const result = useAtomValue(spendAtom);

  if (AsyncResult.isInitial(result)) {
    return (
      <div role="status" className="flex flex-1 flex-col gap-3 p-6">
        <span className="sr-only">Loading spend</span>
        {[0, 1, 2].map((row) => (
          <Skeleton key={row} className="h-12 w-full max-w-2xl" aria-hidden />
        ))}
      </div>
    );
  }

  // As on the attention view: a failed poll keeps the last answer on screen with a marker; only a
  // first read that fails replaces the page.
  const last = Option.getOrUndefined(AsyncResult.value(result));
  if (AsyncResult.isFailure(result) && last === undefined) {
    return (
      <EmptyPane
        icon={<CoinsIcon strokeWidth={1.75} />}
        title="Spend did not load"
        detail={Cause.pretty(result.cause)}
        visible
      />
    );
  }
  if (last === undefined) return null;
  const stale = AsyncResult.isFailure(result) ? result.cause : undefined;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-border px-4 py-3">
        <h1 className="text-sm font-medium">Spend</h1>
        <span className="text-[11px] text-muted-foreground">
          by repo and actor
        </span>
        {stale === undefined ? null : (
          <span
            role="status"
            data-spend-stale
            title={Cause.pretty(stale)}
            className="text-[11px] text-destructive"
          >
            Reconnecting: showing the last answer the server gave
          </span>
        )}
        <span
          data-spend-total={last.costTotal}
          data-spend-sessions={last.sessions}
          className="ml-auto font-mono text-[11px] text-muted-foreground"
        >
          {formatSpendDollars(last.costTotal)} across{" "}
          {sessionCount(last.sessions)}
        </span>
      </header>
      {last.rows.length === 0 ? (
        <div data-spend-empty className="flex min-h-0 flex-1 flex-col">
          <EmptyPane
            icon={<CoinsIcon strokeWidth={1.75} />}
            title="No spend recorded"
            detail="No session on this control plane has run yet. Spend appears here, per repo and per actor, once a session makes a model request."
            visible
          />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-6">
          <div className="grid max-w-4xl gap-6 md:grid-cols-2">
            <SpendList
              by="repo"
              title="By repo"
              lines={spendByRepo(last)}
              total={last.costTotal}
            />
            <SpendList
              by="actor"
              title="By actor"
              lines={spendByActor(last)}
              total={last.costTotal}
            />
          </div>
          <SpendPairs rows={last.rows} />
        </div>
      )}
    </div>
  );
}

/**
 * One roll-up: a line per repo (or per actor) with its cost, its session count, and a bar for its
 * share of the total. The share is the bar's width and nothing else, so it never needs a legend.
 */
const SpendList = ({
  by,
  title,
  lines,
  total,
}: {
  readonly by: "repo" | "actor";
  readonly title: string;
  readonly lines: ReadonlyArray<SpendLine>;
  readonly total: number;
}) => (
  <section
    data-spend-group={by}
    aria-label={title}
    className="flex min-w-0 flex-col gap-2"
  >
    <h2 className="flex items-baseline gap-2 text-xs font-medium">
      {title}
      <span className="font-mono text-[10px] text-muted-foreground">
        {lines.length}
      </span>
    </h2>
    <ul className="flex flex-col gap-1">
      {lines.map((line) => (
        <li
          key={line.key ?? ""}
          data-spend-line={line.label}
          data-spend-absent={line.key === undefined ? "" : undefined}
          data-spend-cost={line.costTotal}
          data-spend-count={line.sessions}
          className="relative flex min-w-0 items-baseline gap-2 border border-border bg-card px-3 py-2"
        >
          <span
            aria-hidden
            className="absolute inset-y-0 left-0 bg-muted"
            style={{
              width: `${total === 0 ? 0 : (line.costTotal / total) * 100}%`,
            }}
          />
          <span
            className={
              line.key === undefined
                ? "relative truncate font-mono text-xs text-muted-foreground italic"
                : "relative truncate font-mono text-xs"
            }
          >
            {line.label}
          </span>
          <span className="relative ml-auto shrink-0 text-[11px] text-muted-foreground">
            {sessionCount(line.sessions)}
          </span>
          <span className="relative w-28 shrink-0 text-right font-mono text-xs tabular-nums">
            {formatSpendDollars(line.costTotal)}
          </span>
        </li>
      ))}
    </ul>
  </section>
);

/** The finest grain the server answers: one row per (repo, actor) pair, costliest first. */
const SpendPairs = ({ rows }: { readonly rows: ReadonlyArray<SpendRow> }) => (
  <section
    data-spend-group="pair"
    aria-label="By repo and actor"
    className="flex max-w-4xl flex-col gap-2"
  >
    <h2 className="flex items-baseline gap-2 text-xs font-medium">
      By repo and actor
      <span className="font-mono text-[10px] text-muted-foreground">
        {rows.length}
      </span>
    </h2>
    <table className="w-full border-collapse text-xs">
      <thead>
        <tr className="border-b border-border text-left text-[11px] text-muted-foreground">
          <th scope="col" className="py-1 pr-3 font-normal">
            Repo
          </th>
          <th scope="col" className="py-1 pr-3 font-normal">
            Actor
          </th>
          <th scope="col" className="py-1 pr-3 text-right font-normal">
            Sessions
          </th>
          <th scope="col" className="py-1 text-right font-normal">
            Cost
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr
            key={pairKey(row)}
            data-spend-pair=""
            data-spend-repo={repoLabel(row.repo)}
            data-spend-actor={actorLabel(row.actor)}
            data-spend-cost={row.costTotal}
            data-spend-count={row.sessions}
            className="border-b border-border/60"
          >
            <td className="py-1.5 pr-3 font-mono">{repoLabel(row.repo)}</td>
            <td className="py-1.5 pr-3 font-mono">{actorLabel(row.actor)}</td>
            <td className="py-1.5 pr-3 text-right tabular-nums">
              {row.sessions}
            </td>
            <td className="py-1.5 text-right font-mono tabular-nums">
              {formatSpendDollars(row.costTotal)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  </section>
);
