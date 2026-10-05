import { createFileRoute, Outlet } from "@tanstack/react-router";
import { SessionSidebar } from "@/components/session-sidebar";

export const Route = createFileRoute("/sessions")({
  component: SessionsLayout,
});

/**
 * Every session route renders inside the same two-column frame: the list is
 * persistent, so switching sessions never costs a re-navigation of the list.
 */
function SessionsLayout() {
  return (
    <>
      <SessionSidebar />
      <Outlet />
    </>
  );
}
