/**
 * The board contract's own refusals (docs/board.md B1–B9, `Task.ts`).
 *
 * These are the shapes a card, a definition and a run carry that nothing else in the repository
 * checks. The migration suite in `packages/storage-postgres` reads the seeded definition back
 * through `BoardDefinition`, so it proves the *columns* decode; nothing proved that `TaskId` refuses
 * a session id, that `ColumnRequirement.key` refuses a key a refusal could not name, or that
 * `TaskRun.sessionId` is a `SessionId` rather than a copy of the task pattern. Those are the claims
 * B5 rests on — "a refusal names the failing requirement", B1's "`run_id` is the session id" — and
 * each was one regex away from being wrong with no case to notice.
 *
 * Pure schema work: no database, no subprocess. Every case is a decode that must succeed or a
 * decode that must throw, so the budgets are this file's convention rather than a load hedge —
 * matching `mcp-pin.test.ts` and `ralph-settled-decisions.test.ts`, which `case-budgets.test.ts`
 * lists as unguarded for exactly this reason.
 */
import { describe, expect, it } from "vitest";
import { Effect, Exit, Schema } from "effect";
import { SessionId } from "./Session";
import {
  Actor,
  cardsByVersion,
  pinnedVersionsNotice,
  BoardColumn,
  BoardDefinition,
  BoardInstance,
  DEFAULT_BOARD_CAPS,
  BlockReason,
  ColumnKind,
  ColumnRequirement,
  CommentKind,
  CommentTaskInput,
  CreateBoardInput,
  DECLARED_TRANSITIONS,
  DEFAULT_DEFINITION_ID,
  DefinitionId,
  columnTransitions,
  declaresTransitions,
  defaultPipelineTransitions,
  definitionProblems,
  type DefinitionMoves,
  gatedColumns,
  gatedExit,
  initialColumnOf,
  MAX_COMMENT_CHARS,
  declaredTransitions,
  HUMAN_GATES,
  humanGate,
  Task,
  transitionOf,
  TaskComment,
  TaskBlocked,
  TaskEvent,
  TaskId,
  TaskPriority,
  TaskRun,
  type BoardInstanceId,
  isWebLink,
  runPrompt,
} from "./Task";

/** Whether `schema` refuses `value`, as a value rather than a throw, so a case reads as data. */
const refuses = (schema: Schema.Codec<unknown>, value: unknown): boolean =>
  !Exit.isSuccess(
    Effect.runSync(Effect.exit(Schema.decodeUnknownEffect(schema)(value))),
  );

/** Twenty-six characters of the alphabet every id in this file draws from. */
const ALPHABET26 = "0".repeat(26);

/** A card id in the shape `Task.ts:31` promises. */
const A_TASK_ID = `tsk_${ALPHABET26}`;
/** A board id in the shape `Task.ts:45` promises. */
const A_BOARD_ID = `brd_${ALPHABET26}` as BoardInstanceId;
/** A session id in the shape `Session.ts:16` promises. */
const A_SESSION_ID = `ses_${ALPHABET26}`;
/** An instant in the shape `Session.ts:29` promises, which is `Schema.String`. */
const AN_INSTANT = "2026-10-08T00:00:00.000Z";
/** A board instance in the shape `Task.ts:112` promises. */
const aBoardInstance = {
  id: A_BOARD_ID,
  repo: "factory/ralph",
  definitionId: "default",
  definitionVersion: 1,
  createdAt: AN_INSTANT,
};

/** A card that every case here varies one field of. */
const aCard = {
  id: A_TASK_ID,
  boardId: A_BOARD_ID,
  title: "a card",
  column: "building",
  definitionVersion: 1,
  revision: 1,
  priority: "normal",
  createdAt: AN_INSTANT,
  updatedAt: AN_INSTANT,
};

