import { Effect, Layer, Logger, Option, Path, Schema } from "effect";
import { McpProtocol, McpServer, Tool, Toolkit } from "effect/ai";
import { Command, Flag } from "effect/cli";
import type { FileSystem } from "effect";
import type { ChildProcessSpawner } from "effect/process";
import {
  RepoSlug,
  SessionActor,
  SessionBudgetCap,
  SessionError,
  SessionId,
  WhenBusy,
} from "@repo/domain/Session";
import type {
  SendMessageResult,
  SessionSnapshot,
} from "@repo/domain/Session";
import { TaskId, TaskPriority } from "@repo/domain/Task";
import type { Task, TaskComment, TaskRun } from "@repo/domain/Task";
import { resolveApiUrl } from "../api";
import { describeFailure, reportFailure } from "../errors";
import { collectHandoff, HandoffRefused, remoteRepo } from "../handoff";
import { BoardClient } from "../rpc";
import { addCardInput, commentCard, startCard } from "./board";
import { boardFor, handOff, handoffRepo, type HandoffClient } from "./handoff";

/**
 * `factory mcp` — the factory as an MCP server on stdio (S-local-agent-handoff-mcp), so a local
 * agent (Claude Code, Codex, Cursor) can hand work to a factory session and follow it without a
 * terminal of its own.
 *
 * The tools are the verbs a delegating agent needs, each over the same RPC client the CLI's own
 * commands use (D9), and each the CLI command's own code path — `board add`, `board start`, `send`,
 * `board comment --start`, `handoff` — so the MCP surface cannot drift from the terminal's:
 *
 * - `create_card` — a card on the repository's board;
 * - `start_run` — a run on a card, sent the card's default prompt (or one given);
 * - `send_message` — a message to a run;
 * - `get_status` — a card (its column, block, question, newest run and its last answer) or a run;
 * - `answer_question` — the answer a parked run asked for, optionally starting the run that reads it;
 * - `handoff` — the checkout's work in progress as a card whose run starts on it (`factory handoff`).
 *
 * **stdio, not HTTP.** The MCP stdio transport is what a local agent launches per workspace
 * (`claude mcp add factory -- factory mcp`): the process is the agent's child, runs in the agent's
 * checkout — which is what `handoff` reads — and is gone with it, so there is no port to bind, no
 * origin to check and no credential to serve on. The control plane's credential is the CLI's own
 * (`FACTORY_API_TOKEN`, LOB-20). Effect's own `McpServer` (effect 4's `effect/ai`) speaks it, so no
 * second MCP SDK enters the tree; it negotiates every dated revision from 2024-11-05 on, so whichever
 * one the client asks for is answered.
 *
 * **stdout is the protocol's.** The transport forbids anything on stdout that is not a JSON-RPC
 * message, so the server's logs go to stderr (`Logger.LogToStderr`), and nothing here prints.
 *
 * **A refusal is a tool result, not a crash.** Every failure — a typed refusal, a `SessionError`, a
 * control plane that is not listening — is answered as an `isError` result carrying the same
 * `code: message` the CLI prints (`describeFailure`), so the calling agent reads why and what to do.
 */

/** What every tool's failure carries: the CLI's own `code: message`, as an `isError` result. */
export class FactoryToolError extends Schema.TaggedError<FactoryToolError>()(
  "FactoryToolError",
  { message: Schema.String },
) {}

/**
 * A failure as the calling agent reads it. A control plane that did not answer is said in words
 * that name where it was looked for and how to point the server elsewhere: the RPC client's own
 * (`rpc_client_error: HttpError`) says neither.
 */
const toolError =
  (apiUrl: string) =>
  (error: unknown): FactoryToolError => {
    const { code, message } = describeFailure(error);
    return new FactoryToolError({
      message:
        code === "rpc_client_error"
          ? `unreachable: the factory control plane at ${apiUrl} did not answer (${message.trim().replace(/:$/, "")}): start it, or point this server at it with --api or FACTORY_API_URL`
          : `${code}: ${message}`,
    });
  };

const described = <S extends Schema.Top>(schema: S, description: string) =>
  schema.annotate({ description });

/**
 * An optional parameter is `optionalKey`, not `optional`: the latter's JSON Schema advertises
 * `string | null`, which the decoder then refuses, so a client that sent the null it was offered
 * would be told its call was invalid.
 */
