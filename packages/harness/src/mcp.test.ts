/**
 * MCP tools for the agent (S-agent-mcp-tools), through a real harness against a fake remote MCP
 * server on loopback (`./mcpFake`), never a real one.
 *
 * Each acceptance criterion is a case that fails if its half of the code is removed:
 *
 * - A read tool the repository allows is offered, runs unattended, and its call and its answer are
 *   in the transcript — and the fake saw the call, with the bearer token the control plane handed
 *   the client (so a client that dropped the header, or a tool that answered without calling the
 *   server, fails it).
 * - A write tool on that server asks a person (`mcpPolicy`): the asker is called with the call's
 *   request id and the server reaches no call; a denial is the blocked call's result, naming who
 *   denied it; an approval runs it once.
 * - A server the repository does not allow, and a tool it does not list, are not offered: the model's
 *   request does not carry them, a call to one is the harness's unknown-tool result, and the fake
 *   records no call to it.
 *
 * Around them: the grants and the widening are decisions in a table; a read-only stage is offered
 * reads only; a read the repository gates asks; a server that cannot be reached at open is a problem
 * and not a failed open; `tools/list` is read page by page; and the open records what it offered.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolCall } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { Effect, Exit } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TranscriptEntry } from "@repo/domain/Session";
import type { RunProfile } from "./loader";
import {
  connectMcp,
  mcpGrants,
  mcpPolicy,
  mcpToolName,
  parseMcpServers,
  type McpServerAccess,
} from "./mcp";
import { startFakeMcpServer, type FakeMcpServer } from "./mcpFake";
import type { ModelAccess } from "./models";
import {
  approvalRequestId,
  autonomyPolicy,
  DEFAULT_AUTONOMY,
  repoPolicyWidening,
  type ApprovalAnswer,
  type ApprovalAsk,
  type ApprovalAsker,
  type McpServerDeclaration,
} from "./policy";
import { projectView } from "./projection";
import {
  closeHarness,
  openSession,
  readPolicyRecord,
  submitMessage,
} from "./session";

const TOKEN = "Bearer mcp-token-for-tests";

const READ = "get_issue";
const WRITE = "update_issue";
const UNLISTED = "delete_issue";

let fake: FakeMcpServer;

beforeAll(async () => {
  fake = await startFakeMcpServer({
    servers: {
      tracker: [
        {
          name: READ,
          description: "Read one issue.",
          readOnly: true,
          inputSchema: {
            type: "object",
            properties: { id: { type: "string" } },
            required: ["id"],
          },
          answer: (args) => `issue ${String(args["id"])}: the login page 500s`,
        },
        {
          name: WRITE,
          description: "Change an issue's state.",
          inputSchema: {
            type: "object",
            properties: { id: { type: "string" }, state: { type: "string" } },
            required: ["id", "state"],
          },
          answer: (args) =>
            `issue ${String(args["id"])} is ${String(args["state"])}`,
        },
        { name: UNLISTED, description: "Delete an issue." },
      ],
      rogue: [{ name: READ, readOnly: true }],
    },
    // Two tools a page: the three tracker tools take two pages to list.
    pageSize: 2,
  });
});

afterAll(async () => {
  await fake.close();
});

const tracker = (
  overrides: Partial<McpServerAccess> = {},
): McpServerAccess => ({
  name: "tracker",
  url: `${fake.url}/tracker`,
  tools: [READ, WRITE],
  approvalRequired: [],
  headers: { Authorization: TOKEN },
  ...overrides,
});

const READ_NAME = mcpToolName("tracker", READ);
const WRITE_NAME = mcpToolName("tracker", WRITE);

/**
 * A model that makes the calls given, one response each, then answers `done` — and records the tools
 * every request offered.
 */
