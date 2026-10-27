/**
 * The reviewer's `review` tool, at the harness seam (LOB-36).
 *
 * The PR and its comment are the control plane's; what is proven here is what the harness does with
 * the callback it is handed. A reviewer run in a real git checkout — a base commit on `main` and a
 * head that changes one file — reads the diff with `bash` and calls the tool: a seeded bug is one
 * post naming the file and the mechanism, a clean change is no post, the rubric and the diff refuse
 * a review that does not hold together (nothing committed, nothing posted, and the run retries), a PR
 * that moved on is not posted to, and no other run is offered the tool. `packages/core`'s suite drives
 * the same path from the `pull_request` event through a real card.
 *
 * No database: Pi Durable's in-memory storage and the faux provider, so this runs in the default gate.
 * Each case runs a whole session in a fresh checkout, so the cases that do are given a minute rather
 * than vitest's five seconds: `bun run test` runs every package at once.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolCall } from "@earendil-works/pi-ai";
import { MemoryStorage } from "@earendil-works/pi-durable";
import type { TranscriptEntry } from "@repo/domain/Session";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { RunProfile } from "./loader";
import { createFauxModelAccess, type FauxSpecAttempt } from "./models";
import { decideStageCall, readOnlyStageOf } from "./policy";
import {
  REVIEW_TOOL,
  renderReview,
  reviewMarker,
  type ReviewOptions,
  type ReviewPosted,
  type ReviewTarget,
} from "./review";
import {
  closeHarness,
  isBusy,
  openSession,
  readOfferedTools,
  readRecordedReview,
  readSessionLog,
  submitMessage,
  writeReviewTarget,
} from "./session";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    stdio: "pipe",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  })
    .toString()
    .trim();

/**
 * A checkout whose `HEAD` is the PR's head: `main` holds `src/sum.ts` and `README.md`, and the head
 * commit changes `src/sum.ts` alone — the one file a finding may name.
 */
const checkout = (): { readonly cwd: string; readonly head: string } => {
  const cwd = mkdtempSync(join(tmpdir(), "factory-review-"));
  git(cwd, "init", "-q", "-b", "main");
  mkdirSync(join(cwd, "src"));
  writeFileSync(
    join(cwd, "src/sum.ts"),
    "export const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);\n",
  );
  writeFileSync(join(cwd, "README.md"), "# sum\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-q", "-m", "base");
  git(cwd, "checkout", "-q", "-b", "feature");
  writeFileSync(
    join(cwd, "src/sum.ts"),
    "export const sum = (xs: number[]) => xs.slice(1).reduce((a, b) => a + b, 0);\n",
  );
  git(cwd, "commit", "-q", "-am", "skip the first element");
  return { cwd, head: git(cwd, "rev-parse", "HEAD") };
};

const targetAt = (head: string): ReviewTarget => ({
  repo: "acme/sum",
  number: 7,
  url: "https://github.com/acme/sum/pull/7",
  base: "main",
  head,
});

const passing = { verdict: "pass", findings: [] };

/** Every dimension passing, as a plain object a case can spread one dimension over. */
const ALL_PASS = {
  correctness: passing,
  security: passing,
  tests: passing,
  performance: passing,
};

/** The seeded bug, found: a P0 correctness finding naming the changed file and the mechanism. */
const MECHANISM =
  "`xs.slice(1)` drops the first element before summing, so sum([5]) is 0 and every total is short by xs[0]";
const BUG_DIMENSIONS = {
  ...ALL_PASS,
  correctness: {
    verdict: "fail",
    findings: [
      { severity: "P0", file: "src/sum.ts", line: 1, mechanism: MECHANISM },
    ],
  },
};
const BUG: FauxSpecAttempt = {
  summary: "Changes how sum folds its input.",
  dimensions: BUG_DIMENSIONS,
};

const CLEAN: FauxSpecAttempt = {
  summary: "Nothing to flag.",
  dimensions: ALL_PASS,
};

/** A review run: opened for a PR (`reviewing`), in the card's reviewer column. */
const reviewer: RunProfile = {
  column: "review",
  role: "reviewer",
  skills: [],
  reviewing: true,
};

/** A poster that records what it was handed and answers as the case chose. */
const recorder = (
  answer: (target: ReviewTarget) => ReviewPosted = (target) => ({
    _tag: "posted",
    url: `${target.url}#pullrequestreview-1`,
  }),
) => {
  const posts: { target: ReviewTarget; body: string; marker: string }[] = [];
  const options: ReviewOptions = {
    post: (request) => {
      posts.push(request);
      return Promise.resolve(answer(request.target));
    },
  };
  return { posts, options };
};

