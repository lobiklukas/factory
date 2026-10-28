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
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/utils/retry";
import type {
  ConversationId,
  Extension,
  Harness,
} from "@earendil-works/pi-durable";
import {
  AgentDoc,
  configure,
  defineEntry,
  defineExtension,
  GenerationTask,
  hook,
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
): Effect.Effect<void, unknown> =>
  Effect.gen(function* () {
    const conversation = yield* Effect.tryPromise(() =>
      harness.conversation(conversationId, BACKGROUND_CONTEXT),
    );
    if (conversation === undefined) return;
    const at = DateTime.formatIso(yield* DateTime.now);
    const change: ModelSwitch = {
      from: modelKey(failed),
      to: modelKey(to),
      reason,
      at,
    };
    yield* Effect.tryPromise(() =>
      conversation.commit(async (tx) => {
        const agent = await tx.doc(AgentDoc, conversationId);
        if (
          agent.model?.provider !== failed.provider ||
          agent.model.modelId !== failed.modelId
        )
          return;
        await configure(tx, conversationId, {
          model: { provider: to.provider, modelId: to.modelId },
        });
        await tx.appendEntry(ModelSwitchEntry, conversationId, {
          data: { ...change, text: describeModelSwitch(change) },
        });
      }, BACKGROUND_CONTEXT),
    );
  });

/**
 * The chain as an extension, installed by `openSession` for a run whose role has one. `chain` is the
 * head and its fallbacks, in order; an answer from a model in it that is a trigger moves the
 * conversation that asked onto the model after it, and an answer from the last, or from a model the
 * chain does not hold (a session created on a model of its own), moves nothing. `session` is read
 * when an answer arrives, which is always after the harness that owns the hook has opened.
 *
 * A switch that cannot be committed is logged and the run carries on as if there were no chain: Pi
 * Durable retries the same model, which is what a run without one does.
 */
export const fallbackExtension = (
  chain: readonly ModelAccess[],
  session: () => Pick<Harness, "conversation"> | undefined,
): Extension =>
  defineExtension({
    name: FALLBACK_EXTENSION,
    hooks: [
      hook(GenerationTask, {
        afterResponse: (message, api) => {
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
            commitSwitch(
              harness,
              api.conversationId,
              failed,
              next,
              message.errorMessage ?? "",
            ).pipe(
              Effect.catch((cause) =>
                Effect.logError(
                  `model switch: ${modelKey(failed)} → ${modelKey(next)} could not be committed; the request is retried on ${modelKey(failed)}`,
                  cause,
                ),
              ),
            ),
          );
        },
      }),
    ],
  });
