/**
 * The per-session budget cap (LOB-163, part 3 of LOB-17): a session's spend has a ceiling, and a run
 * that reaches it stops and says so.
 *
 * Stop semantics — what "the cap stops a run at the limit" means, exactly:
 *
 * - **What is capped.** The session's spend in the currency `pi.usage` reports (US dollars): both
 *   buckets of the root conversation's ledger, models and tools — the same total the session list
 *   shows (LOB-153, `usageCostTotal`). The cap lives in the session's own log, as the `factory.budget`
 *   document `writeBudget` commits at create, so it survives a restart and a fold reads it back (D7).
 * - **When it is checked.** Before every model request a run would send: Pi Durable's `beforeRequest`
 *   hook on the generation task, which runs before the first request of a run, before each request
 *   after a tool round, and before every retry. Spend is only ever added by a request that already
 *   answered, so this is the last point at which stopping saves anything.
 * - **The limit.** A run stops when spend has *reached* the cap (`spent >= cap`). A request already
 *   sent is paid for, so a session can end above its cap by the cost of the one request that crossed
 *   it — never by a second.
 * - **How it stops.** As an interrupt does: the root conversation is aborted, so the request is never
 *   sent, every task of the run is aborted (a running tool call included), queued messages are
 *   withdrawn, and the run settles `unanswered` with reason `aborted`. Nothing waits: the session is
 *   idle when the stop is done.
 * - **How it is reported.** Before the abort, one commit records the stop twice: a `budget` entry in
 *   the transcript (`describeBudgetStop`, the line an attached client and `factory run` print) and the
 *   stop on the `factory.budget` document, which a snapshot reports as `budget.stopped`. A recovered
 *   request re-checks after a restart and finds its stop already recorded, so a stop is announced once
 *   per generation task.
 * - **After a stop.** The session stays capped: a later message starts a run that stops before its
 *   first request, with a stop entry of its own and no spend. Raising a session's cap is not built.
 * - **What it does not stop.** A compaction's summary request and a curation call are not generation
 *   requests, so the hook does not see them; their spend still counts toward the total it checks.
 *
 * Like `./ask`, the module knows no database: the hook reads committed documents through Pi Durable,
 * and the only write is to the session's own log.
 */
import type { Context as ChordContext } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type {
  Conversation,
  Extension,
  HookApi,
} from "@earendil-works/pi-durable";
import {
  defineDoc,
  defineEntry,
  defineExtension,
  GenerationTask,
  hook,
  ROOT_CONVERSATION_ID,
  UsageDoc,
} from "@earendil-works/pi-durable";
import { DateTime, Effect } from "effect";
import {
  SessionError as SessionErrorClass,
  type SessionError,
} from "@repo/domain/Session";
import {
  BUDGET_DOC_KIND,
  BUDGET_STOPPED_ENTRY_KIND,
  projectUsageDoc,
  usageCostTotal,
} from "./projection";

/** The name the extension carrying the hook is installed under. */
export const BUDGET_EXTENSION = "factory.budget";

/**
 * The cap and the last stop. The seed's cap is `0`, which is "no cap" — a session created without
 * one never writes this document, and the hook reads the seed. The stop fields are flat rather than a
 * nested object so every field always has a value; `stoppedAt` empty means the cap never stopped a
 * run. `stoppedTask` is the generation task the stop was recorded for, which is what makes the record
 * once per task across a recovery.
 */
export const BudgetDoc = defineDoc({
  kind: BUDGET_DOC_KIND,
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({
    cap: 0,
    stoppedAt: "",
    stoppedSpent: 0,
    stoppedCap: 0,
    stoppedTask: "",
  }),
});

/** A budget stop, announced in the transcript. It carries no model content: the agent never sees it. */
export const BudgetStoppedEntry = defineEntry<{
  readonly text: string;
  readonly cap: number;
  readonly spent: number;
  readonly at: string;
}>(BUDGET_STOPPED_ENTRY_KIND);

/** An amount the way a budget line prints it: dollars, to the hundredth of a cent. */
export const formatDollars = (amount: number): string =>
  `$${amount.toFixed(4)}`;

/** The line a budget stop reads as, in the transcript and in a terminal. */
export const describeBudgetStop = (stop: {
  readonly spent: number;
  readonly cap: number;
}): string =>
  `budget reached: the session has spent ${formatDollars(stop.spent)} of its ` +
  `${formatDollars(stop.cap)} cap, so the run was stopped before its next model request`;

/**
 * Commit a session's cap (LOB-163). Called once, at create, before any message can start a run: a
 * cap written after a run started would let that run's first request through uncounted.
 */
