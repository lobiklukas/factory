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
 * With `sessions` set it is the stateful form instead: `initialize` answers with an
 * `Mcp-Session-Id`, every later request must carry a live one or is `404` (as a server that expired
 * or forgot the session answers), `DELETE` ends one, and `expireSessions` forgets them all — a
 * server's restart, as the client meets it.
 *
 * What it does not prove: OAuth, SSE responses, resumability, or anything a real server's tools do.
 * A tool's answer is whatever its `answer` returns.
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
  /** The `Mcp-Session-Id` it carried. */
  readonly session: string | undefined;
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
  /** Forget every session (`sessions` mode): the next request on one is `404`. */
  readonly expireSessions: () => void;
  readonly close: () => Promise<void>;
};

export type FakeMcpOptions = {
  /** The tools each path serves; a path not listed is `404`. */
  readonly servers: Readonly<Record<string, readonly FakeMcpTool[]>>;
  /** Page `tools/list` this many tools at a time. Absent: one page. */
  readonly pageSize?: number;
  /** Answer each `tools/list` page this many milliseconds late. Absent: at once. */
  readonly listDelayMs?: number;
  /** The stateful form: session ids, `404` for an unknown one, `DELETE` ends one. Absent: stateless. */
  readonly sessions?: boolean;
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
  const live = new Set<string>();
  let minted = 0;
  const server = createServer((request, response) => {
    const path = (request.url ?? "/").split("?")[0] ?? "/";
    const header = request.headers.authorization;
    const authorization = typeof header === "string" ? header : undefined;
    const sessionHeader = request.headers["mcp-session-id"];
    const session =
      typeof sessionHeader === "string" ? sessionHeader : undefined;
    const tools = Object.hasOwn(options.servers, path.replace(/^\//, ""))
      ? options.servers[path.replace(/^\//, "")]
      : undefined;
    if (request.method !== "POST") {
      requests.push({
        path,
        method: request.method ?? "",
        rpc: undefined,
        authorization,
        session,
      });
      if (
        request.method === "DELETE" &&
        options.sessions === true &&
        tools !== undefined
      ) {
        const known = session !== undefined && live.delete(session);
        response.writeHead(known ? 200 : 404).end();
        return;
      }
      response.writeHead(tools === undefined ? 404 : 405).end();
      return;
    }
    withBody(request, (text) => {
      let message: RpcMessage;
      try {
        message = record(JSON.parse(text));
      } catch {
        requests.push({
          path,
          method: "POST",
          rpc: undefined,
          authorization,
          session,
        });
        response.writeHead(400).end();
        return;
      }
      const rpc =
        typeof message.method === "string" ? message.method : undefined;
      requests.push({ path, method: "POST", rpc, authorization, session });
      if (tools === undefined) {
        response.writeHead(404).end();
        return;
      }
      // The stateful form: a request on a session the server does not know is `404`.
      const minting = options.sessions === true && rpc === "initialize";
      if (
        options.sessions === true &&
        !minting &&
        (session === undefined || !live.has(session))
      ) {
        response.writeHead(404, { "content-type": "application/json" }).end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32001, message: "Session not found" },
          }),
        );
        return;
      }
      // A notification (no id) is accepted and answers nothing.
      if (message.id === undefined || message.id === null) {
        response.writeHead(202).end();
        return;
      }
      const answer = (body: Record<string, unknown>) => {
        const headers: Record<string, string> = {
          "content-type": "application/json",
        };
        if (minting) {
          minted += 1;
          const id = `fake-session-${minted}`;
          live.add(id);
          headers["mcp-session-id"] = id;
        }
        response
          .writeHead(200, headers)
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
          const page = () =>
            answer({
              result: {
                tools: tools.slice(start, end).map(toolJson),
                ...(end < tools.length ? { nextCursor: String(end) } : {}),
              },
            });
          if (options.listDelayMs === undefined) page();
          // oxlint-disable-next-line effecttsgo/global-timers -- a fake server's slow answer, outside any Effect.
          else setTimeout(page, options.listDelayMs);
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
    expireSessions: () => live.clear(),
    // oxlint-disable-next-line effecttsgo/async-function -- a test's `afterAll` awaits it.
    close: async () => {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
  };
};
