// A second model provider and a role's fallback onto it (S-model-provider-breadth), driven with the
// real Effect RPC client against an API whose second provider is the loopback OpenAI-compatible fake
// (`openai-compatible-fake.ts`) and whose backend is the faux.
//
//   bun model-fallback.ts      (via ./model-fallback.sh, which owns the API, the fake and the database)
//
//   PHASE=role      booted with `ROLE_MODELS=specifier=openai-compatible/compat-1`: a card's run in
//                   `specifying` runs end to end on the endpoint — a `bash` round and an answer that
//                   says what it printed — under that model, keyed with the drive's dummy key, its
//                   spend charged to that model at the endpoint's configured price
//   PHASE=fallback  booted with `ROLE_MODELS=specifier=faux/primary` (whose script answers once, then
//                   answers every request with a 529, F6's `overloaded:1`) and
//                   `ROLE_FALLBACKS=specifier=openai-compatible/compat-1`: the 529 moves the run onto
//                   the endpoint once, the transcript carries one `modelSwitch` line naming both models
//                   and the 529, the run finishes on the endpoint, each answer is charged to the model
//                   that gave it, the session is pinned to the fallback, and a second message stays there
//
// Env: API_URL, FAKE_URL (the endpoint's origin, for its `/__ledger`), EVIDENCE_DIR, PHASE,
// COMPAT_KEY (the dummy key the API was booted with), FAUX_COST, COMPAT_PRICE_IN, COMPAT_PRICE_OUT.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { RpcApi } from "@repo/domain/Rpc";
import { RepoSlug, type SessionSnapshot } from "@repo/domain/Session";
import { DefinitionId } from "@repo/domain/Task";
import { FAUX_OVERLOADED_MESSAGE } from "@repo/harness";
import {
  OPENAI_COMPATIBLE_FAKE_USAGE,
  type OpenAICompatibleFakeRequest,
} from "@repo/harness/openaiCompatibleFake";
import { Effect } from "effect";
import { RpcClient } from "effect/rpc";
import { makeChecker, protocolFor, waitUntil } from "./harness.ts";
import type { CheckRecord } from "./harness.ts";

const API_URL = process.env["API_URL"] ?? "http://127.0.0.1:9448";
const FAKE_URL = process.env["FAKE_URL"] ?? "http://127.0.0.1:9449";
const EVIDENCE_DIR =
  process.env["EVIDENCE_DIR"] ?? ".verify/evidence/latest/api";
const PHASE = process.env["PHASE"] ?? "";
const COMPAT_KEY = process.env["COMPAT_KEY"] ?? "";
const FAUX_COST = Number(process.env["FAUX_COST"] ?? "0");
const PRICE_IN = Number(process.env["COMPAT_PRICE_IN"] ?? "0");
const PRICE_OUT = Number(process.env["COMPAT_PRICE_OUT"] ?? "0");
const PERSON = "person:verify-api";
const COMPAT = "openai-compatible/compat-1";
const PRIMARY = "faux/primary";
/** What one of the endpoint's answers costs at its configured price and the fake's usage. */
const COMPAT_ANSWER =
  (OPENAI_COMPATIBLE_FAKE_USAGE.prompt * PRICE_IN +
    OPENAI_COMPATIBLE_FAKE_USAGE.completion * PRICE_OUT) /
  1e6;

await mkdir(EVIDENCE_DIR, { recursive: true });

const observed: {
  phase: string;
  apiUrl: string;
  snapshots: Record<string, unknown>;
  ledger: ReadonlyArray<OpenAICompatibleFakeRequest> | null;
  checks: Record<string, CheckRecord>;
} = { phase: PHASE, apiUrl: API_URL, snapshots: {}, ledger: null, checks: {} };
const assert = makeChecker(observed);

/** Equal to a cent's millionth: dollars summed in floating point. */
const near = (left: number | undefined, right: number): boolean =>
  left !== undefined && Math.abs(left - right) < 1e-9;

const ledger = Effect.promise(
  async () =>
    (
      (await (await fetch(`${FAKE_URL}/__ledger`)).json()) as {
        readonly requests: ReadonlyArray<OpenAICompatibleFakeRequest>;
      }
    ).requests,
);

const costOf = (snapshot: SessionSnapshot, key: string): number | undefined =>
  snapshot.usage.models.find((entry) => entry.key === key)?.usage.costTotal;

