/**
 * The docs trigger (LOB-197, part 3 of LOB-37): a documentation run that starts without a person.
 *
 * Two things start a docs run, and neither is a person clicking: a **push** to the default branch,
 * and an **interval schedule**. Both are deliveries to the same seam the Linear, generic, GitHub
 * issue and Jira adapters deliver to (LOB-188), so both are deduped by delivery id, both are refused
 * by the same `TriggerError` rules, and both create a session the way every other trigger does. This
 * file is an adapter plus a clock — it decides nothing about replays, refusals or sessions:
 *
 * - `docsPushDelivery` normalizes a GitHub `push` payload into a delivery, and answers `undefined`
 *   for a push that is not about the default branch (or is a branch deletion), exactly as
 *   `githubDelivery` answers for an issue event this adapter does not act on.
 * - `docsSchedule` is the clock: every `everyMs` it delivers one tick, and when it is disabled
 *   (`undefined` or `<= 0`) it delivers nothing at all — not one tick, not a disabled one.
 *
 * **The run's branch says what produced it.** A docs run must never work on the default branch, and
 * a reviewer reading `factory/<session-id>` cannot tell a docs run from any other. So the trigger
 * names the branch `factory/doc-<deliveryId>`, where the delivery id is the push's commit sha or the
 * schedule tick's own instant — a branch that names the delivery that started it, and one that two
 * deliveries cannot share. `DocsSessionsFromSessionService` is the port that puts it there: the
 * seam's `TriggerSessions` contract, filled with `SessionService.create({branch})`.
 *
 * **The id is the branch, so the id must be a branch.** A delivery id here is built, never taken
 * from a header: `docsPushDelivery` derives `push-<repo>-<sha>` and `docsSchedule` derives
 * `schedule-<repo>-<instant>`, both from values it validates (a 40-hex sha, an integer instant, a
 * `RepoSlug`). A GitHub delivery uuid would be branch-safe too, but it is *not* stable across a
 * redelivery of the same push, and the branch has to name the push rather than the attempt.
 *
 * **Its callers (LOB-234).** `apps/api` is what starts both without a person: `POST /webhooks/github`
 * hands a signed `push` to `handleDocsPushWebhook`, and a daemon runs `runDocsSchedule` when
 * `DOCS_SCHEDULE_MS` is set. Both deliver through `DocsTriggerLive`, so the route, the daemon, the
 * tests and the drive run the same seam.
 */
import { Clock, Duration, Effect, Layer, Option, Schema } from "effect";
import type { SqlClient } from "effect/sql/SqlClient";
import type { RepoSlug } from "@repo/domain/Session";
import { BranchName, RepoSlug as RepoSlugSchema } from "@repo/domain/Session";
import {
  LIFECYCLE_ACTIONS,
  TriggerError,
  type TriggerDelivery,
  type TriggerEvent,
  type TriggerRule,
} from "@repo/domain/Trigger";
import { type GitHubWebhookAnswer, refuseGitHubDelivery } from "./LinearSync";
import { SessionService } from "./SessionService";
import {
  NoWriteBack,
  TriggerService,
  TriggerServiceLive,
  TriggerSessions,
  triggerActorOf,
} from "./TriggerService";

/** The label a docs rule claims, and the only label a docs delivery carries. */
export const DOCS_TRIGGER_LABEL = "docs";

/** Every docs branch starts here; the rest of the name is the delivery that started the run. */
export const DOCS_BRANCH_PREFIX = "factory/doc-";

/** What the run is told to do. One sentence, because the `docs` skill's body carries the rules. */
export const DOCS_PROMPT =
  "Update the documentation for this change: the files under docs/ that describe what changed, " +
  "in the project's own voice. Change documentation only.\n\n" +
  "Source: {{source}} ({{key}})\n" +
  "{{title}}\n\n" +
  "{{body}}";

/**
 * The rule a deployment registers to make a delivery a docs run: the `docs` label in, the repo and
 * the prompt out. One rule, because one label means one kind of work; a deployment that docs two
 * repos registers one trigger per repo (the branch names the repo, so the two runs cannot share
 * one).
 */
export const docsTriggerRules = (
  repo: RepoSlug,
  baseRef?: string,
): ReadonlyArray<TriggerRule> => [
  {
    label: DOCS_TRIGGER_LABEL,
    repo,
    ...(baseRef === undefined ? {} : { baseRef }),
    prompt: DOCS_PROMPT,
    // The docs rule is the one rule that admits the two lifecycle actions: a repository's own push
    // and the schedule's tick are what start a docs run, and nothing else may name them.
    startsWorkFor: [...LIFECYCLE_ACTIONS],
  },
];