const scripted = (
  calls: readonly {
    readonly name: string;
    readonly args: Record<string, string>;
  }[],
): { readonly access: ModelAccess; readonly offered: string[][] } => {
  const models = createModels();
  const faux = fauxProvider();
  models.setProvider(faux.provider);
  const offered: string[][] = [];
  let next = 0;
  const step: FauxResponseFactory = (context) => {
    faux.appendResponses([step]);
    // The tools in effect: every system message's additions and removals, replayed in order.
    const tools = new Set<string>();
    for (const message of context.messages) {
      if (message.role !== "system") continue;
      for (const tool of message.toolsAdded ?? []) tools.add(tool.name);
      for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
    }
    offered.push([...tools]);
    const call = calls[next];
    if (call === undefined) return fauxAssistantMessage("done");
    next += 1;
    return fauxAssistantMessage(fauxToolCall(call.name, call.args), {
      stopReason: "toolUse",
    });
  };
  faux.setResponses([step]);
  return {
    access: {
      backend: "faux",
      models,
      provider: "faux",
      modelId: faux.models[0].id,
      contextWindow: faux.models[0].contextWindow,
    },
    offered,
  };
};

const recordingAsker = (
  answer: (ask: ApprovalAsk) => ApprovalAnswer,
): { readonly asks: ApprovalAsk[]; readonly ask: ApprovalAsker } => {
  const asks: ApprovalAsk[] = [];
  return {
    asks,
    ask: (ask) =>
      Effect.sync(() => {
        asks.push(ask);
        return answer(ask);
      }),
  };
};

const pending = (ask: ApprovalAsk): ApprovalAnswer => ({
  _tag: "pending",
  requestId: ask.requestId,
  fresh: true,
});

/** One turn to idle: its transcript, the tools each request offered, and the storage it wrote. */
const turn = async (options: {
  readonly calls: readonly {
    readonly name: string;
    readonly args: Record<string, string>;
  }[];
  readonly mcp: readonly McpServerAccess[];
  readonly ask?: ApprovalAsker;
  readonly run?: RunProfile;
}) => {
  const worktree = mkdtempSync(join(tmpdir(), "factory-mcp-"));
  const model = scripted(options.calls);
  const storage = new MemoryStorage();
  const opened = await Effect.runPromise(
    openSession({
      storage,
      model: model.access,
      cwd: worktree,
      policy: autonomyPolicy(DEFAULT_AUTONOMY, worktree),
      policyRecord: {
        source: null,
        repo: { approvalRequired: [], denied: [] },
      },
      mcp: options.mcp,
      ...(options.ask === undefined ? {} : { approvalAsker: options.ask }),
      ...(options.run === undefined ? {} : { run: options.run }),
    }),
  );
  const submitted = await Effect.runPromise(
    submitMessage(opened.root, { content: "go", requestId: "mcp" }),
  );
  const settled = await submitted.submission.wait(BACKGROUND_CONTEXT);
  expect(settled.status).toBe("done");
  const view = await opened.root.viewState(BACKGROUND_CONTEXT);
  const projection = projectView(view.value);
  view.dispose();
  const record = await Effect.runPromise(readPolicyRecord(storage));
  await Effect.runPromise(closeHarness(opened.harness));
  await Effect.runPromise(opened.releaseEnvironment);
  return { entries: projection.entries, offered: model.offered, record };
};

const results = (entries: readonly TranscriptEntry[]) =>
  entries.filter((entry) => entry.kind === "toolResult");

const callsTo = (path: string, tool: string) =>
  fake.calls.filter((call) => call.path === path && call.tool === tool);

