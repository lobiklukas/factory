
## 2026-10-09 LOB-101 - in review
- Strict Mode strips everything not in `env`/`globalEnv`/pass-through; only DATABASE_URL was declared. Fixed per package: apps/api/turbo.json (14 vars + ANTHROPIC_API_KEY passThrough), apps/web/turbo.json (VITE_*), apps/cli/turbo.json (6 vars, the CLI dev script also runs under turbo).
- turbo 2.11.7 framework inference already passes VITE_* for @repo/web, so VITE_PORT was not stripped; MODEL_BACKEND was the real failure (boots faux without the declaration).
- Regression cases: packages/storage-postgres/src/turbo-env.test.ts "the dev tasks' environment". Dry-run cases are fast (no task runs); spawnSync 60 s bound in the shared helper is the residual risk (not changed).
- PR https://github.com/lobiklukas/factory/pull/37 (draft); review record head bd05dcb, all three angles OK with notes.

## 2026-10-09 LOB-101 - ralph-fix (CI image pull), still in review
- PR #37 red only on `test`: `docker pull postgres:17-alpine` hit Docker Hub's anonymous rate limit on every attempt of run 37990330302 (including two `gh run rerun --failed`). Head bd05dcb unchanged; local gate green.
- Not fixed in this PR: the fix is in `.github/workflows/gate.yml` (protected). Filed LOB-145 (priority 2, front of queue) and set it as LOB-101's blocker. Mirror `public.ecr.aws/docker/library/postgres:17-alpine` resolves to the same tag.
- Next worker: LOB-145 first (human merge), then re-run CI on PR #37 and remove `ralph-fix` once `gate` is green.

## 2026-10-09 LOB-145 - in review
- Root cause of PR #37's red CI: `gate.yml` test-job service pulled `postgres:17-alpine` from Docker Hub anonymously; run 37990330302 hit `toomanyrequests` before `bun run test` ran.
- Fix: image → `public.ecr.aws/docker/library/postgres:17-alpine` (same tag, env, port). Digest matches Docker Hub (`.verify/LOB-145/digest.txt`).
- PR https://github.com/lobiklukas/factory/pull/39 (draft, label needs-human-merge, head afe63c8). Review record posted (combined angle, OK, p0p1_open 0).
- Next: a human merges #39; then re-run CI on PR #37 (LOB-101) and drop `ralph-fix` once green. Compose files still use Docker Hub for local dev (out of scope, noted).

## 2026-10-09 LOB-101 - ralph-fix still open, waiting on LOB-145 (iteration 4, worker 1)
- Fix-first picked PR #37 (lowest open `ralph-fix`); claimed LOB-101. Head unchanged at bd05dcb; `test` still fails on the Docker Hub pull (run 37990330302). The other four checks are green.
- The fix is PR #39 (LOB-145, protected `.github/`, label needs-human-merge, draft, head afe63c8, mergeStateStatus CLEAN). Not merged by this worker. Linear: LOB-145 In Review, LOB-101 In Review blocked by it.
- No new issue taken this iteration: the fix-first item cannot be moved without the human merge. Next step for a human: merge #39, then re-run CI on #37 and drop `ralph-fix` once green.

## 2026-10-09 LOB-8 (worker 1)
- Policy extension (`packages/harness/src/policy.ts`) installed beside CodingTools; verify-policy 8/8. Branch `ralph/LOB-8` merged with origin/main (conflict was only SessionService.test.ts: kept main's tests + the autonomy describe).
- Review P1 fixed: a session pushed any `refs/heads/factory/*` branch. Now `forWorktree(worktree, sessionId)` scopes it to the session's own branch. The prefix check runs before the ownership check so the autonomy-config test keeps its message.
- Trap: `ralph-reviewer` P2 (`-ud` read as `--delete`) is an over-refusal, left as is.
- PR https://github.com/lobiklukas/factory/pull/41

## 2026-10-09 LOB-50 - skipped (too-big), worker 1 iteration 2
- `origin/ralph/LOB-50` (wip 01eb929) cherry-picked onto main is not usable: duplicated idle-sweep block, migration `0007` collides with `0007_create_tasks`, approvals kept in a side SQL table not the log, RPC methods not in their own group.
- Labelled too-big, returned to Todo; Linear comment lists the split. Next worker: LOB-51 (no wip, unblocked, Urgent) if not claimed.

## 2026-10-09 LOB-51 (worker 1, iteration 3)
- `CredentialProvider` (static-token, `GITHUB_TOKEN`) in `packages/core/src/credentials.ts`; `GITHUB_APP_ID` refused until LOB-55. Empty token = typed `missing`.
- Trap found: `NodeExecutionEnv` spreads the whole control-plane `process.env` into every tool command, so `*TOKEN/*SECRET/*API_KEY` leaked to the session shell. Fixed in `packages/harness/src/session.ts` (`sessionShellEnv` blanks them). Any future secret env var is covered by name pattern.
- Open: verify-api skill not updated for the boot credential log; `CredentialError.repo: "*"` sentinel.
- PR https://github.com/lobiklukas/factory/pull/42

## 2026-10-09 LOB-146 (worker 1)
- Approval records: `ApprovalRequest`/`ApprovalDecision` in `@repo/domain/Approval`, `ApprovalsRpc` merged into `RpcApi`, `requestApproval`/`decideApproval`/`listApprovals` in SessionService. Writes `factory.approval.*` log entries.
- Trap: the pending set is process-local (in-memory Ref). A restart empties the list and a repeat request re-appends. The snapshot fold (LOB-147) must fix it.
- Approval entries project as kind `other`; a named kind changes the wire schema, so it waits for LOB-147/LOB-53.
- PR https://github.com/lobiklukas/factory/pull/44
