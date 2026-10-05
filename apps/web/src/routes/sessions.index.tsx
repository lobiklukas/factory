import { createFileRoute } from "@tanstack/react-router";
import { TerminalIcon } from "lucide-react";
import { EmptyPane } from "@/components/empty-pane";

export const Route = createFileRoute("/sessions/")({
  component: () => (
    <EmptyPane
      icon={<TerminalIcon strokeWidth={1.75} />}
      title="Pick a session"
      detail="Or start one: it creates a session, sends the first message, and follows the stream. Everything the agent does lands in the transcript below the header."
      visible
    />
  ),
});
