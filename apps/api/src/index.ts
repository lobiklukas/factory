import { BunHttpServer, BunRuntime, BunServices } from "@effect/platform-bun";
import {
  backfillSessionModels,
  CredentialConfig,
  CredentialProvider,
  CredentialProviderLive,
  DEFAULT_DIFF_CAP,
  githubReviewPoster,
  gitRepoMirror,
  gitRepoRemote,
  PlanFreshnessPassesLive,
  ReviewerCredentialConfig,
  selectReviewerCredentialProvider,
  runDocsSchedule,
  SessionService,
  SessionServiceLive,
} from "@repo/core";
import { Api } from "@repo/domain/Api";
import {
  RepoSlug,
  SessionBudgetCap,
  type SessionError,
} from "@repo/domain/Session";
import {
  createModelAccess,
  DEFAULT_AUTONOMY,
  FAUX_COMMAND,
  FAUX_MODEL_ID,
  modelKey,
  parseFauxModelScripts,
  parseRoleModels,
  resolveRoleModels,
  resolveDefaultModel,
  REVIEW_ROLES,
} from "@repo/harness";
import { MigrationsLive, PostgresLive } from "@repo/storage-postgres";
import {
  Cause,
  Config,
  Effect,
  Exit,
  Layer,
  Option,
  Redacted,
  Schema,
} from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpRouter,
  HttpServer,
} from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { HealthGroupLive } from "./Api/Health";
import { webhookLiveFor } from "./Api/Webhook";
import {
  bootEnvFromProcess,
  logTriggerBootFromProcess,
} from "./Api/WebhookBoot";
import { TriggerCheckoutLog } from "./TriggerCheckouts";
import { GitHubWebhookLive } from "./Api/GitHubWebhook";
import {
  linearConfig,
  LinearIssueSyncLayer,
  LinearSyncLog,
  ProposalTrackerLive,
} from "./Api/LinearSync";
import {
  SessionWriteBacksLive,
  TriggerAdaptersLog,
} from "./Api/TriggerAdapters";
import { ProbesLive } from "./Api/Probes";
import { NotifierDaemon } from "./Notifications";
import { SessionRpcLive } from "./Rpc/Session";
import {
  ApiAuthConfig,
  bindRefusal,
  controlPlaneAuthLayer,
  describeApiAuth,
  tokenTableOf,
} from "./Rpc/Auth";
import { ServerFacts, webhookRouteStates } from "./ServerInfo";
import { describeLoadedEnvFiles, loadedEnvFiles } from "./EnvFiles";
import {
  DEFAULT_SANDBOX_RUNTIME,
  describeSandboxRuntime,
  SandboxRuntimeConfig,
  selectSandboxRuntime,
} from "./Sandbox";
import {
  describeModelBackend,
  modelBackendWarnings,
  selectModelBackend,
} from "./ModelBackend";
import { DevToolsLive } from "./observability/DevTools";
import { MotelLive } from "./observability/Motel";
import { OtlpMetricsLive } from "./observability/OtlpMetrics";

/**
 * Cap on an HTTP request body, in bytes (LOB-21). The largest legitimate request here is an RPC
 * `sendMessage`: the service refuses a message over `MAX_MESSAGE_CHARS` (100,000 characters), which
 * is at most ~400 KB of UTF-8 plus JSON framing, so 1 MiB carries every legal request with
 * headroom. Bun's own default is 128 MiB — 128× larger, and enough for one unauthenticated upload
 * to exhaust the process.
 */
const DEFAULT_MAX_REQUEST_BODY_BYTES = 1_048_576;

/** How long to wait before retrying a failed migration sweep (LOB-21). */
const MIGRATION_RETRY_MS = 3_000;

export const ServerConfig = Config.all({
  port: Config.Number("PORT").pipe(Config.withDefault(9000)),
  /**
   * Loopback unless a deployment says otherwise (LOB-20): a control plane with no token serves every
   * caller, so it listens beyond this machine only with a token or `FACTORY_API_AUTH=off`
   * (`./Rpc/Auth`'s `bindRefusal`).
   */
  hostname: Config.String("HOST").pipe(Config.withDefault("127.0.0.1")),
  idleTimeout: Config.Number("IDLE_TIMEOUT").pipe(Config.withDefault(120)),
  allowedOrigins: Config.String("ALLOWED_ORIGINS").pipe(
    Config.withDefault("http://localhost:3000"),
  ),
  /** Bounds one request; Bun's own default is 128 MiB (LOB-21). */
  maxRequestBodySize: Config.Number("MAX_REQUEST_BODY_BYTES").pipe(
    Config.withDefault(DEFAULT_MAX_REQUEST_BODY_BYTES),
  ),
});

/**
 * How large a session's diff may be before the PR step opens nothing (LOB-227).
 *
 * Two keys with the control plane's own defaults, so an unconfigured deployment still has a bound
 * and one that wants a different one can set it without a rebuild. Read here rather than in
 * `@repo/core` because that is where every other deployment setting is read; the step itself takes
 * the resolved values.
 */
const PrCapConfig = Config.all({
  maxFiles: Config.Int("PR_CAP_MAX_FILES").pipe(
    Config.withDefault(DEFAULT_DIFF_CAP.maxFiles),
  ),
  maxLines: Config.Int("PR_CAP_MAX_LINES").pipe(
    Config.withDefault(DEFAULT_DIFF_CAP.maxLines),
  ),
});