/** A token that is safe in, and unique within, a git branch name. */
const BRANCH_TOKEN = /^[a-z0-9][a-z0-9._-]*$/;

/** The repo as a branch token: `owner/name` → `owner-name`. */
const repoToken = (repo: RepoSlug): string => repo.replace("/", "-");

/**
 * The branch `factory/doc-<token>`, or `undefined` when the token could not be one. `undefined` is
 * the refusal, not a fallback: a docs run that quietly invented `factory/<session-id>` would break
 * the one promise the branch makes.
 */
export const docsBranch = (token: string): string | undefined =>
  BRANCH_TOKEN.test(token) ? `${DOCS_BRANCH_PREFIX}${token}` : undefined;

const SHA = /^[0-9a-f]{40}$/;

/** The delivery id of one push to one branch of one repo. */
export const pushToken = (repo: RepoSlug, sha: string): string =>
  `push-${repoToken(repo)}-${sha}`;

/**
 * The delivery id of the tick that covers `at`: the interval it falls in, not the moment the loop
 * happened to wake. Two wakes inside one interval are one delivery (the seam answers the second as
 * a replay), and the next interval is a new one.
 */
export const scheduleToken = (
  repo: RepoSlug,
  at: number,
  everyMs: number,
): string =>
  `schedule-${repoToken(repo)}-${Math.floor(at / everyMs) * everyMs}`;

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const stringField = (
  record: Record<string, unknown> | undefined,
  name: string,
): string | undefined => {
  const value = record?.[name];
  return typeof value === "string" ? value : undefined;
};

const repoSlug = (fullName: string): RepoSlug | undefined => {
  const decoded = Schema.decodeOption(RepoSlugSchema)(fullName.toLowerCase());
  return Option.isSome(decoded) ? decoded.value : undefined;
};

/** The commit messages a push carries, as the prompt's body. */
const pushedCommits = (payload: Record<string, unknown>): string => {
  const commits = payload["commits"];
  if (!Array.isArray(commits)) return "";
  return commits
    .flatMap((entry): ReadonlyArray<string> => {
      const message = stringField(asRecord(entry), "message");
      if (message === undefined) return [];
      // One line per commit: a push of ten commits should read as ten lines, not ten paragraphs.
      const first = message.split("\n")[0]?.trim() ?? "";
      return first === "" ? [] : [`- ${first}`];
    })
    .join("\n");
};

/**
 * A GitHub `push` payload, normalized — or `undefined` when it is not a push this trigger acts on.
 *
 * `undefined` covers four things, and each one is a real delivery the route will record as refused
 * rather than as work: a push to a branch that is not the default one (a session's own
 * `factory/<id>` push must not start a docs run), a branch deletion (`deleted`, or the all-zeros
 * `after` GitHub sends), a payload with no `repository.full_name`, and one whose full name is not a
 * `RepoSlug`. The default branch is a parameter rather than "main": a repo whose trunk is `trunk`
 * docs its trunk.
 */
export const docsPushEvent = (input: {
  readonly payload: unknown;
  readonly defaultBranch: string;
}): TriggerEvent | undefined => {
  const body = asRecord(input.payload);
  if (body === undefined) return undefined;
  const ref = stringField(body, "ref");
  if (ref !== `refs/heads/${input.defaultBranch}`) return undefined;
  if (body["deleted"] === true) return undefined;
  const sha = stringField(body, "after");
  if (sha === undefined || !SHA.test(sha)) return undefined;
  const fullName = stringField(asRecord(body["repository"]), "full_name");
  if (fullName === undefined) return undefined;
  const repo = repoSlug(fullName);
  if (repo === undefined) return undefined;
  const commits = pushedCommits(body);
  return {
    source: "github",
    // The push, not the delivery attempt: see this module's docstring.
    key: `${repo}@${sha}`,
    action: "push",
    title: `docs: ${repo} pushed ${sha.slice(0, 12)}`,
    body: commits,
    labels: [DOCS_TRIGGER_LABEL],
    repo,
  };
};

/**
 * One push, as the seam takes it. `undefined` when the payload is not a push to the default branch —
 * the caller answers that as a bad request, the way the issue adapter answers a payload it cannot
 * act on.
 */
