/**
 * Replaying a recorded session against another model (LOB-198).
 *
 * A replay is *not* a fork: a fork copies a transcript's prefix and the two logs then diverge, while
 * a replay takes the same task — the prompt a session was opened with — and runs it again in a
 * fresh session on a different model. So the replay's transcript starts empty and fills with its own
 * run, and the only thing it takes from the source is the task, the repo binding and the recorded
 * model it departed from.
 *
 * Opening a replay reads the source through a reader-mode `Storage` and never writes to it. That is
 * a claim worth stating as a mechanism rather than as care: `readReplaySource` is the only place
 * `replaySession` touches the source, it takes a reader, and the document that links the two
 * sessions is committed to the *replay's* own log.
 *
 * Once the replay's task settles, the two runs are compared (LOB-199): `readReplayRun` measures each
 * log through a reader, `compareReplay` turns the two readings into one comparison per side, and
 * `writeReplayComparison` commits each into its own session's `factory.replay` document. That is the
 * one write a replay ever makes to its source, and it is a document, not a run: the source's
 * transcript, spend, binding and lineage stay what they were.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Storage } from "@earendil-works/pi-durable";
import { Effect, Schema } from "effect";
import type {
  ReplayRun,
  SessionError,
  SessionId,
  SessionUsage,
} from "@repo/domain/Session";
import {
  ReplayComparison,
  SessionError as SessionErrorClass,
} from "@repo/domain/Session";
import type { BindableSandboxRuntimeShape } from "@repo/sandbox";
import { ReplayDoc } from "./docs";
import type { RunProfile } from "./loader";
import type { McpServerAccess } from "./mcp";
import type { RepoContext } from "./repoContext";
import type { ModelAccess } from "./models";
import { modelKey } from "./models";
import type { ApprovalAsker, SessionPolicy } from "./policy";
import { usageCostTotal } from "./projection";
import {
  ActorDoc,
  attempt,
  closeSession,
  openSession,
  readBudgetSource,
  readPromptSubmission,
  readSessionLog,
  SessionDoc,
  submitMessage,
  TitleEntry,
  type Conversation,
  type OpenSession,
  type RepoBinding,
  type SubmittedMessage,
} from "./session";
import type { VerifyOptions } from "./verify";
import type { InjectedSecrets } from "./secrets";
import { inheritBudget, setBudget, type BudgetSource } from "./budget";

// The document lives with the other typed tokens (`./docs`), where the snapshot reads it too; it is
// re-exported here because a replay is what it is about.
export { ReplayDoc };

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
  /** The runtime the replay's commands run through (LOB-244), as `OpenSessionOptions.sandbox`. */
  readonly sandbox?: BindableSandboxRuntimeShape;
  readonly policy?: SessionPolicy;
  /** How the replay's gated calls ask a person (D15, LOB-52); see `OpenSessionOptions.approvalAsker`. */
  readonly approvalAsker?: ApprovalAsker;
  /** The MCP servers its run may call (S-agent-mcp-tools), as `OpenSessionOptions.mcp`. */
  readonly mcp?: readonly McpServerAccess[];
  readonly run?: RunProfile;
  /**
   * What the replay's repository tells it, as `OpenSessionOptions.repo`: read again for the replay's
   * own worktree, so the run on the other model is told what the source's repository says.
   */
  readonly repo?: RepoContext;
  /** What the replay's `verify` tool runs (LOB-78), as `OpenSessionOptions.verify`. */
  readonly verify?: VerifyOptions;
  /** The values the replay's commands are given, masked in its log, as `OpenSessionOptions.secrets`. */
  readonly secrets?: InjectedSecrets;
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
      ...(options.sandbox === undefined ? {} : { sandbox: options.sandbox }),
      ...(options.policy === undefined ? {} : { policy: options.policy }),
      ...(options.approvalAsker === undefined
        ? {}
        : { approvalAsker: options.approvalAsker }),
      ...(options.run === undefined ? {} : { run: options.run }),
      ...(options.repo === undefined ? {} : { repo: options.repo }),
      ...(options.verify === undefined ? {} : { verify: options.verify }),
      ...(options.secrets === undefined ? {} : { secrets: options.secrets }),
      ...(options.mcp === undefined ? {} : { mcp: options.mcp }),
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
    ).pipe(Effect.tapError(() => closeSession(opened).pipe(Effect.ignore)));
    const submission = yield* submitMessage(opened.root, {
      content: options.source.prompt,
    }).pipe(Effect.tapError(() => closeSession(opened).pipe(Effect.ignore)));
    return { ...opened, source: options.source, submission };
  });

