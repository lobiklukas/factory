/**
 * A second model provider beside the backend's (S-model-provider-breadth): any server that speaks
 * OpenAI's Chat Completions API — vLLM, Ollama, LiteLLM, OpenRouter, a gateway, OpenAI itself.
 *
 * It is pi-ai's own `openai-completions` API behind a provider this module builds (`createProvider`),
 * so a request to it goes through the same `Models` registry, the same Pi Durable generation and the
 * same usage ledger as one to Anthropic or the faux: a role row or a fallback chain names one of its
 * models as `openai-compatible/<id>` and nothing else changes. A generic endpoint publishes no
 * catalog pi-ai knows, so the deployment says which model ids it serves (`OPENAI_COMPATIBLE_MODELS`),
 * and what each costs when it costs anything — the price is what the ledger charges the model.
 *
 * The key is pi-ai's to read, never this module's: the provider's auth asks pi-ai's `AuthContext` for
 * `OPENAI_COMPATIBLE_API_KEY` when a request is made. An endpoint with no key set is keyless (a local
 * server): the request carries a placeholder the server ignores, rather than failing before it is
 * sent. Tests and verify drives point the base URL at a loopback fake (`./openaiCompatibleFake`).
 */
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { createProvider, type Provider } from "@earendil-works/pi-ai/models";
import { Effect, Schema } from "effect";

/** The provider id its models are named under: `openai-compatible/<model id>`. */
export const OPENAI_COMPATIBLE_PROVIDER = "openai-compatible";

/** The variable pi-ai reads the endpoint's key from, when it has one. Its value is never read here. */
export const OPENAI_COMPATIBLE_KEY_VARIABLE = "OPENAI_COMPATIBLE_API_KEY";

/** What a keyless endpoint is sent as its key: the SDK needs one, and a keyless server ignores it. */
const KEYLESS_PLACEHOLDER = "keyless";

/** The window a model is published with when the deployment does not say. */
const DEFAULT_CONTEXT_WINDOW = 128_000;
/** The answer room a model is published with when the deployment does not say. */
const DEFAULT_MAX_TOKENS = 16_384;

/** What one model costs, in US dollars per million tokens, as pi-ai's catalogs price theirs. */
export type OpenAICompatiblePrice = {
  readonly input: number;
  readonly output: number;
  readonly cacheRead?: number | undefined;
  readonly cacheWrite?: number | undefined;
};

/** One model the endpoint serves. */
export type OpenAICompatibleModel = {
  readonly id: string;
  readonly contextWindow?: number | undefined;
  readonly maxTokens?: number | undefined;
  /** Absent: free, so its answers land in the ledger at `$0`. */
  readonly cost?: OpenAICompatiblePrice | undefined;
};

/** The endpoint and the models it serves (`OPENAI_COMPATIBLE_BASE_URL`, `OPENAI_COMPATIBLE_MODELS`). */
export type OpenAICompatibleConfig = {
  /** The API's base, the part before `/chat/completions`: `http://127.0.0.1:8000/v1`. */
  readonly baseUrl: string;
  readonly models: readonly OpenAICompatibleModel[];
};

/** The endpoint's configuration is half there, or does not read. */
export class InvalidOpenAICompatible extends Schema.TaggedError<InvalidOpenAICompatible>()(
  "InvalidOpenAICompatible",
  { message: Schema.String },
) {}

const Price = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  cacheRead: Schema.optional(Schema.Finite),
  cacheWrite: Schema.optional(Schema.Finite),
});

const ModelsJson = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      id: Schema.NonEmptyString,
      contextWindow: Schema.optional(Schema.Int),
      maxTokens: Schema.optional(Schema.Int),
      cost: Schema.optional(Price),
    }),
  ),
);

/**
 * Read the endpoint's configuration as a deployment writes it. Both blank: no second provider.
 * `models` is either a comma-separated list of ids (`gpt-4o-mini,llama-3.1-70b`, free and with the
 * default window) or a JSON array of `{id, contextWindow?, maxTokens?, cost?: {input, output,
 * cacheRead?, cacheWrite?}}`. A base URL without models, models without a base URL, a URL that is not
 * http(s), a model named twice or a negative price fails the boot: a provider configured onto
 * nothing would make every role row that names it fail at boot anyway, for a less direct reason.
 */
export const parseOpenAICompatible = (input: {
  readonly baseUrl: string;
  readonly models: string;
}): Effect.Effect<
  OpenAICompatibleConfig | undefined,
  InvalidOpenAICompatible
