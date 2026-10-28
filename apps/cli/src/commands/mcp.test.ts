/**
 * `factory mcp` (S-local-agent-handoff-mcp): the tools over an in-memory board, and the process a
 * local agent launches, spoken to over stdio the way an MCP client speaks to it.
 *
 * The handlers are driven against a fake `McpClient` — a board, its cards, their runs and threads
 * in memory — so what each tool sends and answers is asserted call by call. The process half spawns
 * the real command (`bun src/index.ts mcp`) and runs the MCP handshake over its stdin and stdout:
 * `initialize` at the revisions clients send, `tools/list`, and a `tools/call`, asserting that every
 * line on stdout is a JSON-RPC message and that a control plane that does not answer is a tool
 * result naming it. The control plane end to end is `.pi/skills/verify-cli/mcp.sh`'s.
 */
import { BunServices } from "@effect/platform-bun";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { SessionError } from "@repo/domain/Session";
import type { SessionId } from "@repo/domain/Session";
import {
  MAX_HANDOFF_PATCH_BYTES,
  type CreateTaskInput,
  type Task,
  type TaskComment,
  type TaskRun,
} from "@repo/domain/Task";
import { afterAll, describe, expect, it } from "vitest";
import { type McpClient, mcpHandlers, type McpOptions } from "./mcp";

const BOARD = "brd_01aaaaaaaaaaaaaaaaaaaaaaaa";
const TASK = "tsk_01bbbbbbbbbbbbbbbbbbbbbbbb";
const SESSION = "ses_01cccccccccccccccccccccccc";
const API = "http://127.0.0.1:9";

const card = (over: Partial<Task> = {}): Task =>
  ({
    id: TASK,
    boardId: BOARD,
    title: "build the widget",
    column: "building",
    repo: "acme/widget",
    definitionVersion: 6,
    revision: 3,
    priority: "normal",
    createdAt: "2026-10-28T00:00:00.000Z",
    updatedAt: "2026-10-28T00:00:00.000Z",
    ...over,
  }) as Task;

/** An in-memory control plane: what each call was given, and what it answers. */
const fake = (
  over: {
    readonly task?: Task;
    readonly runs?: ReadonlyArray<TaskRun>;
    readonly comments?: ReadonlyArray<TaskComment>;
    readonly fail?: unknown;
  } = {},
) => {
  const created: Array<CreateTaskInput> = [];
  const comments: Array<{ expectedRevision: number; body: string }> = [];
  const sessions: Array<{ taskId: string; taskColumn: string }> = [];
  const sent: Array<{ sessionId: string; content: string; whenBusy?: string }> =
    [];
  let task = over.task ?? card();
  const failing = <A>(value: () => A) =>
    over.fail === undefined
      ? Effect.sync(value)
      : Effect.fail(over.fail as SessionError);
  const client: McpClient<SessionError, SessionError> = {
    listBoards: () =>
      failing(() => [
        {
          id: "brd_01dddddddddddddddddddddddd" as never,
          repo: "acme/other" as never,
        },
        { id: BOARD as never, repo: "acme/widget" as never },
      ]),
    createTask: (input) =>
      failing(() => {
        created.push(input);
        task = card({
          title: input.title,
          column: "intake",
          revision: 1,
          ...(input.body === undefined ? {} : { body: input.body }),
        });
        return task;
      }),
    getTask: () => failing(() => task),
    getBoard: () =>
      Effect.succeed({
        instance: { definitionId: "default" as never },
        definition: { version: 6, columns: [] },
      }),
    getDefinition: () => Effect.succeed({ columns: [] }),
    createSession: (input) =>
      Effect.sync(() => {
        sessions.push({ taskId: input.taskId, taskColumn: input.taskColumn });
        return { id: SESSION as SessionId };
      }),
    getSession: () =>
      Effect.succeed({
        session: {
          id: SESSION as SessionId,
          title: "build the widget",
          status: "idle" as const,
          mode: "live" as never,
          createdAt: "2026-10-28T00:00:00.000Z",
          prUrl: "https://github.com/acme/widget/pull/7",
        },
        workspace: {
          path: "/tmp/w",
          commands: {},
          commandsSource: "none" as never,
        },
        entries: [
          { id: "1", kind: "user" as const, text: "go", toolCalls: [] },
          {
            id: "2",
            kind: "assistant" as const,
            text: "Done: the retry loop is in.",
            toolCalls: [],
          },
        ],
        approvals: [],
      }),
    sendMessage: (input) =>
      Effect.sync(() => {
        sent.push(input);
        return {
          placement: "followUp" as const,
          session: { status: "busy" as const } as never,
        };
      }),
    listTaskRuns: () =>
      Effect.succeed(
        over.runs ?? [
          {
            id: "run",
            taskId: TASK as never,
            sessionId: SESSION as SessionId,
            column: "building",
            startedAt: "2026-10-28T00:00:00.000Z",
          },
        ],
      ),
    listTaskComments: () => Effect.succeed(over.comments ?? []),
    commentTask: (input) =>
      Effect.sync(() => {
        comments.push({
          expectedRevision: input.expectedRevision,
          body: input.body,
        });
        const { blocked: _lifted, ...unblocked } = task;
        task = { ...unblocked, revision: task.revision + 1 };
        return task;
      }),
  };
  return { client, created, comments, sessions, sent };
};

