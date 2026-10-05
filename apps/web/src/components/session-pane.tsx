import { useEffect, useState } from "react";
import { useAtom, useAtomSet } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { Cause } from "effect";
import { SquareIcon, XIcon } from "lucide-react";
import { cn } from "cn";
import type { SessionId } from "@repo/domain/Session";
import {
  sendMessageAtom,
  sessionAtom,
  type SessionView,
} from "@/lib/atoms/session-atom";
import { forgetSession, recordSession } from "@/lib/atoms/session-registry";
import { TranscriptRow } from "@/components/transcript-entry";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyTitle } from "@/components/ui/empty";
import { Kbd } from "@/components/ui/kbd";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";

/**
 * The header chip.
 *
 * Mintlify labels a finished run `Accepted` and v0 shows `Restarting` beside a
 * live ticker, so state here is one word and a dot, never a sentence. `mode`
 * sits next to it because a folded transcript must never look like a live one
 * (docs/design.md D8).
 */
const StatusChip = ({ view }: { readonly view: SessionView }) => (
  <div className="flex items-center gap-2">
    <Badge
      variant="outline"
      className={cn(
        "gap-1.5 font-mono text-[10px] tracking-wide uppercase",
        view.summary.status === "busy" && "border-ring/40 text-ring",
      )}
    >
      <span
        className={cn(
          "size-1.5",
          view.summary.status === "busy"
            ? "animate-pulse bg-ring"
            : "bg-muted-foreground/50",
        )}
        aria-hidden
      />
      {view.summary.status}
    </Badge>
    <span className="font-mono text-[10px] tracking-wide text-muted-foreground uppercase">
      {view.summary.mode === "live" ? "live stream" : "historical fold"}
    </span>
    {/*
     * Where an in-flight tool call goes now that the transcript does not label
     * calls: v0 puts the current step beside the status word, and one line beats
     * a marker in the transcript that a busy run keeps appending to.
     */}
    {view.live.tools.map((tool) => (
      <span
        key={tool.callId}
        className="font-mono text-[10px] tracking-wide text-muted-foreground"
      >
        {tool.name}
        {tool.status === "running" ? "…" : ""}
      </span>
    ))}
  </div>
);

/**
 * The pane while it attaches.
 *
 * Skeleton lines rather than a spinner alone, so the transcript's shape is
 * already reserved when the first row lands and the composer does not jump.
 * `role="status"` carries the announcement a pile of grey rectangles cannot.
 */
const AttachingSkeleton = () => (
  <div role="status" className="flex flex-col gap-5">
    <span className="sr-only">Attaching to the session</span>
    {[0, 1, 2, 3].map((row) => (
      <div key={row} className="flex flex-col gap-2" aria-hidden>
        <Skeleton className="h-3 w-1/4" />
        <Skeleton className="h-3 w-4/5" />
        <Skeleton className="h-3 w-2/3" />
      </div>
    ))}
  </div>
);

export const SessionPane = ({
  sessionId,
}: {
  readonly sessionId: SessionId;
}) => {
  const [result, attach] = useAtom(sessionAtom);
  const send = useAtomSet(sendMessageAtom);
  const record = useAtomSet(recordSession);
  const forget = useAtomSet(forgetSession);
  const [draft, setDraft] = useState("");

  useEffect(() => {
    attach(sessionId);
  }, [attach, sessionId]);

  const view = AsyncResult.getOrElse(result, () => null);

  // The registry is written here rather than in the atom: writing an atom from
  // an atom needs an `AtomRegistry` in context, and the pane is already the
  // place that knows what the stream last reported.
  useEffect(() => {
    if (view !== null) record(view.summary);
  }, [record, view]);

  const attaching = AsyncResult.isInitial(result);
  const failure = AsyncResult.isFailure(result) ? result.cause : null;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center justify-between gap-4 border-b border-border px-4">
        <div className="flex min-w-0 items-center gap-3">
          <h1 className="truncate text-sm font-medium">
            {view?.summary.title ?? "Session"}
          </h1>
          <span className="truncate font-mono text-[10px] text-muted-foreground">
            {sessionId}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {attaching ? (
            <Spinner className="size-3.5 text-muted-foreground" />
          ) : null}
          {view !== null ? <StatusChip view={view} /> : null}
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Forget this session"
            onClick={() => forget(sessionId)}
          >
            <XIcon className="size-4" strokeWidth={1.75} />
          </Button>
        </div>
      </header>

      {/*
       * The scroller follows the stream: a live run appends while you read, and
       * before this the pane never moved, so the newest line was always the one
       * you had to scroll to find. `defaultScrollPosition="end"` opens on the
       * latest row, and the button appears only once you have scrolled away.
       */}
      <MessageScrollerProvider defaultScrollPosition="end" autoScroll>
        {/*
         * The wrapper exists because the primitive's root is `size-full`, and
         * `h-full` only resolves against a parent with a definite height. A
         * `flex-1 min-h-0` box gives it one; without it the scroller sizes to its
         * content and the composer leaves the viewport.
         */}
        <div className="flex min-h-0 flex-1 flex-col">
          <MessageScroller>
            <MessageScrollerViewport aria-label="Transcript">
              <MessageScrollerContent className="mx-auto w-full max-w-[68ch] gap-5 px-6 py-6">
                {attaching ? <AttachingSkeleton /> : null}

                {failure !== null ? (
                  <Alert variant="destructive">
                    <AlertTitle>This session could not be read</AlertTitle>
                    <AlertDescription>
                      The control plane refused the attach. What it said:
                      <pre className="mt-1 max-h-40 overflow-auto font-mono text-[11px] whitespace-pre-wrap">
                        {Cause.pretty(failure)}
                      </pre>
                    </AlertDescription>
                  </Alert>
                ) : null}

                {view?.entries.map((entry, index) => (
                  <MessageScrollerItem
                    key={entry.id}
                    messageId={entry.id}
                    scrollAnchor={index === view.entries.length - 1}
                  >
                    <TranscriptRow entry={entry} />
                  </MessageScrollerItem>
                ))}

                {view !== null && view.entries.length === 0 ? (
                  <Empty>
                    <EmptyTitle>Nothing in this log yet</EmptyTitle>
                    <EmptyDescription>
                      The run has opened and committed nothing. Send it
                      something and the first entry lands here.
                    </EmptyDescription>
                  </Empty>
                ) : null}
              </MessageScrollerContent>
            </MessageScrollerViewport>
            <MessageScrollerButton />
          </MessageScroller>
        </div>
      </MessageScrollerProvider>

      <div className="shrink-0 border-t border-border px-6 py-3">
        <form
          className="mx-auto flex max-w-[68ch] flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (draft.trim().length === 0) return;
            send({ sessionId, content: draft });
            setDraft("");
          }}
        >
          <div className="flex items-end gap-2">
            <Textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="Send a message to this session"
              rows={1}
              className="min-h-9 resize-none"
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
            />
            {view?.summary.status === "busy" ? (
              <Button
                type="button"
                variant="outline"
                size="icon"
                aria-label="Interrupt this run"
              >
                <SquareIcon className="size-4" strokeWidth={1.75} />
              </Button>
            ) : null}
            <Button type="submit" disabled={draft.trim().length === 0}>
              Send
            </Button>
          </div>
          {/* Enter-to-send was real but undiscoverable; this is the only place
              the composer states its own contract. */}
          <p className="flex items-center gap-1.5 font-mono text-[10px] text-muted-foreground">
            <Kbd>Enter</Kbd> send
            <Kbd>Shift</Kbd>
            <Kbd>Enter</Kbd> newline
          </p>
        </form>
      </div>
    </div>
  );
};
