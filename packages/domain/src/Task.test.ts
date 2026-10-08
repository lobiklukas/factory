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
  BoardColumn,
  BoardDefinition,
  BoardInstance,
  BlockReason,
  ColumnKind,
  ColumnRequirement,
  DefinitionId,
  Task,
  TaskBlocked,
  TaskEvent,
  TaskId,
  TaskPriority,
  TaskRun,
  type BoardInstanceId,
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
   * `TaskEvent`'s six tags, and the two fields B5 says every move carries.
   *
   * B5: "Every move carries an **actor** and an expected **revision**". This is the case that proves
   * all six variants declare both, rather than the four that read as moves — a block and a comment
   * are moves too, and an event without an actor would break the audit trail `Task.ts:186` claims.
   *
   * The `task_events` table's `kind` column is what a writer would store, and it is unconstrained
   * `TEXT`: nothing in the database ties a row's `kind` to these six. That gap is recorded by the
   * case in `PostgresStorage.test.ts` that stores a column set the contract rejects; here the claim
   * is only that the *contract* has six and every one carries both fields.
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
        _tag: "priorityChanged",
        taskId: A_TASK_ID,
        from: "normal",
        to: "urgent",
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
    // A seventh tag is refused, so the set is closed at six.
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