/**
 * Which commands need a person's approval before they run (D15, LOB-52).
 *
 * `APPROVAL_REQUIRED` is a comma-separated list of command prefixes — `npm publish,terraform apply`
 * — matched against each simple command a `bash` call runs. Empty by default: a gate is a
 * deployment's choice, and an ungated deployment is the boundary D11 already draws. Every other
 * autonomy rule keeps D11's defaults.
 *
 * A gate's first word is a command name (`/usr/bin/npm` gates as `npm`), and flags may sit between
 * its words (`npm --registry x publish`, `terraform -chdir=infra apply`); `sudo`, `env`, `timeout`,
 * `xargs`, compound keywords and `sh -c '…'` are read through. A gate is a prompt, not a boundary
 * (D15): it does not see a command spelled through a variable, an alias, `eval`, a script that runs
 * it, or another interpreter. One approval covers one run of the call it names; the next identical
 * call asks again. A denial stands for that exact call for the rest of the session.
 */
const ApprovalGateConfig = Config.String("APPROVAL_REQUIRED").pipe(
  Config.withDefault(""),
  Config.map((value) => ({
    ...DEFAULT_AUTONOMY,
    approvalRequired: value
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  })),
);

/**
 * Which model a session runs against.
 *
 * `MODEL_BACKEND` wins when set. Otherwise a credential decides (`./ModelBackend`, LOB-258): the real
 * provider when pi-ai resolves any credential it accepts, its deterministic faux provider when none
 * does, so a checkout with no key still boots and a session still runs end to end — it just reports
 * that it is not talking to a model. The credentials themselves are never read here: pi-ai reads
 * them, and the boot line names the variable that authenticated, never its value.
 */
const ModelConfig = Config.all({
  backend: Config.option(
    Config.Literals(["anthropic", "faux"], "MODEL_BACKEND"),
  ),
  /** What the faux script runs. A verification run scripts a command that sleeps. */
  fauxCommand: Config.String("FAUX_COMMAND").pipe(
    Config.withDefault(FAUX_COMMAND),
  ),
  /**
   * Whether the faux script calls `FAUX_COMMAND` on every turn rather than the first: a run that
   * retries a gated call after its approval (LOB-52).
   */
  fauxEveryTurn: Config.Boolean("FAUX_EVERY_TURN").pipe(
    Config.withDefault(false),
  ),
  /**
   * The question the faux script asks with the `ask` tool (LOB-73). Unset, the script never asks: a
   * verification that proves the parked run (`.pi/skills/verify-board/ask.sh`) sets it.
   */
  fauxAsk: Config.option(Config.String("FAUX_ASK")),
  /**
   * The `spec` calls the faux script makes when a run is offered the tool (LOB-238): a JSON array of
   * the tool's arguments, tried in order until one is accepted. Unset, the script never specs; a
   * verification that proves the specifier's spec (`.pi/skills/verify-board/drive.sh`) sets it. A
   * value that is not a JSON array of objects fails the boot.
   */
  fauxSpec: Config.option(
    Config.schema(
      Schema.fromJsonString(
        Schema.Array(Schema.Record(Schema.String, Schema.MutableJson)),
      ),
      "FAUX_SPEC",
    ),
  ),
  /**
   * The answer the faux model gives a decomposition (LOB-201), verbatim: a `{"proposals": [...]}`
   * object. Unset, it derives one proposal per criterion and no edges; a verification that proves
   * `approveProposals` creates the `blockedBy` relations
   * (`.pi/skills/verify-api/approve-proposals.sh`) scripts edges here.
   */
  fauxDecomposition: Config.option(Config.String("FAUX_DECOMPOSITION")),
  fauxPlanFreshness: Config.option(Config.String("FAUX_PLAN_FRESHNESS")),
  /**
   * The `review` calls the faux script makes, in order (LOB-36's `fauxReview`): a JSON array of the
   * tool's arguments, each sent only when the one before it was refused. Unset: the faux never
   * reviews. A value that is not a JSON array of objects fails the boot.
   */
  fauxReview: Config.option(
    Config.schema(
      Schema.fromJsonString(
        Schema.Array(Schema.Record(Schema.String, Schema.MutableJson)),
      ),
      "FAUX_REVIEW",
    ),
  ),
  /**
   * What each faux request costs, in US dollars (LOB-163). pi-ai's faux reports no cost, so a capped
   * session on it could never reach its cap; a verification that proves the cap
   * (`.pi/skills/verify-api/budget.sh`) prices it. `0` by default: free, as before.
   */
  fauxCost: Config.Finite("FAUX_COST").pipe(Config.withDefault(0)),
  /**
   * Whether the faux script calls `verify` after its `bash` turn (LOB-78's `fauxVerify`). Off by
   * default; `.pi/skills/verify-board/requires.sh` sets it so a run on a card records the evidence
   * a column's `verified` requirement checks (LOB-80).
   */
  fauxVerify: Config.Boolean("FAUX_VERIFY").pipe(Config.withDefault(false)),
  /**
   * How long the sleeping faux script naps before each step of a turn, in milliseconds (LOB-167): a
   * run that is busy long enough for a steer, a follow-up, or a refused `whenBusy: "reject"` to
   * arrive while it is in flight (`.pi/skills/verify-cli/steer.sh`). `0`: the script answers at once.
   */
  fauxSleepMs: Config.Int("FAUX_SLEEP_MS").pipe(Config.withDefault(0)),
  /**
   * A faux script per model id (LOB-86): `{"builder": {"command": "…", "verify": true}}`. With
   * `ROLE_MODELS=builder=faux/builder`, a run in a `builder` column writes, commits and verifies a
   * change while every other run keeps `FAUX_COMMAND` — what `.pi/skills/verify-board/drive.sh`
   * needs to take one card from a read-only specify run to a PR. A row for a model the faux backend
   * does not publish fails the boot (`parseFauxModelScripts`). Empty: every model runs one script.
   */
  fauxModelScripts: Config.String("FAUX_MODEL_SCRIPTS").pipe(
    Config.withDefault(""),
  ),
  sessionRoot: Config.String("SESSION_ROOT").pipe(
    Config.withDefault(".factory/sessions"),
  ),
  idleTimeoutMs: Config.Int("SESSION_IDLE_TIMEOUT_MS").pipe(
    Config.withDefault(15 * 60_000),
  ),
});

