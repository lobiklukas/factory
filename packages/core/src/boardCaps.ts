/**
 * Board caps and WIP limits (docs/board.md B9, LOB-71): how many runs may be in flight at once on
 * one board, on one task, in one repository across every board over it, and started in one column.
 *
 * The limits are definition data, not constants: a version's `caps` (`board`, `task`, `repo`) and a
 * column's `wipLimit`, read from the version the card **pins** (B2), so a new version with other caps
 * moves the threshold for the cards on it and leaves the cards on the old one where they were. A
 * version that declares none caps nothing (default versions 1–4).
 *
 * A run is **in flight** from its start (`task_runs` row) until its session first goes idle
 * (`task_runs.finished_at`, the end LOB-44 measures), unless its card reaches `done` or `canceled`
 * or its workspace is released first — a finished card's run holds no slot even if it never ran.
 * A run opened without a prompt is in flight while it waits: it is open on the card, and a person
 * frees it by sending it its message or by finishing the card; the refusal names it so they can.
 *
 * Checked where a run starts, `SessionService.create` with a card named, inside the transaction that
 * writes the run's session and `task_runs` rows: an advisory lock on the card's repository first, so
 * two starts that would each take the last slot are serialized — every cap counts runs inside one
 * repository, so one lock covers them all — then the count, then the rows. A refusal rolls the
 * transaction back, so a refused start writes no row and opens no session. No dispatcher, lease or
 * auto-start is involved (B12's are wave 2): a person's start is the only start this refuses.
 */
import { Effect, Schema } from "effect";
import type { SqlError } from "effect/sql/SqlError";
import { SqlClient } from "effect/sql/SqlClient";
import { BoardCaps, BoardColumn, TERMINAL_COLUMNS } from "@repo/domain/Task";
import type { RunCapHit } from "./admission";

/** One run in flight in the repository, as the caps count it. */
export type InFlightRun = {
  readonly sessionId: string;
  readonly taskId: string;
  readonly boardId: string;
  readonly column: string;
};

/** The start being checked, and the caps of the definition version its card pins. */
export type RunStart = {
  readonly taskId: string;
  readonly boardId: string;
  readonly repo: string;
  /** The column the run is started in, whose WIP limit applies. */
  readonly column: string;
  readonly definitionId: string;
  readonly definitionVersion: number;
  readonly caps: BoardCaps | undefined;
  /** The run's column's WIP limit under the pinned version; absent for none, or an undeclared column. */
  readonly wipLimit: number | undefined;
};

/** Where a cap is configured, as an operator finds it: the definition version and the field. */
const sourceOf = (start: RunStart, field: string): string =>
  `definition ${start.definitionId} v${start.definitionVersion} ${field}`;

/**
 * The first cap the start would exceed, or `undefined` when it fits under every one. Narrowest
 * first — the task, then its column, then its board, then the repository — so a refusal names the
 * cap closest to the card: with 2/1/2 on one board, a second run on a card is the task's cap even
 * though the board has room, and a third on the board is the board's even though the repository is
 * full too. A cap is exceeded when as many runs as it allows are already in flight.
 */
export const firstRunCapHit = (
  start: RunStart,
  inFlight: ReadonlyArray<InFlightRun>,
): RunCapHit | undefined => {
  const onBoard = inFlight.filter((run) => run.boardId === start.boardId);
  const counted: ReadonlyArray<{
    readonly kind: RunCapHit["kind"];
    readonly limit: number | undefined;
    readonly field: string;
    readonly scope: string;
    readonly runs: ReadonlyArray<InFlightRun>;
  }> = [
    {
      kind: "task",
      limit: start.caps?.task,
      field: "caps.task",
      scope: start.taskId,
      runs: inFlight.filter((run) => run.taskId === start.taskId),
    },
    {
      kind: "column",
      limit: start.wipLimit,
      field: `columns.${start.column}.wipLimit`,
      scope: start.column,
      runs: onBoard.filter((run) => run.column === start.column),
    },
    {
      kind: "board",
      limit: start.caps?.board,
      field: "caps.board",
      scope: start.boardId,
      runs: onBoard,
    },
    {
      kind: "repo",
      limit: start.caps?.repo,
      field: "caps.repo",
      scope: start.repo,
      runs: inFlight,
    },
  ];
  for (const cap of counted) {
    if (cap.limit === undefined || cap.runs.length < cap.limit) continue;
    return {
      kind: cap.kind,
      limit: cap.limit,
      source: sourceOf(start, cap.field),
      scope: cap.scope,
      board: start.boardId,
      holders: cap.runs.map((run) => run.sessionId),
    };
  }
  return undefined;
};

