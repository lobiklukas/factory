import {
  definitionVocabulary,
  describeDefinition,
  HARNESS_ROLES,
  releaseFinishedCard,
  SessionService,
  SkillService,
  TaskService,
  TaskStorageError,
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
    // So is the autonomy policy (C22): a column is described with what its runs may do unasked, the
    // deployment's gates and scopes narrowed by the column, as the run's policy is built.
    const deployment = {
      modelOf: sessions.roleModel,
      autonomyOf: sessions.columnAutonomy,
    };
    // An authored version's skills are held to the library a run resolves them from (D7), read
    // afresh for every define, so a skill put a moment ago is one a column may bind.
    const skills = yield* SkillService;
    const skillNames = skills.list.pipe(
      Effect.map((records) => new Set(records.map((record) => record.name))),
      Effect.mapError(
        (cause) =>
          new TaskStorageError({
            message: `read the skill library: ${cause.message}`,
          }),
      ),
    );
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
              describeDefinition(definition, deployment),
            ),
          ),
      // The rules are core's (`./boardDefine`); the library they check against is the skill table
      // and the session layer's role table, the two a run in the version's columns would resolve.
      defineBoard: (input) =>
        skillNames.pipe(
          Effect.flatMap((names) =>
            tasks.defineBoard(input, {
              skills: names,
              roles: sessions.roles,
              // The harness's roles and the deployment's own role policy rows (D10, `ROLE_POLICIES`).
              knownRoles: new Set([
                ...HARNESS_ROLES,
                ...sessions.rolePolicies.keys(),
              ]),
            }),
          ),
          Effect.map(({ outcome, definition }) => ({
            outcome,
            definition: describeDefinition(definition, deployment),
          })),
        ),
      // The editor's pickers (D6): the keys and roles the rules `defineBoard` runs accept, against the
      // same role table and the same held definitions, read afresh for every call.
      getDefinitionVocabulary: () =>
        tasks.declaredRoles.pipe(
          Effect.map((declared) =>
            definitionVocabulary({
              table: new Set([
                ...sessions.roles,
                ...sessions.rolePolicies.keys(),
              ]),
              declared,
            }),
          ),
        ),
      // One read: `getBoard`'s join of the instance and its pinned version, so the two cannot disagree.
      getBoardConfig: (input) =>
        tasks.getBoard(input.boardId).pipe(
          Effect.map((view) => ({
            instance: view.instance,
            definition: describeDefinition(view.definition, deployment),
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
      updateTask: (input) =>
        attributed(input).pipe(
          Effect.flatMap((owned) => tasks.update(owned as any)),
        ),
      commentTask: (input) =>
        attributed(input).pipe(Effect.flatMap(tasks.comment)),
      listTaskComments: (input) => tasks.comments(input.taskId),
      getTaskSpec: (input) =>
        tasks.spec(input.taskId).pipe(Effect.map((spec) => spec ?? null)),
      getTaskPlan: (input) =>
        tasks.plan(input.taskId).pipe(Effect.map((plan) => plan ?? null)),
      getTaskExit: (input) => tasks.exit(input.taskId),
      listTaskRuns: (input) => tasks.listRuns(input.taskId),
      listAttention: (input) => tasks.attention(input.boardId),
    });
  }),
);
