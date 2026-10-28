import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { buttonVariants } from "@/components/ui/button";

/**
 * The next action an empty pane names (C9): a link into the dashboard, never a command to type in a
 * terminal. An empty state with no press in it leaves a new operator where the owner found the
 * dashboard — "when I open UI I can't do anything" — so every pane that has nothing to show says
 * where to go to change that. The `data-empty-action` attribute is what the drive asserts on.
 */
export const EmptyLink = ({
  to,
  children,
}: {
  readonly to: "/boards" | "/sessions" | "/repos";
  readonly children: ReactNode;
}) => (
  <Link
    to={to}
    data-empty-action={to}
    className={buttonVariants({ size: "sm", variant: "outline" })}
  >
    {children}
  </Link>
);