/** One reviewer run, settled: its log, its recorded review, what it was offered. */
const reviewOnce = (options: {
  readonly run?: RunProfile;
  readonly review?: ReviewOptions;
  readonly attempts: readonly FauxSpecAttempt[];
  /** Write no target, as for a run opened for no pull request. */
  readonly untargeted?: boolean;
  /** Send a second message after the first turn settles, so the reviewer reviews again. */
  readonly again?: boolean;
}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const repo = checkout();
      const faux = createFauxModelAccess({
        fauxCommand: "git diff --stat main...HEAD",
        fauxReview: options.attempts,
      });
      const storage = new MemoryStorage();
      const { harness, root } = yield* openSession({
        storage,
        model: faux.access,
        cwd: repo.cwd,
        ...(options.run === undefined ? {} : { run: options.run }),
        ...(options.review === undefined ? {} : { review: options.review }),
      });
      const target = targetAt(repo.head);
      if (options.untargeted !== true) yield* writeReviewTarget(root, target);
      const submitted = yield* submitMessage(root, {
        content: "review pull request #7",
      });
      yield* Effect.promise(() =>
        submitted.submission.wait(BACKGROUND_CONTEXT),
      );
      if (options.again === true) {
        const second = yield* submitMessage(root, {
          content: "review it again",
        });
        yield* Effect.promise(() => second.submission.wait(BACKGROUND_CONTEXT));
      }
      const busy = yield* isBusy(harness, root);
      const recorded = yield* readRecordedReview(storage);
      const log = yield* readSessionLog(storage);
      const offered = yield* readOfferedTools(storage);
      yield* closeHarness(harness);
      return { busy, recorded, offered, entries: log.entries, target };
    }),
  );

const reviewResults = (entries: ReadonlyArray<TranscriptEntry>) =>
  entries.filter(
    (entry) => entry.kind === "toolResult" && entry.toolName === REVIEW_TOOL,
  );

