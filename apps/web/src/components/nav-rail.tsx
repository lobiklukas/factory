import { Link, useRouterState } from "@tanstack/react-router";
import { useAtomValue } from "@effect/atom-react";
import { Option } from "effect";
import { AsyncResult } from "effect/reactivity";
import {
  BellIcon,
  BellRingIcon,
  BookOpenTextIcon,
  CoinsIcon,
  GitBranchIcon,
  KanbanSquareIcon,
  TerminalIcon,
  WebhookIcon,
} from "lucide-react";
import { cn } from "cn";
import { FactoryMark } from "@/components/factory-mark";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ThemeToggle } from "@/components/theme-toggle";
import { ALL_BOARDS, attentionAtom } from "@/lib/atoms/attention-atom";
import { attentionBadge } from "@/lib/attention-view";

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
  // question. Their routes stay: `/sandboxes` says what it used to, and `/approvals` is every run's
  // pending approvals (LOB-53), linked from a session parked on one rather than from the rail.
  { to: "/boards", label: "Boards", icon: KanbanSquareIcon },
  // What needs a person, across every board (LOB-77): the question the board exists to answer.
  { to: "/attention", label: "Needs a person", icon: BellIcon },
  { to: "/sessions", label: "Sessions", icon: TerminalIcon },
  // What the sessions cost, per repo and per actor (LOB-162): R4's attribution, across every run.
  { to: "/spend", label: "Spend", icon: CoinsIcon },
  // The repositories sessions are cut worktrees from, and the form that registers one (LOB-262).
  { to: "/repos", label: "Repositories", icon: GitBranchIcon },
  // What the trigger seam did with each delivery, and why it skipped the ones it did (T4).
  { to: "/triggers", label: "Triggers", icon: WebhookIcon },
  // The prompt text a column's runs are told, and the form that publishes a new version of it (D8).
  { to: "/skills", label: "Skills", icon: BookOpenTextIcon },
  // Which events the factory tells people about, and where it tells you: email and Web Push (F21).
  { to: "/notifications", label: "Notifications", icon: BellRingIcon },
] as const;

/**
 * What waits on a person, across every board (LOB-271): the length of the same `listAttention`
 * answer `/attention` renders from the same atom, so the badge is the page's own count and the rail
 * adds no second poll while that page is open. A failed poll keeps the last answer, as the page
 * does; before a first answer there is nothing to count.
 */
const useAttentionCount = (): number =>
  Option.match(AsyncResult.value(useAtomValue(attentionAtom(ALL_BOARDS))), {
    onNone: () => 0,
    onSome: (items) => items.length,
  });

export const NavRail = () => {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const waiting = attentionBadge(useAttentionCount());

  return (
    <nav
      aria-label="Sections"
      className="flex w-12 shrink-0 flex-col items-center gap-1 border-r border-border bg-sidebar py-3"
    >
      {/* The dashboard's front door (C9): `/` opens the only board, or the boards list. */}
      <Link
        to="/"
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
                "relative grid size-8 place-items-center text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                active && "bg-sidebar-accent text-sidebar-accent-foreground",
              )}
              render={
                <Link to={to} className="grid size-8 place-items-center" />
              }
            >
              <Icon className="size-4" strokeWidth={1.75} />
              <span className="sr-only">{label}</span>
              {to === "/attention" && waiting !== undefined ? (
                <span
                  data-attention-badge={waiting}
                  className="absolute top-0 right-0 grid min-w-3.5 place-items-center bg-destructive px-0.5 font-mono text-[9px] leading-3.5 text-white"
                >
                  <span className="sr-only"> </span>
                  {waiting}
                  <span className="sr-only"> waiting on a person</span>
                </span>
              ) : null}
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
