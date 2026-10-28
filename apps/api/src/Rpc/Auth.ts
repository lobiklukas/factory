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
 * declared, as before this issue; the boot warns. An open control plane is a loopback one: the API
 * binds 127.0.0.1 unless `HOST` says otherwise, and with no token a `HOST` that is not loopback
 * refuses the boot unless `FACTORY_API_AUTH=off` turns auth off on purpose (`bindRefusal`). With
 * either token variable set, every RPC — every group, the `watchSession` stream included — needs
 * `Authorization: Bearer <token>`, and a call without one, or with one the table does not hold,
 * fails with `Unauthenticated` before its handler runs.
 *
 * The table holds SHA-256 digests, not tokens, and a presented token is looked up by its digest, so
 * no comparison runs over the secret itself and nothing kept in memory is a usable credential. A
 * table the boot cannot trust fails the boot: a token shorter than `MIN_TOKEN_CHARS`, one token
 * claimed by two actors, or an actor that is not a `SessionActor` — or is a run's (a session id) or a
 * trigger's (`trigger:<source>`), the two namespaces only the server mints (docs/board.md B5: a run
 * cannot cross a human gate, so a token that read as a run would be refused every gate, and one that
 * read as a trigger would forge a signed delivery's attribution). A refusal names the entry by where
 * it was set (`FACTORY_API_TOKENS entry 2`) and quotes nothing from it, so an entry written the wrong
 * way round (`<token>=amy`) cannot put its token in the boot log.
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
  /** `off`: serve an open control plane on a `HOST` that is not loopback, on purpose. */
  authOff: Config.option(Config.Literals(["off"], "FACTORY_API_AUTH")).pipe(
    Config.map(Option.isSome),
  ),
});
export type ApiAuthConfig =
  typeof ApiAuthConfig extends Config.Config<infer A> ? A : never;

/** A token table the boot refuses, naming the entry and never the token. */
export class InvalidApiTokens extends Schema.TaggedError<InvalidApiTokens>()(
  "InvalidApiTokens",
  { message: Schema.String },
) {}

/** An open control plane (no token) asked to listen beyond loopback without `FACTORY_API_AUTH=off`. */
export class ApiAuthRequired extends Schema.TaggedError<ApiAuthRequired>()(
  "ApiAuthRequired",
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
    const entries: Array<{
      /** Where the entry was set, the only thing a refusal names. */
      readonly source: string;
      readonly actor: string;
      readonly token: string;
    }> = [];
    const shared = Option.getOrElse(
      Option.map(config.token, Redacted.value),
      () => "",
    ).trim();
    if (shared !== "") {
      entries.push({
        source: "FACTORY_API_TOKEN (as FACTORY_API_ACTOR)",
        actor: config.actor,
        token: shared,
      });
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
          source: `FACTORY_API_TOKENS entry ${index + 1}`,
          actor: entry.slice(0, at).trim(),
          token: entry.slice(at + 1).trim(),
        });
      }
    }
    if (entries.length === 0) return undefined;

    const actors = new Map<string, SessionActor>();
    const sources = new Map<string, string>();
    for (const { source, actor, token } of entries) {
      const refusal = actorRefusal(actor);
      if (refusal !== undefined) {
        return yield* new InvalidApiTokens({
          message: `${source}: the actor ${refusal}`,
        });
      }
      if (token.length < MIN_TOKEN_CHARS || /\s/.test(token)) {
        return yield* new InvalidApiTokens({
          message: `${source}: the token must be at least ${MIN_TOKEN_CHARS} characters with no whitespace`,
        });
      }
      const key = digest(token);
      const claimed = sources.get(key);
      if (claimed !== undefined) {
        return yield* new InvalidApiTokens({
          message: `${source} repeats the token of ${claimed}: one token authenticates one actor`,
        });
      }
      actors.set(key, actor);
      sources.set(key, source);
    }
    return { actors };
  });

/** Whether `host` is a loopback address, which nothing off this machine can reach. */
export const isLoopbackHost = (host: string): boolean => {
  const bare = host
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1");
  return (
    bare === "localhost" || bare === "::1" || /^127(\.\d{1,3}){3}$/.test(bare)
  );
};

/**
 * Why the API must not listen on `host` with `table`, or `undefined` when it may (LOB-20). A token
 * table listens anywhere. No table — an open control plane, whose every write records whatever actor
 * its caller declares, a run's or a trigger's included — listens on loopback, or beyond it only when
 * `FACTORY_API_AUTH=off` says so; `off` beside a token is a contradiction the boot refuses too.
 */
export const bindRefusal = (
  table: TokenTable | undefined,
  host: string,
  authOff: boolean,
): ApiAuthRequired | undefined => {
  if (table !== undefined) {
    return authOff
      ? new ApiAuthRequired({
          message:
            "FACTORY_API_AUTH=off contradicts FACTORY_API_TOKEN/FACTORY_API_TOKENS: unset one of them",
        })
      : undefined;
  }
  if (authOff || isLoopbackHost(host)) return undefined;
  return new ApiAuthRequired({
    message: `HOST=${host} is reachable from other machines, and no credential is configured: set FACTORY_API_TOKEN (or FACTORY_API_TOKENS), bind loopback (HOST=127.0.0.1, the default), or set FACTORY_API_AUTH=off to serve every caller unauthenticated on purpose`,
  });
};

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
 * `input` with its `actor` set to the authenticated caller's (LOB-20), or unchanged when auth is off.
 * Every handler whose write records an actor routes its input through here — whether its body may
 * declare one (`createSession`, `decideApproval`, the card writes) or not (`forkSession` and
 * `replaySession`, whose new session is otherwise its source's) — so a body actor reaches the service
 * only on an open control plane, and the rule lives in one place.
 */
export const attributed = <I extends object>(
  input: I,
): Effect.Effect<I & { readonly actor?: SessionActor }, never, Caller> =>
  Effect.gen(function* () {
    const { actor } = yield* Caller;
    return actor === undefined ? input : { ...input, actor };
  });