export const docsPushDelivery = (input: {
  readonly payload: unknown;
  readonly defaultBranch: string;
}): TriggerDelivery | undefined => {
  const event = docsPushEvent(input);
  if (event === undefined) return undefined;
  if (event.repo === undefined) return undefined;
  const sha = event.key.slice(event.key.lastIndexOf("@") + 1);
  // `keyedByWork`: the id is the push itself, so GitHub has no fresh delivery of it to offer. A push
  // that reached a repo nobody had registered yet is recorded `skipped`; once the operator registers
  // it, redelivering that push from GitHub's log has to start the run rather than replay the skip.
  return { requestId: pushToken(event.repo, sha), event, keyedByWork: true };
};

/** One tick of the schedule, as the seam takes it. */
export const docsScheduleDelivery = (input: {
  readonly repo: RepoSlug;
  readonly at: number;
  readonly everyMs: number;
}): TriggerDelivery => ({
  requestId: scheduleToken(input.repo, input.at, input.everyMs),
  event: {
    source: "github",
    key: `${input.repo}@schedule-${Math.floor(input.at / input.everyMs) * input.everyMs}`,
    action: "schedule",
    title: `docs: the scheduled pass over ${input.repo}`,
    body: "No push started this pass: the schedule did.",
    labels: [DOCS_TRIGGER_LABEL],
    repo: input.repo,
  },
});

/** What the schedule needs: where to read the interval, what to docs, and how to deliver. */
export type DocsScheduleOptions = {
  /**
   * The interval, in milliseconds. `undefined` (unconfigured) and any non-positive number are
   * *disabled*: the schedule then delivers nothing at all, which is the default for a deployment
   * that never asked for one.
   */
  readonly everyMs: number | undefined;
  readonly repo: RepoSlug;
  readonly deliver: (
    delivery: TriggerDelivery,
  ) => Effect.Effect<unknown, TriggerError>;
};

/**
 * The interval schedule: one delivery per interval, forever, until it is interrupted.
 *
 * The clock is aligned to the intervals `scheduleToken` names (multiples of `everyMs` since the
 * epoch), not to the end of the last tick: after each delivery it sleeps until the next boundary.
 * A loop that waited `everyMs` *after* each tick (`Schedule.spaced`) would drift later by every
 * tick's own duration and skip an interval every few ticks. Aligned, a tick that finishes inside its
 * interval is always followed by a tick for the next one, and no interval is delivered twice. The
 * guarantee is exact while a tick is shorter than an interval; a tick that outlasts one is followed
 * at once by a tick for the interval it finished in, so an interval that began *and* ended while a
 * tick was still running is not delivered — at most once per interval, never a backlog of stale
 * passes.
 *
 * A failed delivery is logged and does not stop the clock. A schedule that died on one database
 * blip would break the automation silently — the process is up, the docs runs simply stop — and the
 * seam already records a refusal as an answer, so the only failure that reaches here is a real one
 * (storage down, the session could not be opened). The next interval retries the *next* tick; the
 * failed one is not replayed, because `scheduleToken` names the interval rather than the attempt.
 */
export const docsSchedule = (
  options: DocsScheduleOptions,
): Effect.Effect<void> => {
  const everyMs = options.everyMs;
  if (everyMs === undefined || !Number.isFinite(everyMs) || everyMs <= 0) {
    return Effect.void;
  }
  // `target` is the boundary this tick was scheduled for. A timer that wakes a hair early must still
  // deliver the interval it slept towards, so the tick reads the later of the clock and its target.
  const tick = (target: number): Effect.Effect<number> =>
    Effect.gen(function* () {
      const at = Math.max(yield* Clock.currentTimeMillis, target);
      const delivery = docsScheduleDelivery({
        repo: options.repo,
        at,
        everyMs,
      });
      yield* options.deliver(delivery).pipe(
        Effect.tapError((cause) =>
          Effect.logWarning(
            `docs schedule: delivery ${delivery.requestId} failed: ${cause.message}`,
          ),
        ),
        Effect.ignore,
      );
      const next = (Math.floor(at / everyMs) + 1) * everyMs;
      const now = yield* Clock.currentTimeMillis;
      yield* Effect.sleep(Duration.millis(Math.max(0, next - now)));
      return next;
    });
  const loop = (target: number): Effect.Effect<never> =>
    Effect.flatMap(tick(target), loop);
  return loop(0).pipe(Effect.asVoid);
};

/**
 * The seam's session port, filled with `SessionService.create` on a docs branch.
 *
 * `requestId` is passed through namespaced by the seam (`trigger:<deliveryId>`) so a retry reuses
 * the session it already opened and does not send its prompt twice; `branch` is the one thing this
 * port adds, and it is a refusal rather than a fallback when the delivery id cannot be a branch
 * token.
 */
