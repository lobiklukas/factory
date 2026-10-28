import type { ServerInfo } from "@repo/domain/Server";

/**
 * What the dashboard says about the model backend (LOB-272), from one `getServerInfo` read.
 *
 * A scripted answer reads exactly like a real one, and the only other faux signal is a boot line
 * inside turbo's TUI. So under the faux backend every route carries a banner that says so, and each
 * session names the model it is pinned to. Pure, so "which backends warn" and "what a missing model
 * prints" are unit cases rather than a screenshot's guess.
 */

/** The banner's sentence under the faux backend. The same words on every route. */
export const FAUX_BANNER =
  "Scripted model (faux): sessions do not reach a real model. Set ANTHROPIC_API_KEY in the repo-root .env and restart.";

/**
 * The banner to show, or `null` for none.
 *
 * `null` for an anthropic backend, and also for an answer not read yet (`undefined`): a banner that
 * flashed on every load until the first read landed would teach people to ignore it, and a control
 * plane that cannot answer is already said by the pages that read it. The reason (what chose the
 * backend) is the server's own line, so the banner repeats the boot's wording and does not invent one.
 */
export type BackendBanner = {
  readonly message: string;
  readonly reason: string;
};

export const backendBanner = (
  info: ServerInfo | undefined,
): BackendBanner | null =>
  info === undefined || info.backend !== "faux"
    ? null
    : { message: FAUX_BANNER, reason: info.reason };

/**
 * The model a session shows: its recorded `provider/modelId`, or `null` when its row names none (a
 * row older than the column that nothing has refolded). Nothing is guessed from the deployment's
 * default: a session pinned to another model would be shown the wrong one, which is worse than none.
 */
export const sessionModel = (model: string | undefined): string | null =>
  model === undefined || model === "" ? null : model;
