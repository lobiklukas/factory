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

**The registry read (LOB-253).** After registering, the drive asks the registry back:

- `registerRepo` answers the checkout's facts — `localPathIsGit: true` and `hasFactoryConfig: true`
  for the fixture — read from the API's disk when the row is answered, never stored;
- `listRepos` holds that row exactly as `registerRepo` answered it, and `getRepo` answers the same;
- `getRepo` for a slug nobody registered fails with `RepoNotFound`, its own tag on the wire;
- `registerRepo` with a `localPath` that is not a git work tree (`/`) is `invalid_input` naming the
  path, and the slug is still `RepoNotFound` afterwards: a refusal writes nothing.

`apps/api/src/Rpc/Session.test.ts` carries the same cases over the app's own router, plus the row a
session auto-registers (no URL, no checkout, both facts `false`) and a second registration that names
only a base ref and keeps the path. The CLI over it is `.pi/skills/verify-cli/features/repo.md`.

**A repo with no checkout (LOB-263).** A session bound to a repo whose registry row has no
`local_path` still opens — naming a repo is enough, and refusing would break every first use — but
the rule is that it says so: `workspace.warning` is set, naming the repo and the fix
(`factory repo add <repo> --path <dir>`), because no worktree is cut and `non_empty_diff` or the PR
step would fail columns later. The same sentence (`noCheckoutWarning` in `packages/core`'s
`workspace.ts`) is on `createBoard`'s answer (`warning`) and on `getBoard` (`BoardView.warning`), read
from the registry each time, so registering a path clears a board's. A repo with a checkout and a
scratch session carry no `warning` key. A live session keeps its answer after the path is registered:
its owner already holds the empty directory, so the warning stays true of it; a session made after the
fix is cut a worktree. The drive checks all of it over RPC; `no-checkout.sh` boots the API with two
`TRIGGER_RULES` and reads the boot log, which names the rule's label and repo for each repo without a
checkout and, after one is registered, only the other. `factory run`, `factory board create`,
`factory board start` and `factory board ls` print it as `warning …`, and the dashboard shows it
under the header of the board and of the session.

**What proves it.** The binding lives in the log as a `factory.session` document, so the index is
derivable from it: `packages/core`'s suite empties the index tables, runs `rebuildIndexes`, and gets
the repo, base ref, title, spend, and creation time back from the logs alone. A repo with no config
is a separate case (`commandsSource: "none"`, `commands: {}`) — a repo that says nothing about
itself must still open.

**What it does not prove.** Nothing clones: the workspace is an empty per-session directory until M6
cuts a worktree (LOB-11, D10). A fixture with a `.factory/config` is the only reason `commandsSource`
can be `"repo"` today.
