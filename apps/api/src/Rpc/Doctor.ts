import {
  checkBaseRef,
  CredentialProvider,
  type CredentialProviderShape,
  SessionService,
} from "@repo/core";
import { DoctorRpc } from "@repo/domain/Rpc";
import type {
  DeploymentChecks,
  ForgeCredentialCheck,
  ModelPing,
  RepoCheck,
} from "@repo/domain/Server";
import type { RepoSummary } from "@repo/domain/Session";
import { modelKey } from "@repo/harness";
import { Clock, Effect } from "effect";
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

    const checkRepo = (repo: RepoSummary): Effect.Effect<RepoCheck> =>
      Effect.all(
        {
          forge: forgeCheck(credentials, facts.githubTokenSet, repo.repo),
          baseRef: checkBaseRef({
            ref: repo.defaultBaseRef,
            workTree: repo.workTree,
            mirrorPath: repo.mirrorPath,
          }),
        },
        { concurrency: 2 },
      ).pipe(Effect.map((checks) => ({ repo: repo.repo, ...checks })));

    return DoctorRpc.of({
      // The registry read is the one part that needs Postgres; its failure is an answer, so the
      // boot facts above it still reach an operator whose database is down.
      checkDeployment: () =>
        Effect.gen(function* () {
          const listed = yield* sessions.listRepos.pipe(Effect.result);
          const base = {
            triggerRules: facts.triggerRules,
            envFiles: [...facts.envFiles],
          };
          if (listed._tag === "Failure") {
            return {
              ...base,
              repos: [],
              reposError: oneLine(listed.failure.message),
            } satisfies DeploymentChecks;
          }
          const repos = yield* Effect.forEach(listed.success.repos, checkRepo, {
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
          const answer = yield* Effect.tryPromise({
            try: () =>
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
                { maxTokens: 16 },
              ),
            catch: (cause) =>
              cause instanceof Error ? cause.message : String(cause),
          }).pipe(Effect.result);
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
                : `answered ${JSON.stringify(oneLine(text).slice(0, 40))}`,
            costUsd: reply.usage.cost.total,
            inputTokens: Math.round(reply.usage.input),
            outputTokens: Math.round(reply.usage.output),
            latencyMs: Math.max(0, Math.round(finished - started)),
          } satisfies ModelPing;
        }),
    });
  }),
);
