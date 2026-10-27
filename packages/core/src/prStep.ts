/**
 * Opening a session's PR: the control-plane step (LOB-177, docs/features.md §2).
 *
 * One GitHub call, one committed document, one index column — and the log is what remembers, so
 * running the step twice returns the first answer instead of opening a second PR. That is why it
 * reads `factory.pr` before it reads a credential: the retry path never reaches the network, and a
 * process that restarted mid-step finds the link if the commit landed and calls GitHub if it did
 * not (the remaining window is LOB-179's, and closing it means adopting the PR GitHub already
 * opened when it refuses a duplicate, not a second local record).
 *
 * The record is the durable answer, and it is deliberately *not* `api.memo`. A memo belongs to one
 * task invocation — `@earendil-works/pi-durable`'s `TaskExecutionApi.memo` is documented as "a
 * durable memo of this task", and the scheduler keeps it on that task's record, read by
 * `invocation.taskId` — while `TaskOptions` names only `ownership`, `conversationId` and
 * `background`, so `createTask` takes no caller-chosen id. Two separate calls of this step can
 * therefore never share a memo, and this step is not a task at all. They can share the session's
 * log, which is what this reads.
 *
 * The answer says which path produced it (`outcome`, LOB-212): the same `{number, url}` comes from a
 * fresh GitHub call and from a retry that never made one, and a caller that has to tell them apart
 * cannot do it from the link. The tag is additive — a reader that wants only the link still decodes
 * the answer with `PullRequest`.
 *
 * The guard is keyed by the session, never by the branch: two sessions that push the same head and
 * base each open their own PR, because each reads its own `factory.pr` document.
 *
 * The index write runs on *both* paths, before anything is returned. It is one idempotent
 * `UPDATE`, and the case that needs it is exactly the retry: a first attempt whose commit landed
 * and whose row write did not would otherwise leave `getSession` and `listSessions` reporting no
 * link until a rebuild.
 *
 * It is a function rather than a method so it can run against the session log it was handed: the
 * caller owns the `Conversation` (Pi Durable allows one owner per log, D8), and the index write is
 * here beside it so a caller cannot commit the document and forget the row the list reads.
 *
 * The step is also where a session's diff is capped (LOB-227). It measures the branch against its
 * base in the session's own worktree *before* anything is written, and a diff over the cap answers
 * `{outcome: "over-cap"}` with the numbers and opens nothing: no GitHub call, no `factory.pr`
 * document, no `pr_url` row. Measuring here rather than in the caller is deliberate — the cap is a
 * property of the diff this step would publish, so a caller that skips the step skips the cap, and
 * there is no second place where a PR could be opened without one. The same measurement is what the
 * body lists under `## Changed files` (LOB-228): one `git diff --numstat` answers both questions,
 * so the paths a reviewer reads and the size the cap refused can never be two different diffs.
 *
 * That one measurement answers the smaller question first: a branch with no file changed against its
 * base has nothing to publish (LOB-196), so the step announces that in the transcript and answers
 * `{outcome: "no-change"}` without reaching GitHub. Nothing is written but that entry — no
 * document, no row — so the answer describes this call's branch rather than a state a later run
 * would have to escape.
 *
 * The body also states what the run verified (LOB-79): the step reads the `verify` tool's records
 * from the session's own log, `prEvidenceOf` turns the last of them into a `PrEvidence`, and the
 * body's `## Verification` section is rendered from it — the skill or declared command, its exit
 * code, a bounded excerpt of its output, and an explicit "no verification evidence" when there is
 * none. The cited call's measured paths are compared with the PR's own, so a verdict that predates
 * part of the change says so. Read here rather than passed in, so no caller can hand the body a verdict the log does not
 * hold; and committed on the `factory.pr` document beside the link, so the record and the body state
 * one verdict.
 */
