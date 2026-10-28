import { createFileRoute, Link } from "@tanstack/react-router";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { Cause } from "effect";
import { BookOpenTextIcon } from "lucide-react";
import { skillsAtom } from "@/lib/atoms/skills-atom";
import { oneLine, versionLabel } from "@/lib/skills-view";
import { EmptyPane } from "@/components/empty-pane";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";

export const Route = createFileRoute("/skills/")({
  component: SkillsRoute,
});

/**
 * The factory's skills (D8): every skill at its newest version, with the columns of the default
 * definition's newest version that bind it — the prompt text a column's runs are told (docs/board.md
 * B6). Each row opens the skill's page, where its body, history and Edit form are.
 *
 * `listSkills` and nothing else, so a skill put from a terminal is here on the next load.
 */
function SkillsRoute() {
  const result = useAtomValue(skillsAtom);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-border px-4 py-3">
        <h1 className="text-sm font-medium">Skills</h1>
        <span className="text-[11px] text-muted-foreground">
          the prompt text a column&apos;s runs are told
        </span>
      </header>
      {AsyncResult.isInitial(result) ? (
        <div role="status" className="flex flex-col gap-3 p-6">
          <span className="sr-only">Loading skills</span>
          {[0, 1, 2].map((row) => (
            <Skeleton key={row} className="h-12 w-full max-w-3xl" aria-hidden />
          ))}
        </div>
      ) : AsyncResult.isFailure(result) ? (
        <EmptyPane
          icon={<BookOpenTextIcon strokeWidth={1.75} />}
          title="The skills did not load"
          detail={Cause.pretty(result.cause)}
          visible
        />
      ) : result.value.length === 0 ? (
        <EmptyPane
          icon={<BookOpenTextIcon strokeWidth={1.75} />}
          title="No skills yet"
          detail="This control plane holds no skill. The shipped ones are seeded when its database is migrated, so an empty list means the migrations have not run against it."
          visible
        />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <p className="mb-3 max-w-3xl text-[11px] text-muted-foreground">
            Columns are the default definition&apos;s newest version&apos;s. An
            edit is a new version: the next run in a column that binds the skill
            is told it, and a run already open keeps the version it opened with.
          </p>
          <ul aria-label="Skills" className="flex max-w-3xl flex-col gap-2">
            {result.value.map((skill) => (
              <li
                key={skill.name}
                data-skill-row={skill.name}
                data-skill-version={skill.version}
                className="border border-border bg-card"
              >
                <Link
                  to="/skills/$name"
                  params={{ name: skill.name }}
                  className="flex min-w-0 flex-col gap-1 px-3 py-2.5 hover:bg-muted/40"
                >
                  <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <span className="font-mono text-xs font-medium">
                      {skill.name}
                    </span>
                    <span className="font-mono text-[10px] text-muted-foreground">
                      {versionLabel(skill.version)}
                    </span>
                    <span
                      data-skill-columns={skill.columns.join(",")}
                      className="ml-auto flex flex-wrap gap-1"
                    >
                      {skill.columns.length === 0 ? (
                        <span className="text-[11px] text-muted-foreground">
                          no column of the default definition
                        </span>
                      ) : (
                        skill.columns.map((column) => (
                          <Badge
                            key={column}
                            variant="outline"
                            className="font-mono text-[10px]"
                          >
                            {column}
                          </Badge>
                        ))
                      )}
                    </span>
                  </span>
                  <span className="text-[11px] text-muted-foreground">
                    {oneLine(skill.description)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
