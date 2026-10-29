import { Console, Effect, Option, Schema } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import {
  type Automation,
  AutomationId,
  type AutomationTick,
} from "@repo/domain/Automation";
import { RepoSlug, SessionBudgetCap } from "@repo/domain/Session";
import { SkillName } from "@repo/domain/Skill";
import { resolveApiUrl } from "../api";
import { reportFailure, reportFailures } from "../errors";
import { BoardClient } from "../rpc";

/**
 * `factory automation` — a repo's scheduled automations from a terminal (S-general-automations): add
 * one on a cron schedule or at one instant (`add`), list them (`ls`), start one now (`run`), stop and
 * restart the clock (`pause`, `resume`), read what its ticks did (`history`), and remove it (`rm`).
 *
 * Each tick files one card on the repo's board and starts one run on it, so what an automation did is
 * also on the board. A scheduled tick on a base that has not moved since the last run is recorded
 * `skipped` with the reason; `run` never skips.
 */

/** What a field with nothing in it prints, matching `factory repo`. */
export const NONE = "none";

/** What separates `ls` and `history` columns: a tab, so a script reads them with `cut -f`. */
export const AUTOMATION_SEPARATOR = "\t";

export const AUTOMATION_LS_HEADER = [
  "id",
  "name",
  "repo",
  "schedule",
  "state",
  "next",
  "last",
].join(AUTOMATION_SEPARATOR);

/** The schedule as one cell: the cron and its zone, or the one-off's instant. */
export const scheduleCell = (automation: Automation): string =>
  automation.cron !== undefined
    ? `cron "${automation.cron}" ${automation.timezone}`
    : `once ${automation.runAt ?? NONE}`;

/** The last tick as one cell: its status and its instant. */
const lastCell = (tick: AutomationTick | undefined): string =>
  tick === undefined ? NONE : `${tick.status} ${tick.tickAt}`;

/** One `factory automation ls` row. */
export const automationRow = (automation: Automation): string =>
  [
    automation.id,
    automation.name,
    automation.repo,
    scheduleCell(automation),
    automation.enabled ? "enabled" : "paused",
    automation.nextTickAt ?? NONE,
    lastCell(automation.lastTick),
  ].join(AUTOMATION_SEPARATOR);

export const automationLsLines = (
  automations: ReadonlyArray<Automation>,
): ReadonlyArray<string> =>
  automations.length === 0
    ? ["no automations"]
    : [AUTOMATION_LS_HEADER, ...automations.map(automationRow)];

/** What `add`, `pause`, `resume` and `rm` print about an automation: its settings, one per line. */
export const automationLines = (
  verb: string,
  automation: Automation,
): ReadonlyArray<string> => [
  `${verb.padEnd(12)} ${automation.id}`,
  `name         ${automation.name}`,
  `repo         ${automation.repo}`,
  `schedule     ${scheduleCell(automation)}`,
  `state        ${automation.enabled ? "enabled" : "paused"}`,
  `next         ${automation.nextTickAt ?? NONE}`,
  ...(automation.skill === undefined
    ? []
    : [`skill        ${automation.skill}`]),
  ...(automation.prompt === ""
    ? []
    : [`prompt       ${automation.prompt.split("\n")[0] ?? ""}`]),
  ...(automation.budget === undefined
    ? []
    : [`budget       $${automation.budget}`]),
  `column       ${automation.column ?? "the card's own"}`,
  `base         ${automation.baseRef ?? "the repo's default"}`,
  `skip         ${automation.skipIfUnchanged ? "a tick on a base that has not moved since the last run" : "never"}`,
];

/** What `run` prints: the tick as it ended. */
export const tickLines = (tick: AutomationTick): ReadonlyArray<string> => [
  `tick         ${tick.tickAt} (${tick.trigger})`,
  `status       ${tick.status}`,
  ...(tick.taskId === undefined ? [] : [`card         ${tick.taskId}`]),
  ...(tick.sessionId === undefined ? [] : [`run          ${tick.sessionId}`]),
  ...(tick.baseCommit === undefined
    ? []
    : [`base         ${tick.baseRef ?? NONE} at ${tick.baseCommit}`]),
  `reason       ${tick.reason}`,
];

