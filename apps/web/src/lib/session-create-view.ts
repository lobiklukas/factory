import type { CostPrediction } from "@repo/domain/Cost";
import type {
  CreateSessionInput,
  RepoSlug,
  RepoSummary,
} from "@repo/domain/Session";
import { DASHBOARD_ACTOR } from "./approvals-view";
import { capBlocked, predictedBudget } from "./cost-view";
import { modelInput, SERVER_DEFAULT } from "./model-picker-view";
import { runnability } from "./repos-view";

/**
 * The sidebar's "New session" form (E6): what it holds, what it sends, and what it shows when the
 * server says no.
 *
 * The form delegates the operator's own task. It replaced a button that sent one fixed sample prompt
 * on no repo, so every press made the same session and none of them could ever produce a pull
 * request. The payload is the one `factory run "<task>" --repo --base-ref --budget --model` sends for
 * the same inputs — `createSession`'s own, each optional field present only when it says something —
 * so the server's defaults (the repo registry's base ref, the deployment's model and cap) are the
 * same whichever door a session came through. Pure on purpose, so the cases a screenshot cannot
 * settle (a prompt of spaces, a budget of `0`, a base ref with no repo) are unit cases.
 */

/** The repo select's value for "no repo": a scratch session, which cuts no worktree. */
export const NO_REPO = "";

/** What the form holds, as typed. */
export type SessionForm = {
  readonly prompt: string;
  /** One of `listRepos`' slugs, or none: a scratch session. */
  readonly repo: RepoSlug | undefined;
  readonly baseRef: string;
  /** `SERVER_DEFAULT`, or a `provider/modelId` from `getServerInfo.models` (LOB-274). */
  readonly model: string;
  /** The spend cap in US dollars, as typed; blank is the server's default cap, or none. */
  readonly budget: string;
  /** Cap at the predicted range's high instead of a typed budget (LOB-38). */
  readonly capped: boolean;
  /** Open the session's pull request when its run settles with a change (F17); needs a repo. */
  readonly openPr: boolean;
};

export const EMPTY_SESSION_FORM: SessionForm = {
  prompt: "",
  repo: undefined,
  baseRef: "",
  model: SERVER_DEFAULT,
  budget: "",
  capped: false,
  openPr: false,
};

/**
 * The form after one field is changed. Ticking "Cap at predicted high" agrees to one range's high,
 * and the prediction is keyed on the model and the repo as well as the prompt (`predictionKey`): a
 * change of either is another range, so it unticks the cap rather than moving it to a number the
 * person never saw. A prompt edit keeps it — the box shows the new high as it settles, and a prompt
 * is refined while the cap is meant to follow it.
 */
export const editSessionForm = <K extends keyof SessionForm>(
  form: SessionForm,
  field: K,
  value: SessionForm[K],
): SessionForm => {
  const next = { ...form, [field]: value };
  const rescoped =
    (field === "model" || field === "repo") && form[field] !== value;
  return rescoped ? { ...next, capped: false } : next;
};

/** Which field a problem is about, so the form marks that one and no other. */
export type SessionField = "prompt" | "budget" | "cap";

export type SessionProblem = {
  readonly field: SessionField;
  readonly message: string;
};

/** What a submit sends: `createSession`'s payload, then the first message. */
export type SessionStart = {
  readonly create: CreateSessionInput;
  readonly content: string;
};

/**
 * The `createSession` payload and first message a form means, as the dashboard (a person, B5), or
 * the problem that stops it before any request.
 *
 * The prompt must say something, and is otherwise sent exactly as typed: it is the session's first
 * user entry, and its lines and indentation are the operator's. No title is sent — the control plane
 * names a session from its first message. The repo is the select's slug, or nothing for a scratch
 * session; the base ref is trimmed and sent only with a repo (without one there is no worktree for
 * it to be the start of), and left out when blank so the registry's default applies. Whether the ref
 * exists in the checkout is the server's to say, in its words, when it cuts the worktree. The budget
 * is either the predicted high (the cap box, which then must have a range to cap at) or the typed
 * amount, which must be a positive number of dollars as `SessionBudgetCap` is; blank sends none.
 * "Open a PR when done" sends `openPrOnSettle` (F17), as `factory run --open-pr` does, and only with a
 * repo: ticked and then the repo cleared, it sends nothing for it.
 */
