import { Console, Effect, Option, Path, Schema } from "effect";
import { Command, Flag } from "effect/cli";
import { RepoSlug, SessionActor } from "@repo/domain/Session";
import { BoardInstanceId } from "@repo/domain/Task";
import type { CreateTaskInput, Task } from "@repo/domain/Task";
import { resolveApiUrl } from "../api";
import { reportFailures } from "../errors";
import {
  type CollectedHandoff,
  collectHandoff,
  HandoffRefused,
  handoffCardText,
} from "../handoff";
import { BoardClient } from "../rpc";
import { startCard, type StartClient } from "./board";

/**
 * `factory handoff` — hand a local agent's work in progress to a factory session
 * (S-local-agent-handoff-mcp).
 *
 * docs/parallel-work.md draws the line where local agent work should stop and a factory session
 * should start; this is the step across it. The checkout's work — local commits, edits, untracked
 * files — becomes one patch (`../handoff`), the patch a new card on the repository's board, and the
 * card's run starts on a fresh `factory/<session-id>` branch at the base with that patch committed
 * on it before its agent's first turn (`@repo/core`'s `./handoff`). `--start` opens that run at once.
 *
 * The patch cap (`MAX_HANDOFF_PATCH_BYTES`) is checked before anything is sent: an oversized diff is
 * refused with its size and the cap named, and no card is made. Nothing local changes either way —
 * not the index, not the branch, not the files. `--dry-run` prints the files the patch would carry
 * and sends nothing, and `--tracked-only` leaves untracked files out of it; the server refuses a
 * patch that adds a credential-shaped line before it stores anything (`@repo/core`'s `handoffOf`).
 */

/** What a handoff needs of the client: the boards, a card, and — for `--start` — a run on it. */
export interface HandoffClient<B, S> extends StartClient<B, S> {
  readonly listBoards: (input: {}) => Effect.Effect<
    ReadonlyArray<{ readonly id: BoardInstanceId; readonly repo: RepoSlug }>,
    B
  >;
  readonly createTask: (input: CreateTaskInput) => Effect.Effect<Task, B>;
}

/**
 * The board a card on `repo` goes on: the one named, or the repository's own (B2: one board per
 * repository). None is a refusal that names the command that makes one.
 */
export const boardFor = <B, S>(
  client: Pick<HandoffClient<B, S>, "listBoards">,
  repo: RepoSlug,
  board: string | undefined,
): Effect.Effect<BoardInstanceId, B | HandoffRefused> =>
  Effect.gen(function* () {
    if (board !== undefined) {
      const decoded = Schema.decodeOption(BoardInstanceId)(board);
      if (Option.isNone(decoded)) {
        return yield* new HandoffRefused({
          message: `--board "${board}" is not a board id (brd_…)`,
        });
      }
      return decoded.value;
    }
    const boards = yield* client.listBoards({});
    const found = boards.find((candidate) => candidate.repo === repo);
    if (found === undefined) {
      return yield* new HandoffRefused({
        message: `no board is over ${repo}: make one with \`factory board create --repo ${repo}\`, or name one with --board`,
      });
    }
    return found.id;
  });

/** The repository a handoff's card is on: the one named, else the one the checkout's remote names. */
export const handoffRepo = (
  named: string | undefined,
  collected: CollectedHandoff,
): Effect.Effect<RepoSlug, HandoffRefused> =>
  Effect.gen(function* () {
    if (named !== undefined) {
      const decoded = Schema.decodeOption(RepoSlug)(named);
      if (Option.isNone(decoded)) {
        return yield* new HandoffRefused({
          message: `--repo "${named}" is not a repository (owner/name)`,
        });
      }
      return decoded.value;
    }
    if (collected.repo === undefined) {
      return yield* new HandoffRefused({
        message:
          "the checkout's remote names no owner/name repository: name the one the factory knows it by with --repo",
      });
    }
    return collected.repo;
  });

/**
 * Make the handed-off card from what `collectHandoff` read, and start its run when `start` says so.
 * Each line goes to `emit` as soon as it is known: the card's id is what a later `board start` or
 * `board show` needs, so a start the server refuses must not take it with it.
 */
export const handOff = Effect.fnUntraced(function* <B, S>(
  client: HandoffClient<B, S>,
  input: {
    readonly collected: CollectedHandoff;
    readonly repo: RepoSlug;
    readonly board: string | undefined;
    readonly note: string | undefined;
    readonly title: string | undefined;
    readonly actor: string;
    /** Open the card's run at once, in `column` (the card's own when absent), attributed to `actor`. */
    readonly start?:
      | { readonly column: string | undefined; readonly actor: string }
      | undefined;
  },
  emit: (line: string) => Effect.Effect<void>,
) {
  const { collected } = input;
  const boardId = yield* boardFor(client, input.repo, input.board);
  const { title, body } = handoffCardText({
    collected,
    note: input.note,
    title: input.title,
  });
  const card = yield* client.createTask({
    boardId,
    title,
    repo: input.repo,
    body,
    baseRef: collected.baseRef,
    handoff: collected.handoff,
    actor: input.actor,
  });
  yield* emit(
    `task    ${card.id} revision ${card.revision} column ${card.column}`,
  );
  yield* emit(
    `handoff ${collected.files.length} file${collected.files.length === 1 ? "" : "s"}, ${collected.bytes} bytes from ${collected.handoff.branch ?? "a detached HEAD"} at ${(collected.handoff.baseCommit ?? "").slice(0, 12)} onto ${collected.baseRef}`,
  );
  if (input.start === undefined) {
    yield* emit(
      `next    factory board start --task ${card.id}  (its run starts with this work committed on factory/<session-id>)`,
    );
    return { card, sessionId: undefined };
  }
  const sessionId = yield* startCard(
    client,
    {
      taskId: card.id,
      column: input.start.column,
      prompt: undefined,
      idle: false,
      actor: input.start.actor,
    },
    emit,
  );
  return { card, sessionId };
});

