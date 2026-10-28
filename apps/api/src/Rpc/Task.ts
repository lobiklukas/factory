import {
  describeDefinition,
  releaseFinishedCard,
  SessionService,
  TaskService,
} from "@repo/core";
import { TasksRpc } from "@repo/domain/Rpc";
import { Effect } from "effect";
import { attributed } from "./Auth";

export const TaskRpcHandlers = TasksRpc.toLayer(
  Effect.gen(function* () {
    const tasks = yield* TaskService;
    // The role → model table is the session layer's (B6): the one `openSession` resolves a run's
    // model from, so a definition is described with the model a run in each column would get.
    const sessions = yield* SessionService;
    return TasksRpc.of({
      getBoard: (input) => tasks.getBoard(input.boardId),
      listBoards: () => tasks.listBoards,
      createBoard: (input) => tasks.createBoard(input),
      listDefinitions: () => tasks.listDefinitions,
      getDefinition: (input) =>
        tasks
          .getDefinition(input.definitionId, input.version)
          .pipe(
            Effect.map((definition) =>
              describeDefinition(definition, sessions.roleModel),
            ),
          ),
      // One read: `getBoard`'s join of the instance and its pinned version, so the two cannot disagree.
      getBoardConfig: (input) =>
        tasks.getBoard(input.boardId).pipe(
          Effect.map((view) => ({
            instance: view.instance,
            definition: describeDefinition(view.definition, sessions.roleModel),
          })),
        ),
      // Every board write is the credential's actor's, not the body's (LOB-20): a body that names a
      // run's session id or another person changes nothing, so neither can cross a human gate (B5).
      createTask: (input) =>
        attributed(input).pipe(
          Effect.flatMap((owned) => tasks.create(owned as any)),
        ),
      getTask: (input) => tasks.get(input.taskId),
      listTasks: (input) => tasks.list(input as any),
      listBoardCards: (input) => tasks.listCards(input as any),
      // A move into `done` or `canceled` finishes the card, and its runs' worktrees and branches
      // go with it (LOB-268) — after the move committed, so a teardown never refuses the move.
      moveTask: (input) =>
        attributed(input).pipe(
          Effect.flatMap((owned) => tasks.move(owned as any)),
          Effect.tap((task) =>
            releaseFinishedCard(task).pipe(
              Effect.provideService(TaskService, tasks),
              Effect.provideService(SessionService, sessions),
            ),
          ),
        ),
      blockTask: (input) =>
        attributed(input).pipe(
          Effect.flatMap((owned) => tasks.block(owned as any)),
        ),
      unblockTask: (input) =>
        attributed(input).pipe(
          Effect.flatMap((owned) => tasks.unblock(owned as any)),
        ),
      commentTask: (input) =>
        attributed(input).pipe(Effect.flatMap(tasks.comment)),
      listTaskComments: (input) => tasks.comments(input.taskId),
      getTaskSpec: (input) =>
        tasks.spec(input.taskId).pipe(Effect.map((spec) => spec ?? null)),
      listTaskRuns: (input) => tasks.listRuns(input.taskId),
      listAttention: (input) => tasks.attention(input.boardId),
    });
  }),
);
