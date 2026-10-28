// A loopback OTLP/HTTP metrics receiver for ./metrics.sh (LOB-69): the local collector the API's
// metrics exporter is pointed at. Not motel — motel has no metrics route.
//
//   OTLP_RECEIVER_PORT=9541 bun otlp-receiver.ts
//
//   POST /v1/metrics   kept as received (method, path, content type, the JSON body), answered with
//                      OTLP/HTTP's success: 200 and an empty `ExportMetricsServiceResponse`
//   GET  /received     every request kept so far, as a JSON array, for the driver to read
//
// Anything else is a 404, so an exporter posting to the wrong path is visible as no record at all.
// Each request is also appended to $EVIDENCE_DIR/metrics-received.ndjson as it arrives.
//
// Env: OTLP_RECEIVER_PORT (9541 when unset), EVIDENCE_DIR.
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

const PORT = Number(process.env["OTLP_RECEIVER_PORT"] ?? "9541");
const EVIDENCE_DIR =
  process.env["EVIDENCE_DIR"] ?? ".verify/evidence/latest/api";
const LEDGER = path.join(EVIDENCE_DIR, "metrics-received.ndjson");

await mkdir(EVIDENCE_DIR, { recursive: true });

type Received = {
  readonly at: string;
  readonly method: string;
  readonly path: string;
  readonly contentType: string | null;
  readonly body: unknown;
};
const received: Received[] = [];

Bun.serve({
  hostname: "127.0.0.1",
  port: PORT,
  fetch: async (request) => {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/received") {
      return Response.json(received);
    }
    if (request.method === "POST" && url.pathname === "/v1/metrics") {
      const text = await request.text();
      let body: unknown = null;
      try {
        body = JSON.parse(text);
      } catch {
        body = { unparsed: text.slice(0, 200) };
      }
      const record: Received = {
        at: new Date().toISOString(),
        method: request.method,
        path: url.pathname,
        contentType: request.headers.get("content-type"),
        body,
      };
      received.push(record);
      await appendFile(LEDGER, `${JSON.stringify(record)}\n`);
      return Response.json({});
    }
    return new Response("not found", { status: 404 });
  },
});

console.log(`otlp receiver  http://127.0.0.1:${PORT}/v1/metrics`);
