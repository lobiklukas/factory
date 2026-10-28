/**
 * What the session pane says when a session is pinned to a model this server does not serve (E9).
 *
 * A session's model is pinned into its log when it first opens, and a pin outlives the backend that
 * chose it: a session created under faux is still on `faux/faux-1` after the API restarts on
 * anthropic. The server refuses a send to it as `model_unavailable` and reports
 * `modelAvailable: false`; the pane disables the composer rather than let a person type into a box
 * that can only refuse, says why in the server's terms, and offers the way forward: a replay of the
 * session's task onto the model this server runs by default (`replaySession`).
 *
 * Pure, so which sessions count and what the words name are unit cases, not a screenshot's guess.
 */

/**
 * The model the session is pinned to when this server cannot serve it, or `null` when it can — or
 * when the server did not say (`modelAvailable` absent: a read that knows no catalog, a session that
 * names no model). Only an explicit `false` disables anything: a composer locked on a guess would
 * strand a healthy session.
 */
export const unservedModel = (summary: {
  readonly model?: string | undefined;
  readonly modelAvailable?: boolean | undefined;
}): string | null =>
  summary.modelAvailable === false &&
  summary.model !== undefined &&
  summary.model !== ""
    ? summary.model
    : null;

/** What the notice and its button say. */
export type ModelUnavailableNotice = {
  /** Why the composer is disabled: names the pinned model, and that a pin does not change. */
  readonly explanation: string;
  /** The Replay button's label: names the model the replay runs on once the server has said it. */
  readonly replayLabel: string;
  /** The composer's placeholder while it is disabled. */
  readonly placeholder: string;
};

export const modelUnavailableNotice = (
  pinned: string,
  defaultModel: string | undefined,
): ModelUnavailableNotice => ({
  explanation: `This session is pinned to ${pinned}, which this server does not serve, so it cannot take another message. A session keeps the model it started on. ${
    defaultModel === undefined
      ? "Replay it to run the same task again on the model this server runs."
      : `Replay it to run the same task again on ${defaultModel}.`
  }`,
  replayLabel:
    defaultModel === undefined ? "Replay" : `Replay on ${defaultModel}`,
  placeholder: `Not available: ${pinned} is not served here`,
});
