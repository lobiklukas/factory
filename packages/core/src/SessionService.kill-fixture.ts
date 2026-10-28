/**
 * The process `SessionService.test.ts` kills in the middle of a run (LOB-25, "a run across a
 * kill"): a real process, so the SIGKILL is a real one — no finalizer, no shutdown, no last commit.
 *
 * It builds the session service the way the API does, over `DATABASE_URL` and the session root it
 * is given, creates one session and sends it the prompt under the request id it is given. The faux
 * model's tool call counts its run into `kill.runs` in the session's worktree — the policy keeps a
 * run's writes there — and then holds until `<hold>/release` exists, so the run is genuinely in
 * flight. Once the call has started, it prints one line — `READY`, the session id, the submission id
 * and the worktree, space-separated — and waits to be killed.
 *
 * Its settings are arguments rather than environment variables: the API's environment is checked
 * against `apps/api/turbo.json` (LOB-257), and these are a test's, not the API's.
 *
 *   DATABASE_URL=… bun packages/core/src/SessionService.kill-fixture.ts <root> <hold> <prompt> <request-id>
 */
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { createFauxModelAccess } from "@repo/harness";
import { DatabaseLive } from "@repo/storage-postgres";
import { Console, Effect, FileSystem, Layer, Path } from "effect";
import { SessionService, SessionServiceLive } from "./SessionService";

const [root = "", hold = "", prompt = "", requestId = ""] =
  process.argv.slice(2);

const ServiceLive = SessionServiceLive({
  // One counted run, then a hold the kill lands in.
  model: createFauxModelAccess({
    fauxCommand: `echo run >> kill.runs; while [ ! -f ${hold}/release ]; do sleep 0.01; done`,
  }).access,
  sessionRoot: root,
}).pipe(Layer.provideMerge(Layer.mergeAll(DatabaseLive, BunServices.layer)));

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sessions = yield* SessionService;
  const created = yield* sessions.create({ title: "a run across a kill" });
  const sent = yield* sessions.send({
    sessionId: created.id,
    content: prompt,
    requestId,
  });
  const worktree = (yield* sessions.get(created.id)).workspace.path;
  while (!(yield* fs.exists(path.join(worktree, "kill.runs")))) {
    yield* Effect.sleep(20);
  }
  yield* Console.log(`READY ${created.id} ${sent.submissionId} ${worktree}`);
  return yield* Effect.never;
});

BunRuntime.runMain(program.pipe(Effect.provide(ServiceLive)));
