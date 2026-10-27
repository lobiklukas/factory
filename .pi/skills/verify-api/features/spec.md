# The spec document: declared gaps, checked at the write

**Status: passing.** The specifying stage's artifact is a typed `factory.spec` document — goal,
acceptance criteria, `gaps`, open questions — and the rule B4 puts on the column's exit ("gaps
declared, explicitly `[]` when there are none") is checked when the spec is written, not promised by
whoever writes it (LOB-72, part 1 of LOB-46).

## What it is

- `writeSpec(conversation, input)` (`packages/harness/src/session.ts`) validates `input` with
  `decodeSpec` (`packages/harness/src/spec.ts`) and commits the `SpecDoc` token
  (`packages/harness/src/docs.ts`). The input is `unknown` on purpose: the validator is the only
  thing that may say a value is a spec.
- A value with no `gaps` field is refused with `SpecRefused{field: "gaps", reason: "missing"}`, and
  a value whose `gaps` is there but not a list of non-empty strings with
  `SpecRefused{field: "gaps", reason: "invalid"}`. `gaps: []` is accepted. So absent and empty are
  two answers, and the error says which field. The same holds for `goal`, `acceptance` and
  `openQuestions`.
- A value wrong in several places is refused once, with every faulted field in `fields`. An absent
  `gaps` leads as `field` even when `goal` is wrong too, so a caller is not told about `gaps` only
  on its second try.
- A refusal commits nothing: the log keeps the spec it held before.
- `readSpec(harness, conversation)` reads the document back, `undefined` when the session never
  specified — the document's seed has an empty goal, which is not a spec, so "never specified" and
  "specified, no gaps" do not collapse into one answer.
- `readSessionLog(storage).spec` is the read-only fold's copy of the same value, read through the
  same validator.

## How a user reaches it

Not yet: it is harness-only by scope (no task table, no RPC, no UI). Its first caller is the
specifying stage's run (LOB-73), which writes the spec and parks the task on a gap. Until then the
"real client" of this document is the harness API itself, and that is what the drive uses: the same
`openSession` on the same `PostgresStorage` the control plane opens.

## What proves it

`./spec.sh`, which runs `spec.ts` twice on the run's `DATABASE_URL`, in two processes:

- **write** — on a fresh log, `readSpec` answers no spec; a spec with no `gaps` is refused as
  `missing` naming `gaps`, and the log still holds no spec; `gaps: null` is refused as `invalid` for
  the same field; a spec with `gaps: []` and `openQuestions: []` is accepted and reads back equal.
- **reopen** — a fresh process opens the same log: `readSpec` returns the same content, `gaps` still
  `[]`; the reader-mode `readSessionLog` reads the same spec.
- The shell checks that the two phases ran in two different processes (the pids in the evidence), so
  the reopen's answer can only have come from the log.

Evidence: `spec-write.json`, `spec-reopen.json` and `spec-process.json` under `$EVIDENCE_DIR/api/`.
The checks are not vacuous: with `writeSpec` defaulting a missing `gaps` to `[]` before it decodes,
the write phase fails (the refusal it waits for never comes) and the script exits non-zero.

The suites cover the rest: `packages/harness/src/spec.test.ts` (every refusal and the field it
names, without a log) and `packages/harness/src/session.test.ts` ("the spec a session declared":
the round trip and reopen, the refusal that commits nothing, a rewrite that drops a withdrawn gap,
and a version-1 `factory.spec` value reading as no spec).

## What it does not prove

- **The stage using it.** Nothing in a run writes a spec yet, and the `specifying` column's exit
  requirement is not checked against the document: the ask, the `needs_input` block and the parked
  run are LOB-73's, read-only enforcement LOB-74's.
- **A spec over the wire.** `getSession` does not carry the spec; when the board shows one it reads
  it from the task, which is LOB-73's.
- **A fork's spec.** A fork copies entries, not documents, so a forked session starts with no spec.
  That is the same as every other `factory.*` document and is not driven here.

## Running it

`./spec.sh` imports `@repo/harness` and `@repo/storage-postgres` from `.pi/skills/verify-api`, as
`./pr-once.sh` imports `@repo/core`. The root `package.json` declares them (LOB-175), so a plain
`bun install` links them into the root `node_modules` and the driver resolves them from its own
directory; no hand-made link is needed.
