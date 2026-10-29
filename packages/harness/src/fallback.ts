/**
 * A role's fallback chain (S-model-provider-breadth): the models a run moves onto, in order, when the
 * one it is on answers overloaded or unavailable.
 *
 * A session is pinned to the model its root was created on (`./session`'s `readPinnedModel`), and
 * that rule stands for everything but this: a recorded switch. The chain is deployment configuration
 * beside the role table (`ROLE_FALLBACKS`, `parseRoleFallbacks`), resolved against the same catalog
 * at boot, so a chain naming a model the process cannot serve fails the boot rather than a run.
 *
 * The switch rides Pi Durable's own retry rather than replacing it. pi-ai classifies an overloaded or
 * unavailable answer as retryable, so Pi Durable appends the failed answer and schedules the request
 * again; the retry re-reads the conversation's agent when it prepares. The hook here
 * (`fallbackExtension`, `afterResponse`) runs before that classification, and when the answer is a
 * fallback's trigger it commits, in one commit, the conversation's agent moved onto the next model
 * and a `factory.model.switched` entry saying so — so the retry goes to the fallback, the transcript
 * says why the answers after it come from another model, and Pi Durable's ledger, which keys usage
 * by the model that answered, charges each answer to the model that gave it. Nothing in Pi Durable
 * is modified: an agent change is its public `configure`.
 *
 * Only overload and unavailability move a run (`isProviderUnavailable`): a refusal, a rate limit, a
 * bad request or an overflow is not the provider being down, and another model would not be the fix.
 * A switch happens once per model: the move is from the model that failed to the one after it, and
 * only while the conversation is still on the model that failed — a retried hook, or a recovered
 * request that failed again on the model the log already moved off, commits nothing. The session
 * stays on the fallback afterwards; it never moves back up the chain on its own.
 *
 * Two limits follow from riding the retry. A switch is made only for a request Pi Durable will send
 * again (`isRetried`): its attempts are counted per request across every model the request went to,
 * so a request whose retries are spent — on transient errors of the same model, or on earlier links
 * of a chain longer than the policy's retries — fails on the model it is on, and no switch is
 * recorded for a retry that never comes. And a session created on a model of its own (LOB-274,
 * `SessionModelDoc`) is never moved: the chain is its role's, and that session is not on it.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/utils/retry";
import type {
  ConversationId,
  ConversationRetryPolicy,
  Extension,
  Harness,
} from "@earendil-works/pi-durable";
import {
  AgentDoc,
  configure,
  defineDoc,
  defineEntry,
  defineExtension,
  DEFAULT_RETRY_POLICY,
  GenerationTask,
  hook,
  LiveDoc,
} from "@earendil-works/pi-durable";
import { DateTime, Effect, Schema } from "effect";
import { modelAccessFor, modelKey, type ModelAccess } from "./models";
import { MODEL_SWITCH_ENTRY_KIND } from "./projection";

export const FALLBACK_EXTENSION = "factory.model-fallback";

/** The deployment's role → fallback chain table is malformed, or names a model it cannot serve. */
export class InvalidRoleFallbacks extends Schema.TaggedError<InvalidRoleFallbacks>()(
  "InvalidRoleFallbacks",
  { message: Schema.String },
) {}

/**
 * Role → the models its runs fall back to, in order, resolved against the catalog. The role's own
 * model (its `ROLE_MODELS` row, else the deployment's) is not in its chain: it is the head the chain
 * follows. A `Map`, for the reason `RoleModels` is one.
 */
export type RoleFallbacks = ReadonlyMap<string, readonly ModelAccess[]>;

/** A deployment that names no fallbacks: a run whose model is down fails as it always did. */
export const NO_ROLE_FALLBACKS: RoleFallbacks = new Map();

/**
 * Read the table as a deployment writes it (`ROLE_FALLBACKS`): comma-separated
 * `role=provider/modelId|provider/modelId`, the chain in the order it is tried. Blank entries are
 * skipped, so an empty value is an empty table. A row with no `=`, an empty side or an empty link, a
 * role named twice, or a model named twice in one chain is refused rather than guessed at.
 */
export const parseRoleFallbacks = (
  text: string,
): Effect.Effect<
  ReadonlyMap<string, readonly string[]>,
  InvalidRoleFallbacks
> =>
  Effect.gen(function* () {
    const table = new Map<string, readonly string[]>();
    for (const raw of text.split(",")) {
      const entry = raw.trim();
      if (entry.length === 0) continue;
      const equals = entry.indexOf("=");
      const role = equals < 0 ? "" : entry.slice(0, equals).trim();
      const chain =
        equals < 0
          ? []
          : entry
              .slice(equals + 1)
              .split("|")
              .map((key) => key.trim());
      if (
        role.length === 0 ||
        chain.length === 0 ||
        chain.some((key) => key === "")
      ) {
        return yield* new InvalidRoleFallbacks({
          message: `role fallback "${entry}" is not role=provider/modelId|provider/modelId`,
        });
      }
      if (table.has(role)) {
        return yield* new InvalidRoleFallbacks({
          message: `role ${role} is given a fallback chain twice`,
        });
      }
      if (new Set(chain).size !== chain.length) {
        return yield* new InvalidRoleFallbacks({
          message: `role ${role}'s fallback chain names a model twice`,
        });
      }
      table.set(role, chain);
    }
    return table;
  });