import { DateTime, Effect, Option } from "effect";
import type { HttpClient } from "effect/http";
import { SqlClient } from "effect/sql/SqlClient";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- the measurement is the local git CLI, the same one `workspace.ts` cuts the worktree with.
import { execFileSync } from "node:child_process";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- the checkout root is a filesystem fact, not a URL.
import { existsSync } from "node:fs";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- as above: `.git` is joined onto a directory this module was handed.
import { join } from "node:path";
import type { RepoSlug, SessionError, SessionId } from "@repo/domain/Session";
import { SessionError as SessionErrorClass } from "@repo/domain/Session";
import type { Conversation, Harness } from "@repo/harness";
import {
  prEvidenceOf,
  readConversationVerifyCalls,
  readPullRequestDoc,
  writeNoDocumentationChange,
  writePullRequestDoc,
  type PullRequestRecord,
} from "@repo/harness";
import type { CredentialError, CredentialProvider } from "./credentials";
import type { DiffCap, OverCapPullRequest, PullRequestStep } from "./pr";
import {
  buildPrBody,
  createPullRequest,
  DEFAULT_DIFF_CAP,
  PrError,
} from "./pr";

export type OpenPullRequestInput = {
  /** The runtime that owns the session's log: it reads the recorded link and commits a new one. */
  readonly harness: Harness;
  readonly conversation: Conversation;
  readonly sessionId: SessionId;
  /** Where the PR is opened: the repo the session is bound to. */
  readonly repo: RepoSlug;
  readonly title: string;
  readonly head: string;
  readonly base: string;
  /** The session's working directory: where the branch's diff is measured against `base`. */
  readonly worktree: string;
  /** The configured limits; absent means `DEFAULT_DIFF_CAP`. */
  readonly cap?: DiffCap;
  /** What the session was asked to do, and the model and spend behind it, for the body. */
  readonly prompt: string;
  readonly model?: string;
  readonly spend?: string;
};

/**
 * The PR for a session in the log: the one already recorded, one GitHub just opened, or the cap
 * that refused to open either.
 *
 * `prUrl` on the `sessions` row is written in the same effect, so `getSession` and `listSessions`
 * report the link from the index the rebuild refills from this same document.
 */
export const openPullRequest = (
  input: OpenPullRequestInput,
): Effect.Effect<
  PullRequestStep,
  PrError | CredentialError | SessionError,
  CredentialProvider | HttpClient.HttpClient | SqlClient
> =>
  Effect.gen(function* () {
    const recorded = yield* readPullRequestDoc(
      input.harness,
      input.conversation,
    );
    // Read before the call, so the tag names the path this invocation took rather than what the
    // document ends the turn holding: a first open that lost its index row is still "opened".
    const outcome = recorded === undefined ? "opened" : "already-open";
    // Measured only when a PR would actually be opened: a recorded PR is the answer whatever the
    // branch has grown to since, and re-measuring it would turn a retry into a refusal. The same
    // measurement is what the body lists, so the cap and the changed-path list can never disagree
    // about what this PR carries.
    const measured =
      recorded === undefined
        ? yield* diffSize({
            worktree: input.worktree,
            base: input.base,
            head: input.head,
          })
        : Option.none<DiffSize>();
    const refused = Option.flatMap(measured, (size) =>
      capRefusal(size, input.cap ?? DEFAULT_DIFF_CAP),
    );
    // A branch even with its base has nothing to publish (LOB-196). GitHub refuses a PR for a head
    // with no commits ahead of its base, so the answer is a value and one transcript line rather
    // than a 422 the caller has to interpret — and the ordinary docs run over docs that need no
    // edit is exactly this branch. Nothing is recorded about the answer: the measurement is taken
    // afresh on every call, so a run that *does* change a file afterwards opens its PR rather than
    // reading a sticky "nothing to do". `none` (a directory that is not its own checkout) is not
    // this case: nothing was measured, so nothing can be said to be empty.
    if (Option.isSome(measured) && measured.value.files === 0) {
      yield* writeNoDocumentationChange(input.conversation, input.base);
      return { outcome: "no-change" };
    }
    // Nothing is written on this path — no document, no row — so a session refused here has the
    // same index and log it had before the step, and reads as a session with no PR.
    if (Option.isSome(refused)) return refused.value;
    const pr =
      recorded ??
      (yield* open(
        input,
        Option.match(measured, { onNone: () => [], onSome: (s) => s.paths }),
      ));

    const sql = yield* SqlClient;
    yield* sql`
      UPDATE sessions SET pr_url = ${pr.url} WHERE id = ${input.sessionId}
    `.pipe(
      Effect.mapError(
        (cause) =>
          new SessionErrorClass({
            code: "storage",
            message: `record the session's PR: ${String(cause)}`,
          }),
      ),
    );

    return { number: pr.number, url: pr.url, outcome };
  });

