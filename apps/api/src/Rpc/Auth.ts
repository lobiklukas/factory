/**
 * The control plane's credential check (LOB-20): the server half of `@repo/domain/Auth`.
 *
 * A deployment configures bearer tokens, each naming the actor it authenticates as:
 *
 * - `FACTORY_API_TOKEN` — one shared token, the whole local setup. It authenticates as
 *   `FACTORY_API_ACTOR` (`operator` unless named). The CLI, the verify drivers and the dashboard
 *   (`VITE_FACTORY_API_TOKEN`) send the same variable's value, so one export runs everything.
 * - `FACTORY_API_TOKENS` — more of them, one per person or service: `amy=<token>,ci=<token>`.
 *
 * With neither set, auth is off: every call is served and a write keeps the actor its caller
 * declared, as before this issue; the boot warns. With either set, every RPC — every group, the
 * `watchSession` stream included — needs `Authorization: Bearer <token>`, and a call without one, or
 * with one the table does not hold, fails with `Unauthenticated` before its handler runs.
 *
 * The table holds SHA-256 digests, not tokens, and a presented token is looked up by its digest, so
 * no comparison runs over the secret itself and nothing kept in memory is a usable credential. A
 * table the boot cannot trust fails the boot: a token shorter than `MIN_TOKEN_CHARS`, one token
 * claimed by two actors, or an actor that is not a `SessionActor` — or is a run's (a session id) or a
 * trigger's (`trigger:<source>`), the two namespaces only the server mints (docs/board.md B5: a run
 * cannot cross a human gate, so a token that read as a run would be refused every gate, and one that
 * read as a trigger would forge a signed delivery's attribution).
 */
import { createHash } from "node:crypto";
import { Caller, ControlPlaneAuth, Unauthenticated } from "@repo/domain/Auth";
import { SessionId } from "@repo/domain/Ids";
import { SessionActor } from "@repo/domain/Session";
import { Config, Effect, Layer, Option, Redacted, Schema } from "effect";
import { Headers } from "effect/http";

/** The shortest token the boot accepts: long enough that guessing one is not a strategy. */
export const MIN_TOKEN_CHARS = 16;

/** Who the shared `FACTORY_API_TOKEN` authenticates as when `FACTORY_API_ACTOR` names nobody. */
export const DEFAULT_SHARED_ACTOR = "operator";

/** The prefix a signed delivery's actor carries (`@repo/core`'s `triggerActorOf`). */
const TRIGGER_ACTOR_PREFIX = "trigger:";

/** What the deployment set, before it is checked. An empty value reads as unset. */
export const ApiAuthConfig = Config.all({
  token: Config.option(Config.Redacted("FACTORY_API_TOKEN")),
  actor: Config.String("FACTORY_API_ACTOR").pipe(
    Config.withDefault(DEFAULT_SHARED_ACTOR),
  ),
  tokens: Config.option(Config.Redacted("FACTORY_API_TOKENS")),
});
export type ApiAuthConfig =
  typeof ApiAuthConfig extends Config.Config<infer A> ? A : never;

/** A token table the boot refuses, naming the entry and never the token. */
export class InvalidApiTokens extends Schema.TaggedError<InvalidApiTokens>()(
  "InvalidApiTokens",
  { message: Schema.String },
) {}

/**
 * The credentials the control plane accepts: each token's SHA-256 digest (hex) and the actor it
 * authenticates as. `undefined` is auth off.
 */
export interface TokenTable {
  readonly actors: ReadonlyMap<string, SessionActor>;
}

const digest = (token: string): string =>
  createHash("sha256").update(token, "utf8").digest("hex");

/** Why `actor` cannot be a credential's, or `undefined` when it can. */
const actorRefusal = (actor: string): string | undefined => {
  if (!Schema.is(SessionActor)(actor)) {
    return "is not a valid actor (blank, padded, a control character, or over 200 characters)";
  }
  if (Schema.is(SessionId)(actor)) {
    return "is a session id, which is a run's actor, never a credential's";
  }
  if (actor.startsWith(TRIGGER_ACTOR_PREFIX)) {
    return "is a trigger's actor (trigger:<source>), which only a signed delivery carries";
  }
  return undefined;
};

/**
 * Check what the deployment set and build the table, or `undefined` when no token is set (auth off).
 * Every refusal names the actor or the entry's position, never the token.
 */
