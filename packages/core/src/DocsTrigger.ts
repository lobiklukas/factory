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
 */
import {
  Clock,
  Duration,
  Effect,
  Layer,
  Option,
  Schedule,
  Schema,
} from "effect";
import type { RepoSlug } from "@repo/domain/Session";
import { BranchName, RepoSlug as RepoSlugSchema } from "@repo/domain/Session";
import {
  LIFECYCLE_ACTIONS,
  TriggerError,
  type TriggerDelivery,
  type TriggerEvent,
  type TriggerRule,
} from "@repo/domain/Trigger";
import { SessionService } from "./SessionService";
import { TriggerSessions } from "./TriggerService";

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
  return { requestId: pushToken(event.repo, sha), event };
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
  const tick = Effect.gen(function* () {
    const at = yield* Clock.currentTimeMillis;
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
  });
  return Effect.repeat(tick, Schedule.spaced(Duration.millis(everyMs))).pipe(
    Effect.asVoid,
  );
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
