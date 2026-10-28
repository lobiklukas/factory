import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import type { ColumnConfig } from "@repo/domain/Task";
import { cn } from "cn";
import {
  gateSource,
  modelSource,
  NONE,
  pushScopeLabel,
  requirementState,
  wipLabel,
  writeScopeLabel,
} from "@/lib/board-settings-view";
import { Badge } from "@/components/ui/badge";

/** One labelled fact of a column: the label in a fixed column, so a list of them reads as a table. */
const Fact = ({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) => (
  <div className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-2">
    <dt className="text-muted-foreground">{label}</dt>
    <dd className="min-w-0">{children}</dd>
  </div>
);

/**
 * What one column of a definition version does (LOB-245), as `getDefinition` describes it: its kind, its
 * role and the model a run started in it talks to, its skills, its exit requirements each marked
 * "checked" or "not yet checked", and its moves out, a move across a human gate named by the gate.
 *
 * The settings page renders one per column and a lane header's disclosure renders its own, so both
 * say the same thing in the same words. Every value is the server's: nothing here infers a gate, a
 * model or a requirement's status. Each value carries a `data-*` hook so `verify-web` reads what is on
 * screen back and compares it with `getDefinition`'s answer (`board-settings.mjs`).
 *
 * Each skill name links to its page (D8), where its body, history and Edit form are.
 *
 * Its autonomy (C22) is the effective one — the deployment's gates and scopes narrowed by the column,
 * its role and its skills — so a gate reads with whose it is, and a specifier column reads read-only
 * whether or not its definition says so. A server that does not describe autonomy shows none of it.
 */
export const ColumnSettings = ({
  column,
  className,
}: {
  readonly column: ColumnConfig;
  readonly className?: string;
}) => {
  const wip = wipLabel(column.wipLimit);
  return (
    <dl
      data-column-settings={column.name}
      className={cn("flex flex-col gap-1.5 text-[11px]", className)}
    >
      <Fact label="Kind">
        <span data-column-kind className="font-mono">
          {column.kind}
        </span>
      </Fact>
      <Fact label="Role">
        <span data-column-role className="font-mono">
          {column.role ?? NONE}
        </span>
      </Fact>
      <Fact label="Model">
        <span className="flex flex-wrap items-baseline gap-x-1.5">
          <span
            data-column-model
            data-column-model-source={column.model.source}
            className="font-mono break-all"
          >
            {column.model.model}
          </span>
          <span className="text-muted-foreground">
            {modelSource(column.model)}
          </span>
        </span>
      </Fact>
      <Fact label="Skills">
        {column.skills.length === 0 ? (
          <span data-column-skills-none>{NONE}</span>
        ) : (
          <ul className="flex flex-wrap gap-1">
            {column.skills.map((skill) => (
              <li key={skill}>
                <Badge
                  variant="outline"
                  className="font-mono text-[10px]"
                  render={
                    <Link
                      to="/skills/$name"
                      params={{ name: skill }}
                      data-column-skill
                      data-column-skill-link={skill}
                    />
                  }
                >
                  {skill}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </Fact>
      <Fact label="Requires">
        {column.requires.length === 0 ? (
          <span data-column-requires-none>{NONE}</span>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {column.requires.map((requirement) => {
              const state = requirementState(requirement);
              return (
                <li
                  key={requirement.key}
                  data-requirement={requirement.key}
                  data-requirement-checked={String(requirement.checked)}
                  className="flex flex-col gap-0.5"
                >
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span data-requirement-key className="font-mono">
                      {requirement.key}
                    </span>
                    <Badge
                      variant={requirement.checked ? "secondary" : "outline"}
                      data-requirement-state
                      className={cn(
                        "text-[10px]",
                        !requirement.checked && "text-muted-foreground",
                      )}
                    >
                      {state}
                    </Badge>
                  </span>
                  <span
                    data-requirement-description
                    className="text-muted-foreground"
                  >
                    {requirement.description}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </Fact>
      <Fact label="Moves to">
        {column.exits.length === 0 ? (
          <span data-column-exits-none>{NONE}</span>
        ) : (
          <ul className="flex flex-col gap-1">
            {column.exits.map((exit) => (
              <li
                key={exit.to}
                data-exit={exit.to}
                className="flex flex-wrap items-center gap-1.5"
              >
                <span className="font-mono">
                  → <span data-exit-to>{exit.to}</span>
                </span>
                {exit.humanGate === undefined ? null : (
                  <Badge variant="outline" className="text-[10px]">
                    human gate:{" "}
                    <span data-exit-gate className="font-medium">
                      {exit.humanGate}
                    </span>
                  </Badge>
                )}
              </li>
            ))}
          </ul>
        )}
      </Fact>
      {wip === null ? null : (
        <Fact label="WIP limit">
          <span data-column-wip={column.wipLimit}>{wip}</span>
        </Fact>
      )}
      {column.autonomy === undefined ? null : (
        <>
          <Fact label="Asks first">
            {column.autonomy.approvalRequired.length === 0 ? (
              <span data-column-gates-none>{NONE}</span>
            ) : (
              <ul className="flex flex-col gap-1">
                {column.autonomy.approvalRequired.map((gate) => (
                  <li
                    key={gate.command}
                    data-gate={gate.command}
                    data-gate-source={gate.source}
                    className="flex flex-wrap items-center gap-1.5"
                  >
                    <span data-gate-command className="font-mono">
                      {gate.command}
                    </span>
                    <span className="text-muted-foreground">
                      {gateSource(gate)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Fact>
          <Fact label="Writes">
            <span data-column-write={column.autonomy.write}>
              {writeScopeLabel(column.autonomy.write)}
            </span>
          </Fact>
          <Fact label="Pushes">
            <span data-column-push={column.autonomy.push}>
              {pushScopeLabel(column.autonomy.push)}
            </span>
          </Fact>
        </>
      )}
    </dl>
  );
};