> =>
  Effect.gen(function* () {
    const baseUrl = input.baseUrl.trim();
    const text = input.models.trim();
    if (baseUrl === "" && text === "") return undefined;
    if (baseUrl === "" || text === "") {
      return yield* new InvalidOpenAICompatible({
        message:
          baseUrl === ""
            ? "OPENAI_COMPATIBLE_MODELS is set but OPENAI_COMPATIBLE_BASE_URL is not: say where the endpoint is"
            : "OPENAI_COMPATIBLE_BASE_URL is set but OPENAI_COMPATIBLE_MODELS is not: say which model ids it serves",
      });
    }
    if (!/^https?:\/\/[^/\s]+/.test(baseUrl)) {
      return yield* new InvalidOpenAICompatible({
        message: `OPENAI_COMPATIBLE_BASE_URL is "${baseUrl}", which is not an http(s) URL`,
      });
    }
    const models: readonly OpenAICompatibleModel[] = text.startsWith("[")
      ? yield* Schema.decodeEffect(ModelsJson)(text, {
          onExcessProperty: "error",
        }).pipe(
          Effect.mapError(
            (cause) =>
              new InvalidOpenAICompatible({
                message: `OPENAI_COMPATIBLE_MODELS is not a JSON array of {"id", "contextWindow"?, "maxTokens"?, "cost"?}: ${cause.message}`,
              }),
          ),
        )
      : text
          .split(",")
          .map((id) => id.trim())
          .filter((id) => id.length > 0)
          .map((id) => ({ id }));
    const seen = new Set<string>();
    for (const model of models) {
      if (seen.has(model.id)) {
        return yield* new InvalidOpenAICompatible({
          message: `OPENAI_COMPATIBLE_MODELS names ${model.id} twice`,
        });
      }
      seen.add(model.id);
      const prices: readonly (number | undefined)[] = Object.values(
        model.cost ?? {},
      );
      if (prices.some((price) => price !== undefined && price < 0)) {
        return yield* new InvalidOpenAICompatible({
          message: `OPENAI_COMPATIBLE_MODELS prices ${model.id} below zero`,
        });
      }
      if (
        (model.contextWindow !== undefined && model.contextWindow <= 0) ||
        (model.maxTokens !== undefined && model.maxTokens <= 0)
      ) {
        return yield* new InvalidOpenAICompatible({
          message: `OPENAI_COMPATIBLE_MODELS gives ${model.id} a window or answer room that is not positive`,
        });
      }
    }
    if (models.length === 0) {
      return yield* new InvalidOpenAICompatible({
        message: "OPENAI_COMPATIBLE_MODELS names no model",
      });
    }
    return { baseUrl: baseUrl.replace(/\/+$/, ""), models };
  });

/**
 * The provider pi-ai's `Models` registry holds for the endpoint. Each model is pinned to the
 * dialect almost every compatible server speaks — a `system` role rather than OpenAI's `developer`,
 * no `store`, no reasoning effort — because pi-ai's auto-detection reads the host name, and a
 * self-hosted endpoint's host says nothing.
 */
export const openAICompatibleProvider = (
  config: OpenAICompatibleConfig,
): Provider =>
  createProvider({
    id: OPENAI_COMPATIBLE_PROVIDER,
    name: "OpenAI-compatible endpoint",
    baseUrl: config.baseUrl,
    auth: {
      apiKey: {
        name: "OpenAI-compatible endpoint key",
        resolve: ({ ctx }) =>
          ctx.env(OPENAI_COMPATIBLE_KEY_VARIABLE).then((value) => {
            const key = value?.trim();
            return key === undefined || key === ""
              ? {
                  auth: { apiKey: KEYLESS_PLACEHOLDER },
                  source: "keyless endpoint",
                }
              : {
                  auth: { apiKey: key },
                  source: OPENAI_COMPATIBLE_KEY_VARIABLE,
                };
          }),
      },
    },
    models: config.models.map((model) => ({
      id: model.id,
      name: model.id,
      api: "openai-completions" as const,
      provider: OPENAI_COMPATIBLE_PROVIDER,
      baseUrl: config.baseUrl,
      input: ["text" as const],
      reasoning: false,
      contextWindow: model.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
      maxTokens: model.maxTokens ?? DEFAULT_MAX_TOKENS,
      cost: {
        input: model.cost?.input ?? 0,
        output: model.cost?.output ?? 0,
        cacheRead: model.cost?.cacheRead ?? 0,
        cacheWrite: model.cost?.cacheWrite ?? 0,
      },
      compat: {
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
      },
    })),
    api: openAICompletionsApi(),
  });

/**
 * The endpoint as a log line may name it: scheme, host and path, never a `user:password@` part or a
 * query string, which is where a gateway that takes its key in the URL would carry it.
 */
export const describeEndpoint = (baseUrl: string): string => {
  try {
    const url = new URL(baseUrl);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return "(an unreadable URL)";
  }
};
