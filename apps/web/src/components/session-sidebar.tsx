import { useState } from "react";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { Cause } from "effect";
import { GitForkIcon, PlusIcon } from "lucide-react";
import { toast } from "sonner";
import { cn } from "cn";
import { sessionListAtom } from "@/lib/atoms/session-list";
import { startSessionAtom } from "@/lib/atoms/session-atom";
import { serverInfoAtom } from "@/lib/atoms/server-info-atom";
import {
  modelChoices,
  modelInput,
  SERVER_DEFAULT,
} from "@/lib/model-picker-view";
import { sessionModel } from "@/lib/server-info-view";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

const PROMPT = "Run echo faux-ok and tell me what it printed.";

/**
 * The session list, and the only navigation the transcript needs.
 *
 * Content is the control plane's own `listSessions` (LOB-6), newest activity
 * first — never anything this browser remembers (LOB-75 deleted the registry
 * that stood in for it), so a reload or a second browser shows the same list.
 * A list that failed to load says so instead of passing for an empty one.
 *
 * Below `md` the list and the pane take turns rather than sharing the width (LOB-210): a fixed
 * 16rem column beside the rail left a 390 px phone an 86 px pane, so the header's actions were cut
 * off and the composer wrapped one character per line. There the list is the whole of `/sessions`,
 * and a session's route shows only its pane, whose header links back here. From `md` up nothing
 * changes: the list stays beside the pane, so switching sessions never costs a navigation.
 */
export const SessionSidebar = () => {
  const result = useAtomValue(sessionListAtom);
  const sessions = AsyncResult.isSuccess(result) ? result.value.sessions : [];
  const failure = AsyncResult.isFailure(result) ? result.cause : null;
  // A next page means the count is a floor, and the footer says so rather than a total it does not know.
  const more =
    AsyncResult.isSuccess(result) && result.value.nextCursor !== undefined;
  const { sessionId } = useParams({ strict: false });
  const navigate = useNavigate();
  const start = useAtomSet(startSessionAtom, { mode: "promise" });
  // The model the next session is created on (LOB-274): the server's catalog, or its default. A
  // server that has not answered (or could not) leaves only the default, which still starts one.
  const info = useAtomValue(serverInfoAtom);
  const choices = modelChoices(
    AsyncResult.isSuccess(info) ? info.value : undefined,
  );
  const [model, setModel] = useState(SERVER_DEFAULT);
  return (
    <aside
      className={cn(
        "flex-col border-border bg-sidebar md:flex md:w-64 md:flex-none md:border-r",
        sessionId === undefined ? "flex min-w-0 flex-1" : "hidden",
      )}
    >
      <div className="flex flex-col gap-2 border-b border-border p-3">
        <label
          htmlFor="new-session-model"
          className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase"
        >
          Model
        </label>
        <select
          id="new-session-model"
          name="model"
          value={model}
          onChange={(event) => setModel(event.currentTarget.value)}
          className="h-8 w-full truncate rounded-none border border-input bg-transparent px-2 font-mono text-[11px] outline-none focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50 dark:bg-input/30"
        >
          {choices.map((choice) => (
            <option key={choice.value} value={choice.value}>
              {choice.label}
            </option>
          ))}
        </select>
        <Button
          className="w-full justify-start"
          variant="outline"
          onClick={() => {
            // Navigating on the created id rather than waiting for the list to
            // re-read: the pane attaches on the route, so the route is what has
            // to move. A refusal says so out loud instead of leaving the user on
            // the list with an error they cannot see: there is no session id to
            // navigate to, and silence is indistinguishable from a dead button.
            void start({ content: PROMPT, ...modelInput(model) }).then(
              (session) =>
                navigate({
                  to: "/sessions/$sessionId",
                  params: { sessionId: session.id },
                }),
              (cause: unknown) => {
                toast.error("No session was created", {
                  description:
                    cause instanceof Error ? cause.message : String(cause),
                });
              },
            );
          }}
        >
          <PlusIcon className="size-4" strokeWidth={1.75} />
          New session
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {AsyncResult.isInitial(result) ? (
          <div role="status" className="flex flex-col gap-2 px-2 py-3">
            <span className="sr-only">Loading sessions</span>
            <Skeleton className="h-3 w-3/4" aria-hidden />
            <Skeleton className="h-3 w-1/2" aria-hidden />
          </div>
        ) : failure !== null ? (
          <p
            role="alert"
            className="px-2 py-3 text-xs leading-relaxed break-words text-destructive"
          >
            The session list did not load: {Cause.pretty(failure)}
          </p>
        ) : sessions.length === 0 ? (
          <p className="px-2 py-3 text-xs leading-relaxed text-muted-foreground">
            No sessions on this control plane yet. Start one and it is listed
            here, for every browser.
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
                    {session.status === "busy" ? "busy" : "idle"}
                    <span className="truncate">{session.id}</span>
                  </span>
                  {/*
                   * The model the session is pinned to (LOB-272), so a scripted transcript is
                   * recognizable from the list. A row that names none prints no line.
                   */}
                  {sessionModel(session.model) === null ? null : (
                    <span
                      data-session-model
                      className="truncate font-mono text-[10px] text-muted-foreground"
                      title={session.model}
                    >
                      {session.model}
                    </span>
                  )}
                  {/*
                   * Lineage (LOB-182): the row keeps its two lines when a session has no parent,
                   * so the list does not jump for the one row that does. The parent's id is plain
                   * text rather than a link: the parent need not be on this page of the list, and
                   * a link to a row the reader cannot see would be a dead end.
                   */}
                  {session.forkedFrom === undefined ? null : (
                    <span className="flex min-w-0 items-center gap-1 font-mono text-[10px] text-muted-foreground">
                      <GitForkIcon
                        className="size-2.5 shrink-0"
                        strokeWidth={1.75}
                        aria-hidden
                      />
                      <span className="truncate" title={session.forkedFrom}>
                        forked from {session.forkedFrom}
                      </span>
                    </span>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="border-t border-border p-3 font-mono text-[10px] text-muted-foreground">
        {sessions.length}
        {more ? "+" : ""} on the server
      </div>
    </aside>
  );
};