const options = (over: Partial<McpOptions> = {}): McpOptions => ({
  apiUrl: API,
  repo: "acme/widget" as never,
  dir: ".",
  actor: "mcp",
  ...over,
});

const run = <A, E>(effect: Effect.Effect<A, E, never>) =>
  Effect.runPromise(effect);
const refused = <A, E>(effect: Effect.Effect<A, E, never>) =>
  Effect.runPromise(Effect.flip(effect));

describe("the MCP tools (S-local-agent-handoff-mcp)", () => {
  /**
   * The acceptance's first half at the handler: a card made on the server's repository's board.
   * Mutations this catches: put the card on the first board listed — `acme/other`'s; drop the
   * server's actor or repo from the create; answer a card the create did not return.
   */
  it("create_card puts the card on the repository's board and answers its id, column and revision", async () => {
    const f = fake();
    const result = await run(
      mcpHandlers(f.client, options()).create_card({
        title: "  Pin the Postgres major ",
        body: "Compose names one major.",
      }),
    );
    expect(f.created).toEqual([
      {
        boardId: BOARD,
        title: "Pin the Postgres major",
        repo: "acme/widget",
        body: "Compose names one major.",
        actor: "mcp",
      },
    ]);
    expect(result).toEqual({
      taskId: TASK,
      boardId: BOARD,
      column: "intake",
      revision: 1,
      text: `card ${TASK} "Pin the Postgres major" is on board ${BOARD} in intake (revision 1): start its run with start_run`,
    });
  });

  it("create_card with no repository to put it on is refused, naming how to give one", async () => {
    const f = fake();
    const error = await refused(
      mcpHandlers(f.client, options({ repo: undefined })).create_card({
        title: "x",
      }),
    );
    expect(error.message).toBe(
      "invalid_input: this server was started for no repository: name one with repo, or start it with `factory mcp --repo owner/name`",
    );
    expect(f.created).toEqual([]);
  });

  /**
   * The acceptance's second half: a card's status read back. Mutations this catches: read the
   * oldest run rather than the newest; drop the open question from a card blocked `needs_input`;
   * quote the user's message as the run's answer.
   */
  it("get_status reads a card's column, block, question and newest run's answer", async () => {
    const f = fake({
      task: card({
        blocked: {
          reason: "needs_input",
          column: "building",
          since: "2026-10-28T00:00:00.000Z",
        },
      }),
      comments: [
        {
          taskId: TASK as never,
          kind: "question",
          actor: SESSION,
          body: "Which Postgres major?",
          revision: 2,
          createdAt: "2026-10-28T00:00:00.000Z",
        },
      ],
    });
    const status = await run(
      mcpHandlers(f.client, options()).get_status({ taskId: TASK }),
    );
    expect(status).toEqual({
      text: [
        `card ${TASK} "build the widget" is in building (revision 3), blocked needs_input`,
        "its run asked: Which Postgres major?",
        "answer it with answer_question",
        `1 run; the newest is ${SESSION} in building`,
        `run ${SESSION} is idle, PR https://github.com/acme/widget/pull/7`,
        "last answer: Done: the retry loop is in.",
      ].join("\n"),
      taskId: TASK,
      column: "building",
      revision: 3,
      blocked: "needs_input",
      question: "Which Postgres major?",
      sessionId: SESSION,
      status: "idle",
      prUrl: "https://github.com/acme/widget/pull/7",
      lastAnswer: "Done: the retry loop is in.",
    });
  });

  it("get_status names exactly one of a card and a run, and decodes the id it is given", async () => {
    const handlers = mcpHandlers(fake().client, options());
    expect((await refused(handlers.get_status({}))).message).toBe(
      "invalid_input: name exactly one of taskId (a card) and sessionId (a run)",
    );
    expect(
      (await refused(handlers.get_status({ taskId: TASK, sessionId: SESSION })))
        .message,
    ).toContain("name exactly one");
    expect(
      (await refused(handlers.get_status({ taskId: "LOB-1" }))).message,
    ).toBe('invalid_input: taskId (tsk_…) "LOB-1" is not one');
    const runStatus = await run(handlers.get_status({ sessionId: SESSION }));
    expect(runStatus.status).toBe("idle");
    expect(runStatus.lastAnswer).toBe("Done: the retry loop is in.");
  });

  /**
   * Mutations this catches: comment on a card that is not waiting — the answer becomes a note; send
   * a stale revision; drop `start` — no run reads the answer.
   */
  it("answer_question answers a parked card at its revision, and start opens the run that reads it", async () => {
    const blocked = card({
      blocked: {
        reason: "needs_input",
        column: "building",
        since: "2026-10-28T00:00:00.000Z",
      },
    });
    const f = fake({ task: blocked });
    const answered = await run(
      mcpHandlers(f.client, options()).answer_question({
        taskId: TASK,
        answer: "Postgres 17.",
        start: true,
      }),
    );
    expect(f.comments).toEqual([{ expectedRevision: 3, body: "Postgres 17." }]);
    expect(f.sessions).toEqual([{ taskId: TASK, taskColumn: "building" }]);
    expect(answered.sessionId).toBe(SESSION);
    expect(answered.revision).toBe(4);
    expect(answered.text).toContain(`answered: ${TASK} is no longer blocked`);

    const idle = fake();
    const notWaiting = await refused(
      mcpHandlers(idle.client, options()).answer_question({
        taskId: TASK,
        answer: "x",
      }),
    );
    expect(notWaiting.message).toBe(
      `invalid_input: ${TASK} is not waiting on an answer (it is not blocked): nothing was written`,
    );
    expect(idle.comments).toEqual([]);
  });

  it("start_run opens a run on the card and send_message steers it", async () => {
    const f = fake();
    const handlers = mcpHandlers(f.client, options());
    const started = await run(handlers.start_run({ taskId: TASK }));
    expect(started.sessionId).toBe(SESSION);
    expect(f.sessions).toEqual([{ taskId: TASK, taskColumn: "building" }]);
    expect(f.sent[0]?.content).toContain("build the widget");
    const sent = await run(
      handlers.send_message({
        sessionId: SESSION,
        content: "also the docs",
        whenBusy: "steer",
      }),
    );
    expect(f.sent[1]).toEqual({
      sessionId: SESSION,
      content: "also the docs",
      whenBusy: "steer",
    });
    expect(sent.text).toBe(
      `sent to ${SESSION}: it is busy, so the message joined its follow-up queue`,
    );
  });

  /**
   * Mutations this catches: pass the RPC client's own `rpc_client_error: HttpError` through — the
   * agent is not told where the control plane was looked for; drop a refusal's code.
   */
  it("says a control plane that does not answer is unreachable, and keeps a refusal's code", async () => {
    const down = fake({
      fail: { _tag: "RpcClientError", message: "HttpError: " },
    });
    expect(
      (
        await refused(
          mcpHandlers(down.client, options()).get_status({ taskId: TASK }),
        )
      ).message,
    ).toBe(
      `unreachable: the factory control plane at ${API} did not answer (HttpError): start it, or point this server at it with --api or FACTORY_API_URL`,
    );
    const missing = fake({
      fail: new SessionError({ code: "not_found", message: `no task ${TASK}` }),
    });
    expect(
      (
        await refused(
          mcpHandlers(missing.client, options()).get_status({ taskId: TASK }),
        )
      ).message,
    ).toBe(`not_found: no task ${TASK}`);
  });
});