describe("which servers and tools a session is granted", () => {
  const declared: McpServerDeclaration[] = [
    {
      name: "tracker",
      url: "http://127.0.0.1:1/tracker",
      secret: "TRACKER_TOKEN",
    },
    { name: "docs", url: "http://127.0.0.1:1/docs" },
  ];

  it("grants only the registered servers the repository names, with the tools it lists", () => {
    expect(
      mcpGrants(declared, {
        tracker: { tools: [READ], approvalRequired: [READ] },
        // Not registered: a widening the policy's read refuses, and grants nothing here.
        rogue: { tools: [READ], approvalRequired: [] },
      }),
    ).toEqual([
      {
        name: "tracker",
        url: "http://127.0.0.1:1/tracker",
        secret: "TRACKER_TOKEN",
        tools: [READ],
        approvalRequired: [READ],
      },
    ]);
  });

  it("grants nothing to a repository that names no server, or a server with no tools", () => {
    expect(mcpGrants(declared, undefined)).toEqual([]);
    expect(
      mcpGrants(declared, { docs: { tools: [], approvalRequired: [] } }),
    ).toEqual([]);
    // A name inherited from Object's prototype is not a server the repository named.
    expect(
      mcpGrants([{ name: "constructor", url: "http://127.0.0.1:1/c" }], {}),
    ).toEqual([]);
  });

  it("is a widening to name a server the deployment does not register", () => {
    const config = { ...DEFAULT_AUTONOMY, mcpServers: declared };
    expect(
      repoPolicyWidening(config, {
        approvalRequired: [],
        denied: [],
        mcp: { tracker: { tools: [READ], approvalRequired: [] } },
      }),
    ).toEqual([]);
    expect(
      repoPolicyWidening(config, {
        approvalRequired: [],
        denied: [],
        mcp: { rogue: { tools: [READ], approvalRequired: [] } },
      }),
    ).toEqual([
      "mcp names server rogue, which this deployment does not register (it registers tracker, docs)",
    ]);
    expect(
      repoPolicyWidening(DEFAULT_AUTONOMY, {
        approvalRequired: [],
        denied: [],
        mcp: { tracker: { tools: [READ], approvalRequired: [] } },
      }),
    ).toEqual([
      "mcp names server tracker, which this deployment does not register (it registers no MCP server)",
    ]);
  });

  it("names a tool the way every provider accepts", () => {
    expect(mcpToolName("tracker", "issues.get")).toBe(
      "mcp__tracker__issues_get",
    );
  });
});

describe("the MCP gate in the policy", () => {
  const call = (name: string): ToolCall => ({
    type: "toolCall",
    id: "call_1",
    name,
    arguments: { id: "ISS-1", state: "done" },
  });
  const policy = mcpPolicy(
    autonomyPolicy(DEFAULT_AUTONOMY, "/work/ses_1"),
    new Map([[WRITE_NAME, "tracker/update_issue (MCP)"]]),
  );

  it("asks about a gated tool's call, under the call's own request id", () => {
    expect(Effect.runSync(policy.decide(call(WRITE_NAME)))).toEqual({
      _tag: "ask",
      requestId: approvalRequestId(call(WRITE_NAME)),
      action: "tracker/update_issue (MCP)",
      detail: `${WRITE_NAME} {"id":"ISS-1","state":"done"}`,
    });
  });

  it("lets every other call through to the wrapped policy", () => {
    expect(Effect.runSync(policy.decide(call(READ_NAME)))._tag).toBe("allow");
    // A refusal of the wrapped policy is never turned into an ask.
    const refused = Effect.runSync(
      policy.decide({
        type: "toolCall",
        id: "call_2",
        name: "bash",
        arguments: { command: "git push --force origin main" },
      }),
    );
    expect(refused._tag).toBe("block");
  });
});

