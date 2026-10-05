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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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

  return (
    <div className="flex min-w-0 flex-1 flex-col">
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

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-[68ch] flex-col gap-5 px-6 py-6">
          {AsyncResult.isInitial(result) ? (
            <p className="text-sm text-muted-foreground">Attaching…</p>
          ) : null}

          {AsyncResult.isFailure(result) ? (
            <div className="border border-destructive/30 bg-destructive/5 px-3 py-2">
              <p className="text-sm text-destructive">
                {Cause.pretty(result.cause)}
              </p>
            </div>
          ) : null}

          {view?.entries.map((entry) => (
            <TranscriptRow key={entry.id} entry={entry} />
          ))}

          {view !== null && view.entries.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing in this log yet.
            </p>
          ) : null}
        </div>
      </div>

      <div className="shrink-0 border-t border-border px-6 py-3">
        <form
          className="mx-auto flex max-w-[68ch] items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (draft.trim().length === 0) return;
            send({ sessionId, content: draft });
            setDraft("");
          }}
        >
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
        </form>
      </div>
    </div>
  );
};
