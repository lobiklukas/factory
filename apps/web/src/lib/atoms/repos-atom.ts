import { Duration, Effect } from "effect";
import { Atom } from "effect/reactivity";
import type { RegisterRepoInput, RepoSlug } from "@repo/domain/Session";
import { runtime } from "../atom";
import { RpcClient } from "../rpc-client";
import { SESSIONS_KEY } from "./session-list";

/** The reactivity key a write that changes the registry invalidates. */
export const REPOS_KEY = "repos";

/**
 * How often the page re-reads `listRepos`. A row is not only this page's to change: a session that
 * names a new slug registers it, `factory repo add` writes it, and a checkout can be deleted behind
 * the registry's back (its `localPathIsGit` is read from the disk each time a row is answered), so
 * the page polls. The registry is small and a probe is one `git rev-parse`, so five seconds is cheap.
 */
export const REPOS_POLL = Duration.seconds(5);

/**
 * The repositories the factory knows (LOB-253): `listRepos`, each row with what its checkout says
 * about itself. Re-read at once when this page registers one, and when a session is started from
 * this dashboard, because `createSession` registers a slug it has not seen (`SESSIONS_KEY`).
 */
export const reposAtom = runtime
  .atom(
    Effect.gen(function* () {
      const rpc = yield* RpcClient;
      return (yield* rpc.client.listRepos({})).repos;
    }),
  )
  .pipe(
    Atom.withReactivity([REPOS_KEY, SESSIONS_KEY]),
    Atom.withRefresh(REPOS_POLL),
  );

/**
 * One repository's row, for the board page (F25): `getRepo`, so its readiness score can be worded on
 * every card of the board from the one read — a board is on one repo, however many cards it holds.
 * Polled as the registry is, because the score follows the checkout's files as they are now. A repo
 * the registry has no row for fails the read, and the board shows no score.
 */
export const repoAtom = Atom.family((repo: RepoSlug) =>
  runtime
    .atom(
      Effect.gen(function* () {
        const rpc = yield* RpcClient;
        return yield* rpc.client.getRepo({ repo });
      }),
    )
    .pipe(Atom.withReactivity([REPOS_KEY]), Atom.withRefresh(REPOS_POLL)),
);

/**
 * Registers a repository, or updates the one with that slug: `registerRepo`, exactly as `factory
 * repo add` does. The answer is the server's row or its typed refusal, and the page renders either;
 * nothing is added to the list here, the list re-reads (`REPOS_KEY`) and shows what the server holds.
 */
export const registerRepoAtom = runtime.fn(
  (input: RegisterRepoInput) =>
    Effect.gen(function* () {
      const rpc = yield* RpcClient;
      return yield* rpc.client.registerRepo(input);
    }),
  { reactivityKeys: [REPOS_KEY] },
);
