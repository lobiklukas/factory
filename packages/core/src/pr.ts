import { Effect, Redacted, Schema } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/http";
import type {
  PrEvidence,
  RepoSlug,
  SessionId,
  Verification,
} from "@repo/domain/Session";
import { CredentialError, CredentialProvider } from "./credentials";

/** A PR could not be created. Typed, so callers handle it instead of dumping stderr. */
export class PrError extends Schema.TaggedError<PrError>()("PrError", {
  operation: Schema.String,
  ref: Schema.String,
  message: Schema.String,
}) {}

export const PullRequest = Schema.Struct({
  number: Schema.Finite,
  url: Schema.String,
});
export type PullRequest = typeof PullRequest.Type;

/**
 * Which of the PR step's two paths answered (LOB-212).
 *
 * `"opened"` is the GitHub call; `"already-open"` is the retry that read the `factory.pr` document
 * its log already held and never reached the network. The link is the same either way, which is
 * exactly why the tag has to be here: before it, a first open and a replay were indistinguishable
 * from the answer.
 *
 * `"opened"` means *this invocation made the call*, not *this invocation created the PR*: since
 * LOB-179 the call adopts the PR a killed attempt left behind when GitHub refuses the duplicate, and
 * that is still the call path. The tag separates "went to GitHub" from "the log answered", which is
 * the distinction a caller can act on; whether the PR existed before the call is the log's business.
 */
export const PullRequestOutcome = Schema.Literals(["opened", "already-open"]);
export type PullRequestOutcome = typeof PullRequestOutcome.Type;

/**
 * The PR step's answer: the link plus the path that produced it.
 *
 * A superset of `PullRequest`, not a replacement — a client that reads only `{number, url}` keeps
 * decoding this answer with `PullRequest` and is unaffected, which is why the tag lives on the
 * step's result rather than on the forge's own shape.
 */
export const OpenedPullRequest = Schema.Struct({
  number: Schema.Finite,
  url: Schema.String,
  outcome: PullRequestOutcome,
});
export type OpenedPullRequest = typeof OpenedPullRequest.Type;

/**
 * How large a session's diff may be before the PR step opens nothing (LOB-227).
 *
 * Two numbers rather than one, because they bound different costs: the line count is what a
 * reviewer reads, and the file count is what a repository pays for (CI, CODEOWNERS, every touched
 * surface). Either one exceeded is enough to refuse; the outcome says which. Both are
 * configuration — a deployment passes its own to `SessionServiceLive` — and `DEFAULT_DIFF_CAP` is
 * what an unconfigured one enforces. There is no third dimension (bytes, hunks): a diff that is
 * small in both is one a person can read, and a cap that guessed at the rest would refuse diffs
 * nobody objects to.
 */
export const DiffCap = Schema.Struct({
  maxFiles: Schema.Finite,
  maxLines: Schema.Finite,
});
export type DiffCap = typeof DiffCap.Type;

/**
 * The cap an unconfigured deployment enforces.
 *
 * Sized from what a session already opens here rather than from a vendor's limit: the largest PR
 * this repo has merged is a few hundred lines, and the loop's own "one sitting" bound is about 800
 * changed lines — so two thousand lines and fifty files accept every ordinary change with room, and
 * only a runaway run hits it. Being a default rather than a constant in the check is the point: a
 * deployment that wants a different bound passes one.
 */
export const DEFAULT_DIFF_CAP: DiffCap = { maxFiles: 50, maxLines: 2_000 };

/** Which of the cap's two dimensions an over-cap diff broke. */
export const DiffCapLimit = Schema.Literals(["files", "lines"]);
export type DiffCapLimit = typeof DiffCapLimit.Type;

/**
 * The answer for a diff the cap refused (LOB-227): no PR, no `factory.pr` document, and the numbers
 * that refused it — which limit, what that limit allows, and what the branch measured.
 *
 * A value rather than a `PrError`, because nothing failed: the step ran, measured, and decided. A
 * caller that retries an error would retry this one too, and the same branch would measure the same;
 * a caller that reads an outcome can instead report the cap and leave the session's PR absent.
 *
 * It carries no `number` and no `url` — there is no PR — which is why the step's answer is a union
 * of two shapes rather than one shape with absent fields: a decoded `{outcome: "over-cap", url}`
 * cannot exist, so no reader has to decide what a missing link on an over-cap answer would mean.
 */
