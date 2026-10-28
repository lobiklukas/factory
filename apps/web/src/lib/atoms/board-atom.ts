import { DefinitionId } from "@repo/domain/Task";
import type {
  BoardDefinition,
  BoardInstanceId,
  BlockTaskInput,
  CommentTaskInput,
  CreateBoardInput,
  CreateTaskInput,
  MoveTaskInput,
  Task,
  TaskId,
  UnblockTaskInput,
  UpdateTaskInput,
  UpgradeBoardInput,
} from "@repo/domain/Task";
import type { DecideApprovalInput } from "@repo/domain/Approval";
import type { SessionId } from "@repo/domain/Session";
import { Cause, Duration, Effect, Option, Schema } from "effect";
import { Atom } from "effect/reactivity";
import { runtime } from "../atom";
import { definitionOfConfig } from "../board-view";
import { RpcClient } from "../rpc-client";
import { startRunSession } from "../run-start-view";
import { SESSIONS_KEY, sessionListAtom } from "./session-list";

/** The reactivity key a move invalidates: every board read re-runs once a move lands. */
export const BOARD_KEY = "board";

/** The reactivity key a run start invalidates: the card pane's run list re-reads. */
export const RUNS_KEY = "task-runs";

/** The reactivity key a comment invalidates: the card pane's thread re-reads (LOB-239). */
export const THREAD_KEY = "task-thread";

/** The reactivity key an approval decision invalidates. */
export const APPROVALS_KEY = "approvals";

/**
 * How often an open board re-reads the server (LOB-76): a move made anywhere else — `factory board
 * move`, another browser, a run — reaches this page within one interval, without a reload.
 *
 * A poll rather than a push on purpose. Cards are rows, not a log (docs/board.md B3), so there is no
 * commit stream to follow the way a session's transcript does, and a change feed over `tasks`
 * (`LISTEN`/`NOTIFY`, or a `task_events` cursor) is a server mechanism this read does not need yet:
 * a board is two small reads, and a refresh keeps the last answer on screen while the next one is in
 * flight, so a person never sees the lanes blink.
 */
export const BOARD_POLL = Duration.seconds(2);

/** How often an open card pane re-reads what its column needs (`taskExitAtom`): the read is heavier than the board's. */
export const EXIT_POLL = Duration.seconds(10);

/**
 * The boards this control plane holds (LOB-75), newest first: what `/boards` offers to open.
 *
 * A server read and nothing else. There is no local copy to fall back on, so a reload always shows
 * what the server has — which is the whole point of the route.
 */
export const boardsAtom = runtime
  .atom(
    Effect.gen(function* () {
      const rpc = yield* RpcClient;
      return yield* rpc.client.listBoards({});
    }),
  )
  .pipe(Atom.withReactivity([BOARD_KEY]));

/**
 * One board as the lanes need it: the instance with the definition version it binds, and its cards.
 *
 * Two calls, issued together. `getBoard` answers the definition in one statement, so the lane order
 * is the pinned version's (B2); `listBoardCards` answers every card on the board in the server's
 * order (B9), each with its runs' newest status, PR link and summed spend (C10) — one read for the
 * whole board, so a card face never costs a call of its own. A failure of either fails the read, rather than showing lanes with no cards — an empty lane
 * and a lane whose cards failed to load must not look the same.
 *
 * A card's moves are its pinned definition version's (B2, LOB-267). Every card made on a board pins
 * the board's version, so this is normally the two calls and nothing else; a card that pinned another
 * version has that version read too (`getDefinition`), once per version, into `pinned`. A version
 * read that fails is left out of `pinned` and does not fail the board: that card's pane offers no
 * move until a later poll reads it.
 *
 * Re-read every `BOARD_POLL` while the board is open, and at once when a move from this page lands
 * (`BOARD_KEY`), so the lanes follow the server rather than this page's last answer (LOB-76).
 */
export const boardAtom = Atom.family((boardId: BoardInstanceId) =>
  runtime
    .atom(
      Effect.gen(function* () {
        const rpc = yield* RpcClient;
        const [view, cards] = yield* Effect.all(
          [
            rpc.client.getBoard({ boardId }),
            rpc.client.listBoardCards({ boardId }),
          ],
          { concurrency: 2 },
        );
        const tasks = cards.map((card) => card.task);
        const others = [
          ...new Set(
            tasks
              .map((task) => task.definitionVersion)
              .filter((version) => version !== view.definition.version),
          ),
        ];
        // A version that fails to read is left out rather than failing the board: its cards still
        // show in their lanes, and the pane says their definition was not read and offers no move,
        // rather than another version's (`definitionFor`). The next poll reads it again.
        const read = yield* Effect.forEach(
          others,
          (version) =>
            rpc.client
              .getDefinition({
                definitionId: view.instance.definitionId,
                version,
              })
              .pipe(
                Effect.map(
                  (config) => [version, definitionOfConfig(config)] as const,
                ),
                Effect.option,
              ),
          { concurrency: 4 },
        );
        const pinned: ReadonlyMap<number, BoardDefinition> = new Map(
          read.flatMap((entry) => (Option.isSome(entry) ? [entry.value] : [])),
        );
        return { ...view, tasks, cards, pinned };
      }),
    )
    .pipe(Atom.withReactivity([BOARD_KEY]), Atom.withRefresh(BOARD_POLL)),
);