export const DocsSessionsFromSessionService = Layer.effect(
  TriggerSessions,
  Effect.gen(function* () {
    const sessions = yield* SessionService;
    return TriggerSessions.of({
      send: (input) =>
        sessions
          .send({
            sessionId: input.sessionId,
            content: input.content,
            requestId: input.requestId,
          })
          .pipe(
            Effect.asVoid,
            Effect.mapError(
              (cause) =>
                new TriggerError({
                  code: "session-create",
                  message: cause.message,
                }),
            ),
          ),
      create: (input) => {
        const wanted = docsBranch(input.deliveryId);
        const branch =
          wanted === undefined
            ? Option.none()
            : Schema.decodeOption(BranchName)(wanted);
        if (Option.isNone(branch)) {
          return Effect.fail(
            new TriggerError({
              code: "session-create",
              message: `delivery ${input.deliveryId} cannot name a docs branch (${DOCS_BRANCH_PREFIX}<a-z0-9-…>)`,
            }),
          );
        }
        return sessions
          .create({
            title: input.title,
            requestId: input.requestId,
            repo: input.repo,
            branch: branch.value,
            ...(input.baseRef === undefined ? {} : { baseRef: input.baseRef }),
            actor: triggerActorOf(input.source),
          })
          .pipe(
            Effect.map((summary) => ({ id: summary.id })),
            Effect.mapError(
              (cause) =>
                new TriggerError({
                  code: "session-create",
                  message: cause.message,
                }),
            ),
          );
      },
    });
  }),
);

/**
 * The seam a docs delivery goes through: `TriggerServiceLive` over the docs rule, on the docs session
 * port, with no write-back (a push and a tick have nowhere to write one). `repo` is the rule's repo,
 * which only a delivery that names none falls back to — a push names its own (`event.repo` wins in
 * `resolveMapping`), and a tick names the schedule's.
 */
export const DocsTriggerLive = (repo: RepoSlug) =>
  TriggerServiceLive({ rules: docsTriggerRules(repo) }).pipe(
    Layer.provide(DocsSessionsFromSessionService),
    Layer.provide(NoWriteBack),
  );

/**
 * The interval schedule as a deployment runs it (LOB-234): `docsSchedule` delivering to the docs
 * seam. Disabled (`everyMs` unset or `<= 0`) it returns at once, having delivered nothing; enabled
 * it runs until it is interrupted, so the caller forks it into a scope that owns its lifetime.
 */
export const runDocsSchedule = (options: {
  readonly everyMs: number | undefined;
  readonly repo: RepoSlug;
}): Effect.Effect<void, never, SessionService | SqlClient> =>
  Effect.gen(function* () {
    const trigger = yield* TriggerService;
    yield* docsSchedule({
      everyMs: options.everyMs,
      repo: options.repo,
      deliver: trigger.deliver,
    });
  }).pipe(Effect.provide(DocsTriggerLive(options.repo)));

/** The default branch a push payload names (`repository.default_branch`, which GitHub always sends). */
const defaultBranchOf = (payload: unknown): string | undefined =>
  stringField(asRecord(asRecord(payload)?.["repository"]), "default_branch");

const refusedPush = (error: string, code: string): GitHubWebhookAnswer => ({
  status: 400,
  body: { ok: false, error, code },
});

const PushJson = Schema.fromJsonString(Schema.Unknown);

/**
 * GitHub's merge-commit subject for a pull request from a docs run's own branch:
 * `Merge pull request #12 from acme/factory/doc-push-…`. The owner is one path segment and the
 * branch follows it, so `factory/doc-` right after the first `/` is the docs branch itself.
 */
const DOCS_MERGE_SUBJECT =
  /^Merge pull request #\d+ from [^/\s]+\/factory\/doc-/;

/**
 * Whether a push is the merge of a docs run's own pull request, and so a docs-only change that must
 * not start the next docs pass. Read from `head_commit.message` (the commit the push left the
 * branch at), which is the merge commit when the PR was merged with a merge commit. A squash or
 * rebase merge leaves no trace of the branch in the commit, so those are not recognized here.
 */
export const isDocsRunMerge = (payload: unknown): boolean => {
  const message = stringField(
    asRecord(asRecord(payload)?.["head_commit"]),
    "message",
  );
  return message !== undefined && DOCS_MERGE_SUBJECT.test(message);
};

