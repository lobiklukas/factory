# Scoped secrets (S-agent-secrets)

**What it is.** A repository's named secrets — a registry token for `install`, a test API key for
`verify` — stored by the control plane, given only to the commands that declare them, masked
wherever they would reach the log, and refused at the push.

- **Stored write-only, encrypted.** `factory secret set <repo> <NAME>` (the value on stdin or
  `--file`, never an argument), the Repositories page's Secrets form, or `setSecret` over RPC. The
  `secrets` table (migration `0042_create_secrets.ts`) holds AES-256-GCM ciphertext under
  `FACTORY_SECRETS_KEY` (32 bytes, base64 or hex; `openssl rand -base64 32`), bound to its repo and
  name. No RPC answers a value: `setSecret`, `listSecrets` and `deleteSecret` answer summaries (repo,
  name, when, who). Without a key nothing is stored (`secrets_unconfigured`); a value under eight
  characters is `invalid_secret`; an unregistered repo `repo_not_found`.
- **Declared at the base.** `.factory/config`'s `"secrets": {"setup": [...], "verify": [...]}`, read
  at the session's base (`git show <base>:.factory/config`), never from the run's branch — a branch
  that declares more gets nothing for it (`packages/core/src/secretNeeds.ts`).
- **Injected per command.** Each declared value is a variable of the setup's `install`/`build` and of
  the `verify` tool's commands only (`execToExit`'s `secrets`). The agent's own `bash` gets the
  session's environment, which holds none of them; `env` there does not show one. The command's own
  variables win, so a secret named `DATABASE_URL` does not undo a verification's isolation.
  A declared name the store does not hold is said in the output (`== secrets: NAME (declared, not
stored)`).
- **Masked before it is committed.** Each injected command's output is masked at the source
  (`[secret:NAME]`, a value split across chunks included), every command the session's tools run is
  masked (`maskingEnv`), and every tool's settled result passes an `afterTool` hook that masks it
  (`secretMaskExtension`) — so the verify record, the live tool output, the transcript and the PR
  body's excerpt never hold a value.
- **Declared at a pinned base.** The base the declaration is read at is resolved once, at the
  session's first open, and pinned in `session_secret_bases` (migration
  `0043_create_session_secret_bases.ts`): a ref the agent's shell moves afterwards grants nothing.
- **Scanned before the push.** The PR step scans every line the branch's commits add
  (`git log -p`, not only the net diff; every file read as text whatever its `.gitattributes`; a
  merge as a dense combined diff) and every commit's message, author, committer and paths, for any
  value the store holds for the repo and for well-known credential shapes. The range stops at the
  base's tip as the control plane fetches it from the forge just before its push — never a local
  ref — and at an adopted card PR's published commit. The patterns apply to every repo, with or
  without a store. A multi-line stored value is also recognized by each piece of it that looks like
  key material (20+ characters mixing cases and digits), never by its boilerplate lines (`SECRET_PATTERNS`; a fixture line may opt out of the patterns with
  `factory-secret-scan:allow`, never out of a stored value). A finding answers `secret-found` — no
  push, no PR, no record — naming each finding's secret (or pattern), path, line and commit and never
  the text. A settled card run writes it as a `secret_found` note on the card; `factory pr` prints
  `error: secret_found: …`. A stored value this key cannot read refuses the step: a branch is never
  pushed unscanned.

**What masking is not.** A defence against code written to leak: the repo's commands are code the
run's branch can change, and a command that prints a value encoded prints nothing a literal match
recognizes. The push's scan is the second guard, for a value that reaches a commit.

**How it is proven.** `./secrets.sh` (its own API on `API_PORT`, a store key minted per run, the faux
model scripted to count `TEST_API_KEY` in its shell, commit a change, and call `verify`):

| Check                | What it proves                                                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| cli set / ls / short | the value is read from stdin and printed nowhere; ls lists the name; a short value is `invalid_secret`                               |
| rpc list             | `listSecrets` answers the summary, no value                                                                                          |
| verify passes        | the declared verify needs the stored value (checked by digest) and exits 0                                                           |
| placeholder          | what verify printed of it is `[secret:TEST_API_KEY]`                                                                                 |
| agent env            | the run's own `env` holds no non-empty `TEST_API_KEY`                                                                                |
| no row               | none of the rows the session wrote (its log's commits and checkpoints, every index row) holds the value                              |
| projection           | `getSession`'s snapshot holds the placeholder and no value                                                                           |
| leaky card           | a card's building run that commits the value settles to a `secret_found` note naming `TEST_API_KEY at leaked.txt:1`, never the value |
| factory pr           | the operator's call meets the same refusal, and no PR is recorded                                                                    |
| rm                   | `factory secret rm` deletes it                                                                                                       |
| board show           | `factory board show --task` prints the card's refusal                                                                                |
| no leak in evidence  | no evidence file and no API log line holds the value                                                                                 |

The push itself is proven refused before it happens in `packages/core/src/SessionService.secrets.test.ts`
(a real `git http-backend` forge sees no `git-receive-pack`, and its `factory/<id>` does not exist);
the store, the scan and the grants in `SecretService.test.ts`, `secretScan.test.ts` and
`secretNeeds.test.ts`; the masking in `packages/harness/src/secrets.test.ts`; the wire in
`apps/api/src/Rpc/Secrets.test.ts`; the Repositories page's Secrets form in verify-web's `repos.sh`.
