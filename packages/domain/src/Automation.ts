/**
 * Scheduled automations (S-general-automations): work the factory starts on a clock.
 *
 * An automation names a repo, a schedule — a cron expression in a time zone, or one instant (a
 * one-off) — and what its run is told: a prompt, a factory skill, or both, with an optional budget,
 * the column the run starts in and the base ref it is cut from. Each **tick** files one card on the
 * repo's board and opens one run on it, the way a card-mode trigger files a card and `factory board
 * start` starts its run, so an automation's work is reviewed on the board like any other card.
 *
 * **One card per tick.** A tick is its automation and its scheduled instant, and the factory records
 * it before it does anything (`automation_ticks`), so a second process — or this one after a restart
 * — that reaches the same instant answers the recorded tick rather than firing it again. Only the
 * latest instant a schedule has reached is ever fired: a control plane that was down for a day fires
 * one tick when it comes back, not a backlog.
 *
 * **Skip if unchanged.** A scheduled tick reads its base's tip first; when it is the commit the last
 * started tick ran on, the tick is recorded `skipped` with the reason and files nothing. A manual run
 * (`runAutomation`, `factory automation run`) always starts one.
 */
import { Schema } from "effect";
import { SessionId, Timestamp } from "@repo/domain/Ids";
import {
  RepoNotFound,
  RepoSlug,
  SessionActor,
  SessionBudgetCap,
  SessionStatus,
} from "@repo/domain/Session";
import { SkillName } from "@repo/domain/Skill";
import { TaskId } from "@repo/domain/Task";

/** An automation's id: `aut_`, then the shape every factory id has (`packages/core/src/ids.ts`). */
export const AutomationId = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^aut_[0-9abcdefghjkmnpqrstvwxyz]{26}$/)),
  Schema.brand("AutomationId"),
);
export type AutomationId = typeof AutomationId.Type;

/** The longest name an automation takes: a card title is made from it and the tick's instant. */
export const MAX_AUTOMATION_NAME_CHARS = 120;

/** The longest prompt an automation takes: it is the card's body, so the card body's cap. */
export const MAX_AUTOMATION_PROMPT_CHARS = 32_000;

/**
 * What started a tick: the schedule reaching an instant, or a person asking for one now (`manual`,
 * which never skips).
 */
export const AutomationTrigger = Schema.Literals(["schedule", "manual"]);
export type AutomationTrigger = typeof AutomationTrigger.Type;

/**
 * Where a tick got to: `claimed` while it runs, then `started` (a card and a run on it), `skipped`
 * (nothing to do, and the reason says why) or `failed` (the reason is the failure).
 */
export const AutomationTickStatus = Schema.Literals([
  "claimed",
  "started",
  "skipped",
  "failed",
]);
export type AutomationTickStatus = typeof AutomationTickStatus.Type;

/** A tick's run as `session_activity` has it now: whether it is working, and what it has spent. */
export const AutomationTickRun = Schema.Struct({
  status: SessionStatus,
  costTotal: Schema.Finite,
  lastActivityAt: Timestamp,
});
export type AutomationTickRun = typeof AutomationTickRun.Type;

/** One tick of an automation's history. */
export const AutomationTick = Schema.Struct({
  automationId: AutomationId,
  /** The scheduled instant (a manual run's is the moment it was asked for). */
  tickAt: Timestamp,
  trigger: AutomationTrigger,
  status: AutomationTickStatus,
  /** Why it ended where it did, in the factory's words; empty while `claimed`. */
  reason: Schema.String,
  /** The base ref the tick read, and the commit its tip was then, when git could say. */
  baseRef: Schema.optional(Schema.String),
  baseCommit: Schema.optional(Schema.String),
  /** The card the tick filed and the run it opened on it, once it had. */
  taskId: Schema.optional(TaskId),
  sessionId: Schema.optional(SessionId),
  run: Schema.optional(AutomationTickRun),
  claimedAt: Timestamp,
  finishedAt: Schema.optional(Timestamp),
});
export type AutomationTick = typeof AutomationTick.Type;

