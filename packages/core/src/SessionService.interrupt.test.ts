/**
 * Interrupting a session (C8): a busy run stops, the turn carries one `interrupted` entry, a later
 * message runs normally, and an interrupt with no run to stop is an answer (`not_running`) that
 * writes nothing and opens nothing — at capacity too, where an interrupt of work is never refused.
 *
 * The owner's model naps before each step of a turn, so a run is busy for several seconds — long
 * enough to interrupt mid-nap, and long enough that a run the interrupt missed would still go on to
 * call `bash` and print `faux-ok`.
 *
 * Postgres only, not mocked: `docker compose up -d --wait postgres`.
 */
import { BunServices } from "@effect/platform-bun";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SessionId,
  type SessionError,
  type SessionSnapshot,
} from "@repo/domain/Session";
import {
  createFauxModelAccess,
  FAUX_COMMAND,
  INTERRUPTED_TEXT,
} from "@repo/harness";
import { type BindableSandboxRuntimeShape, InProcess } from "@repo/sandbox";
import { DatabaseLive } from "@repo/storage-postgres";
import {
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  ManagedRuntime,
  Scope,
} from "effect";
import { afterAll, describe, expect, it } from "vitest";
import { SessionService, SessionServiceLive } from "./SessionService";

/** How long each step of a faux turn naps: the run is busy for about twice this. */
const SLEEP_MS = 1_500;

const runtime = ManagedRuntime.make(
  SessionServiceLive({
    model: createFauxModelAccess({ fauxSleepMs: SLEEP_MS }).access,
    sessionRoot: mkdtempSync(join(tmpdir(), "factory-core-interrupt-")),
  }).pipe(Layer.provideMerge(Layer.mergeAll(DatabaseLive, BunServices.layer))),
);

afterAll(async () => {
  await runtime.dispose();
});

const waitUntil = <E, R>(
  check: Effect.Effect<boolean, E, R>,
  label: string,
): Effect.Effect<void, E, R> =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      if (yield* check) return;
      yield* Effect.sleep(50);
    }
    return yield* Effect.die(new Error(`timed out waiting for ${label}`));
  });

/** What the faux command prints: present in a transcript only if its `bash` call ran. */
const FAUX_OUTPUT = FAUX_COMMAND.replace(/^echo /, "");

/** What the sleeping tool would print, had the interrupt missed it. */
const SLEPT = "slept-ok";

const printed = (snapshot: SessionSnapshot): boolean =>
  snapshot.entries.some((entry) => entry.text.includes(FAUX_OUTPUT));

/**
 * Whether the run is in its model request — where the faux model naps — rather than still preparing
 * it: Pi Durable's generation task commits the prompt in `prepare` and calls the model in `request`.
 */
const requesting = (snapshot: SessionSnapshot): boolean =>
  snapshot.live.busy &&
  snapshot.tasks.some(
    (task) => task.kind === "pi.generation" && task.phase === "request",
  );