const git = (cwd: string, args: ReadonlyArray<string>): string =>
  execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "mcp",
      GIT_AUTHOR_EMAIL: "mcp@localhost",
      GIT_COMMITTER_NAME: "mcp",
      GIT_COMMITTER_EMAIL: "mcp@localhost",
    },
  }).trim();

/** A checkout whose remote is named like a GitHub repository, with work in progress on a branch. */
const checkout = () => {
  const remote = mkdtempSync(join(tmpdir(), "factory-mcp-remote-"));
  const local = mkdtempSync(join(tmpdir(), "factory-mcp-local-"));
  git(remote, ["init", "-q", "--bare", "-b", "main"]);
  git(local, ["init", "-q", "-b", "main"]);
  writeFileSync(join(local, "README.md"), "mcp\n");
  git(local, ["add", "-A"]);
  git(local, ["commit", "-q", "-m", "init"]);
  git(local, ["remote", "add", "origin", remote]);
  git(local, ["push", "-q", "origin", "main"]);
  git(local, ["remote", "set-head", "origin", "main"]);
  git(local, ["checkout", "-q", "-b", "feature/retry"]);
  return local;
};

describe("the handoff tool (S-local-agent-handoff-mcp)", () => {
  /**
   * Mutations this catches: make the card without the patch, or without the base its runs apply it
   * on; read a directory other than the server's checkout.
   */
  it("hands the server's checkout's work in progress to a card, and starts its run when asked", async () => {
    const local = checkout();
    writeFileSync(join(local, "notes.md"), "work in progress\n");
    const f = fake();
    const result = await Effect.runPromise(
      mcpHandlers(f.client, options({ dir: local }))
        .handoff({ note: "Finish the retry loop", start: true })
        .pipe(Effect.provide(BunServices.layer)),
    );
    expect(f.created).toHaveLength(1);
    expect(f.created[0]).toMatchObject({
      boardId: BOARD,
      title: "Finish the retry loop",
      repo: "acme/widget",
      baseRef: "main",
      actor: "mcp",
      handoff: {
        branch: "feature/retry",
        baseCommit: git(local, ["rev-parse", "origin/main"]),
      },
    });
    expect(f.created[0]?.handoff?.patch).toContain("+work in progress");
    expect(result.files).toEqual(["notes.md"]);
    expect(result.sessionId).toBe(SESSION);
    expect(f.sessions).toEqual([{ taskId: TASK, taskColumn: "intake" }]);
  }, 60_000);

  /** The cap's refusal reaches the agent as a tool result, and no card is made. */
  it("refuses an oversized diff in the cap's words, and makes no card", async () => {
    const local = checkout();
    writeFileSync(
      join(local, "big.txt"),
      `${"x".repeat(MAX_HANDOFF_PATCH_BYTES)}\n`,
    );
    const f = fake();
    const error = await Effect.runPromise(
      mcpHandlers(f.client, options({ dir: local }))
        .handoff({ note: "too big" })
        .pipe(Effect.flip, Effect.provide(BunServices.layer)),
    );
    expect(error.message).toMatch(
      new RegExp(
        `^handoff_refused: the handoff patch is \\d+ bytes, over the ${MAX_HANDOFF_PATCH_BYTES}-byte cap a card carries`,
      ),
    );
    expect(f.created).toEqual([]);
  }, 60_000);
});