const optionalString = (description: string) =>
  Schema.optionalKey(described(Schema.String, description));

const CreateCard = Tool.make("create_card", {
  description:
    "Put a card on the factory board of this repository: a unit of work a factory session will do. Answers the card's id, column and revision; start its run with start_run.",
  parameters: Schema.Struct({
    title: described(Schema.String, "The card's title, one line"),
    body: optionalString(
      "What the card asks for, in markdown: quoted into every run's prompt",
    ),
    priority: Schema.optionalKey(TaskPriority),
    baseRef: optionalString(
      "The branch its runs start from (defaults to the repository's)",
    ),
    repo: optionalString(
      "owner/name (defaults to the repository this server was started for)",
    ),
    board: optionalString(
      "Board instance id brd_… (defaults to the repository's board)",
    ),
  }),
  success: Schema.Struct({
    taskId: Schema.String,
    boardId: Schema.String,
    column: Schema.String,
    revision: Schema.Int,
    text: Schema.String,
  }),
  failure: FactoryToolError,
}).annotate(Tool.Destructive, false);

const StartRun = Tool.make("start_run", {
  description:
    "Start a factory run on a card: a session bound to the card, in its column (or the one named), sent the card's default prompt unless a prompt is given. Answers the run's session id.",
  parameters: Schema.Struct({
    taskId: described(Schema.String, "The card, tsk_…"),
    column: optionalString(
      "The column the run starts in (defaults to the card's)",
    ),
    prompt: optionalString(
      "The run's first message (defaults to the card's title, body and the column's instruction)",
    ),
    budget: Schema.optionalKey(
      described(SessionBudgetCap, "Spend ceiling for the run, in US dollars"),
    ),
  }),
  success: Schema.Struct({
    sessionId: Schema.String,
    taskId: Schema.String,
    text: Schema.String,
  }),
  failure: FactoryToolError,
}).annotate(Tool.Destructive, false);

const SendMessage = Tool.make("send_message", {
  description:
    "Send a message to a factory run (a session). A busy run queues it as a follow-up unless whenBusy says steer or reject.",
  parameters: Schema.Struct({
    sessionId: described(Schema.String, "The run, ses_…"),
    content: described(Schema.String, "The message"),
    whenBusy: Schema.optionalKey(WhenBusy),
  }),
  success: Schema.Struct({
    sessionId: Schema.String,
    placement: Schema.String,
    text: Schema.String,
  }),
  failure: FactoryToolError,
}).annotate(Tool.Destructive, false);

const GetStatus = Tool.make("get_status", {
  description:
    "Read where a card or a run stands: a card's column, block, open question and newest run; a run's status, PR and last answer. Name exactly one of taskId and sessionId.",
  parameters: Schema.Struct({
    taskId: optionalString("A card, tsk_…"),
    sessionId: optionalString("A run, ses_…"),
  }),
  success: Schema.Struct({
    text: Schema.String,
    taskId: Schema.optionalKey(Schema.String),
    column: Schema.optionalKey(Schema.String),
    revision: Schema.optionalKey(Schema.Int),
    blocked: Schema.optionalKey(Schema.String),
    question: Schema.optionalKey(Schema.String),
    sessionId: Schema.optionalKey(Schema.String),
    status: Schema.optionalKey(Schema.String),
    prUrl: Schema.optionalKey(Schema.String),
    lastAnswer: Schema.optionalKey(Schema.String),
  }),
  failure: FactoryToolError,
}).annotate(Tool.Readonly, true);

const AnswerQuestion = Tool.make("answer_question", {
  description:
    "Answer the question a factory run parked its card on (the card is blocked needs_input). The answer lifts the block; start: true also starts the run that reads it.",
  parameters: Schema.Struct({
    taskId: described(Schema.String, "The card, tsk_…"),
    answer: described(Schema.String, "The answer, in markdown"),
    start: Schema.optionalKey(
      described(Schema.Boolean, "Start the next run on the card after answering"),
    ),
  }),
  success: Schema.Struct({
    taskId: Schema.String,
    revision: Schema.Int,
    sessionId: Schema.optionalKey(Schema.String),
    text: Schema.String,
  }),
  failure: FactoryToolError,
}).annotate(Tool.Destructive, false);

