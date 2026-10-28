# `factory repo`

**What it is.** The repo registry from a terminal (LOB-253): `factory repo add owner/name --path <dir>
[--base-ref main] [--url …]` registers a repository or updates one, `factory repo ls` lists every
registered repo, and `factory repo show owner/name` reads one. Each answer is the server's
`RepoSummary` — slug, clone URL, default base ref, local checkout, registered-at — with facts the
API reads from its own disk when it answers: whether the checkout is inside a git work tree (what a
session's worktree is cut from), the root of that work tree, and whether it holds a `.factory/config`.

The check is "inside a work tree", not "is a work tree's root": a monorepo package is a valid path,
and so, unavoidably, is a plain directory under an unrelated enclosing repository. `add` and `show`
print `work-tree   <root>` so the operator sees which repository sessions will be cut from.

A repo no session can cut a worktree from says so in words and prints the fix: the row
`createSession` writes the first time a session names a slug reads `no clone URL / no local checkout`
with `factory repo add <slug> --path <dir>`.

**How a user reaches it.** `factory repo add lobiklukas/factory --path .` from a checkout (the path is
resolved against the directory the command runs in), then `factory repo ls` or `factory repo show`.
`--path` may be left out only when the repo already has a checkout registered: a second `add` that
names only `--base-ref` keeps the path. `--url` with no path has the API clone the repo into its own
cache before it answers (LOB-265, [clone.md](clone.md)); with neither, an `add` for a repo that has
no checkout and no URL is refused `invalid_input`.

**How the skill drives it.** `./repo.sh`, run by `./drive.sh` against the `./up.sh` instance, in a
tmux server of its own. Each command's pane is kept as `repo-*.txt`; the checks are in `repo.json`.

1. `repo add <slug> --path <checkout> --base-ref main` — exit 0, and the printed block names the
   repo, the path, `work-tree   <the checkout>`, `base-ref    main`, `config      .factory/config
found` and `state       ready`. The checkout is a fresh `git init` with a `.factory/config` and
   an `AGENTS.md`, so `readiness   1/4 (…)` names the three readiness checks it fails (S-env-setup).
2. `repo add <slug> --base-ref trunk` — exit 0, `base-ref    trunk`, and the same path.
   Then `repo add <nested> --path <checkout>/packages/nested` (a plain directory inside it) — exit 0,
   `state       ready`, and `work-tree` naming the enclosing checkout, not the path.
3. `repo add <refused> --path <plain temp dir>` fails non-zero with `invalid_input`, its message
   naming the path as not a git work tree; then `repo show <refused>` is `repo_not_found`: nothing
   was written.
4. `repo add Acme/Upper --path … --api http://127.0.0.1:9` fails with `invalid_input` ("is not a
   repository"). Nothing listens on that port, so a request would have failed with the generic
   `error` code instead: the slug is refused before any request.
5. `factory run … --repo <auto>` names a slug nobody registered; `repo show <auto>` then prints
   `path        none`, `url         none`, `state       no clone URL / no local checkout` and
   `remedy      factory repo add <auto> --path <dir>`.
6. `repo ls` — the header `repo path base-ref registered-at config readiness url state`; the
   registered repo's row has the checkout as its second field, `trunk` third, an ISO timestamp
   fourth, `yes` fifth and `1/4` sixth; the auto-registered row has `none` for path, readiness and
   URL and ends in the state with its remedy;
   the refused slug has no row. The columns are tab-separated (the pane shows the tabs expanded), so
   the same command piped to a file is checked too: its header is the eight names joined by tabs and
   `awk -F'\t'` reads the checkout as the second field, whatever a path contains.
7. `repo show <unknown>` — `error: repo_not_found`, non-zero.

Every slug carries the run's id, so a row an earlier run wrote is never the one asserted on.

**What proves it.** The CLI has no local registry: every line is rendered from what `registerRepo`,
`listRepos` or `getRepo` answered over HTTP, and the checkout facts are the API's reading of its own
disk. The refusal in step 3 is the server's (`invalid_input` naming the path), and step 3's `show` is
a second request that would find the row if the refusal had written one.

**What it does not prove.** Cloning: that is [clone.md](clone.md)'s (`./clone.sh`). The
dashboard's Repositories page (LOB-262) is proven by
[verify-web's repos.md](../../verify-web/features/repos.md). The `warning …` lines LOB-263 added to `factory run`, `board create`, `board start`
and `board ls` are unit-tested (`board.test.ts`) and read by `verify-api`'s `repo-binding.md`; this
skill's drive does not assert them.
