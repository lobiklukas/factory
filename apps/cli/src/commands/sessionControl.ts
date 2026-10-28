import type {
  SessionId as SessionIdType,
  SessionTask,
  TranscriptEntry,
} from "@repo/domain/Session";
import { SessionId } from "@repo/domain/Session";
import { Console, Duration, Effect, Option, Schema } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { resolveApiUrl } from "../api";
import { reportFailures } from "../errors";
import { SessionClient } from "../rpc";
import { formatEntry } from "../transcript";

/**
 * `factory fork`, `factory reset` and `factory compact` — the session controls the dashboard has
 * (`forkSessionAtom`, the Reset and Compact buttons), from a terminal. Each is one RPC and a line a
 * script can read; none of them follows the session (`factory watch` does that). An id the control
 * plane does not know is its own `not_found`, printed as that word with a non-zero exit like every
 * other command (`errors.ts`).
 */

const apiFlag = Flag.String("api").pipe(
  Flag.withDescription("Control plane base URL"),
  Flag.optional,
);

const sessionIdArgument = (description: string) =>
  Argument.String("session-id").pipe(
    Argument.withDescription(description),
    Argument.withSchema(SessionId),
  );

/** The line `factory fork` prints: the child first, as `factory replay` names its replay. */
export const forkLine = (
  child: SessionIdType,
  parent: SessionIdType,
  at: string | undefined,
): string =>
  `fork ${child} of ${parent}${at === undefined ? "" : ` at entry ${at}`}`;

/**
 * `factory fork <session-id> [--at <entry>]` — a new session whose transcript is the parent's up to
 * `--at` (its last entry when absent), then its own. Prints the child's id; the parent is only read.
 * An entry the parent does not have is the server's `invalid_input`.
 */
export const forkCommand = Command.make(
  "fork",
  {
    sessionId: sessionIdArgument("Session to fork"),
    at: Flag.String("at").pipe(
      Flag.withDescription(
        "Entry to fork at, as the transcript names it (the last entry when absent)",
      ),
      Flag.optional,
    ),
    api: apiFlag,
  },
  Effect.fnUntraced(function* ({ sessionId, at, api }) {
    const apiUrl = yield* resolveApiUrl(api);
    const program = Effect.gen(function* () {
      const { client } = yield* SessionClient;
      const child = yield* client.forkSession({
        sessionId,
        ...Option.match(at, {
          onNone: () => ({}),
          onSome: (value) => ({ at: value }),
        }),
      });
      yield* Console.log(
        forkLine(child.id, sessionId, Option.getOrUndefined(at)),
      );
    });
    yield* reportFailures(Effect.provide(program, SessionClient.layer(apiUrl)));
  }),
).pipe(
  Command.withDescription(
    "Fork a session: a new session that starts from the parent's transcript",
  ),
  Command.withExamples([
    {
      command: "factory fork ses_00000000000000000000000000",
      description: "Fork at the parent's last entry and print the child's id",
    },
    {
      command: "factory fork ses_00000000000000000000000000 --at 7",
      description: "Undo everything after entry 7 in a new session",
    },
  ]),
);

/** The ids of the `kind` entries a transcript already holds, to tell a new one from an old one. */
export const entryIds = (
  entries: readonly TranscriptEntry[],
  kind: TranscriptEntry["kind"],
): ReadonlySet<string> =>
  new Set(entries.filter((entry) => entry.kind === kind).map(({ id }) => id));

/**
 * The newest `kind` entry that was not in `before`: what a reset or a compaction just wrote.
 * Absent when none was written (yet) — which is not the same as it failing.
 */
export const newestEntryOf = (
  entries: readonly TranscriptEntry[],
  kind: TranscriptEntry["kind"],
  before: ReadonlySet<string>,
): TranscriptEntry | undefined =>
  entries.findLast((entry) => entry.kind === kind && !before.has(entry.id));

/**
 * What `factory reset` prints: the marker's entry id, then the marker as the transcript shows it
 * (`[reset] <handoff>`) when it carries a handoff. A reset with no marker yet is one admitted into a
 * running session, which Pi Durable places at the run's next boundary.
 */
