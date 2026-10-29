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
 *
 * **Two halves: the network, then the offer.** `listMcp` connects and lists, within one deadline per
 * server for the handshake and every page together; `offerMcp` picks, from what was listed, the tools
 * an open grants, and touches nothing remote. The control plane lists before its owners' gate and
 * offers under it, so a slow or silent server holds its own session's open and nobody else's. A link
 * outlives the open (`McpLink`): it re-initialises a session the server forgot, and ends the session
 * with a `DELETE` when it closes.
 */
import { Type } from "@earendil-works/pi-ai";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { Extension, ToolRegistration } from "@earendil-works/pi-durable";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
  ContentBlock,
  Tool as McpTool,
} from "@modelcontextprotocol/sdk/types.js";
import { Effect, Schema, Semaphore } from "effect";
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
  link: McpLink,
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
      Effect.runPromise(
        Effect.result(
          link.call(tool.name, args, {
            timeoutMs: callTimeoutMs,
            resend: readsOnly(tool),
          }),
        ),
        context.abortSignal === undefined
          ? undefined
          : { signal: context.abortSignal },
      ).then((called) => {
        if (called._tag === "Failure")
          throw new Error(
            `the ${server.name} MCP server's ${tool.name} failed: ${called.failure.message}`,
          );
        const result = called.success;
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
      }),
  });

/**
 * The SDK's own transport as the `Transport` its client takes. It declares `sessionId` as
 * `string | undefined` where `Transport` has it optional, which `exactOptionalPropertyTypes` reads as
 * two types; at runtime they are the same property.
 */
const asTransport = (transport: StreamableHTTPClientTransport): Transport =>
  transport as Transport;

/**
 * The SDK, loaded the first time a session has a server to connect to: it brings zod and ajv with
 * it, over a second of imports on a loaded machine, which every process that imports this package
 * (the API, the CLI, each test) would otherwise pay at start whether or not it registers a server.
 */
const loadSdk = Effect.tryPromise(() =>
  // The module loader keeps each module once, so a later open's import is the first one's.
  Promise.all([
    import("@modelcontextprotocol/sdk/client/index.js"),
    import("@modelcontextprotocol/sdk/client/streamableHttp.js"),
  ]).then(([client, transport]) => ({
    Client: client.Client,
    StreamableHTTPClientTransport: transport.StreamableHTTPClientTransport,
    StreamableHTTPError: transport.StreamableHTTPError,
  })),
);

type Sdk = Effect.Success<typeof loadSdk>;

/**
 * A request to an MCP server that failed: it could not be sent, the server refused it, or no answer
 * came in time. `sessionLost` says the server answered `404` — it no longer knows the session the
 * client holds (Streamable HTTP's own word for an expired or forgotten session).
 */
export class McpRequestFailed extends Schema.TaggedError<McpRequestFailed>()(
  "McpRequestFailed",
  { message: Schema.String, sessionLost: Schema.Boolean },
) {}

/** A cause the SDK threw, as the request's failure. */
const failedWith =
  (sdk: Sdk) =>
  (cause: unknown): McpRequestFailed =>
    new McpRequestFailed({
      message: describe(cause),
      sessionLost:
        cause instanceof sdk.StreamableHTTPError && cause.code === 404,
    });

const failed = (message: string): McpRequestFailed =>
  new McpRequestFailed({ message, sessionLost: false });

/** What a tool call answers, as the SDK's client returns it. */
type McpCallResult = Awaited<ReturnType<Client["callTool"]>>;

/** One initialised MCP session with a server: the client and the transport it holds. */
type Live = {
  readonly client: Client;
  readonly transport: StreamableHTTPClientTransport;
};

/** How long closing waits for the server to end its session before letting go regardless. */
const SESSION_END_GRACE_MS = 2_000;

/**
 * End a session: tell the server (`DELETE`, which a server without sessions answers `405`), bounded
 * so a server that stopped answering cannot hold the close, then close the client, which aborts
 * whatever it still has in flight. Never fails.
 */
