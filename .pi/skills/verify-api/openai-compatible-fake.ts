// The loopback OpenAI-compatible endpoint a drive points `OPENAI_COMPATIBLE_BASE_URL` at
// (S-model-provider-breadth): `@repo/harness`'s fake, the one the gate's suites use, served on
// 127.0.0.1 until the process is killed. `GET /__ledger` answers every request it served.
//
//   OPENAI_COMPATIBLE_FAKE_PORT=9449 bun openai-compatible-fake.ts
//
// Env: OPENAI_COMPATIBLE_FAKE_PORT (required), OPENAI_COMPATIBLE_FAKE_READY (a file it writes its
// base URL to once it listens, so the caller waits on a file rather than a sleep).
import { writeFile } from "node:fs/promises";
import { startOpenAICompatibleFake } from "@repo/harness/openaiCompatibleFake";

const port = Number(process.env["OPENAI_COMPATIBLE_FAKE_PORT"] ?? "");
if (!Number.isInteger(port) || port <= 0) {
  console.error("OPENAI_COMPATIBLE_FAKE_PORT must name a port");
  process.exit(1);
}
const fake = await startOpenAICompatibleFake({ port });
console.log(`openai-compatible fake on ${fake.url}`);
const ready = process.env["OPENAI_COMPATIBLE_FAKE_READY"];
if (ready !== undefined && ready !== "") await writeFile(ready, fake.url);