export const OverCapPullRequest = Schema.Struct({
  outcome: Schema.Literal("over-cap"),
  limit: DiffCapLimit,
  cap: Schema.Finite,
  measured: Schema.Finite,
});
export type OverCapPullRequest = typeof OverCapPullRequest.Type;

/**
 * The answer for a branch with nothing to publish (LOB-196): no PR, no `factory.pr` document, no
 * `pr_url` row — the run measured the branch against its base and found it even.
 *
 * GitHub refuses to open a PR for a head with no commits ahead of its base, so before this the
 * ordinary result of a docs run over docs that need no edit was a typed 422 failure. It is a value
 * for the same reason an over-cap answer is: nothing failed, the step ran, measured and decided, and
 * a caller that retries an error would ask GitHub again for the same empty branch.
 *
 * Nothing is recorded about it, deliberately. A recorded answer would be sticky — the next run that
 * *does* change a file would read it and open nothing — so the transcript entry is the run's own
 * record and the next call measures the branch afresh.
 */
export const NoChangePullRequest = Schema.Struct({
  outcome: Schema.Literal("no-change"),
});
export type NoChangePullRequest = typeof NoChangePullRequest.Type;

/** What the PR step answers: the link and the path that produced it, the cap that refused it, or
 * the empty branch that had nothing to open. */
export const PullRequestStep = Schema.Union([
  OpenedPullRequest,
  OverCapPullRequest,
  NoChangePullRequest,
]);
export type PullRequestStep = typeof PullRequestStep.Type;

export type PrBodyInput = {
  readonly sessionId: SessionId;
  readonly prompt: string;
  /** The model that did the work. Absent when the session spent nothing on a model. */
  readonly model?: string;
  readonly spend?: string;
  /**
   * The branches' changed files, **as git's `--numstat` spells them** (LOB-228).
   *
   * That spelling is not always a bare path: a rename arrives as `docs/{old.md => new.md}` and a
   * path with a special character arrives quoted, because the list is git's own path column rather
   * than a parsed one. It is the list a reviewer gets before opening the diff, which is what it is
   * for — a caller that needs a path to fetch must ask git itself.
   *
   * Absent means "nothing was measured": a session whose directory is not a checkout of its own
   * (`prStep.ts`'s `diffSize` answers `none`) has no diff to list, and an empty list is the same
   * fact from a branch that changes nothing. Both leave the section out rather than printing a
   * heading over no rows.
   *
   * It exists because the `docs` skill's body tells a run to "list what changed … so the pull
   * request body can carry it" (0015's seed) and nothing did: the body named the session, the model
   * and the spend, and a reader had to open the diff to learn what the run touched.
   */
  readonly changed?: readonly string[];
  /**
   * What the run verified, from its recorded `verify` results (LOB-79) — never from the model's
   * prose. Required, because the section is never omitted: a run with nothing to show passes an
   * `EvidenceNone`, and the body says so.
   */
  readonly evidence: PrEvidence;
};

/**
 * A code span or fence that `text` cannot close early: one backtick longer than the longest run of
 * backticks in it (CommonMark closes a fence only on a run at least as long as the opener). Driver
 * output and skill scripts are arbitrary text, and a stray fence in them would turn the rest of the
 * body into code.
 */
