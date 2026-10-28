#!/usr/bin/env bun
// An MCP client for `factory mcp` (S-local-agent-handoff-mcp): what Claude Code does with a stdio
// server it was configured with, done by a script so the drive needs no model and no token.
//
// It launches the server the way `claude mcp add factory -- factory mcp …` does — a child process in
// the checkout, spoken to as newline-delimited JSON-RPC on its stdin and stdout — and runs the
// session a delegating agent would: `initialize` at the revision Claude Code sends, the
// `notifications/initialized` that ends the handshake, `tools/list`, then `create_card` and
// `get_status` on the card it made. Every line the server wrote to stdout is kept, so the drive can
// check that each one is a JSON-RPC message (the transport forbids anything else there).
//
// Env: FACTORY (the command that runs the CLI, e.g. `bun run apps/cli/src/index.ts`), API_URL, REPO,
// CHECKOUT (where the server runs), PROTOCOL (the revision to initialize at), TITLE, EVIDENCE (the
// JSON file to write). Prints `card <tsk_…>` and `status <text>` on stdout; exits non-zero when the
// server did not answer every request.
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";

const env = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value === "")
    throw new Error(`${name} is not set`);
  return value;
};

const [command, ...args] = env("FACTORY").split(" ");
if (command === undefined) throw new Error("FACTORY is empty");
const child = spawn(
  command,
  [...args, "mcp", "--api", env("API_URL"), "--repo", env("REPO")],
  { cwd: env("CHECKOUT"), stdio: ["pipe", "pipe", "pipe"] },
);

const lines: Array<string> = [];
const stderr: Array<string> = [];
const waiting = new Map<number, (message: Record<string, unknown>) => void>();
let buffer = "";
child.stdout.on("data", (chunk: Buffer) => {
  buffer += chunk.toString("utf8");
  let newline = buffer.indexOf("\n");
  while (newline !== -1) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    newline = buffer.indexOf("\n");
    lines.push(line);
    try {
      const message = JSON.parse(line) as Record<string, unknown>;
      const id = message["id"];
      if (typeof id === "number") waiting.get(id)?.(message);
    } catch {
      // Kept in `lines`: the drive's check is that there are none of these.
    }
  }
});
child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk.toString("utf8")));

let nextId = 0;
const request = (method: string, params?: Record<string, unknown>) =>
  new Promise<Record<string, unknown>>((resolve, reject) => {
    nextId += 1;
    const id = nextId;
    const timer = setTimeout(
      () => reject(new Error(`no answer to ${method} (id ${id}) in 60s`)),
      60_000,
    );
    waiting.set(id, (message) => {
      clearTimeout(timer);
      resolve(message);
    });
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) })}\n`,
    );
  });
const notify = (method: string) =>
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);

/** A tool call's structured result, or its error text. */
const call = async (name: string, args: Record<string, unknown>) => {
  const answer = await request("tools/call", { name, arguments: args });
  const result = answer["result"] as
    | {
        isError?: boolean;
        structuredContent?: Record<string, unknown>;
        content?: Array<{ text?: string }>;
      }
    | undefined;
  const structured = result?.structuredContent ?? {};
  // A result's words are its `text` field; the content block carries the whole result as JSON, and
  // an error's block carries its message alone.
  const text =
    typeof structured["text"] === "string"
      ? structured["text"]
      : (result?.content?.map((part) => part.text ?? "").join("\n") ?? "");
  return { answer, isError: result?.isError === true, structured, text };
};

let failed = false;
const transcript: Record<string, unknown> = {};
try {
  const initialize = await request("initialize", {
    protocolVersion: env("PROTOCOL"),
    capabilities: { roots: {} },
    clientInfo: { name: "claude-code", version: "2.1.312" },
  });
  notify("notifications/initialized");
  const listed = await request("tools/list");
  const created = await call("create_card", {
    title: env("TITLE"),
    body: "Made through factory mcp by verify-cli's mcp.sh.",
  });
  const taskId = String(created.structured["taskId"] ?? "");
  const status = await call("get_status", { taskId });
  Object.assign(transcript, { initialize, listed, created, status });
  console.log(`card ${taskId}`);
  console.log(`created ${created.isError ? "error" : "ok"} ${created.text}`);
  console.log(`status ${status.isError ? "error" : "ok"} ${status.text}`);
} catch (error) {
  failed = true;
  console.log(`error ${String(error)}`);
}
// Hanging up is closing stdin; the server is the client's child and must exit with it.
child.stdin.end();
const exit = await new Promise<number | null>((resolve) => {
  const timer = setTimeout(() => {
    child.kill("SIGKILL");
    resolve(null);
  }, 15_000);
  child.on("exit", (code) => {
    clearTimeout(timer);
    resolve(code);
  });
});
const strays = lines.filter((line) => {
  try {
    return (JSON.parse(line) as { jsonrpc?: unknown }).jsonrpc !== "2.0";
  } catch {
    return true;
  }
});
console.log(`stdout ${lines.length} lines, ${strays.length} not JSON-RPC`);
console.log(`exited ${exit === null ? "no (killed)" : "yes"}`);
await writeFile(
  env("EVIDENCE"),
  `${JSON.stringify({ ...transcript, stdout: lines, strays, stderr: stderr.join(""), exit }, null, 2)}\n`,
);
process.exit(failed ? 1 : 0);
