# The read-only specifying stage

**Status: passing** (LOB-74, part 3 of LOB-46).

A run whose column declares the `specifier` role is the **specifying stage**, and it writes nothing:
the refusal is a policy in the session's `ToolTask` hook, not a sentence in the `specify` skill. The
rule is `readOnlyStagePolicy` in `packages/harness/src/policy.ts`, keyed by role in
`READ_ONLY_ROLES` (B6: "a role resolves to … tool policy in one place"), and `openSession` composes it
from the run profile `SessionService` resolves from the card's pinned board definition — the column
the run started in and the role that column declares. No caller sets a flag.

## What it refuses, and what it leaves alone

`bash` is judged by an **allowlist** of read commands (`STAGE_READ_COMMANDS`), so it fails closed: a
command the stage does not know reads is refused, rather than let through because nobody listed it as
a write. That is what keeps out the writes a model refused `edit` reaches for next — `sed -i`,
`perl -pi`, `patch`, `tar x`, `npm install`, `python3 -c`, a script.

| Refused                                                                                                           | Allowed                                                                                             |
| ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `write`, `edit` (any path), `verify` (it runs the worktree's own scripts)                                         | `read`, `ask`, a tool the rule has never heard of                                                   |
| a redirect into a file, in every spelling (`>`, `>>`, `>\|`, a heredoc into a file)                               | a redirect to a device (`2>/dev/null`), `tee` with no file                                          |
| any command not on the list: `rm`, `cp`, `touch`, `perl`, `awk`, `patch`, `tar`, `curl`, `npm`, `eval`, `./x.sh`  | `ls`, `cat`, `head`, `tail`, `grep`, `rg`, `wc`, `sort`, `jq`, `cd`, `test`                         |
| a read command's writing flag: `sed -i`, `find -delete`/`-exec`, `sort -o`, `rg --pre`, `uniq IN OUT`             | `sed -n '1,40p'`, `find . -name '*.ts'`, `xargs grep`, a `for` loop of reads                        |
| a `git` not known to read: `commit`, `fetch`, `update-ref`, `branch -D`, `tag v1`, `config k v`, `-c`, `--output` | `log`, `show`, `diff`, `status`, `blame`, `grep`, `branch`, `tag -l`, `worktree list`, `stash list` |
| the same inside `sh -c '…'`, `$(…)`, backticks, or behind `sudo`/`env`/`timeout`/`xargs`                          | `echo 'rm -rf src'` (a string), `x=$(git rev-parse HEAD)`                                           |

The refusal names the stage, the column and the role, and for `bash` what its `bash` may run:

```
Tool call blocked: redirecting output to stage-probe.txt is refused: this run is in the read-only
specifying stage (column "specifying", role specifier), which reads the workspace and changes nothing
in it. Its bash runs only commands that read (ls, cat, head, tail, grep, rg, find, wc, git log, show,
diff, status, blame, grep) and redirects nothing into a file. Read and search instead, and put what
you found in your answer or ask a question with the ask tool.
```

**The typed refusal is the sentence's source, not a second record.** `stageRefusalOf` returns
`{ _tag: "ReadOnlyStage", stage, column, role, call, what }`, and the tests assert those fields rather
than parsing prose. Pi Durable's `beforeTool` takes a `block` string and nothing else, so what the
run's log records — and what the API shows — is the sentence, which names every field.

**The stage decides first.** A write outside the worktree in a specifying run is the stage's refusal,
not D11's: D11's sentence says "write inside the worktree instead", which would send a read-only run
straight into a second refusal. A call the stage allows goes on to the session's own policy, so every
D11 refusal (egress, a push to `main`, …) and every approval gate still holds; a gated call the stage
refuses is never asked about.

## The role's model and tools (LOB-207)

The role is resolved once, by `resolveRole` in `packages/harness/src/loader.ts`, into the run's
model, the tools it is **not offered**, and the stage above. A read-only role is never given `write`,
`edit` or `verify`: they are filtered out of the run's tool list at `openSession`
(`AgentChange.tools: { remove }`), so a model that calls one anyway gets Pi Durable's
`Tool write is not available`. The refusal table above still holds behind the filter, and it is
still what a `bash` write meets. The model is the deployment's `ROLE_MODELS` row for the role, or the
deployment's own model when the role has no row.

`refusals.sh` boots the `stage` case with `ROLE_MODELS=specifier=faux/faux-spec`, and `stage.ts`
also asserts that the specifying run's requests all went to `faux/faux-spec` and the building run's
to `faux/faux-1` (each run's billed usage, through `getSession`). It also asserts that the specifying
run was offered `read`, `bash` and `ask` and none of `write`, `edit` or `verify`, and that the
building run was offered all three (`readOfferedTools`, read from the system messages in the run's
log). Observed 2026-10-27, API on `:9530`–`:9538`: **9/9 cases, 70 checks**, `stage` 19 of them.

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
is the half that fails if the rule is made global instead (`READ_ONLY_ROLES.get(role) ?? "specifying"`
fails `packages/harness` and `packages/core` rows the same way).

Below the drive: `packages/harness/src/policy.stage.test.ts` is the table (the refusals with their
typed refusal, the allows that keep the stage usable, the role selection — `constructor` is not a
role — and the composition order), `policy.hook.test.ts` drives
the `write` and `edit` tools and a shell read through `openSession` in a real harness, `loader.test.ts`
pins that the role travels in the run profile, and `packages/core`'s `SessionService.test.ts` runs the
same write in `specifying` on v2, `specifying` on v1 (no skill bound — the role alone makes the stage)
and `building`, reading the refusal out of the Postgres log.

## What it does not prove

- **A boundary.** The `bash` half reads the command's text. It fails closed on what the text shows,
  and cannot see what the text does not: a `sed` script's own `w` command, a program named in an
  environment variable (`GIT_PAGER=…`, `GIT_EXTERNAL_DIFF=…`), a symlink inside the worktree. D15:
  hooks stop the accident; the specifying stage's missing push credential (LOB-46) is what would stop
  the rest.
- **Every read.** A heredoc's body is read as commands, so a heredoc is refused unless every line of
  it is a read; `awk`, `xxd` and the interpreters are refused even when they would only read, and a
  `git` subcommand not in the read table is refused even when it is harmless (`git ls-remote`).
- **The spec artifact or the parked run.** What a specifying run produces and how it ends are LOB-72
  and LOB-73; this is only what it may not do.
- **Other roles' tools.** Only `specifier` is read-only; every other role is offered every tool.
