/**
 * The session pane's PR link (LOB-65): what the header's anchor points at and what it says.
 *
 * The link is `SessionSummary.prUrl` — the URL the PR step recorded in the session's log and wrote
 * to its index row (LOB-62), carried to the pane by `getSession`, the stream's snapshot, and a
 * `prOpened` event. The anchor's `href` is that string verbatim: the drive compares the two, and a
 * normalized URL would be a link the session never recorded.
 *
 * Pure on purpose. `.pi/skills/verify-web` proves the anchor in a browser against a seeded session;
 * the cases here are the ones a screenshot cannot settle — which values are not a link at all.
 */
export type PrLink = {
  /** The recorded URL, unchanged. */
  readonly href: string;
  /** What the anchor reads: the PR's number when the URL names one. */
  readonly label: string;
};

/** GitHub spells a pull request's page `/<owner>/<repo>/pull/<number>`. */
const PULL_NUMBER = /\/pull\/(\d+)\/?$/;

/**
 * The link for a recorded PR URL, or `null` when there is nothing to link.
 *
 * Only `http:` and `https:` become an anchor. The URL arrives from the control plane, which took it
 * from the forge's answer; rendering a `javascript:` or `data:` value as an `href` would let that
 * answer run script in the dashboard's origin, so anything else renders no link.
 */
export const prLink = (prUrl: string | undefined): PrLink | null => {
  if (prUrl === undefined || prUrl === "") return null;
  let parsed: URL;
  try {
    parsed = new URL(prUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  const number = PULL_NUMBER.exec(parsed.pathname)?.[1];
  return {
    href: prUrl,
    label: number === undefined ? "Pull request" : `PR #${number}`,
  };
};