describe("the board's ids", () => {
  /**
   * `TaskId`'s pattern, which is what `Task.ts:31` promises: `tsk_`, then twenty-six characters of
   * Crockford base32 without the four ambiguous letters.
   *
   * Mutation: widen the pattern, or drop the `tsk_` anchor — each refusal below goes.
   */
  it("accepts the shape TaskId promises and refuses everything else", () => {
    expect(refuses(TaskId, A_TASK_ID)).toBe(false);
    // The four letters Crockford base32 omits because they are read alike: i, l, o, u.
    for (const letter of ["i", "l", "o", "u"]) {
      expect(refuses(TaskId, `tsk_${letter.repeat(26)}`)).toBe(true);
    }
    // The length and the prefix are both load-bearing.
    expect(refuses(TaskId, `tsk_${"0".repeat(25)}`)).toBe(true);
    expect(refuses(TaskId, `tsk_${"0".repeat(27)}`)).toBe(true);
    expect(refuses(TaskId, `ses_${ALPHABET26}`)).toBe(true);
    expect(refuses(TaskId, A_TASK_ID.toUpperCase())).toBe(true);
    expect(refuses(TaskId, A_TASK_ID.replace("tsk_", "tsk"))).toBe(true);
    expect(refuses(TaskId, `tsk-${ALPHABET26}`)).toBe(true);
  });

  /**
   * The three ids are three different namespaces, not three spellings of one. `Task.ts:27-28`
   * calls the task id "as much a label for a human as a key for a database", which is only true
   * while the prefixes stay distinct — a card whose id read `ses_…` would be a session id in a
   * card's field.
   *
   * Mutation: copy `TaskId`'s pattern into `BoardInstanceId` — the refusals below that pass a task
   * id where a *board* id belongs (the `BoardInstance` decode at the bottom of this case) go,
   * because a board then accepts `A_TASK_ID`. The first two refusals do not depend on it.
   */
  it("keeps TaskId, SessionId and BoardInstanceId in three separate namespaces", () => {
    expect(refuses(TaskId, A_SESSION_ID)).toBe(true);
    expect(refuses(SessionId, A_TASK_ID)).toBe(true);
    expect(refuses(SessionId, `brd_${ALPHABET26}`)).toBe(true);

    const boardIdSchema = BoardInstance;
    expect(refuses(boardIdSchema, { ...aBoardInstance, id: A_TASK_ID })).toBe(
      true,
    );
    expect(
      refuses(boardIdSchema, { ...aBoardInstance, id: A_SESSION_ID }),
    ).toBe(true);
  });

  /**
   * `DefinitionId` is a human slug, not an id: `default` is what the seed writes, and B2's rule is
   * that a definition's own id is stable across the versions that carry its column sets. So the
   * pattern has to accept a short lowercase word and refuse anything that would make a definition id
   * ambiguous — an uppercase spelling is a second name for the same row.
   *
   * Mutation: allow uppercase in the pattern — the second refusal below goes.
   */
  it("accepts the seeded id and refuses a DefinitionId that could name two rows", () => {
    expect(refuses(DefinitionId, "default")).toBe(false);
    expect(refuses(DefinitionId, "a")).toBe(false);
    expect(refuses(DefinitionId, "a-b_c9")).toBe(false);
    // Sixty-four characters, the ceiling `Task.ts:39` sets.
    expect(refuses(DefinitionId, "d".repeat(64))).toBe(false);
    expect(refuses(DefinitionId, "d".repeat(65))).toBe(true);

    // A leading digit or hyphen, an uppercase letter, a space, and the empty string: each of these
    // would make two spellings of one definition id, which is what a version's identity cannot be.
    for (const id of [
      "9lives",
      "-leading",
      "Default",
      "two words",
      "with/slash",
      "",
    ]) {
      expect(refuses(DefinitionId, id)).toBe(true);
    }
  });
});

describe("the board's columns", () => {
  /**
   * `ColumnRequirement.key` is the identity a refusal names — B5's "a refusal names the failing
   * requirement" — so the pattern is the mechanism, not cosmetics. A key a program cannot match is a
   * requirement nothing can be refused against.
   *
   * The pattern is `^[a-z][a-z0-9_]*$`: lowercase, a leading letter, then snake_case. Every refusal
   * below is a spelling that would break a machine matching against it.
   *
   * Mutation: widen the pattern to `^\\S+$` — the first and second refusals go; the third
   * (`"spec doc"`) is a space, which `^\\S+$` still refuses.
   */
  it("refuses a requirement key a refusal could not name", () => {
    expect(
      refuses(ColumnRequirement, { key: "spec_doc", description: "d" }),
    ).toBe(false);
    expect(refuses(ColumnRequirement, { key: "a", description: "d" })).toBe(
      false,
    );
    expect(refuses(ColumnRequirement, { key: "a1_b2", description: "d" })).toBe(
      false,
    );

    for (const key of [
      "Spec_doc", // uppercase: a case-sensitive match would miss it
      "spec-doc", // a hyphen: not an identifier character
      "spec doc", // a space: a UI label, not a key
      "1spec", // a leading digit: not a letter
      "_spec", // a leading underscore: not a letter
      "", // nothing to name
      "spec.doc", // a dot: a path, not a key
      "spec/doc", // a slash
    ]) {
      expect(refuses(ColumnRequirement, { key, description: "d" })).toBe(true);
    }

    // `description` is required and is what a person reads, but an empty one is deliberately
    // *accepted*: a requirement with nothing to show a reader is a content question for whoever
    // writes the definition, and this schema states the mechanism (the key), not the prose. The
    // `Actor` case below proves the same kind of looseness on purpose; this one is not pinned by a
    // refusal, and tightening it would be a product decision rather than a bug fix.
    expect(
      refuses(ColumnRequirement, { key: "spec_doc", description: "" }),
    ).toBe(false);
    expect(
      refuses(ColumnRequirement, {
        key: "spec_doc",
        description: "a spec doc",
      }),
    ).toBe(false);
  });

  /**
   * `ColumnKind`'s three literals, and the two rule fields B6 says every column declares.
   *
   * The refusal that matters is the unknown kind: a column with `kind: "sideways"` has no exit
   * semantics, and `ColumnKind` is the only thing that says which of the three it has. The empty
   * `skills[]` and `requires[]` are checked as accepted, because B4's `intake` and the two terminal
   * columns carry exactly those and a shape that refused them would reject the seed.
   *
   * Mutation: add a fourth literal to `ColumnKind` — the first refusal below goes.
   */
  it("refuses a kind that is not one of B4's three, and admits the rest", () => {
    for (const kind of ["resting", "working", "terminal"]) {
      expect(
        refuses(BoardColumn, {
          name: "specifying",
          kind,
          role: undefined,
          skills: [],
          requires: [],
        }),
      ).toBe(false);
    }
    for (const kind of [
      "sideways",
      "RESTING",
      "Resting",
      "resting ",
      "",
      "0",
    ]) {
      expect(
        refuses(BoardColumn, {
          name: "specifying",
          kind,
          skills: [],
          requires: [],
        }),
      ).toBe(true);
    }

    // `skills` and `requires` are both required fields that may be empty: B4's `intake` has no
    // exit requirement and no skills, and the seed writes exactly that.
    expect(
      refuses(BoardColumn, { name: "intake", kind: "resting", requires: [] }),
    ).toBe(true);
    expect(
      refuses(BoardColumn, { name: "intake", kind: "resting", skills: [] }),
    ).toBe(true);
    // And `role` is the one optional field, because B4 prints an em dash for three of its columns.
    expect(
      refuses(BoardColumn, {
        name: "intake",
        kind: "resting",
        role: undefined,
        skills: [],
        requires: [],
      }),
    ).toBe(false);
    expect(
      refuses(BoardColumn, {
        name: "building",
        kind: "working",
        role: "builder",
        skills: [],
        requires: [],
      }),
    ).toBe(false);
  });

  /**
   * `ColumnKind` and `TaskPriority` are closed sets, and this is the case that says they are closed
   * rather than leaving it to a reader to infer from the `Schema.Literals` call.
   *
   * B9's flag is `urgent | normal` and nothing else — the case proves a card cannot be `high`, which
   * is the spelling someone would reach for and which B9 does not list.
   */
  it("closes ColumnKind and TaskPriority to the literals the documents name", () => {
    expect(refuses(ColumnKind, "resting")).toBe(false);
    expect(refuses(ColumnKind, "working")).toBe(false);
    expect(refuses(ColumnKind, "terminal")).toBe(false);
    expect(refuses(ColumnKind, "done")).toBe(true);

    expect(refuses(TaskPriority, "urgent")).toBe(false);
    expect(refuses(TaskPriority, "normal")).toBe(false);
    expect(refuses(TaskPriority, "high")).toBe(true);
    expect(refuses(TaskPriority, "Normal")).toBe(true);
  });

  /**
   * `BlockReason`'s four literals are B4's, verbatim, in the order B4 prints them.
   *
   * This is the one place a case can check the *set* rather than a few members: B4 writes
   * `dependency | needs_input | capability | transient` and the literals are those four, so a typo
   * that adds or swaps one is caught here and nowhere else.
   */
  it("takes exactly B4's four block reasons", () => {
    for (const reason of [
      "dependency",
      "needs_input",
      "capability",
      "transient",
    ]) {
      expect(refuses(BlockReason, reason)).toBe(false);
    }
    for (const reason of ["blocked", "waiting", "Dependency", "", "human"]) {
      expect(refuses(BlockReason, reason)).toBe(true);
    }
  });
});

