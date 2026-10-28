import { RepoSlug, SessionActor, SessionBudgetCap } from "@repo/domain/Session";
import { Console, Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { resolveApiUrl } from "../api";
import { reportFailures } from "../errors";
import { BoardClient } from "../rpc";
import { followSession, formatDollars } from "../transcript";
import { runModelLines } from "./status";

/**
 * `factory run "<task>"` — mint a session, hand it the task, and follow the transcript until the
 * run settles.
 *
 * `--repo` binds the session to a repository (and registers it on first use); `--base-ref` picks
 * the ref it starts from, `--actor` who its spend is attributed to (LOB-162; `cli` unless named, as
 * `factory approve` decides as `cli`), and `--model` the model it runs on (LOB-274; one of
 * `getServerInfo`'s models, otherwise the server's default or the column role's). The workspace line is
 * the server's own answer for where the work will live, so the run proves the read path as well as the
 * write. The `model` line is the model the session is pinned to (LOB-272), and under the faux backend a
 * `warning: faux backend` line follows it: a scripted answer reads exactly like a real one, so the run
 * says which it is getting.
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
    model: Flag.String("model").pipe(
      Flag.withDescription(
        "Model the session runs on, as provider/modelId (one the server serves); defaults to the server's",
      ),
      Flag.optional,
    ),
    actor: Flag.String("actor").pipe(
      Flag.withDescription("Who the session's spend is attributed to"),
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
    model,
    actor,
    api,
  }) {
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

      const session = yield* client.createSession(input);
      yield* Console.log(`session ${session.id}`);
      if (Option.isSome(budget)) {
        yield* Console.log(`budget ${formatDollars(budget.value)}`);
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
