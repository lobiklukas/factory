# MCP tools for the agent (S-agent-mcp-tools)

**What it is.** A run can call the tools of a remote MCP server — an issue tracker, a docs search —
when the deployment registers the server and the run's repository allows it. Three parties, each
narrowing what the one before allows:

- **The deployment** registers servers in `MCP_SERVERS`, a JSON array of `{ "name", "url",
"secret"? }`. `url` is the server's Streamable HTTP endpoint (`https`, or `http` on loopback);
  `secret` names the repository secret (`factory secrets set <repo> <NAME>`) sent as
  `Authorization: Bearer`. Registering a server offers nothing. A malformed list fails the boot, and
  the boot log names each server.
- **The repository** names, in the `policy` block of its `.factory/config` at the base, the servers
  its runs may call and the tools of each, by the server's names:

  ```json
  {
    "policy": {
      "mcp": {
        "tracker": {
          "tools": ["get_issue", "update_issue"],
          "approvalRequired": ["get_issue"]
        }
      }
    }
  }
  ```

  A server the deployment does not register is a widening: the whole policy is refused
  (`policy_rejected`), as an `allowedHosts` entry the deployment denies is. An unknown key, a server
  name that is not lower-case letters, digits and dashes, and a gate on a tool `tools` does not list
  are refused too. A registered server it does not name, and a tool it does not list, are never
  offered.

- **Each tool** is a read or a write. A read is one its server annotates `readOnlyHint: true`;
  everything else — MCP's default — is a write. A read runs unattended; a write asks a person on
  every call through the same approval hook a gated command uses (`tracker/update_issue (MCP)` on the
  approval, the tool and its arguments in the detail), and a denial is the blocked call's result. The
  repository can gate a read too (`approvalRequired`); nothing makes a write unattended. A read-only
  stage (specifying, planning, reviewing) is offered the reads only.

The agent calls a tool as `mcp__<server>__<tool>`. The control plane is the MCP client
(`packages/harness/src/mcp.ts`, the official SDK's `Client`): it connects and lists the tools at every
open, and sends each call itself, so the token is a header on its own requests and never enters the
session's shell, prompt or log (it is masked in tool results too, should a server echo it). A server
that cannot be reached at open, or whose secret the repo does not hold, is a warning and offers no
tools for that open; the run goes on. The open records the repo's allowlist and the tools it offered,
with whether each asks, in the log's `factory.policy` (`repo.mcp`, `effective.mcpTools`), pinned for
the session like the rest of the repository's policy.

**Not a boundary (D15).** `readOnlyHint` is the server's word about its own tool; the deployment chose
to trust the server by registering it, and the repository can gate any tool by name.

**How to drive it.** `./mcp-tools.sh` (API on `API_PORT`, default `:9446`; the fake MCP server on
`MCP_FAKE_PORT`, default `:9447`). The deployment registers `tracker` (its token from the secret
`TRACKER_MCP_TOKEN`) and `rogue`, both served by `@repo/harness/mcpFake` on loopback; the fixture
repo allows `tracker`'s `get_issue` and `update_issue`. The faux model, on every turn, runs
`printenv TRACKER_MCP_TOKEN` and then calls the three tools (`FAUX_MCP_CALLS`).

| Scenario | Check                                                                                                  |
| -------- | ------------------------------------------------------------------------------------------------------ |
| `read`   | the read tool's call and the fake's answer are in the transcript                                       |
| `read`   | it ran unattended; the fake got it once, on `/tracker`, with `Bearer <the secret>` and its arguments   |
| `read`   | the agent's shell does not hold the token, and no transcript entry carries it                          |
| `write`  | the write is blocked on an approval for `tracker/update_issue (MCP)`; the fake saw no call             |
| `rogue`  | the unallowed server's tool is the harness's unknown-tool error; the fake saw no request on `/rogue`   |
| `write`  | after a person denies it, the next turn's call is refused as denied by them; the fake still saw none   |
| `record` | `factory.policy` holds the repo's `mcp` allowlist and the two offered tools, the write marked as gated |

Evidence: `.verify/evidence/latest/api/mcp-tools.json`, `mcp-tools.log` and `mcp-tools-api.log`.

**What is not built.** OAuth to a server (a bearer token from a repo secret is the one credential);
servers over stdio; MCP resources and prompts; a deployment-wide credential; showing the offered
tools in the dashboard or CLI.