describe("MCP tools in a real harness", () => {
  it("offers an allowed read tool, runs it unattended, and the call is in the transcript", async () => {
    const before = callsTo("/tracker", READ).length;
    const asker = recordingAsker(pending);
    const { entries, offered } = await turn({
      calls: [{ name: READ_NAME, args: { id: "ISS-7" } }],
      mcp: [tracker()],
      ask: asker.ask,
    });

    expect(offered[0]).toEqual(expect.arrayContaining([READ_NAME, WRITE_NAME]));
    // The call is the assistant's, the answer the tool result after it.
    const call = entries.find(
      (entry) =>
        entry.kind === "assistant" &&
        entry.toolCalls.some((ref) => ref.name === READ_NAME),
    );
    expect(call).toBeDefined();
    expect(results(entries)[0]).toMatchObject({
      toolName: READ_NAME,
      isError: false,
      text: "issue ISS-7: the login page 500s",
    });
    // Unattended: nobody was asked, and the server got the call with the token the client holds.
    expect(asker.asks).toEqual([]);
    const reached = callsTo("/tracker", READ).slice(before);
    expect(reached).toEqual([
      {
        path: "/tracker",
        tool: READ,
        arguments: { id: "ISS-7" },
        authorization: TOKEN,
      },
    ]);
  });

  it("asks a person before a write tool runs, and the server sees no call while it waits", async () => {
    const before = callsTo("/tracker", WRITE).length;
    const asker = recordingAsker(pending);
    const args = { id: "ISS-7", state: "done" };
    const { entries } = await turn({
      calls: [{ name: WRITE_NAME, args }],
      mcp: [tracker()],
      ask: asker.ask,
    });

    const requestId = approvalRequestId({
      type: "toolCall",
      id: "any",
      name: WRITE_NAME,
      arguments: args,
    });
    expect(asker.asks).toEqual([
      {
        requestId,
        action: "tracker/update_issue (MCP)",
        detail: `${WRITE_NAME} {"id":"ISS-7","state":"done"}`,
      },
    ]);
    const result = results(entries)[0];
    expect(result?.isError).toBe(true);
    expect(result?.text).toContain("one has been asked for");
    expect(callsTo("/tracker", WRITE).length).toBe(before);
  });

  it("tells the agent a write was denied, and never sends it", async () => {
    const before = callsTo("/tracker", WRITE).length;
    const asker = recordingAsker((ask) => ({
      _tag: "denied",
      requestId: ask.requestId,
      actor: "ops@example",
    }));
    const { entries } = await turn({
      calls: [{ name: WRITE_NAME, args: { id: "ISS-7", state: "done" } }],
      mcp: [tracker()],
      ask: asker.ask,
    });

    const result = results(entries)[0];
    expect(result?.isError).toBe(true);
    expect(result?.text).toContain(
      "`tracker/update_issue (MCP)` was denied by ops@example",
    );
    expect(result?.text).toContain("Do not retry it");
    expect(callsTo("/tracker", WRITE).length).toBe(before);
  });

  it("runs an approved write once", async () => {
    const before = callsTo("/tracker", WRITE).length;
    const asker = recordingAsker((ask) => ({
      _tag: "approved",
      requestId: ask.requestId,
      actor: "ops@example",
    }));
    const { entries } = await turn({
      calls: [{ name: WRITE_NAME, args: { id: "ISS-7", state: "done" } }],
      mcp: [tracker()],
      ask: asker.ask,
    });

    expect(results(entries)[0]).toMatchObject({
      isError: false,
      text: "issue ISS-7 is done",
    });
    expect(callsTo("/tracker", WRITE).slice(before)).toHaveLength(1);
  });

  it("does not offer a server the repository does not allow, nor a tool it does not list", async () => {
    const rogue = mcpToolName("rogue", READ);
    const unlisted = mcpToolName("tracker", UNLISTED);
    const before = fake.calls.length;
    // The deployment registers both servers; the repository allows only the tracker's two tools.
    const granted = mcpGrants(
      [
        { name: "tracker", url: `${fake.url}/tracker` },
        { name: "rogue", url: `${fake.url}/rogue` },
      ],
      { tracker: { tools: [READ, WRITE], approvalRequired: [] } },
    );
    expect(granted.map((server) => server.name)).toEqual(["tracker"]);
    const { entries, offered } = await turn({
      calls: [
        { name: rogue, args: {} },
        { name: unlisted, args: {} },
      ],
      mcp: granted,
    });

    for (const tools of offered) {
      expect(tools).not.toContain(rogue);
      expect(tools).not.toContain(unlisted);
      expect(tools).toContain(READ_NAME);
    }
    const [first, second] = results(entries);
    expect(first).toMatchObject({ toolName: rogue, isError: true });
    expect(second).toMatchObject({ toolName: unlisted, isError: true });
    expect(first?.text).not.toContain("the login page");
    // Nothing reached either server for them.
    expect(fake.calls.slice(before)).toEqual([]);
  });

  it("offers a read-only stage the reads only", async () => {
    const { offered } = await turn({
      calls: [],
      mcp: [tracker()],
      run: { column: "specifying", role: "specifier", skills: [] },
    });
    expect(offered[0]).toContain(READ_NAME);
    expect(offered[0]).not.toContain(WRITE_NAME);
  });

  it("asks about a read the repository gates", async () => {
    const asker = recordingAsker(pending);
    const before = callsTo("/tracker", READ).length;
    await turn({
      calls: [{ name: READ_NAME, args: { id: "ISS-7" } }],
      mcp: [tracker({ approvalRequired: [READ] })],
      ask: asker.ask,
    });
    expect(asker.asks.map((ask) => ask.action)).toEqual([
      "tracker/get_issue (MCP)",
    ]);
    expect(callsTo("/tracker", READ).length).toBe(before);
  });

  it("records what the open offered in the policy record", async () => {
    const { record } = await turn({ calls: [], mcp: [tracker()] });
    expect(record?.effective.mcpTools).toEqual([
      { name: READ_NAME, server: "tracker", tool: READ, gated: false },
      { name: WRITE_NAME, server: "tracker", tool: WRITE, gated: true },
    ]);
  });
});

