/**
 * `bun infra/src/rulesets.ts <plan|apply|verify|probe> --repo owner/name` — the GitHub rulesets of
 * D15 as reviewed code (LOB-30). See `rulesets/policy.ts` for what is declared and why.
 *
 * - `plan` reads the repo's rulesets and prints what `apply` would do. Writes nothing.
 * - `apply` makes the plan's writes, then reads every ruleset back; exits non-zero unless the
 *   read-back is clean.
 * - `verify` is the read-back alone: exits non-zero when a declared ruleset is missing, differs, or
 *   names a bypass actor. `.github/workflows/rulesets.yml` runs it daily against this repository.
 * - `probe` pushes to `factory/ruleset-probe` as the factory's own credential and exits non-zero
 *   unless the forge refuses the force-push and the deletion (`rulesets/probe.ts`).
 *
 * `plan`, `apply` and `verify` call the rulesets API with `GITHUB_RULESETS_TOKEN` — an operator's
 * token with the repository's Administration permission — and refuse to run when it is the
 * factory's own `GITHUB_TOKEN`: the push credential must not be able to edit the boundary it is
 * held by. `probe` pushes with the factory's credential (`GITHUB_TOKEN`, or `GITHUB_APP_*`).
 * `GITHUB_API_URL` points both at another API root, as it does for the rest of the control plane;
 * the git URL is `--url`, `https://github.com/<repo>.git` by default.
 *
 * `--json` prints the result as one JSON object instead of lines, for a drive or a CI job to read.
 */
import { BunRuntime, BunServices } from "@effect/platform-bun";
import {
  Config,
  Console,
  Effect,
  Layer,
  Option,
  Redacted,
  Schema,
} from "effect";
import { Command, Flag } from "effect/cli";
import { FetchHttpClient } from "effect/http";
import { CredentialProviderLive, githubApiUrl } from "@repo/core";
import { RepoSlug } from "@repo/domain/Session";
import { makeRulesetsClient } from "./rulesets/github";
import { rulesetPolicy } from "./rulesets/policy";
import { DEFAULT_PROBE_BRANCH, probeRulesets } from "./rulesets/probe";
import {
  applyPlan,
  planRulesets,
  type RulesetChange,
  verifyRulesets,
} from "./rulesets/reconcile";

/** A refusal the command reports as `error: <code>: <message>` with a non-zero exit. */
class RulesetsCommandError extends Schema.TaggedError<RulesetsCommandError>()(
  "RulesetsCommandError",
  { code: Schema.String, message: Schema.String },
) {}

const RulesetsTokenConfig = Config.all({
  admin: Config.option(Config.Redacted("GITHUB_RULESETS_TOKEN")),
  worker: Config.option(Config.Redacted("GITHUB_TOKEN")),
});

const repoFlag = Flag.String("repo").pipe(
  Flag.withDescription("The repository (owner/name)"),
);
const approvalsFlag = Flag.Int("approvals").pipe(
  Flag.withDescription("Approvals a PR into the default branch requires"),
  Flag.withDefault(1),
);
const jsonFlag = Flag.Boolean("json").pipe(
  Flag.withDescription("Print the result as one JSON object"),
  Flag.withDefault(false),
);

const fail = (code: string, message: string) =>
  Effect.fail(new RulesetsCommandError({ code, message }));

const slugOf = (repo: string) =>
  Option.match(Schema.decodeOption(RepoSlug)(repo), {
    onNone: () => fail("invalid_input", `"${repo}" is not owner/name`),
    onSome: Effect.succeed,
  });

/** The rulesets client for the operator's token, refusing the factory's own. */
const operatorClient = Effect.gen(function* () {
  const tokens = yield* RulesetsTokenConfig;
  const admin = Option.filter(
    tokens.admin,
    (token) => Redacted.value(token).length > 0,
  );
  if (Option.isNone(admin))
    return yield* fail(
      "missing_credential",
      "set GITHUB_RULESETS_TOKEN to an operator token with the repository's Administration permission",
    );
  if (
    Option.isSome(tokens.worker) &&
    Redacted.value(tokens.worker.value) === Redacted.value(admin.value)
  )
    return yield* fail(
      "unsafe_credential",
      "GITHUB_RULESETS_TOKEN is the factory's own GITHUB_TOKEN: the push credential must not be able to edit the rulesets that bind it",
    );
  return yield* makeRulesetsClient({
    apiUrl: githubApiUrl(),
    token: admin.value,
  });
});

const describeChange = (change: RulesetChange): ReadonlyArray<string> => {
  switch (change.action) {
    case "create":
      return [`create  "${change.name}"`];
    case "keep":
      return [`ok      "${change.name}" (id ${change.id})`];
    case "delete":
      return [`delete  "${change.name}" (id ${change.id})`];
    case "update":
      return [
        `update  "${change.name}" (id ${change.id})`,
        ...change.drift.map((line) => `          ${line}`),
      ];
  }
};

const print = (json: boolean, value: unknown, lines: ReadonlyArray<string>) =>
  json
    ? Console.log(JSON.stringify(value, null, 2))
    : Effect.forEach(lines, (line) => Console.log(line), { discard: true });

/** Report a failure the way the factory CLI does — `error: <code>: <message>` — and exit non-zero. */
const reported = <
  A,
  E extends { readonly _tag: string; readonly message: string },
  R,
