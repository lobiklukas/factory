import type {
  SessionId as SessionIdType,
  SessionLive,
  SessionTask,
  TranscriptEntry,
} from "@repo/domain/Session";
import { SessionId } from "@repo/domain/Session";
import {
  Console,
  Duration,
  Effect,
  Option,
  Ref,
  Schedule,
  Schema,
} from "effect";
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
        "Entry id to fork at: the # in `factory watch|history --ids` lines, or the id `reset` prints (the last entry when absent)",
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

/**
 * Where a transcript ended when a command started: the id of its last entry, and every id the read
 * held.
 *
 * A reset or a compaction is recognised by position, not by "an entry I had not seen". The read a
 * command makes first can be the historical one (a session no process owns carries only its newest
 * `HISTORY_WINDOW` entries), while the read after the write is the live one, which carries the whole
 * transcript: an older `compaction` entry that was always there is absent from the first read and
 * present in the second, and an id-set test would take it for new. The last entry of a window is
 * still the transcript's newest, so everything after it in the live read is what came later.
 */
export type TranscriptAnchor = {
  readonly last: string | undefined;
  readonly seen: ReadonlySet<string>;
};

export const anchorOf = (
  entries: readonly TranscriptEntry[],
): TranscriptAnchor => ({
  last: entries.at(-1)?.id,
  seen: new Set(entries.map(({ id }) => id)),
});

/**
 * The first `kind` entry after the anchor: what a reset or a compaction just wrote. Absent when none
 * was written (yet) — which is not the same as it failing. The *first*, not the newest: a later one
 * is a later compaction (the harness's own threshold policy, say), not this command's.
 *
 * An anchor the read does not hold (it is not expected to happen: entries are only appended) falls
 * back to the ids the first read saw.
 */
export const firstEntryAfter = (
  entries: readonly TranscriptEntry[],
  kind: TranscriptEntry["kind"],
  anchor: TranscriptAnchor,
): TranscriptEntry | undefined => {
  const at =
    anchor.last === undefined
      ? -1
      : entries.findLastIndex((entry) => entry.id === anchor.last);
  const after =
    anchor.last !== undefined && at === -1
      ? entries.filter((entry) => !anchor.seen.has(entry.id))
      : entries.slice(at + 1);
  return after.find((entry) => entry.kind === kind);
};

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
      // The marker is read back as the first `reset` entry after the transcript's end as it is now,
      // so that end is noted first; the read also refuses an unknown id before anything is written.
      const before = yield* client.getSession({ sessionId });
      yield* client.resetSession({
        sessionId,
        ...Option.match(note, {
          onNone: () => ({}),
          onSome: (value) => ({ handoff: value }),
        }),
      });
      const after = yield* client.getSession({ sessionId });
      const marker = firstEntryAfter(
        after.entries,
        "reset",
        anchorOf(before.entries),
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

/** What the compaction wait reads of the session each time: its transcript, tasks and activity. */
export type CompactionReading = {
  readonly entries: readonly TranscriptEntry[];
  readonly tasks: readonly SessionTask[];
  readonly live: Pick<SessionLive, "busy">;
};

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
 * entry would wait forever. A summary after the anchor is the answer; with none, the task still
 * being in the live list is "running", and its absence is "nothing" (a settled task is absent from
 * `tasks`, not carried with a terminal status) — but only on an idle session. A busy session places
 * a summary at the end of its current turn, which can be long after the task left the list, so a
 * busy session with no summary is still "running". `apps/web/src/lib/compaction-view.ts` reads the
 * same signals.
 */
export const compactionVerdict = (
  reading: CompactionReading,
  anchor: TranscriptAnchor,
  taskId: string,
): CompactionVerdict => {
  const summary = firstEntryAfter(reading.entries, "compaction", anchor);
  if (summary !== undefined) return { state: "compacted", summary };
  return reading.live.busy || reading.tasks.some((task) => task.id === taskId)
    ? { state: "running" }
    : { state: "nothing" };
};

/**
 * Wait for the compaction to settle: its summary, or `undefined` when it wrote none.
 *
 * A "nothing" reading must hold on two reads in a row, and only an idle session can give one (see
 * `compactionVerdict`): `nothing to compact` printed above a summary the task then wrote would be
 * wrong. Past `wait` it fails as `CompactionPending`, because the task was admitted and
 * `factory watch` will show its summary — a timeout is a report of that, not of a failure to
 * compact.
 */
export const awaitCompaction = <E, R>(
  read: Effect.Effect<CompactionReading, E, R>,
  input: {
    readonly sessionId: string;
    readonly taskId: string;
    readonly anchor: TranscriptAnchor;
  },
  options: {
    readonly wait?: Duration.Input;
    readonly poll?: Duration.Input;
  } = {},
): Effect.Effect<TranscriptEntry | undefined, E | CompactionPending, R> =>
  Effect.gen(function* () {
    const wait = options.wait ?? COMPACTION_WAIT;
    const poll = options.poll ?? COMPACTION_POLL;
    const nothingOnce = yield* Ref.make(false);
    type Outcome =
      | { readonly settled: false }
      | {
          readonly settled: true;
          readonly summary: TranscriptEntry | undefined;
        };
    const step = Effect.gen(function* () {
      const verdict = compactionVerdict(
        yield* read,
        input.anchor,
        input.taskId,
      );
      const previouslyNothing = yield* Ref.getAndSet(
        nothingOnce,
        verdict.state === "nothing",
      );
      if (verdict.state === "compacted")
        return { settled: true, summary: verdict.summary } satisfies Outcome;
      if (verdict.state === "nothing" && previouslyNothing)
        return { settled: true, summary: undefined } satisfies Outcome;
      return { settled: false } satisfies Outcome;
    });
    const settled = yield* step.pipe(
      Effect.repeat({
        schedule: Schedule.spaced(poll),
        until: (outcome: Outcome) => outcome.settled,
      }),
      Effect.timeoutOption(wait),
    );
    if (Option.isNone(settled) || !settled.value.settled) {
      return yield* new CompactionPending({
        session: input.sessionId,
        task: input.taskId,
        message: `compaction ${input.taskId} was admitted but has not settled after ${Duration.format(Duration.fromInputUnsafe(wait))}; \`factory watch ${input.sessionId}\` shows its summary when it lands`,
      });
    }
    return settled.value.summary;
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
        anchor: anchorOf(before.entries),
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
