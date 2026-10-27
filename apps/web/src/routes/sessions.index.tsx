import { createFileRoute } from "@tanstack/react-router";
import { TerminalIcon } from "lucide-react";
import { EmptyPane } from "@/components/empty-pane";

export const Route = createFileRoute("/sessions/")({
  // Below `md` the session list is this route's whole width (LOB-210), so the empty pane beside it
  // would only squeeze it: it says "pick a session" next to the list it points at, which there is
  // no room for.
  component: () => (
    <div className="hidden min-h-0 min-w-0 flex-1 md:flex">
      <EmptyPane
        icon={<TerminalIcon strokeWidth={1.75} />}
        title="Pick a session"
        detail="Or start one: it creates a session, sends the first message, and follows the stream. Everything the agent does lands in the transcript below the header."
        visible
      />
    </div>
  ),
});
