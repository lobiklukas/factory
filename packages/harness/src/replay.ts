/**
 * Replaying a recorded session against another model (LOB-198).
 *
 * A replay is *not* a fork: a fork copies a transcript's prefix and the two logs then diverge, while
 * a replay takes the same task — the prompt a session was opened with — and runs it again in a
 * fresh session on a different model. So the replay's transcript starts empty and fills with its own
 * run, and the only thing it takes from the source is the task, the repo binding and the recorded
 * model it departed from.
 *
 * The source is read through a reader-mode `Storage` and never written to. That is a claim worth
 * stating as a mechanism rather than as care: `readReplaySource` is the only place this module
 * touches the source, it takes a reader, and the document that links the two sessions is committed
 * to the *replay's* own log.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Storage } from "@earendil-works/pi-durable";
import { defineDoc } from "@earendil-works/pi-durable";
import { Effect } from "effect";
import type { SessionError, SessionUsage } from "@repo/domain/Session";
import { SessionError as SessionErrorClass } from "@repo/domain/Session";
import type { RunProfile } from "./loader";
import type { ModelAccess } from "./models";
import { modelKey } from "./models";
import type { ApprovalAsker, SessionPolicy } from "./policy";
import { REPLAY_DOC_KIND } from "./projection";
import {
  ActorDoc,
  attempt,
  closeHarness,
  openSession,
  readBudgetSource,
  readSessionLog,
  SessionDoc,
  submitMessage,
  TitleEntry,
  type OpenSession,
  type RepoBinding,
  type SubmittedMessage,
} from "./session";
import type { VerifyOptions } from "./verify";
import { inheritBudget, setBudget, type BudgetSource } from "./budget";

/**
 * The link between a replay and the session it replays, committed to the replay's own log.
 *
 * `source` is the session the prompt came from; `replay` is this log's own session id, which the
 * control plane mints before the log exists and hands in here — so the pair is named by one document
 * in one place. `from` is the model the source's log records (empty when it recorded none) and
 * `model` is the one this replay ran on, which is what makes "the same task, a different model"
 * checkable from the log rather than from the call that asked for it.
 */
export const ReplayDoc = defineDoc({
  kind: REPLAY_DOC_KIND,
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({ source: "", replay: "", model: "", from: "" }),
});

/**
 * The model a session's log records it spent most on, as `provider/modelId`.
 *
 * `pi.usage` is the only place the log names a model, and a session runs on one: a log whose keys
 * are several ran more than one over its life (a model switch, which nothing does yet), so this
 * answers the one that did most of the work — the same rule the PR step uses for its body.
 * `undefined` means the log names none, which is a session that ran no turn.
 */
const recordedModel = (usage: SessionUsage): string | undefined =>
  usage.models.reduce<(typeof usage.models)[number] | undefined>(
    (costliest, candidate) =>
      costliest === undefined ||
      candidate.usage.costTotal > costliest.usage.costTotal
        ? candidate
        : costliest,
    undefined,
  )?.key;

/** What a replay needs from the session it replays. */
export type ReplaySource = {
  /** The source's first user entry, verbatim: the task the replay runs again. */
  readonly prompt: string;
  /** The source's repo binding, which the replay works at too. Never empty: see below. */
  readonly binding: RepoBinding;
  /** The model the source's log records, when it records one. */
  readonly model?: string;
  /** The source's cap and spend (LOB-163): a replay keeps the cap, not the spend. */
  readonly budget: BudgetSource;
};

/**
 * Read what a replay needs off the source's log, refusing the two cases that would make a replay
 * mean nothing: a session with no prompt to replay, and one bound to no repo.
 *
 * The second refusal is explicit rather than a fallback to a scratch directory: a scratch replay
 * would answer "the same task" by running it somewhere the task never applied, which is a different
 * experiment wearing the same name.
 */
export const readReplaySource = (
  storage: Storage,
): Effect.Effect<ReplaySource, SessionError> =>
  Effect.gen(function* () {
    const log = yield* readSessionLog(storage);
    const binding = log.binding;
    if (binding.repo === "") {
      return yield* new SessionErrorClass({
        code: "invalid_input",
        message:
          "this session is bound to no repo, so it has nowhere to replay into",
      });
    }
    // The *first* user entry, not the first one with text in it: a replay's claim is that its first
    // prompt is the source's, so a source whose first prompt is blank has no replayable task rather
    // than a different one further down.
    const prompt = log.entries.find((entry) => entry.kind === "user");
    if (prompt === undefined) {
      return yield* new SessionErrorClass({
        code: "invalid_input",
        message: "this session has no prompt to replay",
      });
    }
    if (prompt.text.trim() === "") {
      return yield* new SessionErrorClass({
        code: "invalid_input",
        message:
          "this session's first prompt is empty, so there is no task to replay",
      });
    }
    const model = recordedModel(log.usage);
    const budget = yield* readBudgetSource(storage);
    return {
      prompt: prompt.text,
      binding,
      budget,
      ...(model === undefined ? {} : { model }),
    };
  });

