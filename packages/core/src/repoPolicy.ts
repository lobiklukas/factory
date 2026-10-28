/**
 * Read a repository's policy (S-factory-config-as-code): the `policy` block of its `.factory/config`,
 * at the commit the session's base names, from the registered checkout or the factory's mirror —
 * never from the session's worktree.
 *
 * **At the base, in the checkout.** The worktree and its branch are the agent's (D10): a run that
 * edited `.factory/config` there, committed or not, would otherwise be writing its own rules. The
 * base is what the operator's repository holds — reviewed and merged — and it is read with `git
 * cat-file` in the checkout the worktree was cut from, so neither the worktree's files nor its `.git`
 * file are consulted. The control plane reads it once per session and pins it in the log
 * (`@repo/harness`'s `PolicyDoc`); this module is only the read.
 *
 * **Tighten-only, checked at load.** The block can add approval gates (`approvalRequired`), a deny
 * list (`deny`) and narrow the egress allowlist (`allowedHosts`); `@repo/harness`'s `withRepoPolicy`
 * merges it under the deployment's configuration. A block that tries to allow something the
 * deployment denies — a host off its allowlist — is refused whole, as `RepoPolicyRejected`, and so
 * is one that is not the policy's shape: an unknown key is an error rather than ignored, because a
 * key the factory does not know (`allow`, `pushRefPrefixes`) is a rule its author thinks is in force.
 * A file that is not JSON is refused too, since there is no telling what policy it meant to declare.
 * The rest of the file — the commands `./workspace` reads — is not this module's, and its keys are
 * left alone.
 */
import { Effect, Schema } from "effect";
import { RepoPolicyRejected } from "@repo/domain/Session";
import {
  repoPolicyWidening,
  type AutonomyConfig,
  type RepoPolicy,
  type RepoPolicySource,
} from "@repo/harness";
import { gitAnswer, resolveCommit } from "./repos";
import { CONFIG_FILE } from "./workspace";

/** The largest `.factory/config` read; a larger one is refused rather than read in part. */
export const REPO_CONFIG_READ_BYTES = 64 * 1024;

/** How long one git read may take. A read that times out is no answer, so the base is unread. */
const GIT_READ_TIMEOUT_MS = 15_000;

/** One entry of a list the block declares: a command prefix or a host, never blank. */
const Entry = Schema.String.pipe(Schema.check(Schema.isPattern(/\S/)));

/** The `policy` block as a repository writes it. Every key is optional; no other key is allowed. */
const PolicyBlock = Schema.Struct({
  approvalRequired: Schema.optional(Schema.Array(Entry)),
  deny: Schema.optional(Schema.Array(Entry)),
  allowedHosts: Schema.optional(Schema.Array(Entry)),
});

/** What one read of a base came to. */
export type RepoPolicyRead =
  /** The base was read: its policy (none declared is `NO_REPO_POLICY`'s empty lists), and where. */
  | {
      readonly _tag: "read";
      readonly source: RepoPolicySource;
      readonly policy: RepoPolicy;
    }
  /** Git could not answer for the base (it names no commit there): nothing to pin, say why. */
  | { readonly _tag: "unread"; readonly problem: string };

export type ReadRepoPolicyInput = {
  readonly repo: string;
  /** The registered checkout, or the factory's mirror of the repo: where the base's objects are. */
  readonly checkout: string;
  /** Where the repo sits inside `checkout`'s work tree (`""` at its root), as git prints it. */
  readonly prefix: string;
  /** The base to read at: the session's base ref, or the fetched tip its worktree was cut from. */
  readonly ref: string;
};

/**
 * The repository's policy at `ref`, checked against the deployment's `config`. A base with no
 * `.factory/config`, or a config with no `policy` block, is a read with no policy. Refused with
 * `RepoPolicyRejected` when the config is too large or not JSON (`unreadable`), when the block is
 * not the policy's shape (`invalid`), and when it widens the deployment (`widens`).
 */
