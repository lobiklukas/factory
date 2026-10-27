# The PR body's evidence block (LOB-79, part 2 of LOB-16)

**What it is.** The session's PR body carries a `## Verification` section generated from the run's
recorded `verify` results (LOB-78), never from prose the model wrote. The PR step
(`packages/core/src/prStep.ts`) reads the `verify` records from the session's own log
(`readConversationVerifyRecords`), `prEvidenceOf` (`packages/harness/src/verify.ts`) turns the
**last** record into a `PrEvidence` (`packages/domain/src/Session.ts`), and `buildPrBody`
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
- no evidence at all — the run never called `verify`, its last call could not measure what changed,
  or it found nothing changed — `**No verification evidence.** Nothing in this PR was verified by a
recorded run: <why>.` The section is never omitted.

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
cuts with the visible mark, a record-level truncation, fence safety), `packages/harness/src/verify.test.ts`
(`prEvidenceOf`: no record, the last call wins, a declared command and an unrunnable one, unmeasured
and no-changes), `packages/harness/src/session.test.ts` (the evidence on the document, the `prOpened`
event and the fold), and `packages/core/src/SessionService.test.ts` ("the PR's evidence": the three
scenarios above through the in-process GitHub fake).

**What it does not prove.** That the last `verify` call saw the commit the PR publishes: a run that
verifies and then commits more is cited with its earlier verdict (the record says which paths it
measured, the body does not compare them). That GitHub renders the section as the fixture bodies
read — the Markdown is CommonMark and the fence rule is CommonMark's, but no real GitHub is called.
Nothing _gates_ on the evidence yet: refusing a move whose `requires[]` evidence is missing is
LOB-80.
