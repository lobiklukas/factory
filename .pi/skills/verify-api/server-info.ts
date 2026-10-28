// What the control plane is running, and the model each session runs on (LOB-269), driven with the
// real Effect RPC client.
//
//   bun server-info.ts      (via ./server-info.sh, which boots the API this drives)
//
//   info      `getServerInfo` answers backend faux selected by MODEL_BACKEND, `faux/faux-1`, the
//             `ROLE_MODELS` rows the shell set (and up.sh's replay row), the approval gate, the
//             default budget, the armed webhook routes, and no model credential mode
//   wire      the same call's raw NDJSON body carries none of the dummy credentials' values
//   model     a session created over RPC names `faux/faux-1` on `createSession`, `getSession` and
//             its `listSessions` row
//
// Env: API_URL, EVIDENCE_DIR, SERVER_INFO_ANTHROPIC_KEY / _GITHUB_SECRET / _LINEAR_SECRET (the
// dummies the shell booted the API with).
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { RpcApi } from "@repo/domain/Rpc";
import type { ServerInfo } from "@repo/domain/Server";
import { Effect } from "effect";
import { RpcClient } from "effect/rpc";
import { makeChecker, protocolFor } from "./harness.ts";
import type { CheckRecord } from "./harness.ts";

const API_URL = process.env["API_URL"] ?? "http://localhost:9200";
const EVIDENCE_DIR =
  process.env["EVIDENCE_DIR"] ?? ".verify/evidence/latest/api";
const SECRETS = [
  process.env["SERVER_INFO_ANTHROPIC_KEY"],
  process.env["SERVER_INFO_GITHUB_SECRET"],
  process.env["SERVER_INFO_LINEAR_SECRET"],
].filter((value): value is string => value !== undefined && value !== "");

await mkdir(EVIDENCE_DIR, { recursive: true });

const observed: {
  apiUrl: string;
  info: ServerInfo | null;
  session: Record<string, unknown>;
  checks: Record<string, CheckRecord>;
} = { apiUrl: API_URL, info: null, session: {}, checks: {} };
const assert = makeChecker(observed);

assert(
  "the drive was given the dummies to look for",
  SECRETS.length === 3,
  `${SECRETS.length} dummies`,
);

await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const client = yield* RpcClient.make(RpcApi);
      const info = yield* client.getServerInfo({});
      observed.info = info;
      assert("info: backend faux", info.backend === "faux", info.backend);
      assert(
        "info: selected by MODEL_BACKEND",
        info.selectedBy === "MODEL_BACKEND",
        info.reason,
      );
      assert(
        "info: default model faux/faux-1",
        info.defaultModel === "faux/faux-1",
        info.defaultModel,
      );
      const roles = info.roleModels.map((row) => `${row.role}=${row.model}`);
      assert(
        "info: the ROLE_MODELS rows",
        roles.join(",") ===
          "replay-target=faux/faux-2,specifier=faux/faux-spec",
        roles.join(","),
      );
      assert(
        "info: the catalog serves every role model",
        ["faux/faux-1", "faux/faux-2", "faux/faux-spec"].every((key) =>
          info.models.includes(key),
        ),
        info.models.join(","),
      );
      assert(
        "info: the approval gate",
        info.approvalRequired.join(",") === "npm publish",
        info.approvalRequired.join(","),
      );
      assert(
        "info: the default budget",
        info.defaultBudget === 3,
        String(info.defaultBudget),
      );
      assert(
        "info: no model credential under faux",
        info.credentialMode.model === null,
        JSON.stringify(info.credentialMode),
      );
      const armed = info.webhooks
        .filter((route) => route.armed)
        .map((route) => route.route);
      assert(
        "info: the armed webhook routes",
        armed.join(",") === "/webhooks/linear,/webhooks/github",
        armed.join(","),
      );
      assert(
        "info: the faux warning",
        info.warnings.length > 0,
        info.warnings[0] ?? "none",
      );

      const created = yield* client.createSession({
        title: "server-info probe",
      });
      const snapshot = yield* client.getSession({ sessionId: created.id });
      const row = (yield* client.listSessions({ limit: 50 })).sessions.find(
        (entry) => entry.id === created.id,
      );
      observed.session = {
        id: created.id,
        created: created.model,
        snapshot: snapshot.session.model,
        listed: row?.model,
      };
      assert(
        "model: createSession names faux/faux-1",
        created.model === "faux/faux-1",
        String(created.model),
      );
      assert(
        "model: getSession names faux/faux-1",
        snapshot.session.model === "faux/faux-1",
        String(snapshot.session.model),
      );
      assert(
        "model: the listSessions row names faux/faux-1",
        row?.model === "faux/faux-1",
        String(row?.model),
      );
    }),
  ).pipe(Effect.provide(protocolFor(API_URL))),
);

// The bytes a client receives, not only what a decoder kept: one raw NDJSON request.
const response = await fetch(`${API_URL}/rpc`, {
  method: "POST",
  headers: { "content-type": "application/ndjson" },
  body: `${JSON.stringify({ _tag: "Request", id: "1", tag: "getServerInfo", payload: {}, headers: [] })}\n`,
});
const wire = await response.text();
assert(
  "wire: the raw body is the answer",
  wire.includes('"_tag":"Exit"') && wire.includes('"backend":"faux"'),
  `${wire.length} bytes`,
);
assert(
  "wire: no dummy credential's value in the raw body",
  SECRETS.every((secret) => !wire.includes(secret)),
  `${SECRETS.length} dummies checked`,
);

await writeFile(
  path.join(EVIDENCE_DIR, "server-info.json"),
  `${JSON.stringify({ skill: "verify-api", script: "server-info.sh", ...observed }, null, 2)}\n`,
);
const failed = Object.values(observed.checks).filter((check) => !check.passed);
process.exit(failed.length === 0 ? 0 : 1);