/**
 * Which model each board role runs (docs/board.md B6, LOB-207).
 *
 * `ROLE_MODELS` is a comma-separated list of `role=provider/modelId` —
 * `specifier=anthropic/claude-haiku-4-5,reviewer=anthropic/claude-opus-4-5` — and a role with no
 * row, like a session with no card, runs the deployment's default model. It is resolved against the
 * backend's catalog at boot (`resolveRoleModels`), so a malformed row or a model the process cannot
 * serve fails the boot rather than a run. Under the faux backend every `faux/<id>` it names is
 * published beside the default, which is how two roles run two models with no key — and only those,
 * so under faux a row dropped while a run is pinned to it strands that run (docs/board.md B6).
 */
const RoleModelsConfig = Config.String("ROLE_MODELS").pipe(
  Config.withDefault(""),
);

/**
 * The deployment's default model (LOB-274): `provider/modelId`, what a session with no model of its
 * own and no `ROLE_MODELS` row runs, instead of the backend's own (`claude-sonnet-5-5` on anthropic,
 * `faux-1` under faux). The precedence is a session's model > its column's role row > this > the
 * backend's. Resolved against the catalog at boot (`resolveDefaultModel`), so a model the process
 * cannot serve fails the boot; under faux a `faux/<id>` is published, as a role row's is. Blank: the
 * backend's own.
 */
const DefaultModelConfig = Config.String("DEFAULT_MODEL").pipe(
  Config.withDefault(""),
);

/** The faux model ids `keys` name, which the faux backend has to publish to serve them. */
const fauxModelIds = (keys: Iterable<string>): string[] =>
  [...keys]
    .map((key) => key.trim())
    .filter((key) => key.startsWith("faux/") && key.length > "faux/".length)
    .map((key) => key.slice("faux/".length));

/**
 * The spend ceiling a session gets when its create names none (LOB-163), in US dollars — and a fork
 * or a replay of an uncapped session, which names none either (a capped one's keeps its source's
 * cap). Unset: no default, so only a create that asks for a cap, or a fork or replay of a capped
 * session, gets one. A value that is not a positive number fails
 * the boot rather than silently leaving every session uncapped.
 */
const SessionBudgetConfig = Config.option(
  Config.schema(SessionBudgetCap, "SESSION_BUDGET"),
);

/**
 * Admission control (LOB-70): how many sessions this process runs at once — open owners, each a
 * harness, a held log, a worktree and a projection. A request that would open one more is refused
 * `at_capacity` (a webhook delivery: `503` with `Retry-After`), and served once the idle sweep
 * (`SESSION_IDLE_TIMEOUT_MS`) releases one. Not `SESSION_BUDGET`, which is dollars per session, and
 * not `SENTRY_RATE_LIMIT`, which is deliveries per window. Unset: no cap, so a deployment that never
 * sets it runs exactly as before. A value that is not a positive integer fails the boot rather than
 * silently leaving the process uncapped.
 */
const SessionMaxConcurrentConfig = Config.option(
  Config.schema(
    Schema.Finite.pipe(Schema.check(Schema.isInt(), Schema.isGreaterThan(0))),
    "SESSION_MAX_CONCURRENT",
  ),
);

/**
 * The docs trigger's interval schedule (LOB-197, started here by LOB-234).
 *
 * `DOCS_SCHEDULE_MS` is the interval and `DOCS_SCHEDULE_REPO` the repo each tick docs. Unset (or
 * `<= 0`) the schedule is off and delivers nothing — the default, because a scheduled docs run is a
 * deployment's choice. An interval with no repo fails the boot rather than ticking at nothing, and so
 * does a value that is not an integer or a repo that is not `owner/name`. The repo still has to be
 * registered: until it is, each tick is recorded `skipped` naming it, the way any trigger's is.
 */
const DocsScheduleConfig = Config.all({
  everyMs: Config.option(Config.Int("DOCS_SCHEDULE_MS")),
  repo: Config.option(Config.schema(RepoSlug, "DOCS_SCHEDULE_REPO")),
});

