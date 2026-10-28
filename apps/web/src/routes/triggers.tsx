import { createFileRoute, Link } from "@tanstack/react-router";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { Cause, Exit, Option } from "effect";
import { WebhookIcon } from "lucide-react";
import { useEffect, useState } from "react";
import type { DeliveryRecord } from "@repo/domain/Trigger";
import {
  olderDeliveriesAtom,
  triggerDeliveriesAtom,
} from "@/lib/atoms/triggers-atom";
import {
  deliveryTarget,
  emptyMessage,
  filterInput,
  filterKey,
  mergeDeliveries,
  receivedLabel,
  SOURCE_FILTERS,
  STATUS_FILTERS,
  STATUS_MEANING,
  statusLabel,
  type SourceFilter,
  type StatusFilter,
} from "@/lib/triggers-view";
import { EmptyPane } from "@/components/empty-pane";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "cn";

export const Route = createFileRoute("/triggers")({
  component: TriggersRoute,
});

/**
 * Trigger deliveries (T4): what the seam did with each webhook it received, newest first — the page
 * an operator opens when a labelled issue started nothing.
 *
 * The list is `listTriggerDeliveries` and nothing else, polled. Each row says whether the delivery
 * was processed, skipped or is still in flight, and shows the reason exactly as the seam recorded
 * it: a skip's reason names what to fix (a repo nobody registered, a label no rule claims), and a
 * processed delivery's names the rule that routed it and links the session it opened. A webhook
 * refused before the seam — a wrong signature, a body over the cap, a route with no secret — is
 * logged by the API and never recorded, so it is absent here by design.
 */
function TriggersRoute() {
  const [status, setStatus] = useState<StatusFilter>("all");
  const [source, setSource] = useState<SourceFilter>("all");

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-border px-4 py-3">
        <h1 className="text-sm font-medium">Triggers</h1>
        <span className="text-[11px] text-muted-foreground">
          what the seam did with each delivery
        </span>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-6">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <div
            role="group"
            aria-label="Outcome"
            className="flex flex-wrap items-center gap-1"
          >
            {STATUS_FILTERS.map((candidate) => (
              <Button
                key={candidate}
                type="button"
                size="sm"
                variant={candidate === status ? "default" : "outline"}
                aria-pressed={candidate === status}
                data-triggers-status={candidate}
                title={
                  candidate === "all"
                    ? "Every delivery the seam recorded"
                    : STATUS_MEANING[candidate]
                }
                onClick={() => setStatus(candidate)}
              >
                {statusLabel(candidate)}
              </Button>
            ))}
          </div>
          <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
            Source
            <select
              data-triggers-source
              value={source}
              onChange={(event) =>
                setSource(
                  SOURCE_FILTERS.find(
                    (candidate) => candidate === event.currentTarget.value,
                  ) ?? "all",
                )
              }
              className="h-7 border border-input bg-background px-2 font-mono text-xs text-foreground"
            >
              {SOURCE_FILTERS.map((candidate) => (
                <option key={candidate} value={candidate}>
                  {candidate === "all" ? "all sources" : candidate}
                </option>
              ))}
            </select>
          </label>
        </div>
        {/* Keyed by the filter, so the older pages a person loaded are dropped when it changes. */}
        <DeliveryList
          key={filterKey(status, source)}
          status={status}
          source={source}
        />
      </div>
    </div>
  );
}

