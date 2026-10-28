import {
  definitionVocabulary,
  describeDefinition,
  PullRequestStates,
  refreshCardPullRequest,
  HARNESS_ROLES,
  releaseFinishedCard,
  SessionService,
  SkillService,
  TaskService,
  TaskStorageError,
} from "@repo/core";
import { TasksRpc } from "@repo/domain/Rpc";
import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
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
    // The card's PR read from the forge when the card is opened (C20): how a box GitHub delivers no
    // webhooks to learns its card's PR merged or closed.
    const states = yield* PullRequestStates;
    const sql = yield* SqlClient;
    // A move asks GitHub afresh: the person has just merged, and the pane's kept answer is older.
    const refresh = (taskId: string, settle: boolean) =>
      refreshCardPullRequest(taskId, { settle, fresh: !settle }).pipe(
        Effect.provideService(TaskService, tasks),
        Effect.provideService(SessionService, sessions),
        Effect.provideService(PullRequestStates, states),
        Effect.provideService(SqlClient, sql),
      );
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
      // The repinned events are the credential's actor's (LOB-20), as every other board write's.
      upgradeBoard: (input) =>
        attributed(input).pipe(Effect.flatMap(tasks.upgradeBoard)),
      // The editor's pickers (D6): the keys and roles the rules `defineBoard` runs accept, against the
      // same role table and the same held definitions, read afresh for every call. The table is
      // `ROLE_MODELS` alone, as the rules read it, so its emptiness is whether any role is accepted (F4);
      // the role policy rows are roles the harness knows, like the declared ones.
      getDefinitionVocabulary: () =>
        tasks.declaredRoles.pipe(
          Effect.map((declared) =>
            definitionVocabulary({
              table: sessions.roles,
              declared: new Set([...declared, ...sessions.rolePolicies.keys()]),
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
      // A move into `done` reads the card's PR first (C20), so a merge GitHub could not deliver is on
      // record for `human_merge`; the read records it and leaves the card for this move to make.
      moveTask: (input) =>
        (input.to === "done" ? refresh(input.taskId, false) : Effect.void).pipe(
          Effect.andThen(attributed(input)),
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
      getTaskHandoff: (input) =>
        tasks
          .handoff(input.taskId)
          .pipe(Effect.map((handoff) => handoff ?? null)),
      // Opening the card reads its PR (C20): a merge moves it to done and a close blocks it, as the
      // webhook would, and the checklist is judged on the card that read leaves.
      getTaskExit: (input) =>
        refresh(input.taskId, true).pipe(
          Effect.andThen(tasks.exit(input.taskId)),
        ),
      listTaskRuns: (input) => tasks.listRuns(input.taskId),
      listAttention: (input) => tasks.attention(input.boardId),
    });
  }),
);
