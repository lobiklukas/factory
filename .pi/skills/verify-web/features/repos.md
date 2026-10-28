# Repositories (the repos page)

**Status: passing.** `/repos` lists the registry and registers a repository without a terminal
(LOB-262, the first step of the first-run path). The rail's **Repositories** section (the branch icon)
opens it. It is the dashboard's face for `registerRepo` and `listRepos` (LOB-253); `factory repo
add|ls|show` is the CLI's ([verify-cli's repo.md](../../verify-cli/features/repo.md)).

## What is shown

- **The list** is `listRepos` and nothing else, polled every 5 s (`REPOS_POLL`) and re-read at once
  when this page registers a repo or a session is started from the dashboard (`createSession`
  registers a slug it has not seen). A row is `[data-repo-row=<slug>]` with `data-repo-runnable`
  (`true`/`false`) and, when it cannot run, `data-repo-cause` (`no_checkout` or `not_a_work_tree`). It
  carries the checkout path, the clone URL, the default base ref and whether `.factory/config`
  declares commands. When the git work tree the path is inside is not the path itself (a package
  inside a monorepo, or a plain directory under an unrelated repository) a **Repository root** line names
  the repository sessions are cut from (git's resolved path, so a symlinked path can show it too).
  **Agent readiness** (`[data-repo-readiness=<score>/<max>]`, S-env-setup) is the score the server
  answers for the checkout (LOB-29's four checks), with each failed check's reason listed
  (`[data-repo-readiness-missing]`); a repo with no checkout that is a work tree is not scored and
  says so (`data-repo-readiness="none"`) rather than showing a zero. `readinessView` in
  `repos-view.ts` is the rule.
- **Not runnable** is a row with no local checkout, or whose checkout is no longer inside a git work
  tree (moved or deleted since it was registered: the server reads that from the disk each time).
  The row says why (`[data-repo-reason]`) and what to do (`[data-repo-fix]`). The rule is
  `apps/web/src/lib/repos-view.ts#runnability`. A clone URL alone does not make a repo runnable: it
  is once the API has cloned it into its own cache (`mirrorPath`, LOB-265), which `registerRepo` does
  when it is given a URL and no path, so a URL-only repo is flagged only until that clone exists.
  The header (`[data-repos-count]`, `data-repos-not-runnable`) counts them.
- **The form** (`[data-repo-form]`) takes slug, local path, default base ref and clone URL and calls
  `registerRepo`, so a slug that exists is updated and a blank field keeps the row's value (blank
  fields are left out of the payload, never sent as `""`). Local path is optional: a repo registered
  without one is listed and flagged. Fields are trimmed (a pasted path carries its newline).
- **A refusal is inline.** A bad slug is stopped in the form (`[data-repo-problem]`, quoting the slug
  and the rule): `registerRepo`'s payload would fail on the client's own encode, so no request goes
  out. Anything the server refuses (`invalid_input` for a path that is not absolute or not inside a
  git work tree) is shown in the server's message verbatim (`[data-repo-refusal=<tag>]`), the form
  keeps what was typed, and nothing is written. A landed registration clears the form and says so
  (`[data-repo-registered=<slug>]`).

- **Secrets** (`[data-repo-secrets=<slug>]`, S-agent-secrets) under each row: the names the repo
  stores (`[data-secret-name]`, from `listSecrets`, which answers no value), a delete per name, and a
  form (`[data-secret-form=<slug>]`) whose Value is a password input, sent once with `setSecret` and
  cleared the moment the server answers (`[data-secret-saved=<name>]`, or the server's refusal in
  `[data-secret-problem]`). No value is ever on the page after it is saved, and no RPC answer the
  page reads holds one. `secrets-view.ts` holds the rules.

## How to get to it (user POV)

Click the branch icon (**Repositories**) in the rail, or open `/repos`.

## Driving it with repos.sh

`./repos.sh` owns its own API and dashboard (`REPOS_API_PORT`, default 9441, and `REPOS_WEB_PORT`,
default 3441) and its own throwaway git checkouts under `.verify/run/repos/checkouts/<tag>/`.
`repos.mjs` requires, in a real browser:

1. **Seed.** A session that names a new slug registers it with no URL and no checkout.
2. **Navigation.** The rail's **Repositories** opens `/repos` and is marked `aria-current`.
3. **Flag.** The seeded repo is `not runnable` (`no_checkout`) with the reason and the fix; the
   header counts the repos and the ones that cannot run, equal to `listRepos`.
4. **A bad slug** is refused inline quoting the slug and the rule, and writes nothing.
5. **The server's refusal.** A path that is a plain directory outside any repository is refused; the
   message on the page contains `registerRepo`'s own error (fetched over RPC), character for
   character; the slug stays unregistered and the form keeps what was typed.
6. **Add.** Slug + the throwaway checkout + base ref + URL: the row appears with no page reload,
   runnable, and equals `listRepos`' row (path, URL, base ref, work tree); the form is cleared.
   The checkout holds an `AGENTS.md` and nothing else a readiness check looks for, so the row shows
   `1/4` and the three failed checks' reasons exactly as `listRepos` scored them; the seeded repo,
   which has no checkout, shows `none` (S-env-setup).
7. **Fix in place.** The same form naming the flagged repo's slug and a checkout turns it runnable
   without a reload, and keeps the base ref.
8. **A run.** `createSession` on the registered repo answers a snapshot whose branch is
   `factory/<session-id>`, whose path holds a worktree (`.git`), and whose branch exists in the
   checkout (`git rev-parse`); the same holds for a session on the flagged repo once step 7 gave
   it a checkout (the first-run path); the session opened while the other repo had no checkout has a
   directory but no worktree.
9. **Follow.** The checkout is renamed away behind the registry's back; the open page flips the row
   to `not runnable` (`not_a_work_tree`) naming the path on its next poll, without a reload; a reload
   shows the same rows.
10. **A card parked `setup_failed`** (S-env-setup). A checkout whose `.factory/config` install exits
    7 is registered over RPC, a card's run on it is sent its first message (refused `setup_failed`),
    and the board page opened on the card shows `[data-card-block-note=setup_failed]` in the card
    pane: the heading `Blocked: its worktree setup failing` and the note naming `exited 7` and the
    stderr line.
11. **No console errors.**

Evidence: `.verify/evidence/latest/repos/` holds `repos-flagged.png`, `repos-refused.png`,
`repos-added.png`, `repos-moved.png`, `repos-setup-failed-card.png`, `observed.json`, `api.log` and
`web.log`.

## Gotchas

- **`runnable` means a checkout, not a proven session.** The server reports whether the path is in a
  git work tree, not whether the default base ref (`main` unless given) exists in it; a `master`-only
  or empty checkout reads runnable and `createSession` then fails with `failed to create worktree`.
  The row's tooltip and the form's help text say so. A server-side `baseRefResolves` fact is a
  follow-up (see LOB-262's comments).
- **The drive cleans up after itself.** `repos.sh` deletes the `verify-repos-%` rows it registered on
  exit (no `deleteRepo` RPC exists); a run killed before cleanup leaves them, and they show as not
  runnable.
- **The registry is global.** The page lists every repo the database holds (other suites' rows too),
  so the drive asserts the rows it made by slug and compares counts to `listRepos`, never to a fixed
  list.
- **A directory under a git work tree is accepted.** `registerRepo` refuses a path outside any work
  tree, not one inside it (LOB-253: a monorepo package is valid). The drive's refused path is
  therefore a `mkdtemp` under the OS temp dir, not a folder in this checkout. The row's Repository root
  line is how a person sees which repository sessions would really be cut from.
- **`workspace.branch` is not proof of a worktree.** A session on a repo with no checkout still
  reports `factory/<id>` as its branch; the drive checks the worktree's `.git` and the branch in the
  checkout instead.
- **The path is on the API's machine**, not the browser's. The form says so; a path typed for the
  wrong machine is refused as not a git work tree.