describe("a card, a run and an event", () => {
  /**
   * `TaskRun.sessionId` is `SessionId`, not `TaskId`. B1 says a run *is* one Pi Durable session, so
   * this is the field that makes the run's log findable — and `TaskRun.id` sits next to it as a plain
   * `Schema.String`, which is worth pinning because a reader may assume the two ids share a pattern.
   *
   * Mutation: change `sessionId` to `Schema.String` — the second refusal below goes.
   */
  it("holds a run's session as a SessionId and its own id as an untyped string", () => {
    const aRun = {
      id: "run_1",
      taskId: A_TASK_ID,
      sessionId: A_SESSION_ID,
      column: "building",
      startedAt: AN_INSTANT,
    };
    expect(refuses(TaskRun, aRun)).toBe(false);

    // A task id is not a session id: swapping the two fields would make the run's log unreachable.
    expect(refuses(TaskRun, { ...aRun, sessionId: A_TASK_ID })).toBe(true);
    expect(refuses(TaskRun, { ...aRun, sessionId: `brd_${ALPHABET26}` })).toBe(
      true,
    );
    expect(refuses(TaskRun, { ...aRun, taskId: A_SESSION_ID })).toBe(true);

    // `finishedAt` is optional, which is what "a run that has not finished" is.
    expect(refuses(TaskRun, { ...aRun, finishedAt: AN_INSTANT })).toBe(false);
    expect(refuses(TaskRun, { ...aRun, column: undefined })).toBe(true);

    // And `TaskRun.id` is untyped: any string is a run id. That is the migration's column too
    // (`id TEXT PRIMARY KEY`, no pattern), so the two agree, and this case says so rather than
    // leaving a reader to assume otherwise.
    expect(refuses(TaskRun, { ...aRun, id: "x" })).toBe(false);
  });

  /**
   * A blocked card is a state, not a column (B4), and `TaskBlocked`'s three required fields are the
   * database's three columns that travel together. `note` is the one optional field, and
   * `blocked_note` sits outside the database's all-or-nothing rule, so the contract and the schema
   * agree on which fields are optional.
   *
   * Mutation: make `column` optional in `TaskBlocked` — the second refusal below goes.
   */
  it("takes a block's reason, the column it blocked from and a timestamp together", () => {
    const aBlock = {
      reason: "needs_input",
      column: "building",
      since: AN_INSTANT,
    };
    expect(refuses(TaskBlocked, aBlock)).toBe(false);
    expect(refuses(TaskBlocked, { ...aBlock, note: "which repo?" })).toBe(
      false,
    );

    // The three that travel together in the database's CHECK: dropping any one is refused.
    expect(
      refuses(TaskBlocked, { column: "building", since: AN_INSTANT }),
    ).toBe(true);
    expect(
      refuses(TaskBlocked, { reason: "needs_input", since: AN_INSTANT }),
    ).toBe(true);
    expect(
      refuses(TaskBlocked, { reason: "needs_input", column: "building" }),
    ).toBe(true);
  });

  /**
   * `Actor` is a plain string, on purpose: `docs/board.md`'s MVP cut deletes "identity beyond an
   * actor string" and wave 2 item 7 owns real authentication (LOB-20). So this case proves the
   * *weakness* deliberately, because a future reader tightening it would be deciding a product
   * question rather than fixing a bug.
   *
   * Mutation: give `Actor` a pattern — the second assertion goes, and B5's MVP actor stops working.
   */
  it("takes any actor string, including the empty one, because the MVP cut says so", () => {
    expect(refuses(Actor, "person:1")).toBe(false);
    expect(refuses(Actor, "")).toBe(false);
    expect(refuses(Actor, "someone@example.com")).toBe(false);
    expect(refuses(Actor, 42)).toBe(true);
  });

  /**
   * `TaskEvent`'s nine tags, and the two fields B5 says every move carries.
   *
   * B5: "Every move carries an **actor** and an expected **revision**". This is the case that proves
   * all nine variants declare both, rather than the four that read as moves — a block and a comment
   * are moves too, and an event without an actor would break the audit trail `Task.ts:186` claims.
   *
   * The `task_events` table's `kind` column is what a writer would store, and it is unconstrained
   * `TEXT`: nothing in the database ties a row's `kind` to these nine. That gap is recorded by the
   * case in `PostgresStorage.test.ts` that stores a column set the contract rejects; here the claim
   * is only that the *contract* has nine and every one carries both fields.
   *
   * Mutation: drop `revision` from the `commented` variant — that variant's refusal goes.
   */
  it("gives every event kind the actor and the revision B5 requires", () => {
    const variants = [
      {
        _tag: "created",
        taskId: A_TASK_ID,
        boardId: A_BOARD_ID,
        title: "a card",
        column: "intake",
      },
      { _tag: "moved", taskId: A_TASK_ID, from: "intake", to: "specifying" },
      {
        _tag: "blocked",
        taskId: A_TASK_ID,
        reason: "needs_input",
        column: "building",
      },
      { _tag: "unblocked", taskId: A_TASK_ID },
      { _tag: "commented", taskId: A_TASK_ID, body: "which repo?" },
      {
        _tag: "specified",
        taskId: A_TASK_ID,
        column: "specifying",
        goal: "pin the Postgres major",
        acceptance: ["the compose file names one major"],
        gaps: [],
        openQuestions: [],
      },
      {
        _tag: "planned",
        taskId: A_TASK_ID,
        column: "planning",
        summary: "export the card count",
        steps: ["add the export"],
        surfaces: ["web"],
        risks: [],
      },
      {
        _tag: "priorityChanged",
        taskId: A_TASK_ID,
        from: "normal",
        to: "urgent",
      },
      { _tag: "retitled", taskId: A_TASK_ID, from: "old", to: "new" },
      {
        _tag: "repinned",
        taskId: A_TASK_ID,
        fromVersion: 2,
        toVersion: 3,
        from: "review",
        to: "review",
        mapping: { review: "review" },
      },
    ] as const;
    for (const variant of variants) {
      expect(
        refuses(TaskEvent, { ...variant, actor: "person:1", revision: 2 }),
      ).toBe(false);
      // B5's two, each missing in turn.
      expect(refuses(TaskEvent, { ...variant, revision: 2 })).toBe(true);
      expect(refuses(TaskEvent, { ...variant, actor: "person:1" })).toBe(true);
    }
    // A tenth tag is refused, so the set is closed at nine.
    expect(
      refuses(TaskEvent, {
        _tag: "renamed",
        taskId: A_TASK_ID,
        actor: "person:1",
        revision: 2,
      }),
    ).toBe(true);
  });

  /**
   * A card's `revision` and `definitionVersion` are `Schema.Int`, which accepts 0 and a negative —
   * while the database refuses both (`CHECK (revision >= 1)`, `CHECK (definition_version >= 1)`).
   *
   * This is a case about the *gap between* the two, not a claim that the database is right. The
   * database's side is witnessed in `PostgresStorage.test.ts`; the contract's side is here. A reader
   * who assumed the schema carried the floor would be wrong, and the honest fix belongs to whichever
   * of LOB-59 or LOB-60 owns the writer rather than to this issue.
   *
   * Mutation: add `Schema.check(Schema.isGreaterThanOrEqualTo(1))` to `revision` — this reddens,
   * and that red is the signal that the contract has caught up with the table.
   */
  it("accepts a revision of 0, which the database refuses", () => {
    expect(refuses(Task, aCard)).toBe(false);
    expect(refuses(Task, { ...aCard, revision: 0 })).toBe(false);
    expect(refuses(Task, { ...aCard, revision: -1 })).toBe(false);
    expect(refuses(Task, { ...aCard, definitionVersion: 0 })).toBe(false);

    // What the contract *does* refuse is what the database's column types imply: an id of the wrong
    // shape, a column that is not a string, a priority outside B9's two literals.
    expect(refuses(Task, { ...aCard, id: A_SESSION_ID })).toBe(true);
    expect(refuses(Task, { ...aCard, boardId: A_TASK_ID })).toBe(true);
    expect(refuses(Task, { ...aCard, column: 7 })).toBe(true);
    expect(refuses(Task, { ...aCard, priority: "high" })).toBe(true);

    // `repo` and `blocked` are the two optional fields: B1 gives a card a repo and 0007 makes
    // `tasks.repo` nullable, and a card need not be blocked.
    expect(refuses(Task, { ...aCard, repo: undefined })).toBe(false);
    expect(refuses(Task, { ...aCard, repo: "factory/ralph" })).toBe(false);
    // RepoSlug's own pattern: `owner/name`, lowercase, no third segment.
    expect(refuses(Task, { ...aCard, repo: "factory" })).toBe(true);
    expect(refuses(Task, { ...aCard, repo: "Factory/Ralph" })).toBe(true);
    expect(refuses(Task, { ...aCard, blocked: undefined })).toBe(false);
    expect(
      refuses(Task, {
        ...aCard,
        blocked: {
          reason: "needs_input",
          column: "building",
          since: AN_INSTANT,
        },
      }),
    ).toBe(false);
  });

  /**
   * `Timestamp` is `Schema.String` (`Session.ts:29`), so every instant on a card, a run and a block
   * is an unvalidated string — `"whenever"` decodes. The database's columns are `TIMESTAMPTZ` and
   * would refuse it.
   *
   * Written down rather than left implicit because the reuse is deliberate (`Task.ts:24` imports
   * `Timestamp` from `@repo/domain/Session` for exactly this reason) and a reader may otherwise assume the
   * board's instants are checked somewhere.
   */
  it("takes any string where a Timestamp is named", () => {
    expect(refuses(Task, { ...aCard, createdAt: AN_INSTANT })).toBe(false);
    expect(refuses(Task, { ...aCard, createdAt: "whenever" })).toBe(false);
    expect(refuses(Task, { ...aCard, updatedAt: "" })).toBe(false);
    expect(refuses(Task, { ...aCard, createdAt: 1_789_000_000_000 })).toBe(
      true,
    );
    expect(
      refuses(Task, {
        ...aCard,
        blocked: { reason: "dependency", column: "building", since: "later" },
      }),
    ).toBe(false);
  });

  /**
   * A `BoardDefinition` decodes from a row the database actually stores, including the
   * `created_at` the contract does not name — so a reader can decode a `board_definitions` row
   * without projecting it first.
   *
   * This is what the migration suite's seed cases depend on, isolated from the database: it says the
   * decode tolerates the extra column rather than only that the seed's own projection works.
   *
   * Mutation: rename `BoardDefinition.version` — a stored row stops decoding and the first refusal
   * goes. Note that adding `onExcessProperty: "error"` to the `Schema.Struct` does *not* do it:
   * measured against effect 4.0.0 that option is declared exactly once in `Schema.d.ts`, at
   * `:10673`, inside `interface ToJsonSchemaOptions` — a JSON-Schema *derivation* option
   * (`node_modules/effect/dist/Schema.d.ts:10662-10673`). No decoder-side option of that name
   * exists in 4.0.0 (`grep -rn onExcessProperty node_modules/effect/dist` finds only the
   * declaration above and the JSON-Schema compiler), so the mutation below is the only one this
   * case can pin.
   */
  it("decodes a board_definitions row as stored, and refuses a column set it rejects", () => {
    const stored = {
      id: "default",
      version: 1,
      name: "Default pipeline",
      created_at: AN_INSTANT,
      columns: [{ name: "intake", kind: "resting", skills: [], requires: [] }],
    };
    expect(refuses(BoardDefinition, stored)).toBe(false);
    // The `created_at` is absorbed: decoding yields the four named fields and no error.
    expect(
      Schema.decodeUnknownSync(BoardDefinition)(stored).columns,
    ).toHaveLength(1);

    // A column set the contract rejects, which is the case the database does *not* catch.
    expect(
      refuses(BoardDefinition, {
        ...stored,
        columns: [{ name: "x", kind: "sideways", skills: [], requires: [] }],
      }),
    ).toBe(true);
    // And a version the database's `CHECK (version >= 1)` mirrors but the contract does not.
    expect(refuses(BoardDefinition, { ...stored, version: 0 })).toBe(false);
  });
});