/**
 * Why `factory automation run` exits non-zero: a tick that started no run — `failed`, or `skipped`
 * (the repo has no board) — so a script can tell. `undefined` for a started tick.
 */
export const runRefusal = (
  tick: AutomationTick,
): { readonly code: string; readonly message: string } | undefined =>
  tick.status === "started"
    ? undefined
    : {
        code: `tick_${tick.status}`,
        message: `the tick at ${tick.tickAt} started no run: ${tick.reason}`,
      };

export const AUTOMATION_HISTORY_HEADER = [
  "tick",
  "trigger",
  "status",
  "card",
  "run",
  "run-status",
  "cost",
  "reason",
].join(AUTOMATION_SEPARATOR);

/** One `factory automation history` row: what the tick decided, and its run as it is now. */
export const historyRow = (tick: AutomationTick): string =>
  [
    tick.tickAt,
    tick.trigger,
    tick.status,
    tick.taskId ?? NONE,
    tick.sessionId ?? NONE,
    tick.run?.status ?? NONE,
    tick.run === undefined ? NONE : `$${tick.run.costTotal.toFixed(4)}`,
    tick.reason,
  ].join(AUTOMATION_SEPARATOR);

export const historyLines = (
  ticks: ReadonlyArray<AutomationTick>,
): ReadonlyArray<string> =>
  ticks.length === 0
    ? ["no ticks yet"]
    : [AUTOMATION_HISTORY_HEADER, ...ticks.map(historyRow)];

const apiFlag = Flag.String("api").pipe(
  Flag.withDescription("Control plane base URL"),
  Flag.optional,
);

const idArgument = Argument.String("id").pipe(
  Argument.withDescription("The automation (aut_…)"),
);

/** The id as the domain spells it, or the refusal to print before anything is sent. */
const parseId = (raw: string): AutomationId | undefined =>
  Option.getOrUndefined(Schema.decodeOption(AutomationId)(raw));

/**
 * `factory automation add --repo … (--cron … | --at …) (--prompt … | --skill …)` — a new automation,
 * enabled from now. The server refuses what it could not run (`invalid_automation`, naming the field):
 * an unreadable cron or zone, a one-off in the past, a skill the library lacks, a repo with no board.
 */