/**
 * Whether the boot resumes the missions (LOB-231) and the runs (LOB-25) its database says are in
 * flight. On by default: a mission a restart interrupted waits on no client, so a deployment that
 * did not resume it would leave it `pending` in its log, and a run would sit placed and unanswered
 * until its next message. The resume only reopens rows marked under this process's
 * `SESSION_ROOT`, which already keeps a verify skill's throwaway API off the development instance's
 * missions; `MISSION_RESUME=false` is for a second process that shares the database *and* the root
 * and must not take over the first one's logs — there is no ownership lease (docs/design.md D12).
 */
const MissionResumeConfig = Config.Boolean("MISSION_RESUME").pipe(
  Config.withDefault(true),
);

/** A docs schedule the boot refuses: an interval with no repo to run it over. */
class InvalidDocsSchedule extends Schema.TaggedError<InvalidDocsSchedule>()(
  "InvalidDocsSchedule",
  { message: Schema.String },
) {}

/** The first line of a cause, short enough for one log line. */
const firstLine = (cause: Cause.Cause<unknown>): string =>
  Cause.pretty(cause).split("\n")[0]?.trim() ?? "unknown failure";

/**
 * Release every session owner this process holds when it is asked to stop (LOB-21).
 *
 * `BunRuntime.runMain` interrupts the main fiber on SIGINT/SIGTERM, which tears down this layer's
 * scope; the finalizer then runs `SessionService.close`. Releasing the owners — rather than letting
 * the process exit with them open — is what makes an interrupted run *resumable* rather than merely
 * durable: `closeHarness` settles the run and the storage is disposed, so the log is a clean
 * transcript a later read folds and a later message continues. The log lines are the evidence.
 */
const SessionShutdown = Layer.effectDiscard(
  Effect.gen(function* () {
    const sessions = yield* SessionService;
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        yield* Effect.logInfo(
          "shutdown: releasing every session owner held by this process",
        );
        // Flush before the process exits: under SIGTERM the runtime interrupts the main
        // fiber and tears down this scope; stdout to a file is block-buffered, so without an
        // explicit flush the finalizer's lines (and the evidence they carry) never land.
        yield* Effect.callback<void>((resume) => {
          process.stdout.write("", () => resume(Effect.void));
        });
        yield* sessions.close;
        yield* Effect.logInfo("shutdown: session owners released");
        yield* Effect.callback<void>((resume) => {
          process.stdout.write("", () => resume(Effect.void));
        });
      }),
    );
  }),
);

/**
 * Apply migrations out of the boot path (LOB-21).
 *
 * `PgMigrator.layer` runs its migrations during layer *acquisition* and dies when Postgres is
 * unreachable, so building it as a dependency of the HTTP server would turn a database outage into
 * a crash loop instead of a pod that is up but *not ready*. Here it is a scoped build inside a
 * forked fiber: the server binds first, `/readyz` names what is missing, and a database that comes
 * back later turns readiness green without a restart. A successful build means the migrations are
 * applied — `PgMigrator.layer` is `Layer.effectDiscard(run(...))`, not a daemon.
 */
const applyMigrations = Effect.gen(function* () {
  for (;;) {
    const exit = yield* Effect.scoped(Layer.build(MigrationsLive)).pipe(
      Effect.exit,
    );
    if (Exit.isSuccess(exit)) {
      yield* Effect.logInfo("migrations: applied");
      // Rows older than migration 0027 name no model until something reads their logs (LOB-269):
      // once, here, so the list names every session's model without waiting for each to reopen. A
      // failure is a stale display column, never a reason to stop serving.
      yield* backfillSessionModels.pipe(
        Effect.flatMap((filled) =>
          filled > 0
            ? Effect.logInfo(
                `session models: filled ${filled} index row(s) from their logs`,
              )
            : Effect.void,
        ),
        Effect.catch((error) =>
          Effect.logWarning(
            `session models: the backfill stopped: ${error.message}`,
          ),
        ),
      );
      return;
    }
    yield* Effect.logError(
      `migrations failed; retrying in ${MIGRATION_RETRY_MS}ms: ${firstLine(exit.cause)}`,
    );
    yield* Effect.sleep(MIGRATION_RETRY_MS);
  }
});

const MigrationsDaemon = Layer.effectDiscard(
  Effect.forkScoped(applyMigrations),
);

/**
 * Run the docs schedule for as long as the process lives (LOB-234), beside `MigrationsDaemon` and for
 * the same reason: forked, so a tick that cannot reach Postgres is logged by `docsSchedule` and the
 * next interval tries again instead of failing the boot. It is built on `SessionShutdown`
 * (`HttpLive`), so its scope closes first: shutdown interrupts the schedule, and waits for it, before
 * the session owners are released. Off, it forks nothing.
 */
const DocsScheduleDaemon = (schedule: {
  readonly everyMs: number;
  readonly repo: RepoSlug;
}) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      yield* Effect.logInfo(
        `docs schedule: every ${schedule.everyMs}ms over ${schedule.repo} (DOCS_SCHEDULE_MS)`,
      );
      yield* Effect.forkScoped(runDocsSchedule(schedule));
    }),
  );

