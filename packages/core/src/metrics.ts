import { Effect, Metric } from "effect";

/**
 * The control plane's metric set (LOB-69): what the session service counts, and nothing else yet.
 * `docs/metrics.md` is the operator's copy of this list — a metric added here is added there.
 *
 * Every metric lives in effect's process-wide registry and leaves the process only through an
 * exporter the app wires (`apps/api/src/observability/OtlpMetrics.ts`, on when
 * `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` is set). With none wired, an update is a map write and
 * nothing more, so the service counts unconditionally.
 *
 * Effect carries a metric's unit as its `unit` attribute, which the OTLP exporter reads into the
 * metric's own `unit` field (and also sends as a point attribute: effect does not separate the two).
 * Units are UCUM, as OpenTelemetry's semantic conventions write them: `s`, and `{session}` for a
 * count of things.
 */

/** Why the factory declined a request it understood (`factory.refusals`' `reason`). */
export type RefusalReason =
  /** `sendMessage` over `MAX_MESSAGE_CHARS`: refused before the session is woken. */
  | "message_too_long"
  /** `sendMessage` with `whenBusy: "reject"` while the session runs. */
  | "busy"
  /** A start on a session whose workspace was released (LOB-268). */
  | "released"
  /** A model request stopped by the session's budget (LOB-163). */
  | "budget"
  /** A request that would open one more session than `SESSION_MAX_CONCURRENT` allows (LOB-70). */
  | "at_capacity";

/** How a session came to exist (`factory.session.creates`' `origin`). */
export type SessionOrigin = "create" | "fork" | "replay";

/** Sessions created, by `origin`. A create the request-id dedupe answers is not a create. */
export const SessionCreates = Metric.counter("factory.session.creates", {
  description: "Sessions created, by origin (create, fork, replay)",
  attributes: { unit: "{session}" },
  incremental: true,
});

/**
 * Sessions this process owns right now: an open harness and a held log, from the open that
 * creates or wakes a session to the release that closes it (idle sweep, workspace release,
 * shutdown). A session nobody owns is in the database, not here.
 */
export const SessionsActive = Metric.gauge("factory.session.active", {
  description: "Sessions this process owns (an open harness and a held log)",
  attributes: { unit: "{session}" },
});

/**
 * How long a run took: from the session turning busy to it turning idle again, as its owner's
 * activity projection saw it. A run cut short by the owner's release is not recorded.
 */
export const RunDuration = Metric.histogram("factory.run.duration", {
  description: "Wall time of a run, from the session turning busy to idle",
  attributes: { unit: "s" },
  boundaries: [0.1, 0.5, 1, 5, 15, 30, 60, 120, 300, 600, 1800, 3600],
});

/** Requests the factory understood and declined, by `reason` (`RefusalReason`). */
export const Refusals = Metric.counter("factory.refusals", {
  description: "Requests the factory understood and declined, by reason",
  attributes: { unit: "{refusal}" },
  incremental: true,
});

/** Count one session created by `origin`. */
export const countSessionCreate = (
  origin: SessionOrigin,
): Effect.Effect<void> =>
  Metric.update(Metric.withAttributes(SessionCreates, { origin }), 1);

/** Count one refusal by `reason`. */
export const countRefusal = (reason: RefusalReason): Effect.Effect<void> =>
  Metric.update(Metric.withAttributes(Refusals, { reason }), 1);

/** One more (`1`) or one fewer (`-1`) session owned by this process. */
export const shiftSessionsActive = (delta: 1 | -1): Effect.Effect<void> =>
  Metric.modify(SessionsActive, delta);

/** Record one run's wall time, given in milliseconds. */
export const recordRunDuration = (millis: number): Effect.Effect<void> =>
  Metric.update(RunDuration, millis / 1000);