const Handoff = Tool.make("handoff", {
  description:
    "Hand this checkout's work in progress (local commits, edits and untracked files against the base branch) to a factory session: a new card carrying it as a patch, whose run starts with that work committed on its branch. Refused when the patch is over the cap.",
  parameters: Schema.Struct({
    note: described(
      Schema.String,
      "What the factory session should do with the work: the card's body, its first line the title",
    ),
    title: optionalString("The card's title (defaults to the note's first line)"),
    base: optionalString(
      "The branch the run starts from (defaults to the remote's default branch)",
    ),
    start: Schema.optionalKey(
      described(Schema.Boolean, "Start the card's run now"),
    ),
    column: optionalString(
      "With start: the column the run starts in (defaults to the card's)",
    ),
  }),
  success: Schema.Struct({
    taskId: Schema.String,
    files: Schema.Array(Schema.String),
    bytes: Schema.Int,
    sessionId: Schema.optionalKey(Schema.String),
    text: Schema.String,
  }),
  failure: FactoryToolError,
}).annotate(Tool.Destructive, false);

export const FactoryToolkit = Toolkit.make(
  CreateCard,
  StartRun,
  SendMessage,
  GetStatus,
  AnswerQuestion,
  Handoff,
);

/** What the tools need of the client: the CLI's commands' clients, and the reads `get_status` makes. */
export interface McpClient<B, S> extends HandoffClient<B, S> {
  readonly getSession: (input: {
    readonly sessionId: SessionId;
  }) => Effect.Effect<
    Pick<SessionSnapshot, "session" | "workspace" | "entries" | "approvals">,
    S
  >;
  readonly sendMessage: (input: {
    readonly sessionId: SessionId;
    readonly content: string;
    readonly whenBusy?: WhenBusy;
  }) => Effect.Effect<Pick<SendMessageResult, "placement" | "session">, S>;
  readonly listTaskRuns: (input: {
    readonly taskId: TaskId;
  }) => Effect.Effect<ReadonlyArray<TaskRun>, B>;
  readonly listTaskComments: (input: {
    readonly taskId: TaskId;
  }) => Effect.Effect<ReadonlyArray<TaskComment>, B>;
  readonly commentTask: (input: {
    readonly taskId: TaskId;
    readonly expectedRevision: number;
    readonly body: string;
    readonly actor: string;
  }) => Effect.Effect<Task, B>;
}

/** What the server was started for: the repository the cards go on, the checkout, and the actor. */
export interface McpOptions {
  /** The control plane the client calls, named in a refusal when it does not answer. */
  readonly apiUrl: string;
  readonly repo: RepoSlug | undefined;
  /** The checkout `handoff` reads: the directory the server runs in. */
  readonly dir: string;
  readonly actor: string;
}

const invalid = (message: string) =>
  new SessionError({ code: "invalid_input", message });

const decoded = <A>(
  schema: Schema.Codec<A, string>,
  raw: string,
  what: string,
): Effect.Effect<A, SessionError> =>
  Option.match(Schema.decodeOption(schema)(raw), {
    onNone: () => Effect.fail(invalid(`${what} "${raw}" is not one`)),
    onSome: Effect.succeed,
  });

/** The repository a tool call means: the one it names, or the one the server was started for. */
const repoOf = (
  named: string | undefined,
  options: McpOptions,
): Effect.Effect<RepoSlug, SessionError> =>
  named !== undefined
    ? decoded(RepoSlug, named, "repo (owner/name)")
    : options.repo !== undefined
      ? Effect.succeed(options.repo)
      : Effect.fail(
          invalid(
            "this server was started for no repository: name one with repo, or start it with `factory mcp --repo owner/name`",
          ),
        );

/** The longest answer `get_status` quotes back; the transcript is the run's, not the tool's. */
const ANSWER_CHARS = 4_000;

/** A run's newest assistant text, when it has said anything. */
const lastAnswerOf = (
  entries: SessionSnapshot["entries"],
): string | undefined => {
  const last = entries
    .filter((entry) => entry.kind === "assistant" && entry.text.trim() !== "")
    .at(-1)?.text;
  return last === undefined
    ? undefined
    : last.length > ANSWER_CHARS
      ? `${last.slice(0, ANSWER_CHARS)}…`
      : last;
};