/** What a replay runs: the source's task, the replay's own log, and the model to run it on. */
export type ReplaySessionOptions = {
  /** What `readReplaySource` answered — read before this is called, so a refusal writes nothing. */
  readonly source: ReplaySource;
  /** The session being replayed. */
  readonly sourceId: string;
  /** The replay's own session id, minted by the caller before this log existed. */
  readonly replayId: string;
  /** The replay's own log, opened in owner mode. */
  readonly target: Storage;
  /** The model to run the task on: the one thing a replay changes. */
  readonly model: ModelAccess;
  /** The replay's title, committed to its log so a rebuild does not lose it. Empty: untitled. */
  readonly title?: string;
  /**
   * Who the replay's spend is attributed to (LOB-162): the source's actor, committed with the
   * lineage so a replay never exists with an indexed actor its log does not record.
   */
  readonly actor?: string;
  readonly cwd: string;
  readonly policy?: SessionPolicy;
  /** How the replay's gated calls ask a person (D15, LOB-52); see `OpenSessionOptions.approvalAsker`. */
  readonly approvalAsker?: ApprovalAsker;
  readonly run?: RunProfile;
  /** What the replay's `verify` tool runs (LOB-78), as `OpenSessionOptions.verify`. */
  readonly verify?: VerifyOptions;
  /**
   * The cap a replay of an uncapped source gets (LOB-163): the server's default, as a create gets
   * it. A capped source's replay keeps its cap — the one thing a replay changes is the model — but
   * starts at no spend, because it is a fresh run of the source's task, not its continuation.
   */
  readonly defaultBudget?: number;
};

export type ReplayedSession = OpenSession & {
  readonly source: ReplaySource;
  readonly submission: SubmittedMessage;
};

/**
 * Open a replay: the replay's own session, its link to the source, then the source's prompt.
 *
 * The link, the title, the repo binding, the cap and the actor are one commit, in the shape a fork copies its entries
 * in: a replay that exists at all exists with everything `rebuildIndexes` folds, so no window
 * leaves a log whose origin, title or binding a rebuild would have to guess. The prompt is the
 * second commit, because the model call it starts is the point of the exercise and nothing after it
 * is required for the replay to be one. Neither commit touches the source, whose log this function
 * only ever reads through `readReplaySource`.
 */
export const replaySession = (
  options: ReplaySessionOptions,
): Effect.Effect<ReplayedSession, SessionError> =>
  Effect.gen(function* () {
    const opened = yield* openSession({
      storage: options.target,
      model: options.model,
      cwd: options.cwd,
      ...(options.policy === undefined ? {} : { policy: options.policy }),
      ...(options.approvalAsker === undefined
        ? {}
        : { approvalAsker: options.approvalAsker }),
      ...(options.run === undefined ? {} : { run: options.run }),
      ...(options.verify === undefined ? {} : { verify: options.verify }),
    });
    // A failure that leaves the harness open would leave a lease nobody releases: close it where the
    // failure is, as the fork's copy does.
    yield* attempt("write replay", () =>
      opened.root.commit((tx) => {
        const doc = tx.doc(ReplayDoc, opened.root.id).then((document) => {
          document.source = options.sourceId;
          document.replay = options.replayId;
          document.model = modelKey(options.model);
          document.from = options.source.model ?? "";
        });
        // The title and the repo binding are this log's own facts, and a session's log is what a
        // rebuild folds (D7): without them the replay would exist only in its index row, and
        // `rebuildIndexes` would return it untitled and unbound.
        const binding = tx.doc(SessionDoc, opened.root.id).then((document) => {
          document.repo = options.source.binding.repo;
          document.baseRef = options.source.binding.baseRef;
        });
        const title =
          options.title === undefined || options.title === ""
            ? []
            : [
                tx.appendEntry(TitleEntry, opened.root.id, {
                  data: { title: options.title },
                }),
              ];
        // The cap is in this commit, before the prompt's: the run the prompt starts is capped from
        // its first request.
        const budget = inheritBudget(
          options.source.budget,
          options.defaultBudget,
          false,
        );
        const cap =
          budget === undefined ? [] : [setBudget(tx, opened.root.id, budget)];
        const actor =
          options.actor === undefined
            ? []
            : [
                tx.doc(ActorDoc, opened.root.id).then((document) => {
                  document.actor = options.actor ?? "";
                }),
              ];
        return Promise.all([doc, binding, ...title, ...cap, ...actor]);
      }, BACKGROUND_CONTEXT),
    ).pipe(
      Effect.tapError(() => closeHarness(opened.harness).pipe(Effect.ignore)),
    );
    const submission = yield* submitMessage(opened.root, {
      content: options.source.prompt,
    }).pipe(
      Effect.tapError(() => closeHarness(opened.harness).pipe(Effect.ignore)),
    );
    return { ...opened, source: options.source, submission };
  });