/**
 * Puts a card on a board from the "New card" form (LOB-275): `createTask`, as `factory board add`
 * (LOB-261) and a trigger call it, so the card opens in the board's initial column on the board's
 * repository (LOB-255, LOB-267). The answer is the server's card or its typed refusal; the lanes show
 * the card when the board read that `BOARD_KEY` re-runs says it is there, not from this answer.
 */
export const createTaskAtom = runtime.fn(
  (input: CreateTaskInput) =>
    Effect.gen(function* () {
      const rpc = yield* RpcClient;
      return yield* rpc.client.createTask(input);
    }),
  { reactivityKeys: [BOARD_KEY] },
);

/**
 * Moves a card along a declared transition, at the revision the pane rendered (LOB-76).
 *
 * The expected revision is the one on screen, never a fresh read: a stale view is exactly the case
 * the revision exists to refuse (B3), and reading first would turn "someone moved it while you
 * looked" into a silent overwrite. The answer is the server's card or its typed refusal; the pane
 * renders either, and does not move the card itself.
 */
export const moveTaskAtom = runtime.fn(
  (input: MoveTaskInput) =>
    Effect.gen(function* () {
      const rpc = yield* RpcClient;
      return yield* rpc.client.moveTask(input);
    }),
  { reactivityKeys: [BOARD_KEY] },
);

/**
 * The card pane's state writes (C11), each at the revision the pane rendered, as a move is (LOB-76):
 * block a card, lift its block, and fix its title or priority. The answer is the server's card or its
 * typed refusal; the lanes show the change when the board read that `BOARD_KEY` re-runs says so.
 */
export const blockTaskAtom = runtime.fn(
  (input: BlockTaskInput) =>
    Effect.gen(function* () {
      const rpc = yield* RpcClient;
      return yield* rpc.client.blockTask(input);
    }),
  { reactivityKeys: [BOARD_KEY] },
);

export const unblockTaskAtom = runtime.fn(
  (input: UnblockTaskInput) =>
    Effect.gen(function* () {
      const rpc = yield* RpcClient;
      return yield* rpc.client.unblockTask(input);
    }),
  { reactivityKeys: [BOARD_KEY] },
);

export const updateTaskAtom = runtime.fn(
  (input: UpdateTaskInput) =>
    Effect.gen(function* () {
      const rpc = yield* RpcClient;
      return yield* rpc.client.updateTask(input);
    }),
  { reactivityKeys: [BOARD_KEY] },
);

/**
 * A card's runs, newest first (LOB-76): the sessions started against it, from `task_runs`.
 *
 * Polled with the board, because a run can be started from the CLI (`factory board start`) as well
 * as from this pane, and the pane should list it either way.
 */
export const taskRunsAtom = Atom.family((taskId: TaskId) =>
  runtime
    .atom(
      Effect.gen(function* () {
        const rpc = yield* RpcClient;
        return yield* rpc.client.listTaskRuns({ taskId });
      }),
    )
    .pipe(Atom.withReactivity([RUNS_KEY]), Atom.withRefresh(BOARD_POLL)),
);

/**
 * The sessions a card's run rows read their state from (C7): repo, status and PR link, out of the
 * activity index (`listSessions`), which costs one query however many runs the card has.
 *
 * Polled with the board, because whether a run is idle and has a PR is what offers its row the
 * "Open pull request" control, and a run that settles under another browser's or the CLI's hand
 * should offer it within one interval. It is deliberately not `getSession` per row: that folds the
 * log and counts as activity, and a card with a dozen runs would keep them all warm. A run older
 * than the newest page the index returns has no entry here and its row offers nothing; the run
 * open in the pane has its own control in the session header, which reads the live stream.
 */
export const runSessionsAtom = sessionListAtom.pipe(
  Atom.withRefresh(BOARD_POLL),
);

/**
 * A card's spec (LOB-238): what its newest specifying run declared with the `spec` tool, or `null`.
 *
 * Polled with the board, like the runs: the run that declares it is not this pane's doing, so the
 * pane learns of it from the server, within one interval.
 */
export const taskSpecAtom = Atom.family((taskId: TaskId) =>
  runtime
    .atom(
      Effect.gen(function* () {
        const rpc = yield* RpcClient;
        return yield* rpc.client.getTaskSpec({ taskId });
      }),
    )
    .pipe(Atom.withRefresh(BOARD_POLL)),
);

