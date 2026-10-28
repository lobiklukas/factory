import { describeDefinition, SessionService, TaskService } from "@repo/core";
import { TasksRpc } from "@repo/domain/Rpc";
import { Effect } from "effect";

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
      createTask: (input) => tasks.create(input as any),
      getTask: (input) => tasks.get(input.taskId),
      listTasks: (input) => tasks.list(input as any),
      moveTask: (input) => tasks.move(input as any),
      blockTask: (input) => tasks.block(input as any),
      unblockTask: (input) => tasks.unblock(input as any),
      commentTask: (input) => tasks.comment(input),
      listTaskComments: (input) => tasks.comments(input.taskId),
      getTaskSpec: (input) =>
        tasks.spec(input.taskId).pipe(Effect.map((spec) => spec ?? null)),
      listTaskRuns: (input) => tasks.listRuns(input.taskId),
      listAttention: (input) => tasks.attention(input.boardId),
    });
  }),
);