/** A run's lines of a status: its status, PR, pending approvals and last answer. */
const sessionLines = (
  snapshot: Pick<SessionSnapshot, "session" | "entries" | "approvals">,
): ReadonlyArray<string> => {
  const answer = lastAnswerOf(snapshot.entries);
  return [
    `run ${snapshot.session.id} is ${snapshot.session.status}${snapshot.session.prUrl === undefined ? "" : `, PR ${snapshot.session.prUrl}`}`,
    ...snapshot.approvals.map(
      (approval) =>
        `waiting on approval ${approval.requestId}: ${approval.action} ${approval.detail}`,
    ),
    ...(answer === undefined ? [] : [`last answer: ${answer}`]),
  ];
};

/**
 * The tools' handlers over `client` (module doc): each one the CLI command's own code path, its
 * printed lines the result's `text`, and every failure a `FactoryToolError` carrying the CLI's
 * `code: message`. `handoff` reads the checkout, so it needs the process and file services.
 */
export const mcpHandlers = <B, S>(
  client: McpClient<B, S>,
  options: McpOptions,
) => {
  /** A sink for the lines a CLI code path prints: the tool result's `text`. */
  const printed = () => {
    const collected: Array<string> = [];
    return {
      text: () => collected.join("\n"),
      emit: (line: string) =>
        Effect.sync(() => {
          collected.push(line);
        }),
    };
  };

  const createCard = (params: typeof CreateCard.parametersSchema.Type) =>
    Effect.gen(function* () {
      const repo = yield* repoOf(params.repo, options);
      const boardId = yield* boardFor(client, repo, params.board);
      const card = yield* client.createTask(
        yield* addCardInput({
          boardId,
          title: params.title,
          repo,
          priority: params.priority,
          body: params.body,
          baseRef: params.baseRef,
          actor: options.actor,
        }),
      );
      return {
        taskId: card.id,
        boardId: card.boardId,
        column: card.column,
        revision: card.revision,
        text: `card ${card.id} "${card.title}" is on board ${card.boardId} in ${card.column} (revision ${card.revision}): start its run with start_run`,
      };
    }).pipe(Effect.mapError(toolError(options.apiUrl)));

  const startRun = (params: typeof StartRun.parametersSchema.Type) =>
    Effect.gen(function* () {
      const taskId = yield* decoded(TaskId, params.taskId, "taskId (tsk_…)");
      const out = printed();
      const sessionId = yield* startCard(
        client,
        {
          taskId,
          column: params.column,
          prompt: params.prompt,
          idle: false,
          budget: params.budget,
          actor: options.actor,
        },
        out.emit,
      );
      return { sessionId, taskId, text: out.text() };
    }).pipe(Effect.mapError(toolError(options.apiUrl)));

  const sendMessage = (params: typeof SendMessage.parametersSchema.Type) =>
    Effect.gen(function* () {
      const sessionId = yield* decoded(
        SessionId,
        params.sessionId,
        "sessionId (ses_…)",
      );
      const sent = yield* client.sendMessage({
        sessionId,
        content: params.content,
        ...(params.whenBusy === undefined ? {} : { whenBusy: params.whenBusy }),
      });
      return {
        sessionId,
        placement: sent.placement,
        text:
          sent.placement === "run"
            ? `sent to ${sessionId}: it started a run`
            : `sent to ${sessionId}: it is ${sent.session.status}, so the message joined its ${sent.placement === "steer" ? "steer" : "follow-up"} queue`,
      };
    }).pipe(Effect.mapError(toolError(options.apiUrl)));

  const cardStatus = (taskId: TaskId) =>
    Effect.gen(function* () {
      const card = yield* client.getTask({ taskId });
      const runs = yield* client.listTaskRuns({ taskId });
      const latest = runs[0];
      const question =
        card.blocked?.reason === "needs_input"
          ? (yield* client.listTaskComments({ taskId }))
              .filter((comment) => comment.kind === "question")
              .at(-1)?.body
          : undefined;
      const snapshot =
        latest === undefined
          ? undefined
          : Option.getOrUndefined(
              yield* client
                .getSession({ sessionId: latest.sessionId })
                .pipe(Effect.option),
            );
      const blocked =
        card.blocked === undefined
          ? undefined
          : `${card.blocked.reason}${card.blocked.note === undefined ? "" : `: ${card.blocked.note}`}`;
      const lastAnswer =
        snapshot === undefined ? undefined : lastAnswerOf(snapshot.entries);
      const text = [
        `card ${card.id} "${card.title}" is in ${card.column} (revision ${card.revision})${blocked === undefined ? "" : `, blocked ${blocked}`}`,
        ...(question === undefined
          ? []
          : [
              `its run asked: ${question}`,
              "answer it with answer_question",
            ]),
        runs.length === 0
          ? "no run has been started on it: start one with start_run"
          : `${runs.length} run${runs.length === 1 ? "" : "s"}; the newest is ${latest?.sessionId} in ${latest?.column}`,
        ...(snapshot === undefined ? [] : sessionLines(snapshot)),
      ].join("\n");
      return {
        text,
        taskId: card.id,
        column: card.column,
        revision: card.revision,
        ...(blocked === undefined ? {} : { blocked }),
        ...(question === undefined ? {} : { question }),
        ...(latest === undefined ? {} : { sessionId: latest.sessionId }),
        ...(snapshot === undefined
          ? {}
          : { status: snapshot.session.status }),
        ...(snapshot?.session.prUrl === undefined
          ? {}
          : { prUrl: snapshot.session.prUrl }),
        ...(lastAnswer === undefined ? {} : { lastAnswer }),
      };
    });

  const runStatus = (sessionId: SessionId) =>
    Effect.gen(function* () {
      const snapshot = yield* client.getSession({ sessionId });
      const lastAnswer = lastAnswerOf(snapshot.entries);
      return {
        text: sessionLines(snapshot).join("\n"),
        sessionId,
        status: snapshot.session.status,
        ...(snapshot.session.prUrl === undefined
          ? {}
          : { prUrl: snapshot.session.prUrl }),
        ...(lastAnswer === undefined ? {} : { lastAnswer }),
      };
    });

  const getStatus = (params: typeof GetStatus.parametersSchema.Type) =>
    Effect.gen(function* () {
      if ((params.taskId === undefined) === (params.sessionId === undefined)) {
        return yield* invalid(
          "name exactly one of taskId (a card) and sessionId (a run)",
        );
      }
      return params.taskId !== undefined
        ? yield* cardStatus(
            yield* decoded(TaskId, params.taskId, "taskId (tsk_…)"),
          )
        : yield* runStatus(
            yield* decoded(
              SessionId,
              params.sessionId ?? "",
              "sessionId (ses_…)",
            ),
          );
    }).pipe(Effect.mapError(toolError(options.apiUrl)));

  const answerQuestion = (
    params: typeof AnswerQuestion.parametersSchema.Type,
  ) =>
    Effect.gen(function* () {
      const taskId = yield* decoded(TaskId, params.taskId, "taskId (tsk_…)");
      const card = yield* client.getTask({ taskId });
      // An answer is what a parked run waits on (B7): anywhere else the comment would be a note,
      // which is not what this tool says it does.
      if (card.blocked?.reason !== "needs_input") {
        return yield* invalid(
          `${card.id} is not waiting on an answer (${card.blocked === undefined ? "it is not blocked" : `it is blocked ${card.blocked.reason}`}): nothing was written`,
        );
      }
      const out = printed();
      yield* commentCard(
        client,
        {
          taskId,
          expectedRevision: card.revision,
          body: params.answer,
          actor: options.actor,
          start: params.start === true ? options.actor : undefined,
        },
        out.emit,
      );
      const after = yield* client.getTask({ taskId });
      const sessionId = /^session (ses_[0-9a-z]+)$/m.exec(out.text())?.[1];
      return {
        taskId,
        revision: after.revision,
        ...(sessionId === undefined ? {} : { sessionId }),
        text: out.text(),
      };
    }).pipe(Effect.mapError(toolError(options.apiUrl)));

  const handoff = (params: typeof Handoff.parametersSchema.Type) =>
    Effect.gen(function* () {
      if (params.start !== true && params.column !== undefined) {
        return yield* new HandoffRefused({
          message: "column names where start opens the run: add start: true",
        });
      }
      const collected = yield* collectHandoff({
        cwd: options.dir,
        base: params.base,
      });
      const repo =
        options.repo ?? (yield* handoffRepo(undefined, collected));
      const out = printed();
      const { card, sessionId } = yield* handOff(
        client,
        {
          collected,
          repo,
          board: undefined,
          note: params.note,
          title: params.title,
          actor: options.actor,
          start:
            params.start === true
              ? { column: params.column, actor: options.actor }
              : undefined,
        },
        out.emit,
      );
      return {
        taskId: card.id,
        files: collected.files,
        bytes: collected.bytes,
        ...(sessionId === undefined ? {} : { sessionId }),
        text: out.text(),
      };
    }).pipe(Effect.mapError(toolError(options.apiUrl)));

  return {
    create_card: createCard,
    start_run: startRun,
    send_message: sendMessage,
    get_status: getStatus,
    answer_question: answerQuestion,
    handoff,
  };
};

