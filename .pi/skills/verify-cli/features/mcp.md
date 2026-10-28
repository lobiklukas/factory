# `factory mcp` and `factory handoff`

**What it is.** The way a local agent hands work to a factory session (S-local-agent-handoff-mcp).
`factory mcp` is an MCP server on stdio, launched by the agent in its checkout, with six tools over
the CLI's own RPC client: `create_card`, `start_run`, `send_message`, `get_status`,
`answer_question` and `handoff`. `factory handoff` takes the checkout's work in progress — local
commits, edits and untracked files against the remote's default branch — as one patch and makes a
card carrying it; the card's run is cut on `factory/<session-id>` at the base with that patch
committed on it before its agent's first turn. A patch over 512 KiB (`MAX_HANDOFF_PATCH_BYTES`) is
refused before anything is sent, by the CLI and by the server in the same words.

**How a user reaches it.** Claude Code:
`claude mcp add factory -- bun run apps/cli/src/index.ts mcp --api http://localhost:9000` from the
checkout (`--repo owner/name` when the remote does not name the repository; `FACTORY_API_TOKEN` is the
credential). A terminal:
`factory handoff --repo owner/name --note "Finish the retry loop" --start --column building` prints
`task tsk_…`, `handoff N files, B bytes from <branch> at <sha> onto <base>`, then the run's
`session ses_…`. An oversized diff prints
`error: handoff_refused: the handoff patch is N bytes, over the 524288-byte cap a card carries: …`
and exits 1.

**How the skill drives it.** `./mcp.sh` owns its own API (`MCP_PORT`, default `:9397`), a bare
"remote", the factory's registered checkout of it and a developer's clone on `feature/local`. It
registers the repo and makes its board with `factory repo add` / `factory board create`, then:

1. runs `mcp-client.ts` twice (initialize at `2025-06-18`, then `2025-11-25`): the client launches
   `factory mcp` in the developer's clone, lists the tools, calls `create_card` and `get_status` on the
   card it made, hangs up, and records every stdout line; `factory board show` reads the card back;
2. when `claude` is installed, configures Claude Code with the server in a scratch
   `CLAUDE_CONFIG_DIR` and runs `claude mcp get factory`;
3. makes the clone dirty (a local commit, an edit, an untracked `notes.md`), takes the expected patch
   through a scratch index, and runs `factory handoff --start --column building` in a tmux window;
4. writes a file past the cap and runs `factory handoff` again.

**What proves it.** The card `create_card` answered is the one `get_status` reads back in `intake`
and `factory board show` prints; every line the server wrote to stdout is JSON-RPC and the server
exits when stdin closes; Claude Code's health check says `✔ Connected`. The handoff's run worktree is
on `factory/<session-id>`, `git diff --binary --full-index main HEAD` there is byte-for-byte the
expected patch and the tree is clean; the faux agent's first turn printed `work in progress` (the
handed-off file) and the handoff commit's subject; the developer's clone has the same status and
`HEAD` as before. The oversized handoff exits non-zero with the cap's words, and the board holds as
many cards after it as before. Evidence: `.verify/evidence/latest/cli/mcp-*.txt|json|patch` and
`mcp.json`.

**What it does not prove.** That a model in Claude Code picks these tools or reads their results
well (the client calls them itself), nor the other four tools end to end (their handlers are
`apps/cli/src/commands/mcp.test.ts`'s, against an in-memory client). A base that moved since the
handoff, and a patch that does not apply, are `packages/core/src/SessionService.handoff.test.ts`'s.

Verified **2026-10-28** from the `agent/S-local-agent-handoff-mcp` worktree with `./mcp.sh` (API on
`:9530`) — **22/22** checks, Claude Code 2.1.312's health check among them.