export const tokenTableOf = (
  config: ApiAuthConfig,
): Effect.Effect<TokenTable | undefined, InvalidApiTokens> =>
  Effect.gen(function* () {
    const entries: Array<{ readonly actor: string; readonly token: string }> =
      [];
    const shared = Option.getOrElse(
      Option.map(config.token, Redacted.value),
      () => "",
    ).trim();
    if (shared !== "") {
      entries.push({ actor: config.actor, token: shared });
    }
    const named = Option.getOrElse(
      Option.map(config.tokens, Redacted.value),
      () => "",
    ).trim();
    if (named !== "") {
      const parts = named.split(",");
      for (const [index, raw] of parts.entries()) {
        const entry = raw.trim();
        const at = entry.indexOf("=");
        if (at <= 0 || at === entry.length - 1) {
          return yield* new InvalidApiTokens({
            message: `FACTORY_API_TOKENS entry ${index + 1} is not actor=token`,
          });
        }
        entries.push({
          actor: entry.slice(0, at).trim(),
          token: entry.slice(at + 1).trim(),
        });
      }
    }
    if (entries.length === 0) return undefined;

    const actors = new Map<string, SessionActor>();
    for (const { actor, token } of entries) {
      const refusal = actorRefusal(actor);
      if (refusal !== undefined) {
        return yield* new InvalidApiTokens({
          message: `the API token actor "${actor}" ${refusal}`,
        });
      }
      if (token.length < MIN_TOKEN_CHARS || /\s/.test(token)) {
        return yield* new InvalidApiTokens({
          message: `the API token for "${actor}" must be at least ${MIN_TOKEN_CHARS} characters with no whitespace`,
        });
      }
      const key = digest(token);
      const claimed = actors.get(key);
      if (claimed !== undefined) {
        return yield* new InvalidApiTokens({
          message: `one API token is configured for both "${claimed}" and "${actor}"`,
        });
      }
      actors.set(key, actor);
    }
    return { actors };
  });

/** The boot line: whether calls are authenticated, and as whom — names only, never a token. */
export const describeApiAuth = (table: TokenTable | undefined): string =>
  table === undefined
    ? "control-plane auth: OFF (FACTORY_API_TOKEN and FACTORY_API_TOKENS unset): every RPC is served unauthenticated and a write records the actor its caller declared; set FACTORY_API_TOKEN to require a credential"
    : `control-plane auth: bearer token on every RPC, ${table.actors.size} credential(s) for ${[
        ...new Set(table.actors.values()),
      ].join(", ")}`;

/** Auth off: every call is served, and nobody is authenticated. */
const OPEN = Caller.of({ actor: undefined });

/** The bearer token a call presented, `""` for a malformed header, `undefined` for none. */
const bearerOf = (headers: Headers.Headers): string | undefined =>
  Option.match(Headers.get(headers, "authorization"), {
    onNone: () => undefined,
    onSome: (value) => {
      const match = /^Bearer\s+(\S+)\s*$/i.exec(value);
      return match?.[1] ?? "";
    },
  });

/**
 * `ControlPlaneAuth` over `table`: the middleware every RPC passes through. It provides the
 * authenticated `Caller` to the handler, or fails the call with `Unauthenticated`, logging which RPC
 * was refused and why — never what was presented.
 */
export const controlPlaneAuthLayer = (
  table: TokenTable | undefined,
): Layer.Layer<ControlPlaneAuth> =>
  Layer.succeed(ControlPlaneAuth, (effect, { headers, rpc }) => {
    if (table === undefined) return Effect.provideService(effect, Caller, OPEN);
    const presented = bearerOf(headers);
    const actor =
      presented === undefined || presented === ""
        ? undefined
        : table.actors.get(digest(presented));
    if (actor === undefined) {
      const refusal =
        presented === undefined
          ? new Unauthenticated({
              reason: "missing",
              message:
                "this control plane requires a credential: send Authorization: Bearer <token> (the CLI reads FACTORY_API_TOKEN)",
            })
          : new Unauthenticated({
              reason: "invalid",
              message:
                "the credential sent is not one this control plane accepts",
            });
      return Effect.logWarning(
        `auth: refused ${rpc._tag} (${refusal.reason} credential)`,
      ).pipe(Effect.andThen(Effect.fail(refusal)));
    }
    return Effect.provideService(effect, Caller, Caller.of({ actor }));
  });

/**
 * `input` with its `actor` replaced by the authenticated caller's (LOB-20), or unchanged when auth is
 * off. Every handler whose write records an actor routes its input through here, so a body actor
 * reaches the service only on an open control plane.
 */
export const attributed = <I extends { readonly actor?: string | undefined }>(
  input: I,
): Effect.Effect<I, never, Caller> =>
  Effect.gen(function* () {
    const { actor } = yield* Caller;
    return actor === undefined ? input : { ...input, actor };
  });
