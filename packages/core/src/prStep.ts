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
 *
 * The step publishes the branch before it names it (C17). GitHub opens a PR only for a head it has,
 * and nothing else pushes a session's branch — the agent's environment carries no credential — so
 * when the caller hands the step a `push`, it runs after the branch is measured and before GitHub is
 * called: a refused or empty branch is never published, and a PR is never asked for a head the forge
 * does not hold. The push is never forced, so a remote branch that moved past this one is the
 * `non-fast-forward` outcome — nothing opened, nothing recorded — rather than a PR over commits the
 * run never saw. Any other push failure is a `PrError` naming the push.
 *
 * The branch passes a secret scan before it is pushed (S-agent-secrets, `./secretScan`): every line
 * its commits add — the history a push publishes, not only the net diff — is checked for a value the
 * factory stores for the repo and for a well-known credential's shape. A finding answers
 * `{outcome: "secret-found"}` naming where each is and never its text: no push, no GitHub call, no
 * record. The caller hands the step the stored values; a stored value its key cannot read refuses the
 * step as a `PrError`, so a branch is never pushed unscanned.
 *
 * A card's later run adopts the card's PR rather than opening a second one (C19): it continues the
 * branch an earlier run of the card opened the PR from (`./cardBranch`), so the caller hands the step
 * that PR (`adopt`). The step then does everything an open does but the GitHub call — the same
 * measurement, cap and push, so this run's commits reach the PR under the same guards — and records
 * the card's PR in this session's log, answering `already-open`. The guard is still keyed by the
 * session: only the caller decides that two sessions are one card's.
 *
 * A session whose own log records its PR and whose branch has since moved past the commit it was
 * published at pushes the new tip onto that PR (F14): the same measurement, cap, scan and push as an
 * open, then the record's commit moves to the new tip and the answer is `updated`. Before this the
 * recorded PR was the answer whatever the branch had grown to, so a session that settled again with
 * more commits left them unpublished, and nothing but a later run of its card ever pushed them. A
 * refusal (`over-cap`, `non-fast-forward`, `secret-found`) is answered as an open's is, naming the PR
 * it left as it was (`pullRequest`), and writes nothing, so the record stays at the commit the forge
 * holds; a branch still at that commit is the retry it always was, answered from the log without
 * measuring, pushing or reaching any forge. A step with no push updates nothing: it answers the PR as
 * it stands, because a record moved without a push would name a commit the forge does not have.
 */
