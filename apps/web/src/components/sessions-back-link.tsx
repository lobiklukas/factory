import { Link } from "@tanstack/react-router";
import { ChevronLeftIcon } from "lucide-react";
import { cn } from "cn";
import { buttonVariants } from "@/components/ui/button";

/**
 * Back to the list (LOB-210). Below `md` the list is not beside a session's route but is the whole
 * of `/sessions`, so this is how a phone reaches it; from `md` up the list is on screen and the
 * link is `display: none`, so it adds nothing to the tab order there. A link, not a button: it
 * moves the route, and a reader can open the list in another tab.
 *
 * Every pane a session's route can render carries it, the refused-id pane included: below `md`
 * that route hides the list whatever the id decodes to, so a pane without it would leave the rail
 * as the only way back.
 */
export const SessionsBackLink = ({
  className,
}: {
  readonly className?: string;
}) => (
  <Link
    to="/sessions"
    aria-label="Show sessions"
    title="Show sessions"
    className={cn(
      buttonVariants({ variant: "ghost", size: "icon-sm" }),
      "md:hidden",
      className,
    )}
  >
    <ChevronLeftIcon className="size-4" strokeWidth={1.75} />
  </Link>
);