/**
 * The thread on a card (B7, LOB-73): a comment is a `commented` event, and what it is in the thread
 * — a run's question, a person's answer, a note — is recorded with it rather than inferred later.
 */
describe("a card's thread", () => {
  const aComment = {
    _tag: "commented",
    taskId: A_TASK_ID,
    actor: A_SESSION_ID,
    body: "Which repo?",
    revision: 2,
  };

  it("closes the comment kinds at three", () => {
    expect(CommentKind.literals).toEqual(["question", "answer", "note"]);
    expect(refuses(CommentKind, "reply")).toBe(true);
  });

  it("records a comment's kind and ask id on the event, and reads one without them as before", () => {
    expect(refuses(TaskEvent, aComment)).toBe(false);
    expect(
      refuses(TaskEvent, {
        ...aComment,
        kind: "question",
        askId: `${A_SESSION_ID}:call-1`,
      }),
    ).toBe(false);
    expect(refuses(TaskEvent, { ...aComment, kind: "reply" })).toBe(true);
    // Encoding keeps both fields: a stored event that lost its ask id could not be deduplicated.
    const encoded = Schema.encodeSync(TaskEvent)(
      Schema.decodeUnknownSync(TaskEvent)({
        ...aComment,
        kind: "question",
        askId: "ses:call",
      }),
    );
    expect(encoded).toMatchObject({ kind: "question", askId: "ses:call" });
  });

  it("gives every comment a reader gets a kind", () => {
    const comment = {
      taskId: A_TASK_ID,
      kind: "answer",
      actor: "person:lukas",
      body: "lobiklukas/factory",
      revision: 4,
      createdAt: AN_INSTANT,
    };
    expect(refuses(TaskComment, comment)).toBe(false);
    const { kind: _kind, ...withoutKind } = comment;
    expect(refuses(TaskComment, withoutKind)).toBe(true);
    expect(refuses(TaskComment, { ...comment, taskId: A_SESSION_ID })).toBe(
      true,
    );
  });

  it("bounds a comment's body, since every run on the card is prompted with it", () => {
    const input = {
      taskId: A_TASK_ID,
      expectedRevision: 3,
      actor: "person:lukas",
    };
    expect(
      refuses(CommentTaskInput, {
        ...input,
        body: "x".repeat(MAX_COMMENT_CHARS),
      }),
    ).toBe(false);
    expect(
      refuses(CommentTaskInput, {
        ...input,
        body: "x".repeat(MAX_COMMENT_CHARS + 1),
      }),
    ).toBe(true);
  });
});

