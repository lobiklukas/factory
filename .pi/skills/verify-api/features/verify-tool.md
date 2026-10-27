# The `verify` tool (LOB-78, part 1 of LOB-16)

**What it is.** A harness tool, installed beside `CodingTools` in every session
(`packages/harness/src/verify.ts`, `openSession`), that verifies the change a run made and records
the verdict in the session's log. It measures the run's changed paths with git in the session's own
worktree (the branch against its base, plus anything uncommitted or untracked), maps each to a surface
(`apps/<name>`, `packages/<name>`, `.pi/skills/verify-<name>` → `<name>`; anything else — `src/`,
`docs/`, root files — → the repo surface `.`), and for each surface runs the repo's declared `verify`
command (`.factory/config`, told the surface through `FACTORY_VERIFY_SURFACE`) or, when the repo
declares none, the surface's skill (`.pi/skills/verify-<surface>/`: `up.sh`, then `drive.sh` /
`drive.ts` / `drive.mjs`, then `down.sh` — and `down.sh` again on its own when a timeout or abort
killed the script before it got there). The repo surface has no skill, so only a declared command
verifies it. The record is the tool result's `details` — the changed paths (the first 500, with
`changedCount` the whole count) and one typed result per surface: `VerifyRan` (command, directory,
exit code, the tail of the output, whether it was cut), `VerifyNoEvidence` (a surface with no command
and no skill, or changed paths outside every package with no declared command — named either way),
or `VerifyUnrunnable` (spawn failure or timeout, with what it printed). A report with changed paths
always has a result, so an empty `results` means nothing changed. `readVerifyRecords` decodes them
out of a log; the PR evidence block (LOB-79) reads them from there.

**Isolation.** Each verification runs with `DATABASE_URL` blank (or `VerifyOptions.databaseUrl`),
never the control plane's own database, and every verification in one control plane process takes
one lock, so two sessions never drive a skill's fixed default ports at once. Not covered: another
process on the host holding the port (a second control plane, a developer's server) — a skill's
readiness poll would reach it. A skill's exit 0 is attributable to the session only on a host where
this control plane is the one running skills.

**How a user reaches it.** Through the model: a run calls `verify` (no arguments) after making its
change. The model cannot choose the surface or the command. That is not a sandbox: the skill scripts
run from the session's own worktree, so a run that edits `.pi/skills/verify-<x>/drive.sh` makes
`verify` run what it wrote, unseen by the policy's textual `bash` checks — the same accepted gap as
"a script written and then executed" in `policy.ts`.
A person reads the verdict as the `verify` tool result in the transcript.

**How the skill drives it.** `./verify-tool.sh` — no server, no port: the driver builds
`SessionService` in-process on the run's `DATABASE_URL`, as `./docs-run.sh` does. Five scenarios,
each its own fixture repo (no remote) registered with `localPath` and its own session on `main`:

1. `pass` — the repo's `verify-api` skill prints a verdict and exits 0. The faux model
   (`fauxVerify`) commits `apps/api/src/feature.ts` on the session's branch with `bash`, then calls
   `verify`. The log holds `VerifyRan{surface: api, source: skill, exitCode: 0}` with the skill's
   output, and the change was found by the branch-against-base measurement (it is committed, so
   nothing else would see it).
2. `fail` — the skill prints 400 lines and exits 3: the record keeps exit 3 and the output's tail
   (the verdict on stderr kept, `check 1` cut, `truncated: true`), and the run still answers and goes
   idle — the tool did not throw.
3. `no-skill` — the change is under `apps/web` and the repo holds only `verify-api`: the record is
   `VerifyNoEvidence{surface: web, reason: no-verify-skill}`, and the model is told so.
4. `declared` — `.factory/config` declares `verify` and the repo also holds a `verify-api` skill that
   exits 9: the declared command ran (`source: workspace`, exit 0, `declared verify for api`), not the
   skill.
5. `repo` — the change is `src/app.ts`, outside every package, and `.factory/config` declares a
   `verify` that exits 1: the declared command ran once for the repo surface (`surface: .`,
   `source: workspace`, exit 1), and the model read `[.] exit 1` — a repo with any layout that says
   how it verifies itself is verified, not silently skipped.

Every check is a required check: the script exits non-zero when one fails.

**What proves it works.** `.verify/evidence/lob-78/api/`: `verify-tool.json` (each scenario's session
id, worktree, decoded records and transcript, and the checks) and `verify-tool.log`. Unit coverage is
`packages/harness/src/verify.test.ts` (the four acceptance cases through `openSession` and the log,
plus `up.sh`/`down.sh` ordering, a failing `up.sh`, a bun driver, base-ref measurement, a
non-checkout directory, a timeout, `down.sh` after a timeout, the repo surface with and without a
declared command, the blanked `DATABASE_URL`, the cross-call lock, the changed-path cap, discovery
tables) and `packages/core/src/SessionService.test.ts`
("the verify tool reads the session's workspace": the declared command and the base ref reach the
tool from the workspace the service resolved; dropping either from `SessionService.ts` fails it).

**What it does not prove.** That a real model calls the tool at the right moment — the faux script
always does. That this repo's own skills pass when run this way: the fixtures are small skills of the
same shape (`up.sh` / driver / `down.sh`), and running `verify-api` or `verify-web` from inside a
session would need the ports and databases those skills assume (and `verify-api` gets no database from the
tool unless the control plane passes one). Path → surface is a rule, not a
declared table: in this repo a change under `packages/core` names surface `core`, which has no skill
and is reported as no evidence rather than mapped onto `verify-api`. And nothing here _gates_ on the
record yet — the PR evidence block is LOB-79 and the gate is part 3 of LOB-16.
