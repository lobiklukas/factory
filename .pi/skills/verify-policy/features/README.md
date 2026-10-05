# Feature map — session policy

One file per user-facing feature of D11's boundary. Each answers: what it is, how a user reaches it,
how the skill drives it, and what observable end state proves it works.

Status reflects the last verified run: **2026-10-05**, API on `:9400`–`:9407`, `MODEL_BACKEND=faux` —
`./refusals.sh` **8/8 cases, 51 checks** (`refusals.json` → `passed: true`), plus `packages/harness`
**209/209** (5 files: 66 decision rows in `policy.test.ts`, 125 attack rows in
`policy.attack.test.ts`, 12 seam rows in `policy.seam.test.ts`, 5 hook rows in
`policy.hook.test.ts`, 1 session row in `session.test.ts`) and `packages/core` **11/11**.

| Feature          | Status  | File                                   |
| ---------------- | ------- | -------------------------------------- |
| Refusals         | passing | [refusals.md](refusals.md)             |
| The happy path   | passing | [refusals.md](refusals.md#the-control) |
| Autonomy as data | passing | [autonomy.md](autonomy.md)             |

## Deliberately absent

- **Isolation.** Nothing here isolates a session. The refusal is a hook in the same process and trust
  domain as the tools it gates (D15), and design R2 forbids claiming otherwise. The enforcement D15
  names is the short-lived narrowed credential (LOB-51/LOB-54) and the GitHub rulesets (LOB-30).
- **A complete boundary.** The classification is textual, so it misses calls in both directions.
  `packages/harness/src/policy.attack.test.ts` has a row for each of these, and
  [refusals.md](refusals.md#what-it-does-not-prove) lists them in prose. Allowed when it should not
  be: writes by a command outside the table (`sed -i`, `tar -C`, `unzip -d`, `rsync`, `curl -o`, a
  path held in a variable), egress by a program outside the list (`npm publish`, `node -e
'fetch(...)'`), a single-label host (`ssh sandbox`), a fully qualified host with a trailing dot, a
  command inside `sh -c`, and a remote given as a local path. Refused when it should not be:
  `git push origin HEAD` and `git push origin '@{u}'`, which cost a round trip rather than protecting
  anything. Six holes a first pass left are now closed and their rows moved to the refusal block:
  `cd`/`pushd` out of the worktree, combined short flags (`-uf`), an abbreviated `--force-w`, a
  remote written out as a URL or `--repo=<url>`, `git config remote.origin.url`, an unquoted `$(…)`
  or backtick substitution, and four egress false positives (`curl -o out.json <url>`, `curl -d
@body.json <url>`, `wget -O index.html <url>`, `scp f.txt host:/tmp/f`).
- **Approvals.** D9/D15's "anything that escapes is gated" needs a human in the loop; that is
  LOB-50/LOB-52/LOB-53. `afterTool` is registered as the seam they write through and does nothing yet
  — and note that pi-durable 1.0.3 settles a _blocked_ call before executing it, so `afterTool` never
  runs for a refusal (`policy.seam.test.ts` pins that; an audit written there cannot see one).
- **The `write`/`edit` tool refusals over HTTP.** The faux script calls `bash` only, so the API drive
  cannot reach them; `packages/harness/src/policy.hook.test.ts` drives them through a real harness
  with a scripted tool call, and the pure decision table covers them exhaustively.
- **A real push or a real network call.** No test may reach a third party, and the drive now proves
  it stayed local: `API_URL` must be loopback, the answer must be the scripted provider's echo of the
  tool result, a full run was observed to spawn **no child process at all** from any API instance, and
  the session root is a throwaway repo whose `origin` is local. The refusal is proven by the decision,
  the transcript, and (for a write) the filesystem — never by watching a real push fail. See
  `.verify/evidence/latest/policy-isolation.json`, including the regression that made the throwaway
  origin necessary.
- **The push credential.** A policy that allows `git push origin refs/heads/factory/<id>` is not proof
  that the push is _authorized_; the credential's scope is the boundary (D14). LOB-51 and LOB-54 own
  that.
