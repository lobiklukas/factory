import { createRootRoute, Outlet } from "@tanstack/react-router";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
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
 *
 * The toaster is here rather than in a route because a refused move is the one
 * message that must survive the surface that raised it.
 *
 * The frame is `h-dvh`, not `min-h-dvh`: every pane below it scrolls inside
 * itself (the transcript, the session list), and a minimum height lets the page
 * grow to its tallest child instead, which pushes the composer off the viewport.
 */
function RootLayout() {
  return (
    <TooltipProvider>
      <div className="flex h-dvh overflow-hidden bg-background text-foreground">
        <NavRail />
        <div className="flex min-w-0 flex-1">
          <Outlet />
        </div>
      </div>
      <Toaster position="bottom-right" />
    </TooltipProvider>
  );
}
