import { Console, Effect, Option, Schema } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { FetchHttpClient, HttpClient } from "effect/http";
import type {
  DeploymentChecks,
  ModelPing,
  RepoCheck,
  ServerInfo,
} from "@repo/domain/Server";
import { RepoCloneFailed, RepoNotFound, RepoSlug } from "@repo/domain/Session";
import type { RepoSummary } from "@repo/domain/Session";
import { resolveApiUrl } from "../api";
import { reportFailure, reportFailures } from "../errors";
import { BoardClient, type BoardRpcClient } from "../rpc";
import { formatDollars } from "../transcript";
import { remedyFor, repoState } from "./repo";

/**
 * `factory doctor` — can this machine turn a task into a PR? (LOB-265, E8)
 *
 * Every prerequisite used to fail only at the step that needed it: a missing GitHub token at the
 * push, a bad base ref at the worktree, a database that was down at the first request. This asks for
 * all of them at once and prints one line per check:
 *
 *     ok|warn|fail <check>: <detail> [-- fix: <what to do>]
 *
 * The first line that is not `ok` is where to start. Nothing printed is a credential: the CLI prints
 * only what the control plane answered, and the control plane answers modes, names, counts and paths
 * (`getServerInfo`, `checkDeployment`), never a value.
 *
 * - `api` is `/readyz`, which is also where `postgres`, `migrations` and `schema` come from; an API
 *   that does not answer ends the run, since nothing else can be asked.
 * - `model`, `model-auth`, `models` read `getServerInfo`: the backend and what chose it, how it
 *   authenticates, and that the default and role models are served. A faux backend is a `warn`.
 * - `repo`, `base-ref`, `config`, `forge` run per registered repo. A repo with only a URL is cloned
 *   now (`syncRepo`), as it always was, because the clone is what says whether it can run.
 * - `webhook`, `trigger-rules` and `env-files` say what the boot read.
 * - `--live` makes one minimal request to the default model (`pingModel`): the only check that
 *   spends, so it is never implied.
 *
 * `factory doctor owner/name` limits the per-repo checks to that repo. The exit is non-zero when any
 * check is `fail`, and when the backend is faux unless `--allow-faux` says that is what is wanted
 * (a drive, a demo, CI). Other warnings are information: the command still exits 0.
 */

export type CheckStatus = "ok" | "warn" | "fail";

/** One verdict: what was checked, what was found, and, unless it is `ok`, how to fix it. */
export type DoctorCheck = {
  readonly status: CheckStatus;
  readonly check: string;
  readonly detail: string;
  readonly fix?: string;
};

const ok = (check: string, detail: string): DoctorCheck => ({
  status: "ok",
  check,
  detail,
});
const warn = (check: string, detail: string, fix: string): DoctorCheck => ({
  status: "warn",
  check,
  detail,
  fix,
});
const fail = (check: string, detail: string, fix: string): DoctorCheck => ({
  status: "fail",
  check,
  detail,
  fix,
});

/** The line a check prints. One line, so `grep '^fail'` is the list of what to fix. */
export const formatCheck = (check: DoctorCheck): string =>
  `${check.status} ${check.check}: ${check.detail}${
    check.fix === undefined ? "" : ` -- fix: ${check.fix}`
  }`;

/** A failure as one short line: its message when it has one, else what it is. */
const reason = (error: unknown): string => {
  const text =
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string" &&
    error.message !== ""
      ? error.message
      : String(error);
  const line = text.split("\n")[0]?.trim() ?? "";
  return line.length > 200 ? `${line.slice(0, 197)}...` : line;
};

// --- the API and its readiness ----------------------------------------------------------------

/** One `/readyz` check as the API reports it. */
type ReadyCheck = {
  readonly name: string;
  readonly ok: boolean;
  readonly error?: string | undefined;
};

/** What asking `/readyz` came to. */
export type Probe =
  | { readonly kind: "unreachable"; readonly message: string }
  | { readonly kind: "unrecognized"; readonly status: number }
  | { readonly kind: "answered"; readonly checks: ReadonlyArray<ReadyCheck> };

const ReadyBody = Schema.Struct({
  checks: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      ok: Schema.Boolean,
      error: Schema.optional(Schema.String),
    }),
  ),
});

