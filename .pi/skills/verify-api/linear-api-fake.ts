// The loopback Linear GraphQL API the write-back is driven against (LOB-15).
//
// One route, because Linear's API is one: `POST /graphql`. It answers exactly the four operations
// the sync sends — the issue read (`query FactoryIssue`), `commentCreate`, `issueUpdate` and
// `attachmentCreate` — and anything else is a GraphQL error, so a client that started asking for
// more would fail here instead of being answered by a fake that guessed. Any other path is a 404.
//
// Issues are created on first read, in `Todo`, in a team with Linear's default workflow states, so
// the driver can name a fresh issue per run without seeding anything. The ledger is a file rather
// than memory so "one comment, not two" is a countable fact a later reader can open: every request
// (operation, variables, `Authorization`) and every issue's state, comments and attachments.
//
//   LINEAR_FAKE_PORT           port to listen on (default 9416)
//   LINEAR_FAKE_LEDGER         ledger file path, required
//   LINEAR_FAKE_LOSE_ACK       an issue identifier: its FIRST `commentCreate` is applied and then
//                              answered 500 — Linear has the comment, the caller never learned it,
//                              and a retry must not turn that into a second comment
//   LINEAR_FAKE_TEAM_STATES    comma-separated state names to give the team instead of the default
import { readFileSync, writeFileSync } from "node:fs";

type State = {
  readonly id: string;
  readonly name: string;
  readonly type: string;
};

type Issue = {
  readonly id: string;
  readonly identifier: string;
  state: State;
  readonly comments: string[];
  readonly attachments: Array<{ readonly url: string; readonly title: string }>;
};

type Ledger = {
  readonly requests: Array<{
    readonly operation: string;
    readonly variables: unknown;
    readonly authorization: string | null;
  }>;
  readonly issues: Record<string, Issue>;
  /** The issues whose comment landed and was answered 500: the window the retry has to close. */
  readonly lostAcks: string[];
};

const port = Number(process.env["LINEAR_FAKE_PORT"] ?? "9416");
const ledgerPath = process.env["LINEAR_FAKE_LEDGER"];
const loseAck = process.env["LINEAR_FAKE_LOSE_ACK"] ?? "";

if (ledgerPath === undefined || ledgerPath === "") {
  console.error("LINEAR_FAKE_LEDGER is required: the ledger is the evidence");
  process.exit(1);
}

const typeOf: Record<string, string> = {
  Backlog: "backlog",
  Todo: "unstarted",
  "In Progress": "started",
  "In Review": "started",
  Done: "completed",
  Canceled: "canceled",
};

const STATES: readonly State[] = (
  process.env["LINEAR_FAKE_TEAM_STATES"]?.split(",") ?? Object.keys(typeOf)
).map((name) => ({
  id: `state-${name.toLowerCase().replaceAll(" ", "-")}`,
  name,
  type: typeOf[name] ?? "started",
}));

const empty: Ledger = { requests: [], issues: {}, lostAcks: [] };

const read = (): Ledger => {
  try {
    return JSON.parse(readFileSync(ledgerPath, "utf8")) as Ledger;
  } catch {
    return empty;
  }
};

/** Synchronous, so a write is on disk before its response is. */
const write = (ledger: Ledger): void => {
  writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
};

write(empty);

const lost = new Set<string>();

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const operationOf = (query: string): string | undefined =>
  query.startsWith("query FactoryIssue")
    ? "issue"
    : query.includes("commentCreate(")
      ? "commentCreate"
      : query.includes("issueUpdate(")
        ? "issueUpdate"
        : query.includes("attachmentCreate(")
          ? "attachmentCreate"
          : undefined;

/** The issue a variable names — by UUID or identifier — created on first sight. */
const issueFor = (ledger: Ledger, key: string): Issue => {
  const known = Object.values(ledger.issues).find(
    (issue) => issue.id === key || issue.identifier === key,
  );
  if (known !== undefined) return known;
  const todo = STATES.find((state) => state.name === "Todo") ?? STATES[0];
  const issue: Issue = {
    id: `uuid-${key}`,
    identifier: key,
    state: todo as State,
    comments: [],
    attachments: [],
  };
  ledger.issues[key] = issue;
  return issue;
};

const server = Bun.serve({
  port,
  hostname: "127.0.0.1",
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/graphql") {
      return json(404, { error: "not a Linear API route" });
    }
    const body = (await request.json()) as {
      readonly query?: string;
      readonly variables?: Record<string, unknown>;
    };
    const operation = operationOf(body.query ?? "");
    const variables = body.variables ?? {};
    const ledger = read();
    ledger.requests.push({
      operation: operation ?? "unknown",
      variables,
      authorization: request.headers.get("authorization"),
    });
    const input = (variables["input"] ?? {}) as Record<string, unknown>;

    switch (operation) {
      case "issue": {
        const issue = issueFor(ledger, String(variables["id"]));
        write(ledger);
        return json(200, {
          data: {
            issue: {
              id: issue.id,
              identifier: issue.identifier,
              state: issue.state,
              team: { states: { nodes: STATES } },
              comments: {
                nodes: issue.comments.map((text) => ({ body: text })),
              },
              attachments: {
                nodes: issue.attachments.map(({ url }) => ({ url })),
              },
            },
          },
        });
      }
      case "commentCreate": {
        const issue = issueFor(ledger, String(input["issueId"]));
        issue.comments.push(String(input["body"]));
        const lose =
          issue.identifier === loseAck && !lost.has(issue.identifier);
        if (lose) {
          lost.add(issue.identifier);
          ledger.lostAcks.push(issue.identifier);
        }
        write(ledger);
        if (lose) {
          return json(500, { error: "upstream timeout (the comment landed)" });
        }
        return json(200, { data: { commentCreate: { success: true } } });
      }
      case "issueUpdate": {
        const issue = issueFor(ledger, String(variables["id"]));
        const next = STATES.find((state) => state.id === input["stateId"]);
        if (next !== undefined) issue.state = next;
        write(ledger);
        return json(200, {
          data: { issueUpdate: { success: next !== undefined } },
        });
      }
      case "attachmentCreate": {
        const issue = issueFor(ledger, String(input["issueId"]));
        issue.attachments.push({
          url: String(input["url"]),
          title: String(input["title"]),
        });
        write(ledger);
        return json(200, { data: { attachmentCreate: { success: true } } });
      }
      default:
        write(ledger);
        return json(200, {
          data: null,
          errors: [
            {
              message:
                "this fake answers only the write-back's four operations",
            },
          ],
        });
    }
  },
});

console.log(`linear api fake listening on ${server.url}`);
