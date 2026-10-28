import type { BoardCard } from "@repo/domain/Task";
import { prLink, type PrLink } from "./pr-link";
import { formatSpendDollars } from "./spend-view";

/**
 * What a card's face says about its runs (C10): whether one is working, where its PR is, and what
 * the runs cost — the three facts that let a board answer "what is live, what has a PR, what did it
 * cost" without opening each card.
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
};

export const cardFace = (card: BoardCard | undefined): CardFace => {
  if (card === undefined)
    return { status: null, pr: null, cost: null, runs: 0 };
  return {
    status: card.run?.status ?? null,
    pr: prLink(card.prUrl),
    cost: card.runCount === 0 ? null : formatSpendDollars(card.costTotal),
    runs: card.runCount,
  };
};

/** Whether the face has anything to say: a card with no run renders no row at all. */
export const faceIsBlank = (face: CardFace): boolean =>
  face.status === null && face.pr === null && face.cost === null;