/**
 * `GET <api>/readyz`, which answers `200` or `503` with the same body: the database, the migrations
 * and the schema, each by name. Asked over plain HTTP rather than the RPC, so an API whose RPC
 * credential is wrong is still told apart from one that is not running.
 */
export const probeApi = (apiUrl: string): Effect.Effect<Probe> =>
  Effect.gen(function* () {
    const response = yield* HttpClient.get(
      `${apiUrl.replace(/\/+$/, "")}/readyz`,
    );
    const body = yield* response.json.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(ReadyBody)),
      Effect.option,
    );
    return Option.match(body, {
      onNone: () =>
        ({ kind: "unrecognized", status: response.status }) satisfies Probe,
      onSome: ({ checks }) => ({ kind: "answered", checks }) satisfies Probe,
    });
  }).pipe(
    Effect.timeoutOption("5 seconds"),
    Effect.map((answer) =>
      Option.getOrElse(answer, (): Probe => ({
        kind: "unreachable",
        message: "no answer within 5 seconds",
      })),
    ),
    Effect.catch((error) =>
      Effect.succeed<Probe>({ kind: "unreachable", message: reason(error) }),
    ),
    Effect.provide(FetchHttpClient.layer),
  );

const START_API =
  "start the API (bun run dev), or point the CLI at it with --api or FACTORY_API_URL";

const FIX_POSTGRES =
  "docker compose up -d --wait postgres (host port 5442), and check DATABASE_URL";

const READY_FIXES: Readonly<Record<string, string>> = {
  postgres: FIX_POSTGRES,
  migrations: "restart the API: it applies migrations when it boots",
  schema: "restart the API: it applies migrations when it boots",
};

/**
 * The `api` check and the readiness checks under it. `reachable` is false when nothing else can be
 * asked of this URL.
 */
export const apiChecks = (
  apiUrl: string,
  probe: Probe,
): {
  readonly checks: ReadonlyArray<DoctorCheck>;
  readonly reachable: boolean;
} => {
  if (probe.kind === "unreachable") {
    return {
      reachable: false,
      checks: [
        fail("api", `${apiUrl} is not reachable (${probe.message})`, START_API),
      ],
    };
  }
  if (probe.kind === "unrecognized") {
    return {
      reachable: false,
      checks: [
        fail(
          "api",
          `${apiUrl} answered /readyz with HTTP ${probe.status} and not the factory's body`,
          "something else is listening there; check the port and --api",
        ),
      ],
    };
  }
  return {
    reachable: true,
    checks: [
      ok("api", `${apiUrl} reachable`),
      ...probe.checks.map((check) =>
        check.ok
          ? ok(check.name, "ready")
          : fail(
              check.name,
              check.error ?? "failed with no message",
              READY_FIXES[check.name] ??
                "see the API's log (bun run motel for the traces)",
            ),
      ),
    ],
  };
};

// --- the model -----------------------------------------------------------------------------------

const SET_A_MODEL_CREDENTIAL =
  "set ANTHROPIC_API_KEY (see README, Model credentials) and unset MODEL_BACKEND";

/** `faux (selected by MODEL_BACKEND)`: the backend and what chose it. */
const backendDetail = (info: ServerInfo): string => {
  switch (info.selectedBy) {
    case "MODEL_BACKEND":
      return `${info.backend} (selected by MODEL_BACKEND)`;
    case "credential":
      return `${info.backend} (a model credential resolved)`;
    case "no_credential":
      return `${info.backend} (no model credential resolved)`;
  }
};

/** The model checks: the backend, how it authenticates, and that the models a run needs are served. */
export const modelChecks = (info: ServerInfo): ReadonlyArray<DoctorCheck> => {
  const served = new Set(info.models);
  const missing = [
    ...(served.has(info.defaultModel) ? [] : [`default ${info.defaultModel}`]),
    ...info.roleModels
      .filter((row) => !served.has(row.model))
      .map((row) => `${row.role}=${row.model}`),
  ];
  const auth = info.credentialMode.model;
  return [
    info.backend === "faux"
      ? warn(
          "model",
          backendDetail(info),
          `sessions answer from a script, not a model: ${SET_A_MODEL_CREDENTIAL}`,
        )
      : ok("model", backendDetail(info)),
    ...(info.backend === "faux"
      ? []
      : [
          auth === null
            ? fail(
                "model-auth",
                "no credential resolves for the model",
                SET_A_MODEL_CREDENTIAL,
              )
            : ok("model-auth", `${auth.source} (${auth.type})`),
        ]),
    missing.length === 0
      ? ok(
          "models",
          `default ${info.defaultModel}${info.roleModels.map((row) => `, ${row.role}=${row.model}`).join("")}`,
        )
      : fail(
          "models",
          `${missing.join(", ")} not served by this backend`,
          "name a model `factory status` lists under models in DEFAULT_MODEL and ROLE_MODELS",
        ),
  ];
};