const addCommand = Command.make(
  "add",
  {
    repo: Flag.String("repo").pipe(
      Flag.withDescription("The registered repo whose board the cards go on"),
    ),
    cron: Flag.String("cron").pipe(
      Flag.withDescription(
        'A cron schedule: minute hour day month weekday ("0 3 * * 1-5"), or six fields with seconds first',
      ),
      Flag.optional,
    ),
    at: Flag.String("at").pipe(
      Flag.withDescription(
        "One instant instead of a schedule (ISO 8601, 2026-11-02T09:00:00Z)",
      ),
      Flag.optional,
    ),
    tz: Flag.String("tz").pipe(
      Flag.withDescription(
        "The time zone the cron is read in (IANA, default UTC)",
      ),
      Flag.optional,
    ),
    prompt: Flag.String("prompt").pipe(
      Flag.withDescription("What each run is told: the card's body"),
      Flag.optional,
    ),
    skill: Flag.String("skill").pipe(
      Flag.withDescription(
        "A factory skill each run follows; its text opens the card's body",
      ),
      Flag.withSchema(SkillName),
      Flag.optional,
    ),
    name: Flag.String("name").pipe(
      Flag.withDescription(
        "What the automation and its cards are called (default: the prompt's first line)",
      ),
      Flag.optional,
    ),
    budget: Flag.Finite("budget").pipe(
      Flag.withDescription("Each run's spend ceiling, in US dollars"),
      Flag.withSchema(SessionBudgetCap),
      Flag.optional,
    ),
    column: Flag.String("column").pipe(
      Flag.withDescription(
        "The column each run starts in (default: the card's own, the board's first)",
      ),
      Flag.optional,
    ),
    baseRef: Flag.String("base-ref").pipe(
      Flag.withDescription(
        "The ref each card is cut from and each tick reads (default: the repo's default)",
      ),
      Flag.optional,
    ),
    always: Flag.Boolean("always").pipe(
      Flag.withDescription(
        "Run every tick, even when the base has not moved since the last run",
      ),
      Flag.withDefault(false),
    ),
    api: apiFlag,
  },
  Effect.fnUntraced(function* (flags) {
    const apiUrl = yield* resolveApiUrl(flags.api);
    if (!Schema.is(RepoSlug)(flags.repo)) {
      return yield* reportFailure(
        "invalid_input",
        `--repo "${flags.repo}" is not a repo slug (owner/name)`,
      );
    }
    const repo = flags.repo;
    const optional = <A>(value: Option.Option<A>) =>
      Option.getOrUndefined(value);
    const input = {
      repo,
      ...Option.match(flags.cron, {
        onNone: () => ({}),
        onSome: (cron) => ({ cron }),
      }),
      ...Option.match(flags.at, {
        onNone: () => ({}),
        onSome: (runAt) => ({ runAt }),
      }),
      ...Option.match(flags.tz, {
        onNone: () => ({}),
        onSome: (timezone) => ({ timezone }),
      }),
      ...Option.match(flags.prompt, {
        onNone: () => ({}),
        onSome: (prompt) => ({ prompt }),
      }),
      ...(optional(flags.skill) === undefined
        ? {}
        : { skill: optional(flags.skill) }),
      ...Option.match(flags.name, {
        onNone: () => ({}),
        onSome: (name) => ({ name }),
      }),
      ...(optional(flags.budget) === undefined
        ? {}
        : { budget: optional(flags.budget) }),
      ...Option.match(flags.column, {
        onNone: () => ({}),
        onSome: (column) => ({ column }),
      }),
      ...Option.match(flags.baseRef, {
        onNone: () => ({}),
        onSome: (baseRef) => ({ baseRef }),
      }),
      skipIfUnchanged: !flags.always,
    };
    const program = Effect.gen(function* () {
      const { client } = yield* BoardClient;
      const added = yield* client.addAutomation(input);
      for (const line of automationLines("added", added))
        yield* Console.log(line);
    });
    yield* reportFailures(Effect.provide(program, BoardClient.layer(apiUrl)));
  }),
).pipe(
  Command.withDescription(
    "Add an automation: a cron schedule or one instant, each tick a card and a run on the repo's board",
  ),
  Command.withExamples([
    {
      command:
        'factory automation add --repo acme/widgets --cron "0 3 * * *" --prompt "Update the dependencies"',
      description:
        "Every night at 03:00 UTC, unless nothing was merged since the last run",
    },
    {
      command:
        "factory automation add --repo acme/widgets --at 2026-11-02T09:00:00Z --skill triage --budget 2",
      description: "Once, following the triage skill, capped at $2",
    },
  ]),
);

/** `factory automation ls [--repo …]` — every automation, or one repo's. */
const lsCommand = Command.make(
  "ls",
  {
    repo: Flag.String("repo").pipe(
      Flag.withDescription("Only this repo's automations"),
      Flag.optional,
    ),
    api: apiFlag,
  },
  Effect.fnUntraced(function* ({ repo, api }) {
    const apiUrl = yield* resolveApiUrl(api);
    const slug = Option.getOrUndefined(repo);
    if (slug !== undefined && !Schema.is(RepoSlug)(slug)) {
      return yield* reportFailure(
        "invalid_input",
        `--repo "${slug}" is not a repo slug (owner/name)`,
      );
    }
    const program = Effect.gen(function* () {
      const { client } = yield* BoardClient;
      const automations = yield* client.listAutomations(
        slug !== undefined && Schema.is(RepoSlug)(slug) ? { repo: slug } : {},
      );
      for (const line of automationLsLines(automations))
        yield* Console.log(line);
    });
    yield* reportFailures(Effect.provide(program, BoardClient.layer(apiUrl)));
  }),
).pipe(
  Command.withDescription(
    "List the automations: schedule, state, next tick and what the last one did",
  ),
);

