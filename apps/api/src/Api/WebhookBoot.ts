/* oxlint-disable effecttsgo/process-env effecttsgo/process-env-in-effect */
/**
 * What the process says about its trigger configuration at boot (LOB-266).
 *
 * Two things used to surface only as "every delivery skipped" or "every delivery 503": a typo in
 * `TRIGGER_RULES` and a missing webhook secret. The first answered `skipped, no rule matches` for
 * every delivery, and the second `503 not-configured`; an operator found out from the sender's
 * dashboard. Now the boot says both, once, where the operator is already looking:
 *
 * - `trigger rules: N (label→repo, …)` names what `TRIGGER_RULES` mapped, or, for a value that does
 *   not decode, an error naming the variable and the decode message. A malformed value **refuses
 *   the boot** (`InvalidTriggerRules`): the old "empty rather than fatal" kept the API up and made
 *   the typo invisible, and a stored route is now the way to route without this variable, so an
 *   operator who set one and got it wrong wants to hear that before the first delivery, not after.
 *   An unset or blank variable is not malformed: it is no fallback rules, which is a valid choice.
 * - one line per webhook route: `armed`, or `unarmed: <VAR> unset`. The route answers every delivery
 *   `503` while unarmed (`handle`'s secret check), so this is the same fact stated before a sender
 *   hits it. Only whether a secret is set is logged, never its value.
 *
 * - `sentry filter: …` names what `SENTRY_MIN_LEVEL`, `SENTRY_ENVIRONMENTS` and `SENTRY_RELEASES`
 *   admit (LOB-82), or, for a level that is not a Sentry level, an error naming the variable. The
 *   route reads the filter per delivery and answers `503` while it does not parse; this line says so
 *   before the first alert does. It does not refuse the boot: the other routes are unaffected.
 *
 * Pure `describe…` functions build the lines so a test names them exactly; `logTriggerBoot` is the
 * effect `index.ts` runs. Both read the environment through the `env` they are given, so a test
 * does not mutate the process's.
 */
import { ENV_RULES_ORIGIN, sentryFilterFromEnv } from "@repo/core";
import { ruleName, TriggerRules, type TriggerRule } from "@repo/domain/Trigger";
import { Effect, Schema } from "effect";

/** The variable the fallback rules come from. */
export const TRIGGER_RULES_VARIABLE = "TRIGGER_RULES";

/** The environment these functions read: `process.env` in production, a record in a test. */
export type Env = Readonly<Record<string, string | undefined>>;

/**
 * `TRIGGER_RULES` is set and does not decode: not JSON, not an array, or an entry that is not a rule
 * (a label that is not a string, no repo, a repo that is not `owner/name`). `message` carries the
 * decode message and the variable's name.
 */
export class InvalidTriggerRules extends Schema.TaggedError<InvalidTriggerRules>()(
  "InvalidTriggerRules",
  { variable: Schema.String, message: Schema.String },
) {}

/**
 * `TRIGGER_RULES` as the fallback rules: unset or blank is none; a JSON array of rules is those; a
 * value that is neither is `InvalidTriggerRules` naming the variable and why.
 */
export const readTriggerRules = (
  env: Env,
): Effect.Effect<ReadonlyArray<TriggerRule>, InvalidTriggerRules> => {
  const raw = env[TRIGGER_RULES_VARIABLE];
  if (raw === undefined || raw.trim() === "") return Effect.succeed([]);
  // Every fault, not the first: an operator fixing a typo should not need a boot per entry.
  return Schema.decodeEffect(Schema.fromJsonString(TriggerRules))(raw, {
    errors: "all",
  }).pipe(
    Effect.mapError(
      (cause) =>
        new InvalidTriggerRules({
          variable: TRIGGER_RULES_VARIABLE,
          message: `${TRIGGER_RULES_VARIABLE} is not a valid rule list: ${cause.message}`,
        }),
    ),
    // `createdAfter: "enabled"` is a stored route's own creation (S-trigger-trust-gating); an env
    // rule has no such instant, and the seam would refuse every delivery through it. Said at boot,
    // with the fix, rather than as a skip per delivery.
    Effect.flatMap((rules) => {
      const index = rules.findIndex(
        (rule) => rule.trust?.createdAfter === "enabled",
      );
      return index === -1
        ? Effect.succeed(rules)
        : Effect.fail(
            new InvalidTriggerRules({
              variable: TRIGGER_RULES_VARIABLE,
              message: `${TRIGGER_RULES_VARIABLE}[${index}] sets trust.createdAfter to "enabled", which only a stored route has (its creation); give the instant the rule was enabled instead, like "2026-10-28T00:00:00Z"`,
            }),
          );
    }),
  );
};

/** `trigger rules: 2 (factory→acme/widgets, team ENG→acme/api card)`: a card rule says so (LOB-254). */
export const describeTriggerRules = (
  rules: ReadonlyArray<TriggerRule>,
): string =>
  `trigger rules: ${rules.length}${
    rules.length === 0
      ? ""
      : ` (${rules.map((rule) => `${ruleName(rule)}→${rule.repo}${rule.mode === "card" ? " card" : ""}`).join(", ")})`
  } from ${ENV_RULES_ORIGIN}; stored routes are read per delivery and win over them`;

