# Refusals

**What it is.** D11's always-blocked list, enforced where a tool call is decided: a push to anything
but `refs/heads/factory/**`, a force-push, a ref deletion, a tag push, a remote change, a write
outside the session worktree, and network egress to a host the deployment did not allowlist. A
refusal is Pi Durable's `blocked` tool result — a message the model reads in the same turn, so the
next attempt can be the right one.

**How a user reaches it.** An agent calls `bash`, `write`, or `edit`. `policyExtension`
(`packages/harness/src/policy.ts`) is installed in the registry beside `CodingTools`, Pi Durable runs
its `beforeTool` hook before the tool task records intent, and a `block` decision settles the call
with `Tool call blocked: <reason>` and `isError: true`. The tool never runs, and the refusal is in the
transcript like any other result — the model sees it, the UI shows it, a rebuild keeps it.

The wording is part of the contract: every refusal names what was refused, why it is always blocked,
and what to do instead (`Push refs/heads/factory/<session-id> instead.`).

**How the skill drives it.** `./refusals.sh` boots one API instance per case with the scripted model
set to call that command, drives a real session over the RPC client, and asserts:

- the tool result is an error and its text carries the refusal (`Tool call blocked` plus the
  case-specific reason),
- the refusal reaches the model's next turn (the faux answer is derived from the tool result, so an
  echo of it can only exist if the model received it) — asserted exactly, as
  `<tool result> (re: <prompt>)`, which is also what proves the model was the in-process faux
  provider and not a real one,
- the API URL is loopback, so the drive cannot leave this machine,
- for `write-outside`, that the file the command would have written does not exist — the half a
  transcript read cannot prove,
- for `write-outside`, that the refusal names the resolved worktree, which is the sentence that lets
  the agent write in the right place on the next try.

Eight cases, 51 checks. The pure decision table behind all of this is
`packages/harness/src/policy.test.ts` (66 rows, including the allow rows: a redirect to `/dev/null`,
`2>&1`, a quoted `git push origin main` inside an `echo`, a `curl` with a JSON body, a relative
write, a read outside the worktree). Its adversarial counterpart is
`packages/harness/src/policy.attack.test.ts` (125 rows: the refusals a naive text check would miss,
the false positives, the holes that were closed, and the holes that remain). The hook path through a
real harness is `packages/harness/src/policy.hook.test.ts` (5 rows), and the hook's registration and
`afterTool` identity are `packages/harness/src/policy.seam.test.ts` (12 rows).

<a id="the-control"></a>

**The control.** `allow` drives `echo faux-ok` and asserts the tool result is _not_ an error and that
the command really ran. Without it, a policy that refused everything would pass every other case.

<a id="what-it-does-not-prove"></a>

**What it does not prove.** That a determined agent cannot get past it, and that nothing ordinary is
caught in the net. The classification is textual and runs in the agent's own process (D15): `eval`,
a command inside `sh -c`, a variable holding a command or a path, a symlink inside the worktree, and
another interpreter (`xargs`) are all ways past it, and none is defended against here. A push to a
_named_ remote is judged by its refspec, not by the remote's host, because resolving a remote name to
a URL means reading git config — the credential seam's job (LOB-51).

Adversarial verification of this surface found more than that. Each of these is a row in
`packages/harness/src/policy.attack.test.ts`, in its `holes the docs still name` block — an allow
row, asserted deliberately, so that closing one is a visible change rather than a quiet fix:

- **Writes by a command outside the table.** `sed -i`, `tar -C`, `unzip -d`, `rsync`, and a program
  that writes a file itself (`curl -o`) write outside the worktree and are not read as writes. A
  path held in a shell variable is the same class.
- **Egress by a program outside the list.** `npm publish`, `node -e 'fetch(…)'` and anything else not
  in the egress command set reaches the network unexamined.
- **Hosts the host regex cannot see.** A single-label host (`ssh sandbox`, `scp -r dir sandbox:/tmp`)
  and a fully qualified host with a trailing dot (`curl https://evil.example./x`) are not hosts to
  this code.
- **A remote given as a local path** (`git push /tmp/other.git …`) has no host to check.

Six holes the first pass left were closed after this table was written, and their rows moved into the
`holes a first pass left, now refused` block: a force-push with combined short flags (`-uf`) or an
abbreviated long option (`--force-w`); a write reached by moving first (`cd /tmp && …`, `(cd /etc &&
…)`, `pushd`); a remote written out as a URL or an `--repo=<url>`; `git config remote.origin.url`
and an `insteadOf` rewrite; an unquoted `$(…)` or backtick substitution, which is now read as the
command it runs; and four false positives that refused ordinary work — `curl -o out.json <url>`,
`curl -d @body.json <url>`, `wget -O index.html <url>`, `scp f.txt host:/tmp/f`.

One refusal remains that costs a round trip rather than protecting anything: `git push origin HEAD`
is refused because `HEAD` is not a ref prefix. Git resolves it to the current branch (`git push
--dry-run --porcelain origin HEAD` against a local remote reports `HEAD:refs/heads/<branch>`), so for
a session on `factory/<id>` the agent has to name the ref. `git push origin '@{u}'` is refused the
same way, but git rejects that refspec itself, so nothing is lost there.

And nothing here proves the push that _is_ allowed will be _authorized_: that is the credential's
scope (D14) and the GitHub rulesets (D15, LOB-30).