/** A definition row's caps or columns that do not decode: a storage fault naming the row. */
export class BoardCapsStorageError extends Schema.TaggedError<BoardCapsStorageError>()(
  "BoardCapsStorageError",
  { message: Schema.String },
) {}

const decodeCaps = Schema.decodeEffect(Schema.fromJsonString(BoardCaps));
const decodeColumns = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Array(BoardColumn)),
);

/**
 * Check a run about to start on `taskId` in `column` against the caps its card's pinned definition
 * version declares, and answer the cap it would exceed, or `undefined` to go ahead. **Must run in the
 * transaction that writes the run's rows:** the advisory lock it takes on the card's repository is
 * held until that transaction ends, which is what keeps a concurrent start from counting before this
 * one's rows are there. A card that does not exist has no caps; the run's own write reports it.
 */
export const checkRunCaps = (
  taskId: string,
  column: string,
): Effect.Effect<
  RunCapHit | undefined,
  SqlError | BoardCapsStorageError,
  SqlClient
> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const cards = yield* sql<{
      boardId: string;
      repo: string;
      definitionId: string;
      definitionVersion: number;
      caps: string | null;
      columns: string;
    }>`
      SELECT t.board_id, bi.repo, bi.definition_id, t.definition_version,
             bd.caps::text AS caps, bd.columns::text AS columns
      FROM tasks t
      JOIN board_instances bi ON bi.id = t.board_id
      JOIN board_definitions bd
        ON bd.id = bi.definition_id AND bd.version = t.definition_version
      WHERE t.id = ${taskId}
    `;
    const card = cards[0];
    if (card === undefined) return undefined;
    // Taken whether or not this version caps anything: a start on an uncapped card is still a run
    // in flight in the repository, and a capped card's count must not miss it mid-write.
    yield* sql`SELECT pg_advisory_xact_lock(hashtext(${`task_runs:${card.repo}`}))`;
    const what = `board definition ${card.definitionId} v${card.definitionVersion}`;
    const storageFault = (field: string) => (cause: unknown) =>
      new BoardCapsStorageError({
        message: `${what} holds invalid ${field}: ${String(cause)}`,
      });
    const caps =
      card.caps === null
        ? undefined
        : yield* decodeCaps(card.caps).pipe(
            Effect.mapError(storageFault("caps")),
          );
    const columns = yield* decodeColumns(card.columns).pipe(
      Effect.mapError(storageFault("columns")),
    );
    const wipLimit = columns.find((c) => c.name === column)?.wipLimit;
    const capped =
      wipLimit !== undefined ||
      (caps !== undefined &&
        (caps.board !== undefined ||
          caps.task !== undefined ||
          caps.repo !== undefined));
    if (!capped) return undefined;
    const inFlight = yield* sql<InFlightRun>`
      SELECT tr.session_id, tr.task_id, t.board_id, tr."column"
      FROM task_runs tr
      JOIN tasks t ON t.id = tr.task_id
      JOIN board_instances bi ON bi.id = t.board_id
      JOIN sessions s ON s.id = tr.session_id
      WHERE bi.repo = ${card.repo}
        AND tr.finished_at IS NULL
        AND s.workspace_released_at IS NULL
        AND NOT (t."column" = ANY(${TERMINAL_COLUMNS}::text[]))
      ORDER BY tr.started_at, tr.session_id
    `;
    return firstRunCapHit(
      {
        taskId,
        boardId: card.boardId,
        repo: card.repo,
        column,
        definitionId: card.definitionId,
        definitionVersion: card.definitionVersion,
        caps,
        wipLimit,
      },
      inFlight,
    );
  });
