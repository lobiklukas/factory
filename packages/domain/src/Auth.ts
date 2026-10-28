/**
 * Control-plane identity (LOB-20): who is calling the RPC surface, as the control plane
 * authenticated them rather than as the caller typed them.
 *
 * Every RPC group carries `ControlPlaneAuth`, so the one seam every call — unary or streaming —
 * passes through is this middleware. The server (`apps/api/src/Rpc/Auth.ts`) reads the call's
 * `Authorization: Bearer <token>` header, looks the token up in the table its deployment configured,
 * and either refuses the call with `Unauthenticated` or hands the handler a `Caller` naming the
 * token's actor. A write that records an actor — a session's spend (`sessions.actor`,
 * `factory.actor`), an approval decision, a card's event — records that one, and a body `actor`
 * naming someone else changes nothing. A later identity provider (GitHub OAuth, SSO) is another
 * way of filling the same `Caller`, not a second seam.
 *
 * A deployment that configures no token runs with auth off: no call is refused, `Caller.actor` is
 * `undefined`, and a write keeps the actor its caller declared, as before LOB-20. The boot says so
 * in a warning, so an open control plane is a choice someone can see, not a default nobody noticed.
 *
 * Two actor namespaces are never a token's: a session id is a run's actor (docs/board.md B1, B5)
 * and `trigger:<source>` is a signed delivery's (the trigger's credential is its route's signing
 * secret, checked before any session or card is made). The server refuses a token table that names
 * either, so neither can be claimed over the RPC surface.
 */
import { Context, Schema } from "effect";
import { RpcMiddleware } from "effect/rpc";
import type { SessionActor } from "@repo/domain/Session";

/**
 * A call the control plane refused because it could not say who made it: `missing` when no bearer
 * credential came with it, `invalid` when one did and it names nobody (or is not a bearer token).
 * The message never repeats what was presented.
 */
export class Unauthenticated extends Schema.TaggedError<Unauthenticated>()(
  "Unauthenticated",
  {
    reason: Schema.Literals(["missing", "invalid"]),
    message: Schema.String,
  },
) {}

/** Who made the call being handled. */
export interface CallerShape {
  /**
   * The actor the call's credential authenticated as. `undefined` only when the control plane runs
   * with auth off, where a write keeps the actor its caller declared.
   */
  readonly actor: SessionActor | undefined;
}

/** The authenticated caller of the RPC being handled, provided by `ControlPlaneAuth`. */
export class Caller extends Context.Service<Caller, CallerShape>()(
  "@repo/domain/Caller",
) {}

/**
 * The RPC middleware every group carries: it provides `Caller` to the handler, and its failure,
 * `Unauthenticated`, is part of every call's error channel on the client.
 */
export class ControlPlaneAuth extends RpcMiddleware.Service<
  ControlPlaneAuth,
  { provides: Caller }
>()("@repo/domain/ControlPlaneAuth", { error: Unauthenticated }) {}
