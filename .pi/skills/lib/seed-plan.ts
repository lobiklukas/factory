// Declare a card's plan, for the drives whose card has to leave `planning` (D10).
//
//   TASK_ID=tsk_… bun .pi/skills/lib/seed-plan.ts
//
// `planning`'s `plan_doc` exit requirement is met by a `planned` event on the card, which a planning
// run's `plan` tool writes in-process; no RPC posts one on a run's behalf. A drive that is about
// something else — a building run, the review gate, a triage view — and walks a card through
// `planning` needs the event and nothing more, so this is the in-process caller: the real
// `TaskService.declarePlan` on the run's `DATABASE_URL`, with a fixed plan. The drive that is about
// the plan (`verify-board/drive.sh`, `plan.ts`) has a real faux planner run declare it instead.
// `lib/seed-spec.ts` is the same for `specifying`.
//
// The card's revision moves on by one, as a real plan's does; prints one JSON line,
// {"taskId":"tsk_…","revision":N}, with the revision the card holds now.
//
// Env: DATABASE_URL (the API's database), TASK_ID, optionally PLAN_ACTOR (default a session-shaped
// id, because a plan's actor is the run that declared it).
import { Effect, Layer } from "effect";
import { TaskService, TaskServiceLive } from "@repo/core";
import { DatabaseLive } from "@repo/storage-postgres";

const TASK_ID = process.env["TASK_ID"] ?? "";
const ACTOR = process.env["PLAN_ACTOR"] ?? `ses_${"0".repeat(26)}`;

const program = Effect.gen(function* () {
  if (!TASK_ID.startsWith("tsk_")) {
    return yield* Effect.die(new Error(`TASK_ID is not a task id: ${TASK_ID}`));
  }
  const tasks = yield* TaskService;
  const card = yield* tasks.declarePlan({
    taskId: TASK_ID,
    actor: ACTOR,
    summary: "walk the card out of planning",
    steps: ["leave planning"],
    surfaces: ["web"],
    risks: [],
  });
  console.log(JSON.stringify({ taskId: card.id, revision: card.revision }));
});

await Effect.runPromise(
  program.pipe(
    Effect.provide(TaskServiceLive.pipe(Layer.provide(DatabaseLive))),
  ),
);
process.exit(0);