const shutdown = (live: Live): Effect.Effect<void> =>
  Effect.tryPromise({
    try: () => live.transport.terminateSession(),
    catch: (cause) => failed(describe(cause)),
  }).pipe(
    Effect.timeout(SESSION_END_GRACE_MS),
    Effect.ignore,
    Effect.andThen(
      Effect.promise(() => live.client.close().catch(() => undefined)),
    ),
  );

/** Connect to a server and initialise a session; whatever fails or is interrupted is shut down. */
const openLive = (
  sdk: Sdk,
  server: McpServerAccess,
  timeoutMs: number,
): Effect.Effect<Live, McpRequestFailed> =>
  Effect.try({
    try: () => ({
      client: new sdk.Client({ name: "factory", version: "0.0.0" }),
      transport: new sdk.StreamableHTTPClientTransport(new URL(server.url), {
        requestInit: { headers: { ...server.headers } },
      }),
    }),
    catch: failedWith(sdk),
  }).pipe(
    Effect.flatMap((live) =>
      Effect.tryPromise({
        try: (signal) =>
          live.client.connect(asTransport(live.transport), {
            timeout: timeoutMs,
            signal,
          }),
        catch: failedWith(sdk),
      }).pipe(
        Effect.onError(() => shutdown(live)),
        Effect.as(live),
      ),
    ),
  );

/** Every tool a connected server lists, page by page. */
const listTools = (sdk: Sdk, client: Client, timeoutMs: number) =>
  Effect.gen(function* () {
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
      const params = cursor === undefined ? {} : { cursor };
      const listed = yield* Effect.tryPromise({
        try: (signal) =>
          client.listTools(params, { timeout: timeoutMs, signal }),
        catch: failedWith(sdk),
      });
      tools.push(...listed.tools);
      cursor = listed.nextCursor;
      if (cursor === undefined) break;
    }
    return tools;
  });

/**
 * The calls' way to one server, for as long as the session that listed it is open.
 *
 * A Streamable HTTP server may forget the session it gave this client — it expired it, or it
 * restarted — and answers every later request `404`. The link then starts a new session for the
 * next call. A read is sent again on it at once; a write is not: whether the server acted on the
 * first is the server's to know, and a write is never sent twice (as on replay), so the call fails,
 * saying so, and the agent may make it again.
 */
export type McpLink = {
  readonly call: (
    tool: string,
    args: Record<string, unknown>,
    options: { readonly timeoutMs: number; readonly resend: boolean },
  ) => Effect.Effect<McpCallResult, McpRequestFailed>;
  /** End the session with the server and close the client; idempotent, and never fails. */
  readonly close: Effect.Effect<void>;
};