describe("the review tool", { timeout: 60_000 }, () => {
  it("posts one comment on a seeded bug, naming the file and the mechanism", async () => {
    const { posts, options } = recorder();
    const ran = await reviewOnce({
      run: reviewer,
      review: options,
      attempts: [BUG],
    });

    expect(ran.offered).toContain(REVIEW_TOOL);
    expect(posts).toHaveLength(1);
    const post = posts[0];
    expect(post?.target).toEqual(ran.target);
    expect(post?.marker).toBe(reviewMarker(ran.target));
    expect(post?.body.startsWith(reviewMarker(ran.target))).toBe(true);
    expect(post?.body).toContain("`src/sum.ts:1`");
    expect(post?.body).toContain(MECHANISM);
    expect(post?.body).toContain("| correctness | fail | 1 P0 |");
    expect(post?.body).toContain("| security | pass | none |");
    expect(post?.body).toContain("changes needed");
    expect(ran.recorded).toEqual({
      target: ran.target,
      verdict: "fail",
      outcome: "posted",
      outcomeDetail: `${ran.target.url}#pullrequestreview-1`,
    });
    const results = reviewResults(ran.entries);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ isError: false });
    expect(results[0]?.text).toContain("Posted on the pull request");
    expect(ran.busy).toBe(false);
  });

  it("posts nothing on a clean change, and records the clean verdict", async () => {
    const { posts, options } = recorder();
    const ran = await reviewOnce({
      run: reviewer,
      review: options,
      attempts: [CLEAN],
    });

    expect(posts).toHaveLength(0);
    expect(ran.recorded).toEqual({
      target: ran.target,
      verdict: "pass",
      outcome: "clean",
      outcomeDetail: "",
    });
    expect(reviewResults(ran.entries)[0]?.text).toContain(
      "a clean pull request gets no comment",
    );
  });

  it("refuses a verdict the rubric contradicts, and the run retries", async () => {
    const { posts, options } = recorder();
    const failsOnNothing: FauxSpecAttempt = {
      ...CLEAN,
      dimensions: {
        ...ALL_PASS,
        tests: { verdict: "fail", findings: [] },
      },
    };
    const passesOverP1: FauxSpecAttempt = {
      ...CLEAN,
      dimensions: {
        ...ALL_PASS,
        security: {
          verdict: "pass",
          findings: [
            { severity: "P1", file: "src/sum.ts", mechanism: "something" },
          ],
        },
      },
    };
    const ran = await reviewOnce({
      run: reviewer,
      review: options,
      attempts: [failsOnNothing, passesOverP1, BUG],
    });

    const results = reviewResults(ran.entries);
    expect(results.map((result) => result.isError)).toEqual([
      true,
      true,
      false,
    ]);
    expect(results[0]?.text).toContain(
      "`dimensions.tests` fails with no P0 or P1 finding",
    );
    expect(results[1]?.text).toContain(
      "`dimensions.security` passes over a P1 finding",
    );
    expect(posts).toHaveLength(1);
    expect(ran.recorded?.verdict).toBe("fail");
  });

  it("refuses a finding on a file the pull request does not change, and a missing dimension", async () => {
    const { posts, options } = recorder();
    const stray: FauxSpecAttempt = {
      ...BUG,
      dimensions: {
        ...BUG_DIMENSIONS,
        correctness: {
          verdict: "fail",
          findings: [
            { severity: "P0", file: "README.md", mechanism: MECHANISM },
          ],
        },
      },
    };
    const { performance: _omitted, ...three } = ALL_PASS;
    const ran = await reviewOnce({
      run: reviewer,
      review: options,
      attempts: [stray, { ...CLEAN, dimensions: three }],
    });

    const results = reviewResults(ran.entries);
    expect(results.map((result) => result.isError)).toEqual([true, true]);
    expect(results[0]?.text).toContain(
      "a correctness finding names README.md, which this pull request does not change (it changes src/sum.ts)",
    );
    expect(results[1]?.text).toContain("performance");
    // Nothing was committed or posted: the log still holds the target alone.
    expect(posts).toHaveLength(0);
    expect(ran.recorded).toEqual({ target: ran.target });
  });

  it("posts nothing when the pull request moved past the reviewed head", async () => {
    const { posts, options } = recorder(() => ({
      _tag: "stale",
      head: "f".repeat(40),
    }));
    const ran = await reviewOnce({
      run: reviewer,
      review: options,
      attempts: [BUG],
    });

    expect(posts).toHaveLength(1);
    expect(ran.recorded).toMatchObject({
      verdict: "fail",
      outcome: "stale",
      outcomeDetail: "f".repeat(40),
    });
    expect(reviewResults(ran.entries)[0]?.text).toContain(
      "this verdict is stale",
    );
  });

  it("reports a post that failed as the tool's error, with the verdict unposted in the log", async () => {
    const ran = await reviewOnce({
      run: reviewer,
      review: {
        post: () => Promise.reject(new Error("no reviewer credential")),
      },
      attempts: [BUG],
    });

    const results = reviewResults(ran.entries);
    expect(results[0]).toMatchObject({ isError: true });
    expect(results[0]?.text).toContain("no reviewer credential");
    expect(ran.recorded).toMatchObject({
      verdict: "fail",
      outcome: "unposted",
    });
  });

  it("refuses a second review once the first settled: one run reviews one head once", async () => {
    const { posts, options } = recorder();
    const ran = await reviewOnce({
      run: reviewer,
      review: options,
      attempts: [BUG],
      again: true,
    });

    const results = reviewResults(ran.entries);
    expect(results.map((result) => result.isError)).toEqual([false, true]);
    expect(results[1]?.text).toContain(
      "this run already recorded its review of",
    );
    expect(results[1]?.text).toContain("a new commit is reviewed by a new run");
    expect(posts).toHaveLength(1);
    expect(ran.recorded?.outcome).toBe("posted");
  });

  it("lets a run whose post failed review again, and posts once", async () => {
    let calls = 0;
    const posts: string[] = [];
    const ran = await reviewOnce({
      run: reviewer,
      review: {
        post: (request) => {
          calls += 1;
          if (calls === 1)
            return Promise.reject(new Error("GitHub answered HTTP 502"));
          posts.push(request.body);
          return Promise.resolve({
            _tag: "posted",
            url: "https://example.test/r/1",
          });
        },
      },
      attempts: [BUG],
      again: true,
    });

    expect(reviewResults(ran.entries).map((result) => result.isError)).toEqual([
      true,
      false,
    ]);
    expect(posts).toHaveLength(1);
    expect(ran.recorded).toMatchObject({ outcome: "posted" });
  });

  it("refuses to review when the run names no pull request", async () => {
    const { posts, options } = recorder();
    const ran = await reviewOnce({
      run: reviewer,
      review: options,
      attempts: [CLEAN],
      untargeted: true,
    });
    expect(reviewResults(ran.entries)[0]?.text).toContain(
      "this run was opened for no pull request",
    );
    expect(posts).toHaveLength(0);
    expect(ran.recorded).toBeUndefined();
  });
});