/** The newest page, polled, and the older pages the person asked for, under one filter. */
const DeliveryList = ({
  status,
  source,
}: {
  readonly status: StatusFilter;
  readonly source: SourceFilter;
}) => {
  const result = useAtomValue(triggerDeliveriesAtom(filterKey(status, source)));
  const loadOlder = useAtomSet(olderDeliveriesAtom, { mode: "promiseExit" });
  const [older, setOlder] = useState<ReadonlyArray<DeliveryRecord>>([]);
  // `undefined`: no older page read yet, so the head's cursor is the way on; `null`: none left.
  const [olderCursor, setOlderCursor] = useState<string | null | undefined>(
    undefined,
  );
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  // As on the repositories view: a failed poll keeps the last answer on screen with a marker; only
  // a first read that fails replaces the list.
  const last = Option.getOrUndefined(AsyncResult.value(result));

  // Once older pages are held, every head the poll reads is held too. A delivery that arrives
  // pushes the head's last row out of the head, and the older pages start after the head as it was
  // when they were asked for, so without this that row is in neither list and silently vanishes.
  useEffect(() => {
    if (last === undefined || olderCursor === undefined) return;
    setOlder((held) => mergeDeliveries(last.deliveries, held));
  }, [last, olderCursor]);
  const stale = AsyncResult.isFailure(result) ? result.cause : undefined;

  if (AsyncResult.isInitial(result)) {
    return (
      <div role="status" className="flex flex-col gap-3">
        <span className="sr-only">Loading deliveries</span>
        {[0, 1, 2].map((row) => (
          <Skeleton key={row} className="h-16 w-full max-w-3xl" aria-hidden />
        ))}
      </div>
    );
  }
  if (last === undefined) {
    return (
      <EmptyPane
        icon={<WebhookIcon strokeWidth={1.75} />}
        title="Deliveries did not load"
        detail={stale === undefined ? "No answer yet." : Cause.pretty(stale)}
        visible
      />
    );
  }

  const rows = mergeDeliveries(last.deliveries, older);
  const cursor = olderCursor === undefined ? last.nextCursor : olderCursor;

  const showOlder = () => {
    if (cursor === undefined || cursor === null) return;
    const headAtClick = last.deliveries;
    setLoading(true);
    setFailure(null);
    void loadOlder({ ...filterInput(status, source), cursor })
      .then((exit) => {
        if (Exit.isSuccess(exit)) {
          // The head as it was when the page was asked for is held with it: the page starts after it.
          setOlder((held) =>
            mergeDeliveries(
              mergeDeliveries(headAtClick, held),
              exit.value.deliveries,
            ),
          );
          setOlderCursor(exit.value.nextCursor ?? null);
          return;
        }
        setFailure(Cause.pretty(exit.cause));
      })
      .finally(() => setLoading(false));
  };

  return (
    <>
      {stale === undefined ? null : (
        <p
          role="status"
          data-triggers-stale
          title={Cause.pretty(stale)}
          className="text-[11px] text-destructive"
        >
          Reconnecting: showing the last answer the server gave
        </p>
      )}
      {rows.length === 0 ? (
        <p
          data-triggers-empty
          className="max-w-3xl text-xs text-muted-foreground"
        >
          {emptyMessage(status, source)}
        </p>
      ) : (
        <ul
          aria-label="Deliveries"
          data-triggers-count={rows.length}
          className="flex max-w-3xl flex-col gap-2"
        >
          {rows.map((delivery) => (
            <DeliveryRow key={delivery.deliveryId} delivery={delivery} />
          ))}
        </ul>
      )}
      {cursor === undefined || cursor === null ? null : (
        <div className="flex max-w-3xl flex-col items-start gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-triggers-older
            disabled={loading}
            aria-busy={loading}
            onClick={showOlder}
          >
            {loading ? <Spinner className="size-3.5" /> : null}
            Show older
          </Button>
          {failure === null ? null : (
            <p
              role="alert"
              data-triggers-older-failure
              className="font-mono text-[11px] break-words text-destructive"
            >
              {failure}
            </p>
          )}
        </div>
      )}
    </>
  );
};

/**
 * One delivery: how it ended, who sent it, when, and the seam's reason verbatim. A processed
 * delivery names what it started: a session links to its pane, a card shows its id.
 */
const DeliveryRow = ({ delivery }: { readonly delivery: DeliveryRecord }) => {
  const target = deliveryTarget(delivery);
  return (
    <li
      data-delivery={delivery.deliveryId}
      data-delivery-status={delivery.status}
      data-delivery-source={delivery.source ?? "unknown"}
      className={cn(
        "flex min-w-0 flex-col gap-1.5 border border-border bg-card px-3 py-2.5",
        delivery.status === "skipped" && "border-l-2 border-l-destructive",
      )}
    >
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
        <span
          data-delivery-outcome
          title={STATUS_MEANING[delivery.status]}
          className={cn(
            "text-[11px] font-medium",
            delivery.status === "skipped" && "text-destructive",
          )}
        >
          {delivery.status === "received" ? "in flight" : delivery.status}
        </span>
        <span className="font-mono text-[11px]">
          {delivery.source ?? "unknown source"}
        </span>
        <time
          dateTime={delivery.receivedAt}
          title={delivery.receivedAt}
          className="ml-auto font-mono text-[10px] text-muted-foreground"
        >
          {receivedLabel(delivery.receivedAt)}
        </time>
      </div>
      {delivery.reason === undefined ? null : (
        <p
          data-delivery-reason
          className="text-xs leading-relaxed break-words whitespace-pre-wrap"
        >
          {delivery.reason}
        </p>
      )}
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-4 gap-y-0.5 font-mono text-[10px] text-muted-foreground">
        <span data-delivery-id className="break-all">
          {delivery.deliveryId}
        </span>
        {target.kind === "session" ? (
          <Link
            to="/sessions/$sessionId"
            params={{ sessionId: target.id }}
            data-delivery-session={target.id}
            className="text-foreground underline underline-offset-2"
          >
            session {target.id}
          </Link>
        ) : target.kind === "card" ? (
          <span data-delivery-card={target.id} className="text-foreground">
            card {target.id}
          </span>
        ) : null}
      </div>
    </li>
  );
};