/**
 * One boot resume, retried until its query can run: the column it reads is a migration's, and the
 * database may not be reachable or migrated yet. Logs what it resumed under `what`.
 */
const resumeAtBoot = (
  what: "missions" | "runs",
  resume: Effect.Effect<readonly string[], SessionError>,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    for (;;) {
      const exit = yield* Effect.exit(resume);
      if (Exit.isSuccess(exit)) {
        yield* Effect.logInfo(
          exit.value.length === 0
            ? `${what}: none in flight to resume`
            : `${what}: resumed ${exit.value.length} in flight: ${exit.value.join(", ")}`,
        );
        return;
      }
      yield* Effect.logWarning(
        `${what}: could not resume; retrying in ${MIGRATION_RETRY_MS}ms: ${firstLine(exit.cause)}`,
      );
      yield* Effect.sleep(MIGRATION_RETRY_MS);
    }
  });

/**
 * Resume every mission (LOB-231) and every run (LOB-25) the last process was stopped in the middle
 * of, once, at boot.
 *
 * A mission is durable work no client is talking to: a shutdown leaves it `pending` in its log, and
 * nothing would reopen that log until somebody sent the session a message. `resumeMissions` reopens
 * each session whose row says a mission is in flight and schedules it, so the mission continues in
 * the phase it died in. A run is the same story for a conversation: a SIGTERM's close or a SIGKILL
 * leaves its submission placed and unanswered, and `resumeRuns` reopens each session whose row says
 * a run is in flight, which continues it as the same submission. Forked beside `MigrationsDaemon`
 * and for the same reason — the boot binds first. Built on `SessionShutdown`, like the docs
 * schedule, so a resume still in progress is interrupted before the owners are released.
 */
const BootResumeDaemon = Layer.effectDiscard(
  Effect.gen(function* () {
    const sessions = yield* SessionService;
    yield* Effect.forkScoped(
      resumeAtBoot("missions", sessions.resumeMissions).pipe(
        Effect.andThen(resumeAtBoot("runs", sessions.resumeRuns)),
      ),
    );
  }),
);

/**
 * Say which credential source the process selected (LOB-51). Building the provider is what refuses
 * an unsupported configuration (a GitHub App id with no App flow), so this line is also the boot's
 * evidence that the static token, not an App, is what the control plane will use.
 */
const CredentialSelectionLog = Layer.effectDiscard(
  Effect.gen(function* () {
    const credentials = yield* CredentialProvider;
    yield* Effect.logInfo(
      `credentials: ${credentials.source} (sessions receive no token)`,
    );
  }),
).pipe(Layer.provide(CredentialProviderLive));

/**
 * What the PR step's RPC member hands `openPullRequest` (LOB-213): the forge client and the
 * credential provider. The provider is the same `CredentialProviderLive` the boot log reports — one
 * layer, so one provider (and one App-token cache) answers both — and the client reaches
 * `GITHUB_API_URL`, which a drive points at a loopback fake.
 */
const PullRequestStepDeps = Layer.mergeAll(
  CredentialProviderLive,
  FetchHttpClient.layer,
);

// HTTP API Router
const ApiRouter = HttpApiBuilder.layer(Api).pipe(
  Layer.provide(HealthGroupLive),
);

// NOTE: Modules append additional routers here through Layer.mergeAll.
const AllRouters = Layer.mergeAll(
  ApiRouter,
  SessionRpcLive,
  ProbesLive,
  GitHubWebhookLive,
);

// NOTE: Modules append additional server layers here through Layer.mergeAll.
const ServerLayers = Layer.mergeAll(
  BunHttpServer.layerConfig(ServerConfig),
  DevToolsLive,
  MotelLive,
  OtlpMetricsLive,
);

