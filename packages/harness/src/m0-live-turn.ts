/**
 * M0 — one live agent turn, end to end, locally.
 *
 * Proves the pieces the design depends on:
 *   - Pi Durable opens a Harness over storage with a local ExecutionEnv
 *   - a real model turn runs against the Anthropic provider
 *   - tool calls execute in NodeExecutionEnv and round-trip into the transcript
 *   - viewState() exposes what the control-plane read model needs (design D8)
 *   - harness.usage() returns the cost data attribution needs (design R4)
 *
 * Disposable: delete once M1/M2 replace it with real tests.
 *
 *   cp .env.example .env   # add ANTHROPIC_API_KEY
 *   bun run m0
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import {
  createRegistry,
  Harness,
  MemoryStorage,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";

const PROMPT =
  "Use the bash tool to run `echo m0-ok`. Then reply with exactly the output of that command and nothing else.";

if (!process.env["ANTHROPIC_API_KEY"]) {
  console.error(
    [
      "ANTHROPIC_API_KEY is not set.",
      "",
      "  cp .env.example .env   # then paste your key",
      "  bun run m0",
    ].join("\n"),
  );
  process.exit(1);
}

const context = BACKGROUND_CONTEXT;

const models = createModels();
models.setProvider(anthropicProvider());

const registry = createRegistry();
registry.install(CodingTools);

const env = ({ cwd }: { cwd?: string }) =>
  new NodeExecutionEnv({ cwd: cwd ?? process.cwd() });

const harness = await Harness.open(
  new MemoryStorage(),
  { models, registry, env },
  context,
);

const root = await harness.root(context, {
  agent: {
    model: { provider: "anthropic", modelId: "claude-sonnet-5-5" },
    cwd: process.cwd(),
  },
});

console.log("→ submitting turn\n");

const submission = await root.submit(
  { type: "input", content: PROMPT, requestId: "m0" },
  context,
);
await submission.wait(context);

const view = await root.viewState(context);
const entries = view.value?.entries ?? [];

console.log(`entries in transcript: ${entries.length}\n`);

for (const entry of entries) {
  const record = entry as unknown as Record<string, unknown>;
  const kind = String(record["kind"] ?? record["type"] ?? "entry");
  const model = record["model"] as
    | readonly { type?: string; text?: string }[]
    | undefined;
  const text = (model ?? [])
    .flatMap((content) =>
      content?.type === "text" && content.text ? [content.text] : [],
    )
    .join("")
    .trim();
  console.log(
    `  [${kind}] ${text.length > 300 ? `${text.slice(0, 300)}…` : text}`,
  );
}

console.log("\n→ usage");
console.log(JSON.stringify(await harness.usage(context), null, 2));

await harness.close(context);