>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.catch((error) => {
      const code =
        "code" in error && typeof error.code === "string"
          ? error.code
          : error._tag.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
      const where =
        "operation" in error && typeof error.operation === "string"
          ? ` (${error.operation})`
          : "";
      return Console.error(`error: ${code}${where}: ${error.message}`).pipe(
        Effect.andThen(Effect.sync(() => process.exit(1))),
      );
    }),
  );

const planCommand = Command.make(
  "plan",
  {
    repo: repoFlag,
    approvals: approvalsFlag,
    json: jsonFlag,
  },
  Effect.fnUntraced(function* ({ repo, approvals, json }) {
    yield* reported(
      Effect.gen(function* () {
        const slug = yield* slugOf(repo);
        const client = yield* operatorClient;
        const policy = rulesetPolicy({ requiredApprovals: approvals });
        const plan = yield* planRulesets(client, slug, policy);
        yield* print(json, plan, plan.changes.flatMap(describeChange));
      }),
    );
  }),
).pipe(Command.withDescription("Show what apply would change. Writes nothing"));

const applyCommand = Command.make(
  "apply",
  {
    repo: repoFlag,
    approvals: approvalsFlag,
    json: jsonFlag,
  },
  Effect.fnUntraced(function* ({ repo, approvals, json }) {
    yield* reported(
      Effect.gen(function* () {
        const slug = yield* slugOf(repo);
        const client = yield* operatorClient;
        const policy = rulesetPolicy({ requiredApprovals: approvals });
        const plan = yield* planRulesets(client, slug, policy);
        const applied = yield* applyPlan(client, plan, policy);
        const verification = yield* verifyRulesets(client, slug, policy);
        yield* print(json, { applied, verification }, [
          ...applied.map(
            (change) => `${change.action} "${change.name}" (id ${change.id})`,
          ),
          ...(applied.length === 0 ? ["nothing to change"] : []),
          ...verification.findings,
          verification.ok ? "read back: ok" : "read back: FAILED",
        ]);
        if (!verification.ok)
          return yield* fail(
            "ruleset_drift",
            `${verification.findings.length} finding(s) after apply on ${slug}`,
          );
      }),
    );
  }),
).pipe(
  Command.withDescription(
    "Create, update or delete rulesets to match the policy, then read them back",
  ),
);

const verifyCommand = Command.make(
  "verify",
  {
    repo: repoFlag,
    approvals: approvalsFlag,
    json: jsonFlag,
  },
  Effect.fnUntraced(function* ({ repo, approvals, json }) {
    yield* reported(
      Effect.gen(function* () {
        const slug = yield* slugOf(repo);
        const client = yield* operatorClient;
        const verification = yield* verifyRulesets(
          client,
          slug,
          rulesetPolicy({ requiredApprovals: approvals }),
        );
        yield* print(json, verification, [
          ...verification.findings,
          verification.ok
            ? `ok: ${slug} has every declared ruleset, as declared`
            : `FAILED: ${slug}`,
        ]);
        if (!verification.ok)
          return yield* fail(
            "ruleset_drift",
            `${verification.findings.length} finding(s) on ${slug}`,
          );
      }),
    );
  }),
).pipe(
  Command.withDescription(
    "Read the live rulesets back and fail unless they are the declared ones",
  ),
);

const probeCommand = Command.make(
  "probe",
  {
    repo: repoFlag,
    url: Flag.String("url").pipe(
      Flag.withDescription(
        "The git URL to push to (default https://github.com/<repo>.git)",
      ),
      Flag.optional,
    ),
    probeBranch: Flag.String("probe-branch").pipe(
      Flag.withDescription("The factory/ branch the probe pushes to"),
      Flag.withDefault(DEFAULT_PROBE_BRANCH),
    ),
    json: jsonFlag,
  },
  Effect.fnUntraced(function* ({ repo, url, probeBranch, json }) {
    yield* reported(
      Effect.gen(function* () {
        const slug = yield* slugOf(repo);
        const report = yield* probeRulesets({
          repo: slug,
          branch: probeBranch,
          ...Option.match(url, {
            onNone: () => ({}),
            onSome: (value) => ({ url: value }),
          }),
        }).pipe(Effect.provide(CredentialProviderLive));
        yield* print(
          json,
          report,
          report.steps.flatMap((step) => [
            `${step.passed ? "ok  " : "FAIL"}  ${step.step}: expected ${step.expected}, ${step.outcome}${step.ruleViolation ? " by a repository rule (GH013)" : ""}`,
            ...(step.detail.length > 0
              ? step.detail.split("\n").map((line) => `        ${line}`)
              : []),
          ]),
        );
        if (!report.passed)
          return yield* fail(
            "ruleset_not_enforced",
            `the forge did not refuse what the rulesets forbid on ${report.ref}`,
          );
      }),
    );
  }),
).pipe(
  Command.withDescription(
    "Push a force-push and a deletion at a factory/ branch and fail unless the forge refuses both",
  ),
);

const root = Command.make("rulesets").pipe(
  Command.withDescription(
    "The GitHub rulesets the factory's enforcement boundary rests on (D15)",
  ),
  Command.withSubcommands([
    planCommand,
    applyCommand,
    verifyCommand,
    probeCommand,
  ]),
);

root.pipe(
  Command.run({ version: "0.0.0" }),
  Effect.provide(Layer.mergeAll(BunServices.layer, FetchHttpClient.layer)),
  BunRuntime.runMain,
);