/**
 * The one call to GitHub, its record, and the event an attached client sees.
 *
 * The body's evidence is read here, from the session's own log (LOB-79): the `verify` tool's
 * recorded results, derived by `prEvidenceOf` — so every caller of the step gets the section, and
 * no caller can hand the body a verdict of its own. The same value is committed on the `factory.pr`
 * document and its entry, so the PR's record and its body can never state two different verdicts.
 */
const open = (
  input: OpenPullRequestInput,
  /** The branch's changed paths, as the step measured them; listed in the body (LOB-228). */
  changed: readonly string[],
): Effect.Effect<
  PullRequestRecord,
  PrError | CredentialError | SessionError,
  CredentialProvider | HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    // The cited call's measured paths are compared with the paths this PR publishes, so a run that
    // verified and then changed more is said on the body rather than cited as if it saw them. Not
    // the numstat list above: that spells a rename `{old => new}`, the record spells the new path.
    const published = publishedPaths(input);
    const evidence = prEvidenceOf(
      yield* readConversationVerifyCalls(input.conversation),
      {
        worktree: input.worktree,
        ...(Option.isSome(published) ? { published: published.value } : {}),
      },
    );
    const opened = yield* createPullRequest({
      repo: input.repo,
      base: input.base,
      head: input.head,
      title: input.title,
      body: buildPrBody({
        sessionId: input.sessionId,
        prompt: input.prompt,
        ...(input.model === undefined ? {} : { model: input.model }),
        ...(input.spend === undefined ? {} : { spend: input.spend }),
        ...(changed.length === 0 ? {} : { changed }),
        evidence,
      }),
    });

    const now = yield* DateTime.now;
    const record: PullRequestRecord = {
      url: opened.url,
      number: opened.number,
      base: input.base,
      head: input.head,
      openedAt: DateTime.formatIso(now),
      evidence,
    };
    yield* writePullRequestDoc(input.conversation, record);
    return record;
  });

/** How much a session's branch changes, as the PR step measures it. */
export type DiffSize = {
  readonly files: number;
  readonly lines: number;
  /**
   * The changed paths, in git's own order, so the PR body can list what the run touched
   * (LOB-228). A rename arrives as git spells it (`docs/{old.md => new.md}`): the measurement is
   * not a diff parser, it is the file list a reviewer gets before opening the diff.
   */
  readonly paths: readonly string[];
};

/**
 * `git diff --numstat`'s rows, summed: `<added>\t<deleted>\t<path>`, one per file.
 *
 * A binary file spells both counts `-` rather than a number, and `Number("-")` is `NaN`, so the
 * `|| 0` below is not defensive padding: it is what makes a binary file count as one changed file
 * with no lines, which is the only honest reading of git's own output. Anything else in a row after
 * the third tab (a path with a tab in it) is part of the path.
 */
export const parseDiffSize = (numstat: string): DiffSize => {
  let files = 0;
  let lines = 0;
  const paths: string[] = [];
  for (const row of numstat.split("\n")) {
    if (row.trim() === "") continue;
    const [added, deleted, ...rest] = row.split("\t");
    files += 1;
    lines += (Number(added) || 0) + (Number(deleted) || 0);
    // A row with no third column carries no path to list; it still counts as a file, because the
    // cap is about what git reported, not about how well this parser read it.
    if (rest.length > 0) paths.push(rest.join("\t"));
  }
  return { files, lines, paths };
};