/** The revisions served, newest first: the client's is answered whichever it asks for. */
const PROTOCOLS = [
  McpProtocol.v2025_11_25,
  McpProtocol.v2025_06_18,
  McpProtocol.v2025_03_26,
  McpProtocol.v2024_11_05,
  McpProtocol.v2026_07_28,
] as const;

const INSTRUCTIONS =
  "The factory runs coding work as cards on a board, each card's runs in their own worktree and branch, and opens a pull request for the change. Use create_card and start_run to delegate a task, get_status to follow it, send_message to steer a run, and answer_question when a run asks. Use handoff to move the work in progress in this checkout to a factory session: the run starts on that work, committed on its branch.";

/**
 * The server: the toolkit's handlers over the API's client, registered with an MCP server on stdio.
 * Built and held until stdin closes; the process is the client's child (module doc).
 */
export const mcpServerLayer = (options: McpOptions) =>
  McpServer.toolkit(FactoryToolkit).pipe(
    Layer.provide(
      FactoryToolkit.toLayer(
        Effect.gen(function* () {
          const { client } = yield* BoardClient;
          // What `handoff` reads the checkout with, captured once so each call runs with it.
          const services = yield* Effect.context<
            | ChildProcessSpawner.ChildProcessSpawner
            | FileSystem.FileSystem
            | Path.Path
          >();
          const handlers = mcpHandlers(client, options);
          return FactoryToolkit.of({
            create_card: handlers.create_card,
            start_run: handlers.start_run,
            send_message: handlers.send_message,
            get_status: handlers.get_status,
            answer_question: handlers.answer_question,
            handoff: (params) =>
              handlers.handoff(params).pipe(Effect.provide(services)),
          });
        }),
      ),
    ),
    Layer.provide(
      McpServer.layerStdio({
        name: "factory",
        version: "0.0.0",
        instructions: INSTRUCTIONS,
        protocols: PROTOCOLS,
      }),
    ),
    Layer.provide(BoardClient.layer(options.apiUrl)),
  );