describe("the declared transitions and human gates (B4, B5)", () => {
  /**
   * The table both `TaskService` and the card pane read (LOB-76). These cases pin its shape, so a
   * pipeline edit that lets a card skip a column — the `intake → done` the card pane must never
   * offer — fails here before it fails in a browser.
   */
  it("is the forward pipeline plus canceled, and no column skips one", () => {
    expect(declaredTransitions("intake")).toEqual(["specifying", "canceled"]);
    expect(declaredTransitions("specifying")).toEqual(["planning", "canceled"]);
    expect(declaredTransitions("planning")).toEqual(["building", "canceled"]);
    expect(declaredTransitions("building")).toEqual(["review", "canceled"]);
    expect(declaredTransitions("review")).toEqual(["done", "canceled"]);
    expect(declaredTransitions("intake")).not.toContain("done");
    expect(declaredTransitions("intake")).not.toContain("building");
  });

  it("declares nothing out of a terminal column or one it does not know", () => {
    expect(declaredTransitions("done")).toEqual([]);
    expect(declaredTransitions("canceled")).toEqual([]);
    expect(declaredTransitions("triage")).toEqual([]);
    expect(Object.keys(DECLARED_TRANSITIONS)).not.toContain("done");
  });

  it("names exactly the two human gates, and only on declared moves", () => {
    expect(humanGate("planning", "building")).toBe("plan approval");
    expect(humanGate("review", "done")).toBe("merge");
    expect(humanGate("intake", "specifying")).toBeUndefined();
    expect(humanGate("building", "review")).toBeUndefined();
    for (const key of Object.keys(HUMAN_GATES)) {
      const [from = "", to = ""] = key.split("→");
      expect(declaredTransitions(from)).toContain(to);
    }
    expect(Object.keys(HUMAN_GATES)).toHaveLength(2);
  });

  it("finds each gated column's exit under the default table, and only the gated ones (LOB-77)", () => {
    const legacy: DefinitionMoves = { columns: B4_NAMES.map(aColumn) };
    expect(gatedColumns(legacy)).toEqual(["planning", "review"]);
    expect(gatedExit(legacy, "planning")).toEqual({
      to: "building",
      gate: "plan approval",
    });
    expect(gatedExit(legacy, "review")).toEqual({ to: "done", gate: "merge" });
    for (const column of ["intake", "specifying", "building", "done", "x"]) {
      expect(gatedExit(legacy, column)).toBeUndefined();
    }
  });
});

