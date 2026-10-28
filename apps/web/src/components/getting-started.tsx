import { Link } from "@tanstack/react-router";
import { useAtomValue } from "@effect/atom-react";
import { Option } from "effect";
import { AsyncResult } from "effect/reactivity";
import { CircleCheckIcon, CircleIcon } from "lucide-react";
import { cn } from "cn";
import { firstRunAtom } from "@/lib/atoms/first-run-atom";
import {
  firstRunComplete,
  firstRunSteps,
  type FirstRunStep,
} from "@/lib/first-run-view";
import { NEW_BOARD } from "@/lib/board-create-view";
import { NEW_CARD } from "@/lib/card-create-view";
import { buttonVariants } from "@/components/ui/button";

/** One step's press: a link to the form it is, or the name of what it waits for. */
const StepAction = ({ step }: { readonly step: FirstRunStep }) => {
  const { action } = step;
  const link = buttonVariants({
    size: "sm",
    variant: step.done ? "ghost" : "outline",
  });
  switch (action.kind) {
    case "repos":
      return (
        <Link to="/repos" data-first-run-action={step.id} className={link}>
          {step.actionLabel}
        </Link>
      );
    case "new-board":
      return (
        <Link
          to="/boards"
          search={{ new: NEW_BOARD }}
          data-first-run-action={step.id}
          className={link}
        >
          {step.actionLabel}
        </Link>
      );
    case "new-card":
      return (
        <Link
          to="/boards/$boardId"
          params={{ boardId: action.boardId }}
          search={{ new: NEW_CARD }}
          data-first-run-action={step.id}
          className={link}
        >
          {step.actionLabel}
        </Link>
      );
    case "open-card":
      return (
        <Link
          to="/boards/$boardId"
          params={{ boardId: action.boardId }}
          search={{ card: action.taskId }}
          data-first-run-action={step.id}
          className={link}
        >
          {step.actionLabel}
        </Link>
      );
    case "blocked":
      return (
        <span
          data-first-run-blocked={step.id}
          className="text-[11px] text-muted-foreground"
        >
          Once {action.until}
        </span>
      );
  }
};

/**
 * The getting-started checklist (C9): register a repository, create a board, add a card, start a
 * run. Each step links to the form it is and ticks off as `listRepos`, `listBoards`, `listTasks` and
 * `listTaskRuns` answer with something, so the list is the control plane's own state, never a
 * browser's memory of what a person pressed (a reload, another browser and the CLI all agree).
 *
 * Shown while any step is unticked, and nothing once all four are: a control plane in use has no use
 * for it. Nothing is shown before a first read lands, or when a read fails, because a step ticked or
 * unticked on a guess is worse than no list; the page around it carries its own error.
 */
export const GettingStarted = ({
  className,
}: {
  readonly className?: string;
}) => {
  const result = useAtomValue(firstRunAtom);
  // A failed poll keeps the last answer, as the other views do; only a first read that fails
  // leaves the list out.
  const facts = Option.getOrUndefined(AsyncResult.value(result));
  if (facts === undefined || firstRunComplete(facts)) return null;
  const steps = firstRunSteps(facts);
  const next = steps.find((step) => !step.done);

  return (
    <section
      aria-label="Getting started"
      data-getting-started
      data-getting-started-done={steps.filter((step) => step.done).length}
      className={cn("flex flex-col gap-2 text-left", className)}
    >
      <h2 className="text-xs font-medium">Getting started</h2>
      <ol className="flex flex-col gap-1">
        {steps.map((step, index) => (
          <li
            key={step.id}
            data-step={step.id}
            data-done={step.done}
            data-next={step.id === next?.id}
            className={cn(
              "flex items-center gap-3 border border-border px-3 py-2",
              step.id === next?.id && "border-foreground/40",
            )}
          >
            {step.done ? (
              <CircleCheckIcon
                className="size-4 shrink-0 text-foreground"
                strokeWidth={1.75}
                aria-hidden
              />
            ) : (
              <CircleIcon
                className="size-4 shrink-0 text-muted-foreground"
                strokeWidth={1.75}
                aria-hidden
              />
            )}
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span
                className={cn(
                  "text-xs font-medium",
                  step.done && "text-muted-foreground line-through",
                )}
              >
                {index + 1}. {step.title}
                <span className="sr-only">{step.done ? " (done)" : ""}</span>
              </span>
              <span className="text-[11px] text-muted-foreground">
                {step.detail}
              </span>
            </span>
            <StepAction step={step} />
          </li>
        ))}
      </ol>
    </section>
  );
};