/**
 * What a card needs to leave its column (D9): `getTaskExit`, each of the column's requirements met,
 * unmet with the reason a move would be refused with, or not checked.
 *
 * Re-read at once when a move or a run start from this page lands (`BOARD_KEY`, `RUNS_KEY`), and
 * polled on a slower interval than the board (`EXIT_POLL`): what a requirement reads — a run's log, a
 * spec a run declared — changes under the CLI's and the runs' hands, but each read folds every run's
 * log and, in a column that gates on `non_empty_diff`, measures the branch with git, which the board's
 * two seconds would repeat for as long as the pane stays open.
 */
export const taskExitAtom = Atom.family((taskId: TaskId) =>
  runtime
    .atom(
      Effect.gen(function* () {
        const rpc = yield* RpcClient;
        return yield* rpc.client.getTaskExit({ taskId });
      }),
    )
    .pipe(
      Atom.withReactivity([BOARD_KEY, RUNS_KEY]),
      Atom.withRefresh(EXIT_POLL),
    ),
);

/**
 * Starts a run against a card and sends it its first message (C6): `createSession` with the card
 * named, exactly as `factory board start` does (LOB-61), so a run is one Pi Durable session (B1) and
 * its row lands in `task_runs`; then `sendMessage` with the prompt the person sent from the field
 * (`startPrompt` opens it with the card's default), so the run starts working, not idle.
 *
 * The run starts from the card's own column, which is the column whose `requires[]` it must satisfy
 * on exit. The card is not moved: the lane a run works in is where the card already sits.
 *
 * A first message that is refused does not undo the run: the session is open and bound to the card,
 * so the answer carries the session and the refusal's words (`sendFailure`), and the pane opens the
 * run and says so, leaving the person to type into it. Only a failed `createSession` fails the atom.
 */
export const startRunAtom = runtime.fn(
  (input: { readonly task: Task; readonly prompt: string }) =>
    Effect.gen(function* () {
      const rpc = yield* RpcClient;
      const session = yield* rpc.client.createSession(
        startRunSession(input.task),
      );
      const sendFailure = yield* rpc.client
        .sendMessage({ sessionId: session.id, content: input.prompt })
        .pipe(
          Effect.as(undefined),
          Effect.catchCause((cause) => Effect.succeed(Cause.pretty(cause))),
        );
      return { session, sendFailure };
    }),
  { reactivityKeys: [RUNS_KEY, SESSIONS_KEY] },
);

/**
 * A card's thread, oldest first (LOB-239): `listTaskComments`, every comment verbatim with the kind
 * the server recorded when it was written (B7).
 *
 * Polled with the board, because most of a thread is written off this page — a run's question is
 * its `ask` tool's, in-process, and an answer can come from `factory board comment` — and the pane
 * has to show the question a parked run asked without a reload.
 */
export const taskCommentsAtom = Atom.family((taskId: TaskId) =>
  runtime
    .atom(
      Effect.gen(function* () {
        const rpc = yield* RpcClient;
        return yield* rpc.client.listTaskComments({ taskId });
      }),
    )
    .pipe(Atom.withReactivity([THREAD_KEY]), Atom.withRefresh(BOARD_POLL)),
);

/**
 * Adds to a card's thread at the revision the pane rendered (LOB-239), exactly as `factory board
 * comment` does. On a card blocked `needs_input` the server makes it the answer and lifts the block
 * in the same transaction, so the board (and the attention view, `BOARD_KEY`) re-reads with the
 * thread once it lands.
 *
 * The revision is the one on screen, for the reason a move's is: an answer typed against a card
 * someone else already answered must be refused as stale, not appended as though it were the answer.
 */
export const commentTaskAtom = runtime.fn(
  (input: CommentTaskInput) =>
    Effect.gen(function* () {
      const rpc = yield* RpcClient;
      return yield* rpc.client.commentTask(input);
    }),
  { reactivityKeys: [THREAD_KEY, BOARD_KEY] },
);

/** The approvals a run is waiting on, oldest first: the card pane's approvals pane (LOB-76). */
export const approvalsAtom = Atom.family((sessionId: SessionId) =>
  runtime
    .atom(
      Effect.gen(function* () {
        const rpc = yield* RpcClient;
        return yield* rpc.client.listApprovals({ sessionId });
      }),
    )
    .pipe(Atom.withReactivity([APPROVALS_KEY]), Atom.withRefresh(BOARD_POLL)),
);

/**
 * Every session's pending approvals, newest first, with the total pending (LOB-53): the `/approvals` pane, the operator's
 * inbox. Polled like a board, and re-read at once when a decision from this page lands.
 */