/** The default pipeline's column names, in declaration order (B4). */
const B4_NAMES = [
  "intake",
  "specifying",
  "planning",
  "building",
  "review",
  "done",
  "canceled",
];

/** A column with nothing on it but its name: no role, skills, requirements or transitions. */
const aColumn = (name: string): BoardColumn => ({
  name,
  kind: "working",
  skills: [],
  requires: [],
});

/**
 * Transitions, gates and the initial column as definition data (LOB-267). A definition that declares
 * moves on any column is read from its columns alone; one that declares none (default v1–v3) through
 * the default pipeline's table, exactly as before.
 */
describe("a definition's own transitions, gates and initial column (LOB-267)", () => {
  /** todo → doing → done, with a gate on doing → done: the issue's synthetic definition. */
  const synthetic: DefinitionMoves = {
    initialColumn: "todo",
    columns: [
      { ...aColumn("todo"), kind: "resting", transitions: [{ to: "doing" }] },
      { ...aColumn("doing"), transitions: [{ to: "done", gate: "sign-off" }] },
      { ...aColumn("done"), kind: "terminal", transitions: [] },
    ],
  };

  /** Mutation: read the default table whatever the definition declares — `todo` has no moves. */
  it("reads the moves a column declares, and only those", () => {
    expect(declaresTransitions(synthetic)).toBe(true);
    expect(columnTransitions(synthetic, "todo")).toEqual([{ to: "doing" }]);
    expect(transitionOf(synthetic, "todo", "doing")).toEqual({ to: "doing" });
    expect(transitionOf(synthetic, "todo", "done")).toBeUndefined();
    expect(transitionOf(synthetic, "doing", "done")).toEqual({
      to: "done",
      gate: "sign-off",
    });
    expect(columnTransitions(synthetic, "done")).toEqual([]);
    expect(columnTransitions(synthetic, "nowhere")).toEqual([]);
    expect(gatedColumns(synthetic)).toEqual(["doing"]);
    expect(gatedExit(synthetic, "doing")).toEqual({
      to: "done",
      gate: "sign-off",
    });
  });

  /**
   * A declaring definition never falls back to the table by name, so a column it leaves without
   * `transitions` declares none even when the table knows its name. Mutation: fall back per column —
   * `intake` here gains `specifying` and `canceled`.
   */
  it("declares no moves for a column without transitions once any column declares some", () => {
    const mixed: DefinitionMoves = {
      columns: [
        aColumn("intake"),
        { ...aColumn("specifying"), transitions: [{ to: "intake" }] },
      ],
    };
    expect(columnTransitions(mixed, "intake")).toEqual([]);
    expect(columnTransitions(mixed, "specifying")).toEqual([{ to: "intake" }]);
  });

  /** Mutation: drop the fallback — a card pinned to default v1–v3 has no moves at all. */
  it("reads a definition that declares no moves through the default pipeline's table", () => {
    const legacy: DefinitionMoves = { columns: B4_NAMES.map(aColumn) };
    expect(declaresTransitions(legacy)).toBe(false);
    for (const name of B4_NAMES) {
      expect(columnTransitions(legacy, name)).toEqual(
        defaultPipelineTransitions(name),
      );
    }
    expect(columnTransitions(legacy, "planning")).toEqual([
      { to: "building", gate: "plan approval" },
      { to: "canceled" },
    ]);
  });

  /** Mutation: hard-code `intake` — the synthetic definition starts a card in a column it lacks. */
  it("starts a card in the declared initial column, or the first column when none is declared", () => {
    expect(initialColumnOf(synthetic)).toBe("todo");
    expect(initialColumnOf({ ...synthetic, initialColumn: "doing" })).toBe(
      "doing",
    );
    expect(initialColumnOf({ columns: B4_NAMES.map(aColumn) })).toBe("intake");
    expect(initialColumnOf({ columns: [aColumn("backlog")] })).toBe("backlog");
    // No columns, no lane to start in: never a default name the definition lacks.
    expect(initialColumnOf({ columns: [] })).toBeUndefined();
  });

  it("finds nothing wrong with the synthetic definition or the default pipeline's table", () => {
    expect(definitionProblems(synthetic)).toEqual([]);
    expect(
      definitionProblems({
        initialColumn: "intake",
        columns: B4_NAMES.map((name) => ({
          ...aColumn(name),
          transitions: defaultPipelineTransitions(name),
        })),
      }),
    ).toEqual([]);
  });

  /** Each fault on its own, so a check that is dropped reddens its own line. */
  it("names every fault that would leave a card stuck or offered a lane that is not there", () => {
    expect(
      definitionProblems({ ...synthetic, initialColumn: "backlog" }),
    ).toEqual([
      'the initial column "backlog" is not a column of the definition',
    ]);
    expect(
      definitionProblems({
        columns: [
          { ...aColumn("todo"), transitions: [{ to: "nowhere" }] },
          aColumn("todo"),
        ],
      }),
    ).toEqual([
      'column "todo" is declared more than once',
      'column "todo" declares a move to "nowhere", which is not a column of the definition',
    ]);
    expect(
      definitionProblems({
        columns: [
          {
            ...aColumn("todo"),
            transitions: [{ to: "todo" }, { to: "done" }, { to: "done" }],
          },
          { ...aColumn("done"), transitions: [{ to: "todo", gate: " " }] },
        ],
      }),
    ).toEqual([
      'column "todo" declares a move to itself',
      'column "todo" declares its move to "done" more than once',
      'column "done"\'s move to "todo" names a gate with no name',
    ]);
    expect(definitionProblems({ columns: [] })).toEqual([
      "the definition declares no columns",
    ]);
  });

  /** A column's transitions round-trip through the schema a `board_definitions` row decodes with. */
  it("decodes a column's transitions, and refuses a transition with no target", () => {
    const column = {
      ...aColumn("doing"),
      transitions: [{ to: "done", gate: "sign-off" }],
    };
    expect(Schema.decodeSync(BoardColumn)(column)).toEqual(column);
    expect(Schema.decodeSync(BoardColumn)(aColumn("doing"))).toEqual(
      aColumn("doing"),
    );
    expect(
      refuses(BoardColumn, { ...column, transitions: [{ gate: "x" }] }),
    ).toBe(true);
    expect(
      Schema.decodeSync(BoardDefinition)({
        id: "todo",
        version: 1,
        name: "Todo",
        initialColumn: "todo",
        columns: [column],
      }).initialColumn,
    ).toBe("todo");
  });
});

