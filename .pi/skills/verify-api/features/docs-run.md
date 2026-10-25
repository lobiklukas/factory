# A docs run (LOB-228, part 4 of LOB-195)

**What it is.** One documentation run end to end: a session whose card sits in a column that names the
factory's `docs` skill edits three markdown files through its own tool path, is refused when it
reaches for a source file, and then opens exactly one pull request whose body lists the three changed
paths. A control run over the diff cap opens nothing.

**How a user reaches it.** They don't drive this by hand; it is what "a docs run" means once a board
column holds the `docs` skill. The pieces a user can see: the `docs` row in the skills library
(seeded by `0015_seed_docs_skill.ts`, LOB-225), the column's `skills[]` selecting it when a run opens
(`runColumnFor` → `loadRun` → `sessions.create({ taskId, taskColumn })`), `openSession` composing
`docsPolicy` because the column names the skill, and the `## Changed files` section the PR step writes
into the body (LOB-228).

**How the skill drives it.** `./docs-run.sh` — two phases, each its own process, against a loopback
GitHub fake (`./github-fake.ts`) whose ledger is a file on disk, so "exactly one request" and "the
body lists these paths" are counted and read rather than asserted from the driver's own memory:

1. `MODE=docs` inserts the drive's own board definition version (`docs-run` v1: one column,
   `documenting`, naming `docs`), a board instance bound to its own repo checkout, a task, and — via
   the real `sessions.create({ taskId, taskColumn })` — the run row the column is read from. It then
   sends one message and waits for both tool calls to be decided, then for the run to settle:
   - the faux model calls `bash` with `DOCS_COMMAND`, which writes `docs/session.md`,
     `docs/board.md`, `docs/policy.md` and creates `src/`;
   - it then calls the `write` tool for `code.ts` at the worktree root, which `docsPolicy` refuses
     with the sentence that names the docs rule and prints the allowlist;
   - it answers with what the refusal told it.
     The driver commits the three files on the session's own branch (what the control plane's git
     plumbing would do; the cap measures the _branch's_ diff), calls the real PR step, and the shell
     reads the ledger: one POST, one PR, and the request body carrying `## Changed files` and each of
     the three paths.
2. `MODE=over-cap` opens a second run in the same column, commits 51 files of one line, and calls the
   step: it must answer `{outcome: "over-cap", limit: "files", cap: 50, measured: 51}` and add
   nothing to the ledger. Without it, a step that opened a PR for any branch would pass every check
   in the first phase.
3. Every check is a required check: the script exits non-zero when one fails.

**What proves it works.** `.verify/evidence/lob-228/`: the two phase files
(`docs-run-docs.json`, `docs-run-over-cap.json`), `docs-run-process.json` (the 5 shell checks),
`docs-run-ledger.json` (the request, its body, and the PR), and the driver logs.

**Non-vacuity.** A hand mutation run, recorded as `mutation-no-docs-rule.log` in the same directory:
dropping the composition at `openSession`'s install site (`skills.some((skill) => skill.name ===
DOCS_SKILL) ? docsPolicy(policy) : policy` → `policy`) makes the source write **land** —
`code.ts exists=true`, the refusal line absent — and three checks fail. The driver waits for "both
tool calls were decided" rather than for the refusal on purpose: a wait for the refusal would report
the mutation as a timeout in the harness instead of as the missing refusal it is.

**What it does not prove.** Nothing about writes a `bash` command makes: `docsPolicy` reads only the
`write`/`edit` `path` argument, so `printf > code.ts`, `sed -i` or a program that writes its own file
land unrefused inside a docs run. That is the shell-write gap the policy's own docstring states, and
this drive does not narrow it — it proves the rule where the rule exists. Nor does the fake prove
what GitHub really answers: a create here is always 201 for a new head, and the duplicate shape (422
followed by the lookup) is `./pr-once.sh`'s subject and `packages/core/src/pr.test.ts`'s contract.
And the body's list is git's own `--numstat` path column: a rename reads `docs/{old.md => new.md}`
and a path with a special character arrives quoted, so a reader of the PR body sees what git printed
rather than a normalized path (the same spelling the cap counts). Finally, the board rows are
inserted by the drive rather than by the CLI or the dashboard (LOB-61, LOB-84), so "a user creates
this board through a surface" is not what is proven here — what is proven is that the service reads a
card's pinned column and the run behaves as the `docs` skill says.