/** An automation as the factory holds it, with where its schedule is and what its last tick did. */
export const Automation = Schema.Struct({
  id: AutomationId,
  name: Schema.String,
  repo: RepoSlug,
  /** A cron expression (five fields, or six with seconds), read in `timezone`. Absent: a one-off. */
  cron: Schema.optional(Schema.String),
  timezone: Schema.String,
  /** A one-off's instant. Absent: a cron schedule. */
  runAt: Schema.optional(Timestamp),
  /** What the run is told, after the skill's body when there is one; empty when the skill is all. */
  prompt: Schema.String,
  skill: Schema.optional(SkillName),
  budget: Schema.optional(SessionBudgetCap),
  /** The column the run starts in; absent, the card's own (the board's initial column). */
  column: Schema.optional(Schema.String),
  /** The ref the card and its run are cut from; absent, the repo's default base ref. */
  baseRef: Schema.optional(Schema.String),
  skipIfUnchanged: Schema.Boolean,
  enabled: Schema.Boolean,
  /** When it was last enabled: no scheduled instant before it fires. */
  enabledAt: Timestamp,
  createdBy: Schema.String,
  createdAt: Timestamp,
  /** The next instant the schedule fires at; absent when paused, or a one-off that has fired. */
  nextTickAt: Schema.optional(Timestamp),
  lastTick: Schema.optional(AutomationTick),
});
export type Automation = typeof Automation.Type;

/**
 * A new automation. Exactly one of `cron` and `runAt`; at least one of `prompt` and `skill`. A cron
 * expression or a time zone `effect/Cron` cannot read, a `runAt` that has passed, a skill the library
 * does not hold, and a repo with no board are `InvalidAutomation`, naming the field, and nothing is
 * written. `skipIfUnchanged` defaults to on.
 */
export const AddAutomationInput = Schema.Struct({
  repo: RepoSlug,
  /** Absent: the schedule and the first words of the prompt (or the skill). */
  name: Schema.optional(Schema.String),
  cron: Schema.optional(Schema.String),
  /** An IANA zone (`Europe/Prague`); absent, `UTC`. Only a cron schedule reads it. */
  timezone: Schema.optional(Schema.String),
  runAt: Schema.optional(Timestamp),
  prompt: Schema.optional(Schema.String),
  skill: Schema.optional(SkillName),
  budget: Schema.optional(SessionBudgetCap),
  column: Schema.optional(Schema.String),
  baseRef: Schema.optional(Schema.String),
  skipIfUnchanged: Schema.optional(Schema.Boolean),
  /** Set by the control plane from the caller's credential (LOB-20), as a skill put's actor is. */
  actor: Schema.optional(SessionActor),
});
export type AddAutomationInput = typeof AddAutomationInput.Type;

/** Every automation, or one repo's. */
export const ListAutomationsInput = Schema.Struct({
  repo: Schema.optional(RepoSlug),
});
export type ListAutomationsInput = typeof ListAutomationsInput.Type;

export const AutomationIdInput = Schema.Struct({ id: AutomationId });
export type AutomationIdInput = typeof AutomationIdInput.Type;

/** An automation's ticks, newest first: at most `limit` (default 20, at most 200). */
export const ListAutomationTicksInput = Schema.Struct({
  id: AutomationId,
  limit: Schema.optional(
    Schema.Int.pipe(
      Schema.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(200)),
    ),
  ),
});
export type ListAutomationTicksInput = typeof ListAutomationTicksInput.Type;

/** An automation the factory refuses to hold as asked: `field` names what to fix. */
export class InvalidAutomation extends Schema.TaggedError<InvalidAutomation>()(
  "InvalidAutomation",
  { field: Schema.String, message: Schema.String },
) {}

export class AutomationNotFound extends Schema.TaggedError<AutomationNotFound>()(
  "AutomationNotFound",
  { id: Schema.String, message: Schema.String },
) {}

export class AutomationStorageError extends Schema.TaggedError<AutomationStorageError>()(
  "AutomationStorageError",
  { message: Schema.String },
) {}

export type AutomationError =
  | InvalidAutomation
  | AutomationNotFound
  | RepoNotFound
  | AutomationStorageError;

/** Every refusal the automations RPC group answers, on the wire. */
export const AutomationErrorSchema = Schema.Union([
  InvalidAutomation,
  AutomationNotFound,
  RepoNotFound,
  AutomationStorageError,
]);
