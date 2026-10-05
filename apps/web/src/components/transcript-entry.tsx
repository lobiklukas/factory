import { useState } from "react";
import type { TranscriptEntry } from "@repo/domain/Session";
import { ChevronRightIcon, TerminalIcon } from "lucide-react";
import { cn } from "cn";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Marker, MarkerContent } from "@/components/ui/marker";
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
}: {
  readonly entry: TranscriptEntry;
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

  if (
    entry.kind === "system" ||
    entry.kind === "reset" ||
    entry.kind === "compaction"
  ) {
    return (
      <Marker
        variant="separator"
        className="gap-3 py-1 font-mono text-[10px] tracking-wide uppercase"
      >
        <MarkerContent>{entry.kind}</MarkerContent>
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
