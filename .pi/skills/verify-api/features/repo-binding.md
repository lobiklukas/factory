# Repo binding

**What it is.** A session knows which repository it works on and at which base ref, and the server
resolves the workspace that implies: a directory of its own, plus the commands the repo declares
about itself in `.factory/config`. LOB-5, `docs/features.md` §3 A1.

**How a user reaches it.** `registerRepo` (slug, clone URL, default base ref, optional local
checkout), then `createSession({ repo, baseRef })`. Naming an unregistered repo is enough: it is
registered on first use with no clone URL. A scratch session is still a session — no `repo` means
`SESSION_ROOT/<session-id>`.

**How the skill drives it.** `drive.ts` registers `lobiklukas/verify-api-fixture` with a `localPath`
of `fixtures/repo` (a checkout in this skill that declares all four commands), creates a session
against it, and reads the snapshot back:

- `registerRepo` returns the row it stored (repo, URL, default base ref) — a registry that cannot be
  written is not a registry.
- the created summary carries `repo` and `baseRef`, so every client sees the binding without a fold;
- `workspace.repo`, `workspace.baseRef`, and `workspace.path` (which must be scoped under
  `lobiklukas/verify-api-fixture/`) are the resolved answer;
- `workspace.commandsSource` is `"repo"` and `workspace.commands.test` is the fixture's own
  `bun run test` — the commands came from the repo, not from a default in the server.

**What proves it.** The binding lives in the log as a `factory.session` document, so the index is
derivable from it: `packages/core`'s suite empties the index tables, runs `rebuildIndexes`, and gets
the repo, base ref, title, spend, and creation time back from the logs alone. A repo with no config
is a separate case (`commandsSource: "none"`, `commands: {}`) — a repo that says nothing about
itself must still open.

**What it does not prove.** Nothing clones: the workspace is an empty per-session directory until M6
cuts a worktree (LOB-11, D10). A fixture with a `.factory/config` is the only reason `commandsSource`
can be `"repo"` today.
