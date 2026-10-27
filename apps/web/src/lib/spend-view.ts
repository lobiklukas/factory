import type { SpendReport, SpendRow } from "@repo/domain/Session";

/**
 * The spend pane's wording and roll-ups (LOB-162, part 2 of LOB-17).
 *
 * The rows are `listSpend`, the server's answer, one per (repo, actor) pair, and they are the only
 * numbers here: a roll-up by repo or by actor alone is those pairs added, so the three lists on the
 * page can never disagree with each other or with the server.
 */

/** What a session bound to no repo is listed as: the scratch session a bare `factory run` makes. */
export const SCRATCH_LABEL = "scratch";

/**
 * What a session nobody was attributed to is listed as: every session created before LOB-162, and a
 * caller that named no actor. Named, not guessed, so the pane never moves spend onto someone.
 */
export const UNATTRIBUTED_LABEL = "unattributed";

export const repoLabel = (repo: string | undefined): string =>
  repo ?? SCRATCH_LABEL;

export const actorLabel = (actor: string | undefined): string =>
  actor ?? UNATTRIBUTED_LABEL;

/** One line of a roll-up: the key it groups by (absent for scratch / unattributed) and its sums. */
export type SpendLine = {
  readonly key: string | undefined;
  readonly label: string;
  readonly sessions: number;
  readonly costTotal: number;
};

/**
 * Costliest first, then by name, with the absent key last — the order the server gives its pairs,
 * so a roll-up reads the way the breakdown under it does.
 */
const byCost = (left: SpendLine, right: SpendLine): number => {
  if (left.costTotal !== right.costTotal)
    return right.costTotal - left.costTotal;
  if (left.key === undefined) return right.key === undefined ? 0 : 1;
  if (right.key === undefined) return -1;
  return left.key < right.key ? -1 : left.key > right.key ? 1 : 0;
};

const rollUp = (
  rows: ReadonlyArray<SpendRow>,
  keyOf: (row: SpendRow) => string | undefined,
  labelOf: (key: string | undefined) => string,
): ReadonlyArray<SpendLine> => {
  const lines = new Map<string | undefined, SpendLine>();
  for (const row of rows) {
    const key = keyOf(row);
    const line = lines.get(key);
    lines.set(key, {
      key,
      label: labelOf(key),
      sessions: (line?.sessions ?? 0) + row.sessions,
      costTotal: (line?.costTotal ?? 0) + row.costTotal,
    });
  }
  return [...lines.values()].sort(byCost);
};

/** Spend per repo, every actor's sessions on it added. */
export const spendByRepo = (report: SpendReport): ReadonlyArray<SpendLine> =>
  rollUp(report.rows, (row) => row.repo, repoLabel);

/** Spend per actor, across every repo they started sessions on. */
export const spendByActor = (report: SpendReport): ReadonlyArray<SpendLine> =>
  rollUp(report.rows, (row) => row.actor, actorLabel);

/**
 * A dollar amount as the pane prints it: `$0.0300`, four decimals, as `factory run` prints a budget,
 * so a sum of small faux-priced runs reads exactly and a cent is never rounded away.
 *
 * Zero is not printed as `$0.0000`: a provider that reports no cost (pi-ai's faux) is not a free run
 * (LOB-222's rule), so a line that spent nothing measurable says so in words.
 */
export const formatSpendDollars = (amount: number): string => {
  if (amount === 0) return "no cost reported";
  // A spend too small for four places is still a spend: `$0.0000` would read as none.
  if (amount < 0.0001) return "<$0.0001";
  return `$${amount.toFixed(4)}`;
};

export const sessionCount = (sessions: number): string =>
  `${sessions} ${sessions === 1 ? "session" : "sessions"}`;

/**
 * A stable key for one pair, built from the values rather than the labels: an actor may be named
 * `unattributed`, and it is still not the absent one. An empty string stands for absent because
 * neither a repo slug nor an actor can be empty.
 */
export const pairKey = (row: SpendRow): string =>
  `${row.repo ?? ""}\u0000${row.actor ?? ""}`;
