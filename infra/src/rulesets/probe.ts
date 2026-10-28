/**
 * The live half of LOB-30's proof: push to a `factory/**` branch as the factory itself, and see the
 * forge refuse the force-push and the deletion (docs/design.md D15).
 *
 * The read-back (`verifyRulesets`) says the rulesets are configured as declared; it cannot say
 * GitHub enforces them the way the declaration means. This does, with real `git` against the real
 * remote, as the credential the factory pushes with (`CredentialProvider`: `GITHUB_TOKEN`, or the
 * GitHub App — so "no app bypass" is what is exercised), and with nothing of the harness in the way:
 * the hooks that refuse a force-push inside a session are not running here, so a refusal can only
 * have come from the forge.
 *
 * On one branch, `factory/ruleset-probe` by default:
 *
 * 1. **seed** — a commit on top of the branch's tip (or a new branch) is pushed, not forced. It must
 *    be accepted: the factory's own kind of push still works, and the branch exists for the rest.
 * 2. **force-push** — an unrelated commit is pushed with `--force`. It must be refused, and refused
 *    by a repository rule (`GH013` in the remote's answer), not by auth or a network error.
 * 3. **delete** — `:refs/heads/<branch>`. Refused the same way.
 * 4. **intact** — `ls-remote` still answers the seed commit.
 *
 * Everything is harmless if the rulesets are absent (the force-push and the deletion then land on
 * the probe's own branch, and the probe fails). It never pushes to the default branch: a probe of
 * the PR-only rule that succeeded would have written to it. The one cost is the probe branch
 * itself, which the deletion rule then keeps; the next run reuses it.
 *
 * The token reaches one `git` process at a time through its environment and a fixed inline
 * credential helper scoped to the forge's origin, as in `@repo/core`'s `git.ts`; the URL is checked
 * by the same `resolveForgeUrl` (GitHub, or `http` only to loopback — which is how the tests point
 * it at `../testing/githubFake.ts`).
 */
