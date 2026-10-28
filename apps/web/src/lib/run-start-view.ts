import type { CreateSessionInput } from "@repo/domain/Session";
import type { BoardDefinition, Task } from "@repo/domain/Task";
import { runPrompt } from "@repo/domain/Task";
import { DASHBOARD_ACTOR } from "./approvals-view";

/**
 * The card pane's Start run, as a prompt then a send (C6): what the prompt field holds when it
 * opens, whether it can be sent, and the session the send opens.
 *
 * A run started with no words sits idle, so Start run does not start one: it opens a field holding
 * the card's own default prompt — its title, its body and the column's instruction, `runPrompt`,
 * the function `factory board start` sends when it is given no `--prompt` — and Send opens the run
 * and sends the field's text as its first message. Pure, so the cases a drive does not reach cheaply
 * (a card with no body, a column the definition lost, a field emptied) are unit cases.
 */

/**
 * The prompt the field opens with: `runPrompt` of the card and the column it is in, the one the run
 * starts from (`runStart`). `definition` is the card's own pinned version (B2); a column it does not
 * name leaves the instruction out, as it does for the CLI.
 */
export const startPrompt = (task: Task, definition: BoardDefinition): string =>
  runPrompt(
    task,
    definition.columns.find((column) => column.name === task.column),
  );

/**
 * Whether the field can be sent. The session refuses an empty message, and a run opened and then
 * refused its first message is exactly the idle run this exists to prevent, so the field says so
 * before anything is opened. The text is never trimmed: it is sent as typed.
 */
export type StartSendable =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

export const startSendable = (draft: string): StartSendable =>
  draft.trim() === ""
    ? { ok: false, reason: "A run needs a first message" }
    : { ok: true };

/**
 * The budget field's text as the payload carries it (C23): blank is no budget of this run's own
 * (the server's default cap applies, or none), and anything else must be a positive amount of US
 * dollars — the schema `createSession` and `setSessionBudget` hold it to — so a value the server
 * would refuse is refused here, before a run is opened and left unsent.
 */
export type StartBudget =
  | { readonly ok: true; readonly budget: number | undefined }
  | { readonly ok: false; readonly reason: string };

export const startBudget = (typed: string): StartBudget => {
  const text = typed.trim();
  if (text === "") return { ok: true, budget: undefined };
  const amount = Number(text);
  return Number.isFinite(amount) && amount > 0
    ? { ok: true, budget: amount }
    : {
        ok: false,
        reason: `A budget is a positive amount of US dollars, like 2.50; "${text}" is not one`,
      };
};

/**
 * The `createSession` input for a run on `task`: the one `factory board start` sends for the same
 * card — the card named, the column it sits in, the repository it is bound to — with the
 * dashboard's actor, so the run's spend is the dashboard's (LOB-162).
 */
export const startRunSession = (
  task: Task,
  budget?: number,
): CreateSessionInput => ({
  title: task.title,
  taskId: task.id,
  taskColumn: task.column,
  actor: DASHBOARD_ACTOR,
  ...(task.repo === undefined ? {} : { repo: task.repo }),
  // C23: the run's spend ceiling, as `factory board start --budget` sends it. Absent when none was
  // typed, so the server's default cap, if it has one, applies.
  ...(budget === undefined ? {} : { budget }),
});
