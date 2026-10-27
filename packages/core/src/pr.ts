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
 * A pull request as GitHub's REST API spells it, as far as the step reads it.
 *
 * GitHub answers two links: `url` is the API resource (`https://api.github.com/repos/o/r/pulls/7`)
 * and `html_url` is the page a person opens (`https://github.com/o/r/pull/7`). The factory's
 * `PullRequest.url` is the page — it is what `sessions.pr_url` records, what the dashboard and the
 * Linear attachment link to, and what a `pull_request` webhook names as `html_url`, which is how a
 * merge finds its session (LOB-15). Reading GitHub's `url` here recorded the API resource instead,
 * so a merge matched no session and every link opened JSON.
 */
const GitHubPullRequest = Schema.Struct({
  number: Schema.Finite,
  html_url: Schema.String,
});

/** The factory's `PullRequest` from GitHub's answer: its number and its page. */
const fromGitHub = (pr: typeof GitHubPullRequest.Type): PullRequest => ({
  number: pr.number,
  url: pr.html_url,
});

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

/** How long a tool-authored message may be on the body; longer ones keep their start. */
export const PR_MESSAGE_MAX_CHARS = 500;

/**
 * A tool-authored message (a verification's `message`, git's stderr) as the body shows it: one line,
 * at most `PR_MESSAGE_MAX_CHARS`, in a code span. The message is the tool's text, not Markdown — a
 * newline followed by `## Prompt` would otherwise start a section, a fence would swallow the body,
 * and an `@name` in stderr would notify someone — and a code span is the one inline construct
 * nothing inside it can escape (`inlineCode` sizes its delimiters past any run of backticks in it).
 */
const toolText = (message: string): string => {
  const line = message.replace(/\s+/g, " ").trim();
  return inlineCode(
    line.length <= PR_MESSAGE_MAX_CHARS
      ? line
      : `${line.slice(0, PR_MESSAGE_MAX_CHARS - 1)}…`,
  );
};

/** A verification's heading and facts, without its output. */
const verificationHead = (verification: Verification): string[] => {
  switch (verification._tag) {
    case "VerificationRan":
      return [
        `### ${inlineCode(verification.name)}: exit ${verification.exitCode}${verification.exitCode === 0 ? "" : " (failed)"}`,
        "",
        `- Surface: ${inlineCode(verification.surface)}`,
        `- Exit code: ${verification.exitCode}`,
        `- Command: ${inlineCode(verification.command)}`,
        "",
      ];
    case "VerificationUnrunnable":
      return [
        `### ${inlineCode(verification.name)}: could not run (${inlineCode(verification.code)})`,
        "",
        `- Surface: ${inlineCode(verification.surface)}`,
        `- Exit code: none — ${toolText(verification.message)}`,
        `- Command: ${inlineCode(verification.command)}`,
        "",
      ];
    case "VerificationMissing":
      return [
        `### ${inlineCode(verification.surface)}: no evidence`,
        "",
        toolText(verification.message),
        "",
      ];
  }
};

/** A verification as the body shows it in full: its facts, then its excerpt when it has one. */
const verificationLines = (verification: Verification): string[] =>
  verification._tag === "VerificationMissing"
    ? verificationHead(verification)
    : [
        ...verificationHead(verification),
        ...excerptLines(verification.excerpt, verification.truncated),
      ];

/** A verification whose excerpt the section's bound left out: its facts, and a line saying so. */
const verificationBrief = (verification: Verification): string[] =>
  verification._tag === "VerificationMissing"
    ? verificationHead(verification)
    : [
        ...verificationHead(verification),
        "Output not quoted: the section reached its size bound. The session's log holds it.",
        "",
      ];

/** Whether a verification failed: a non-zero exit or one that could not run. Quoted first. */
const failed = (verification: Verification): boolean =>
  verification._tag === "VerificationUnrunnable" ||
  (verification._tag === "VerificationRan" && verification.exitCode !== 0);

/** The characters `lines` take once joined with newlines, counting the one after the last. */
const sizeOf = (lines: readonly string[]): number =>
  lines.reduce((total, line) => total + line.length + 1, 0);

/**
 * GitHub refuses a PR body over 65,536 characters, and the step then opens no PR at all. The body is
 * kept under this, with room: the sections a run controls (the changed files, the evidence, the
 * prompt) are each bounded so the whole is.
 */
export const PR_BODY_MAX_CHARS = 60_000;

/**
 * The `## Verification` section's share of `PR_BODY_MAX_CHARS`. Each excerpt is already bounded
 * (`PR_EVIDENCE_EXCERPT`); this bounds how many of them a run with many surfaces quotes.
 */
export const PR_EVIDENCE_SECTION_MAX_CHARS = 30_000;

/** How many changed files the body lists before it says how many more there are. */
export const PR_CHANGED_LIST_MAX = 300;

