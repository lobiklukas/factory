/**
 * Interrupting a session (C8): a busy run stops, the transcript ends the turn with an `interrupted`
 * entry, a later message runs normally, and an interrupt with no run to stop is an answer
 * (`not_running`) that writes nothing.
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
import { DatabaseLive } from "@repo/storage-postgres";
import { Effect, Exit, Layer, ManagedRuntime } from "effect";
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

const printed = (snapshot: SessionSnapshot): boolean =>
  snapshot.entries.some((entry) => entry.text.includes(FAUX_OUTPUT));

describe("interrupting a session", () => {
  it("stops a busy run before it prints, marks the turn, and runs the next message", async () => {
    const outcome = await runtime.runPromise(
      Effect.gen(function* () {
        const sessions = yield* SessionService;
        const created = yield* sessions.create({ title: "a run to stop" });
        yield* sessions.send({ sessionId: created.id, content: "go slowly" });
        yield* waitUntil(
          sessions
            .get(created.id)
            .pipe(Effect.map((snapshot) => snapshot.live.busy)),
          "the run to start",
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