import { DateTime, Effect, Option } from "effect";
import type { HttpClient } from "effect/http";
import { SqlClient } from "effect/sql/SqlClient";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- the measurement is the local git CLI, the same one `workspace.ts` cuts the worktree with.
import { execFile, execFileSync } from "node:child_process";
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
  writePullRequestUpdate,
  type InjectedSecrets,
  type PullRequestRecord,
} from "@repo/harness";
import type { CredentialError, CredentialProvider } from "./credentials";
import type { GitError, PushedBranch } from "./git";
import type { DiffCap, OverCapPullRequest, PullRequestStep } from "./pr";
import { resolveCommit } from "./repos";
import { scanBranchForSecrets } from "./secretScan";
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
  /**
   * The ref the branch is measured against when it is not `base` itself: the base's tip as last
   * fetched from the forge (`refs/remotes/factory/<base>`, C17). The worktree was cut from it, and the
   * operator's local `base` can be behind it, which would count the remote's own commits as the
   * session's. `base` is still what the PR targets. Absent: `base`.
   */
  readonly measureBase?: string;
  /**
   * Publish `head` to the repo's forge (C17): run once a PR would be opened, after the measurement
   * and before GitHub is called, never on the retry the log answers. Absent: the step pushes nothing,
   * as before — a repo the deployment has no forge URL for, whose head must already be there.
   */
  readonly push?: (
    commit: string | undefined,
  ) => Effect.Effect<PushedBranch, GitError | CredentialError>;
  /**
   * The base's tip on the forge, fetched by the control plane when the step is about to push
   * (S-agent-secrets): the commit the secret scan stops at. Given with `push`, because only a push
   * the step makes is one the scan bounds by what the forge holds rather than by a local ref, which
   * the agent's own shell shares in a local checkout and could move to hide a commit from the scan.
   * A fetch that fails refuses the step as a `PrError`. Absent: the scan stops at `measureBase`.
   */
  readonly forgeBase?: Effect.Effect<string, GitError | CredentialError>;
  /**
   * The PR the session's card already has on this head and base (C19), opened by an earlier run of
   * the card on the branch this one continues. With one, a session whose log records no PR yet takes
   * every step of an open — measured, capped, pushed — but asks GitHub for nothing: the PR exists,
   * and the push is what brings this run's commits onto it. The record is committed to this log as
   * it stands, and the answer is `already-open`. Absent: the step opens one, as before.
   */
  readonly adopt?: PullRequestRecord;
  /** The configured limits; absent means `DEFAULT_DIFF_CAP`. */
  readonly cap?: DiffCap;
  /**
   * The repo's stored secrets, for the scan a branch passes before it is pushed (S-agent-secrets,
   * `./secretScan`): `known` are the values a line may not hold, `unreadable` the names the store
   * holds and this control plane's key cannot read — which refuses the step, because a branch
   * cannot be scanned for a value nobody can read. Absent: no stored value, only the patterns.
   */
  readonly secrets?: {
    readonly known: InjectedSecrets;
    readonly unreadable: readonly string[];
  };
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
    // The head is resolved to one commit first, and that commit is what is measured, listed and
    // pushed (C17): a commit the agent lands on the branch while the step runs is then neither
    // pushed past the cap unmeasured nor missing from the body. A head the checkout cannot resolve
    // is measured by name, which fails on its own terms. A recorded PR's head is resolved too, when
    // it is the head this call names (F14): it is how the step tells a branch the PR carries from
    // one that moved past it.
    const commit =
      (recorded === undefined || recorded.head === input.head) &&
      existsSync(join(input.worktree, ".git"))
        ? yield* resolveCommit(input.worktree, `refs/heads/${input.head}`)
        : undefined;
    // A recorded PR whose branch has moved past the commit it was published at is updated (F14):
    // the new tip takes every step an open takes but the GitHub call — measured, capped, scanned and
    // pushed, never forced — and the record moves to it. A record that names no commit (one written
    // before C19) is treated as moved, so its first update records one. A branch still at the
    // published commit is the retry it always was: answered from the log, measuring and pushing
    // nothing, reaching no forge.
    //
    // Only a step that can push updates: with no push (a repo with no forge URL a token may go to,
    // a deployment with no remote) nothing would reach the PR, and no GitHub call catches it as an
    // open's would — a record moved anyway would name a commit the forge does not have, and
    // `pr_link` would be met for work that never reached the PR. Such a step answers the PR as it
    // stands, as it did before F14, and leaves the record where it was.
    const moved =
      recorded !== undefined &&
      commit !== undefined &&
      recorded.commit !== commit;
    const updating = moved && input.push !== undefined;
    if (moved && !updating) {
      yield* Effect.logInfo(
        `session ${input.sessionId}: ${input.head} moved past the commit ${recorded.url} was published at, but this step has no push, so the PR is left where it was`,
      );
    }
    const publishing = recorded === undefined || updating;
    // A refusal of a recorded PR's update names the PR it left as it was (F14), so no reader tells
    // an operator "no PR was opened" about a session whose PR is open.
    const leftAsItWas = <A extends object>(
      answer: A,
    ): A | (A & { readonly pullRequest: string }) =>
      recorded === undefined
        ? answer
        : { ...answer, pullRequest: recorded.url };
    // Read before the call, so the tag names the path this invocation took rather than what the
    // document ends the turn holding: a first open that lost its index row is still "opened".
    // A card's PR this run adopts (C19) is one already open, so it is not "opened" either.
    const outcome =
      recorded === undefined && input.adopt === undefined
        ? "opened"
        : updating
          ? "updated"
          : "already-open";
    // Measured only when the step would publish: a recorded PR whose branch has not moved is the
    // answer as it stands, and re-measuring it would turn a retry into a refusal. The same
    // measurement is what the body lists, so the cap and the changed-path list can never disagree
    // about what this PR carries.
    const measuredHead = commit ?? input.head;
    const measured = publishing
      ? yield* diffSize({
          worktree: input.worktree,
          base: input.measureBase ?? input.base,
          head: measuredHead,
        }).pipe(
          // A failed measurement names the branch, as the caller does, not the commit it resolved.
          Effect.mapError((error) =>
            commit === undefined
              ? error
              : new PrError({
                  operation: error.operation,
                  ref: `${input.measureBase ?? input.base}...${input.head}`,
                  message: error.message,
                }),
          ),
        )
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
    // this case: nothing was measured, so nothing can be said to be empty. Only an open asks it: a
    // PR that exists takes a push that empties its diff as any other (F14), and says so on GitHub.
    if (
      recorded === undefined &&
      Option.isSome(measured) &&
      measured.value.files === 0
    ) {
      yield* writeNoDocumentationChange(input.conversation, input.base, commit);
      return { outcome: "no-change" };
    }
    // Nothing is written on this path — no document, no row — so a session refused here has the
    // same index and log it had before the step, and reads as a session with no PR; a recorded PR
    // refused an update (F14) keeps its record, at the commit it was published at.
    if (Option.isSome(refused)) return leftAsItWas(refused.value);
    // The scan before the push (S-agent-secrets): every line the branch's commits add, for a stored
    // value or a credential's shape. Like the cap it writes nothing, so a refused session reads as
    // one with no PR; unlike the cap it reads the history, because that is what a push publishes.
    //
    // What it stops at is what the forge already holds: the base's tip there, fetched now, when the
    // step pushes — never a local ref name the agent's shell could have moved onto a commit it wants
    // unscanned — and the commit the PR was last published at: an adopted card PR's (C19), or this
    // session's own recorded PR's (F14), which an earlier step scanned and pushed, so a later push is
    // not refused for history the forge already has.
    if (publishing && Option.isSome(measured)) {
      const localBase = input.measureBase ?? input.base;
      const unreadable = input.secrets?.unreadable ?? [];
      if (unreadable.length > 0) {
        return yield* new PrError({
          operation: "secretScan",
          ref: `${localBase}..${input.head}`,
          message: `the repo's stored secret(s) ${unreadable.join(", ")} cannot be read with this control plane's FACTORY_SECRETS_KEY, so the branch cannot be scanned for them and nothing was pushed`,
        });
      }
      const base =
        input.push !== undefined && input.forgeBase !== undefined
          ? yield* input.forgeBase.pipe(
              Effect.mapError(
                (error) =>
                  new PrError({
                    operation: "secretScan",
                    ref: `${input.base}..${input.head}`,
                    message: `the forge's ${input.base} could not be fetched to bound the branch's secret scan, so nothing was pushed: ${error.message}`,
                  }),
              ),
            )
          : localBase;
      const previously = recorded?.commit ?? input.adopt?.commit ?? "";
      const published =
        previously === ""
          ? undefined
          : yield* resolveCommit(input.worktree, previously);
      const found = yield* scanBranchForSecrets({
        checkout: input.worktree,
        base,
        head: measuredHead,
        ...(published === undefined ? {} : { exclude: [published] }),
        known: input.secrets?.known ?? [],
      });
      if (Option.isSome(found)) return leftAsItWas(found.value);
    }
    // Published only when the step publishes, and only a branch the step measured: a directory that
    // is not its own checkout has no branch to push. A rejected push writes nothing, so the session
    // reads as it did before the step — no PR, or its PR at the commit it was published at.
    if (publishing && Option.isSome(measured) && input.push !== undefined) {
      const pushed = yield* publish(input.push(commit), input.head);
      if (pushed !== undefined) return leftAsItWas(pushed);
    }
    const pr =
      recorded !== undefined
        ? updating && commit !== undefined
          ? yield* updateRecordedPr(input.conversation, recorded, commit)
          : recorded
        : input.adopt === undefined
          ? yield* open(
              input,
              Option.match(measured, {
                onNone: () => [],
                onSome: (s) => s.paths,
              }),
              measuredHead,
              commit,
            )
          : yield* adoptCardPr(input.conversation, input.adopt, commit);

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
 * Move this session's recorded PR to the commit the step just pushed onto it (F14), announcing the
 * push in the transcript. The PR is the same one — its number, page, base and body stand — so the
 * only field that changes is the published commit, which is what `pr_link` compares with the
 * branch's tip.
 */