export const pendingApprovalsAtom = runtime
  .atom(
    Effect.gen(function* () {
      const rpc = yield* RpcClient;
      return yield* rpc.client.listPendingApprovals({});
    }),
  )
  .pipe(Atom.withReactivity([APPROVALS_KEY]), Atom.withRefresh(BOARD_POLL));

/**
 * Settles one pending approval; every pending list re-reads once the decision is committed. The
 * dashboard's decisions resume their session (`decisionFor`), so the run a person answered wakes.
 */
export const decideApprovalAtom = runtime.fn(
  (input: DecideApprovalInput) =>
    Effect.gen(function* () {
      const rpc = yield* RpcClient;
      return yield* rpc.client.decideApproval(input);
    }),
  { reactivityKeys: [APPROVALS_KEY] },
);

/** The reactivity key a saved definition version invalidates (D6): the definition list re-reads. */
export const DEFINITIONS_KEY = "definitions";

/**
 * Which definitions exist and the versions each holds (LOB-270): what the "New board" form's
 * pickers offer, and how the settings page (LOB-245) knows a version newer than a board's pin exists.
 * Read once per opening of the form or the page, and again when the editor saves a version here
 * (`DEFINITIONS_KEY`, D6) — a version written elsewhere (`factory board define`) is rare enough that a
 * poll would mostly re-ask a fixed answer.
 */
export const definitionsAtom = runtime
  .atom(
    Effect.gen(function* () {
      const rpc = yield* RpcClient;
      return yield* rpc.client.listDefinitions({});
    }),
  )
  .pipe(Atom.withReactivity([DEFINITIONS_KEY]));

/** The reactivity key an upgrade invalidates (D5): the board's configuration re-reads its new pin. */
export const BOARD_PIN_KEY = "board-pin";

/**
 * A board's configuration (LOB-245): `getBoardConfig`, the instance with the definition version it pins
 * described exactly as `getDefinition` describes that version — each column's kind, role and the
 * model it resolves to, skills, requirements marked checked or not, exits and human gates. What the
 * settings page and a lane header's disclosure render, and nothing else.
 *
 * Read once per opening, not polled: a version is never edited in place (B2), and a board's pin
 * moves only by an upgrade (D5), which re-reads it here (`BOARD_PIN_KEY`) — one made elsewhere is
 * rare enough that a poll would mostly re-ask a fixed answer. One read rather than `getBoard` and
 * then `getDefinition`, so the version described is the one the instance pins, never a later one.
 */
export const boardConfigAtom = Atom.family((boardId: BoardInstanceId) =>
  runtime
    .atom(
      Effect.gen(function* () {
        const rpc = yield* RpcClient;
        return yield* rpc.client.getBoardConfig({ boardId });
      }),
    )
    .pipe(Atom.withReactivity([BOARD_PIN_KEY])),
);

/**
 * One version of a definition described (D5), keyed `<id>@<version>`: the columns the Upgrade
 * action maps a board's cards onto. Read once per version the form names.
 */
export const definitionVersionAtom = Atom.family((key: string) =>
  runtime.atom(
    Effect.gen(function* () {
      const at = key.lastIndexOf("@");
      const definitionId = yield* Schema.decodeEffect(DefinitionId)(
        key.slice(0, at),
      );
      const rpc = yield* RpcClient;
      return yield* rpc.client.getDefinition({
        definitionId,
        version: Number(key.slice(at + 1)),
      });
    }),
  ),
);

/**
 * Moves a board to a newer definition version from the settings page (D5): `upgradeBoard`, exactly
 * as `factory board upgrade` calls it, at the version the page read the board at, with a mapping only
 * when the person chose to migrate the cards. The settings page re-reads its pin and the board its
 * cards once it lands; a refusal (`StaleBoardVersion`, `CardMigrationRefused`) is the page's to show.
 */
export const upgradeBoardAtom = runtime.fn(
  (input: UpgradeBoardInput) =>
    Effect.gen(function* () {
      const rpc = yield* RpcClient;
      return yield* rpc.client.upgradeBoard(input);
    }),
  { reactivityKeys: [BOARD_KEY, BOARD_PIN_KEY] },
);

/**
 * Makes a board from the "New board" form (C5): `createBoard`, exactly as `factory board create`
 * calls it, so a repository gets one board, pinned to the version the server resolves (B2). The
 * answer is the server's board or its typed refusal (`BoardExists`, `DefinitionNotFound`); `/boards`
 * shows the board when the list read that `BOARD_KEY` re-runs says it is there.
 */
export const createBoardAtom = runtime.fn(
  (input: CreateBoardInput) =>
    Effect.gen(function* () {
      const rpc = yield* RpcClient;
      return yield* rpc.client.createBoard(input);
    }),
  { reactivityKeys: [BOARD_KEY] },
);