/**
 * One GitHub `push` delivery, as `POST /webhooks/github` takes it (LOB-234): authenticated, read,
 * normalized by `docsPushDelivery`, and handed to the docs seam. In the order each step refuses more,
 * as the other webhook routes do:
 *
 * - no `GITHUB_WEBHOOK_SECRET` is `503` and a wrong or missing `X-Hub-Signature-256` is `401`
 *   (`refuseGitHubDelivery`, shared with the `pull_request` mirror), and neither writes anything;
 * - a body that is not JSON, or names no default branch, is `400 bad-payload`, and a push to any
 *   other branch is `400 not-default-branch` — answered before the seam, so it records no delivery
 *   and starts nothing (a session's own `factory/<id>` push must not start a docs run);
 * - a push to the default branch is the seam's: `{status: "processed", sessionId}` the first time,
 *   `replayed: true` for a redelivery, `skipped` (with the reason) for an unregistered repo, and
 *   `500` for a real failure, so GitHub's delivery log shows it;
 * - the merge commit of a docs run's own `factory/doc-*` pull request is `200 skipped` before the
 *   seam (`isDocsRunMerge`): merging a docs PR must not start the next docs pass.
 *
 * The default branch is the payload's own `repository.default_branch` rather than configuration, so
 * a repo whose trunk is `trunk` docs its trunk with nothing set. The delivery id is the push
 * (`docsPushDelivery`), not `X-GitHub-Delivery`: GitHub gives a manual redelivery a fresh header, and
 * the replay has to be keyed on what was pushed. The header is logged, so a delivery in GitHub's log
 * can still be found in ours.
 */
export const handleDocsPushWebhook = (input: {
  readonly secret: string | undefined;
  readonly raw: string;
  readonly signature: string | undefined;
  /** `X-GitHub-Delivery`, for the log line only. */
  readonly delivery?: string | undefined;
}): Effect.Effect<GitHubWebhookAnswer, never, SessionService | SqlClient> =>
  Effect.gen(function* () {
    const refused = refuseGitHubDelivery(input);
    if (refused !== undefined) return refused;
    const payload = yield* Schema.decodeEffect(PushJson)(input.raw).pipe(
      Effect.orElseSucceed(() => undefined),
    );
    const defaultBranch = defaultBranchOf(payload);
    if (defaultBranch === undefined) {
      return refusedPush(
        "the payload is not a push: it names no repository.default_branch",
        "bad-payload",
      );
    }
    const ref = stringField(asRecord(payload), "ref");
    if (ref !== `refs/heads/${defaultBranch}`) {
      return refusedPush(
        `a push to ${ref ?? "no ref"} is not to the default branch (${defaultBranch}); it starts no docs run`,
        "not-default-branch",
      );
    }
    const delivery = docsPushDelivery({ payload, defaultBranch });
    if (delivery === undefined || delivery.event.repo === undefined) {
      return refusedPush(
        "the push is a deletion, or names no commit or repository a docs run can start from",
        "bad-payload",
      );
    }
    if (isDocsRunMerge(payload)) {
      // A well-formed push the trigger chooses not to act on: `200 skipped`, not a `400`, so
      // GitHub's delivery log does not show the factory's own merge as a failure.
      const reason = `${delivery.requestId} merges a docs run's own ${DOCS_BRANCH_PREFIX}* branch; a docs-only change starts no docs run`;
      yield* Effect.logInfo(`docs push: ${reason}`);
      return {
        status: 200,
        body: { ok: true, status: "skipped", replayed: false, reason },
      } satisfies GitHubWebhookAnswer;
    }
    yield* Effect.logInfo(
      `docs push: GitHub delivery ${input.delivery ?? "(no id)"} is ${delivery.requestId}`,
    );
    return yield* Effect.gen(function* () {
      const trigger = yield* TriggerService;
      const delivered = yield* trigger.deliver(delivery);
      return {
        status: 200,
        body: {
          ok: true,
          status: delivered.status,
          replayed: delivered.replayed,
          ...(delivered.sessionId === undefined
            ? {}
            : { sessionId: delivered.sessionId }),
          ...(delivered.reason === undefined
            ? {}
            : { reason: delivered.reason }),
        },
      } satisfies GitHubWebhookAnswer;
    }).pipe(
      Effect.provide(DocsTriggerLive(delivery.event.repo)),
      // A refusal is an answer (`skipped`), so only a real failure reaches here: `500`, so the
      // delivery log shows it, rather than `200` on work that never got recorded.
      Effect.catchTag("TriggerError", (cause) =>
        Effect.logError(
          `docs push: delivery ${delivery.requestId} failed: ${cause.message}`,
        ).pipe(
          Effect.as<GitHubWebhookAnswer>({
            status: 500,
            body: { ok: false, error: cause.message, code: cause.code },
          }),
        ),
      ),
    );
  });
