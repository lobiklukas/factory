# `factory replay`

**What it is.** Deterministic replay across models, from a terminal (LOB-200, part 3 of LOB-39). A
replay runs a recorded session's task again — its first prompt, at its repo and base ref — in a _new_
session on another model (`replaySession`, LOB-198). When the replay's task settles, the control plane
stores a comparison on both sessions (`replayComparisons`, LOB-199); `factory replay` opens the
replay, follows it, and prints that comparison.

**How a user reaches it.** `factory replay ses_… --model provider/modelId` prints
`replay <new id> of <source id>`, the replay's transcript as `factory run` does, its `answer:`, and a
table: a `source` and a `replay` column (session, model, result, turns, cost) and a `delta` (the
replay's minus the source's, as stored on the log). Without `--model` the replay runs on the control
plane's own model.

Refusals are non-zero and typed, on stderr:

- an unknown model is `error: unknown_replay_model: model <x> is not one this control plane serves;
allowed: <every served model>` — checked against `getServerInfo().models` before anything is
  opened, so nothing is replayed;
- a session bound to no repo, or with no prompt to replay, prints the server's own
  `error: invalid_input: …` reason;
- an unknown id is `error: not_found`;
- a comparison that has not landed 30 s after the replay settled is
  `error: replay_comparison_pending`, naming the replay (it exists; a later `getSession` has it).

**How the skill drives it.** `./replay.sh` owns its own API (`REPLAY_PORT`, default `:9360`) with a
second faux model (`ROLE_MODELS=builder=faux/faux-alt`) that answers `alt-ok`, a flat `FAUX_COST`, and a
registered checkout. In a tmux window it runs a source session with a follow-up (so the source has more
turns than a replay will), replays it on `faux/faux-alt`, replays it with no `--model`, replays with an
unknown model, replays a scratch session with no repo, and replays an unknown id.

**What proves it.** The pane carries `answer: alt-ok` (the replay ran on the other model's script) and
the table: the session row names both sessions, the model row `faux/faux-1` against `faux/faux-alt`,
the result row `answered` twice, and the turns and cost rows a negative delta whose arithmetic the
script re-checks (replay minus source). `factory ls` gains exactly one row for the replay and none for
the refused model. Evidence: `.verify/evidence/latest/cli/replay-*.txt` and `replay.json`.

**What it does not prove.** The comparison's content: that a replay's spend, turns and outcome are
read correctly off each log, and that both logs hold the same reading, is `packages/harness`'s and
`packages/core`'s (`SessionService.test.ts`, LOB-199). The table's column order, signs and the
wait for a late comparison are `apps/cli/src/commands/replay.test.ts`.
