# The PR body's evidence block (LOB-79, part 2 of LOB-16)

**What it is.** The session's PR body carries a `## Verification` section generated from the run's
recorded `verify` results (LOB-78), never from prose the model wrote. The PR step
(`packages/core/src/prStep.ts`) reads the `verify` records from the session's own log
(`readConversationVerifyCalls`), `prEvidenceOf` (`packages/harness/src/verify.ts`) turns the
**last recorded** call into a `PrEvidence` (`packages/domain/src/Session.ts`), and `buildPrBody`
(`packages/core/src/pr.ts`) renders it between `## Changed files` and `## Prompt`:

- per verification that ran: the name (`verify-api` for a skill, `commands.verify` for the repo's
  declared command), the surface, the exit code (`exit 3 (failed)` when non-zero), the command, and
  an excerpt of the recorded output — its tail under `PR_EVIDENCE_EXCERPT` (40 lines, 2,000
  characters), cut by the same deterministic `tailOf` the record uses. When the excerpt is not all
  the command printed (the record kept a tail, or the excerpt cut it further) the line above the
  fence says `Output (truncated: earlier output omitted, the last N line(s) shown):`. The fence is one
  backtick longer than any run in the output, so a driver that prints a fence cannot end it;
- a verification that could not run: its code and message, with whatever it printed;
- a surface with no skill: named, with the tool's message;
- no evidence at all — the run never called `verify`, every call it made was blocked or crashed
  (`unrecorded`), its last recorded call could not measure what changed, or it found nothing
  changed — `**No verification evidence.** Nothing in this PR was verified by a recorded run:
<why>.`, then `The tool said: <message>` when the tool said something. The section is never
  omitted.

The cited call is never quietly stale. Calls after it that left no record (blocked, crashed) are
counted on `unrecordedAfter` and the body says `**Not the run's last call.**`. The PR step measures
the paths its `base...head` diff publishes (`publishedPaths`, `git diff --name-only -z`, the record's
own spelling) and compares them with the call's measured `changed` on `coverage`: a path the call
did not measure gives `**Stale.** The cited call measured N of the M path(s) this PR changes …` and
names them; otherwise the body says it measured all M, and that this compares paths, not contents.

Tool-authored text (an unrunnable or missing verification's `message`, the tool's own words on an
`EvidenceNone`) is one line in a code span, at most `PR_MESSAGE_MAX_CHARS` (500), so a newline, a
heading, a fence or an `@name` in git's stderr cannot change the body's structure or notify anyone;
the session worktree's absolute path in such a message is replaced by `<worktree>`. The whole body
stays under `PR_BODY_MAX_CHARS` (60,000; GitHub refuses one over 65,536 and no PR opens): the section
is bounded by `PR_EVIDENCE_SECTION_MAX_CHARS` (30,000) — every result keeps its facts, failing results
get their excerpts first, a result left without one says `Output not quoted`, and results whose facts
do not fit are counted — the changed-file list stops at `PR_CHANGED_LIST_MAX` (300) with a count, and
the prompt is cut to fit with a line saying so.

The same `PrEvidence` is committed on the `factory.pr` document (field `evidence`) and on the
`factory.pr.opened` entry, so the `prOpened` event carries it and `readSessionLog(...).pr.evidence`
folds it back — the value a column's `requires[]` check (LOB-80) will read is the one the reviewer
read.

**How a user reaches it.** By opening the session's PR: the reviewer reads the section on GitHub.

**How the skill drives it.** `./pr-evidence.sh` — the loopback GitHub fake (`./github-fake.ts`) on
`PR_EVIDENCE_PORT`, else `API_PORT`, else 9411, and the driver building `SessionService` in-process
on the run's `DATABASE_URL` (no API server). Three scenarios, each its own fixture repo (no remote)
with a `.pi/skills/verify-api/drive.sh`, and its own session whose faux model commits
`apps/api/feature.ts` on the session's branch:

1. `pass` — the model calls `verify`; the skill prints a verdict and exits 0. The body the fake was
   sent names `` `verify-api`: exit 0 ``, `Exit code: 0`, and quotes the output whole with no
   truncation mark; the `factory.pr` document holds the same evidence.
2. `fail` — the skill prints 400 lines and exits 3. The body says `exit 3 (failed)`, marks the
   excerpt truncated, keeps the verdict line, drops `check 1`, and the fenced excerpt is exactly
   `tailOf(recorded output, PR_EVIDENCE_EXCERPT)` — 40 lines starting at `check 362`.
3. `unverified` — the model never calls `verify`. The log holds no record, and the body says
   `**No verification evidence.** … the run never called the `verify` tool.`; the document holds
   `EvidenceNone{reason: not-verified}`.

The body is read from the fake's ledger on disk, i.e. the request GitHub would have received. Every
check is required: the script exits non-zero when one fails.

**What proves it works.** `.verify/evidence/lob-79/api/`: `pr-evidence.json` (each scenario's session
id, step answer, sent body, decoded records and committed evidence, and the checks),
`pr-evidence-<scenario>.md` (each body as sent), `pr-evidence-ledger.json`, `pr-evidence.log`. Unit
and service coverage: `packages/core/src/pr.test.ts` ("the verification section": name, exit code,
output, order, a failing code, no evidence, a skill-less surface, deterministic line and character
cuts with the visible mark, a record-level truncation, fence safety, tool messages as one code-span
line, the stale and not-last caveats, the section bound, the body bound), `packages/harness/src/verify.test.ts`
(`prEvidenceOf`: no record, the last call wins, a declared command and an unrunnable one, unmeasured
and no-changes, the worktree path redacted, a newest call with no record, path coverage), `packages/harness/src/session.test.ts` (the evidence on the document, the `prOpened`
event and the fold), and `packages/core/src/SessionService.test.ts` ("the PR's evidence": the three
scenarios above through the in-process GitHub fake, plus a run that commits again after verifying,
whose body says `**Stale.**` and names the path).

**What it does not prove.** That the cited `verify` call saw the _contents_ the PR publishes: the
comparison is by path, so an edit to a path the call already measured is not detected (the body says
so). That GitHub renders the section as the fixture bodies
read — the Markdown is CommonMark and the fence rule is CommonMark's, but no real GitHub is called.
Nothing _gates_ on the evidence yet: refusing a move whose `requires[]` evidence is missing is
LOB-80.
