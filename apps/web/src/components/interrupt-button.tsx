import { SquareIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

/**
 * The composer's Interrupt control (C8), on its own so its markup and its press can be tested.
 *
 * One press is one `interruptSession` call: while the call is in flight the control is unavailable
 * and a second press is dropped, so an impatient double click does not interrupt the follow-up the
 * operator sends next. Never natively `disabled`, for the reason the Compact control is not
 * (LOB-232): a focused `<button>` that turns `disabled` drops focus to `body`.
 */
export const InterruptButton = ({
  calling,
  onPress,
}: {
  /** The interrupt call is in flight. */
  readonly calling: boolean;
  readonly onPress: () => void;
}) => (
  <Button
    type="button"
    variant="outline"
    size="icon"
    aria-label="Interrupt this run"
    title="Interrupt this run"
    aria-busy={calling}
    data-interrupt-state={calling ? "calling" : "idle"}
    disabled={calling}
    focusableWhenDisabled
    onClick={() => {
      // Base UI drops a click on an unavailable button already; this keeps the rule local.
      if (calling) return;
      onPress();
    }}
  >
    {calling ? (
      <Spinner className="size-4 text-muted-foreground" />
    ) : (
      <SquareIcon className="size-4" strokeWidth={1.75} />
    )}
  </Button>
);