const program = Effect.gen(function* () {
  const client = yield* RpcClient.make(RpcApi);

  /** A card in `specifying` on a board of its own, and its run, which talks to the specifier's model. */
  const specifierRun = (title: string) =>
    Effect.gen(function* () {
      const board = yield* client.createBoard({
        repo: RepoSlug.make(`verify-api/fallback-${PHASE}-${Date.now()}`),
        definitionId: DefinitionId.make("default"),
      });
      const created = yield* client.createTask({
        boardId: board.id,
        title,
        actor: PERSON,
      });
      const card = yield* client.moveTask({
        taskId: created.id,
        expectedRevision: created.revision,
        to: "specifying",
        actor: PERSON,
      });
      const run = yield* client.createSession({
        title,
        taskId: card.id,
        taskColumn: card.column,
      });
      return run.id;
    });

  /** Send `content` and wait for the run to settle on a final answer to it. */
  const settled = (sessionId: Parameters<typeof client.getSession>[0]["sessionId"], content: string) =>
    Effect.gen(function* () {
      yield* client.sendMessage({ sessionId, content });
      return yield* waitUntil(
        Effect.map(client.getSession({ sessionId }), (snapshot) => {
          const last = snapshot.entries.at(-1);
          return !snapshot.live.busy &&
            last?.kind === "assistant" &&
            last.isError !== true &&
            last.text.endsWith(`(re: ${content})`)
            ? snapshot
            : undefined;
        }),
        `the run to answer "${content}"`,
      );
    });

  if (PHASE === "role") {
    const sessionId = yield* specifierRun("fallback: a role on the endpoint");
    const snapshot = yield* settled(sessionId, "go");
    observed.snapshots["role"] = snapshot;
    const requests = yield* ledger;
    observed.ledger = requests;
    assert(
      "the specifier's run is pinned to the endpoint's model",
      snapshot.session.model === COMPAT,
      `model=${snapshot.session.model}`,
    );
    assert(
      "the endpoint was asked twice under compat-1: the bash call, then the answer",
      JSON.stringify(requests.map((r) => [r.model, r.answered])) ===
        JSON.stringify([
          ["compat-1", "bash"],
          ["compat-1", "text"],
        ]),
      JSON.stringify(requests.map((r) => [r.model, r.answered])),
    );
    assert(
      "every request carried the key pi-ai resolved from OPENAI_COMPATIBLE_API_KEY",
      requests.length > 0 &&
        requests.every((r) => r.authorization === `Bearer ${COMPAT_KEY}`),
      `authorizations=${new Set(requests.map((r) => r.authorization === `Bearer ${COMPAT_KEY}`)).size}`,
    );
    assert(
      "the run's tool ran and its answer says what it printed",
      snapshot.entries.some(
        (entry) => entry.kind === "toolResult" && entry.toolName === "bash",
      ) && snapshot.entries.at(-1)?.text === "compat-ok (re: go)",
      `last=${snapshot.entries.at(-1)?.text}`,
    );
    assert(
      "the spend is the endpoint model's, at its configured price",
      snapshot.usage.models.length === 1 &&
        near(costOf(snapshot, COMPAT), 2 * COMPAT_ANSWER),
      JSON.stringify(snapshot.usage.models.map((m) => [m.key, m.usage.costTotal])),
    );
    return;
  }

  if (PHASE === "fallback") {
    const sessionId = yield* specifierRun("fallback: the primary is down");
    const first = yield* settled(sessionId, "go");
    observed.snapshots["first"] = first;
    const switches = first.entries.filter((entry) => entry.kind === "modelSwitch");
    assert(
      "the 529 switched the run once, and the transcript says so",
      switches.length === 1 &&
        switches[0]?.text.includes(`${PRIMARY} is unavailable`) === true &&
        switches[0]?.text.includes(FAUX_OVERLOADED_MESSAGE) === true &&
        switches[0]?.text.includes(`go to ${COMPAT}`) === true,
      switches.map((entry) => entry.text).join(" / "),
    );
    const kinds = first.entries
      .filter((entry) => entry.kind !== "system" && entry.kind !== "title")
      .map((entry) =>
        entry.kind === "assistant" && entry.isError === true ? "error" : entry.kind,
      );
    assert(
      "the transcript reads: the primary's tool round, the switch, its 529, the fallback's answer",
      JSON.stringify(kinds) ===
        JSON.stringify(["user", "assistant", "toolResult", "modelSwitch", "error", "assistant"]),
      JSON.stringify(kinds),
    );
    const requests = yield* ledger;
    observed.ledger = requests;
    assert(
      "the fallback was asked once, for the answer, picking up the primary's tool result",
      requests.length === 1 &&
        requests[0]?.answered === "text" &&
        first.entries.at(-1)?.text === "faux-ok (re: go)",
      `requests=${requests.length} last=${first.entries.at(-1)?.text}`,
    );
    assert(
      "each answer is charged to the model that gave it",
      first.usage.models.length === 2 &&
        near(costOf(first, PRIMARY), FAUX_COST) &&
        near(costOf(first, COMPAT), COMPAT_ANSWER),
      JSON.stringify(first.usage.models.map((m) => [m.key, m.usage.costTotal])),
    );
    assert(
      "the session is pinned to the fallback the switch recorded",
      first.session.model === COMPAT,
      `model=${first.session.model}`,
    );
    const second = yield* settled(sessionId, "again");
    observed.snapshots["second"] = second;
    const after = yield* ledger;
    observed.ledger = after;
    assert(
      "a second message stays on the fallback, and nothing switches again",
      second.entries.filter((entry) => entry.kind === "modelSwitch").length === 1 &&
        after.length === 2 &&
        near(costOf(second, PRIMARY), FAUX_COST) &&
        near(costOf(second, COMPAT), 2 * COMPAT_ANSWER),
      `switches=${second.entries.filter((entry) => entry.kind === "modelSwitch").length} requests=${after.length}`,
    );
    const info = yield* client.getServerInfo({});
    assert(
      "getServerInfo names the chain and the endpoint's model",
      JSON.stringify(info.roleFallbacks) ===
        JSON.stringify([{ role: "specifier", models: [COMPAT] }]) &&
        info.models.includes(COMPAT),
      JSON.stringify({ roleFallbacks: info.roleFallbacks, models: info.models }),
    );
    return;
  }

  return yield* Effect.die(new Error(`PHASE must be role or fallback, not ${PHASE}`));
});

try {
  await Effect.runPromise(
    program.pipe(Effect.provide(protocolFor(API_URL)), Effect.scoped),
  );
} catch (error) {
  assert("the drive completed", false, `threw: ${String(error)}`);
}

await writeFile(
  path.join(EVIDENCE_DIR, `model-fallback-${PHASE}.json`),
  `${JSON.stringify(observed, null, 2)}\n`,
);

const failed = Object.entries(observed.checks).filter(([, check]) => !check.passed);
if (failed.length > 0) {
  console.error(`\n${failed.length} required check(s) failed`);
  process.exitCode = 1;
}
