// The HTTP half the three adapter drives share (`jira.ts`, `slack.ts`, `github-issues.ts`,
// LOB-259): post a raw body at the running API, read a fake's ledger, read the delivery rows the
// API recorded, and read sessions back over the same Effect RPC client the CLI builds.
//
// Nothing here calls a third party. The drives are the sender, signing with the secrets the shell
// booted the API with, and the only thing they read besides the API's answers is the fakes' own
// ledger files and the API's database.
import { readFileSync } from "node:fs";
import { SQL } from "bun";
import { SessionRpc } from "@repo/domain/Rpc";
import { SessionId, type RepoSlug } from "@repo/domain/Session";
import { Effect } from "effect";
import { RpcClient } from "effect/rpc";

/** One answer from the API: the status, the JSON body as it arrived, and `Retry-After`. */
export type Answer = {
  readonly status: number;
  readonly body: unknown;
  readonly retryAfter: string | null;
};

/** One POST of `raw` to `url`, with `headers` beside a JSON content type. */
export const postRaw = async (
  url: string,
  raw: string,
  headers: Readonly<Record<string, string>>,
): Promise<Answer> => {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: raw,
  });
  return {
    status: response.status,
    body: await response.json().catch(() => null),
    retryAfter: response.headers.get("retry-after"),
  };
};

/** A field of an answer's JSON body, or `undefined` when the body is not an object with it. */
export const field = (answer: Answer, name: string): unknown =>
  typeof answer.body === "object" && answer.body !== null
    ? (answer.body as Record<string, unknown>)[name]
    : undefined;

/** The session id an answer names, or `undefined`. */
export const sessionIdOf = (answer: Answer): SessionId | undefined => {
  const id = field(answer, "sessionId");
  return typeof id === "string" ? SessionId.make(id) : undefined;
};

/** A fake's ledger file, or `empty` while it has none. */
export const readLedger = <Ledger>(path: string, empty: Ledger): Ledger => {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Ledger;
  } catch {
    return empty;
  }
};

/** The `webhook_deliveries` rows the API recorded for these request ids. */
export const deliveryRows = async (
  databaseUrl: string,
  requestIds: ReadonlyArray<string>,
): Promise<Array<{ request_id: string; status: string }>> => {
  const db = new SQL(databaseUrl);
  try {
    return await db`
      SELECT request_id, status FROM webhook_deliveries
      WHERE request_id IN ${db(requestIds)}
    `;
  } finally {
    await db.close();
  }
};

/** The RPC client for a session read, as `RpcClient.make` builds it (see `harness.ts`'s protocol). */
export const sessionClient = RpcClient.make(SessionRpc);

/** How many sessions `repo` has: a drive's own repo is nobody else's, so this is "how many did it open". */
export const sessionsOf = (
  client: Effect.Success<typeof sessionClient>,
  repo: RepoSlug,
) =>
  Effect.gen(function* () {
    const listed = yield* client.listSessions({ limit: 100 });
    return listed.sessions.filter((entry) => entry.repo === repo).length;
  });