describe("connecting at open", () => {
  it("reads every page of the tool list", async () => {
    const connection = await Effect.runPromise(
      connectMcp([tracker({ tools: [READ, WRITE, UNLISTED] })], {
        readOnly: false,
      }),
    );
    await Effect.runPromise(connection.close);
    // Three tools at two a page: the third is on the second page.
    expect(connection.offered.map((tool) => tool.tool)).toEqual([
      READ,
      WRITE,
      UNLISTED,
    ]);
    // A tool the server does not annotate as a read is a write.
    expect(connection.gates.has(mcpToolName("tracker", UNLISTED))).toBe(true);
  });

  it("names a tool the repository allows that the server does not list", async () => {
    const connection = await Effect.runPromise(
      connectMcp([tracker({ tools: [READ, "no_such_tool"] })], {
        readOnly: false,
      }),
    );
    await Effect.runPromise(connection.close);
    expect(connection.offered.map((tool) => tool.tool)).toEqual([READ]);
    expect(connection.problems).toEqual([
      "the repository allows tool no_such_tool of MCP server tracker, which the server does not list",
    ]);
  });

  it("opens without a server that cannot be reached, and offers none of its tools", async () => {
    const down = await startFakeMcpServer({ servers: {} });
    const url = `${down.url}/tracker`;
    await down.close();
    const { offered } = await turn({
      calls: [],
      mcp: [tracker({ url })],
    });
    expect(offered[0]).not.toContain(READ_NAME);
    const connection = await Effect.runPromise(
      connectMcp([tracker({ url })], { readOnly: false }),
    );
    expect(connection.extension).toBeUndefined();
    expect(connection.problems[0]).toContain(
      `MCP server tracker (${url}) could not be reached, so none of its tools is offered`,
    );
  });
});

describe("MCP_SERVERS, as a deployment writes it", () => {
  const parsed = (text: string) => Effect.runPromiseExit(parseMcpServers(text));
  const refused = async (text: string) => {
    const exit = await parsed(text);
    if (Exit.isSuccess(exit)) throw new Error("expected a refusal");
    const failure = exit.cause.reasons[0];
    if (failure?._tag !== "Fail") throw new Error("expected a typed failure");
    return failure.error;
  };

  it("reads a JSON list of registrations, and blank as none", async () => {
    expect(await Effect.runPromise(parseMcpServers("  "))).toEqual([]);
    expect(
      await Effect.runPromise(
        parseMcpServers(
          JSON.stringify([
            {
              name: "tracker",
              url: "https://mcp.example/mcp",
              secret: "TRACKER_TOKEN",
            },
            { name: "local", url: "http://127.0.0.1:9511/local" },
          ]),
        ),
      ),
    ).toEqual([
      {
        name: "tracker",
        url: "https://mcp.example/mcp",
        secret: "TRACKER_TOKEN",
      },
      { name: "local", url: "http://127.0.0.1:9511/local" },
    ]);
  });

  it.each([
    ["not JSON", "tracker=https://mcp.example", "not a JSON array"],
    [
      "an unknown key",
      JSON.stringify([{ name: "a", url: "https://x.example", token: "t" }]),
      "not a JSON array",
    ],
    [
      "a bad name",
      JSON.stringify([{ name: "Tracker", url: "https://x.example" }]),
      "is not lower-case",
    ],
    [
      "a name twice",
      JSON.stringify([
        { name: "a", url: "https://x.example" },
        { name: "a", url: "https://y.example" },
      ]),
      "registered twice",
    ],
    [
      "plain http off loopback",
      JSON.stringify([{ name: "a", url: "http://x.example/mcp" }]),
      "not an https URL",
    ],
    [
      "a secret that is not a secret's name",
      JSON.stringify([
        { name: "a", url: "https://x.example", secret: "lower" },
      ]),
      "not a JSON array",
    ],
  ])("refuses %s", async (_case, text, message) => {
    const error = await refused(text);
    expect(error._tag).toBe("InvalidMcpServers");
    expect(error.message).toContain(message);
  });
});
