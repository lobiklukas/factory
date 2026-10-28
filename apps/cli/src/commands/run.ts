import { RepoSlug, SessionActor, SessionBudgetCap } from "@repo/domain/Session";
import { Console, Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { resolveApiUrl } from "../api";
import { reportFailure, reportFailures } from "../errors";
import { BoardClient } from "../rpc";
import { followSession, formatDollars } from "../transcript";
import { predictedCap, predictionLine } from "./cost";
import { runModelLines } from "./status";

/**
 * `factory run "<task>"` — mint a session, hand it the task, and follow the transcript until the
 * run settles.
 *
 * `--repo` binds the session to a repository (and registers it on first use); `--base-ref` picks
 * the ref it starts from, `--actor` who its spend is attributed to (LOB-162; `cli` unless named, as
 * `factory approve` decides as `cli`; a declaration only an open control plane keeps: one that
 * authenticates records the actor of the `FACTORY_API_TOKEN` the call carried, LOB-20), and `--model` the
 * model it runs on (LOB-274; one of `getServerInfo`'s models, otherwise the server's default or the
 * column role's). The workspace line is the server's own answer for where the work will live, so the
 * run proves the read path as well as the write. The `model` line is the model the session is pinned
 * to (LOB-272), and under the faux backend a `warning: faux backend` line follows it: a scripted answer
 * reads exactly like a real one, so the run says which it is getting.
 *
 * Before anything is created, the run prints what it is predicted to cost (LOB-38): a range from the
 * completed sessions most like the task (`factory cost predict`'s line). The prediction is advice, so
 * a server that cannot answer it costs the run that line and nothing else — unless
 * `--cap-at-prediction` asked to cap the session at the range's high, which then has no cap to set
 * and refuses before a session exists, as it does with too little history to predict from.
 */
export const runCommand = Command.make(
  "run",
  {
    task: Argument.String("task").pipe(
      Argument.withDescription("The task to delegate to the session"),
    ),
    repo: Flag.String("repo").pipe(
      Flag.withDescription("Repository to work on, as owner/name"),
      Flag.withSchema(RepoSlug),
      Flag.optional,
    ),
    baseRef: Flag.String("base-ref").pipe(
      Flag.withDescription("Ref the session starts from"),
      Flag.optional,
    ),
    budget: Flag.Finite("budget").pipe(
      Flag.withDescription(
        "Spend ceiling for the session, in US dollars: the run stops before a model request once it is reached",
      ),
      Flag.withSchema(SessionBudgetCap),
      Flag.optional,
    ),
    capAtPrediction: Flag.Boolean("cap-at-prediction").pipe(
      Flag.withDescription(
        "Cap the session's spend at the predicted range's high (instead of --budget)",
      ),
      Flag.withDefault(false),
    ),
    model: Flag.String("model").pipe(
      Flag.withDescription(
        "Model the session runs on, as provider/modelId (one the server serves); defaults to the server's",
      ),
      Flag.optional,
    ),
    actor: Flag.String("actor").pipe(
      Flag.withDescription(
        "Who the session's spend is attributed to; ignored by a control plane that authenticates (FACTORY_API_TOKEN), which records the token's actor",
      ),
      Flag.withSchema(SessionActor),
      Flag.withDefault("cli"),
    ),
    api: Flag.String("api").pipe(
      Flag.withDescription("Control plane base URL"),
      Flag.optional,
    ),
  },
  Effect.fnUntraced(function* ({
    task,
    repo,
    baseRef,
    budget,
    capAtPrediction,
    model,
    actor,
    api,
  }) {
    if (capAtPrediction && Option.isSome(budget)) {
      return yield* reportFailure(
        "invalid_input",
        "--cap-at-prediction and --budget both set the cap; pass one",
      );
    }
    const apiUrl = yield* resolveApiUrl(api);

    const program = Effect.gen(function* () {
      const { client } = yield* BoardClient;

      const input: {
        repo?: RepoSlug;
        baseRef?: string;
        budget?: number;
        model?: string;
        actor: string;
      } = { actor };
      if (Option.isSome(repo)) input.repo = repo.value;
      if (Option.isSome(baseRef)) input.baseRef = baseRef.value;
      if (Option.isSome(budget)) input.budget = budget.value;
      if (Option.isSome(model)) input.model = model.value;

      // What the run is predicted to cost, before it exists (LOB-38). Only a cap that needs it makes
      // a failed prediction the run's failure.
      const asked = client.predictCost({
        prompt: task,
        ...(input.repo === undefined ? {} : { repo: input.repo }),
        ...(input.model === undefined ? {} : { model: input.model }),
      });
      const prediction = capAtPrediction
        ? yield* asked
        : yield* asked.pipe(Effect.option, Effect.map(Option.getOrUndefined));
      if (prediction !== undefined) {
        yield* Console.log(predictionLine(prediction));
      }
      let capped = false;
      if (capAtPrediction && prediction !== undefined) {
        const cap = predictedCap(prediction);
        if ("refused" in cap) {
          return yield* reportFailure("invalid_input", cap.refused);
        }
        input.budget = cap.cap;
        capped = true;
      }

      const session = yield* client.createSession(input);
      yield* Console.log(`session ${session.id}`);
      if (input.budget !== undefined) {
        yield* Console.log(
          `budget ${formatDollars(input.budget)}${capped ? " (the predicted high)" : ""}`,
        );
      }

      // A server that cannot answer `getServerInfo` costs the run its warning, never the run.
      const info = yield* client
        .getServerInfo({})
        .pipe(Effect.option, Effect.map(Option.getOrUndefined));
      for (const line of runModelLines(session.model, info)) {
        yield* Console.log(line);
      }

      const opened = yield* client.getSession({ sessionId: session.id });
      yield* Console.log(`workspace ${opened.workspace.path}`);
      if (opened.workspace.repo !== undefined) {
        const ref =
          opened.workspace.baseRef === undefined
            ? ""
            : ` base-ref ${opened.workspace.baseRef}`;
        yield* Console.log(`repo ${opened.workspace.repo}${ref}`);
      }
      if (opened.workspace.warning !== undefined) {
        yield* Console.log(`warning ${opened.workspace.warning}`);
      }

      yield* client.sendMessage({ sessionId: session.id, content: task });

      const { answer } = yield* followSession(client, session.id, {
        printMode: false,
      });
      yield* Console.log(`answer: ${answer ?? "(no answer)"}`);
      // The cap stopping the run is the reason there was no answer, and says so on a line of its own
      // (the transcript printed the `[budget]` entry as it landed).
      const after = yield* client.getSession({ sessionId: session.id });
      if (after.budget?.stopped !== undefined) {
        yield* Console.log(
          `stopped: budget reached (${formatDollars(after.budget.stopped.spent)} of ${formatDollars(after.budget.stopped.cap)})`,
        );
      }
    });

    yield* reportFailures(Effect.provide(program, BoardClient.layer(apiUrl)));
  }),
).pipe(
  Command.withDescription(
    "Create a session, send it a task, and stream the transcript",
  ),
  Command.withExamples([
    {
      command: 'factory run "fix the flaky test"',
      description: "Run a task in a scratch session",
    },
    {
      command: 'factory run "fix the flaky test" --budget 2',
      description: "Run a task that stops once it has spent $2",
    },
    {
      command: 'factory run "fix the flaky test" --cap-at-prediction',
      description:
        "Run a task capped at the high end of what runs like it have cost",
    },
    {
      command:
        'factory run "rename the flag" --model anthropic/claude-haiku-4-5',
      description: "Run a task on a cheaper model than the server's default",
    },
    {
      command: 'factory run "tighten the parser" --repo lobiklukas/factory',
      description: "Run a task against a repository",
    },
  ]),
);