const HttpLive = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const model = yield* ModelConfig;
  const prCap = yield* PrCapConfig;
  const autonomy = yield* ApprovalGateConfig;
  const defaultBudget = yield* SessionBudgetConfig;
  const maxConcurrent = yield* SessionMaxConcurrentConfig;
  const declaredRoles = yield* parseRoleModels(yield* RoleModelsConfig);
  const declaredDefault = (yield* DefaultModelConfig).trim();
  const docsSchedule = yield* DocsScheduleConfig;
  const sandboxChoice = yield* SandboxRuntimeConfig;
  const missionResume = yield* MissionResumeConfig;
  // Who may call the RPC surface (LOB-20): a malformed token table refuses the boot here, and no
  // table at all is auth off, which the boot says in a warning rather than an info line — and which
  // listens beyond loopback only when FACTORY_API_AUTH=off asks for it.
  const apiAuth = yield* ApiAuthConfig;
  const apiTokens = yield* tokenTableOf(apiAuth);
  const unsafeBind = bindRefusal(apiTokens, config.hostname, apiAuth.authOff);
  if (unsafeBind !== undefined) return yield* unsafeBind;
  const docsEveryMs = Option.getOrElse(docsSchedule.everyMs, () => 0);
  if (docsEveryMs > 0 && Option.isNone(docsSchedule.repo)) {
    return yield* new InvalidDocsSchedule({
      message:
        "DOCS_SCHEDULE_MS is set but DOCS_SCHEDULE_REPO is not: the docs schedule needs the repo it docs",
    });
  }
  const allowedOrigins = config.allowedOrigins.split(",").map((o) => o.trim());
  // `TRIGGER_RULES` and the webhook secrets, said once at boot (LOB-266); a malformed rule list
  // refuses the boot here rather than answering every delivery `skipped`.
  const triggerRules = yield* logTriggerBootFromProcess;

  yield* Effect.logInfo(
    describeLoadedEnvFiles(
      yield* loadedEnvFiles({
        execArgv: process.execArgv,
        cwd: process.cwd(),
        // Bun picks its autoloaded files from NODE_ENV, so the boot line reads the same variable.
        nodeEnv: Option.getOrUndefined(
          yield* Config.option(Config.String("NODE_ENV")),
        ),
      }).pipe(Effect.provide(BunServices.layer)),
    ),
  );
  // After the env-file line, so a refused boot still says which files it read. Forced anthropic with
  // no credential fails here, before anything is served (LOB-258).
  const backendChoice = yield* selectModelBackend({ forced: model.backend });
  const backend = backendChoice.backend;
  yield* Effect.logInfo(describeModelBackend(backendChoice));
  yield* Effect.logInfo(
    Option.match(defaultBudget, {
      onNone: () => "session budget: none by default (a create may name one)",
      onSome: (budget) =>
        `session budget: $${budget} by default (SESSION_BUDGET)`,
    }),
  );
  yield* Effect.logInfo(
    Option.match(maxConcurrent, {
      onNone: () =>
        "session admission: no cap on concurrent sessions (SESSION_MAX_CONCURRENT unset)",
      onSome: (limit) =>
        `session admission: at most ${limit} concurrent sessions (SESSION_MAX_CONCURRENT)`,
    }),
  );
  for (const warning of modelBackendWarnings(backendChoice)) {
    yield* Effect.logWarning(warning);
  }
  // Where sessions' commands run (LOB-244). Built in the boot's scope, so it outlives every owner:
  // the session layer below releases its owners — and their sandboxes — before this is released.
  const sandbox = yield* selectSandboxRuntime(
    Option.getOrElse(sandboxChoice, () => DEFAULT_SANDBOX_RUNTIME),
  );
  yield* Effect.logInfo(
    describeSandboxRuntime(sandbox.capabilities, Option.isSome(sandboxChoice)),
  );

  // The model every session talks to, and the one a run's role picks instead (LOB-207).
  // The backend's own first, so it stays in the catalog when `DEFAULT_MODEL` names another one; a
  // `faux/<id>` that `DEFAULT_MODEL` or a role row names is published beside it (LOB-274).
  const fauxModels = [
    ...new Set([
      FAUX_MODEL_ID,
      ...fauxModelIds([declaredDefault]),
      ...fauxModelIds(declaredRoles.values()),
    ]),
  ];
  const fauxModelScripts = yield* parseFauxModelScripts(
    model.fauxModelScripts,
    fauxModels,
  );
  if (backend === "faux" && fauxModelScripts.size > 0) {
    yield* Effect.logInfo(
      `faux model scripts: ${[...fauxModelScripts.keys()].join(", ")} (FAUX_MODEL_SCRIPTS)`,
    );
  }
  const backendAccess = createModelAccess(backend, {
    fauxCommand: model.fauxCommand,
    fauxEveryTurn: model.fauxEveryTurn,
    fauxAsk: Option.getOrUndefined(model.fauxAsk),
    fauxSpec: Option.getOrUndefined(model.fauxSpec),
    fauxDecomposition: Option.getOrUndefined(model.fauxDecomposition),
    fauxPlanFreshness: Option.getOrUndefined(model.fauxPlanFreshness),
    fauxReview: Option.getOrUndefined(model.fauxReview),
    fauxCost: model.fauxCost,
    fauxVerify: model.fauxVerify,
    fauxSleepMs: model.fauxSleepMs,
    fauxModels,
    fauxModelScripts,
  });
  // The deployment's default (LOB-274): `DEFAULT_MODEL` resolved against the backend's catalog, or
  // the backend's own model when it is blank. One outside the catalog fails the boot here.
  const modelAccess = yield* resolveDefaultModel(
    backendAccess,
    declaredDefault,
  );
  yield* Effect.logInfo(
    declaredDefault === ""
      ? `default model: ${modelKey(modelAccess)} (the ${backend} backend's own; DEFAULT_MODEL unset)`
      : `default model: ${modelKey(modelAccess)} (DEFAULT_MODEL)`,
  );
  const roleModels = yield* resolveRoleModels(modelAccess, declaredRoles);
  yield* Effect.logInfo(
    `role models: ${[...roleModels]
      .map(([role, access]) => `${role} → ${modelKey(access)}`)
      .concat(`any other role → ${modelKey(modelAccess)}`)
      .join(", ")}${declaredRoles.size === 0 ? "" : " (ROLE_MODELS)"}`,
  );
  // A review run's model is its role's row (LOB-36); with none, every PR head the review trigger
  // reviews runs on the deployment's model, which is the one the builders need and rarely the cheap one.
  const webhookSecret = yield* Config.String("GITHUB_WEBHOOK_SECRET").pipe(
    Config.withDefault(""),
  );
  // A card leaves `review` for `done` only on a review run's pass (LOB-241's `review_verdict`), and
  // review runs are opened only by signed deliveries to this route: without it, no card can.
  if (webhookSecret === "") {
    yield* Effect.logWarning(
      "review runs: off (GITHUB_WEBHOOK_SECRET unset, so POST /webhooks/github answers 503): no pull request is reviewed, and a board's review → done, which needs a review run's pass (review_verdict), is refused for every card",
    );
  } else if (![...REVIEW_ROLES].some((role) => roleModels.has(role))) {
    yield* Effect.logWarning(
      `review runs: ROLE_MODELS has no row for ${[...REVIEW_ROLES].join(" or ")}, so every pull request review runs on the deployment's model (${modelKey(modelAccess)}); set ROLE_MODELS=reviewer=<provider>/<model> to review on a cheaper one`,
    );
  }

  // The reviewer's identity (LOB-36): its own token or App, never the worker's. One that *is* the
  // worker's fails the boot here; none at all boots, and each review's post says what is missing.
  const reviewerConfig = yield* ReviewerCredentialConfig;
  const credentialConfig = yield* CredentialConfig;
  const reviewerCredentials = yield* selectReviewerCredentialProvider(
    credentialConfig,
    reviewerConfig,
  ).pipe(Effect.provide(FetchHttpClient.layer));
  const reviewerAppId = Option.filter(reviewerConfig.appId, (id) => id !== "");
  const reviewPoster = yield* githubReviewPoster({
    credentials: reviewerCredentials,
    // An App reviewer asks `GET /app` which bot is its own, so another App's marked review is not.
    ...(Option.isSome(reviewerAppId) &&
    Option.isSome(reviewerConfig.appPrivateKey)
      ? {
          app: {
            appId: reviewerAppId.value,
            privateKey: reviewerConfig.appPrivateKey.value,
          },
        }
      : {}),
  }).pipe(Effect.provide(FetchHttpClient.layer));
  const reviewerIdentity = Option.isSome(reviewerConfig.appId)
    ? "github-app"
    : Option.isSome(reviewerConfig.token)
      ? "token"
      : "none";
  yield* Effect.logInfo(
    `reviewer identity: ${reviewerIdentity === "github-app" ? "its own GitHub App (GITHUB_REVIEWER_APP_ID)" : reviewerIdentity === "token" ? "its own token (GITHUB_REVIEWER_TOKEN)" : "none, so reviews are recorded and not posted"}`,
  );

  // A repo registered with only a URL is cloned into `<SESSION_ROOT>/.cache` with the worker's read
  // credential, and its sessions' worktrees are cut from that clone (LOB-265). A repo with a checkout
  // and a forge URL has its base fetched into the checkout before a worktree is cut, and its
  // session's branch pushed before the PR step opens the PR (C17). One provider answers both.
  const [repoMirror, repoRemote] = yield* Effect.all([
    gitRepoMirror({ root: model.sessionRoot }),
    gitRepoRemote,
  ]).pipe(
    Effect.provide(Layer.mergeAll(CredentialProviderLive, BunServices.layer)),
  );

  // What `getServerInfo` answers (LOB-269): the values resolved above, as they were resolved, so the
  // RPC and the boot lines say the same thing. Names and modes only — no credential is in here.
  const ServerFactsLive = Layer.succeed(ServerFacts, {
    choice: backendChoice,
    model: modelAccess,
    roleModels,
    approvalRequired: autonomy.approvalRequired,
    defaultBudget,
    // Resolved here to armed-or-not, so the secrets' values never enter the service.
    webhooks: webhookRouteStates(bootEnvFromProcess()),
    githubTokenSet: Option.exists(
      credentialConfig.githubToken,
      (token) => Redacted.value(token) !== "",
    ),
    linearStates: linearConfig?.states,
    reviewer: reviewerIdentity,
    sandbox: Option.getOrElse(sandboxChoice, () => DEFAULT_SANDBOX_RUNTIME),
  });

  // Sessions own one log, one working directory, and (locally) the harness that drives them. The PR
  // step's exit is mirrored on the Linear issue a session was delegated from, when a key is set
  // (LOB-15).
  //
  // The PR step a settled run takes with no operator call (C18) reaches the forge through the pair
  // the RPC member is handed — the credential provider and a client on `GITHUB_API_URL` — read
  // inside the layer graph from `PullRequestStepDeps`, the same layer the routes are given: one
  // build of it, so one provider (and one App-token cache) answers a settle, a call and the boot log.
  const SessionDeps = Layer.unwrap(
    Effect.map(
      Effect.context<CredentialProvider | HttpClient.HttpClient>(),
      (pullRequestOnSettle) =>
        SessionServiceLive({
          pullRequestOnSettle,
          reviewPoster,
          repoMirror,
          repoRemote,
          model: modelAccess,
          roleModels,
          sessionRoot: model.sessionRoot,
          sandbox,
          idleTimeoutMs: model.idleTimeoutMs,
          ...Option.match(maxConcurrent, {
            onNone: () => ({}),
            onSome: (limit) => ({ maxConcurrentSessions: limit }),
          }),
          prCap,
          autonomy,
          ...Option.match(defaultBudget, {
            onNone: () => ({}),
            onSome: (budget) => ({ defaultBudget: budget }),
          }),
        }),
    ),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        SessionWriteBacksLive,
        ProposalTrackerLive,
        PullRequestStepDeps,
      ),
    ),
  );

  // The database pool is lazy (`PgClient` opens a connection on first query), so this graph builds
  // — and the server binds — even when Postgres is unreachable. Migrations run in the background so
  // a failing migrator cannot kill the process; `/readyz` reports the truth and requests that need
  // the log fail with a typed `SessionError`.
  //
  // `provideMerge` (not `provide`): `/readyz` needs `SqlClient` itself, so the database services
  // have to stay in the layer's output rather than being kept private to the session layer. The
  // shutdown finalizer registers after the pool, so it runs before the pool closes.
  // The docs schedule reads the session layer, so it sits under it with the shutdown finalizer —
  // built *on* `SessionShutdown` rather than beside it. `provideMerge` builds the two in one
  // sequential scope, shutdown first, so the daemon's fiber is interrupted (and awaited) before
  // `sessions.close` releases the owners; siblings in `Layer.mergeAll` would close in parallel, and a
  // tick inside `sessions.create` could open an owner while `close` was releasing them.
  // The mission resume (LOB-231) sits there too, for the same reason: a resume that is still
  // reopening owners when the signal lands is interrupted before `close` releases them.
  const MissionResume = missionResume
    ? BootResumeDaemon
    : Layer.effectDiscard(
        Effect.logInfo(
          "missions: resume at boot off (MISSION_RESUME=false); a mission or a run in flight waits for its next caller",
        ),
      );
  // The plan-freshness passes (LOB-45) sit there too: a pass a merged PR's delivery claimed runs on
  // this fiber set, past the request, and shutdown interrupts it before the owners are released.
  const SessionDaemons = Layer.mergeAll(
    Option.match(docsSchedule.repo, {
      onNone: () => MissionResume,
      onSome: (repo) =>
        docsEveryMs > 0
          ? Layer.mergeAll(
              MissionResume,
              DocsScheduleDaemon({ everyMs: docsEveryMs, repo }),
            )
          : MissionResume,
    }),
    PlanFreshnessPassesLive,
  ).pipe(Layer.provideMerge(SessionShutdown));
  if (docsEveryMs <= 0) {
    yield* Effect.logInfo("docs schedule: off (DOCS_SCHEDULE_MS unset)");
  }

  const RouterDependencies = Layer.mergeAll(
    SessionDaemons.pipe(Layer.provideMerge(SessionDeps)),
    MigrationsDaemon,
    CredentialSelectionLog,
    LinearSyncLog,
    TriggerAdaptersLog,
    TriggerCheckoutLog(triggerRules),
    // Tells a person when a run needs them (S-notifications); off, it logs one line and forks nothing.
    NotifierDaemon(allowedOrigins[0] ?? "http://localhost:3000"),
    PullRequestStepDeps,
    ServerFactsLive,
    controlPlaneAuthLayer(apiTokens),
  ).pipe(
    // The Linear sync sits beside Postgres so the session layer and the routes share one instance
    // (`./Api/LinearSync`): a layer first built inside `serve` would be the routes' private copy.
    Layer.provideMerge(
      Layer.mergeAll(PostgresLive, BunServices.layer, LinearIssueSyncLayer),
    ),
  );

  if (apiTokens === undefined) {
    yield* Effect.logWarning(describeApiAuth(apiTokens));
  } else {
    yield* Effect.logInfo(describeApiAuth(apiTokens));
  }
  yield* Effect.logInfo(`CORS allowed origins: ${allowedOrigins.join(", ")}`);
  yield* Effect.logInfo("Starting server with:");
  yield* Effect.logInfo("  - HTTP API at /");
  yield* Effect.logInfo(
    `  - RPC at /rpc (${apiTokens === undefined ? "unauthenticated" : "bearer token required"}; webhooks keep their own signatures)`,
  );
  yield* Effect.logInfo("  - probes at /livez and /readyz");
  yield* Effect.logInfo(
    `  - session working directories under ${model.sessionRoot}`,
  );
  yield* Effect.logInfo(
    `  - request body cap ${config.maxRequestBodySize} bytes`,
  );
  yield* Effect.logInfo(
    `  - commands that wait for an approval: ${autonomy.approvalRequired.length === 0 ? "none" : autonomy.approvalRequired.join(", ")}`,
  );
  yield* Effect.logInfo(
    `  - a session's PR step refuses a diff over ${prCap.maxFiles} files / ${prCap.maxLines} lines`,
  );
  yield* Effect.logInfo(
    "  - a settled run opens its PR with no operator call when a trigger opened its session or its card's column requires a PR",
  );

  const CorsRouters = Layer.mergeAll(
    AllRouters,
    webhookLiveFor(triggerRules),
  ).pipe(
    Layer.provide(
      HttpRouter.cors({
        allowedOrigins,
        allowedMethods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
        allowedHeaders: ["Content-Type", "Authorization", "B3", "traceparent"],
        credentials: true,
      }),
    ),
  );

  return HttpRouter.serve(CorsRouters).pipe(
    HttpServer.withLogAddress,
    Layer.provide(RouterDependencies),
    Layer.provideMerge(ServerLayers),
  );
}).pipe(Layer.unwrap, Layer.launch);

BunRuntime.runMain(HttpLive);
