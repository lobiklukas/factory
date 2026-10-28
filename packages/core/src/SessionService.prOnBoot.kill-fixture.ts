/**
 * The process `SessionService.prOnBoot.test.ts` kills in its settle's PR step (F16): a real process,
 * so the SIGKILL is a real one — no finalizer, no shutdown, no last commit.
 *
 * It builds the session service the way the API does, over `DATABASE_URL` and the session root it
 * is given, with the settle-time PR step on (C18) and a forge that never answers: the first request
 * the step makes holds, as a GitHub call in flight when the process dies does. It registers the
 * fixture checkout as `<repo>`, puts a card on a new board straight into `building` (a column whose
 * exit requires a PR), and starts a run on it whose faux `bash` call commits one file. Once the run
 * has settled and its step is inside the forge call — after the branch was measured, before
 * `factory.pr` could commit — it prints one line, `READY`, the session id, the card id and the
 * worktree, space-separated, and waits to be killed.
 *
 * Its settings are arguments rather than environment variables, as `SessionService.kill-fixture.ts`'s
 * are: the API's environment is checked against `apps/api/turbo.json` (LOB-257), and these are a
 * test's.
 *
 *   DATABASE_URL=… bun packages/core/src/SessionService.prOnBoot.kill-fixture.ts <root> <repo> <checkout>
 */
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { RepoSlug } from "@repo/domain/Session";
import {
  BoardInstanceId,
  DEFAULT_DEFINITION_ID,
  DefinitionId,
} from "@repo/domain/Task";
import { createFauxModelAccess } from "@repo/harness";
import { DatabaseLive } from "@repo/storage-postgres";
import {
  Console,
  Context,
  Deferred,
  Effect,
  Layer,
  Option,
  Redacted,
} from "effect";
import { HttpClient } from "effect/http";
import { SqlClient } from "effect/sql/SqlClient";
import { CredentialProvider, staticTokenProvider } from "./credentials";
import { SessionService, SessionServiceLive } from "./SessionService";
import { TaskService, TaskServiceLive } from "./TaskService";

const [root = "", repo = "", checkout = ""] = process.argv.slice(2);

/** Completed by the forge's first request: the step is inside its GitHub call. */
const inTheCall = Deferred.makeUnsafe<void, never>();

const forge = Context.make(
  HttpClient.HttpClient,
  HttpClient.make(() =>
    Deferred.succeed(inTheCall, undefined).pipe(Effect.andThen(Effect.never)),
  ),
).pipe(
  Context.add(
    CredentialProvider,
    staticTokenProvider(Option.some(Redacted.make("f16-fake-token"))),
  ),
);

const ServiceLive = TaskServiceLive.pipe(
  Layer.provideMerge(
    SessionServiceLive({
      model: createFauxModelAccess({
        fauxCommand:
          "echo f16 > f16.txt && git add f16.txt && git -c user.email=f16@localhost -c user.name=f16 commit -qm f16; echo faux-ok",
      }).access,
      sessionRoot: root,
      pullRequestOnSettle: forge,
    }),
  ),
  Layer.provideMerge(Layer.mergeAll(DatabaseLive, BunServices.layer)),
);

const program = Effect.gen(function* () {
  const sessions = yield* SessionService;
  const tasks = yield* TaskService;
  const sql = yield* SqlClient;
  const slug = RepoSlug.make(repo);
  yield* sessions.registerRepo({
    repo: slug,
    url: `https://github.com/${repo}.git`,
    localPath: checkout,
  });
  const board = yield* tasks.createBoard({
    repo: slug,
    definitionId: DefinitionId.make(DEFAULT_DEFINITION_ID),
  });
  const card = yield* tasks.create({
    boardId: BoardInstanceId.make(board.id),
    title: "a card whose run's process dies in the PR step",
    actor: "person:f16",
  });
  // Straight into `building`: the moves that get a card there are the board's own suite's.
  yield* sql`UPDATE tasks SET "column" = 'building' WHERE id = ${card.id}`;
  const created = yield* sessions.create({
    taskId: card.id,
    taskColumn: "building",
  });
  yield* sessions.send({ sessionId: created.id, content: "build it" });
  yield* Deferred.await(inTheCall);
  const worktree = (yield* sessions.get(created.id)).workspace.path;
  yield* Console.log(`READY ${created.id} ${card.id} ${worktree}`);
  return yield* Effect.never;
});

BunRuntime.runMain(program.pipe(Effect.provide(ServiceLive)));