describe("a new board (B2, LOB-208)", () => {
  /**
   * `createBoard`'s payload (LOB-208) is the RPC's only check on what reaches `board_instances`:
   * `repo` has no CHECK in 0007, so a malformed slug would be stored and then fail every read of
   * the board. Mutation: make `repo` `Schema.String` — the first refusal goes. Make `definitionId`
   * `Schema.String` — the second.
   */
  it("takes a repo and a definition id for a new board, the version optional, and refuses a malformed one", () => {
    const decode = Schema.decodeUnknownSync(CreateBoardInput);
    expect(
      decode({
        repo: "lobiklukas/factory",
        definitionId: DEFAULT_DEFINITION_ID,
      }),
    ).toEqual({ repo: "lobiklukas/factory", definitionId: "default" });
    expect(
      decode({
        repo: "lobiklukas/factory",
        definitionId: "default",
        definitionVersion: 1,
      }).definitionVersion,
    ).toBe(1);
    expect(
      refuses(CreateBoardInput, {
        repo: "Not A Repo",
        definitionId: "default",
      }),
    ).toBe(true);
    expect(
      refuses(CreateBoardInput, {
        repo: "lobiklukas/factory",
        definitionId: "Default Pipeline",
      }),
    ).toBe(true);
    expect(
      refuses(CreateBoardInput, {
        repo: "lobiklukas/factory",
        definitionId: "default",
        definitionVersion: 1.5,
      }),
    ).toBe(true);
  });
});

