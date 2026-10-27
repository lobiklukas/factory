import { Link, useRouterState } from "@tanstack/react-router";
import { BellIcon, KanbanSquareIcon, TerminalIcon } from "lucide-react";
import { cn } from "cn";
import { FactoryMark } from "@/components/factory-mark";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ThemeToggle } from "@/components/theme-toggle";

/**
 * The narrow rail. Vercel's dashboard pattern: sections are icons because there
 * are only a handful of them, and a label per icon costs 48px of width for nothing. The
 * label moves into a tooltip on hover and into the pane's own header, so the name
 * is never lost.
 */
const SECTIONS = [
  // The board leads (LOB-75): the cockpit is the board (docs/board.md), and sessions are the runs
  // a card owns. Sandboxes and approvals left the rail for panes inside a card's run (LOB-76): each
  // means something only for one run, so a top-level list with no card around it is the wrong
  // question. Their routes stay, so an old link still says what it used to.
  { to: "/boards", label: "Boards", icon: KanbanSquareIcon },
  // What needs a person, across every board (LOB-77): the question the board exists to answer.
  { to: "/attention", label: "Needs a person", icon: BellIcon },
  { to: "/sessions", label: "Sessions", icon: TerminalIcon },
] as const;

export const NavRail = () => {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });

  return (
    <nav
      aria-label="Sections"
      className="flex w-12 shrink-0 flex-col items-center gap-1 border-r border-border bg-sidebar py-3"
    >
      <Link
        to="/sessions"
        aria-label="factory"
        className="mb-3 grid size-7 shrink-0 place-items-center bg-foreground text-background"
      >
        <FactoryMark className="size-7" />
      </Link>

      {SECTIONS.map(({ to, label, icon: Icon }) => {
        const active = pathname.startsWith(to);
        return (
          <Tooltip key={to}>
            <TooltipTrigger
              aria-current={active ? "page" : undefined}
              className={cn(
                "grid size-8 place-items-center text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                active && "bg-sidebar-accent text-sidebar-accent-foreground",
              )}
              render={
                <Link to={to} className="grid size-8 place-items-center" />
              }
            >
              <Icon className="size-4" strokeWidth={1.75} />
              <span className="sr-only">{label}</span>
            </TooltipTrigger>
            <TooltipContent side="right">{label}</TooltipContent>
          </Tooltip>
        );
      })}

      <div className="mt-auto">
        <ThemeToggle />
      </div>
    </nav>
  );
};
