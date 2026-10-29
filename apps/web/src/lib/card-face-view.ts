import type { RepoSummary } from "@repo/domain/Session";
import type { BoardCard } from "@repo/domain/Task";
import { prLink, type PrLink } from "./pr-link";
import { readinessView } from "./repos-view";
import { formatSpendDollars } from "./spend-view";

/**
 * What a card's face says about its runs (C10): whether one is working, where its PR is, and what
 * the runs cost — the three facts that let a board answer "what is live, what has a PR, what did it
 * cost" without opening each card.
 *
 * And, from the board's repository, how ready it is for an agent (F25): the score the Repositories
 * page shows, read once per board (`getRepo`) and worded the same by `readinessView`, so a card does
 * not ask for it and a board of nine cards costs the repo reads a board of three does.
 *
 * Every value is the server's (`listBoardCards`, one read per board); this module only words them,
 * so the cases a screenshot cannot settle — a card with no run, a PR URL that is not a web link, a
 * run that cost nothing measurable — are unit cases, and the PR link is the session pane's own
 * (`prLink`), so both say the same thing about the same URL.
 */
export type CardFace = {
  /** The newest run's state, or `null` for a card no run was started against. */
  readonly status: "busy" | "idle" | null;
  /** The PR the card's runs opened, or `null` when none did or its URL is not a web link. */
  readonly pr: PrLink | null;
  /** The runs' summed spend, worded as `/spend` words it; `null` when the card has had no run. */
  readonly cost: string | null;
  readonly runs: number;
  /**
   * The board's repository's readiness (F25): the score, whether every check passed, and the title
   * that names the ones that did not; `null` when the repo has no checkout to score, or the read
   * has not (or did not) answer, which is never worded as a zero.
   */
  readonly readiness: CardReadiness | null;
};

export type CardReadiness = {
  readonly score: string;
  readonly ready: boolean;
  readonly title: string;
};

/** The readiness chip a card shows for its board's repository, or `null` when there is no score. */
export const cardReadiness = (
  repo: RepoSummary | undefined,
): CardReadiness | null => {
  const view = repo === undefined ? null : readinessView(repo);
  if (view === null) return null;
  return {
    score: view.score,
    ready: view.ready,
    title: view.ready
      ? `Agent-readiness ${view.score}: every check passes`
      : `Agent-readiness ${view.score}. Missing: ${view.missing.join("; ")}`,
  };
};

export const cardFace = (
  card: BoardCard | undefined,
  repo?: RepoSummary,
): CardFace => {
  const readiness = cardReadiness(repo);
  if (card === undefined)
    return { status: null, pr: null, cost: null, runs: 0, readiness };
  return {
    status: card.run?.status ?? null,
    pr: prLink(card.prUrl),
    cost: card.runCount === 0 ? null : formatSpendDollars(card.costTotal),
    runs: card.runCount,
    readiness,
  };
};

/**
 * Whether the run row has anything to say: a card with no run renders no row at all. The readiness
 * is the board's repository's, not the card's runs', so it sits with the card's id and does not
 * make this row appear.
 */
export const faceIsBlank = (face: CardFace): boolean =>
  face.status === null && face.pr === null && face.cost === null;