/** The cited call's freshness, said on the body: later calls that left no record, missed paths. */
const caveatLines = (
  evidence: Extract<PrEvidence, { _tag: "EvidenceRecorded" }>,
): string[] => {
  const lines: string[] = [];
  if (evidence.unrecordedAfter !== undefined && evidence.unrecordedAfter > 0)
    lines.push(
      `**Not the run's last call.** The ${evidence.unrecordedAfter} \`verify\` call(s) after it left no record (blocked or crashed), so the verdict below is from an earlier call.`,
      "",
    );
  const coverage = evidence.coverage;
  if (coverage === undefined) return lines;
  const missedCount = coverage.published - coverage.covered;
  if (missedCount > 0) {
    const more = missedCount - coverage.missed.length;
    lines.push(
      `**Stale.** The cited call measured ${coverage.covered} of the ${coverage.published} path(s) this PR changes; the run changed the rest after it verified, so the verdict below predates them: ${coverage.missed.map(inlineCode).join(", ")}${more > 0 ? `, and ${more} more` : ""}.`,
      "",
    );
  } else
    lines.push(
      `It measured all ${coverage.published} path(s) this PR changes. Paths, not contents: an edit to one of them after the call is not detected.`,
      "",
    );
  return lines;
};

/**
 * The body's `## Verification` section (LOB-79): every result of the run's last recorded `verify`
 * call — what ran, its exit code, and a bounded excerpt of its output — or, when there is none, a
 * sentence saying so. Always present, so a PR without evidence reads as one, not as one whose section
 * was dropped. A cited call that is not the run's last, or that did not measure every path the PR
 * changes, says so above its results.
 *
 * At most `maxChars`: every result keeps its facts, failing ones get their excerpts first, then the
 * rest in order while they fit; a result left without one says so. A run with so many results that
 * even their facts do not fit lists what fits and counts the rest.
 */
export const evidenceSection = (
  evidence: PrEvidence,
  maxChars: number = PR_EVIDENCE_SECTION_MAX_CHARS,
): string[] => {
  if (evidence._tag === "EvidenceNone")
    return [
      "## Verification",
      "",
      `**No verification evidence.** Nothing in this PR was verified by a recorded run: ${evidence.message.replace(/\.$/, "")}.`,
      "",
      ...(evidence.detail === undefined
        ? []
        : [`The tool said: ${toolText(evidence.detail)}`, ""]),
    ];
  const head = [
    "## Verification",
    "",
    `Recorded by the run's \`verify\` tool: its last recorded call (${evidence.calls} in all) over ${evidence.changedCount} changed path(s).`,
    "",
    ...caveatLines(evidence),
  ];
  const { results } = evidence;
  const full = results.map(verificationLines);
  const brief = results.map(verificationBrief);
  const quoted = results.map(() => false);
  let size = sizeOf(head) + brief.reduce((total, b) => total + sizeOf(b), 0);
  const order = [
    ...results.flatMap((v, i) => (failed(v) ? [i] : [])),
    ...results.flatMap((v, i) => (failed(v) ? [] : [i])),
  ];
  for (const i of order) {
    const grown = size - sizeOf(brief[i] ?? []) + sizeOf(full[i] ?? []);
    if (grown <= maxChars) {
      quoted[i] = true;
      size = grown;
    }
  }
  const shown = results.map((_, i) => (quoted[i] ? full[i] : brief[i]) ?? []);
  if (size <= maxChars) return [...head, ...shown.flat()];
  // Even the facts alone do not fit: list what does, keeping room for the line that counts the rest.
  const lines = [...head];
  for (const [i, rendered] of shown.entries()) {
    const note = [
      `${results.length - i} more result(s) not shown: the section reached its size bound. The session's log holds every one.`,
      "",
    ];
    if (sizeOf(lines) + sizeOf(rendered) + sizeOf(note) > maxChars) {
      lines.push(...note);
      break;
    }
    lines.push(...rendered);
  }
  return lines;
};

/** The changed files as the body lists them: at most `PR_CHANGED_LIST_MAX`, then a count. */
const changedLines = (changed: readonly string[]): string[] => {
  if (changed.length === 0) return [];
  const shown = changed.slice(0, PR_CHANGED_LIST_MAX);
  const more = changed.length - shown.length;
  return [
    "## Changed files",
    "",
    ...shown.map((path) => `- ${path}`),
    ...(more > 0 ? [`- …and ${more} more`] : []),
    "",
  ];
};

/**
 * The body a factory PR carries: session id, model, spend, the changed files, what was verified,
 * and the prompt — at most `PR_BODY_MAX_CHARS`, the prompt (last, and the one section nothing else
 * bounds) cut to fit with a line saying so.
 */
export const buildPrBody = (input: PrBodyInput): string => {
  const head = [
    "## Factory session",
    "",
    `- Session: ${input.sessionId}`,
    ...(input.model === undefined ? [] : [`- Model: ${input.model}`]),
    ...(input.spend ? [`- Spend: ${input.spend}`] : []),
    "",
    ...changedLines(input.changed ?? []),
    ...evidenceSection(input.evidence),
    "## Prompt",
    "",
    "",
  ].join("\n");
  const budget = PR_BODY_MAX_CHARS - head.length;
  if (input.prompt.length <= budget) return head + input.prompt;
  const note = (shown: number) =>
    `\n\n_(Prompt truncated: the first ${shown} of ${input.prompt.length} characters shown.)_`;
  const shown = Math.max(0, budget - note(input.prompt.length).length);
  return head + input.prompt.slice(0, shown) + note(shown);
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
      Effect.flatMap(HttpClientResponse.schemaBodyJson(GitHubPullRequest)),
      Effect.map(fromGitHub),
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
        HttpClientResponse.schemaBodyJson(Schema.Array(GitHubPullRequest)),
      ),
      Effect.map((found) =>
        found[0] === undefined ? undefined : fromGitHub(found[0]),
      ),
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
