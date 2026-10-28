import { TriangleAlertIcon } from "lucide-react";

/**
 * The server's warning that a repository has no local checkout (LOB-263): a run there gets an empty
 * directory instead of a worktree, so no card can produce a diff. Shown under the header of the
 * board and the session it is about, with the fix the server names — nothing renders when there is
 * no warning, so a checked-out repo's page is what it was.
 */
export const CheckoutWarning = ({
  warning,
}: {
  readonly warning: string | undefined;
}) =>
  warning === undefined ? null : (
    <div
      role="status"
      data-checkout-warning
      className="flex shrink-0 items-start gap-2 border-b border-border bg-muted/40 px-4 py-2 text-xs text-muted-foreground"
    >
      <TriangleAlertIcon
        aria-hidden
        strokeWidth={1.75}
        className="mt-px size-3.5 shrink-0"
      />
      <span className="min-w-0 break-words">{warning}</span>
    </div>
  );