export const readRepoPolicy = (
  input: ReadRepoPolicyInput,
  config: AutonomyConfig,
): Effect.Effect<RepoPolicyRead, RepoPolicyRejected> =>
  Effect.gen(function* () {
    const commit = yield* resolveCommit(input.checkout, input.ref);
    if (commit === undefined)
      return {
        _tag: "unread",
        problem: `${input.ref} names no commit in ${input.checkout}`,
      } as const;
    const path = [input.prefix, ...CONFIG_FILE]
      .filter((part) => part !== "")
      .join("/");
    const source = { ref: input.ref, commit, path };
    const refuse = (
      kind: RepoPolicyRejected["kind"],
      reasons: readonly string[],
    ) =>
      new RepoPolicyRejected({
        repo: input.repo,
        ref: input.ref,
        commit,
        path,
        kind,
        reasons,
        message: `repo ${input.repo}: the policy in ${path} at ${input.ref} (${commit.slice(0, 12)}) cannot be loaded: ${reasons.join("; ")}`,
      });
    const listed = yield* gitAnswer(
      input.checkout,
      [
        "--literal-pathspecs",
        "ls-tree",
        "-l",
        "--end-of-options",
        commit,
        "--",
        path,
      ],
      { timeoutMs: GIT_READ_TIMEOUT_MS },
    );
    if (listed === undefined)
      return {
        _tag: "unread",
        problem: `git could not list ${path} at ${input.ref}`,
      } as const;
    // `<mode> <type> <object> <size>\t<path>`; nothing listed is a base with no config.
    const [mode, type, object, size] =
      listed.split("\t")[0]?.trim().split(/\s+/) ?? [];
    if (listed === "" || object === undefined)
      return {
        _tag: "read",
        source: { ...source, found: false },
        policy: { approvalRequired: [], denied: [] },
      } as const;
    if (type !== "blob" || (mode !== "100644" && mode !== "100755"))
      return yield* refuse("unreadable", [`${path} is not a file`]);
    const bytes = Number(size);
    if (!Number.isFinite(bytes) || bytes > REPO_CONFIG_READ_BYTES)
      return yield* refuse("unreadable", [
        `${path} is ${size} bytes, over the ${REPO_CONFIG_READ_BYTES} read`,
      ]);
    const text = yield* gitAnswer(
      input.checkout,
      ["cat-file", "blob", object],
      {
        trim: false,
        maxBuffer: REPO_CONFIG_READ_BYTES + 1024,
        timeoutMs: GIT_READ_TIMEOUT_MS,
      },
    );
    if (text === undefined)
      return {
        _tag: "unread",
        problem: `git could not read ${path} at ${input.ref}`,
      } as const;
    const policy = yield* decodePolicy(text).pipe(
      Effect.mapError(({ kind, reasons }) => refuse(kind, reasons)),
    );
    const widening = repoPolicyWidening(config, policy);
    if (widening.length > 0) return yield* refuse("widens", widening);
    return {
      _tag: "read",
      source: { ...source, found: true },
      policy,
    } as const;
  });

/** Why a config's text is not a policy: the kind of refusal, and each problem in it. */
type Undecodable = {
  readonly kind: "unreadable" | "invalid";
  readonly reasons: readonly string[];
};

/**
 * A config's text as the policy it declares: no `policy` key is no policy. Pure apart from being an
 * Effect, so what is refused is a table in a test.
 */
export const decodePolicy = (
  text: string,
): Effect.Effect<RepoPolicy, Undecodable> =>
  Effect.gen(function* () {
    const parsed = yield* Schema.decodeEffect(
      Schema.fromJsonString(Schema.Unknown),
    )(text).pipe(
      Effect.mapError((): Undecodable => ({
        kind: "unreadable",
        reasons: [".factory/config is not JSON"],
      })),
    );
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      return yield* Effect.fail<Undecodable>({
        kind: "unreadable",
        reasons: [".factory/config is not a JSON object"],
      });
    if (!("policy" in parsed)) return { approvalRequired: [], denied: [] };
    const block = yield* Schema.decodeUnknownEffect(PolicyBlock)(
      parsed.policy,
      { onExcessProperty: "error", errors: "all" },
    ).pipe(
      Effect.mapError((error): Undecodable => ({
        kind: "invalid",
        reasons: [
          `its policy block is not a policy (approvalRequired, deny and allowedHosts, each a list of non-empty strings): ${error.message.replace(/\n\s*/g, " ")}`,
        ],
      })),
    );
    return {
      approvalRequired: (block.approvalRequired ?? []).map((entry) =>
        entry.trim(),
      ),
      denied: (block.deny ?? []).map((entry) => entry.trim()),
      ...(block.allowedHosts === undefined
        ? {}
        : { allowedHosts: block.allowedHosts.map((host) => host.trim()) }),
    };
  });
