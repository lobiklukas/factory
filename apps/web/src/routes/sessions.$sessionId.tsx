import { createFileRoute } from "@tanstack/react-router";
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
      title="Not a session id this control plane mints"
      detail="Session ids are `ses_` plus Crockford base32 (docs/handoff.md, Session notes). A link with anything else cannot resolve."
      visible={parsed._tag === "None"}
    >
      {parsed._tag === "Some" ? <SessionPane sessionId={parsed.value} /> : null}
    </EmptyPane>
  );
}
