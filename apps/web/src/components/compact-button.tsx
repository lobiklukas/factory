import { Loader2Icon, Minimize2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * The pane header's Compact control (LOB-223, LOB-224), on its own so its markup can be tested.
 *
 * It is never natively `disabled` (LOB-232). The press itself makes it unavailable — `running` is
 * set in the same tick as the click — and a focused `<button>` that becomes `disabled` drops focus
 * to `body` in Chromium and WebKit, so a keyboard operator who pressed Compact was put back at the
 * top of the page. Base UI's `focusableWhenDisabled` renders `aria-disabled` instead and swallows
 * the press itself, so focus stays on the control and a screen reader still reads it as dimmed.
 * The same holds when a run starts under a focused button, and it is what lets the busy reason be
 * heard at all: a natively disabled button is skipped by Tab, so its description was only ever
 * reachable by a screen reader's virtual cursor.
 */
export const CompactButton = ({
  blocked,
  running,
  calling,
  state,
  onPress,
}: {
  /** Why it cannot be pressed now, or `null` when it can; the button's title and description. */
  readonly blocked: string | null;
  /** A compaction is under way: the call is in flight or its task is still live. */
  readonly running: boolean;
  /** The call itself is in flight, which is the only time the button carries a spinner. */
  readonly calling: boolean;
  /** What the last press came to, coarsely, for a drive to read without matching on copy. */
  readonly state: "idle" | "requested" | "settled";
  readonly onPress: () => void;
}) => {
  const unavailable = blocked !== null || running;
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-label={running ? "Compacting session" : "Compact session"}
        data-compaction-state={state}
        title={running ? "Compacting" : (blocked ?? "Compact this session now")}
        aria-busy={running}
        aria-describedby={blocked === null ? undefined : "compact-blocked"}
        disabled={unavailable}
        focusableWhenDisabled
        onClick={() => {
          // Base UI drops a click on an unavailable button already; this keeps the rule local.
          if (unavailable) return;
          onPress();
        }}
      >
        {calling ? (
          <Loader2Icon
            data-slot="spinner"
            aria-hidden
            className="size-4 animate-spin"
          />
        ) : (
          <Minimize2Icon className="size-4" strokeWidth={1.75} />
        )}
        {running ? "Compacting" : "Compact"}
      </Button>
      {blocked === null ? null : (
        <span id="compact-blocked" className="sr-only">
          {blocked}
        </span>
      )}
    </>
  );
};
