/**
 * A remote MCP server on loopback, for tests and verify drives (S-agent-mcp-tools,
 * `docs/testing-third-parties.md`): the Streamable HTTP transport's stateless form, written from the
 * MCP specification rather than with the SDK the client uses, so a client that only works against its
 * own library's server would fail here.
 *
 * It answers `initialize`, `ping`, `tools/list` (paged when `pageSize` is set) and `tools/call` with a
 * JSON body, takes every notification with `202`, and refuses the optional `GET` stream and `DELETE`
 * with `405`, as a server without them must. Every request is recorded with its path and its
 * `Authorization` header, and every call with its arguments, so a test asserts what reached the
 * server — and what did not — rather than what the client says it sent. One process can stand in for
 * several servers: each path is one, and the path is in the record.
 *
 * What it does not prove: OAuth, SSE responses, session ids, resumability, or anything a real
 * server's tools do. A tool's answer is whatever its `answer` returns.
 */
import { once } from "node:events";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- a listener the MCP client connects to, not a client: the server's side of the wire.
import { createServer, type IncomingMessage } from "node:http";

export type FakeMcpTool = {
  readonly name: string;
  readonly description?: string;
  /** The tool's input schema; absent is an object with no properties. */
  readonly inputSchema?: Readonly<Record<string, unknown>>;
  /** Annotated `readOnlyHint: true` when set; otherwise the tool carries no annotations. */
  readonly readOnly?: boolean;
  /** The text the call answers, or an error result. Absent: the arguments, as JSON. */
  readonly answer?: (
    args: Readonly<Record<string, unknown>>,
  ) => string | { readonly isError: true; readonly text: string };
};

/** One request the server received. */
export type FakeMcpRequest = {
  readonly path: string;
  readonly method: string;
  /** The JSON-RPC method, for a `POST`. */
  readonly rpc: string | undefined;
  readonly authorization: string | undefined;
};

/** One `tools/call` the server answered. */
export type FakeMcpCall = {
  readonly path: string;
  readonly tool: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly authorization: string | undefined;
};

export type FakeMcpServer = {
  /** The server's base URL; a path under it is one server (`${url}/tracker`). */
  readonly url: string;
  readonly requests: FakeMcpRequest[];
  readonly calls: FakeMcpCall[];
  readonly close: () => Promise<void>;
};

export type FakeMcpOptions = {
  /** The tools each path serves; a path not listed is `404`. */
  readonly servers: Readonly<Record<string, readonly FakeMcpTool[]>>;
  /** Page `tools/list` this many tools at a time. Absent: one page. */
  readonly pageSize?: number;
  readonly port?: number;
  readonly host?: string;
};

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

type RpcMessage = {
  readonly jsonrpc?: unknown;
  readonly id?: unknown;
  readonly method?: unknown;
  readonly params?: unknown;
};

const record = (value: unknown): Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** Call `then` with the request's whole body once it has arrived. */
const withBody = (
  request: IncomingMessage,
  then: (text: string) => void,
): void => {
  const chunks: Buffer[] = [];
  request.on("data", (chunk: Buffer) => chunks.push(chunk));
  request.on("end", () => then(Buffer.concat(chunks).toString("utf8")));
};

const toolJson = (tool: FakeMcpTool) => ({
  name: tool.name,
  ...(tool.description === undefined ? {} : { description: tool.description }),
  inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
  ...(tool.readOnly === true ? { annotations: { readOnlyHint: true } } : {}),
});

/** Start the fake on loopback; port 0 (the default) picks a free one. */
// oxlint-disable-next-line effecttsgo/async-function -- a vitest `beforeAll` and a verify driver await it, as the other fakes' callers do.
export const startFakeMcpServer = async (
  options: FakeMcpOptions,
): Promise<FakeMcpServer> => {
  const requests: FakeMcpRequest[] = [];
  const calls: FakeMcpCall[] = [];
  const server = createServer((request, response) => {
    const path = (request.url ?? "/").split("?")[0] ?? "/";
    const header = request.headers.authorization;
    const authorization = typeof header === "string" ? header : undefined;
    const tools = Object.hasOwn(options.servers, path.replace(/^\//, ""))
      ? options.servers[path.replace(/^\//, "")]
      : undefined;
    if (request.method !== "POST") {
      requests.push({
        path,
        method: request.method ?? "",
        rpc: undefined,
        authorization,
      });
      response.writeHead(tools === undefined ? 404 : 405).end();
      return;
    }
    withBody(request, (text) => {
      let message: RpcMessage;
      try {
        message = record(JSON.parse(text));
      } catch {
        requests.push({ path, method: "POST", rpc: undefined, authorization });
        response.writeHead(400).end();
        return;
      }
      const rpc =
        typeof message.method === "string" ? message.method : undefined;
      requests.push({ path, method: "POST", rpc, authorization });
      if (tools === undefined) {
        response.writeHead(404).end();
        return;
      }
      // A notification (no id) is accepted and answers nothing.
      if (message.id === undefined || message.id === null) {
        response.writeHead(202).end();
        return;
      }
      const answer = (body: Record<string, unknown>) => {
        response
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ jsonrpc: "2.0", id: message.id, ...body }));
      };
      const params = record(message.params);
      switch (rpc) {
        case "initialize": {
          const asked = params["protocolVersion"];
          answer({
            result: {
              protocolVersion:
                typeof asked === "string" && PROTOCOL_VERSIONS.includes(asked)
                  ? asked
                  : PROTOCOL_VERSIONS[0],
              capabilities: { tools: {} },
              serverInfo: { name: "factory-fake-mcp", version: "0.0.0" },
            },
          });
          return;
        }
        case "ping":
          answer({ result: {} });
          return;
        case "tools/list": {
          const size = options.pageSize ?? tools.length;
          const cursor = params["cursor"];
          const start = typeof cursor === "string" ? Number(cursor) : 0;
          const end = start + Math.max(1, size);
          answer({
            result: {
              tools: tools.slice(start, end).map(toolJson),
              ...(end < tools.length ? { nextCursor: String(end) } : {}),
            },
          });
          return;
        }
        case "tools/call": {
          const name = params["name"];
          const tool = tools.find((candidate) => candidate.name === name);
          if (tool === undefined) {
            answer({
              error: { code: -32602, message: `Unknown tool: ${String(name)}` },
            });
            return;
          }
          const args = record(params["arguments"]);
          calls.push({ path, tool: tool.name, arguments: args, authorization });
          const result = tool.answer?.(args) ?? JSON.stringify(args);
          answer({
            result:
              typeof result === "string"
                ? { content: [{ type: "text", text: result }] }
                : {
                    content: [{ type: "text", text: result.text }],
                    isError: true,
                  },
          });
          return;
        }
        default:
          answer({
            error: {
              code: -32601,
              message: `Method not found: ${String(rpc)}`,
            },
          });
      }
    });
  });
  const host = options.host ?? "127.0.0.1";
  server.listen(options.port ?? 0, host);
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("the fake MCP server did not bind a TCP port");
  return {
    url: `http://${host}:${address.port}`,
    requests,
    calls,
    // oxlint-disable-next-line effecttsgo/async-function -- a test's `afterAll` awaits it.
    close: async () => {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
  };
};