describe("isWebLink (LOB-254)", () => {
  it("takes an absolute http(s) URL and nothing else", () => {
    for (const link of [
      "https://linear.app/acme/issue/ENG-7/title",
      "http://localhost:3000/issue?id=7#top",
      "HTTPS://LINEAR.APP",
    ]) {
      expect(isWebLink(link), link).toBe(true);
    }
    for (const notLink of [
      "javascript:alert(1)",
      "ftp://linear.app/x",
      "/issue/ENG-7",
      "ENG-7",
      "https://",
      "https://user@evil.example/x",
      "https://linear.app/a b",
      " https://linear.app",
    ]) {
      expect(isWebLink(notLink), notLink).toBe(false);
    }
  });
});

describe("run caps and WIP limits (LOB-71)", () => {
  const definition = {
    id: "default",
    version: 5,
    name: "Default pipeline",
    columns: [{ name: "building", kind: "working", skills: [], requires: [] }],
  };

  /** Mutation: drop the `>= 1` check on `RunCap` — a zero cap and a zero WIP limit decode. */
  it("takes a whole number of runs, at least one, for every cap and a column's WIP limit", () => {
    expect(
      refuses(BoardDefinition, { ...definition, caps: DEFAULT_BOARD_CAPS }),
    ).toBe(false);
    expect(refuses(BoardDefinition, { ...definition, caps: {} })).toBe(false);
    for (const caps of [{ board: 0 }, { task: 1.5 }, { repo: -2 }])
      expect(refuses(BoardDefinition, { ...definition, caps })).toBe(true);
    const column = definition.columns[0];
    expect(refuses(BoardColumn, { ...column, wipLimit: 3 })).toBe(false);
    expect(refuses(BoardColumn, { ...column, wipLimit: 0 })).toBe(true);
  });

  it("is B9's 2 per board, 1 per task, 2 per repo by default", () => {
    expect(DEFAULT_BOARD_CAPS).toEqual({ board: 2, task: 1, repo: 2 });
  });
});

describe("runPrompt (C6)", () => {
  const building = {
    name: "building",
    requires: [
      { key: "non_empty_diff", description: "the run left a change" },
      { key: "tests_pass", description: "the tests pass" },
    ],
  };

  it("is the title, the body verbatim, and the column's instruction, in that order", () => {
    expect(
      runPrompt(
        {
          title: "Fix the login",
          body: "Users get a 500.\n\n  - repro: sign in\n",
        },
        building,
      ),
    ).toBe(
      "Fix the login\n\n" +
        "Users get a 500.\n\n  - repro: sign in\n\n" +
        "Work this card in the building column. It leaves the column only when each of these holds:\n" +
        "- non_empty_diff: the run left a change\n" +
        "- tests_pass: the tests pass",
    );
  });

  it("leaves out a body the card does not have, or that is only whitespace", () => {
    const column = { name: "specifying", requires: [] };
    const bare = runPrompt({ title: "T" }, column);
    expect(bare).toBe("T\n\nWork this card in the specifying column.");
    expect(runPrompt({ title: "T", body: " \n\t\n" }, column)).toBe(bare);
  });

  it("names no column the definition does not have", () => {
    expect(runPrompt({ title: "T", body: "B" }, undefined)).toBe("T\n\nB");
  });
});

describe("cards pinned to more than one version (D5)", () => {
  /** Mutation: count distinct versions against 1 instead of 2 — a board on one version gets a notice. */
  it("says nothing when every card pins one version, and names each version and its cards otherwise", () => {
    expect(pinnedVersionsNotice(3, [])).toBeNull();
    expect(
      pinnedVersionsNotice(3, [
        { definitionVersion: 2 },
        { definitionVersion: 2 },
      ]),
    ).toBeNull();
    expect(
      cardsByVersion([
        { definitionVersion: 3 },
        { definitionVersion: 2 },
        { definitionVersion: 3 },
      ]),
    ).toEqual([
      { version: 2, cards: 1 },
      { version: 3, cards: 2 },
    ]);
    expect(
      pinnedVersionsNotice(3, [
        { definitionVersion: 3 },
        { definitionVersion: 2 },
        { definitionVersion: 3 },
      ]),
    ).toBe(
      "This board's cards pin more than one version: 1 on v2, 2 on v3 (the board's). Each card moves by the version it pins.",
    );
  });
});