/**
 * One side of a replay, measured from its log (LOB-199): how its task settled, how many assistant
 * entries the log ran, and what it spent — both `pi.usage` buckets, the total the list shows.
 * `model` is the caller's, from the replay's link: the log's spend names models, but a run that
 * never reached a request names none, and the link always says which model a side was.
 *
 * The task is the log's first user entry — the one `readReplaySource` hands a replay — and its
 * outcome is the submission that placed it. A fork's first entry was copied, not submitted, so no
 * submission names it: its outcome is then what the transcript shows (an assistant entry answers it
 * before the next prompt does), and its copied prefix is reported as `inherited` instead of being
 * counted in `turns`, because the spend that bought it is the parent's and is not in `cost` either.
 */
export const readReplayRun = (
  storage: Storage,
  session: SessionId,
  model: string,
): Effect.Effect<ReplayRun, SessionError> =>
  Effect.gen(function* () {
    const log = yield* readSessionLog(storage);
    const entries = log.entries;
    const copied =
      log.forkedAt === undefined
        ? 0
        : entries.findIndex((entry) => entry.id === log.forkedAt) + 1;
    const task = entries.findIndex((entry) => entry.kind === "user");
    const record = yield* readPromptSubmission(storage, entries[task]?.id);
    const outcome =
      record !== undefined
        ? record.status === "done"
          ? { outcome: "answered" as const }
          : record.status === "unanswered"
            ? { outcome: "unanswered" as const, reason: record.reason }
            : { outcome: "open" as const }
        : task === -1
          ? // A replay's source always has a prompt (`readReplaySource` refuses one without), and a
            // replay is opened with one; a log with none has nothing that settled.
            { outcome: "unanswered" as const, reason: "no prompt" }
          : answeredInTranscript(entries, task)
            ? { outcome: "answered" as const }
            : { outcome: "unanswered" as const, reason: "no answer recorded" };
    const assistants = (from: number, to: number): number =>
      entries.slice(from, to).filter((entry) => entry.kind === "assistant")
        .length;
    return {
      session,
      model,
      ...outcome,
      turns: assistants(copied, entries.length),
      cost: usageCostTotal(log.usage),
      ...(log.forkedFrom === undefined
        ? {}
        : {
            inherited: { from: log.forkedFrom, turns: assistants(0, copied) },
          }),
    };
  });

/** Whether an assistant entry follows the user entry at `task` before the next user entry does. */
const answeredInTranscript = (
  entries: readonly { readonly kind: string }[],
  task: number,
): boolean => {
  for (const entry of entries.slice(task + 1)) {
    if (entry.kind === "user") return false;
    if (entry.kind === "assistant") return true;
  }
  return false;
};

/**
 * The two comparisons one reading yields (LOB-199): the replay's, naming its source, and the
 * source's, naming the replay. Each `delta` is its own side minus the other, computed once per side
 * from the same two numbers, so the deltas are exact negatives of each other — IEEE subtraction is
 * antisymmetric, and no rounding happens between them.
 */
export const compareReplay = (reading: {
  readonly source: ReplayRun;
  readonly replay: ReplayRun;
  readonly at: string;
}): {
  readonly source: ReplayComparison;
  readonly replay: ReplayComparison;
} => ({
  replay: compareSide("replay", reading.replay, reading.source, reading.at),
  source: compareSide("source", reading.source, reading.replay, reading.at),
});

const compareSide = (
  role: ReplayComparison["role"],
  self: ReplayRun,
  counterpart: ReplayRun,
  at: string,
): ReplayComparison => ({
  role,
  at,
  self,
  counterpart,
  delta: {
    turns: self.turns - counterpart.turns,
    cost: self.cost - counterpart.cost,
  },
});

/**
 * The comparison the other side of `comparison` holds (LOB-199): the same reading with the roles
 * swapped. What repairs a pair only one log of which carries its comparison — a write the process
 * did not finish — without a second reading, so the two still mirror each other exactly: the delta
 * is recomputed by the same subtraction `compareReplay` made, not negated.
 */
export const mirrorComparison = (
  comparison: ReplayComparison,
): ReplayComparison =>
  compareSide(
    comparison.role === "replay" ? "source" : "replay",
    comparison.counterpart,
    comparison.self,
    comparison.at,
  );

const encodeComparison = Schema.encodeSync(ReplayComparison);

/**
 * Commit one comparison to the session it describes (LOB-199), keyed by its counterpart: the other
 * comparisons the document holds are kept, and recording the same pair again rewrites its entry
 * rather than adding one. On a source this is the document's first write, and it leaves the link
 * fields at their seed — a source compared with a replay is not a replay.
 */
export const writeReplayComparison = (
  conversation: Conversation,
  comparison: ReplayComparison,
): Effect.Effect<void, SessionError> =>
  attempt("write replay comparison", () =>
    conversation.commit(
      (tx) =>
        tx.doc(ReplayDoc, conversation.id).then((document) => {
          // Spread rather than assigned into: a document written before comparisons existed has no
          // `comparisons` object to assign into, and spreading nothing is an empty set.
          document.comparisons = {
            ...document.comparisons,
            [comparison.counterpart.session]: encodeComparison(comparison),
          };
        }),
      BACKGROUND_CONTEXT,
    ),
  );
