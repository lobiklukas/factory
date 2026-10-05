import { createRootRoute, Outlet } from "@tanstack/react-router";
import { TooltipProvider } from "@/components/ui/tooltip";
import { NavRail } from "@/components/nav-rail";

export const Route = createRootRoute({
  component: RootLayout,
});

/**
 * The frame every route sits in.
 *
 * The rail lives outside the session routes on purpose: it is the product's
 * frame, not a session's, and a pane that re-renders on every transcript event
 * should not drag the navigation down with it.
 */
function RootLayout() {
  return (
    <TooltipProvider>
      <div className="flex min-h-[100dvh] bg-background text-foreground">
        <NavRail />
        <div className="flex min-w-0 flex-1">
          <Outlet />
        </div>
      </div>
    </TooltipProvider>
  );
}
