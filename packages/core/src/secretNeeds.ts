/**
 * Which secrets a session's commands are given (S-agent-secrets): the names its repository's
 * `.factory/config` declares, read at the base the session was cut from, and the values the store
 * holds for them.
 *
 * **At the base, not the worktree.** The commands themselves are read from the worktree
 * (`./workspace`), which the agent's branch can change — so the declaration that decides which
 * stored values reach them is not. A branch that adds `"secrets": {"verify": ["DEPLOY_TOKEN"]}` to
 * its own config gets nothing for it; the operator's reviewed, merged config is what grants a value,
 * as the repository's instructions are read at the base (`./repoContext`). The worktree shares the
 * checkout's objects, so the read is one `git show` there: no checkout, no network.
 *
 * Never fails the open: a base that does not resolve, a config that does not exist there or does not
 * decode, and a store that cannot answer all grant nothing — said in the process's log — and a name
 * declared but not stored is answered as missing, which the commands' output names.
 */
import { Effect, Option, Schema } from "effect";
import { RepoSecretNeeds } from "@repo/domain/Secret";
import type { RepoSlug } from "@repo/domain/Session";
import type { InjectedSecrets } from "@repo/harness";
import { gitAnswer } from "./repos";
import type { SecretServiceShape } from "./SecretService";
import { CONFIG_FILE, type WorkspaceDeps, workTreePrefix } from "./workspace";

/** What one step is given: the values it declares and the store holds, and the names it does not. */
export type StepSecrets = {
  readonly values: InjectedSecrets;
  readonly missing: readonly string[];
};

/** What a session's commands are given, per step, and every value among them (what is masked). */
export type GrantedSecrets = {
  readonly setup: StepSecrets;
  readonly verify: StepSecrets;
  readonly all: InjectedSecrets;
};

const NO_STEP: StepSecrets = { values: [], missing: [] };

export const NO_SECRETS: GrantedSecrets = {
  setup: NO_STEP,
  verify: NO_STEP,
  all: [],
};

/** The `secrets` section of a config document; anything else in it is the commands' business. */
const SecretsSection = Schema.fromJsonString(
  Schema.Struct({ secrets: Schema.optional(RepoSecretNeeds) }),
);

/** The largest config read: a config past it declares no secrets. */
const CONFIG_READ_BYTES = 256 * 1024;

/**
 * The secrets `.factory/config` declares at `ref`, read in `directory` (the session's worktree). A
 * checkout registered at a subdirectory of its work tree has its config at that place, as the
 * workspace reads it. `undefined` when the config is not there or declares none it can decode.
 */
export const secretNeedsAt = (
  input: {
    readonly directory: string;
    readonly ref: string;
    readonly localPath?: string | undefined;
  },
  deps: WorkspaceDeps,
): Effect.Effect<RepoSecretNeeds | undefined> =>
  Effect.gen(function* () {
    const prefix =
      input.localPath === undefined
        ? ""
        : yield* workTreePrefix(input.localPath, deps);
    const file = [...(prefix === "" ? [] : [prefix]), ...CONFIG_FILE].join(
      "/",
    );
    const text = yield* gitAnswer(
      input.directory,
      ["show", "--end-of-options", `${input.ref}:${file}`],
      { trim: false, maxBuffer: CONFIG_READ_BYTES },
    );
    if (text === undefined) return undefined;
    const decoded = Schema.decodeOption(SecretsSection)(text);
    if (Option.isNone(decoded)) {
      yield* Effect.logWarning(
        `${input.directory}: ${file} at ${input.ref} declares no secrets this server can read, so the session's commands get none`,
      );
      return undefined;
    }
    return decoded.value.secrets;
  });

/**
 * The values `needs` grants from the store for `repo`. A name the store holds and this key cannot
 * read is missing (and warned about); a store that cannot answer grants nothing.
 */
export const grantSecrets = (
  store: SecretServiceShape | undefined,
  repo: RepoSlug | undefined,
  needs: RepoSecretNeeds | undefined,
): Effect.Effect<GrantedSecrets> =>
  Effect.gen(function* () {
    const setupNames = [...new Set(needs?.setup ?? [])];
    const verifyNames = [...new Set(needs?.verify ?? [])];
    const names = [...new Set([...setupNames, ...verifyNames])];
    if (names.length === 0) return NO_SECRETS;
    const revealed =
      store === undefined || repo === undefined
        ? { values: [], unreadable: [] }
        : yield* store.reveal(repo, names).pipe(
            Effect.catch((error) =>
              Effect.logWarning(
                `repo ${repo}: its secrets could not be read (${error.message}), so the session's commands get none`,
              ).pipe(Effect.as({ values: [], unreadable: [] })),
            ),
          );
    if (revealed.unreadable.length > 0) {
      yield* Effect.logWarning(
        `repo ${repo}: secret(s) ${revealed.unreadable.join(", ")} cannot be read with this server's FACTORY_SECRETS_KEY, so the session's commands get none of them`,
      );
    }
    const step = (declared: readonly string[]): StepSecrets => {
      const values = revealed.values.filter((secret) =>
        declared.includes(secret.name),
      );
      return {
        values,
        missing: declared.filter(
          (name) => !values.some((secret) => secret.name === name),
        ),
      };
    };
    return {
      setup: step(setupNames),
      verify: step(verifyNames),
      all: revealed.values,
    };
  });
