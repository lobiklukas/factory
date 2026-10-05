import { createFileRoute } from "@tanstack/react-router";
import { TerminalIcon } from "lucide-react";
import { Schema } from "effect";
import { SessionId } from "@repo/domain/Session";
import { SessionPane } from "@/components/session-pane";
import { EmptyPane } from "@/components/empty-pane";

export const Route = createFileRoute("/sessions/$sessionId")({
  component: SessionRoute,
});

function SessionRoute() {
  const { sessionId } = Route.useParams();
  // Decoded, not cast: the id is a brand, and a link carrying anything else
  // should say so here rather than reach the RPC surface as a `not_found` the
  // user cannot act on.
  const parsed = Schema.decodeUnknownOption(SessionId)(sessionId);

  return (
    <EmptyPane
      icon={<TerminalIcon strokeWidth={1.75} />}
      title="Not a session id this control plane mints"
      detail="A session id is ses_ followed by Crockford base32. A link carrying anything else cannot resolve, so it is refused here instead of reaching the API as a not-found you cannot act on."
      visible={parsed._tag === "None"}
    >
      {parsed._tag === "Some" ? <SessionPane sessionId={parsed.value} /> : null}
    </EmptyPane>
  );
}
