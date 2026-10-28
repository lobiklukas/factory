/**
 * `factory handoff`'s card (S-local-agent-handoff-mcp): the board it goes on, the repository it
 * names, and what the create carries. The checkout half is `../handoff.test.ts`; the run that applies
 * the patch is `@repo/core`'s `SessionService.handoff.test.ts`; the terminal is verify-cli's
 * `mcp.sh`.
 */
import { Effect } from "effect";
import type { SessionId } from "@repo/domain/Session";
import type { CreateTaskInput, Task } from "@repo/domain/Task";
import { describe, expect, it } from "vitest";
import type { CollectedHandoff } from "../handoff";
import { boardFor, handOff, handoffRepo, type HandoffClient } from "./handoff";

const BOARD = "brd_01aaaaaaaaaaaaaaaaaaaaaaaa";
const TASK = "tsk_01bbbbbbbbbbbbbbbbbbbbbbbb";

const collected: CollectedHandoff = {
  root: "/tmp/x",
  handoff: {
    patch: "diff --git a/notes.md b/notes.md\n",
    branch: "feature/retry",
    baseCommit: "a".repeat(40),
  },
  baseRef: "main",
  files: ["notes.md"],
  bytes: 33,
  repo: "acme/widget" as never,
};

const client = (boards: ReadonlyArray<{ id: string; repo: string }>) => {
  const created: Array<CreateTaskInput> = [];
  const value: HandoffClient<never, never> = {
    listBoards: () => Effect.succeed(boards as never),
    createTask: (input) =>
      Effect.sync(() => {
        created.push(input);
        return {
          id: TASK,
          boardId: input.boardId,
          title: input.title,
          column: "intake",
          revision: 1,
        } as Task;
      }),
    getTask: () => Effect.die("unused"),
    getBoard: () => Effect.die("unused"),
    getDefinition: () => Effect.die("unused"),
    createSession: () => Effect.succeed({ id: "ses_x" as SessionId }),
    getSession: () => Effect.die("unused"),
    sendMessage: () => Effect.die("unused"),
  };
  return { value, created };
};

describe("factory handoff's card (S-local-agent-handoff-mcp)", () => {
  /**
   * Mutations this catches: send the create without the patch, without the base the patch was taken
   * against, or with the local branch as the base; print no card id.
   */
  it("makes one card on the repository's board carrying the patch, the base and the note", async () => {
    const c = client([{ id: BOARD, repo: "acme/widget" }]);
    const lines: Array<string> = [];
    const { card, sessionId } = await Effect.runPromise(
      handOff(
        c.value,
        {
          collected,
          repo: "acme/widget" as never,
          board: undefined,
          note: "Finish the retry loop",
          title: undefined,
          actor: "cli",
        },
        (line) => Effect.sync(() => void lines.push(line)),
      ),
    );
    expect(c.created).toEqual([
      {
        boardId: BOARD,
        title: "Finish the retry loop",
        repo: "acme/widget",
        body: expect.stringContaining(
          "The run's worktree starts with that work committed on its branch",
        ),
        baseRef: "main",
        handoff: collected.handoff,
        actor: "cli",
      },
    ]);
    expect(card.id).toBe(TASK);
    expect(sessionId).toBeUndefined();
    expect(lines).toEqual([
      `task    ${TASK} revision 1 column intake`,
      `handoff 1 file, 33 bytes from feature/retry at aaaaaaaaaaaa onto main`,
      `next    factory board start --task ${TASK}  (its run starts with this work committed on factory/<session-id>)`,
    ]);
  });

  it("refuses a repository with no board, a malformed board id, and a checkout whose remote names no repository", async () => {
    const none = await Effect.runPromise(
      boardFor(client([]).value, "acme/widget" as never, undefined).pipe(
        Effect.flip,
      ),
    );
    expect(none.message).toBe(
      "no board is over acme/widget: make one with `factory board create --repo acme/widget`, or name one with --board",
    );
    const malformed = await Effect.runPromise(
      boardFor(client([]).value, "acme/widget" as never, "board-1").pipe(
        Effect.flip,
      ),
    );
    expect(malformed.message).toBe(
      '--board "board-1" is not a board id (brd_…)',
    );
    const unnamed = await Effect.runPromise(
      handoffRepo(undefined, { ...collected, repo: undefined }).pipe(
        Effect.flip,
      ),
    );
    expect(unnamed.message).toContain(
      "name the one the factory knows it by with --repo",
    );
    expect(await Effect.runPromise(handoffRepo(undefined, collected))).toBe(
      "acme/widget",
    );
  });
});
