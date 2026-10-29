/**
 * MCP tools for the agent (S-agent-mcp-tools): the tools of a remote MCP server, offered to a run
 * as Pi Durable tools, allowlisted per repository and policed by the approval hook.
 *
 * **Who decides what.** Three parties, each able only to narrow what the one before it allows:
 *
 * - The deployment registers servers (`AutonomyConfig.mcpServers`, `MCP_SERVERS`): a name, a
 *   Streamable HTTP endpoint, and the repository secret its bearer token is read from. Registering a
 *   server offers nothing.
 * - A repository's `.factory/config` names, in its `policy.mcp` block read at the session's base
 *   (`@repo/core`'s `repoPolicy`), the registered servers its runs may call and the tools of each, by
 *   the server's own names (`RepoMcp`). A server it names that the deployment does not register is a
 *   widening, and the whole policy is refused. A registered server it does not name, and a tool it
 *   does not list, are never offered: the agent cannot call what it was not given.
 * - Each tool is a read or a write. A read runs unattended; a write asks a person on every call,
 *   through the policy's `beforeTool` hook (`mcpPolicy`, LOB-52's `askOnce`), so an approval covers
 *   one run of one call and a denial reaches the agent as the blocked call's result. A read is a tool
 *   whose server annotates it `readOnlyHint: true` — MCP's own default is `false`, so a tool the server
 *   says nothing about is a write — and the repository can make a read ask too (`approvalRequired`).
 *   Nothing makes a write unattended. A read-only stage (`./rolePolicy`) is offered reads only.
 *
 * **The control plane is the client.** The calls go from the control plane's process, not from the
 * sandbox: the token is a header on the client's own requests, resolved by the control plane, and
 * never enters the session's shell environment, its prompt or its log. The server's endpoint is
 * therefore not on the session's egress allowlist; the deployment's registration is its allowlist.
 *
 * **Not a boundary either (D15).** `readOnlyHint` is the server's word about its own tool. The
 * deployment chose to trust the server by registering it; a server that marks a write as a read
 * makes that write unattended, which is why the repository can gate any tool by name.
 *
 * The client is the official MCP TypeScript SDK's (`@modelcontextprotocol/sdk`, already in the tree
 * through `@google/genai` and pinned to the same version): Effect ships an MCP server and no client.
 * Its tools are listed once per open, so a tool the server added since reaches the next open and one
 * it removed is gone from it. A server that cannot be reached at open is a warning and offers no
 * tools for that open, never a failed open: the run goes on without it.
 */
import { Type } from "@earendil-works/pi-ai";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { Extension, ToolRegistration } from "@earendil-works/pi-durable";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
  ContentBlock,
  Tool as McpTool,
} from "@modelcontextprotocol/sdk/types.js";
import { Effect, Schema } from "effect";
import { SecretName } from "@repo/domain/Secret";
import {
  approvalRequestId,
  MCP_SERVER_NAME,
  type McpServerDeclaration,
  type RepoMcp,
  type RepoMcpServer,
  type SessionPolicy,
} from "./policy";

/** The extension the MCP tools are installed under. */
export const MCP_EXTENSION = "factory.mcp";

/** How long connecting to a server and listing its tools may take at open. */
export const MCP_CONNECT_TIMEOUT_MS = 15_000;

/** How long one tool call may take before it is reported failed. */
export const MCP_CALL_TIMEOUT_MS = 120_000;

/** The most pages of `tools/list` read from one server, so a server that never ends its list cannot hold an open. */
const MAX_LIST_PAGES = 20;

/** A name every provider accepts for a tool (OpenAI's is the narrowest: 64 characters). */
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The name a server's tool is offered under: `mcp__<server>__<tool>`, with any character a provider
 * would refuse read as `_` (MCP allows `.` in a tool's name, no provider does).
 */
export const mcpToolName = (server: string, tool: string): string =>
  `mcp__${server}__${tool.replace(/[^A-Za-z0-9_-]/g, "_")}`;

/** A deployment's `MCP_SERVERS` that is not a list of servers it can register. */
export class InvalidMcpServers extends Schema.TaggedError<InvalidMcpServers>()(
  "InvalidMcpServers",
  { message: Schema.String },
) {}

const McpServersJson = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      name: Schema.String,
      url: Schema.String,
      secret: Schema.optional(SecretName),
    }),
  ),
);

const isLoopback = (host: string): boolean =>
  host === "localhost" || host === "[::1]" || /^127(\.\d{1,3}){3}$/.test(host);