/**
 * What `--dry-run` prints: what the patch would carry, file by file, and where — the list an
 * operator checks for a file that should not leave the machine before anything is sent.
 */
export const handoffPreview = (
  collected: CollectedHandoff,
  repo: RepoSlug,
): ReadonlyArray<string> => [
  `dry-run ${collected.files.length} file${collected.files.length === 1 ? "" : "s"}, ${collected.bytes} bytes from ${collected.handoff.branch ?? "a detached HEAD"} at ${(collected.handoff.baseCommit ?? "").slice(0, 12)} onto ${repo} ${collected.baseRef}; nothing was sent`,
  ...collected.files.map((file) => `file    ${file}`),
];

export const handoffCommand = Command.make(
  "handoff",
  {
    repo: Flag.String("repo").pipe(
      Flag.withDescription(
        "The repository the card is on, owner/name (defaults to the one the checkout's remote names)",
      ),
      Flag.optional,
    ),
    note: Flag.String("note").pipe(
      Flag.withDescription(
        "What the factory session should do with the work: the card's body, its first line the title",
      ),
      Flag.optional,
    ),
    title: Flag.String("title").pipe(
      Flag.withDescription(
        "The card's title (defaults to the note's first line)",
      ),
      Flag.optional,
    ),
    board: Flag.String("board").pipe(
      Flag.withDescription(
        "Board instance id (brd_…); defaults to the repository's board",
      ),
      Flag.optional,
    ),
    base: Flag.String("base").pipe(
      Flag.withDescription(
        "The branch the run starts from and the patch is taken against (defaults to the remote's default branch)",
      ),
      Flag.optional,
    ),
    dir: Flag.String("dir").pipe(
      Flag.withDescription("A directory inside the checkout to hand off"),
      Flag.withDefault("."),
    ),
    trackedOnly: Flag.Boolean("tracked-only").pipe(
      Flag.withDescription(
        "Leave untracked files out of the patch: only changes to files the checkout tracks travel",
      ),
      Flag.withDefault(false),
    ),
    dryRun: Flag.Boolean("dry-run").pipe(
      Flag.withDescription(
        "Print the files and bytes the patch would carry, and send nothing",
      ),
      Flag.withDefault(false),
    ),
    start: Flag.Boolean("start").pipe(
      Flag.withDescription(
        "Start the card's run now, sent the card's default prompt",
      ),
      Flag.withDefault(false),
    ),
    column: Flag.String("column").pipe(
      Flag.withDescription(
        "With --start: the column the run starts in (defaults to the card's)",
      ),
      Flag.optional,
    ),
    actor: Flag.String("actor").pipe(
      Flag.withDescription(
        "Who makes the card and its run; ignored by a control plane that authenticates (FACTORY_API_TOKEN)",
      ),
      Flag.withSchema(SessionActor),
      Flag.withDefault("cli"),
    ),
    api: Flag.String("api").pipe(
      Flag.withDescription("Control plane base URL"),
      Flag.optional,
    ),
  },
  Effect.fnUntraced(function* ({
    repo,
    note,
    title,
    board,
    base,
    dir,
    trackedOnly,
    dryRun,
    start,
    column,
    actor,
    api,
  }) {
    const apiUrl = yield* resolveApiUrl(api);
    const path = yield* Path.Path;
    const program = Effect.gen(function* () {
      if (!start && Option.isSome(column)) {
        return yield* new HandoffRefused({
          message: "--column names where --start opens the run: add --start",
        });
      }
      // Read and measured before any request: a refused handoff sends nothing.
      const collected = yield* collectHandoff({
        cwd: path.resolve(dir),
        base: Option.getOrUndefined(base),
        untracked: !trackedOnly,
      });
      const slug = yield* handoffRepo(Option.getOrUndefined(repo), collected);
      if (dryRun) {
        for (const line of handoffPreview(collected, slug))
          yield* Console.log(line);
        return;
      }
      const { client } = yield* BoardClient;
      yield* handOff(
        client,
        {
          collected,
          repo: slug,
          board: Option.getOrUndefined(board),
          note: Option.getOrUndefined(note),
          title: Option.getOrUndefined(title),
          actor,
          start: start
            ? { column: Option.getOrUndefined(column), actor }
            : undefined,
        },
        Console.log,
      );
    });
    yield* reportFailures(Effect.provide(program, BoardClient.layer(apiUrl)));
  }),
).pipe(
  Command.withDescription(
    "Hand the checkout's work in progress to a factory session, as a card",
  ),
  Command.withExamples([
    {
      command:
        'factory handoff --repo acme/widget --note "Finish the retry loop; the tests in retry.test.ts are the spec"',
      description:
        "A card carrying the uncommitted diff, on the repository's board",
    },
    {
      command: "factory handoff --dry-run",
      description:
        "List the files the patch would carry, and send nothing (add --tracked-only to leave untracked files out)",
    },
    {
      command:
        'factory handoff --note "Take it from here" --start --column building',
      description: "The same, and its run started at once in building",
    },
  ]),
);
