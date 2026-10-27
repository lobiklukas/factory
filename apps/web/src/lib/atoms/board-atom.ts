import type {
  BoardInstanceId,
  CommentTaskInput,
  MoveTaskInput,
  Task,
  TaskId,
} from "@repo/domain/Task";
import type { DecideApprovalInput } from "@repo/domain/Approval";
import type { SessionId } from "@repo/domain/Session";
import { Duration, Effect } from "effect";
import { Atom } from "effect/reactivity";
import { runtime } from "../atom";
import { RpcClient } from "../rpc-client";
import { DASHBOARD_ACTOR } from "../approvals-view";
import { SESSIONS_KEY } from "./session-list";

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

/**
 * The boards this control plane holds (LOB-75), newest first: what `/boards` offers to open.
 *
 * A server read and nothing else. There is no local copy to fall back on, so a reload always shows
 * what the server has — which is the whole point of the route.
 */
export const boardsAtom = runtime.atom(
  Effect.gen(function* () {
    const rpc = yield* RpcClient;
    return yield* rpc.client.listBoards({});
  }),
);

/**
 * One board as the lanes need it: the instance with the definition version it binds, and its cards.
 *
 * Two calls, issued together. `getBoard` answers the definition in one statement, so the lane order
 * is the pinned version's (B2); `listTasks` answers every card on the board in the server's order
 * (B9). A failure of either fails the read, rather than showing lanes with no cards — an empty lane
 * and a lane whose cards failed to load must not look the same.
 *
 * Re-read every `BOARD_POLL` while the board is open, and at once when a move from this page lands
 * (`BOARD_KEY`), so the lanes follow the server rather than this page's last answer (LOB-76).
 */
export const boardAtom = Atom.family((boardId: BoardInstanceId) =>
  runtime
    .atom(
      Effect.gen(function* () {
        const rpc = yield* RpcClient;
        const [view, tasks] = yield* Effect.all(
          [rpc.client.getBoard({ boardId }), rpc.client.listTasks({ boardId })],
          { concurrency: 2 },
        );
        return { ...view, tasks };
      }),
    )
    .pipe(Atom.withReactivity([BOARD_KEY]), Atom.withRefresh(BOARD_POLL)),
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
 * Starts a run against a card: `createSession` with the card named, exactly as `factory board
 * start` does (LOB-61), so a run is one Pi Durable session (B1) and its row lands in `task_runs`.
 *
 * The run starts from the card's own column, which is the column whose `requires[]` it must satisfy
 * on exit. The card is not moved: the lane a run works in is where the card already sits.
 */
export const startRunAtom = runtime.fn(
  (task: Task) =>
    Effect.gen(function* () {
      const rpc = yield* RpcClient;
      return yield* rpc.client.createSession({
        title: task.title,
        taskId: task.id,
        taskColumn: task.column,
        // The run's spend is the dashboard's, as `factory board start`'s is `cli`'s (LOB-162).
        actor: DASHBOARD_ACTOR,
        ...(task.repo === undefined ? {} : { repo: task.repo }),
      });
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