/**
 * Every inbound webhook route and the variable that arms it. A route whose variable is unset or blank
 * refuses every delivery `503` (`Webhook.ts`'s `handle`, `GitHubWebhook.ts`), so this table is what
 * the boot reports and what a new route adds a row to.
 */
export const WEBHOOK_ROUTES: ReadonlyArray<{
  readonly route: string;
  readonly variable: string;
}> = [
  { route: "/webhooks/linear", variable: "LINEAR_WEBHOOK_SECRET" },
  { route: "/webhooks/generic", variable: "TRIGGER_SECRET" },
  { route: "/webhooks/sentry", variable: "SENTRY_CLIENT_SECRET" },
  { route: "/webhooks/github", variable: "GITHUB_WEBHOOK_SECRET" },
  { route: "/webhooks/jira", variable: "JIRA_WEBHOOK_SECRET" },
  { route: "/webhooks/slack", variable: "SLACK_SIGNING_SECRET" },
];

/** One line per route: `webhook /webhooks/linear: armed` or `…: unarmed: LINEAR_WEBHOOK_SECRET unset`. */
export const describeWebhookRoutes = (env: Env): ReadonlyArray<string> =>
  WEBHOOK_ROUTES.map(({ route, variable }) => {
    const set = (env[variable] ?? "") !== "";
    return `webhook ${route}: ${set ? "armed" : `unarmed: ${variable} unset`}`;
  });

/**
 * `sentry filter: level ≥ error, environments [production], releases any`, or the error that the
 * Sentry route answers every delivery with while the filter does not parse.
 */
export const describeSentryFilter = (
  env: Env,
): { readonly ok: boolean; readonly line: string } => {
  const read = sentryFilterFromEnv(env);
  if (!read.ok) {
    return {
      ok: false,
      line: `sentry filter: ${read.message}; /webhooks/sentry answers 503 not-configured until it is fixed`,
    };
  }
  const { minLevel, environments, releases } = read.filter;
  const list = (entries: ReadonlyArray<string> | undefined) =>
    entries === undefined ? "any" : `[${entries.join(", ")}]`;
  return {
    ok: true,
    line: `sentry filter: level ${minLevel === undefined ? "any" : `>= ${minLevel}`}, environments ${list(environments)}, releases ${list(releases)}`,
  };
};

/**
 * Read `TRIGGER_RULES`, say what it mapped (or why it did not decode), say which webhook routes are
 * armed, and answer the rules. A malformed value is logged at error level with the decode message and
 * then fails the boot; the log line is what an operator greps, and the failure is what stops the API.
 */
export const logTriggerBoot = (
  env: Env,
): Effect.Effect<ReadonlyArray<TriggerRule>, InvalidTriggerRules> =>
  Effect.gen(function* () {
    const rules = yield* readTriggerRules(env).pipe(
      Effect.tapError((error) => Effect.logError(error.message)),
    );
    yield* Effect.logInfo(describeTriggerRules(rules));
    for (const line of describeWebhookRoutes(env)) {
      // An unarmed route is a configuration the operator may have chosen, but it is also the one
      // that answers every delivery `503`; a warning is what stands out from the armed ones.
      yield* line.includes("unarmed")
        ? Effect.logWarning(line)
        : Effect.logInfo(line);
    }
    const sentry = describeSentryFilter(env);
    yield* sentry.ok
      ? Effect.logInfo(sentry.line)
      : Effect.logError(sentry.line);
    return rules;
  });

/**
 * The live environment, for `index.ts`: the rules variable, every route's secret and the Sentry
 * filter (LOB-82), each read by name. A read through a variable (`process.env[name]`) is invisible
 * to the scan that keeps `apps/api/turbo.json` declaring everything the API reads (LOB-257), so
 * every name is a literal here, and `WebhookBoot.test.ts` checks the snapshot covers every row of
 * `WEBHOOK_ROUTES`.
 */
export const bootEnvFromProcess = (): Env => ({
  TRIGGER_RULES: process.env["TRIGGER_RULES"],
  LINEAR_WEBHOOK_SECRET: process.env["LINEAR_WEBHOOK_SECRET"],
  TRIGGER_SECRET: process.env["TRIGGER_SECRET"],
  SENTRY_CLIENT_SECRET: process.env["SENTRY_CLIENT_SECRET"],
  GITHUB_WEBHOOK_SECRET: process.env["GITHUB_WEBHOOK_SECRET"],
  JIRA_WEBHOOK_SECRET: process.env["JIRA_WEBHOOK_SECRET"],
  SLACK_SIGNING_SECRET: process.env["SLACK_SIGNING_SECRET"],
  SENTRY_MIN_LEVEL: process.env["SENTRY_MIN_LEVEL"],
  SENTRY_ENVIRONMENTS: process.env["SENTRY_ENVIRONMENTS"],
  SENTRY_RELEASES: process.env["SENTRY_RELEASES"],
});

export const logTriggerBootFromProcess = Effect.suspend(() =>
  logTriggerBoot(bootEnvFromProcess()),
);
