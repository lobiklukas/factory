# `factory repo add --url`, `repo sync`, `factory doctor`

**What it is.** A repo that is not checked out on this machine still gets real worktrees (LOB-265).
`factory repo add owner/name --url <clone URL>` — with no `--path` — has the API clone the repo into a
bare repository of its own, `<SESSION_ROOT>/.cache/<owner>/<name>.git`, with the control plane's
credential sent for that one call and written nowhere (`@repo/core`'s `git.ts#syncMirror`). Every
session on the repo then fetches its base ref into that clone and is cut a linked worktree of it, at
the fetched ref, on `factory/<session-id>`. The answer carries `cache <path>` and `state ready`.

- `factory repo sync owner/name` clones the repo, or fetches its base ref, now; it is what `add` runs.
- `factory doctor [owner/name]` checks every registered repo (or one) can cut a worktree: a checkout is
  read as the registry reads it, a URL-only repo is cloned right now, and the rest is reported with the
  command that fixes it. It exits non-zero when any repo it checked cannot run.
- A clone that fails is `repo_clone_failed`, naming the repo and a reason (`auth`, `credential`,
  `missing-ref`, `refused`, `timeout`, `failed`). `repo add` keeps the row registered, so `repo sync`
  can retry it; a half-made clone is removed.

**How a user reaches it.** `factory repo add lobiklukas/factory --url https://github.com/lobiklukas/factory.git`,
then `factory run … --repo lobiklukas/factory`. A URL must be on GitHub (or a loopback host, which is
the tests' forge), be `https`, and carry no credential: one with a token in it is `invalid_input` at
`add`, and any other URL a token may not be sent to is `repo_clone_failed (refused)`.

**How the skill drives it.** `./clone.sh`, self-contained: a loopback `git http-backend` forge that
answers `401` without the drive's own token (`../lib/git-remote.ts`), its own API with that token as
`GITHUB_TOKEN`, and a tmux terminal. Panes are kept as `clone-*.txt`; the checks are in `clone.json`.

1. `repo add <slug> --url <forge>/<slug>.git` — exit 0, `cache       <root>/.cache/<slug>.git`,
   `state       ready`, `path        none`. The cache is a bare repository whose
   `refs/remotes/origin/main` is the forge's main; no file of it holds the token and its config names no
   remote and no URL.
2. `factory run … --repo <slug> --base-ref main` — exit 0 and no `warning` line; its `workspace` is a
   linked worktree (`.git` is a file) whose common dir is the cache, on `factory/<id>`, at the forge's
   main, with the repo's `README.md`.
3. The forge's main moves; a second `run` is cut at the new tip and the first worktree stays where it
   was: each session fetches.
4. `repo show` reads `state       ready` and the cache; `factory doctor <slug>` prints
   `ok    <slug>  cloned into <cache>` and exits 0.
5. `repo add <ghost> --url <forge>/<ghost>.git` for a repo the forge does not serve — non-zero,
   `error: repo_clone_failed:` naming the ghost, nothing left in the cache. `repo show` still has the row,
   `state       not cloned yet`, `remedy      factory repo sync <ghost>`; `factory doctor <ghost>` prints
   `FAIL  <ghost>  repo_clone_failed (…)` with its remedy and exits non-zero; `repo sync` fails the same
   way. Once the forge has the repo, `repo sync` clones it and the row is `ready`.
6. The API's log holds no token.

**What proves it.** The forge refuses every request without the token, so a clone with no credential
fails; the clone succeeding is the proof it was sent, and step 1's scan is the proof it was not kept.
The worktree facts are read from git on disk (`rev-parse --git-common-dir`, `HEAD`), not from what the
CLI printed. `packages/core/src/git.test.ts` proves the same against a loopback forge in-process, and
`SessionService.test.ts` the wiring (clone on register, fetch per session, teardown from the cache).

**What it does not prove.** A forge other than GitHub: `git.ts` only sends a token to GitHub or a
loopback host. The PR step on a URL-only repo (push from the cache) is not part of this change.