export const mcpCommand = Command.make(
  "mcp",
  {
    repo: Flag.String("repo").pipe(
      Flag.withDescription(
        "The repository cards go on, owner/name (defaults to the one the checkout's remote names)",
      ),
      Flag.optional,
    ),
    dir: Flag.String("dir").pipe(
      Flag.withDescription(
        "The checkout `handoff` reads (defaults to the directory the server runs in)",
      ),
      Flag.withDefault("."),
    ),
    actor: Flag.String("actor").pipe(
      Flag.withDescription(
        "Who the cards, runs and answers are attributed to; ignored by a control plane that authenticates (FACTORY_API_TOKEN)",
      ),
      Flag.withSchema(SessionActor),
      Flag.withDefault("mcp"),
    ),
    api: Flag.String("api").pipe(
      Flag.withDescription("Control plane base URL"),
      Flag.optional,
    ),
  },
  Effect.fnUntraced(function* ({ repo, dir, actor, api }) {
    const apiUrl = yield* resolveApiUrl(api);
    const path = yield* Path.Path;
    const checkout = path.resolve(dir);
    const named = Option.getOrUndefined(repo);
    const slug =
      named === undefined
        ? yield* remoteRepo(checkout)
        : Option.getOrUndefined(Schema.decodeOption(RepoSlug)(named));
    if (named !== undefined && slug === undefined) {
      // Not the protocol's yet: nothing has been read from stdin, so a plain refusal is the answer.
      return yield* reportFailure(
        "invalid_input",
        `--repo "${named}" is not a repository (owner/name)`,
      );
    }
    return yield* Layer.launch(
      mcpServerLayer({ apiUrl, repo: slug, dir: checkout, actor }),
    ).pipe(Effect.provideService(Logger.LogToStderr, true));
  }),
).pipe(
  Command.withDescription(
    "Serve the factory to a local agent as an MCP server on stdio",
  ),
  Command.withExamples([
    {
      command: "claude mcp add factory -- factory mcp --api http://localhost:9000",
      description:
        "Claude Code launches it in the checkout: create_card, start_run, send_message, get_status, answer_question, handoff",
    },
  ]),
);
