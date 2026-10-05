import { createFileRoute } from "@tanstack/react-router";
import { BoxesIcon } from "lucide-react";
import { EmptyPane } from "@/components/empty-pane";

export const Route = createFileRoute("/sandboxes")({
  component: SandboxesRoute,
});

/**
 * Deliberately empty.
 *
 * `packages/sandbox` does not exist yet (docs/design.md M4, and the component
 * inventory in docs/handoff.md). There is no sandbox RPC group to read, so a
 * table here would be fiction. The route exists because the nav needs a stable
 * target and the milestone needs a name, and it will gain its real read when the
 * CRD work lands.
 */
function SandboxesRoute() {
  return (
    <EmptyPane
      icon={<BoxesIcon strokeWidth={1.75} />}
      title="No sandboxes yet"
      detail="Sandbox lifecycle is M4. Until it lands a session's environment is the control plane itself, so there is nothing separate to list."
      visible
    />
  );
}