const CLI = fileURLToPath(new URL("../index.ts", import.meta.url));

/** Every server spawned here, killed after the file in case one never hung up. */
const children: Array<ChildProcess> = [];
afterAll(() => {
  for (const child of children) child.kill("SIGKILL");
});

/**
 * Speak to a spawned `factory mcp` over stdio: write each message as one line, collect the lines it
 * writes, and hang up (close its stdin) once every request id in `answered` has its answer.
 */
const converse = async (
  messages: ReadonlyArray<Record<string, unknown>>,
  answered: ReadonlyArray<number>,
) => {
  const child = spawn(
    "bun",
    [CLI, "mcp", "--api", "http://127.0.0.1:9", "--repo", "acme/widget"],
    { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, MOTEL_URL: "" } },
  );
  children.push(child);
  const lines: Array<string> = [];
  let buffer = "";
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      lines.push(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
    }
    const ids = lines.flatMap((line) => {
      try {
        const id = (JSON.parse(line) as { id?: unknown }).id;
        return typeof id === "number" ? [id] : [];
      } catch {
        return [];
      }
    });
    // The client is done: closing stdin is how it hangs up, and the server goes with it.
    if (answered.every((id) => ids.includes(id))) child.stdin.end();
  });
  for (const message of messages) {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }
  const [exit] = (await once(child, "exit")) as [number | null];
  if (buffer.trim() !== "") lines.push(buffer);
  return { lines, exit };
};