const updateRecordedPr = (
  conversation: Conversation,
  recorded: PullRequestRecord,
  commit: string,
): Effect.Effect<PullRequestRecord, SessionError> =>
  Effect.as(writePullRequestUpdate(conversation, recorded, commit), {
    ...recorded,
    commit,
  });

/**
 * Run the caller's push, answering the `non-fast-forward` outcome for a remote that moved past the
 * branch and `undefined` once the forge holds it. Every other `GitError` is a `PrError` on the push
 * — the wire does not carry `GitError`, and its message already names the operation, the ref and
 * the repo without a URL or a token. A `CredentialError` stays what it is.
 */
const publish = (
  push: Effect.Effect<PushedBranch, GitError | CredentialError>,
  head: string,
): Effect.Effect<
  { readonly outcome: "non-fast-forward"; readonly head: string } | undefined,
  PrError | CredentialError
> =>
  push.pipe(
    Effect.as(undefined),
    Effect.catchTag("GitError", (error) =>
      error.reason === "non-fast-forward"
        ? Effect.succeed({ outcome: "non-fast-forward" as const, head })
        : Effect.fail(
            new PrError({
              operation: "pushBranch",
              ref: error.ref,
              message: error.message,
            }),
          ),
    ),
  );

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
  /** The commit (or, unresolved, the branch) those paths were measured at. */
  measuredHead: string,
  /** The commit measured and pushed, recorded as the PR's published head (C19). */
  commit: string | undefined,
): Effect.Effect<
  PullRequestRecord,
  PrError | CredentialError | SessionError,
  CredentialProvider | HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    // The cited call's measured paths are compared with the paths this PR publishes, so a run that
    // verified and then changed more is said on the body rather than cited as if it saw them. Not
    // the numstat list above: that spells a rename `{old => new}`, the record spells the new path.
    const published = publishedPaths({
      worktree: input.worktree,
      base: input.measureBase ?? input.base,
      head: measuredHead,
    });
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
      ...(commit === undefined ? {} : { commit }),
      evidence,
    };
    yield* writePullRequestDoc(input.conversation, record);
    return record;
  });