const ticksFor = (text: string, minimum: number): string => {
  const longest = Math.max(
    0,
    ...Array.from(text.matchAll(/`+/g), (run) => run[0].length),
  );
  return "`".repeat(Math.max(minimum, longest + 1));
};

const inlineCode = (text: string): string => {
  const ticks = ticksFor(text, 1);
  // A span whose text starts or ends with a backtick needs a space between it and the delimiter.
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${ticks}${pad}${text}${pad}${ticks}`;
};

/**
 * An excerpt as the body shows it: fenced, and introduced by a line that says whether it is all of
 * the output or its tail. The truncation note is outside the fence, so it can never be mistaken for
 * a line the command printed.
 */
const excerptLines = (excerpt: string, truncated: boolean): string[] => {
  const fence = ticksFor(excerpt, 3);
  const body = excerpt.endsWith("\n") ? excerpt.slice(0, -1) : excerpt;
  const shown = body === "" ? 0 : body.split("\n").length;
  return [
    truncated
      ? `Output (truncated: earlier output omitted, the last ${shown} line(s) shown):`
      : "Output:",
    "",
    `${fence}text`,
    ...(body === "" ? [] : [body]),
    fence,
    "",
  ];
};

const verificationLines = (verification: Verification): string[] => {
  switch (verification._tag) {
    case "VerificationRan":
      return [
        `### ${inlineCode(verification.name)}: exit ${verification.exitCode}${verification.exitCode === 0 ? "" : " (failed)"}`,
        "",
        `- Surface: ${inlineCode(verification.surface)}`,
        `- Exit code: ${verification.exitCode}`,
        `- Command: ${inlineCode(verification.command)}`,
        "",
        ...excerptLines(verification.excerpt, verification.truncated),
      ];
    case "VerificationUnrunnable":
      return [
        `### ${inlineCode(verification.name)}: could not run (${verification.code})`,
        "",
        `- Surface: ${inlineCode(verification.surface)}`,
        `- Exit code: none — ${verification.message}`,
        `- Command: ${inlineCode(verification.command)}`,
        "",
        ...excerptLines(verification.excerpt, verification.truncated),
      ];
    case "VerificationMissing":
      return [
        `### ${inlineCode(verification.surface)}: no evidence`,
        "",
        verification.message,
        "",
      ];
  }
};

/**
 * The body's `## Verification` section (LOB-79): every result of the run's last `verify` call —
 * what ran, its exit code, and a bounded excerpt of its output — or, when there is none, a sentence
 * saying so. Always present, so a PR without evidence reads as one, not as one whose section was
 * dropped.
 */
export const evidenceSection = (evidence: PrEvidence): string[] => {
  if (evidence._tag === "EvidenceNone")
    return [
      "## Verification",
      "",
      `**No verification evidence.** Nothing in this PR was verified by a recorded run: ${evidence.message.replace(/\.$/, "")}.`,
      "",
    ];
  return [
    "## Verification",
    "",
    `Recorded by the run's \`verify\` tool: its last call (${evidence.calls} in all) over ${evidence.changedCount} changed path(s).`,
    "",
    ...evidence.results.flatMap(verificationLines),
  ];
};

/**
 * The body a factory PR carries: session id, model, spend, the changed files, what was verified,
 * and the prompt.
 */
export const buildPrBody = (input: PrBodyInput): string => {
  const changed = input.changed ?? [];
  const lines = [
    "## Factory session",
    "",
    `- Session: ${input.sessionId}`,
    ...(input.model === undefined ? [] : [`- Model: ${input.model}`]),
    ...(input.spend ? [`- Spend: ${input.spend}`] : []),
    "",
    ...(changed.length === 0
      ? []
      : ["## Changed files", "", ...changed.map((path) => `- ${path}`), ""]),
    ...evidenceSection(input.evidence),
    "## Prompt",
    "",
    input.prompt,
  ];
  return lines.join("\n");
};

export type CreatePullRequestInput = {
  readonly repo: RepoSlug;
  readonly base: string;
  readonly head: string;
  readonly title: string;
  readonly body: string;
  /**
   * The API root to call. Absent means the deployment's `GITHUB_API_URL`, which is the key the App
   * token flow already reads (LOB-51), so one variable points both GitHub clients at the same
   * forge — and a loopback fake can answer for the PR client without a key (LOB-179).
   */
  readonly apiUrl?: string;
};

/** GitHub's own API root: what an unconfigured deployment calls. */
const DEFAULT_API_URL = "https://api.github.com";

/**
 * Where the GitHub clients send their requests: `GITHUB_API_URL` when set, `https://api.github.com`
 * when not. Read per call rather than at module load so a test or a verify script can point the same
 * process at a loopback endpoint, and an empty value is an unset one (as `GITHUB_TOKEN` is). The PR
 * step (here) and the issue write-back (`GitHub.ts`) both read it, so one variable points both at
 * the same forge.
 */
export const githubApiUrl = (): string => {
  // oxlint-disable-next-line effecttsgo/process-env -- the deployment seam; a `Config` here would add a requirement to every caller of the step.
  const configured = process.env["GITHUB_API_URL"];
  return configured === undefined || configured === ""
    ? DEFAULT_API_URL
    : configured;
};

export const createPullRequest = (
  input: CreatePullRequestInput,
): Effect.Effect<
  PullRequest,
  PrError | CredentialError,
  CredentialProvider | HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    const provider = yield* CredentialProvider;
    const http = yield* HttpClient.HttpClient;
    const token = yield* provider.tokenFor(input.repo);
    const [owner, repo] = input.repo.split("/");
    const ref = `${input.repo}:${input.head}->${input.base}`;
    const apiUrl = input.apiUrl ?? githubApiUrl();
    const request = yield* HttpClientRequest.post(
      `${apiUrl}/repos/${owner}/${repo}/pulls`,
      {
        headers: {
          authorization: `Bearer ${Redacted.value(token)}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
        },
      },
    ).pipe(
      HttpClientRequest.bodyJson({
        title: input.title,
        head: input.head,
        base: input.base,
        body: input.body,
      }),
      Effect.mapError(
        () =>
          new PrError({
            operation: "createPullRequest",
            ref,
            message: "the request body could not be encoded",
          }),
      ),
    );
    const response = yield* http.execute(request).pipe(
      Effect.mapError(
        () =>
          new PrError({
            operation: "createPullRequest",
            ref,
            message: "GitHub could not be reached",
          }),
      ),
    );
    // A duplicate is not a failure to report: GitHub refuses a second PR for one head and base, so
    // the answer to "open this PR" is the PR that already exists. Adopting it is what closes the
    // window a kill between the call and its acknowledgement opens — the first attempt's commit
    // never landed, so nothing local remembers the PR, and the retry finds it here (LOB-179).
    if (response.status === 422) {
      const existing = yield* findPullRequest({
        http,
        apiUrl,
        repo: input.repo,
        head: input.head,
        base: input.base,
        ref,
        authorization: `Bearer ${Redacted.value(token)}`,
      });
      if (existing !== undefined) return existing;
    }
    return yield* HttpClientResponse.filterStatusOk(response).pipe(
      Effect.flatMap(HttpClientResponse.schemaBodyJson(PullRequest)),
      Effect.mapError((error) => {
        const status =
          error._tag === "HttpClientError" &&
          error.reason._tag === "StatusCodeError"
            ? error.reason.response.status
            : undefined;
        return new PrError({
          operation: "createPullRequest",
          ref,
          message:
            status === undefined
              ? "GitHub's response could not be read"
              : `GitHub answered HTTP ${status}`,
        });
      }),
    );
  });

/**
 * The PR that already exists for one head and base, if GitHub has one.
 *
 * GitHub keys a PR by its head branch as the *repo's owner* spells it (`owner:branch`), which is
 * why the query names the owner rather than the bare branch. An empty list is no answer, not a
 * failure: the caller reports the status GitHub gave when the create was refused.
 */
const findPullRequest = (input: {
  readonly http: HttpClient.HttpClient;
  readonly apiUrl: string;
  readonly repo: RepoSlug;
  readonly head: string;
  readonly base: string;
  readonly ref: string;
  /** The same bearer the create sent: the lookup reads a repo the token already reaches. */
  readonly authorization: string;
}): Effect.Effect<PullRequest | undefined, PrError> =>
  Effect.gen(function* () {
    const [owner, repo] = input.repo.split("/");
    const query = new URLSearchParams({
      head: `${owner}:${input.head}`,
      base: input.base,
      state: "open",
    });
    const request = HttpClientRequest.get(
      `${input.apiUrl}/repos/${owner}/${repo}/pulls?${query.toString()}`,
      {
        headers: {
          authorization: input.authorization,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
        },
      },
    );
    return yield* input.http.execute(request).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(
        HttpClientResponse.schemaBodyJson(Schema.Array(PullRequest)),
      ),
      Effect.map((found) => found[0]),
      Effect.mapError(
        () =>
          new PrError({
            operation: "findPullRequest",
            ref: input.ref,
            message: "the existing pull request could not be read",
          }),
      ),
    );
  });

export const PrClientLive = FetchHttpClient.layer;
