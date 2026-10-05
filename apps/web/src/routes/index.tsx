import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  // The dashboard opens on sessions: it is the only section with a real read
  // behind it today (docs/handoff.md M2), and a redirect beats an empty first
  // impression.
  beforeLoad: () => {
    throw redirect({ to: "/sessions" });
  },
});