const linkOf = (
  sdk: Sdk,
  server: McpServerAccess,
  first: Live,
  connectTimeoutMs: number,
): McpLink => {
  let live: Live | undefined = first;
  let closed = false;
  // One new session at a time: two calls that both met the `404` share the one the first starts.
  const reopening = Semaphore.makeUnsafe(1);
  const current = reopening.withPermits(1)(
    Effect.suspend(() => {
      if (closed)
        return Effect.fail(
          failed(`the session's link to ${server.name} is closed`),
        );
      if (live !== undefined) return Effect.succeed(live);
      return openLive(sdk, server, connectTimeoutMs).pipe(
        Effect.flatMap((opened) => {
          // Closed while it was opening: the new session is the close's too.
          if (closed)
            return shutdown(opened).pipe(
              Effect.andThen(
                Effect.fail(
                  failed(`the session's link to ${server.name} is closed`),
                ),
              ),
            );
          live = opened;
          return Effect.succeed(opened);
        }),
      );
    }),
  );
  /** Drop a session the server no longer knows, so the next call starts a new one. */
  const expire = (stale: Live) =>
    Effect.suspend(() => {
      if (live !== stale) return Effect.void;
      live = undefined;
      return shutdown(stale);
    });
  const send = (
    on: Live,
    tool: string,
    args: Record<string, unknown>,
    timeoutMs: number,
  ) =>
    Effect.tryPromise({
      try: (signal) =>
        on.client.callTool({ name: tool, arguments: args }, undefined, {
          timeout: timeoutMs,
          signal,
        }),
      catch: failedWith(sdk),
    });
  return {
    call: (tool, args, { timeoutMs, resend }) =>
      Effect.gen(function* () {
        const on = yield* current;
        const sent = yield* Effect.result(send(on, tool, args, timeoutMs));
        if (sent._tag === "Success") return sent.success;
        if (!sent.failure.sessionLost) return yield* sent.failure;
        yield* expire(on);
        if (!resend)
          return yield* failed(
            `${sent.failure.message} — the server no longer knows this session, so the call was not sent again (a write is never sent twice); the next call starts a new session`,
          );
        return yield* send(yield* current, tool, args, timeoutMs);
      }),
    close: Effect.suspend(() => {
      closed = true;
      const open = live;
      live = undefined;
      return open === undefined ? Effect.void : shutdown(open);
    }),
  };
};

/** One granted server as connecting to it came out: its tools and its link, or why there are none. */
export type McpServerListing = {
  /** The server as it was connected to: its grant and the headers it was given. */
  readonly server: McpServerAccess;
  readonly link: McpLink | undefined;
  readonly tools: readonly McpTool[];
  /** Why it offers nothing — it could not be reached in time — or `undefined`. */
  readonly problem: string | undefined;
};

/**
 * The servers a session's open connected to and the tools each listed: the network half of
 * offering MCP tools (`listMcp`), done before the open so the open itself waits on nothing remote.
 * Whoever holds it owns its sessions until it hands it to an open (`OpenSessionOptions.mcpListing`).
 */
export type McpListing = {
  readonly servers: readonly McpServerListing[];
  /** End every server's session; idempotent, and never fails. */
  readonly close: Effect.Effect<void>;
};

/** Nothing connected. */
export const NO_MCP_LISTING: McpListing = { servers: [], close: Effect.void };

const unreachable = (
  server: McpServerAccess,
  cause: unknown,
): McpServerListing => ({
  server,
  link: undefined,
  tools: [],
  problem: `MCP server ${server.name} (${server.url}) could not be reached, so none of its tools is offered: ${describe(cause)}`,
});

/**
 * Connect to one server and list its tools, all of it within one deadline — however many pages its
 * list runs to — after which it is a problem and its session is shut down.
 */
const listServer = (
  sdk: Sdk,
  server: McpServerAccess,
  deadlineMs: number,
): Effect.Effect<McpServerListing> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const live = yield* restore(openLive(sdk, server, deadlineMs));
      const tools = yield* restore(
        listTools(sdk, live.client, deadlineMs),
      ).pipe(Effect.onError(() => shutdown(live)));
      return {
        server,
        link: linkOf(sdk, server, live, deadlineMs),
        tools,
        problem: undefined,
      } satisfies McpServerListing;
    }),
  ).pipe(
    Effect.timeoutOrElse({
      duration: deadlineMs,
      orElse: () =>
        Effect.fail(
          failed(
            `it did not finish connecting and listing its tools within ${deadlineMs} ms`,
          ),
        ),
    }),
    Effect.catch((error) => Effect.succeed(unreachable(server, error))),
  );

/**
 * Connect to every granted server and list its tools, concurrently, each within
 * `connectTimeoutMs` all told. Never fails: a server that cannot be reached in time is a problem
 * and offers nothing. Interrupted, it shuts down what it had connected.
 */
