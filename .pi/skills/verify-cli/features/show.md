# `factory show`

**What it is.** One session's facts, one `name value` line each: `session`, `title`, `status`, `repo`
(with `base-ref`), `workspace`, `model`, `pr`, and — F19 — `context`: what its run was told about its
repository. Read from the session's snapshot and `getSessionContext`, so it answers for a session no
process owns.

**The `context` line.** `told AGENTS.md (5823 bytes, 1522 tokens) and 8 repo skills`, with a truncated
file called out (`truncated: the prompt carries only part of it, cap 4096 tokens`), skills dropped for the
budget or shadowed by the column's own, and nested `AGENTS.md` files listed (`1 nested AGENTS.md listed`).
The file named is the one that was read (F20): `AGENTS.md`, else `CLAUDE.md`, else
`.github/copilot-instructions.md`. A scratch session and a repo with neither file nor skills say
`context no repo instructions`. `context-read`, `context-nested`, `context-dropped` and
`context-shadowed` lines follow with the commit and paths.

**How the skill drives it.** `./repo-context.sh` (API on `CONTEXT_PORT`, default `:9394`): fixture repos
with AGENTS.md and skills, AGENTS.md and CLAUDE.md, only CLAUDE.md, only the Copilot file, a file far over
the cap, and nothing; a real `factory run` on each, then `factory show` and the line is matched, the byte
count against the file's own size. An unknown id is `error: not_found`, non-zero.

**Proven in tests too.** `apps/cli/src/commands/show.test.ts`, `packages/domain/src/RepoContext.test.ts`,
`packages/core/src/SessionService.repoContext.test.ts` (`getSessionContext` through the service) and
`apps/api/src/Rpc/Session.test.ts` (over the wire).
