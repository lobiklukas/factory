import { Link, useRouterState } from "@tanstack/react-router";
import { BoxesIcon, CheckSquareIcon, TerminalIcon } from "lucide-react";
import { cn } from "cn";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ThemeToggle } from "@/components/theme-toggle";

/**
 * The narrow rail. Vercel's dashboard pattern: sections are icons because there
 * are three of them, and a label per icon costs 48px of width for nothing. The
 * label moves into a tooltip on hover and into the pane's own header, so the name
 * is never lost.
 */
const SECTIONS = [
  { to: "/sessions", label: "Sessions", icon: TerminalIcon },
  { to: "/sandboxes", label: "Sandboxes", icon: BoxesIcon },
  { to: "/approvals", label: "Approvals", icon: CheckSquareIcon },
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
        className="mb-3 grid size-7 place-items-center bg-foreground text-[11px] font-semibold tracking-tight text-background"
      >
        f
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
