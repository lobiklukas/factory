// Declare a card's spec, for the drives whose card has to leave `specifying` (D9).
//
//   TASK_ID=tsk_… bun .pi/skills/lib/seed-spec.ts
//
// `specifying`'s `spec_doc` exit requirement is met by a `specified` event on the card, which a
// specifying run's `spec` tool writes in-process (LOB-238); no RPC posts one on a run's behalf. A
// drive that is about something else — the actor attribution of a move, the card pane's move button,
// a triage view — and walks a card through `specifying` needs the event and nothing more, so this
// is the in-process caller: the real `TaskService.declareSpec` on the run's `DATABASE_URL`, with a
// fixed spec whose gaps are closed. The drives that are about the spec (`verify-board/drive.sh`,
// `spec.ts`) have a real faux run declare it instead.
//
// The card's revision moves on by one, as a real spec's does; prints one JSON line,
// {"taskId":"tsk_…","revision":N}, with the revision the card holds now.
//
// Env: DATABASE_URL (the API's database), TASK_ID, optionally SPEC_ACTOR (default a session-shaped
// id, because a spec's actor is the run that declared it).
import { Effect, Layer } from "effect";
import { TaskService, TaskServiceLive } from "@repo/core";
import { DatabaseLive } from "@repo/storage-postgres";

const TASK_ID = process.env["TASK_ID"] ?? "";
const ACTOR = process.env["SPEC_ACTOR"] ?? `ses_${"0".repeat(26)}`;

const program = Effect.gen(function* () {
  if (!TASK_ID.startsWith("tsk_")) {
    return yield* Effect.die(new Error(`TASK_ID is not a task id: ${TASK_ID}`));
  }
  const tasks = yield* TaskService;
  const card = yield* tasks.declareSpec({
    taskId: TASK_ID,
    actor: ACTOR,
    goal: "walk the card out of specifying",
    acceptance: ["the card leaves specifying"],
    gaps: [],
    openQuestions: [],
  });
  console.log(JSON.stringify({ taskId: card.id, revision: card.revision }));
});

await Effect.runPromise(
  program.pipe(
    Effect.provide(TaskServiceLive.pipe(Layer.provide(DatabaseLive))),
  ),
);
process.exit(0);