describe("who is offered the review tool", { timeout: 60_000 }, () => {
  it("is not offered to a run that is not a review, nor to a review with nowhere to post", async () => {
    const { posts, options } = recorder();
    for (const run of [
      { column: "building", role: "builder", skills: [] },
      { column: "specifying", role: "specifier", skills: [] },
      // A person's run in the review column is not a review: it is offered no review tool, and it
      // is not read-only either (a fix-up that changes and verifies, B8).
      { column: "review", role: "reviewer", skills: [] },
      undefined,
    ] satisfies (RunProfile | undefined)[]) {
      const ran = await reviewOnce({
        ...(run === undefined ? {} : { run }),
        review: options,
        attempts: [BUG],
      });
      expect(ran.offered).not.toContain(REVIEW_TOOL);
      expect(reviewResults(ran.entries)).toHaveLength(0);
    }
    expect(
      readOnlyStageOf({ column: "review", role: "reviewer" }),
    ).toBeUndefined();
    const unwired = await reviewOnce({ run: reviewer, attempts: [BUG] });
    expect(unwired.offered).not.toContain(REVIEW_TOOL);
    expect(posts).toHaveLength(0);
  });

  it("is a reviewer's only way out: the reviewing stage lets the review through and refuses writes", async () => {
    const stage = readOnlyStageOf(reviewer);
    expect(stage).toEqual({
      stage: "reviewing",
      column: "review",
      role: "reviewer",
    });
    // A review run is the reviewing stage whatever its column, and even with none.
    expect(readOnlyStageOf({ reviewing: true })).toEqual({
      stage: "reviewing",
      column: "none",
      role: "none",
    });
    if (stage === undefined) return;
    const call = (name: string, args: ToolCall["arguments"]): ToolCall => ({
      type: "toolCall",
      id: "call-1",
      name,
      arguments: args,
    });
    expect(decideStageCall(stage, call(REVIEW_TOOL, BUG))).toEqual({
      _tag: "allow",
    });
    expect(
      decideStageCall(stage, call("bash", { command: "git diff main...HEAD" })),
    ).toEqual({ _tag: "allow" });
    for (const writes of [
      call("write", { path: "src/sum.ts", content: "x" }),
      call("edit", { path: "src/sum.ts", edits: [] }),
      call("bash", { command: "git commit -am fix" }),
      call("bash", { command: "gh pr review 7 --approve" }),
    ]) {
      expect(decideStageCall(stage, writes)._tag).toBe("block");
    }
    // And the run is not offered `write`, `edit` or `verify` at all.
    const ran = await reviewOnce({
      run: reviewer,
      review: recorder().options,
      attempts: [CLEAN],
    });
    for (const tool of ["write", "edit", "verify"]) {
      expect(ran.offered).not.toContain(tool);
    }
  });
});

describe("the comment", () => {
  it("lists every dimension, the findings by severity, and the rubric", () => {
    const target = targetAt("a".repeat(40));
    const body = renderReview({
      review: {
        summary: "Two problems.",
        dimensions: {
          correctness: {
            verdict: "fail",
            findings: [
              { severity: "P2", file: "b.ts", mechanism: "minor thing" },
              {
                severity: "P0",
                file: "a.ts",
                line: 3,
                mechanism: "major thing",
              },
            ],
          },
          security: { verdict: "pass", findings: [] },
          tests: { verdict: "pass", findings: [] },
          performance: { verdict: "pass", findings: [] },
        },
      },
      target,
      marker: reviewMarker(target),
    });
    expect(body).toContain("| correctness | fail | 1 P0, 1 P2 |");
    expect(body).toContain("| performance | pass | none |");
    expect(body).toContain(
      "Reviewed `aaaaaaaaaaaa` against `main`. Two problems.",
    );
    // P0 before P2, whatever order the model filed them in.
    expect(body.indexOf("`a.ts:3` — major thing")).toBeLessThan(
      body.indexOf("`b.ts` — minor thing"),
    );
    expect(body).toContain("- **P1**: a real problem to fix before merging");
    expect(body).toContain("A new commit invalidates this review");
  });
});
