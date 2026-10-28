import { Console, Effect, Option, Schema } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { RepoCloneFailed, RepoSlug } from "@repo/domain/Session";
import type { RepoSummary } from "@repo/domain/Session";
import { resolveApiUrl } from "../api";
import { reportFailure, reportFailures } from "../errors";
import { SessionClient } from "../rpc";
import { remedyFor, repoState } from "./repo";

/**
 * `factory doctor` — can every registered repo cut a worktree? (LOB-265)
 *
 * It reads the registry and, for each repo, answers `ok` or says what is wrong and the command that
 * fixes it. A repo with a local checkout is read as the registry reads it (inside a git work tree or
 * not). A repo with only a URL is cloned into the factory's cache right now (`syncRepo`), so the
 * answer is the clone's: `ok` once it is there, and the typed `repo_clone_failed` reason — auth, a
 * base ref the remote lacks, a URL a token may not be sent to, the network — when it is not. A repo
 * with neither is the one `createSession` auto-registers, and is reported as it is.
 *
 * `factory doctor owner/name` checks that one repo alone. Exits non-zero when any repo checked cannot
 * run, so a script (or a deploy) can gate on it.
 */

/** One repo's verdict: ok, or what is wrong and how to fix it. */
export type RepoDiagnosis =
  | { readonly ok: true; readonly detail: string }
  | { readonly ok: false; readonly detail: string; readonly remedy: string };

/** The verdict for a repo that needs no clone: read off the row the registry answered. */
export const diagnoseRow = (repo: RepoSummary): RepoDiagnosis => {
  if (repo.localPath !== undefined && repo.localPathIsGit)
    return { ok: true, detail: `checkout ${repo.localPath}` };
  if (repo.localPath === undefined && repo.mirrorPath !== undefined)
    return { ok: true, detail: `cloned into ${repo.mirrorPath}` };
  return {
    ok: false,
    detail: repoState(repo),
    remedy: remedyFor(repo),
  };
};

const isCloneFailure = Schema.is(RepoCloneFailed);

const doctorCommand = Command.make(
  "doctor",
  {
    repo: Argument.String("repo").pipe(
      Argument.withDescription("Check only this repository (owner/name)"),
      Argument.optional,
    ),
    api: Flag.String("api").pipe(
      Flag.withDescription("Control plane base URL"),
      Flag.optional,
    ),
  },
  Effect.fnUntraced(function* ({ repo: only, api }) {
    const asked = Option.getOrUndefined(only);
    const slug =
      asked === undefined
        ? undefined
        : Option.getOrUndefined(Schema.decodeOption(RepoSlug)(asked));
    if (asked !== undefined && slug === undefined)
      return yield* reportFailure(
        "invalid_input",
        `"${asked}" is not a repository (owner/name)`,
      );
    const apiUrl = yield* resolveApiUrl(api);

    const program = Effect.gen(function* () {
      const { client } = yield* SessionClient;
      const repos =
        slug === undefined
          ? (yield* client.listRepos({})).repos
          : [yield* client.getRepo({ repo: slug })];
      if (repos.length === 0) {
        yield* Console.log("no repos");
        return;
      }
      let broken = 0;
      for (const repo of repos) {
        // A URL-only repo is cloned now: the clone is what says whether it can run.
        const diagnosis: RepoDiagnosis =
          repo.localPath === undefined && repo.url !== ""
            ? yield* client.syncRepo({ repo: repo.repo }).pipe(
                Effect.map((synced): RepoDiagnosis => diagnoseRow(synced)),
                Effect.catchIf(isCloneFailure, (failed) =>
                  Effect.succeed<RepoDiagnosis>({
                    ok: false,
                    detail: `repo_clone_failed (${failed.reason}): ${failed.message}`,
                    remedy: `fix the URL or the credential, then factory repo sync ${repo.repo}`,
                  }),
                ),
              )
            : diagnoseRow(repo);
        if (diagnosis.ok) {
          yield* Console.log(`ok    ${repo.repo}  ${diagnosis.detail}`);
        } else {
          broken += 1;
          yield* Console.log(`FAIL  ${repo.repo}  ${diagnosis.detail}`);
          yield* Console.log(`      remedy: ${diagnosis.remedy}`);
        }
      }
      if (broken > 0) {
        return yield* reportFailure(
          "repo_check_failed",
          `${broken} of ${repos.length} repos cannot cut a worktree`,
        );
      }
    });

    yield* reportFailures(Effect.provide(program, SessionClient.layer(apiUrl)));
  }),
).pipe(
  Command.withDescription(
    "Check that every registered repository can cut a worktree, cloning URL-only ones",
  ),
);

export { doctorCommand };