export const listMcp = (
  servers: readonly McpServerAccess[],
  options: { readonly connectTimeoutMs?: number } = {},
): Effect.Effect<McpListing> =>
  servers.length === 0
    ? Effect.succeed(NO_MCP_LISTING)
    : Effect.gen(function* () {
        const deadlineMs = options.connectTimeoutMs ?? MCP_CONNECT_TIMEOUT_MS;
        const sdk = yield* Effect.result(loadSdk);
        if (sdk._tag === "Failure")
          return {
            servers: servers.map((server) =>
              unreachable(server, sdk.failure.cause),
            ),
            close: Effect.void,
          };
        const listed = yield* Effect.forEach(
          servers,
          (server) => listServer(sdk.success, server, deadlineMs),
          { concurrency: "unbounded" },
        );
        const closed = { done: false };
        return {
          servers: listed,
          close: Effect.suspend(() => {
            if (closed.done) return Effect.void;
            closed.done = true;
            return Effect.forEach(
              listed,
              (server) => server.link?.close ?? Effect.void,
              { concurrency: "unbounded", discard: true },
            );
          }),
        };
      });

const sameHeaders = (
  a: Readonly<Record<string, string>> | undefined,
  b: Readonly<Record<string, string>> | undefined,
): boolean => {
  const left = Object.entries(a ?? {});
  const right = b ?? {};
  return (
    left.length === Object.keys(right).length &&
    left.every(([key, value]) => right[key] === value)
  );
};

export type OfferMcpOptions = {
  /** A read-only stage's run (`./rolePolicy`): only the reads are offered. */
  readonly readOnly: boolean;
  readonly callTimeoutMs?: number;
};

/**
 * What a session is offered of a listing: for each server it is granted, the tools the repository
 * allows and the server listed — a read-only stage the reads only — as one extension, and the gates
 * the policy asks on. Nothing remote: the listing was made before. A granted server the listing
 * holds no session for under the same URL and credential (the grants changed while the open waited
 * for the gate) is a problem, not a connection made here.
 */
export const offerMcp = (
  listing: McpListing,
  servers: readonly McpServerAccess[],
  options: OfferMcpOptions,
): McpConnection => {
  const callTimeoutMs = options.callTimeoutMs ?? MCP_CALL_TIMEOUT_MS;
  const problems: string[] = [];
  const tools: ToolRegistration[] = [];
  const offered: McpOfferedTool[] = [];
  for (const server of servers) {
    const listed = listing.servers.find(
      (candidate) =>
        candidate.server.name === server.name &&
        candidate.server.url === server.url &&
        sameHeaders(candidate.server.headers, server.headers),
    );
    if (listed === undefined) {
      problems.push(
        `MCP server ${server.name} is not offered: it was not connected for this open, since what the session may reach of it changed while the open waited`,
      );
      continue;
    }
    if (listed.problem !== undefined || listed.link === undefined) {
      if (listed.problem !== undefined) problems.push(listed.problem);
      continue;
    }
    const byName = new Map(listed.tools.map((tool) => [tool.name, tool]));
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
        registrationOf(listed.link, server, tool, name, gated, callTimeoutMs),
      );
      offered.push({ name, server: server.name, tool: tool.name, gated });
    }
  }
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
    problems,
    close: listing.close,
  };
};

/**
 * Connect to every granted server, list its tools and offer them (`listMcp`, then `offerMcp`):
 * for a caller with no listing made beforehand. Never fails.
 */
export const connectMcp = (
  servers: readonly McpServerAccess[],
  options: ConnectMcpOptions,
): Effect.Effect<McpConnection> =>
  servers.length === 0
    ? Effect.succeed(NO_MCP)
    : Effect.map(
        listMcp(
          servers,
          options.connectTimeoutMs === undefined
            ? {}
            : { connectTimeoutMs: options.connectTimeoutMs },
        ),
        (listing) =>
          offerMcp(
            listing,
            servers,
            options.callTimeoutMs === undefined
              ? { readOnly: options.readOnly }
              : {
                  readOnly: options.readOnly,
                  callTimeoutMs: options.callTimeoutMs,
                },
          ),
      );

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
