import {
  checkBaseRef,
  CredentialProvider,
  type CredentialProviderShape,
  SessionService,
} from "@repo/core";
import { DoctorRpc } from "@repo/domain/Rpc";
import type {
  BaseRefCheck,
  DeploymentChecks,
  ForgeCredentialCheck,
  ModelPing,
  RepoCheck,
} from "@repo/domain/Server";
import type { RepoSummary } from "@repo/domain/Session";
import { modelKey } from "@repo/harness";
import { Clock, Effect, Option } from "effect";
import { ServerFacts } from "../ServerInfo";

/**
 * The checks only the control plane can run for `factory doctor` (E8).
 *
 * Nothing here returns a credential's value: the forge check asks the provider whether a token
 * resolves for a repo and keeps only the answer's status and message (the provider's messages name
 * the repo and the variable, and are written never to quote a token), and the model ping keeps the
 * answer's text and cost, not the request. `Doctor.test.ts` plants a known token and key and asserts
 * neither is in anything a client received.
 */

/** A provider's message or a thrown value as one line short enough to print. */
const oneLine = (text: string): string => {
  const line = text.split("\n")[0]?.trim() ?? "";
  if (line === "") return "no message";
  return line.length > 200 ? `${line.slice(0, 197)}...` : line;
};

/**
 * What one repo's token mint and one base-ref probe may take, and what the model ping may take.
 * Without a bound, a provider that stalls turns the command that names what is broken into a hang.
 */
const REPO_CHECK_SECONDS = 20;
const PING_SECONDS = 30;

/**
 * Whether the PR step could get a token for `repo`. `none` is a static-token provider with no token
 * behind it, which `describeServer` reports the same way. A GitHub App provider mints an
 * installation token for the call, which is the check: a key GitHub rejects fails here, not at the
 * first push.
 */
const forgeCheck = (
  credentials: CredentialProviderShape,
  githubTokenSet: boolean,
  repo: RepoSummary["repo"],
): Effect.Effect<ForgeCredentialCheck> => {
  const mode =
    credentials.source === "static-token" && !githubTokenSet
      ? ("none" as const)
      : credentials.source;
  return credentials.tokenFor(repo).pipe(
    // The token is dropped on the floor: only that one resolved matters.
    Effect.as<ForgeCredentialCheck>({
      mode,
      status: "ok",
      message: `${mode} resolves a token for ${repo}`,
    }),
    Effect.catch((error) =>
      Effect.succeed<ForgeCredentialCheck>({
        mode,
        status: error.code === "missing" ? "missing" : "failed",
        message: oneLine(error.message),
      }),
    ),
  );
};

export const DoctorRpcHandlers = DoctorRpc.toLayer(
  Effect.gen(function* () {
    const facts = yield* ServerFacts;
    const credentials = yield* CredentialProvider;
    const sessions = yield* SessionService;

    const checkRepo = (repo: RepoSummary): Effect.Effect<RepoCheck> => {
      // Each half is bounded on its own, so a stalled mint is a `failed` forge line and the base
      // ref beside it is still answered.
      const stalled = `no answer within ${REPO_CHECK_SECONDS}s`;
      return Effect.all(
        {
          forge: forgeCheck(credentials, facts.githubTokenSet, repo.repo).pipe(
            Effect.timeoutOption(`${REPO_CHECK_SECONDS} seconds`),
            Effect.map((answer) =>
              Option.getOrElse(answer, (): ForgeCredentialCheck => ({
                mode: credentials.source,
                status: "failed",
                message: stalled,
              })),
            ),
          ),
          baseRef: checkBaseRef({
            ref: repo.defaultBaseRef,
            workTree: repo.workTree,
            mirrorPath: repo.mirrorPath,
          }).pipe(
            Effect.timeoutOption(`${REPO_CHECK_SECONDS} seconds`),
            Effect.map((answer) =>
              Option.getOrElse(answer, (): BaseRefCheck => ({
                ref: repo.defaultBaseRef,
                status: "unresolved",
                message: stalled,
              })),
            ),
          ),
        },
        { concurrency: 2 },
      ).pipe(Effect.map((checks) => ({ repo: repo.repo, ...checks })));
    };

    return DoctorRpc.of({
      // The registry read is the one part that needs Postgres; its failure is an answer, so the
      // boot facts above it still reach an operator whose database is down.
      checkDeployment: ({ repo }) =>
        Effect.gen(function* () {
          const listed = yield* sessions.listRepos.pipe(Effect.result);
          const base = {
            triggerRules: facts.triggerRules,
            envFiles: [...facts.envFiles],
            setupTimeoutSeconds: facts.setupTimeoutSeconds,
          };
          if (listed._tag === "Failure") {
            return {
              ...base,
              repos: [],
              reposError: oneLine(listed.failure.message),
            } satisfies DeploymentChecks;
          }
          // `doctor owner/name` asks about one repo: do not mint a token for the others.
          const asked =
            repo === undefined
              ? listed.success.repos
              : listed.success.repos.filter((row) => row.repo === repo);
          const repos = yield* Effect.forEach(asked, checkRepo, {
            concurrency: 4,
          });
          return { ...base, repos } satisfies DeploymentChecks;
        }),

      // One request, the smallest the model will answer, to the model a session with no role runs on.
      pingModel: () =>
        Effect.gen(function* () {
          const model = modelKey(facts.model);
          const served = facts.model.models.getModel(
            facts.model.provider,
            facts.model.modelId,
          );
          const refused = (message: string): ModelPing => ({
            model,
            ok: false,
            message,
            costUsd: 0,
            inputTokens: 0,
            outputTokens: 0,
            latencyMs: 0,
          });
          if (served === undefined) {
            return refused(`this process serves no model ${model}`);
          }
          const started = yield* Clock.currentTimeMillis;
          // The signal aborts the request when the timeout fires or the RPC is interrupted.
          const answer = yield* Effect.tryPromise({
            try: (signal) =>
              facts.model.models.completeSimple(
                served,
                {
                  systemPrompt: "You are a connectivity check. Answer briefly.",
                  messages: [
                    {
                      role: "user",
                      content: "Reply with the single word: ok",
                      timestamp: started,
                    },
                  ],
                },
                { maxTokens: 16, signal },
              ),
            catch: (cause) =>
              cause instanceof Error ? cause.message : String(cause),
          }).pipe(
            Effect.timeoutOption(`${PING_SECONDS} seconds`),
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.fail(`no answer within ${PING_SECONDS}s`),
                onSome: Effect.succeed,
              }),
            ),
            Effect.result,
          );
          const finished = yield* Clock.currentTimeMillis;
          if (answer._tag === "Failure") {
            return refused(oneLine(answer.failure));
          }
          const reply = answer.success;
          const failed = reply.stopReason === "error";
          const text = reply.content
            .flatMap((part) => (part.type === "text" ? [part.text] : []))
            .join("");
          return {
            model,
            ok: !failed,
            message: failed
              ? oneLine(reply.errorMessage ?? "the provider answered an error")
              : text.trim() === ""
                ? "answered"
                : `answered "${oneLine(text).slice(0, 40)}"`,
            costUsd: reply.usage.cost.total,
            inputTokens: Math.round(reply.usage.input),
            outputTokens: Math.round(reply.usage.output),
            latencyMs: Math.max(0, Math.round(finished - started)),
          } satisfies ModelPing;
        }),
    });
  }),
);