/**
 * Read the deployment's registrations as it writes them (`MCP_SERVERS`): a JSON array of
 * `{ "name", "url", "secret"? }`. Blank is no server. A name that is not `MCP_SERVER_NAME`'s shape
 * or is given twice, a URL that does not parse or is not `https` — plain `http` only on loopback,
 * since the bearer token rides on every request — a secret that is not a secret's name, and an
 * unknown key are refused rather than guessed at, so a typo fails the boot rather than every run.
 */
export const parseMcpServers = (
  text: string,
): Effect.Effect<readonly McpServerDeclaration[], InvalidMcpServers> =>
  Effect.gen(function* () {
    if (text.trim().length === 0) return [];
    const declared = yield* Schema.decodeEffect(McpServersJson)(text, {
      onExcessProperty: "error",
    }).pipe(
      Effect.mapError(
        (error) =>
          new InvalidMcpServers({
            message: `MCP_SERVERS is not a JSON array of { name, url, secret? }: ${error.message.replace(/\n\s*/g, " ")}`,
          }),
      ),
    );
    const seen = new Set<string>();
    for (const server of declared) {
      if (!MCP_SERVER_NAME.test(server.name))
        return yield* new InvalidMcpServers({
          message: `MCP server name "${server.name}" is not lower-case letters, digits and dashes (at most 24)`,
        });
      if (seen.has(server.name))
        return yield* new InvalidMcpServers({
          message: `MCP server ${server.name} is registered twice`,
        });
      seen.add(server.name);
      const url = URL.canParse(server.url) ? new URL(server.url) : undefined;
      if (
        url === undefined ||
        !(
          url.protocol === "https:" ||
          (url.protocol === "http:" && isLoopback(url.hostname))
        )
      )
        return yield* new InvalidMcpServers({
          message: `MCP server ${server.name}: ${server.url} is not an https URL (plain http is allowed on loopback only)`,
        });
    }
    return declared.map((server) =>
      server.secret === undefined
        ? { name: server.name, url: server.url }
        : { name: server.name, url: server.url, secret: server.secret },
    );
  });

/** One registered server as a session may reach it: the deployment's half and the repository's. */
export type McpServerGrant = McpServerDeclaration & RepoMcpServer;

/**
 * The servers a repository's allowlist grants of the ones the deployment registers, in the
 * deployment's order. A server the repository does not name is not granted, nor is one it names
 * with no tools; a name the deployment does not register grants nothing (it is a widening the
 * policy's read refuses, `repoPolicyWidening`, and a pinned policy may still hold one).
 */
export const mcpGrants = (
  declared: readonly McpServerDeclaration[],
  repo: RepoMcp | undefined,
): readonly McpServerGrant[] =>
  declared.flatMap((server) => {
    const allowed =
      repo !== undefined && Object.hasOwn(repo, server.name)
        ? repo[server.name]
        : undefined;
    return allowed === undefined || allowed.tools.length === 0
      ? []
      : [
          {
            ...server,
            tools: allowed.tools,
            approvalRequired: allowed.approvalRequired,
          },
        ];
  });

/** A grant as an open connects to it: with the headers the control plane resolved for it. */
export type McpServerAccess = McpServerGrant & {
  /**
   * Headers every request to the server carries — the bearer token read from the repository's
   * secret. Held by the client alone: never logged, never in the shell environment.
   */
  readonly headers?: Readonly<Record<string, string>> | undefined;
};

/** One tool an open offered the agent, as the policy record names it. */
export type McpOfferedTool = {
  /** The name the agent calls it by (`mcpToolName`). */
  readonly name: string;
  readonly server: string;
  /** The server's own name for it. */
  readonly tool: string;
  /** Whether each call asks a person first. */
  readonly gated: boolean;
};

/** What connecting to a session's servers came to. */
export type McpConnection = {
  /** The tools as an extension, or `undefined` when no server offered one. */
  readonly extension: Extension | undefined;
  readonly offered: readonly McpOfferedTool[];
  /** The gated tools, by the name the agent calls them, each with the action an approval names. */
  readonly gates: ReadonlyMap<string, string>;
  /** Why a granted server or tool is not offered, one sentence each, for the open to warn with. */
  readonly problems: readonly string[];
  /** Close every client; idempotent, and never fails. */
  readonly close: Effect.Effect<void>;
};

/** Nothing to connect to. */
export const NO_MCP: McpConnection = {
  extension: undefined,
  offered: [],
  gates: new Map(),
  problems: [],
  close: Effect.void,
};

export type ConnectMcpOptions = {
  /** A read-only stage's run (`./rolePolicy`): only the reads are offered. */
  readonly readOnly: boolean;
  readonly connectTimeoutMs?: number;
  readonly callTimeoutMs?: number;
};