/**
 * The branch's diff against its base, measured in the session's own worktree.
 *
 * Two answers, and the difference between them is the whole boundary of the cap:
 *
 * - **`none`: this directory is not a checkout root of its own.** M6 cuts a worktree only for a
 *   registered repo, so a session against a bare slug has a plain directory (`workspace.ts`), and
 *   the PR step is driven today against exactly that. There is no branch to measure and nothing a
 *   cap could refuse, so the cap does not apply. The check is the `.git` entry *in this directory*
 *   rather than a `git` command that succeeds: a plain session directory is created under
 *   `SESSION_ROOT`, which by default is `.factory/sessions` — inside the control plane's own
 *   checkout — so a bare `git diff` there walks up to the enclosing repository and measures *its*
 *   branch. That is the wrong diff in both directions: a clean control-plane tree reads as an empty
 *   session diff, and a dirty one refuses a PR for changes the session never made.
 * - **a `PrError`: this directory is a checkout root and the measurement failed** (no such base or
 *   head ref, git gone). That is not a diff that fits, so it does not open a PR: a bound that a
 *   broken checkout slips past is not a bound, and the failure names the range it could not read
 *   rather than pretending the diff was measured.
 *
 * `base...head` (three-dot) is the diff a PR shows: from the merge base to the branch tip. Two-dot
 * would blame the branch for everything `base` gained since they forked. Uncommitted work is not in
 * it either, deliberately — a change that is not committed is not in the PR, so it is not what this
 * cap refuses.
 *
 * It measures the branch the PR *names* (`head`), not the worktree's own `HEAD`. They are the same
 * branch in every ordinary call — the session's `factory/<id>` is what the worktree was cut at — but
 * the step publishes `head`, so that is the diff to bound: a worktree holding a small branch while
 * the caller asks for a PR from a large one would otherwise pass a cap over a diff nobody publishes,
 * and the reverse would refuse one that is small. A `head` the worktree cannot resolve is the
 * `PrError` above, which is the honest answer to "measure a branch that is not here".
 */
export const diffSize = (input: {
  readonly worktree: string;
  readonly base: string;
  readonly head: string;
}): Effect.Effect<Option.Option<DiffSize>, PrError> => {
  if (!existsSync(join(input.worktree, ".git")))
    return Effect.succeed(Option.none());
  return Effect.map(
    Effect.mapError(
      Effect.try({
        try: () =>
          parseDiffSize(
            execFileSync(
              "git",
              [
                "diff",
                "--numstat",
                // As `publishedPaths` does: a range is never read as an option, whoever named it.
                "--end-of-options",
                `${input.base}...${input.head}`,
                "--",
              ],
              {
                cwd: input.worktree,
                encoding: "utf8",
                // stderr is swallowed: the failure is the typed error below, not a log line every
                // session that opens a PR would print.
                stdio: ["ignore", "pipe", "ignore"],
              },
            ),
          ),
        catch: () => undefined,
      }),
      () =>
        new PrError({
          operation: "diffSize",
          ref: `${input.base}...${input.head}`,
          message: "the branch's diff could not be measured",
        }),
    ),
    Option.some,
  );
};

/**
 * The paths the PR publishes (`base...head`), as `git diff --name-only -z` spells them — the
 * spelling the `verify` record's `changed` uses, so the two compare path for path (LOB-79). `none`
 * when the directory is not its own checkout or git cannot answer: the evidence then carries no
 * coverage rather than a comparison against a guess. `diffSize` already measured this range, so a
 * failure here is not a reason to refuse the PR.
 */
export const publishedPaths = (input: {
  readonly worktree: string;
  readonly base: string;
  readonly head: string;
}): Option.Option<readonly string[]> => {
  if (!existsSync(join(input.worktree, ".git"))) return Option.none();
  try {
    const stdout = execFileSync(
      "git",
      [
        "diff",
        "--name-only",
        "-z",
        "--end-of-options",
        `${input.base}...${input.head}`,
        "--",
      ],
      {
        cwd: input.worktree,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    return Option.some(stdout.split("\0").filter((path) => path !== ""));
  } catch {
    return Option.none();
  }
};

/**
 * The typed refusal for an over-cap diff, or `none` when the diff fits or there is none to measure.
 *
 * The two dimensions are checked in a fixed order (files first) only so that a diff over both
 * answers one thing rather than two; each is compared on its own, so a wide-but-shallow diff and a
 * narrow-but-deep one are both refused.
 */
const capRefusal = (
  size: DiffSize,
  cap: DiffCap,
): Option.Option<OverCapPullRequest> => {
  if (size.files > cap.maxFiles) {
    return Option.some({
      outcome: "over-cap",
      limit: "files",
      cap: cap.maxFiles,
      measured: size.files,
    });
  }
  if (size.lines > cap.maxLines) {
    return Option.some({
      outcome: "over-cap",
      limit: "lines",
      cap: cap.maxLines,
      measured: size.lines,
    });
  }
  return Option.none();
};

export const diffCapRefusal = (input: {
  readonly worktree: string;
  readonly base: string;
  readonly head: string;
  readonly cap: DiffCap;
}): Effect.Effect<Option.Option<OverCapPullRequest>, PrError> =>
  Effect.map(diffSize(input), (size) =>
    Option.flatMap(size, (measured) => capRefusal(measured, input.cap)),
  );
