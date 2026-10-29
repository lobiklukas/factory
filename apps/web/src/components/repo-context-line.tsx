import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { repoContextText } from "@repo/domain/RepoContext";
import type { SessionId } from "@repo/domain/Session";
import { sessionContextAtom } from "@/lib/atoms/session-atom";

/**
 * One line under the session header saying what the run was told about its repository (F19):
 * "told AGENTS.md (5823 bytes, 1522 tokens) and 8 repo skills", "no repo instructions" for a scratch
 * session and a repo with neither file, a truncated file called out. The words are the CLI's
 * (`repoContextText`), so `factory show` and this pane never disagree; the paths of the nested,
 * dropped and shadowed files are in its tooltip. Nothing is drawn until the read answers: a line that
 * flashed "no repo instructions" before the truth arrived would be a false report.
 */
export const RepoContextLine = ({
  sessionId,
}: {
  readonly sessionId: SessionId;
}) => {
  const context = useAtomValue(sessionContextAtom(sessionId));
  if (!AsyncResult.isSuccess(context)) return null;
  const repo = context.value.repo;
  const truncated = repo?.instructions?.truncated === true;
  const detail =
    repo === undefined
      ? undefined
      : [
          `read at ${repo.ref} (${repo.commit.slice(0, 12)})`,
          ...repo.skills.nested.map((path) => `nested: ${path}`),
          ...repo.skills.dropped.map((path) => `dropped: ${path}`),
          ...repo.skills.shadowed.map((path) => `shadowed: ${path}`),
        ].join("\n");
  return (
    <p
      data-session-context={repo === undefined ? "none" : "told"}
      data-session-context-truncated={truncated ? "" : undefined}
      title={detail}
      className="shrink-0 border-b border-border px-4 py-1 font-mono text-[10px] text-muted-foreground"
    >
      {repoContextText(repo)}
    </p>
  );
};
