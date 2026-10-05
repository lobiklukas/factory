import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { PlusIcon } from "lucide-react";
import { cn } from "cn";
import { sessionRegistry } from "@/lib/atoms/session-registry";
import { startSessionAtom } from "@/lib/atoms/session-atom";
import { Button } from "@/components/ui/button";

const PROMPT = "Run echo faux-ok and tell me what it printed.";

/**
 * The session list, and the only navigation the transcript needs.
 *
 * Content comes from `sessionRegistry`, which is browser-local today: the
 * control plane has no list endpoint yet (docs/handoff.md task 8). The empty
 * state says exactly that rather than implying the account has no sessions,
 * because that is the difference between a user fixing a bug and a user filing
 * one.
 */
export const SessionSidebar = () => {
  const sessions = useAtomValue(sessionRegistry);
  const { sessionId } = useParams({ strict: false });
  const navigate = useNavigate();
  const start = useAtomSet(startSessionAtom, { mode: "promise" });
  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-border bg-sidebar">
      <div className="border-b border-border p-3">
        <Button
          className="w-full justify-start"
          variant="outline"
          onClick={() => {
            // Navigating on the created id rather than waiting for the registry
            // to update: the pane attaches on the route, so the route is what has
            // to move. A failure leaves the user on the list with the error in
            // the console, which is the honest outcome for a create that did not
            // happen — there is no session id to navigate to.
            void start({ content: PROMPT }).then((session) =>
              navigate({
                to: "/sessions/$sessionId",
                params: { sessionId: session.id },
              }),
            );
          }}
        >
          <PlusIcon className="size-4" strokeWidth={1.75} />
          New session
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {sessions.length === 0 ? (
          <p className="px-2 py-3 text-xs leading-relaxed text-muted-foreground">
            No sessions in this browser yet. The ones you open appear here and
            survive a reload; the server-side list arrives with task 8.
          </p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {sessions.map((session) => (
              <li key={session.id}>
                <Link
                  to="/sessions/$sessionId"
                  params={{ sessionId: session.id }}
                  className={cn(
                    "flex flex-col gap-1 px-2 py-2 transition-colors hover:bg-sidebar-accent",
                    session.id === sessionId &&
                      "bg-sidebar-accent text-sidebar-accent-foreground",
                  )}
                >
                  <span className="truncate text-xs font-medium">
                    {session.title}
                  </span>
                  <span className="flex items-center gap-2 font-mono text-[10px] text-muted-foreground">
                    <span
                      className={cn(
                        "size-1.5 shrink-0",
                        session.status === "busy"
                          ? "animate-pulse bg-ring"
                          : "bg-muted-foreground/40",
                      )}
                      aria-hidden
                    />
                    {session.status === "busy" ? "busy" : "idle"} ·{" "}
                    {session.mode}
                    <span className="truncate">{session.id}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="border-t border-border p-3 font-mono text-[10px] text-muted-foreground">
        {sessions.length} in this browser
      </div>
    </aside>
  );
};
