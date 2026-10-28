/**
 * The card's body in a run's prompt, at the harness seam (LOB-260; docs/board.md B1).
 *
 * The card is the control plane's; what is proven here is what the harness does with the string it
 * is handed: the committed `pi.system` entry carries it verbatim as the `task_body` section, beside
 * the thread, and a card with no body — empty or all whitespace — gets no section at all.
 * `packages/core`'s `cardBody.test.ts` drives the same path through a real card.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { TaskId } from "@repo/domain/Task";
import { DatabaseLive, PostgresStorage } from "@repo/storage-postgres";
import { Clock, Effect, ManagedRuntime, Random } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { THREAD_SECTION_KEY } from "./ask";
import { BODY_SECTION_KEY, renderBody } from "./body";
import { createFauxModelAccess } from "./models";
import {
  closeHarness,
  openSession,
  readPromptSections,
  submitMessage,
} from "./session";

const runtime = ManagedRuntime.make(DatabaseLive);
const workdir = mkdtempSync(join(tmpdir(), "factory-harness-body-"));

let sql: SqlClient;

beforeAll(async () => {
  sql = await runtime.runPromise(SqlClient);
}, 60_000);

afterAll(() => runtime.dispose());

const freshLogId = () =>
  `harness-body-${Effect.runSync(Random.nextIntBetween(0, 2 ** 31))}-${Effect.runSync(Clock.currentTimeMillis)}`;

/** Markdown with edges a trim would lose, so "verbatim" is a claim that can fail. */
const BODY =
  "  ## Goal\n\nWrite the release notes — **all** of them.\n\n- keep port 5442\n\n";

/** The prompt sections one request of a session opened with `body` committed. */
const sectionsOf = (options: { readonly body?: string; thread?: boolean }) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const faux = createFauxModelAccess({});
      const storage = yield* Effect.promise(() =>
        PostgresStorage.owner(sql, freshLogId()),
      );
      const { harness, root } = yield* openSession({
        storage,
        model: faux.access,
        cwd: workdir,
        ...(options.body === undefined ? {} : { body: options.body }),
        ...(options.thread === true
          ? {
              thread: () =>
                Promise.resolve([
                  {
                    taskId: TaskId.make(`tsk_${"0".repeat(26)}`),
                    kind: "note" as const,
                    actor: "person:lukas",
                    body: "a note",
                    revision: 2,
                    createdAt: "2026-10-28T00:00:00.000Z",
                  },
                ]),
            }
          : {}),
      });
      const submitted = yield* submitMessage(root, { content: "go" });
      yield* Effect.promise(() =>
        submitted.submission.wait(BACKGROUND_CONTEXT),
      );
      const sections = yield* readPromptSections(storage);
      yield* closeHarness(harness);
      yield* Effect.promise(() => storage.dispose());
      return sections;
    }),
  );

describe("renderBody", () => {
  /** Mutation: trim the body — the trailing blank lines and the leading spaces go. */
  it("quotes the body verbatim after its preamble", () => {
    const text = renderBody(BODY);
    expect(text).toBe(
      "The task this run works on, as it was filed, quoted verbatim. It is what the work is for: " +
        "read it before planning or changing anything, and treat the task's thread, when there is " +
        `one, as the later word on anything the two disagree about.\n\n${BODY}`,
    );
  });

  /** Mutation: test `body === ""` only — a whitespace body renders a preamble with nothing under it. */
  it("is no section at all for an absent, empty or all-whitespace body", () => {
    expect(renderBody(undefined)).toBeUndefined();
    expect(renderBody("")).toBeUndefined();
    expect(renderBody(" \n\t\n ")).toBeUndefined();
  });
});

describe("the body in a run's prompt", () => {
  /** Mutation: drop the install in `openSession` — the committed prompt has no `task_body`. */
  it("commits the body as the task_body section, beside the thread", async () => {
    const sections = await sectionsOf({ body: BODY, thread: true });
    expect(sections[BODY_SECTION_KEY]).toBe(
      `<${BODY_SECTION_KEY}>\n${renderBody(BODY) ?? ""}\n</${BODY_SECTION_KEY}>`,
    );
    expect(sections[THREAD_SECTION_KEY]).toContain("a note");
  }, 120_000);

  /** Mutation: drop the blank check in `renderBody` — an empty body commits a bare preamble. */
  it("carries no section for a card with an empty body, or none", async () => {
    for (const body of ["", "   \n", undefined]) {
      const sections = await sectionsOf(body === undefined ? {} : { body });
      expect(sections[BODY_SECTION_KEY]).toBeUndefined();
    }
  }, 120_000);
});