import {
  DateTime,
  Duration,
  Effect,
  FileSystem,
  Redacted,
  Schema,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import {
  CredentialProvider,
  type CredentialError,
  isSafeBranchName,
  resolveForgeUrl,
  SESSION_BRANCH_PREFIX,
} from "@repo/core";
import type { RepoSlug } from "@repo/domain/Session";

/** The probe could not run at all: a refused input, or git could not start. */
export class ProbeError extends Schema.TaggedError<ProbeError>()("ProbeError", {
  message: Schema.String,
}) {}

export type ProbeOutcome = "accepted" | "rejected";

export type ProbeStep = {
  readonly step: "seed" | "force-push" | "delete" | "intact";
  readonly expected: ProbeOutcome;
  readonly outcome: ProbeOutcome;
  /** The remote named a repository rule (`GH013`) in its answer. */
  readonly ruleViolation: boolean;
  readonly passed: boolean;
  /** What the remote said (its `remote:` and `!` lines), with the token scrubbed out. */
  readonly detail: string;
};

export type ProbeReport = {
  readonly repo: string;
  readonly ref: string;
  readonly passed: boolean;
  readonly steps: ReadonlyArray<ProbeStep>;
};

export type ProbeInput = {
  readonly repo: RepoSlug;
  /** Defaults to `https://github.com/<repo>.git`; see `resolveForgeUrl`. */
  readonly url?: string;
  /** Defaults to `factory/ruleset-probe`. Must be under `factory/`. */
  readonly branch?: string;
  /** Per git call. Defaults to two minutes. */
  readonly timeout?: Duration.Input;
};

export const DEFAULT_PROBE_BRANCH = `${SESSION_BRANCH_PREFIX}ruleset-probe`;

const TOKEN_ENV = "FACTORY_PROBE_TOKEN";
const HELPER = `!f() { if [ "$1" = get ]; then printf 'username=x-access-token\\npassword=%s\\n' "$${TOKEN_ENV}"; fi; }; f`;

type Run = {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
};

const collect = <E>(stream: Stream.Stream<Uint8Array, E>) =>
  stream.pipe(Stream.decodeText(), Stream.mkString);

/** Run the force-push / deletion probe against one repo. */
export const probeRulesets = (
  input: ProbeInput,
): Effect.Effect<
  ProbeReport,
  ProbeError | CredentialError,
  | CredentialProvider
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const branch = input.branch ?? DEFAULT_PROBE_BRANCH;
    if (!branch.startsWith(SESSION_BRANCH_PREFIX) || !isSafeBranchName(branch))
      return yield* new ProbeError({
        message: `the probe branch must be a plain name under ${SESSION_BRANCH_PREFIX}, not "${branch}"`,
      });
    const resolved = resolveForgeUrl(input.repo, input.url);
    if (!resolved.ok)
      return yield* new ProbeError({
        message: `the forge URL is refused: ${resolved.why}`,
      });
    const forge = resolved.forge;
    const ref = `refs/heads/${branch}`;
    const timeout = input.timeout ?? Duration.minutes(2);

    const token = yield* (yield* CredentialProvider).tokenFor(input.repo);
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const fs = yield* FileSystem.FileSystem;
    const gitDir = yield* fs
      .makeTempDirectoryScoped({ prefix: "factory-ruleset-probe-" })
      .pipe(
        Effect.mapError(
          () => new ProbeError({ message: "no scratch directory" }),
        ),
      );
    const stamp = DateTime.formatIso(yield* DateTime.now);

    const scrub = (text: string) => {
      const value = Redacted.value(token);
      return value.length === 0 ? text : text.split(value).join("<redacted>");
    };

    const git = (args: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        const handle = yield* spawner.spawn(
          ChildProcess.make(
            "git",
            [
              "-c",
              "credential.helper=",
              "-c",
              `credential.${forge.origin}.helper=${HELPER}`,
              "-c",
              "core.askPass=",
              "-c",
              "protocol.allow=never",
              "-c",
              `protocol.${forge.scheme}.allow=always`,
              "-c",
              "http.followRedirects=false",
              "-c",
              "core.hooksPath=/dev/null",
              "--git-dir",
              gitDir,
              ...args,
            ],
            {
              cwd: gitDir,
              extendEnv: true,
              env: {
                GIT_CONFIG_NOSYSTEM: "1",
                GIT_CONFIG_GLOBAL: "/dev/null",
                GIT_TERMINAL_PROMPT: "0",
                GIT_ASKPASS: "",
                SSH_ASKPASS: "",
                GIT_AUTHOR_NAME: "factory ruleset probe",
                GIT_AUTHOR_EMAIL: "ruleset-probe@factory.invalid",
                GIT_COMMITTER_NAME: "factory ruleset probe",
                GIT_COMMITTER_EMAIL: "ruleset-probe@factory.invalid",
                [TOKEN_ENV]: Redacted.value(token),
              },
              // `mktree` reads its entries from stdin: none, so the empty tree.
              stdin: "ignore",
            },
          ),
        );
        const [stdout, stderr, exitCode] = yield* Effect.all(
          [collect(handle.stdout), collect(handle.stderr), handle.exitCode],
          { concurrency: "unbounded" },
        );
        return { stdout, stderr: scrub(stderr), exitCode: Number(exitCode) };
      }).pipe(
        Effect.scoped,
        Effect.timeoutOption(timeout),
        Effect.flatMap((run) =>
          run._tag === "Some"
            ? Effect.succeed<Run>(run.value)
            : Effect.fail(
                new ProbeError({
                  message: `git ${args[0] ?? ""} timed out`,
                }),
              ),
        ),
        Effect.catchTag("PlatformError", () =>
          Effect.fail(new ProbeError({ message: "git could not be run" })),
        ),
      );

    /** A local step that must work for the probe to mean anything. */
    const must = (args: ReadonlyArray<string>) =>
      git(args).pipe(
        Effect.flatMap((run) =>
          run.exitCode === 0
            ? Effect.succeed(run.stdout.trim())
            : Effect.fail(
                new ProbeError({
                  message: `git ${args[0] ?? ""} failed: ${run.stderr.trim().split("\n").at(-1) ?? ""}`,
                }),
              ),
        ),
      );

    const remoteTip = git(["ls-remote", forge.url, ref]).pipe(
      Effect.flatMap((run) =>
        run.exitCode === 0
          ? Effect.succeed(run.stdout.trim().split(/\s+/)[0] || undefined)
          : Effect.fail(
              new ProbeError({
                message: `ls-remote failed: ${run.stderr.trim().split("\n").at(-1) ?? ""}`,
              }),
            ),
      ),
    );

    const step = (
      name: ProbeStep["step"],
      expected: ProbeOutcome,
      args: ReadonlyArray<string>,
    ) =>
      git(args).pipe(
        Effect.map((run): ProbeStep => {
          const outcome: ProbeOutcome =
            run.exitCode === 0 ? "accepted" : "rejected";
          const ruleViolation = run.stderr.includes("GH013");
          const detail = run.stderr
            .split("\n")
            .filter(
              (line) => line.startsWith("remote:") || line.startsWith(" ! "),
            )
            .map((line) => line.trimEnd())
            .join("\n");
          return {
            step: name,
            expected,
            outcome,
            ruleViolation,
            // A rejection only counts when a repository rule made it: an auth failure or a dropped
            // connection is also a non-zero exit, and proves nothing about the boundary.
            passed:
              outcome === expected &&
              (expected === "accepted" || ruleViolation),
            detail:
              detail.length > 0
                ? detail
                : (run.stderr.trim().split("\n").at(-1) ?? ""),
          };
        }),
      );

    yield* must(["init", "--bare", "--quiet", "--template=", gitDir]);
    const emptyTree = yield* must(["mktree"]);
    const tip = yield* remoteTip;
    if (tip !== undefined)
      yield* must([
        "fetch",
        "--quiet",
        "--depth=1",
        "--no-tags",
        forge.url,
        `${ref}:refs/probe/tip`,
      ]);
    const seed = yield* must([
      "commit-tree",
      emptyTree,
      ...(tip === undefined ? [] : ["-p", tip]),
      "-m",
      `factory ruleset probe: seed ${stamp}`,
    ]);
    const rewrite = yield* must([
      "commit-tree",
      emptyTree,
      "-m",
      `factory ruleset probe: rewrite ${stamp}`,
    ]);

    const steps: Array<ProbeStep> = [];
    const seeded = yield* step("seed", "accepted", [
      "push",
      forge.url,
      `${seed}:${ref}`,
    ]);
    steps.push(seeded);
    if (seeded.passed) {
      steps.push(
        yield* step("force-push", "rejected", [
          "push",
          "--force",
          forge.url,
          `${rewrite}:${ref}`,
        ]),
      );
      steps.push(
        yield* step("delete", "rejected", ["push", forge.url, `:${ref}`]),
      );
      const after = yield* remoteTip;
      steps.push({
        step: "intact",
        expected: "accepted",
        outcome: after === seed ? "accepted" : "rejected",
        ruleViolation: false,
        passed: after === seed,
        detail: `${ref} is ${after ?? "absent"}, seeded ${seed}`,
      });
    }
    return {
      repo: input.repo,
      ref,
      passed: steps.length === 4 && steps.every((each) => each.passed),
      steps,
    };
  }).pipe(Effect.scoped);
