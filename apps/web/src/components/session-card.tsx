import { useAtom } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { sessionAtom } from "@/lib/atoms/session-atom";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const PROMPT = "Run echo faux-ok and tell me what it printed.";

/**
 * The dashboard's first real feature: a session, driven and watched through the RPC surface.
 *
 * `mode` is shown on purpose (docs/design.md D8): a transcript folded from the log must never look
 * like a live one.
 */
export const SessionCard = () => {
  const [result, start] = useAtom(sessionAtom);
  const view = AsyncResult.getOrElse(result, () => null);

  return (
    <div className="flex h-full flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Session</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Button className="w-full" onClick={() => start({ content: PROMPT })}>
            Start a session
          </Button>
          {view ? (
            <p className="text-muted-foreground text-xs">
              {view.mode === "live" ? "live" : "historical fold"} ·{" "}
              {view.status}
            </p>
          ) : null}
        </CardContent>
      </Card>

      <div className="flex-1 overflow-auto rounded-lg border border-border bg-muted/50 p-4">
        {view && view.lines.length > 0 ? (
          <pre className="text-sm">
            <code>{view.lines.join("\n")}</code>
          </pre>
        ) : (
          <p className="text-muted-foreground text-sm">
            Click the button above to create a session and watch it run
          </p>
        )}
      </div>
    </div>
  );
};
