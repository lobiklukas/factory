import { BunHttpServer, BunRuntime, BunServices } from "@effect/platform-bun";
import {
  CredentialProvider,
  CredentialProviderLive,
  DEFAULT_DIFF_CAP,
  SessionService,
  SessionServiceLive,
} from "@repo/core";
import { Api } from "@repo/domain/Api";
import {
  createModelAccess,
  DEFAULT_AUTONOMY,
  FAUX_COMMAND,
  type ModelBackend,
} from "@repo/harness";
import { MigrationsLive, PostgresLive } from "@repo/storage-postgres";
import { Cause, Config, Effect, Exit, Layer, Option } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { HealthGroupLive } from "./Api/Health";
import { WebhookLive } from "./Api/Webhook";
import { GitHubWebhookLive } from "./Api/GitHubWebhook";
import {
  LinearIssueSyncLayer,
  LinearSyncLog,
  SessionWriteBackLive,
} from "./Api/LinearSync";
import { ProbesLive } from "./Api/Probes";
import { SessionRpcLive } from "./Rpc/Session";
import { DevToolsLive } from "./observability/DevTools";
import { MotelLive } from "./observability/Motel";

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
  hostname: Config.String("HOST").pipe(Config.withDefault("0.0.0.0")),
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
 * `MODEL_BACKEND` wins when set. Otherwise a key decides: a real provider when one is configured,
 * pi-ai's deterministic faux provider when none is, so a checkout with no key still boots and a
 * session still runs end to end — it just reports that it is not talking to a model.
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
  apiKey: Config.option(Config.Redacted("ANTHROPIC_API_KEY")),
  sessionRoot: Config.String("SESSION_ROOT").pipe(
    Config.withDefault(".factory/sessions"),
  ),
  idleTimeoutMs: Config.Int("SESSION_IDLE_TIMEOUT_MS").pipe(
    Config.withDefault(15 * 60_000),
  ),
});

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

// HTTP API Router
const ApiRouter = HttpApiBuilder.layer(Api).pipe(
  Layer.provide(HealthGroupLive),
);

// NOTE: Modules append additional routers here through Layer.mergeAll.
const AllRouters = Layer.mergeAll(
  ApiRouter,
  SessionRpcLive,
  ProbesLive,
  WebhookLive,
  GitHubWebhookLive,
);

// NOTE: Modules append additional server layers here through Layer.mergeAll.
const ServerLayers = Layer.mergeAll(
  BunHttpServer.layerConfig(ServerConfig),
  DevToolsLive,
  MotelLive,
);

const HttpLive = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const model = yield* ModelConfig;
  const prCap = yield* PrCapConfig;
  const autonomy = yield* ApprovalGateConfig;
  const allowedOrigins = config.allowedOrigins.split(",").map((o) => o.trim());

  const backend: ModelBackend = Option.getOrElse(model.backend, () =>
    Option.isSome(model.apiKey) ? "anthropic" : "faux",
  );
  yield* Effect.logInfo(
    `model backend: ${backend}${Option.isSome(model.backend) ? " (MODEL_BACKEND)" : ""}`,
  );
  if (backend === "faux") {
    yield* Effect.logWarning(
      "no ANTHROPIC_API_KEY: sessions run against the faux provider and produce scripted answers",
    );
  }

  // Sessions own one log, one working directory, and (locally) the harness that drives them. The PR
  // step's exit is mirrored on the Linear issue a session was delegated from, when a key is set
  // (LOB-15).
  const SessionDeps = SessionServiceLive({
    model: createModelAccess(backend, {
      fauxCommand: model.fauxCommand,
      fauxEveryTurn: model.fauxEveryTurn,
    }),
    sessionRoot: model.sessionRoot,
    idleTimeoutMs: model.idleTimeoutMs,
    prCap,
    autonomy,
  }).pipe(Layer.provide(SessionWriteBackLive));

  // The database pool is lazy (`PgClient` opens a connection on first query), so this graph builds
  // — and the server binds — even when Postgres is unreachable. Migrations run in the background so
  // a failing migrator cannot kill the process; `/readyz` reports the truth and requests that need
  // the log fail with a typed `SessionError`.
  //
  // `provideMerge` (not `provide`): `/readyz` needs `SqlClient` itself, so the database services
  // have to stay in the layer's output rather than being kept private to the session layer. The
  // shutdown finalizer registers after the pool, so it runs before the pool closes.
  const RouterDependencies = Layer.mergeAll(
    SessionShutdown.pipe(Layer.provideMerge(SessionDeps)),
    MigrationsDaemon,
    CredentialSelectionLog,
    LinearSyncLog,
  ).pipe(
    // The Linear sync sits beside Postgres so the session layer and the routes share one instance
    // (`./Api/LinearSync`): a layer first built inside `serve` would be the routes' private copy.
    Layer.provideMerge(
      Layer.mergeAll(PostgresLive, BunServices.layer, LinearIssueSyncLayer),
    ),
  );

  yield* Effect.logInfo(`CORS allowed origins: ${allowedOrigins.join(", ")}`);
  yield* Effect.logInfo("Starting server with:");
  yield* Effect.logInfo("  - HTTP API at /");
  yield* Effect.logInfo("  - RPC at /rpc");
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

  const CorsRouters = AllRouters.pipe(
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