export const resetLines = (
  sessionId: SessionIdType,
  marker: TranscriptEntry | undefined,
): readonly string[] =>
  marker === undefined
    ? [
        `reset ${sessionId} admitted; the marker is placed at the run's next boundary`,
      ]
    : [
        `reset ${sessionId} marker ${marker.id}`,
        ...(marker.text.trim() === "" ? [] : [formatEntry(marker)]),
      ];

/**
 * `factory reset <session-id> [--note <handoff>]` — start a new model context. The transcript keeps
 * the turns before it and gains a `reset` entry; `--note` is the handoff the new context opens with.
 */
export const resetCommand = Command.make(
  "reset",
  {
    sessionId: sessionIdArgument("Session to reset"),
    note: Flag.String("note").pipe(
      Flag.withDescription(
        "Handoff the new context opens with, as its first message (a context that opens empty when absent)",
      ),
      Flag.optional,
    ),
    api: apiFlag,
  },
  Effect.fnUntraced(function* ({ sessionId, note, api }) {
    const apiUrl = yield* resolveApiUrl(api);
    const program = Effect.gen(function* () {
      const { client } = yield* SessionClient;
      // The marker is read back as the new `reset` entry, so the entries already there are noted
      // first; the read also refuses an unknown id before anything is written.
      const before = yield* client.getSession({ sessionId });
      yield* client.resetSession({
        sessionId,
        ...Option.match(note, {
          onNone: () => ({}),
          onSome: (value) => ({ handoff: value }),
        }),
      });
      const after = yield* client.getSession({ sessionId });
      const marker = newestEntryOf(
        after.entries,
        "reset",
        entryIds(before.entries, "reset"),
      );
      for (const line of resetLines(sessionId, marker)) {
        yield* Console.log(line);
      }
    });
    yield* reportFailures(Effect.provide(program, SessionClient.layer(apiUrl)));
  }),
).pipe(
  Command.withDescription(
    "Start a new model context, keeping the transcript and marking where it began",
  ),
  Command.withExamples([
    {
      command:
        'factory reset ses_00000000000000000000000000 --note "we were fixing the flaky login test"',
      description: "Hand the fresh context a summary of where things stood",
    },
  ]),
);

/** What `factory compact` prints when the compaction wrote no summary. */
export const NOTHING_TO_COMPACT = "nothing to compact";

/** The compaction was admitted but has not settled after the wait (see `awaitCompaction`). */
export class CompactionPending extends Schema.TaggedError<CompactionPending>()(
  "CompactionPending",
  { session: Schema.String, task: Schema.String, message: Schema.String },
) {}

/** How long the CLI waits for the summarizer: a real model call, so far longer than a read. */
export const COMPACTION_WAIT = Duration.seconds(120);
const COMPACTION_POLL = Duration.millis(250);

/** What a reading of the session says about the compaction task that was admitted. */
export type CompactionVerdict =
  | { readonly state: "running" }
  | { readonly state: "compacted"; readonly summary: TranscriptEntry }
  | { readonly state: "nothing" };

/**
 * Whether the compaction task has settled, and what it wrote.
 *
 * `compactSession` answers a task id and nothing else, and Pi Durable keeps the newest tokens
 * verbatim, so a transcript with no cut settles the task and writes no summary: waiting for an
 * entry would wait forever. A summary newer than `before` is the answer; with none, the task still
 * being in the live list is "running", and its absence is "nothing" (a settled task is absent from
 * `tasks`, not carried with a terminal status). `apps/web/src/lib/compaction-view.ts` reads the
 * same two signals.
 */
export const compactionVerdict = (
  reading: {
    readonly entries: readonly TranscriptEntry[];
    readonly tasks: readonly SessionTask[];
  },
  before: ReadonlySet<string>,
  taskId: string,
): CompactionVerdict => {
  const summary = newestEntryOf(reading.entries, "compaction", before);
  if (summary !== undefined) return { state: "compacted", summary };
  return reading.tasks.some((task) => task.id === taskId)
    ? { state: "running" }
    : { state: "nothing" };
};

