/**
 * A loopback fake of an OpenAI-compatible endpoint (S-model-provider-breadth), for the gate and the
 * verify drives: `POST <url>/chat/completions` answered the way a Chat Completions server streams,
 * from a script derived from the request rather than queued — the faux backend's script
 * (`./models`' `fauxAnswer`) in the other provider's wire format. A request whose transcript has run
 * no `bash` yet calls `bash` with `command`; every later one answers with what that command printed,
 * `(re: <the user's newest message>)` — so a session on it runs a tool round end to end, and a run
 * that falls back onto it from another model picks up from the other model's tool result.
 *
 * `fail` makes it the provider that is down: once a request's transcript holds `afterAnswers`
 * assistant messages it answers `status` (`529` by default) with Anthropic's overloaded body, which
 * is what a role's fallback chain moves a run off (`./fallback`).
 *
 * Every request is recorded — the model it named, whether it carried a key, the status it got — so
 * a test asserts what the provider was asked rather than what the caller says it asked; a drive in
 * another process reads the same record from `GET /__ledger`. Nothing here
 * reaches past 127.0.0.1, and the key it is sent is a test's dummy, never a real one.
 */
// oxlint-disable-next-line effecttsgo/node-builtin-import -- a fake server the gate runs under node and bun alike; Bun.serve is not in node.
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

/** One request the fake served. */
export type OpenAICompatibleFakeRequest = {
  readonly model: string;
  /** The `Authorization` header as sent: a test's dummy key, or the provider's keyless placeholder. */
  readonly authorization: string | undefined;
  readonly status: number;
  /** What it answered: `bash` for a tool call, `text` for an answer, `error` for a failure. */
  readonly answered: "bash" | "text" | "error";
};

export type OpenAICompatibleFakeOptions = {
  /** The command the first turn calls `bash` with. */
  readonly command?: string | undefined;
  /** Fail requests once their transcript holds `afterAnswers` assistant messages. */
  readonly fail?:
    | { readonly afterAnswers: number; readonly status?: number | undefined }
    | undefined;
  /** The usage every answer reports, which the provider's price turns into its cost. */
  readonly usage?:
    | { readonly prompt: number; readonly completion: number }
    | undefined;
  /** The port to bind on 127.0.0.1; `0` (the default) is any free one. */
  readonly port?: number | undefined;
};

export type OpenAICompatibleFake = {
  /** The base URL a provider is configured with: `http://127.0.0.1:<port>/v1`. */
  readonly url: string;
  /** Every request served, oldest first. */
  readonly requests: readonly OpenAICompatibleFakeRequest[];
  readonly close: () => Promise<void>;
};

/** What the fake's first turn runs unless told otherwise. */
export const OPENAI_COMPATIBLE_FAKE_COMMAND = "echo compat-ok";

/** The usage each answer reports unless told otherwise. */
export const OPENAI_COMPATIBLE_FAKE_USAGE = {
  prompt: 1000,
  completion: 50,
} as const;

type ChatMessage = {
  readonly role?: unknown;
  readonly content?: unknown;
  readonly tool_calls?: unknown;
};

const contentText = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .map((part: unknown) =>
            typeof part === "object" &&
            part !== null &&
            "text" in part &&
            typeof part.text === "string"
              ? part.text
              : "",
          )
          .join("")
      : "";

const readBody = (request: IncomingMessage): Promise<string> =>
  // oxlint-disable-next-line effecttsgo/new-promise -- a node:http stream and server take callbacks.
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });

/** One streamed chunk, as `data: {…}` followed by the blank line SSE ends an event with. */
const event = (value: unknown): string => `data: ${JSON.stringify(value)}\n\n`;

export const startOpenAICompatibleFake = (
  options: OpenAICompatibleFakeOptions = {},
): Promise<OpenAICompatibleFake> => {
  const requests: OpenAICompatibleFakeRequest[] = [];
  const command = options.command ?? OPENAI_COMPATIBLE_FAKE_COMMAND;
  const usage = options.usage ?? OPENAI_COMPATIBLE_FAKE_USAGE;
  let calls = 0;
  const server = createServer((request, response) => {
    void readBody(request).then((text) => {
      // What it was asked, for a drive in another process (`.pi/skills/verify-api/model-fallback.ts`).
      if (request.method === "GET" && request.url === "/__ledger") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ requests }));
        return;
      }
      if (
        request.method !== "POST" ||
        !(request.url ?? "").endsWith("/chat/completions")
      ) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "not found" } }));
        return;
      }
      const body = JSON.parse(text) as {
        readonly model?: unknown;
        readonly messages?: readonly ChatMessage[];
      };
      const model = typeof body.model === "string" ? body.model : "";
      const messages = body.messages ?? [];
      const authorization = request.headers.authorization;
      const answers = messages.filter(
        (message) => message.role === "assistant",
      ).length;
      if (options.fail !== undefined && answers >= options.fail.afterAnswers) {
        const status = options.fail.status ?? 529;
        requests.push({ model, authorization, status, answered: "error" });
        response.writeHead(status, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            type: "error",
            error: {
              type: "overloaded_error",
              message: "Overloaded (the loopback fake is down, as asked)",
            },
          }),
        );
        return;
      }
      calls += 1;
      const id = `chatcmpl-fake-${calls}`;
      const base = { id, object: "chat.completion.chunk", created: 0, model };
      const tool = messages.findLast((message) => message.role === "tool");
      const user = messages.findLast((message) => message.role === "user");
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      if (tool === undefined) {
        requests.push({ model, authorization, status: 200, answered: "bash" });
        response.write(
          event({
            ...base,
            choices: [
              {
                index: 0,
                delta: {
                  role: "assistant",
                  tool_calls: [
                    {
                      index: 0,
                      id: `call_fake_${calls}`,
                      type: "function",
                      function: {
                        name: "bash",
                        arguments: JSON.stringify({ command }),
                      },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          }),
        );
        response.write(
          event({
            ...base,
            choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
          }),
        );
      } else {
        requests.push({ model, authorization, status: 200, answered: "text" });
        const answer = `${contentText(tool.content).trim()} (re: ${contentText(user?.content).trim()})`;
        response.write(
          event({
            ...base,
            choices: [
              {
                index: 0,
                delta: { role: "assistant", content: answer },
                finish_reason: null,
              },
            ],
          }),
        );
        response.write(
          event({
            ...base,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          }),
        );
      }
      response.write(
        event({
          ...base,
          choices: [],
          usage: {
            prompt_tokens: usage.prompt,
            completion_tokens: usage.completion,
            total_tokens: usage.prompt + usage.completion,
          },
        }),
      );
      response.end("data: [DONE]\n\n");
    });
  });
  // oxlint-disable-next-line effecttsgo/new-promise -- a node:http stream and server take callbacks.
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}/v1`,
        requests,
        close: () =>
          // oxlint-disable-next-line effecttsgo/new-promise -- a node:http stream and server take callbacks.
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
};