const describe = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/** Whether the server says its tool only reads (MCP's `readOnlyHint`, `false` when absent). */
const readsOnly = (tool: McpTool): boolean =>
  tool.annotations?.readOnlyHint === true;

/** The action an approval of a call to this tool names: the server and the tool, as the person reads them. */
const gateAction = (server: string, tool: string): string =>
  `${server}/${tool} (MCP)`;

/** One MCP content block as a tool result's content: text and images as they are, anything else said in text. */
const contentOf = (block: ContentBlock): TextContent | ImageContent => {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "image":
      return { type: "image", data: block.data, mimeType: block.mimeType };
    case "audio":
      return { type: "text", text: `[audio content, ${block.mimeType}]` };
    case "resource":
      return {
        type: "text",
        text:
          "text" in block.resource && typeof block.resource.text === "string"
            ? block.resource.text
            : `[resource ${block.resource.uri}]`,
      };
    case "resource_link":
      return { type: "text", text: `[resource link ${block.uri}]` };
  }
};

/** A tool's input schema as Pi Durable validates arguments against: the server's JSON Schema, as it is. */
const parametersOf = (tool: McpTool) =>
  Type.Unsafe<Record<string, unknown>>(tool.inputSchema);

const registrationOf = (
  client: Client,
  server: McpServerAccess,
  tool: McpTool,
  name: string,
  gated: boolean,
  callTimeoutMs: number,
) =>
  defineTool({
    name,
    description: [
      `A tool of the ${server.name} MCP server (its ${tool.name}).`,
      gated
        ? "Every call asks a person's approval first and runs only once they approve it."
        : "It only reads.",
      tool.description ?? "",
    ]
      .filter((part) => part.length > 0)
      .join(" "),
    parameters: parametersOf(tool),
    // A read rerun on recovery reads again; a write that may have reached the server must not be
    // sent twice, so an interrupted one settles as interrupted.
    replay: gated ? "unsafe" : "safe",
    execute: (args, _api, context) =>
      client
        .callTool({ name: tool.name, arguments: args }, undefined, {
          timeout: callTimeoutMs,
          ...(context.abortSignal === undefined
            ? {}
            : { signal: context.abortSignal }),
        })
        .then(
          (result) => {
            const blocks = Array.isArray(result.content)
              ? (result.content as readonly ContentBlock[])
              : [];
            const content =
              blocks.length > 0
                ? blocks.map(contentOf)
                : [
                    {
                      type: "text" as const,
                      text:
                        result.structuredContent === undefined
                          ? "(the tool returned no content)"
                          : JSON.stringify(result.structuredContent),
                    },
                  ];
            return {
              content,
              isError: result.isError === true,
              details: { server: server.name, tool: tool.name },
            };
          },
          (cause: unknown) => {
            throw new Error(
              `the ${server.name} MCP server's ${tool.name} failed: ${describe(cause)}`,
            );
          },
        ),
  });

/**
 * The SDK's own transport as the `Transport` its client takes. It declares `sessionId` as
 * `string | undefined` where `Transport` has it optional, which `exactOptionalPropertyTypes` reads as
 * two types; at runtime they are the same property.
 */
const asTransport = (transport: StreamableHTTPClientTransport): Transport =>
  transport as Transport;

/** Every tool a connected server lists, page by page. */
const listTools = (client: Client, timeoutMs: number) =>
  Effect.gen(function* () {
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
      const params = cursor === undefined ? {} : { cursor };
      const listed = yield* Effect.tryPromise(() =>
        client.listTools(params, { timeout: timeoutMs }),
      );
      tools.push(...listed.tools);
      cursor = listed.nextCursor;
      if (cursor === undefined) break;
    }
    return tools;
  });

type ServerTools = {
  readonly client: Client | undefined;
  readonly tools: readonly ToolRegistration[];
  readonly offered: readonly McpOfferedTool[];
  readonly problems: readonly string[];
};