/**
 * Resolve each chain against the catalog `deployment` was built with (`modelAccessFor`), once, at
 * boot. A link the process cannot serve is refused, and so is a chain that names its own head — the
 * role's row in `roles`, else the deployment's model — because falling back onto the model that just
 * failed is a retry, which Pi Durable already does.
 */
export const resolveRoleFallbacks = (
  deployment: ModelAccess,
  roles: ReadonlyMap<string, ModelAccess>,
  declared: ReadonlyMap<string, readonly string[]>,
): Effect.Effect<RoleFallbacks, InvalidRoleFallbacks> =>
  Effect.gen(function* () {
    const resolved = new Map<string, readonly ModelAccess[]>();
    for (const [role, keys] of declared) {
      const head = modelKey(roles.get(role) ?? deployment);
      const chain: ModelAccess[] = [];
      for (const key of keys) {
        const access = modelAccessFor(deployment, key);
        if (access === undefined) {
          return yield* new InvalidRoleFallbacks({
            message: `role ${role}'s fallback chain names model ${key}, which this process does not serve`,
          });
        }
        if (modelKey(access) === head) {
          return yield* new InvalidRoleFallbacks({
            message: `role ${role}'s fallback chain names ${key}, which is the role's own model`,
          });
        }
        chain.push(access);
      }
      resolved.set(role, chain);
    }
    return resolved;
  });

/**
 * What an overloaded or unavailable provider says: Anthropic's `529 overloaded_error`, an HTTP `503`,
 * "service unavailable", and the capacity wordings pi-ai's retry pattern names. Rate limits (`429`),
 * other server errors, timeouts and transport failures are not here: they are retried on the same
 * model, and only a provider that says it cannot serve moves a run to another one.
 */
const UNAVAILABLE =
  /\b529\b|\b503\b|overloaded|service.?unavailable|model is at capacity|currently experiencing high demand/i;

/**
 * Whether an answer is a fallback's trigger: a failed request whose error says the provider is
 * overloaded or unavailable, and which pi-ai calls retryable — the retry is what the switch rides,
 * so an answer Pi Durable would not retry (a quota exhausted, worded "overloaded") never moves a run.
 */
export const isProviderUnavailable = (message: AssistantMessage): boolean =>
  message.stopReason === "error" &&
  isRetryableAssistantError(message) &&
  UNAVAILABLE.test(message.errorMessage ?? "");

/**
 * The retry policy every session's harness runs with (`openSession`'s settings): the one the hook
 * reads to know whether the failed request will be sent again. Pi Durable's own default, named here
 * so the harness and the hook cannot disagree about it.
 */
export const SESSION_RETRY_POLICY: ConversationRetryPolicy = {
  ...DEFAULT_RETRY_POLICY,
};

/**
 * Whether Pi Durable sends a request again after its `attempt`th answer failed retryably — the rule
 * its generation task applies after the `afterResponse` hooks ran: retries enabled and `attempt` not
 * past `maxRetries`. Attempts count from 1 and are not reset by a switch. An attempt the hook could
 * not read is treated as not retried, so a switch is never recorded for a retry that may not come.
 */
export const isRetried = (
  attempt: number | undefined,
  policy: ConversationRetryPolicy,
): boolean =>
  attempt !== undefined && policy.enabled && attempt <= policy.maxRetries;

export const SESSION_MODEL_DOC_KIND = "factory.session-model";

/**
 * The model a session was created on when it was created on one of its own (LOB-274), written in
 * the commit that creates its root and never again. Its presence is what keeps a role's fallback
 * chain off the session on every later open, whichever model that was — the role's own included —
 * because a person chose it. Absent (or blank): the session's model came from its role or the
 * deployment, and its role's chain applies.
 */
export const SessionModelDoc = defineDoc({
  kind: SESSION_MODEL_DOC_KIND,
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({ model: "" }),
});

/** One switch, as the log records it. */
export type ModelSwitch = {
  /** The model that answered overloaded or unavailable, `provider/modelId`. */
  readonly from: string;
  /** The model the session moved onto, `provider/modelId`. */
  readonly to: string;
  /** The provider's error, verbatim. */
  readonly reason: string;
  readonly at: string;
};

export const ModelSwitchEntry = defineEntry<
  ModelSwitch & { readonly text: string }
>(MODEL_SWITCH_ENTRY_KIND);