// --- what the boot read -----------------------------------------------------------------------

const MISSING_FORGE_CREDENTIAL =
  "set GITHUB_TOKEN, or GITHUB_APP_ID with GITHUB_APP_PRIVATE_KEY and GITHUB_APP_INSTALLATION_ID";

/**
 * The checks of what the boot read: each webhook route, the trigger rules and the env files. The
 * forge credential is here only for a deployment with no repo yet; with repos it is one line each.
 */
export const bootChecks = (
  info: ServerInfo,
  deployment: DeploymentChecks,
  hasRepos: boolean,
): ReadonlyArray<DoctorCheck> => {
  const armed = info.webhooks.some((hook) => hook.armed);
  return [
    ...(hasRepos
      ? []
      : [
          info.credentialMode.forge === "none"
            ? warn(
                "forge",
                "no GitHub credential: a PR cannot be pushed or opened",
                MISSING_FORGE_CREDENTIAL,
              )
            : ok("forge", info.credentialMode.forge),
        ]),
    ...info.webhooks.map((hook) => {
      // The route is the path the receiver listens on; the check is named by its source.
      const source = hook.route.replace(/^\/webhooks\//, "");
      return hook.armed
        ? ok(`webhook ${source}`, `armed (${hook.variable})`)
        : warn(
            `webhook ${source}`,
            `not armed: every delivery is refused (${hook.variable} is unset)`,
            `set ${hook.variable} to arm it, or ignore it if ${source} does not start work here`,
          );
    }),
    deployment.triggerRules > 0
      ? ok("trigger-rules", `${deployment.triggerRules} mapped`)
      : armed
        ? warn(
            "trigger-rules",
            "0 mapped: a delivery matches only the routes stored over RPC",
            "set TRIGGER_RULES, or store a route over the trigger-routes RPC",
          )
        : ok("trigger-rules", "0 mapped (no webhook is armed)"),
    // What a slow install is given before the setup fails (F24): an `ok` either way, because the
    // default is a choice, and the line is there so an operator reads which one is in force.
    ok(
      "setup-timeout",
      `${deployment.setupTimeoutSeconds}s per setup step (SETUP_TIMEOUT_SECONDS)`,
    ),
    ok(
      "env-files",
      deployment.envFiles.length === 0
        ? "none loaded (the environment only)"
        : deployment.envFiles.join(", "),
    ),
  ];
};

// --- the repos -------------------------------------------------------------------------------

/** One repo's verdict: ok, or what is wrong and how to fix it. */
export type RepoDiagnosis =
  | { readonly ok: true; readonly detail: string }
  | { readonly ok: false; readonly detail: string; readonly remedy: string };

/** The verdict for a repo that needs no clone: read off the row the registry answered. */
export const diagnoseRow = (repo: RepoSummary): RepoDiagnosis => {
  if (repo.localPath !== undefined && repo.localPathIsGit)
    return { ok: true, detail: `checkout ${repo.localPath}` };
  if (repo.localPath === undefined && repo.mirrorPath !== undefined)
    return { ok: true, detail: `cloned into ${repo.mirrorPath}` };
  return {
    ok: false,
    detail: repoState(repo),
    remedy: remedyFor(repo),
  };
};

const isCloneFailure = Schema.is(RepoCloneFailed);
const isRepoNotFound = Schema.is(RepoNotFound);

/**
 * Longer than the server's own bounds (a git probe and a token mint per repo; one model request),
 * so a stalled call is named by the server when it can be and by this limit when it cannot.
 */
const CHECK_DEPLOYMENT_SECONDS = 60;
const PING_MODEL_SECONDS = 45;

type Bounded<A> =
  | { readonly _tag: "Success"; readonly success: A }
  | {
      readonly _tag: "Failure";
      readonly failure: {
        readonly message: string;
        readonly timedOut: boolean;
      };
    };

/** A call that is a `Failure` line when it fails or stalls, never a hang: doctor's whole job. */
const bounded = <A, E, R>(
  call: Effect.Effect<A, E, R>,
  seconds: number,
): Effect.Effect<Bounded<A>, never, R> =>
  call.pipe(
    Effect.timeoutOption(`${seconds} seconds`),
    Effect.map((answer): Bounded<A> =>
      Option.isSome(answer)
        ? { _tag: "Success", success: answer.value }
        : {
            _tag: "Failure",
            failure: {
              message: `no answer within ${seconds} seconds`,
              timedOut: true,
            },
          },
    ),
    Effect.catch((error) =>
      Effect.succeed<Bounded<A>>({
        _tag: "Failure",
        failure: { message: reason(error), timedOut: false },
      }),
    ),
  );

/**
 * Can this repo cut a worktree? A URL-only repo is cloned right now, so the answer is the clone's;
 * the row it answers is the one the later checks read (`mirrorPath` exists only after the clone).
 */
const diagnoseRepo = (
  client: DoctorClient,
  repo: RepoSummary,
): Effect.Effect<{
  readonly row: RepoSummary;
  readonly diagnosis: RepoDiagnosis;
}> =>
  repo.localPath === undefined && repo.url !== ""
    ? client.syncRepo({ repo: repo.repo }).pipe(
        Effect.map((row) => ({ row, diagnosis: diagnoseRow(row) })),
        Effect.catch((failed) =>
          Effect.succeed({
            row: repo,
            diagnosis: {
              ok: false,
              detail: isCloneFailure(failed)
                ? `repo_clone_failed (${failed.reason}): ${failed.message}`
                : reason(failed),
              remedy: `fix the URL or the credential, then factory repo sync ${repo.repo}`,
            } satisfies RepoDiagnosis,
          }),
        ),
      )
    : Effect.succeed({ row: repo, diagnosis: diagnoseRow(repo) });

/** The checks for one registered repo: its checkout, base ref, `.factory/config` and forge token. */
export const repoChecks = (
  row: RepoSummary,
  diagnosis: RepoDiagnosis,
  server: RepoCheck | undefined,
): ReadonlyArray<DoctorCheck> => {
  const slug = row.repo;
  return [
    diagnosis.ok
      ? ok(`repo ${slug}`, diagnosis.detail)
      : fail(`repo ${slug}`, diagnosis.detail, diagnosis.remedy),
    // Without a checkout or clone there is nothing to resolve a ref in, and `repo` already said so.
    ...(server === undefined || server.baseRef.status === "no_checkout"
      ? []
      : [
          server.baseRef.status === "ok"
            ? ok(`base-ref ${slug}`, server.baseRef.message)
            : fail(
                `base-ref ${slug}`,
                server.baseRef.message,
                `fetch or push the branch, or register the repo with a base ref that exists: factory repo add ${slug} --base-ref <ref>`,
              ),
        ]),
    // Without a checkout there is no config to read either; `repo` has said what to do.
    ...(diagnosis.ok && row.localPath !== undefined
      ? [
          row.hasFactoryConfig
            ? ok(`config ${slug}`, ".factory/config found")
            : warn(
                `config ${slug}`,
                "no .factory/config: runs have no declared install, build or verify commands",
                `add .factory/config to ${row.localPath}`,
              ),
        ]
      : []),
    ...(server === undefined
      ? []
      : [
          server.forge.status === "ok"
            ? ok(`forge ${slug}`, server.forge.message)
            : server.forge.status === "missing"
              ? warn(
                  `forge ${slug}`,
                  `${server.forge.message}: a PR cannot be pushed or opened`,
                  MISSING_FORGE_CREDENTIAL,
                )
              : fail(
                  `forge ${slug}`,
                  server.forge.message,
                  "check the GitHub App's id, private key and installation id",
                ),
        ]),
  ];
};

// --- the live request ----------------------------------------------------------------------

/** What the one request `--live` sends came to. */
export const liveCheck = (ping: ModelPing): DoctorCheck =>
  ping.ok
    ? ok(
        "live-model",
        `${ping.model} ${ping.message} (${formatDollars(ping.costUsd)}, ${ping.inputTokens} in / ${ping.outputTokens} out, ${ping.latencyMs}ms)`,
      )
    : fail(
        "live-model",
        `${ping.model} refused: ${ping.message}`,
        "check the model credential (model-auth above) and the provider's status",
      );

// --- the run ---------------------------------------------------------------------------------

/** The calls doctor makes of the control plane: a subset of the client, so a test can fake it. */
export type DoctorClient = Pick<
  BoardRpcClient,
  | "getServerInfo"
  | "listRepos"
  | "getRepo"
  | "syncRepo"
  | "checkDeployment"
  | "pingModel"
>;

export type DoctorOptions = {
  readonly apiUrl: string;
  /** Check only this repo; every registered repo when absent. */
  readonly repo: RepoSlug | undefined;
  /** Send the one request that spends. */
  readonly live: boolean;
};

/**
 * Every check, in the order they print. `probe` is what asking `/readyz` came to; the rest is asked
 * of `client`. A failed read is a `fail` line naming what could not be read, never a thrown error:
 * the point of the command is to say what is wrong when something is.
 */
export const collectChecks = (
  client: DoctorClient,
  probe: Probe,
  options: DoctorOptions,
): Effect.Effect<ReadonlyArray<DoctorCheck>> =>
  Effect.gen(function* () {
    const api = apiChecks(options.apiUrl, probe);
    if (!api.reachable) return api.checks;
    const checks: DoctorCheck[] = [...api.checks];

    const info = yield* client.getServerInfo({}).pipe(Effect.result);
    if (info._tag === "Failure") {
      return [
        ...checks,
        fail(
          "server-info",
          reason(info.failure),
          "if the API has auth on, set FACTORY_API_TOKEN to its token",
        ),
      ];
    }
    checks.push(...modelChecks(info.success));

    // The registry is read from Postgres: when it is down, `readyz` has said so above, and the one
    // `repos` line below says what that costs. A slug the registry has no row for is not that: it
    // is a mistyped argument, and restarting the database would not fix it.
    const asked = options.repo;
    const listed = yield* (
      asked === undefined
        ? client.listRepos({}).pipe(Effect.map((out) => out.repos))
        : client.getRepo({ repo: asked }).pipe(Effect.map((row) => [row]))
    ).pipe(Effect.result);
    const notRegistered =
      asked !== undefined &&
      listed._tag === "Failure" &&
      isRepoNotFound(listed.failure);
    const diagnosed =
      listed._tag === "Success"
        ? yield* Effect.forEach(
            listed.success,
            (row) => diagnoseRepo(client, row),
            { concurrency: 4 },
          )
        : [];

    // After the clones, so a base ref is asked of the clone a URL-only repo has just been given.
    const deployment = yield* bounded(
      client.checkDeployment({ repo: asked }),
      CHECK_DEPLOYMENT_SECONDS,
    );
    if (deployment._tag === "Failure") {
      checks.push(
        fail(
          "deployment",
          reason(deployment.failure),
          deployment.failure.timedOut
            ? "the API did not answer: check its logs, and that the forge and the repos' remotes are reachable"
            : "restart the API: it is older than this CLI",
        ),
      );
    } else {
      checks.push(
        ...bootChecks(info.success, deployment.success, diagnosed.length > 0),
      );
    }
    // The per-repo lines do not depend on the server's half: a clone that failed or a checkout that
    // is not git is the operator's answer even when the deployment checks could not run.
    const registryError = notRegistered
      ? undefined
      : listed._tag === "Failure"
        ? reason(listed.failure)
        : deployment._tag === "Success"
          ? deployment.success.reposError
          : undefined;
    if (notRegistered) {
      checks.push(
        fail(
          `repo ${asked}`,
          "not registered",
          `factory repo add ${asked} --path <dir> | --url <url>`,
        ),
      );
    }
    if (registryError !== undefined) {
      checks.push(
        fail(
          "repos",
          `the registry could not be read: ${registryError}`,
          FIX_POSTGRES,
        ),
      );
    }
    const byRepo = new Map(
      deployment._tag === "Success"
        ? deployment.success.repos.map((row) => [row.repo, row])
        : [],
    );
    for (const { row, diagnosis } of diagnosed) {
      checks.push(...repoChecks(row, diagnosis, byRepo.get(row.repo)));
    }
    if (listed._tag === "Success" && listed.success.length === 0) {
      checks.push(
        ok(
          "repos",
          "none registered (the first session that names a repo registers it)",
        ),
      );
    }

    if (options.live) {
      const ping = yield* bounded(client.pingModel({}), PING_MODEL_SECONDS);
      checks.push(
        ping._tag === "Success"
          ? liveCheck(ping.success)
          : fail(
              "live-model",
              reason(ping.failure),
              ping.failure.timedOut
                ? "check the provider's status and this machine's route to it"
                : "restart the API: it is older than this CLI",
            ),
      );
    }
    return checks;
  });

/** What the checks add up to: how many of each, and whether the backend is one the caller refused. */
export const verdict = (
  checks: ReadonlyArray<DoctorCheck>,
  allowFaux: boolean,
): {
  readonly failed: number;
  readonly warned: number;
  readonly fauxRefused: boolean;
} => ({
  failed: checks.filter((check) => check.status === "fail").length,
  warned: checks.filter((check) => check.status === "warn").length,
  // The one warning that fails the command: every answer a faux backend gives is a script's, so a
  // doctor that exited 0 on it would call a deployment ready that cannot do the job.
  fauxRefused:
    !allowFaux &&
    checks.some((check) => check.check === "model" && check.status === "warn"),
});

const doctorCommand = Command.make(
  "doctor",
  {
    repo: Argument.String("repo").pipe(
      Argument.withDescription("Check only this repository (owner/name)"),
      Argument.optional,
    ),
    api: Flag.String("api").pipe(
      Flag.withDescription("Control plane base URL"),
      Flag.optional,
    ),
    allowFaux: Flag.Boolean("allow-faux").pipe(
      Flag.withDescription(
        "Exit 0 on a faux model backend (a drive or demo that wants one)",
      ),
      Flag.withDefault(false),
    ),
    live: Flag.Boolean("live").pipe(
      Flag.withDescription(
        "Also send one minimal request to the default model (this spends)",
      ),
      Flag.withDefault(false),
    ),
  },
  Effect.fnUntraced(function* ({ repo: only, api, allowFaux, live }) {
    const asked = Option.getOrUndefined(only);
    const slug =
      asked === undefined
        ? undefined
        : Option.getOrUndefined(Schema.decodeOption(RepoSlug)(asked));
    if (asked !== undefined && slug === undefined)
      return yield* reportFailure(
        "invalid_input",
        `"${asked}" is not a repository (owner/name)`,
      );
    const apiUrl = yield* resolveApiUrl(api);

    const program = Effect.gen(function* () {
      const probe = yield* probeApi(apiUrl);
      const { client } = yield* BoardClient;
      const checks = yield* collectChecks(client, probe, {
        apiUrl,
        repo: slug,
        live,
      });
      for (const check of checks) {
        yield* Console.log(formatCheck(check));
      }
      const { failed, warned, fauxRefused } = verdict(checks, allowFaux);
      yield* Console.log(
        `doctor: ${failed} failed, ${warned} warning${warned === 1 ? "" : "s"}`,
      );
      if (failed > 0) {
        return yield* reportFailure(
          "doctor_failed",
          `${failed} of ${checks.length} checks failed`,
        );
      }
      if (fauxRefused) {
        return yield* reportFailure(
          "doctor_faux",
          "the model backend is faux; pass --allow-faux if that is what you want",
        );
      }
    });

    yield* reportFailures(Effect.provide(program, BoardClient.layer(apiUrl)));
  }),
).pipe(
  Command.withDescription(
    "Check that this machine can turn a task into a PR, and say what to fix when it cannot",
  ),
  Command.withExamples([
    {
      command: "factory doctor",
      description: "Every prerequisite, one line each; non-zero on a fail",
    },
    {
      command: "factory doctor --allow-faux",
      description: "The same, accepting a scripted model (a drive or a demo)",
    },
    {
      command: "factory doctor --live",
      description: "Also make one minimal real model request (spends)",
    },
  ]),
);

export { doctorCommand };