describe("interrupting a session", () => {
  it("stops a busy run before it prints, marks the turn, and runs the next message", async () => {
    const outcome = await runtime.runPromise(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const created = yield* sessions.create({ title: "a run to stop" });
        yield* sessions.send({ sessionId: created.id, content: "go slowly" });
        // Mid-nap, not merely busy: a run is busy from its submission, before its model turn has
        // committed the prompt it is about to send, and an interrupt that lands in that window is
        // followed by the prompt's `pi.system` entry (`stopRun`: the marker is the turn's, not
        // necessarily its last entry).
        yield* waitUntil(
          sessions.get(created.id).pipe(Effect.map(requesting)),
          "the run's model request",
        );
        const interrupted = yield* sessions.interrupt(created.id);
        const right = yield* sessions.get(created.id);
        // Longer than both naps of the turn: a run the interrupt missed would have called `bash`
        // and answered by now.
        yield* Effect.sleep(SLEEP_MS * 2 + 500);
        const later = yield* sessions.get(created.id);

        yield* sessions.send({ sessionId: created.id, content: "now finish" });
        yield* waitUntil(
          sessions
            .get(created.id)
            .pipe(
              Effect.map(
                (snapshot) =>
                  !snapshot.live.busy &&
                  snapshot.entries.at(-1)?.kind === "assistant",
              ),
            ),
          "the follow-up to settle",
        );
        const followed = yield* sessions.get(created.id);
        return { interrupted, right, later, followed };
      }),
    );

    expect(outcome.interrupted.outcome).toBe("interrupted");
    expect(outcome.interrupted.session.status).toBe("idle");
    expect(outcome.interrupted.message).toContain("was interrupted");
    expect(outcome.right.live.busy).toBe(false);

    // The turn as the transcript tells it: the message, then the marker, and nothing the run would
    // have gone on to do.
    expect(printed(outcome.later)).toBe(false);
    expect(outcome.later.live.busy).toBe(false);
    const kinds = outcome.later.entries
      .filter((entry) => entry.kind === "user" || entry.kind === "interrupted")
      .map((entry) => entry.kind);
    expect(kinds).toEqual(["user", "interrupted"]);
    expect(outcome.later.entries.at(-1)).toMatchObject({
      kind: "interrupted",
      text: INTERRUPTED_TEXT,
    });

    // The follow-up is an ordinary run: it calls `bash`, which prints, and answers.
    expect(printed(outcome.followed)).toBe(true);
    const tail = outcome.followed.entries.at(-1);
    expect(tail?.kind).toBe("assistant");
    expect(tail?.text.length).toBeGreaterThan(0);
    expect(
      outcome.followed.entries.filter((entry) => entry.kind === "interrupted"),
    ).toHaveLength(1);
  }, 120_000);

  /**
   * The stop a user presses right after sending: the interrupt lands while the run's generation task
   * still prepares its request, not mid-nap — the window the case above used to land in at random,
   * leaving the prompt's `pi.system` entry after the marker (DEFLAKE). Here it is held open on
   * purpose: `prepare` awaits the session's execution environment, which is bound on first use, and
   * this runtime's sandbox will not bind until the test lets it. The run still stops and prints
   * nothing, the turn carries one marker, and the next message runs; what follows the marker is at
   * most the prompt `prepare` commits once it is let go, if it commits before the abort reaches it
   * (`stopRun`: the marker is the turn's, not necessarily its last entry) — never an answer or a
   * tool call.
   */
  it("stops a run interrupted while it prepares its request, and runs the next message", async () => {
    const sandboxScope = Scope.makeUnsafe();
    const inner = await Effect.runPromise(
      InProcess.make().pipe(Scope.provide(sandboxScope)),
    );
    // Armed once the session exists: only the run's first `prepare` waits for the test.
    const gate = Deferred.makeUnsafe<void>();
    let armed = false;
    let asked = false;
    const gated: BindableSandboxRuntimeShape = {
      ...inner,
      bind: (workdir, options) =>
        Effect.suspend(() => {
          if (!armed) return inner.bind(workdir, options);
          asked = true;
          return Deferred.await(gate).pipe(
            Effect.andThen(inner.bind(workdir, options)),
          );
        }),
    };
    const preparing = ManagedRuntime.make(
      SessionServiceLive({
        model: createFauxModelAccess({ fauxSleepMs: SLEEP_MS }).access,
        sessionRoot: mkdtempSync(
          join(tmpdir(), "factory-core-interrupt-prepare-"),
        ),
        sandbox: gated,
      }).pipe(
        Layer.provideMerge(Layer.mergeAll(DatabaseLive, BunServices.layer)),
      ),
    );
    try {
      const outcome = await preparing.runPromise(
        Effect.gen(function* () {
          const sessions = yield* SessionService;
          const created = yield* sessions.create({
            title: "a run stopped while it prepares",
          });
          armed = true;
          yield* sessions.send({
            sessionId: created.id,
            content: "go slowly",
          });
          // The run's `prepare` is waiting on the environment the sandbox has not bound.
          yield* waitUntil(
            Effect.sync(() => asked),
            "the run to ask for its environment",
          );
          const before = yield* sessions.get(created.id);
          // `stopRun` commits the marker, then aborts and waits for the run to settle — which it
          // cannot while `prepare` waits on the bind. So the bind is let go once the marker is in.
          const stopping = yield* Effect.forkChild(
            sessions.interrupt(created.id),
          );
          yield* waitUntil(
            sessions
              .get(created.id)
              .pipe(
                Effect.map((snapshot) =>
                  snapshot.entries.some(
                    (entry) => entry.kind === "interrupted",
                  ),
                ),
              ),
            "the interrupted marker",
          );
          yield* Deferred.succeed(gate, undefined);
          const interrupted = yield* Fiber.join(stopping);
          const right = yield* sessions.get(created.id);
          // Longer than both naps of the turn: a run the interrupt missed would have called `bash`
          // and answered by now.
          yield* Effect.sleep(SLEEP_MS * 2 + 500);
          const later = yield* sessions.get(created.id);

          yield* sessions.send({
            sessionId: created.id,
            content: "now finish",
          });
          yield* waitUntil(
            sessions
              .get(created.id)
              .pipe(
                Effect.map(
                  (snapshot) =>
                    !snapshot.live.busy &&
                    snapshot.entries.at(-1)?.kind === "assistant",
                ),
              ),
            "the follow-up to settle",
          );
          const followed = yield* sessions.get(created.id);
          yield* sessions.close;
          return { before, interrupted, right, later, followed };
        }),
      );

      // The interrupt landed in `prepare`: busy, its prompt not yet committed.
      expect(outcome.before.live.busy).toBe(true);
      expect(
        outcome.before.tasks.some(
          (task) => task.kind === "pi.generation" && task.phase === "prepare",
        ),
      ).toBe(true);
      expect(requesting(outcome.before)).toBe(false);
      expect(outcome.before.entries.map((entry) => entry.kind)).not.toContain(
        "system",
      );

      expect(outcome.interrupted.outcome).toBe("interrupted");
      expect(outcome.interrupted.session.status).toBe("idle");
      expect(outcome.right.live.busy).toBe(false);

      expect(printed(outcome.later)).toBe(false);
      expect(outcome.later.live.busy).toBe(false);
      const entries = outcome.later.entries;
      const kinds = entries
        .filter(
          (entry) => entry.kind === "user" || entry.kind === "interrupted",
        )
        .map((entry) => entry.kind);
      expect(kinds).toEqual(["user", "interrupted"]);
      const marker = entries.findIndex((entry) => entry.kind === "interrupted");
      expect(entries[marker]?.text).toBe(INTERRUPTED_TEXT);
      // After the marker: at most the prompt `prepare` commits once let go, if it gets there before
      // the abort — no answer, no tool call.
      const after = entries.slice(marker + 1).map((entry) => entry.kind);
      expect(after.filter((kind) => kind !== "system")).toEqual([]);
      expect(entries.some((entry) => entry.kind === "assistant")).toBe(false);

      // The follow-up is an ordinary run: it calls `bash`, which prints, and answers.
      expect(printed(outcome.followed)).toBe(true);
      const tail = outcome.followed.entries.at(-1);
      expect(tail?.kind).toBe("assistant");
      expect(tail?.text.length).toBeGreaterThan(0);
      expect(
        outcome.followed.entries.filter(
          (entry) => entry.kind === "interrupted",
        ),
      ).toHaveLength(1);
    } finally {
      Deferred.doneUnsafe(gate, Exit.void);
      await preparing.dispose();
      await Effect.runPromise(Scope.close(sandboxScope, Exit.void));
    }
  }, 120_000);

  it("answers not_running for an idle session, and writes nothing", async () => {
    const outcome = await runtime.runPromise(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const created = yield* sessions.create({ title: "nothing to stop" });
        const before = yield* sessions.get(created.id);
        const answer = yield* sessions.interrupt(created.id);
        const after = yield* sessions.get(created.id);
        return { created, answer, before, after };
      }),
    );

    expect(outcome.answer.outcome).toBe("not_running");
    expect(outcome.answer.session.status).toBe("idle");
    expect(outcome.answer.message).toBe(
      `session ${outcome.created.id} is not running: there was no run to interrupt`,
    );
    expect(outcome.after.entries).toEqual(outcome.before.entries);
  }, 120_000);

  it("marks a run stopped mid tool call once, however many interrupts overlap, with the call's result after the marker", async () => {
    // A `bash` call that sleeps: the interrupt lands while the tool runs, not while the model naps.
    const tooling = ManagedRuntime.make(
      SessionServiceLive({
        model: createFauxModelAccess({
          fauxCommand: `sleep 20 && echo ${SLEPT}`,
        }).access,
        sessionRoot: mkdtempSync(
          join(tmpdir(), "factory-core-interrupt-tool-"),
        ),
      }).pipe(
        Layer.provideMerge(Layer.mergeAll(DatabaseLive, BunServices.layer)),
      ),
    );
    try {
      const outcome = await tooling.runPromise(
        Effect.gen(function* () {
          const sessions = yield* SessionService;
          const created = yield* sessions.create({ title: "a tool to stop" });
          yield* sessions.send({ sessionId: created.id, content: "sleep" });
          yield* waitUntil(
            sessions
              .get(created.id)
              .pipe(
                Effect.map((snapshot) =>
                  snapshot.live.tools.some((tool) => tool.status === "running"),
                ),
              ),
            "the bash call to start",
          );
          // The dashboard and `factory interrupt` at once: both answer, one marker is written.
          const answers = yield* Effect.all(
            [sessions.interrupt(created.id), sessions.interrupt(created.id)],
            { concurrency: "unbounded" },
          );
          const again = yield* sessions.interrupt(created.id);
          const stopped = yield* sessions.get(created.id);
          yield* sessions.close;
          return { answers, again, stopped };
        }),
      );

      expect(outcome.answers.map((answer) => answer.outcome)).toContain(
        "interrupted",
      );
      expect(outcome.again.outcome).toBe("not_running");
      expect(outcome.stopped.live.busy).toBe(false);
      const entries = outcome.stopped.entries;
      expect(entries.some((entry) => entry.text.includes(SLEPT))).toBe(false);
      const markers = entries.filter((entry) => entry.kind === "interrupted");
      expect(markers).toHaveLength(1);
      // The marker is committed before the abort, so the call the abort stopped settles after it:
      // what follows the marker is that call's result, and no answer.
      const after = entries
        .slice(entries.findIndex((entry) => entry.kind === "interrupted") + 1)
        .map((entry) => entry.kind);
      expect(after).not.toContain("assistant");
      expect(after).toContain("toolResult");
    } finally {
      await tooling.dispose();
    }
  }, 120_000);

  it("is never refused at capacity: an idle session answers not_running unopened, and a paused run is stopped", async () => {
    const capped = ManagedRuntime.make(
      SessionServiceLive({
        model: createFauxModelAccess({ fauxSleepMs: SLEEP_MS }).access,
        sessionRoot: mkdtempSync(join(tmpdir(), "factory-core-interrupt-cap-")),
        maxConcurrentSessions: 1,
      }).pipe(
        Layer.provideMerge(Layer.mergeAll(DatabaseLive, BunServices.layer)),
      ),
    );
    try {
      const outcome = await capped.runPromise(
        Effect.gen(function* () {
          const sessions = yield* SessionService;
          const idle = yield* sessions.create({ title: "idle at capacity" });
          yield* sessions.close;
          // A run the close left placed and unanswered: what a dead process leaves (LOB-25).
          const paused = yield* sessions.create({
            title: "paused at capacity",
          });
          yield* sessions.send({ sessionId: paused.id, content: "go slowly" });
          yield* waitUntil(
            sessions
              .get(paused.id)
              .pipe(Effect.map((snapshot) => snapshot.live.busy)),
            "the run to start",
          );
          yield* sessions.close;
          // The one slot taken by another session.
          yield* sessions.create({ title: "the slot's holder" });
          const refused = yield* Effect.exit(
            sessions.create({ title: "one too many" }),
          );

          const idleAnswer = yield* sessions.interrupt(idle.id);
          const pausedAnswer = yield* sessions.interrupt(paused.id);
          yield* Effect.sleep(SLEEP_MS * 2 + 500);
          const stopped = yield* sessions.get(paused.id);
          yield* sessions.close;
          return { refused, idleAnswer, pausedAnswer, stopped };
        }),
      );

      // The server is full: a create is refused, an interrupt is not.
      expect(Exit.isFailure(outcome.refused)).toBe(true);
      expect(outcome.idleAnswer.outcome).toBe("not_running");
      // Answered from the committed log: no owner was opened to say so.
      expect(outcome.idleAnswer.session.mode).toBe("historical");
      expect(outcome.pausedAnswer.outcome).toBe("interrupted");
      expect(outcome.stopped.live.busy).toBe(false);
      expect(printed(outcome.stopped)).toBe(false);
      expect(
        outcome.stopped.entries.filter((entry) => entry.kind === "interrupted"),
      ).toHaveLength(1);
    } finally {
      await capped.dispose();
    }
  }, 120_000);

  it("fails not_found for a session that does not exist", async () => {
    const exit = await runtime.runPromise(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        return yield* Effect.exit(
          sessions.interrupt(SessionId.make("ses_00000000000000000000000000")),
        );
      }),
    );
    const error: SessionError | undefined =
      Exit.isFailure(exit) && exit.cause.reasons[0]?._tag === "Fail"
        ? exit.cause.reasons[0].error
        : undefined;
    expect(error?.code).toBe("not_found");
  }, 120_000);
});
