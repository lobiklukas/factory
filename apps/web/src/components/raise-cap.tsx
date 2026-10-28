import { useState } from "react";
import { TrendingUpIcon } from "lucide-react";
import { raiseCapAttempt } from "@/lib/budget-view";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";

/**
 * The "Raise cap" action under a budget stop (C23), on its own so its markup and its press can be
 * tested. One press is one `setSessionBudget` call: while it is in flight the control is unavailable
 * and a second press is dropped. A cap the typed text does not make is said on the spot and sent
 * nowhere. Never natively `disabled`, for the reason the Interrupt control is not (LOB-232).
 */
export const RaiseCap = ({
  initial,
  spent,
  calling,
  onRaise,
}: {
  /** What the field opens with (`suggestedCap`). */
  readonly initial: string;
  /** What the session has spent, so a cap at or below it is refused here. */
  readonly spent: number;
  /** The call is in flight. */
  readonly calling: boolean;
  readonly onRaise: (budget: number) => void;
}) => {
  const [typed, setTyped] = useState(initial);
  const attempt = raiseCapAttempt(typed, spent);
  const showProblem = !attempt.ok && typed.trim() !== initial.trim();
  const press = () => {
    if (calling || !attempt.ok) return;
    onRaise(attempt.budget);
  };
  return (
    <form
      aria-label="Raise this session's cap"
      data-raise-cap
      className="flex flex-col gap-1.5 pl-6"
      onSubmit={(event) => {
        event.preventDefault();
        press();
      }}
    >
      <div className="flex items-center gap-2">
        <Label
          htmlFor="raise-cap-input"
          className="text-[11px] text-muted-foreground"
        >
          New cap, US$
        </Label>
        <Input
          id="raise-cap-input"
          name="cap"
          data-raise-cap-input
          inputMode="decimal"
          value={typed}
          onChange={(event) => setTyped(event.currentTarget.value)}
          autoComplete="off"
          aria-invalid={showProblem}
          aria-describedby={showProblem ? "raise-cap-bad" : undefined}
          className="h-7 w-24 font-mono text-xs"
        />
        <Button
          type="submit"
          size="sm"
          variant="outline"
          data-raise-cap-submit
          aria-busy={calling}
          aria-disabled={calling || !attempt.ok}
          focusableWhenDisabled
          disabled={calling || !attempt.ok}
        >
          {calling ? (
            <Spinner className="size-3.5" />
          ) : (
            <TrendingUpIcon className="size-3.5" strokeWidth={1.75} />
          )}
          Raise cap
        </Button>
      </div>
      {showProblem && !attempt.ok ? (
        <p
          id="raise-cap-bad"
          data-raise-cap-invalid
          className="text-[11px] text-destructive"
        >
          {attempt.reason}.
        </p>
      ) : null}
    </form>
  );
};