/**
 * Wait for the compaction to settle: its summary, or `undefined` when it wrote none.
 *
 * A "nothing" reading must hold on two reads in a row: a summary placed at a busy session's next
 * boundary can trail the task leaving the list, and `nothing to compact` printed above a summary the
 * task then wrote would be wrong. Past `wait` it fails as `CompactionPending`, because the task was
 * admitted and `factory watch` will show its summary — a timeout is a report of that, not of a
 * failure to compact.
 */
export const awaitCompaction = <E, R>(
  read: Effect.Effect<
    {
      readonly entries: readonly TranscriptEntry[];
      readonly tasks: readonly SessionTask[];
    },
    E,
    R
  >,
  input: {
    readonly sessionId: string;
    readonly taskId: string;
    readonly before: ReadonlySet<string>;
  },
  options: {
    readonly wait?: Duration.Input;
    readonly poll?: Duration.Input;
  } = {},
): Effect.Effect<TranscriptEntry | undefined, E | CompactionPending, R> =>
  Effect.gen(function* () {
    const wait = options.wait ?? COMPACTION_WAIT;
    const poll = options.poll ?? COMPACTION_POLL;
    const settled = yield* Effect.gen(function* () {
      let nothingOnce = false;
      for (;;) {
        const verdict = compactionVerdict(
          yield* read,
          input.before,
          input.taskId,
        );
        if (verdict.state === "compacted") return verdict.summary;
        if (verdict.state === "nothing") {
          if (nothingOnce) return undefined;
          nothingOnce = true;
        } else {
          nothingOnce = false;
        }
        yield* Effect.sleep(poll);
      }
    }).pipe(Effect.timeoutOption(wait));
    if (Option.isNone(settled)) {
      return yield* new CompactionPending({
        session: input.sessionId,
        task: input.taskId,
        message: `compaction ${input.taskId} was admitted but has not settled after ${Duration.format(Duration.fromInputUnsafe(wait))}; \`factory watch ${input.sessionId}\` shows its summary when it lands`,
      });
    }
    return settled.value;
  });

/**
 * `factory compact <session-id> [--instructions <focus>]` — summarize the old part of the model
 * context now. Waits for the task to settle, then prints the summary as the transcript shows it
 * (`[compaction] …`), or `nothing to compact`. Every entry the summary stands in for stays in the
 * transcript.
 */
export const compactCommand = Command.make(
  "compact",
  {
    sessionId: sessionIdArgument("Session to compact"),
    instructions: Flag.String("instructions").pipe(
      Flag.withDescription("What the summarizer should focus on"),
      Flag.optional,
    ),
    api: apiFlag,
  },
  Effect.fnUntraced(function* ({ sessionId, instructions, api }) {
    const apiUrl = yield* resolveApiUrl(api);
    const program = Effect.gen(function* () {
      const { client } = yield* SessionClient;
      const before = yield* client.getSession({ sessionId });
      const admitted = yield* client.compactSession({
        sessionId,
        ...Option.match(instructions, {
          onNone: () => ({}),
          onSome: (value) => ({ instructions: value }),
        }),
      });
      const summary = yield* awaitCompaction(client.getSession({ sessionId }), {
        sessionId,
        taskId: admitted.taskId,
        before: entryIds(before.entries, "compaction"),
      });
      yield* Console.log(
        summary === undefined ? NOTHING_TO_COMPACT : formatEntry(summary),
      );
    });
    yield* reportFailures(Effect.provide(program, SessionClient.layer(apiUrl)));
  }),
).pipe(
  Command.withDescription(
    "Compact a session's model context and print the summary it wrote",
  ),
  Command.withExamples([
    {
      command:
        'factory compact ses_00000000000000000000000000 --instructions "keep the failing test"',
      description: "Summarize the old context, steering the summarizer",
    },
  ]),
);
