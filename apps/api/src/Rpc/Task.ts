import { TaskService } from "@repo/core";
import { TasksRpc } from "@repo/domain/Rpc";
import { Effect } from "effect";

export const TaskRpcHandlers = TasksRpc.toLayer(
  Effect.gen(function* () {
    const tasks = yield* TaskService;
    return TasksRpc.of({
      getBoard: (input) => tasks.getBoard(input.boardId),
      listBoards: () => tasks.listBoards,
      createBoard: (input) => tasks.createBoard(input),
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
