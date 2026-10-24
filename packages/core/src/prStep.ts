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
 */
import { DateTime, Effect } from "effect";
import type { HttpClient } from "effect/http";
import { SqlClient } from "effect/sql/SqlClient";
import type { RepoSlug, SessionError, SessionId } from "@repo/domain/Session";
import { SessionError as SessionErrorClass } from "@repo/domain/Session";
import type { Conversation, Harness } from "@repo/harness";
import {
  readPullRequestDoc,
  writePullRequestDoc,
  type PullRequestRecord,
} from "@repo/harness";
import type { CredentialError, CredentialProvider } from "./credentials";
import type { OpenedPullRequest, PrError } from "./pr";
import { buildPrBody, createPullRequest } from "./pr";

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
  /** What the session was asked to do, and the model and spend behind it, for the body. */
  readonly prompt: string;
  readonly model?: string;
  readonly spend?: string;
};

/**
 * The PR for a session in the log: the one already recorded, or one GitHub just opened.
 *
 * `prUrl` on the `sessions` row is written in the same effect, so `getSession` and `listSessions`
 * report the link from the index the rebuild refills from this same document.
 */
export const openPullRequest = (
  input: OpenPullRequestInput,
): Effect.Effect<
  OpenedPullRequest,
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
    const pr = recorded ?? (yield* open(input));

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

/** The one call to GitHub, its record, and the event an attached client sees. */
const open = (
  input: OpenPullRequestInput,
): Effect.Effect<
  PullRequestRecord,
  PrError | CredentialError | SessionError,
  CredentialProvider | HttpClient.HttpClient
> =>
  Effect.gen(function* () {
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
      }),
    });

    const now = yield* DateTime.now;
    const record: PullRequestRecord = {
      url: opened.url,
      number: opened.number,
      base: input.base,
      head: input.head,
      openedAt: DateTime.formatIso(now),
    };
    yield* writePullRequestDoc(input.conversation, record);
    return record;
  });