/** One `<id>` subcommand: decode the id, call, and print what the call answers. */
const byId = <E>(
  name: string,
  description: string,
  call: (
    id: AutomationId,
  ) => Effect.Effect<ReadonlyArray<string>, E, BoardClient>,
) =>
  Command.make(
    name,
    { id: idArgument, api: apiFlag },
    Effect.fnUntraced(function* ({ id, api }) {
      const apiUrl = yield* resolveApiUrl(api);
      const automationId = parseId(id);
      if (automationId === undefined) {
        return yield* reportFailure(
          "invalid_input",
          `"${id}" is not an automation id (aut_…)`,
        );
      }
      const program = Effect.gen(function* () {
        for (const line of yield* call(automationId)) yield* Console.log(line);
      });
      yield* reportFailures(Effect.provide(program, BoardClient.layer(apiUrl)));
    }),
  ).pipe(Command.withDescription(description));

const runCommand = byId(
  "run",
  "Start one tick now: a card and a run, paused or not, even when the base has not moved; exits non-zero when it started no run",
  (id) =>
    Effect.gen(function* () {
      const { client } = yield* BoardClient;
      const tick = yield* client.runAutomation({ id });
      for (const line of tickLines(tick)) yield* Console.log(line);
      const refused = runRefusal(tick);
      if (refused !== undefined)
        yield* reportFailure(refused.code, refused.message);
      return [];
    }),
);

const pauseCommand = byId(
  "pause",
  "Stop the automation's scheduled ticks (run still starts one)",
  (id) =>
    Effect.gen(function* () {
      const { client } = yield* BoardClient;
      return automationLines("paused", yield* client.pauseAutomation({ id }));
    }),
);

const resumeCommand = byId(
  "resume",
  "Start the scheduled ticks again from now; a tick it slept through does not fire",
  (id) =>
    Effect.gen(function* () {
      const { client } = yield* BoardClient;
      return automationLines("resumed", yield* client.resumeAutomation({ id }));
    }),
);

const rmCommand = byId(
  "rm",
  "Remove the automation and its history; its cards and runs stay on the board",
  (id) =>
    Effect.gen(function* () {
      const { client } = yield* BoardClient;
      return automationLines("removed", yield* client.removeAutomation({ id }));
    }),
);

const showCommand = byId(
  "show",
  "Show one automation's settings and its next tick",
  (id) =>
    Effect.gen(function* () {
      const { client } = yield* BoardClient;
      const automation = yield* client.getAutomation({ id });
      return [
        ...automationLines("automation", automation),
        `last         ${lastCell(automation.lastTick)}`,
      ];
    }),
);

/** `factory automation history <id> [--limit n]` — its ticks, newest first, with each run's state. */
const historyCommand = Command.make(
  "history",
  {
    id: idArgument,
    limit: Flag.Int("limit").pipe(
      Flag.withDescription("At most this many ticks (default 20, at most 200)"),
      Flag.optional,
    ),
    api: apiFlag,
  },
  Effect.fnUntraced(function* ({ id, limit, api }) {
    const apiUrl = yield* resolveApiUrl(api);
    const automationId = parseId(id);
    if (automationId === undefined) {
      return yield* reportFailure(
        "invalid_input",
        `"${id}" is not an automation id (aut_…)`,
      );
    }
    const program = Effect.gen(function* () {
      const { client } = yield* BoardClient;
      const ticks = yield* client.listAutomationTicks({
        id: automationId,
        ...Option.match(limit, {
          onNone: () => ({}),
          onSome: (value) => ({ limit: value }),
        }),
      });
      for (const line of historyLines(ticks)) yield* Console.log(line);
    });
    yield* reportFailures(Effect.provide(program, BoardClient.layer(apiUrl)));
  }),
).pipe(
  Command.withDescription(
    "What an automation's ticks did, newest first: started (card, run, its status and spend), skipped (why) or failed (why)",
  ),
);

export const automationCommand = Command.make("automation").pipe(
  Command.withDescription(
    "Scheduled work: a cron or one-off schedule per repo, each tick a card and a run, skipped when nothing changed",
  ),
  Command.withSubcommands([
    addCommand,
    lsCommand,
    showCommand,
    runCommand,
    pauseCommand,
    resumeCommand,
    historyCommand,
    rmCommand,
  ]),
);