const connectServer = (
  server: McpServerAccess,
  options: ConnectMcpOptions,
): Effect.Effect<ServerTools> =>
  Effect.gen(function* () {
    const connectTimeoutMs = options.connectTimeoutMs ?? MCP_CONNECT_TIMEOUT_MS;
    const callTimeoutMs = options.callTimeoutMs ?? MCP_CALL_TIMEOUT_MS;
    const client = new Client({ name: "factory", version: "0.0.0" });
    const unreachable = (cause: unknown): ServerTools => ({
      client: undefined,
      tools: [],
      offered: [],
      problems: [
        `MCP server ${server.name} (${server.url}) could not be reached, so none of its tools is offered: ${describe(cause)}`,
      ],
    });
    const listed = yield* Effect.try(
      () =>
        new StreamableHTTPClientTransport(new URL(server.url), {
          requestInit: { headers: { ...server.headers } },
        }),
    ).pipe(
      Effect.flatMap((transport) =>
        Effect.tryPromise(() =>
          client.connect(asTransport(transport), {
            timeout: connectTimeoutMs,
          }),
        ),
      ),
      Effect.andThen(listTools(client, connectTimeoutMs)),
      Effect.result,
    );
    if (listed._tag === "Failure") {
      yield* Effect.promise(() => client.close().catch(() => undefined));
      return unreachable(listed.failure.cause);
    }
    const byName = new Map(listed.success.map((tool) => [tool.name, tool]));
    const problems: string[] = [];
    const tools: ToolRegistration[] = [];
    const offered: McpOfferedTool[] = [];
    for (const allowed of server.tools) {
      const tool = byName.get(allowed);
      if (tool === undefined) {
        problems.push(
          `the repository allows tool ${allowed} of MCP server ${server.name}, which the server does not list`,
        );
        continue;
      }
      // A read-only stage changes nothing outside its log either: it is offered the reads only.
      if (options.readOnly && !readsOnly(tool)) continue;
      const name = mcpToolName(server.name, tool.name);
      if (!TOOL_NAME.test(name)) {
        problems.push(
          `tool ${tool.name} of MCP server ${server.name} is not offered: ${name} is longer than a model provider allows`,
        );
        continue;
      }
      if (offered.some((other) => other.name === name)) {
        problems.push(
          `tool ${tool.name} of MCP server ${server.name} is not offered: another of its tools is offered as ${name}`,
        );
        continue;
      }
      const gated =
        !readsOnly(tool) || server.approvalRequired.includes(tool.name);
      tools.push(
        registrationOf(client, server, tool, name, gated, callTimeoutMs),
      );
      offered.push({ name, server: server.name, tool: tool.name, gated });
    }
    return { client, tools, offered, problems };
  });

/**
 * Connect to every granted server and list its tools, concurrently: the tools the repository
 * allows and the server lists, as one extension, and the gates the policy asks on. Never fails — a
 * server that cannot be reached is a problem and offers nothing.
 */
export const connectMcp = (
  servers: readonly McpServerAccess[],
  options: ConnectMcpOptions,
): Effect.Effect<McpConnection> =>
  servers.length === 0
    ? Effect.succeed(NO_MCP)
    : Effect.gen(function* () {
        const connected = yield* Effect.forEach(
          servers,
          (server) => connectServer(server, options),
          { concurrency: "unbounded" },
        );
        const tools = connected.flatMap((server) => server.tools);
        const offered = connected.flatMap((server) => server.offered);
        const clients = connected.flatMap((server) =>
          server.client === undefined ? [] : [server.client],
        );
        const closed = { done: false };
        return {
          extension:
            tools.length === 0
              ? undefined
              : defineExtension({ name: MCP_EXTENSION, tools }),
          offered,
          gates: new Map(
            offered
              .filter((tool) => tool.gated)
              .map((tool) => [tool.name, gateAction(tool.server, tool.tool)]),
          ),
          problems: connected.flatMap((server) => server.problems),
          close: Effect.suspend(() => {
            if (closed.done) return Effect.void;
            closed.done = true;
            return Effect.promise(() =>
              Promise.allSettled(clients.map((client) => client.close())),
            );
          }).pipe(Effect.asVoid),
        };
      });

/**
 * Compose the MCP gates into a session's policy: a call to a gated MCP tool that the wrapped policy
 * allows asks a person (LOB-52), under the request id `approvalRequestId` derives from the call, so
 * the same call asks the same question on every attempt and a denial stands for it. The wrapped
 * policy decides first, so a read-only stage's refusal or any other block is never turned into an
 * ask. No gates is the wrapped policy itself.
 */
export const mcpPolicy = (
  policy: SessionPolicy,
  gates: ReadonlyMap<string, string>,
): SessionPolicy =>
  gates.size === 0
    ? policy
    : {
        rules: policy.rules,
        decide: (call) =>
          Effect.map(policy.decide(call), (decision) => {
            const action = gates.get(call.name);
            return decision._tag !== "allow" || action === undefined
              ? decision
              : {
                  _tag: "ask",
                  requestId: approvalRequestId(call),
                  action,
                  detail: `${call.name} ${JSON.stringify(call.arguments)}`,
                };
          }),
      };