/**
 * Record the card's PR in this session's log (C19, `adopt`): the PR an earlier run of the card
 * opened, at the commit *this* step measured and pushed — never the earlier run's commit, which is
 * not what the branch holds now. With no commit resolved, the record names none, which `pr_link`
 * reads as unknown.
 */
const adoptCardPr = (
  conversation: Conversation,
  card: PullRequestRecord,
  commit: string | undefined,
): Effect.Effect<PullRequestRecord, SessionError> => {
  const record: PullRequestRecord = {
    url: card.url,
    number: card.number,
    base: card.base,
    head: card.head,
    openedAt: card.openedAt,
    ...(commit === undefined ? {} : { commit }),
    ...(card.evidence === undefined ? {} : { evidence: card.evidence }),
  };
  return Effect.as(writePullRequestDoc(conversation, record), record);
};

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
}): Effect.Effect<Option.Option<DiffSize>, PrError> =>
  existsSync(join(input.worktree, ".git"))
    ? Effect.map(
        branchDiffSize({
          checkout: input.worktree,
          base: input.base,
          head: input.head,
        }),
        Option.some,
      )
    : Effect.succeed(Option.none());

/**
 * How long one `git diff --numstat` may run before it is a `PrError`. The measurement is local (no
 * network), so a minute is far past any real diff and only bounds a wedged git.
 */
const DIFF_TIMEOUT_MS = 60_000;

/**
 * `diffSize`'s measurement on its own: `git diff --numstat base...head` run in `checkout`, with git's
 * ordinary repository discovery from that directory. No checkout-root check — the caller has already
 * decided this directory names a repository: `diffSize` by finding `.git` in it, the board
 * (`TaskService`, LOB-240) because it is the registered `local_path` that `workspace.ts` cut the
 * session's worktree from with the same discovery, so the session's branch is a ref of the
 * repository git finds from there, whether `local_path` is the checkout root or a directory inside
 * it.
 *
 * Asynchronous (`execFile`, not `execFileSync`): the diff runs in a child process while the API's
 * event loop keeps serving every other request, and a diff that outlives `DIFF_TIMEOUT_MS` (or an
 * interrupted caller) kills git rather than leaving it running. A ref git cannot resolve, a path
 * that is not inside a repository, or a git that is gone is the `PrError`.
 */
export const branchDiffSize = (input: {
  readonly checkout: string;
  readonly base: string;
  readonly head: string;
}): Effect.Effect<DiffSize, PrError> => {
  const refused = new PrError({
    operation: "diffSize",
    ref: `${input.base}...${input.head}`,
    message: "the branch's diff could not be measured",
  });
  return Effect.callback<DiffSize, PrError>((resume, signal) => {
    execFile(
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
        cwd: input.checkout,
        encoding: "utf8",
        // An interrupted caller (a move abandoned, a PR request gone) kills git rather than leaving it.
        signal,
        timeout: DIFF_TIMEOUT_MS,
        // As `execFileSync`'s default, which this measurement used before it went async.
        maxBuffer: 1024 * 1024,
      },
      // stderr is dropped: the failure is the typed error, not a log line every session that opens
      // a PR (or every move out of `building`) would print.
      (error, stdout) =>
        resume(
          error === null
            ? Effect.succeed(parseDiffSize(stdout))
            : Effect.fail(refused),
        ),
    );
  });
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
