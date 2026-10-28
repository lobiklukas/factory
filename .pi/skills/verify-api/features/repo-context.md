# The repository's AGENTS.md and skills in every run (S-repo-instructions-and-skills)

**What it is.** Every time a session on a repository opens, the control plane reads the repository's
`AGENTS.md` and its skills — `.pi/skills/<name>/SKILL.md`, then `.agents/skills/<name>/SKILL.md` —
from the session's worktree **at the commit its base names** (`packages/core/src/repoContext.ts`,
`SessionService`'s `repoContextFor`), never from the worktree's files: a run's own branch cannot
rewrite what the next run is told. `openSession` turns them into two prompt sections
(`packages/harness/src/repoContext.ts`):

- `repo_instructions`: `AGENTS.md` verbatim under a one-line preamble, capped at 4096 tokens with the
  estimator compaction uses. A longer file is cut at a line boundary and says so, naming the file; a
  file over 256 KiB is not read and the section only says where it is. A symlinked `AGENTS.md` is
  followed once, to a file inside the repository. Installed ahead of the column's skills.
- `repo_skills`: an index, not the bodies — one line per skill with its frontmatter `name`
  (else its directory), a one-line `description`, and its path — capped at 1536 tokens as a prefix,
  installed after the column's skills. The run reads a skill's `SKILL.md` with its own tools when it
  needs it; the factory's skills table never holds it. A repo skill whose name the run's column
  already binds is left out (`shadowed`): the factory's skill is authoritative.

What both came to is committed in the open's one commit as the `factory.repo.prompt` document
(`readRepoPrompt`): the ref and commit, the instructions' path, bytes, tokens, cap and whether they
were cut, and the skills listed, dropped by the budget, or shadowed. A repository with neither file
gets no section and a record saying `instructions: null`; a scratch session (no repository) gets
neither, so it runs exactly as before. Forks and replays read their own worktree's base the same way.

**How a user reaches it.** Commit an `AGENTS.md` or a `.pi/skills/<name>/SKILL.md` to the repo's
base branch; the next run on that repo is told it.

**How to drive it.** `./repo-context.sh` (API on `API_PORT`, default `:9440`; faux, its
`FAUX_COMMAND` `cat`s the fixture's skill). Three repos over RPC:

| Scenario | Check                                                                                                       |
| -------- | ----------------------------------------------------------------------------------------------------------- |
| `told`   | the recorded prompt's `repo_instructions` carries AGENTS.md verbatim                                        |
| `told`   | the log's record names `AGENTS.md`, its bytes, the section's tokens, not truncated                          |
| `told`   | `repo_skills` names both skills and their paths, not the body                                               |
| `told`   | the run's `bash` read the skill's body from its worktree by the listed path                                 |
| `told`   | `listSkills` (the factory's table) has no row of either name                                                |
| `bare`   | no `repo_*` section: the same section keys a session with no repo gets                                      |
| `bare`   | the run answered; the record says `instructions: null`, no skills                                           |
| `self`   | a clone of this checkout: its own AGENTS.md (the Postgres gate rule) reaches the run, at its committed size |
| `self`   | its verify skills are listed by path                                                                        |

**Observable end state.** `.verify/evidence/latest/api/repo-context.json`: each session's id, the
section keys, both sections' text, the record, the `bash` result and the factory skill names;
`repo-context.log` and `repo-context-api.log` beside it.

**Proven in tests too.** `packages/harness/src/repoContext.test.ts` (assembly, caps, shadowing),
`packages/harness/src/repoContext.session.test.ts` (the committed sections, their order, the record, a
reopen), `packages/core/src/repoContext.test.ts` (the read at the base, symlinks, bounds) and
`packages/core/src/SessionService.repoContext.test.ts` (the three acceptance criteria through the
service).

**Status.** Passing: 9/9 on 2026-10-28 from the `agent/S-repo-instructions-and-skills` worktree
(`API_PORT=9530`, faux, `DATABASE_URL=…/factory_agent_s_repo_instructions_and_skills` on 5442). This
repository's own AGENTS.md came to 5823 bytes, 1522 tokens, uncut; its index listed 8 skills, none
dropped.
