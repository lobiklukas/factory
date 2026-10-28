import type {
  BoardInstanceId,
  CreateTaskInput,
  TaskPriority,
} from "@repo/domain/Task";
import { MAX_TASK_BODY_CHARS, MAX_TASK_REF_CHARS } from "@repo/domain/Task";
import { DASHBOARD_ACTOR } from "./approvals-view";

/**
 * The board page's "New card" form (LOB-275): what it holds, what it sends, and what it shows when
 * the server says no.
 *
 * The payload is the one `factory board add` (LOB-261) sends for the same inputs — `createTask`'s
 * own, each optional field present only when it says something — so the server's defaults (the
 * board's repository, LOB-255; no body; the repo's default base ref) are the same whichever door a
 * card came through, and two cards made with the same inputs read back the same. Pure on purpose, so
 * the cases a screenshot cannot settle (a title of spaces, a body over its cap, a refusal with no
 * words) are unit cases.
 */

/**
 * The search value that opens the form: `/boards/<id>?new=card`. A URL rather than a click's state,
 * so an empty state, a getting-started page or another tool can link straight to it (C9, planned),
 * and a reload keeps it open.
 */
export const NEW_CARD = "card";

/** What the form holds, as typed. */
export type CardForm = {
  readonly title: string;
  readonly body: string;
  readonly priority: TaskPriority;
  readonly baseRef: string;
};

export const EMPTY_CARD_FORM: CardForm = {
  title: "",
  body: "",
  priority: "normal",
  baseRef: "",
};

/** Which field a problem is about, so the form marks that one and no other. */
export type CardField = "title" | "body" | "baseRef";

export type CardProblem = {
  readonly field: CardField;
  readonly message: string;
};

/**
 * The `createTask` payload a form means, as the dashboard (a person, B5), or the problem that stops
 * it before any request.
 *
 * The title is trimmed and must say something: a card with no name cannot be told from another in
 * a lane. The body is sent as typed — its lines, indentation and trailing newline are what every run
 * on the card is quoted (LOB-260) — and left out when it is blank, which the server would store as
 * none anyway. The base ref is trimmed and left out when blank (the repository's default); whether
 * it names a ref a run can start from is the server's rule (`isSafeBranchName`), so a bad one is the
 * server's refusal in the server's words, not a second copy of the rule here. The two caps are
 * checked here because they are the payload schema's: over them, the client's own encode would fail
 * with a schema error instead of an answer the server gave. No repo is sent: the card is the board's.
 */
export const createCardInput = (
  boardId: BoardInstanceId,
  form: CardForm,
):
  | { readonly ok: true; readonly input: CreateTaskInput }
  | { readonly ok: false; readonly problem: CardProblem } => {
  const title = form.title.trim();
  if (title === "") {
    return {
      ok: false,
      problem: { field: "title", message: "A card needs a title." },
    };
  }
  if (form.body.length > MAX_TASK_BODY_CHARS) {
    return {
      ok: false,
      problem: {
        field: "body",
        message: `The body is ${form.body.length} characters; a card takes at most ${MAX_TASK_BODY_CHARS}. A longer spec belongs in a file in the repository.`,
      },
    };
  }
  const baseRef = form.baseRef.trim();
  if (baseRef.length > MAX_TASK_REF_CHARS) {
    return {
      ok: false,
      problem: {
        field: "baseRef",
        message: `A base ref takes at most ${MAX_TASK_REF_CHARS} characters.`,
      },
    };
  }
  return {
    ok: true,
    input: {
      boardId,
      title,
      priority: form.priority,
      ...(form.body.trim() === "" ? {} : { body: form.body }),
      ...(baseRef === "" ? {} : { baseRef }),
      actor: DASHBOARD_ACTOR,
    },
  };
};

/** A refused create: which refusal it was, and the server's message verbatim. */
export type CreateRefusal = {
  readonly tag: string;
  readonly message: string;
};

/**
 * What a failed `createTask` shows in its toast. A typed refusal (`InvalidTaskInput` naming a base
 * ref no run can start from, `BoardNotFound`, a storage error) is shown in the server's own words,
 * which name the field and say why; anything else (a dropped connection) falls back to the cause.
 */
export const createRefusal = (
  error: { readonly _tag: string; readonly message: string } | undefined,
  fallback: string,
): CreateRefusal =>
  error === undefined || error.message.length === 0
    ? { tag: error?._tag ?? "Unknown", message: fallback }
    : { tag: error._tag, message: error.message };
