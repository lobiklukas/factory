# The read-only specifying stage

**Status: passing** (LOB-74, part 3 of LOB-46).

A run whose column declares the `specifier` role is the **specifying stage**, and it writes nothing:
the refusal is a policy in the session's `ToolTask` hook, not a sentence in the `specify` skill. The
rule is `readOnlyStagePolicy` in `packages/harness/src/policy.ts`, keyed by role in
`READ_ONLY_ROLES` (B6: "a role resolves to … tool policy in one place"), and `openSession` composes it
from the run profile `SessionService` resolves from the card's pinned board definition — the column
the run started in and the role that column declares. No caller sets a flag.

## What it refuses, and what it leaves alone

| Refused                                                                                           | Allowed                                                |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `write`, `edit` (any path), `verify` (it runs the worktree's own scripts)                         | `read`, `ask`, a tool the rule has never heard of      |
| a `bash` redirect into a file, a write-table command (`rm`, `cp`, `touch`, `tee <file>`, …)       | `ls`, `grep … 2>/dev/null`, `cat`, a pipeline of reads |
| `dd of=<file>`, a `git` that changes the repo (`commit`, `push`, `checkout`, `reset`, `stash`, …) | `git log`, `git diff`, `git show`, `git stash list`    |
| the same writes inside `sh -c '…'` or behind `sudo`/`env`/`timeout`                               | a redirect to a device, `echo 'rm -rf src'` (a string) |

The refusal names the stage, the column and the role, and says what to do instead:

```
Tool call blocked: redirecting output to stage-probe.txt is refused: this run is in the read-only
specifying stage (column "specifying", role specifier), which reads the workspace and changes nothing
in it. Read and search instead, and put what you found in your answer or ask a question with the ask
tool.
```

The decision also carries it as data — `refusal: { _tag: "ReadOnlyStage", stage, column, role, call,
what }` on the `block` — so a test asserts the fields rather than parsing the sentence.

**The stage decides first.** A write outside the worktree in a specifying run is the stage's refusal,
not D11's: D11's sentence says "write inside the worktree instead", which would send a read-only run
straight into a second refusal. A call the stage allows goes on to the session's own policy, so every
D11 refusal (egress, a push to `main`, …) and every approval gate still holds; a gated call the stage
refuses is never asked about.

## How it is proven

```sh
./refusals.sh    # the `stage` case is the ninth
```

`stage.ts` seeds a board over `default` v2 and one card each in `specifying` and `building`, starts a
run on each through the API's `createSession({ taskId, taskColumn })`, and the faux script calls
`bash` with the same command in both: `echo stage > stage-probe.txt && echo wrote stage-probe.txt`.
It asserts, in `refusal-stage.json`:

- the specifying run's tool result is an error that says `redirecting output to stage-probe.txt is
refused`, `read-only specifying stage` and `column "specifying"`;
- the same tool result is in the **run's log**, read back through a reader-mode `PostgresStorage` and
  `readSessionLog` rather than from the API's live view;
- `stage-probe.txt` is not in the specifying run's worktree;
- the refusal reached the model's next turn (the faux echo);
- the building run's identical call ran, and `stage-probe.txt` holds `stage` in its worktree.

Mutation, observed on 2026-10-27: forcing `openSession` to skip the composition makes seven checks of
the specifying half fail (the call runs, the file lands), and the building half still passes — which
is the half that fails if the rule is made global instead (`READ_ONLY_ROLES[role] ?? "specifying"`
fails `packages/harness` and `packages/core` rows the same way).

Below the drive: `packages/harness/src/policy.stage.test.ts` is the table (17 refusals with their
typed refusal, 13 allows, the role selection, and the composition order), `policy.hook.test.ts` drives
the `write` and `edit` tools and a shell read through `openSession` in a real harness, `loader.test.ts`
pins that the role travels in the run profile, and `packages/core`'s `SessionService.test.ts` runs the
same write in `specifying` on v2, `specifying` on v1 (no skill bound — the role alone makes the stage)
and `building`, reading the refusal out of the Postgres log.

## What it does not prove

- **A boundary.** The `bash` half is the same textual read as D11's write rule, with the same holes:
  `sed -i`, a package manager, an interpreter, a script written earlier, a path in a variable. `git
branch`, `git tag` and `git config` writes are not read either (each also lists). D15: hooks stop the
  accident; the specifying stage's missing push credential (LOB-46) is what would stop the rest.
- **The spec artifact or the parked run.** What a specifying run produces and how it ends are LOB-72
  and LOB-73; this is only what it may not do.
- **Other roles.** Only `specifier` is read-only. The rest of B6's role → model and tool-policy
  mapping is LOB-207.
