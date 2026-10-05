import { useState } from "react";
import type { TranscriptEntry } from "@repo/domain/Session";
import { ChevronRightIcon, TerminalIcon } from "lucide-react";
import { cn } from "cn";

/**
 * One transcript row.
 *
 * The reference set agreed on one thing: tool activity is a disclosure, not a
 * card per step (Cofounder's `Preview / Changes / Replay / Screenshot` tabs,
 * Devin's "Worked for 11s" chevron, Mintlify's activity timeline). A coding run
 * emits dozens of tool calls, so a card each would bury the answer the user
 * actually came for. Assistant prose runs full width; only the user's own
 * message gets a surface, because that is the one line being attributed.
 */
export const TranscriptRow = ({
  entry,
}: {
  readonly entry: TranscriptEntry;
}) => {
  const [open, setOpen] = useState(false);

  if (entry.kind === "user") {
    return (
      <div className="flex justify-end">
        <p className="max-w-[85%] bg-muted px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap">
          {entry.text}
        </p>
      </div>
    );
  }

  if (
    entry.kind === "system" ||
    entry.kind === "reset" ||
    entry.kind === "compaction"
  ) {
    return (
      <div className="flex items-center gap-3 py-1 font-mono text-[10px] tracking-wide text-muted-foreground uppercase">
        <span className="h-px flex-1 bg-border" />
        {entry.kind}
        <span className="h-px flex-1 bg-border" />
      </div>
    );
  }

  if (entry.kind === "toolResult") {
    return (
      <div className="border border-border bg-muted/40">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left font-mono text-[11px] text-muted-foreground transition-colors hover:text-foreground"
        >
          <ChevronRightIcon
            className={cn(
              "size-3.5 shrink-0 transition-transform",
              open && "rotate-90",
            )}
            strokeWidth={1.75}
          />
          <TerminalIcon className="size-3.5 shrink-0" strokeWidth={1.75} />
          <span className={cn(entry.isError === true && "text-destructive")}>
            {entry.toolName ?? "tool"}
          </span>
        </button>
        {open ? (
          <pre className="max-h-80 overflow-auto border-t border-border px-2.5 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
            {entry.text}
          </pre>
        ) : null}
      </div>
    );
  }

  // The tool calls are not listed here on purpose: a `toolResult` entry follows
  // every call and already carries the name inside its disclosure, so a label
  // above it says the same thing twice. A call still in flight shows up in the
  // header's live tools instead.
  return (
    <div className="flex flex-col gap-2">
      {entry.text.length > 0 ? (
        <p className="text-sm leading-relaxed whitespace-pre-wrap">
          {entry.text}
        </p>
      ) : null}
    </div>
  );
};