/** A switch could not be committed: the conversation could not be read, or its commit failed. */
export class ModelSwitchFailed extends Schema.TaggedError<ModelSwitchFailed>()(
  "ModelSwitchFailed",
  { message: Schema.String },
) {}

const switchFailed = (cause: unknown): ModelSwitchFailed =>
  new ModelSwitchFailed({
    message: cause instanceof Error ? cause.message : String(cause),
  });

/** The switch as one transcript line. */
export const describeModelSwitch = (change: {
  readonly from: string;
  readonly to: string;
  readonly reason: string;
}): string =>
  `model switch: ${change.from} is unavailable (${change.reason}), so the run's retried request ` +
  `and every later one go to ${change.to}, the next model in its role's fallback chain`;

/**
 * Commit the switch when the conversation is still on the model that failed: its agent moved onto
 * `to` and the entry that says so, in one commit, so neither is ever in the log without the other.
 * Whether it moved is decided inside the commit, against the committed agent, so two hooks for the
 * same failure — or a recovered request that failed on a model the log already left — move it once.
 */
const commitSwitch = (
  harness: Pick<Harness, "conversation">,
  conversationId: ConversationId,
  failed: ModelAccess,
  to: ModelAccess,
  reason: string,
): Effect.Effect<void, ModelSwitchFailed> =>
  Effect.gen(function* () {
    const conversation = yield* Effect.tryPromise({
      try: () => harness.conversation(conversationId, BACKGROUND_CONTEXT),
      catch: switchFailed,
    });
    if (conversation === undefined) return;
    const at = DateTime.formatIso(yield* DateTime.now);
    const change: ModelSwitch = {
      from: modelKey(failed),
      to: modelKey(to),
      reason,
      at,
    };
    yield* Effect.tryPromise({
      try: () =>
        conversation.commit(
          (tx) =>
            tx.doc(AgentDoc, conversationId).then((agent) =>
              agent.model?.provider !== failed.provider ||
              agent.model.modelId !== failed.modelId
                ? undefined
                : configure(tx, conversationId, {
                    model: { provider: to.provider, modelId: to.modelId },
                  })
                    .then(() =>
                      tx.appendEntry(ModelSwitchEntry, conversationId, {
                        data: { ...change, text: describeModelSwitch(change) },
                      }),
                    )
                    .then(() => undefined),
            ),
          BACKGROUND_CONTEXT,
        ),
      catch: switchFailed,
    });
  });

/**
 * The chain as an extension, installed by `openSession` for a run whose role has one and that was not
 * created on a model of its own. `chain` is the head and its fallbacks, in order; an answer from a
 * model in it that is a trigger moves the conversation that asked onto the model after it, and an
 * answer from the last, or from a model the chain does not hold, moves nothing. Nor does an answer
 * whose request Pi Durable will not retry (`isRetried` under `retry`, the harness's policy): the run
 * then ends on the model that failed, as a run without a chain does. `session` is read when an answer
 * arrives, which is always after the harness that owns the hook has opened.
 *
 * A switch that cannot be committed is logged and the run carries on as if there were no chain: Pi
 * Durable retries the same model, which is what a run without one does.
 */
export const fallbackExtension = (
  chain: readonly ModelAccess[],
  session: () => Pick<Harness, "conversation"> | undefined,
  retry: ConversationRetryPolicy = SESSION_RETRY_POLICY,
): Extension =>
  defineExtension({
    name: FALLBACK_EXTENSION,
    hooks: [
      hook(GenerationTask, {
        afterResponse: (message, api, context) => {
          if (!isProviderUnavailable(message)) return;
          const index = chain.findIndex(
            (access) =>
              access.provider === message.provider &&
              access.modelId === message.model,
          );
          const failed = chain[index];
          const next = chain[index + 1];
          const harness = session();
          if (
            failed === undefined ||
            next === undefined ||
            harness === undefined
          )
            return;
          return Effect.runPromise(
            Effect.gen(function* () {
              // The attempt this answer was for, as the generation committed it when it prepared.
              const live = yield* Effect.tryPromise({
                try: () => api.snapshot(LiveDoc, api.conversationId, context),
                catch: switchFailed,
              });
              const attempt = live?.generation?.attempt;
              if (!isRetried(attempt, retry)) {
                return yield* Effect.logWarning(
                  `model switch: ${modelKey(failed)} is unavailable on attempt ${attempt ?? "?"} of a request whose retries are spent, so it is not retried and the run ends on ${modelKey(failed)} rather than moving to ${modelKey(next)}`,
                );
              }
              yield* commitSwitch(
                harness,
                api.conversationId,
                failed,
                next,
                message.errorMessage ?? "",
              );
            }).pipe(
              Effect.catch((error) =>
                Effect.logError(
                  `model switch: ${modelKey(failed)} → ${modelKey(next)} could not be committed (${error.message}); the request is retried on ${modelKey(failed)}`,
                ),
              ),
            ),
          );
        },
      }),
    ],
  });
