import { useState } from "react";
import type { TranscriptEntry } from "@repo/domain/Session";
import {
  ChevronRightIcon,
  CircleStopIcon,
  GitPullRequestIcon,
  TerminalIcon,
} from "lucide-react";
import { cn } from "cn";
import type { SpendDelta } from "@/lib/compaction-view";
import { spendHeading } from "@/lib/compaction-view";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker";
import { Message, MessageContent } from "@/components/ui/message";

/**
 * One transcript row.
 *
 * The reference set agreed on one thing: tool activity is a disclosure, not a
 * card per step (Cofounder's `Preview / Changes / Replay / Screenshot` tabs,
 * Devin's "Worked for 11s" chevron, Mintlify's activity timeline). A coding run
 * emits dozens of tool calls, so a card each would bury the answer the user
 * actually came for. Assistant prose runs full width; only the user's own
 * message gets a surface, because that is the one line being attributed.
 *
 * The row is `Message` so both alignments share one contract, and the enter
 * animation is the one motion here that carries information: a row appearing
 * below the fold while you read above it. The global reduced-motion block in
 * `index.css` collapses it.
 */
export const TranscriptRow = ({
  entry,
  spend,
}: {
  readonly entry: TranscriptEntry;
  /**
   * What the compaction this pane asked for spent, when this row is the summary it wrote
   * (LOB-223). The pane computes it and passes it in: the row reads no atoms, so it stays a
   * function of its props and the arithmetic lives in a module a test can call.
   */
  readonly spend?: SpendDelta | undefined;
}) => {
  const [open, setOpen] = useState(false);

  if (entry.kind === "user") {
    return (
      <Message align="end" className="animate-in fade-in">
        <MessageContent>
          <Bubble variant="muted">
            <BubbleContent className="text-sm whitespace-pre-wrap">
              {entry.text}
            </BubbleContent>
          </Bubble>
        </MessageContent>
      </Message>
    );
  }

  if (entry.kind === "compaction") {
    // The summary is what the model now sees in place of the turns above it, so it is the one
    // marker that has to carry text: a bare `compaction` label hid the answer the operator
    // compacted a session to read (LOB-223). The separator stays, because the rows above and
    // below it are still the log they always were — nothing was dropped.
    return (
      <div className="animate-in fade-in flex flex-col gap-2">
        <Marker
          variant="separator"
          className="gap-3 py-1 font-mono text-[10px] tracking-wide uppercase"
        >
          <MarkerContent>compaction</MarkerContent>
        </Marker>
        <Message>
          <MessageContent>
            {entry.text.length > 0 ? (
              <p className="text-sm leading-relaxed whitespace-pre-wrap">
                {entry.text}
              </p>
            ) : (
              <p className="text-sm leading-relaxed text-muted-foreground">
                Compacted. The log kept no summary text for this cut.
              </p>
            )}
            {spend === undefined ? null : (
              <p
                data-compaction-spend
                className="mt-1 font-mono text-[11px] text-muted-foreground tabular-nums"
              >
                {spendHeading(spend)} to compact
              </p>
            )}
          </MessageContent>
        </Message>
      </div>
    );
  }

  if (entry.kind === "system" || entry.kind === "reset") {
    return (
      <Marker
        variant="separator"
        className="gap-3 py-1 font-mono text-[10px] tracking-wide uppercase"
      >
        <MarkerContent>{entry.kind}</MarkerContent>
      </Marker>
    );
  }

  // A budget stop (LOB-163) is the control plane speaking, not the agent: a
  // marker row with the line it recorded, so it never reads as a reply.
  if (entry.kind === "budget") {
    return (
      <Marker variant="border" className="text-destructive" role="status">
        <MarkerIcon>
          <CircleStopIcon strokeWidth={1.75} />
        </MarkerIcon>
        <MarkerContent>{entry.text}</MarkerContent>
      </Marker>
    );
  }

  // A line a fork inherited (LOB-211) is history the control plane kept, not the
  // agent speaking: a muted marker naming whose PR it was, so the fork's
  // transcript never reads as if this session opened it.
  if (entry.kind === "inherited") {
    return (
      <Marker variant="border" className="text-muted-foreground">
        <MarkerIcon>
          <GitPullRequestIcon strokeWidth={1.75} />
        </MarkerIcon>
        <MarkerContent>{entry.text}</MarkerContent>
      </Marker>
    );
  }

  if (entry.kind === "toolResult") {
    return (
      <Collapsible
        open={open}
        onOpenChange={setOpen}
        className="animate-in fade-in border border-border bg-muted/40"
      >
        <CollapsibleTrigger className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left font-mono text-[11px] text-muted-foreground transition-colors hover:text-foreground">
          <ChevronRightIcon
            className={cn(
              "size-3.5 shrink-0 transition-transform motion-safe:duration-200",
              open && "rotate-90",
            )}
            strokeWidth={1.75}
          />
          <TerminalIcon className="size-3.5 shrink-0" strokeWidth={1.75} />
          <span className={cn(entry.isError === true && "text-destructive")}>
            {entry.toolName ?? "tool"}
          </span>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <pre className="max-h-80 overflow-auto border-t border-border px-2.5 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
            {entry.text}
          </pre>
        </CollapsibleContent>
      </Collapsible>
    );
  }

  // The tool calls are not listed here on purpose: a `toolResult` entry follows
  // every call and already carries the name inside its disclosure, so a label
  // above it says the same thing twice. A call still in flight shows up in the
  // header's live tools instead.
  return (
    <Message className="animate-in fade-in">
      <MessageContent>
        {entry.text.length > 0 ? (
          <p className="text-sm leading-relaxed whitespace-pre-wrap">
            {entry.text}
          </p>
        ) : null}
      </MessageContent>
    </Message>
  );
};