describe("factory mcp, the process (S-local-agent-handoff-mcp)", () => {
  /**
   * Mutations this catches: log to stdout — a line that is not JSON-RPC; register no tools, or a
   * different set; answer only one protocol revision — the other client's initialize fails; let an
   * unreachable control plane crash the call instead of answering it.
   */
  it.each(["2025-06-18", "2025-11-25"])(
    "answers an MCP client at %s over stdio: initialize, tools/list, and a tool call",
    async (protocolVersion) => {
      const { lines, exit } = await converse(
        [
          {
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion,
              capabilities: {},
              clientInfo: { name: "claude-code", version: "2.1.312" },
            },
          },
          { jsonrpc: "2.0", method: "notifications/initialized" },
          { jsonrpc: "2.0", id: 2, method: "tools/list" },
          {
            jsonrpc: "2.0",
            id: 3,
            method: "tools/call",
            params: { name: "get_status", arguments: { taskId: TASK } },
          },
        ],
        [1, 2, 3],
      );
      const messages = lines.map(
        (line) =>
          JSON.parse(line) as {
            jsonrpc: string;
            id?: number;
            result?: Record<string, unknown>;
          },
      );
      expect(messages.every((message) => message.jsonrpc === "2.0")).toBe(true);
      const byId = (id: number) =>
        messages.find((message) => message.id === id)?.result;
      expect(byId(1)).toMatchObject({
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "factory" },
      });
      const listed = byId(2)?.["tools"] as
        | Array<{ readonly name: string }>
        | undefined;
      const tools = (listed ?? []).map((tool) => tool.name);
      expect(tools.sort()).toEqual([
        "answer_question",
        "create_card",
        "get_status",
        "handoff",
        "send_message",
        "start_run",
      ]);
      expect(byId(3)).toMatchObject({ isError: true });
      expect(JSON.stringify(byId(3))).toContain(
        "unreachable: the factory control plane at http://127.0.0.1:9 did not answer",
      );
      // Closing stdin ends it: the server is the client's child and does not outlive it.
      expect(exit).not.toBeNull();
    },
    60_000,
  );
});
