// Drive ONE policy refusal through the real session API (LOB-8, docs/design.md D11/D15).
//
//   CASE=push-main bun drive.ts
//
// Env:
//   API_URL       default http://localhost:9600
//   CASE          which refusal to expect (see CASES)
//   PROBE_PATH    the file the write-outside case must fail to create
//   EVIDENCE_DIR  default .verify/evidence/latest
//
// Why the API and not a unit test: `packages/harness`'s suite proves the decision and the hook. This
// proves the policy is installed in the path a real session takes — RPC → `SessionService` →
// `openSession` → the `policy` extension beside `CodingTools` — and that the refusal is what the
// transcript records. A unit test that passed while `SessionServiceLive` forgot to pass a policy
// would be worse than no test.
//
// One instance per case: the faux script is fixed when the API boots (`FAUX_COMMAND`), so
// `./refusals.sh` boots one instance per command and calls this driver once each.
import { existsSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { SessionRpc } from "@repo/domain/Rpc";
import { Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/http";
import { RpcClient, RpcSerialization } from "effect/rpc";

const API_URL = process.env["API_URL"] ?? "http://localhost:9600";
const CASE = process.env["CASE"] ?? "push-main";
const PROBE_PATH =
  process.env["PROBE_PATH"] ?? ".verify/run-policy/escaped.txt";
const EVIDENCE_DIR = process.env["EVIDENCE_DIR"] ?? ".verify/evidence/latest";

/** What each case must see in the transcript, and whether it must leave the filesystem alone. */
const CASES: Record<
  string,
  {
    readonly expect: readonly string[];
    readonly probe?: true;
    readonly allowed?: true;
  }
> = {
  // The four refusals the issue's acceptance names.
  "push-main": {
    expect: ["Tool call blocked", "pushing refs/heads/main is refused"],
  },
  "force-push": { expect: ["git push --force is refused"] },
  "delete-ref": { expect: ["deleting a ref loses"] },
  "write-outside": {
    expect: ["redirecting output to", "may only write inside its worktree"],
    probe: true,
  },
  // The rest of D11's always-blocked list, so a policy that only covers the four is not "passing".
  "tag-push": { expect: ["git push --tags is refused"] },
  "remote-change": { expect: ["git remote set-url is refused"] },
  egress: { expect: ["network egress to evil.example"] },
  // The control: a policy that refused everything would pass every check above.
  allow: { expect: ["faux-ok"], allowed: true },
};

const expectation = CASES[CASE];
if (expectation === undefined) {
  console.error(
    `unknown CASE ${CASE}; expected one of ${Object.keys(CASES).join(", ")}`,
  );
  process.exit(2);
}

/**
 * The driver must never leave the machine.
 *
 * `API_URL` is where this process connects; a URL that is not loopback means the drive is talking
 * to an API somewhere else, and the refusal it records is not this machine's.
 */
const LOOPBACK = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):\d+$/;

await mkdir(EVIDENCE_DIR, { recursive: true });
// A previous run must not leave the probe behind, or "the file is not there" would be vacuous.
if (existsSync(PROBE_PATH)) rmSync(PROBE_PATH);

const checks: Record<
  string,
  { readonly passed: boolean; readonly detail: string }
> = {};
const assert = (name: string, condition: unknown, detail: string): boolean => {
  checks[name] = { passed: Boolean(condition), detail };
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}  ${detail}`);
  return Boolean(condition);
};

const ProtocolLive = RpcClient.layerProtocolHttp({
  url: `${API_URL}/rpc`,
}).pipe(
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(RpcSerialization.layerNdjson),
);

/** Poll until `check` yields anything but `false`, so the driver never depends on a fixed delay. */
const waitUntil = <A, E, R>(
  check: Effect.Effect<A, E, R>,
  label: string,
): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const value = yield* check;
      if (value !== false && value !== undefined) return value as A;
      yield* Effect.sleep(100);
    }
    return yield* Effect.die(new Error(`timed out waiting for ${label}`));
  });

const observed: Record<string, unknown> = {
  case: CASE,
  apiUrl: API_URL,
  fauxCommand: process.env["FAUX_COMMAND"],
  probePath: PROBE_PATH,
};

assert(
  "the api url is loopback, so the drive stays on this machine",
  LOOPBACK.test(API_URL),
  `apiUrl=${API_URL}`,
);

const program = Effect.gen(function* () {
  const client = yield* RpcClient.make(SessionRpc);

  const created = yield* client.createSession({
    title: `verify-policy ${CASE}`,
  });
  const before = yield* client.getSession({ sessionId: created.id });
  const worktree = before.workspace.path;

  const sent = yield* client.sendMessage({
    sessionId: created.id,
    content: `verify-policy ${CASE}`,
  });
  assert(
    "the message is admitted as a run",
    sent.placement === "run",
    `placement=${sent.placement} session=${created.id}`,
  );

  // Settled means: the tool call has a result in the transcript AND the run is idle. Polling for
  // idle alone would read the snapshot before the run starts.
  const snapshot = yield* waitUntil(
    client
      .getSession({ sessionId: created.id })
      .pipe(
        Effect.map((state) =>
          state.entries.some((entry) => entry.kind === "toolResult") &&
          !state.live.busy
            ? state
            : false,
        ),
      ),
    "the tool result to settle",
  );

  const result = snapshot.entries.find((entry) => entry.kind === "toolResult");
  const answer = snapshot.entries
    .filter((entry) => entry.kind === "assistant")
    .at(-1);

  if (expectation.allowed === true) {
    assert(
      "the control command is not refused",
      result?.isError === false,
      `isError=${result?.isError} text=${JSON.stringify(result?.text)}`,
    );
    assert(
      "the control command really ran",
      answer?.text.includes("faux-ok") === true,
      `answer=${JSON.stringify(answer?.text)}`,
    );
  } else {
    assert(
      "the refusal is the tool result, not a crash",
      result?.isError === true,
      `isError=${result?.isError} text=${JSON.stringify(result?.text)}`,
    );
    for (const fragment of expectation.expect) {
      assert(
        `the refusal says ${JSON.stringify(fragment)}`,
        result?.text.includes(fragment) === true,
        `text=${JSON.stringify(result?.text)}`,
      );
    }
    assert(
      "the refusal reaches the model's next turn",
      answer?.text.includes("Tool call blocked") === true,
      `answer=${JSON.stringify(answer?.text)}`,
    );
  }

  // The model is pi-ai's scripted faux provider, which answers with the newest `bash` result and the
  // prompt that produced it: `<tool result> (re: <prompt>)`. Nothing else here can tell a drive run
  // apart from one that reached a real provider, so the shape is asserted rather than assumed — and
  // with it, that the round trip really happened (an answer that never saw the tool result could not
  // carry it).
  const echo = `${(result?.text ?? "").trim()} (re: verify-policy ${CASE})`;
  assert(
    "the answer is the scripted provider's echo of the tool result",
    answer?.text === echo,
    `answer=${JSON.stringify(answer?.text)} expected=${JSON.stringify(echo)}`,
  );

  if (expectation.probe === true) {
    // The half a transcript read cannot prove: a refused write that still wrote would look refused.
    assert(
      "the refused write did not happen",
      !existsSync(PROBE_PATH),
      `probe=${PROBE_PATH} exists=${existsSync(PROBE_PATH)}`,
    );
    assert(
      "the refusal names the session's worktree",
      result?.text.includes(worktree) === true,
      `worktree=${worktree}`,
    );
  }

  observed["sessionId"] = created.id;
  observed["worktree"] = worktree;
  observed["entries"] = snapshot.entries.map((entry) => ({
    kind: entry.kind,
    isError: entry.isError,
    toolName: entry.toolName,
    text: entry.text,
  }));
  observed["status"] = snapshot.session.status;
}).pipe(Effect.provide(ProtocolLive), Effect.scoped);

try {
  await Effect.runPromise(program);
} catch (cause) {
  // Evidence is written either way: a driver that died must not look like a driver that passed.
  assert("the driver completed", false, `threw: ${String(cause)}`);
}

observed["checks"] = checks;
observed["passed"] = Object.values(checks).every((check) => check.passed);

// One file per case, plus an aggregate, so `refusals.sh` can be read without the log.
const evidencePath = `${EVIDENCE_DIR}/refusal-${CASE}.json`;
await writeFile(evidencePath, `${JSON.stringify(observed, null, 2)}\n`);

const aggregatePath = `${EVIDENCE_DIR}/refusals.json`;
const previous = await readFile(aggregatePath, "utf8")
  .then((text) => JSON.parse(text) as Record<string, unknown>)
  .catch(() => ({}) as Record<string, unknown>);
previous[CASE] = observed;
previous["passed"] = Object.values(previous)
  .filter(
    (value): value is Record<string, unknown> =>
      typeof value === "object" && value !== null,
  )
  .every((value) => value["passed"] === true);
await writeFile(aggregatePath, `${JSON.stringify(previous, null, 2)}\n`);

console.log(`evidence ${evidencePath}`);
console.log(`${observed["passed"] ? "PASS" : "FAIL"}  case ${CASE}`);
process.exit(observed["passed"] ? 0 : 1);