export const writeBudget = (
  conversation: Conversation,
  cap: number,
): Effect.Effect<void, SessionError> =>
  Effect.tryPromise({
    try: () =>
      conversation.commit(
        (tx) =>
          tx.doc(BudgetDoc, conversation.id).then((doc) => {
            doc.cap = cap;
          }),
        BACKGROUND_CONTEXT,
      ),
    catch: (cause) =>
      new SessionErrorClass({
        code: "harness",
        message: `write budget: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  });

/** What a stop records: the generation task it stopped, and the spend and cap it was measured at. */
type BudgetStop = {
  readonly taskId: string;
  readonly spent: number;
  readonly cap: number;
  readonly at: string;
};

/**
 * Record a stop, once per generation task: the document's stop fields and the transcript's entry in
 * one commit. A task that already recorded its stop — a recovered request, rechecking after the
 * process died between this commit and the abort — commits nothing.
 */
const recordStop = (root: Conversation, stop: BudgetStop): Promise<void> =>
  root.commit(
    (tx) =>
      tx.doc(BudgetDoc, root.id).then((doc) => {
        if (doc.stoppedTask === stop.taskId) return undefined;
        doc.stoppedAt = stop.at;
        doc.stoppedSpent = stop.spent;
        doc.stoppedCap = stop.cap;
        doc.stoppedTask = stop.taskId;
        return tx
          .appendEntry(BudgetStoppedEntry, root.id, {
            data: {
              text: describeBudgetStop(stop),
              cap: stop.cap,
              spent: stop.spent,
              at: stop.at,
            },
          })
          .then(() => undefined);
      }),
    BACKGROUND_CONTEXT,
  );

/**
 * Wait until the asking task is told to stop: its invocation's signal fires once the abort is
 * committed, which is what lets the hook's failure end the phase (Pi Durable rethrows a hook error
 * only when the invocation was aborted; any other error it reports and carries on). If the abort
 * settles without reaching this task, the wait ends too, so the hook can never hang a request.
 */
const untilStopped = (
  context: ChordContext,
  abort: Promise<void>,
): Effect.Effect<void> =>
  Effect.callback<void>((resume) => {
    const signal = context.abortSignal;
    const done = () => resume(Effect.void);
    if (signal?.aborted === true) return done();
    signal?.addEventListener("abort", done, { once: true });
    abort.then(done, done);
    return Effect.sync(() => signal?.removeEventListener("abort", done));
  });

/**
 * The check before one request: read the cap and the spend from committed state, and below the cap
 * let the request through. At or past it, record the stop, abort the session's run, and fail once the
 * abort reached this task — the request is never sent.
 */
const checkBudget = (
  api: HookApi,
  context: ChordContext,
  root: Conversation | undefined,
): Effect.Effect<undefined> =>
  Effect.gen(function* () {
    // The root conversation's, whichever conversation asks: the cap is the session's, and so is
    // the ledger the list reports (`pi.usage` is per conversation).
    const budget = yield* Effect.promise(() =>
      api.snapshot(BudgetDoc, ROOT_CONVERSATION_ID, context),
    );
    const cap = budget?.cap ?? 0;
    if (cap <= 0 || root === undefined) return undefined;
    const usage = yield* Effect.promise(() =>
      api.snapshot(UsageDoc, ROOT_CONVERSATION_ID, context),
    );
    const spent = usageCostTotal(projectUsageDoc(usage));
    if (spent < cap) return undefined;
    const at = DateTime.formatIso(yield* DateTime.now);
    yield* Effect.promise(() =>
      recordStop(root, { taskId: String(api.taskId), spent, cap, at }),
    );
    // Not awaited: `abort` resolves once the conversation is idle, and it cannot be idle while this
    // hook holds its request open. Its marking is what fires the signal `untilStopped` waits on.
    const abort = root.abort(BACKGROUND_CONTEXT);
    yield* untilStopped(context, abort);
    return yield* Effect.die(new Error(describeBudgetStop({ spent, cap })));
  });

/**
 * The cap, as an extension installed at `openSession` for every session. A session with no cap pays
 * one document read per request and nothing else. `root` is read when a request is about to be sent,
 * which is always after the harness that owns the hook has opened its root conversation.
 */
export const budgetExtension = (
  root: () => Conversation | undefined,
): Extension =>
  defineExtension({
    name: BUDGET_EXTENSION,
    hooks: [
      hook(GenerationTask, {
        beforeRequest: (_request, api, context) =>
          Effect.runPromise(checkBudget(api, context, root())),
      }),
    ],
  });