export const newSessionInput = (
  form: SessionForm,
  prediction: CostPrediction | undefined,
):
  | { readonly ok: true; readonly start: SessionStart }
  | { readonly ok: false; readonly problem: SessionProblem } => {
  if (form.prompt.trim() === "") {
    return {
      ok: false,
      problem: {
        field: "prompt",
        message: "A session needs a prompt: the task it is delegated.",
      },
    };
  }
  const budget = budgetInput(form, prediction);
  if (!budget.ok) return budget;
  const baseRef = form.baseRef.trim();
  const repo = form.repo;
  return {
    ok: true,
    start: {
      create: {
        actor: DASHBOARD_ACTOR,
        ...(repo === undefined ? {} : { repo }),
        ...(repo === undefined || baseRef === "" ? {} : { baseRef }),
        ...modelInput(form.model),
        ...budget.budget,
        // Only with a repo: a scratch session has no PR to open, and the server refuses the ask.
        ...(repo !== undefined && form.openPr ? { openPrOnSettle: true } : {}),
      },
      content: form.prompt,
    },
  };
};

const budgetInput = (
  form: SessionForm,
  prediction: CostPrediction | undefined,
):
  | { readonly ok: true; readonly budget: { readonly budget?: number } }
  | { readonly ok: false; readonly problem: SessionProblem } => {
  if (form.capped) {
    // Asked to cap with no range to cap at: wait rather than create the uncapped session nobody
    // asked for.
    return capBlocked(prediction, true)
      ? {
          ok: false,
          problem: {
            field: "cap",
            message:
              "No predicted high to cap at yet: untick the cap to start uncapped, or type a budget.",
          },
        }
      : { ok: true, budget: predictedBudget(prediction, true) };
  }
  const typed = form.budget.trim();
  if (typed === "") return { ok: true, budget: {} };
  const amount = Number(typed);
  if (!Number.isFinite(amount) || amount <= 0) {
    return {
      ok: false,
      problem: {
        field: "budget",
        message: `A budget is a positive amount of US dollars, like 2.50; "${typed}" is not one.`,
      },
    };
  }
  return { ok: true, budget: { budget: amount } };
};

/**
 * One option of the repo select: the slug, and — for a repo that cannot cut a worktree (no checkout,
 * or one that is not a git work tree, LOB-263) — that it cannot, so the operator knows before
 * submitting that the session will produce no diff. It is still offered: the server opens a session
 * on it, and says why it has no worktree.
 */
export type RepoChoice = {
  /** What the `<option>` carries: `NO_REPO`, or the slug. */
  readonly value: string;
  readonly repo: RepoSlug | undefined;
  readonly label: string;
  /** The ref a blank base ref means for this repo: the registry's default. */
  readonly defaultBaseRef?: string;
};

export const repoChoices = (
  repos: readonly RepoSummary[] | undefined,
): readonly RepoChoice[] => [
  { value: NO_REPO, repo: undefined, label: "No repo (scratch session)" },
  ...(repos ?? []).map((repo) => ({
    value: repo.repo,
    repo: repo.repo,
    label: runnability(repo).runnable
      ? repo.repo
      : `${repo.repo} (no worktree: not runnable)`,
    defaultBaseRef: repo.defaultBaseRef,
  })),
];

/**
 * What a failed start shows inline under the form. A typed refusal (`SessionError` naming a base ref
 * the checkout does not have, a model the server does not serve, `at_capacity`) is shown in the
 * server's own words; anything else (a dropped connection) falls back to the cause.
 */
export const startRefusal = (
  error: { readonly message: string } | undefined,
  fallback: string,
): string =>
  error === undefined || error.message.length === 0 ? fallback : error.message;
