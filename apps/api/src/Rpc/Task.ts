import { releaseFinishedCard, SessionService, TaskService } from "@repo/core";
import { TasksRpc } from "@repo/domain/Rpc";
import { Effect } from "effect";

export const TaskRpcHandlers = TasksRpc.toLayer(
  Effect.gen(function* () {
    const tasks = yield* TaskService;
    const sessions = yield* SessionService;
    return TasksRpc.of({
      getBoard: (input) => tasks.getBoard(input.boardId),
      listBoards: () => tasks.listBoards,
      createBoard: (input) => tasks.createBoard(input),
      createTask: (input) => tasks.create(input as any),
      getTask: (input) => tasks.get(input.taskId),
      listTasks: (input) => tasks.list(input as any),
      // A move into `done` or `canceled` finishes the card, and its runs' worktrees and branches
      // go with it (LOB-268) — after the move committed, so a teardown never refuses the move.
      moveTask: (input) =>
        tasks
          .move(input as any)
          .pipe(
            Effect.tap((task) =>
              releaseFinishedCard(task).pipe(
                Effect.provideService(TaskService, tasks),
                Effect.provideService(SessionService, sessions),
              ),
            ),
          ),
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
